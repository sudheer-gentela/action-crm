-- =====================================================================
-- 2026_114_boq_procurement.sql
--
--   1. boq_items.vendor_account_id   — which vendor is delivering this line
--   2. boq_items.procurement_status  — where the line is in procurement
--   3. boq_items.procurement_ref     — shared PO/RFQ reference
--   4. boq_section_rollup            — Civil total, MEP total, etc.
--
-- ON THE ITEM-VS-PACKAGE TENSION
--   One purchase order usually covers several bill lines, which argues for a
--   package entity holding the status. But what matters from a project
--   perspective is whether THIS line's material has arrived, so status lives
--   on the item and is the source of truth.
--
--   procurement_ref is the compromise: lines covered by the same PO carry the
--   same reference and can be advanced together in one action, while each
--   line still reports its own status. No package table, no five-lines-to-
--   update friction. If real packages are needed later, this reference is the
--   natural key to migrate on.
--
-- ON THE VENDOR LINK
--   vendor_account_id points at accounts, the existing vendor entity — an
--   account becomes a vendor through account_relationships with
--   relationship = 'vendor'. That relationship is NOT enforced here: a CHECK
--   cannot span tables, and a foreign key to accounts would silently accept a
--   customer account. The service layer validates it, and the query at the
--   end of this file reports any line that slipped through.
--
-- ORG CONFIGURATION (no schema — organizations.settings jsonb, matching the
-- existing playbook_default_access convention):
--   boq_progress_entry_mode  'per_item' (default) | 'bulk_sheet'
--   boq_lock_active_bill     false (default) | true
--
--   psql "$DATABASE_URL" -f 2026_114_boq_procurement.sql
-- =====================================================================

\set ON_ERROR_STOP on
SET statement_timeout = '600s';

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.boq_items') IS NULL THEN
    RAISE EXCEPTION 'HARD STOP: boq_items does not exist. Run 2026_113 first.';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 1-3. Vendor + procurement columns
-- ---------------------------------------------------------------------
ALTER TABLE public.boq_items ADD COLUMN IF NOT EXISTS vendor_account_id integer;
ALTER TABLE public.boq_items ADD COLUMN IF NOT EXISTS procurement_ref   text;

-- 'not_required' is the default and it matters: own-labour lines must not sit
-- permanently at "to procure" dragging the procurement rollup down. A line is
-- opted IN to procurement, not out of it.
ALTER TABLE public.boq_items
  ADD COLUMN IF NOT EXISTS procurement_status text NOT NULL DEFAULT 'not_required';

ALTER TABLE public.boq_items DROP CONSTRAINT IF EXISTS boq_items_procurement_status_chk;
ALTER TABLE public.boq_items
  ADD CONSTRAINT boq_items_procurement_status_chk
  CHECK (procurement_status IN (
    'not_required',   -- own labour / nothing to buy
    'to_procure',     -- identified, not yet gone out
    'rfq_issued',     -- enquiry with vendors
    'quoted',         -- quotes received, not yet ordered
    'po_issued',      -- ordered
    'in_transit',     -- shipped, not yet on site
    'delivered'       -- received
  ));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boq_items_vendor_fkey') THEN
    -- SET NULL, not CASCADE: deleting an account must never delete bill lines
    -- or the spend ledger hanging off them.
    ALTER TABLE ONLY public.boq_items
      ADD CONSTRAINT boq_items_vendor_fkey
      FOREIGN KEY (vendor_account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_boq_items_vendor
  ON public.boq_items (vendor_account_id) WHERE (vendor_account_id IS NOT NULL);
-- Supports advancing every line on one PO together.
CREATE INDEX IF NOT EXISTS idx_boq_items_proc_ref
  ON public.boq_items (boq_id, procurement_ref) WHERE (procurement_ref IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_boq_items_proc_status
  ON public.boq_items (boq_id, procurement_status);

-- ---------------------------------------------------------------------
-- 4. Section rollup — Civil total, MEP total
--
-- Aggregates boq_item_rollup rather than re-deriving from the ledger, so a
-- section total can never disagree with the lines shown beneath it.
-- Sections are a flat text grouping; there is no sub-section hierarchy.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW public.boq_section_rollup AS
 SELECT r.boq_id,
        r.org_id,
        COALESCE(r.section, 'Unsectioned')            AS section,
        count(*)::int                                  AS items,
        sum(r.planned_amount)                          AS planned_amount,
        sum(r.approved_variation_amount)               AS approved_variation_amount,
        sum(r.sanctioned_amount)                       AS sanctioned_amount,
        sum(r.spent_amount)                            AS spent_amount,
        sum(r.remaining_amount)                        AS remaining_amount,
        -- Lines that have overrun what was sanctioned for them. Counted at
        -- LINE level on purpose: a section can look healthy in total while
        -- individual lines are badly over, and netting those against
        -- underspend elsewhere hides exactly what needs attention.
        count(*) FILTER (WHERE r.remaining_amount < 0)::int AS overrun_items,
        count(*) FILTER (WHERE i.procurement_status = ANY (ARRAY['to_procure','rfq_issued','quoted']))::int AS awaiting_order,
        count(*) FILTER (WHERE i.procurement_status = ANY (ARRAY['po_issued','in_transit']))::int           AS on_order,
        count(*) FILTER (WHERE i.procurement_status = 'delivered')::int                                     AS delivered
   FROM public.boq_item_rollup r
   JOIN public.boq_items i ON i.id = r.boq_item_id
  GROUP BY r.boq_id, r.org_id, COALESCE(r.section, 'Unsectioned');

COMMENT ON VIEW public.boq_section_rollup IS
  'Per-section totals for a bill. overrun_items counts LINES over their own sanctioned amount, not the section net, so overspend is not masked by underspend on other lines.';

-- The item rollup needs to carry the procurement fields too, or the BoQ screen
-- would have to join boq_items separately just to show a vendor column.
CREATE OR REPLACE VIEW public.boq_item_rollup AS
 SELECT i.id                                   AS boq_item_id,
        i.boq_id,
        i.org_id,
        i.section,
        i.item_code,
        i.description,
        i.unit,
        i.planned_qty,
        i.rate,
        i.planned_amount,
        COALESCE(v.qty_delta, 0)               AS approved_variation_qty,
        COALESCE(v.amount_delta, 0)            AS approved_variation_amount,
        (i.planned_amount + COALESCE(v.amount_delta, 0)) AS sanctioned_amount,
        COALESCE(p.qty_done, 0)                AS executed_qty,
        COALESCE(p.amount_spent, 0)            AS spent_amount,
        ((i.planned_amount + COALESCE(v.amount_delta, 0)) - COALESCE(p.amount_spent, 0))
                                               AS remaining_amount,
        COALESCE(p.entries, 0)                 AS entry_count,
        p.last_entry_date,
        -- Appended, not inserted mid-list: CREATE OR REPLACE VIEW can only ADD
        -- columns at the end. Placing them next to the other item fields would
        -- require dropping the view, which would cascade to anything built on
        -- it later. Column order is cosmetic; the drop is not.
        i.vendor_account_id,
        va.name                                AS vendor_name,
        i.procurement_status,
        i.procurement_ref
   FROM public.boq_items i
   LEFT JOIN public.accounts va ON va.id = i.vendor_account_id
   LEFT JOIN LATERAL (
     SELECT sum(pr.qty_delta)     AS qty_done,
            sum(pr.amount_delta)  AS amount_spent,
            count(*)::int         AS entries,
            max(pr.entry_date)    AS last_entry_date
       FROM public.boq_progress pr
      WHERE pr.boq_item_id = i.id
   ) p ON TRUE
   LEFT JOIN LATERAL (
     SELECT sum(vr.qty_delta)    AS qty_delta,
            sum(vr.amount_delta) AS amount_delta
       FROM public.boq_variations vr
      WHERE vr.boq_item_id = i.id AND vr.status = 'approved'
   ) v ON TRUE;

COMMIT;

\echo ''
\echo '=== Columns added to boq_items ==='
SELECT column_name, data_type, column_default
  FROM information_schema.columns
 WHERE table_name = 'boq_items'
   AND column_name IN ('vendor_account_id', 'procurement_status', 'procurement_ref')
 ORDER BY column_name;

\echo ''
\echo '=== Procurement status distribution ==='
SELECT procurement_status, count(*) FROM public.boq_items GROUP BY 1 ORDER BY 2 DESC;

\echo ''
\echo '=== Integrity check: any line pointing at a NON-vendor account? ==='
\echo '    (the FK only proves the account exists, not that it is a vendor)'
SELECT i.id AS boq_item_id, i.item_code, a.name AS account_name
  FROM public.boq_items i
  JOIN public.accounts a ON a.id = i.vendor_account_id
 WHERE NOT EXISTS (
   SELECT 1 FROM public.account_relationships ar
    WHERE ar.account_id = i.vendor_account_id
      AND ar.relationship = 'vendor'
      AND ar.status = 'active'
 );

\echo ''
\echo 'Org configuration lives in organizations.settings (jsonb) — no migration.'
\echo 'Keys: boq_progress_entry_mode = per_item | bulk_sheet'
\echo '      boq_lock_active_bill     = false | true'
\echo 'Set them from the org admin screen, or with a jsonb concat update.'
