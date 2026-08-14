-- =====================================================================
-- 2026_113_boq.sql   —   Bill of Quantities, first-class project object
--
--   boqs            one bill per project (several allowed later)
--   boq_items       the bill lines: quantity, rate, planned amount
--   boq_progress    APPEND-ONLY spend ledger, incremental deltas
--   boq_variations  approved scope changes, kept apart from the bill
--
-- FIVE DESIGN DECISIONS, each of which changes what the numbers mean:
--
--  1. PROGRESS IS INCREMENTAL, NEVER CUMULATIVE.
--     Rows hold deltas; the cumulative view is a running SUM. Storing a
--     cumulative figure makes a correction ambiguous — you cannot tell a
--     re-measurement from a typo, and two people entering on the same day
--     silently overwrite each other.
--
--  2. EVERY ENTRY SNAPSHOTS THE RATE IT WAS BOOKED AT.
--     Rate revisions are coming (out of scope for v1). Without the
--     snapshot, revising a rate would retroactively rewrite months of
--     recorded spend. Same reasoning as baseline_due_date and the evidence
--     snapshot in 2026_111.
--
--  3. CORRECTIONS ARE REVERSALS, NOT EDITS.
--     A spend ledger that can be edited is not a ledger. A mistake gets a
--     negative entry pointing at the original, so the correction is part of
--     the record. Enforced by trigger, not convention.
--
--  4. VARIATIONS ARE SEPARATE FROM THE BILL.
--     Folding an approved variation into the original quantities makes a
--     project look on-budget and loses the reason it grew. Scope change and
--     overrun are different failures and must stay distinguishable.
--
--  5. ONE BILL PER PROJECT, ENFORCED BY A PARTIAL UNIQUE INDEX.
--     The grouping row exists now so that allowing several later is
--     dropping an index rather than reshaping three tables.
--
-- Vendor work is handled on the budget side, so there is deliberately no
-- cross-project order or allocation here — a BoQ belongs to exactly one
-- project.
--
--   psql "$DATABASE_URL" -f 2026_113_boq.sql
-- =====================================================================

\set ON_ERROR_STOP on
SET statement_timeout = '600s';

BEGIN;

-- =====================================================================
-- boqs
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.boqs (
    id          integer NOT NULL,
    org_id      integer NOT NULL,
    handover_id integer NOT NULL,
    name        text    NOT NULL DEFAULT 'Bill of Quantities',
    -- 'draft'    — being built, not yet the working bill
    -- 'active'   — the bill work is measured against
    -- 'archived' — superseded; kept for history, never deleted
    status      text    NOT NULL DEFAULT 'draft',
    currency    text    NOT NULL DEFAULT 'INR',
    notes       text,
    created_by  integer,
    created_at  timestamp with time zone NOT NULL DEFAULT now(),
    updated_at  timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT boqs_status_chk CHECK (status IN ('draft', 'active', 'archived'))
);

CREATE SEQUENCE IF NOT EXISTS public.boqs_id_seq AS integer START WITH 1 INCREMENT BY 1 CACHE 1;
ALTER SEQUENCE public.boqs_id_seq OWNED BY public.boqs.id;
ALTER TABLE ONLY public.boqs ALTER COLUMN id SET DEFAULT nextval('public.boqs_id_seq'::regclass);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boqs_pkey') THEN
    ALTER TABLE ONLY public.boqs ADD CONSTRAINT boqs_pkey PRIMARY KEY (id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boqs_org_fkey') THEN
    ALTER TABLE ONLY public.boqs ADD CONSTRAINT boqs_org_fkey
      FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boqs_handover_fkey') THEN
    ALTER TABLE ONLY public.boqs ADD CONSTRAINT boqs_handover_fkey
      FOREIGN KEY (handover_id) REFERENCES public.sales_handovers(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boqs_created_by_fkey') THEN
    ALTER TABLE ONLY public.boqs ADD CONSTRAINT boqs_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id);
  END IF;
END $$;

-- One LIVE bill per project. Archived bills do not count, so a project can
-- be re-billed without deleting its history. Drop this index to allow
-- several concurrent bills.
CREATE UNIQUE INDEX IF NOT EXISTS uq_boqs_one_live_per_project
  ON public.boqs (handover_id) WHERE (status <> 'archived');

CREATE INDEX IF NOT EXISTS idx_boqs_org ON public.boqs (org_id, handover_id);

-- =====================================================================
-- boq_items
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.boq_items (
    id             integer NOT NULL,
    org_id         integer NOT NULL,
    boq_id         integer NOT NULL,
    section        text,
    item_code      text,
    description    text    NOT NULL,
    unit           text,
    planned_qty    numeric(16,3) NOT NULL DEFAULT 0,
    rate           numeric(16,2) NOT NULL DEFAULT 0,
    -- Derived, never written by hand: a stored amount that disagreed with
    -- qty x rate would be impossible to reconcile after the fact.
    planned_amount numeric(18,2) GENERATED ALWAYS AS (round(planned_qty * rate, 2)) STORED,
    sort_order     integer NOT NULL DEFAULT 0,
    notes          text,
    created_by     integer,
    created_at     timestamp with time zone NOT NULL DEFAULT now(),
    updated_at     timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT boq_items_qty_chk  CHECK (planned_qty >= 0),
    CONSTRAINT boq_items_rate_chk CHECK (rate >= 0)
);

CREATE SEQUENCE IF NOT EXISTS public.boq_items_id_seq AS integer START WITH 1 INCREMENT BY 1 CACHE 1;
ALTER SEQUENCE public.boq_items_id_seq OWNED BY public.boq_items.id;
ALTER TABLE ONLY public.boq_items ALTER COLUMN id SET DEFAULT nextval('public.boq_items_id_seq'::regclass);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boq_items_pkey') THEN
    ALTER TABLE ONLY public.boq_items ADD CONSTRAINT boq_items_pkey PRIMARY KEY (id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boq_items_boq_fkey') THEN
    ALTER TABLE ONLY public.boq_items ADD CONSTRAINT boq_items_boq_fkey
      FOREIGN KEY (boq_id) REFERENCES public.boqs(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boq_items_org_fkey') THEN
    ALTER TABLE ONLY public.boq_items ADD CONSTRAINT boq_items_org_fkey
      FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boq_items_created_by_fkey') THEN
    ALTER TABLE ONLY public.boq_items ADD CONSTRAINT boq_items_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id);
  END IF;
END $$;

-- item_code is optional, but where present it must be unique within a bill —
-- two lines sharing a code make measurement against it ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS uq_boq_items_code
  ON public.boq_items (boq_id, item_code) WHERE (item_code IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_boq_items_boq ON public.boq_items (boq_id, sort_order);

-- =====================================================================
-- boq_progress  — append-only spend ledger
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.boq_progress (
    id           integer NOT NULL,
    org_id       integer NOT NULL,
    boq_item_id  integer NOT NULL,
    entry_date   date    NOT NULL DEFAULT CURRENT_DATE,
    -- INCREMENTAL. Negative is legitimate: it is how a reversal is expressed.
    qty_delta    numeric(16,3) NOT NULL DEFAULT 0,
    -- The rate this entry was booked at. Copied from the item at entry time
    -- and never updated, so a future rate revision cannot rewrite history.
    rate_used    numeric(16,2) NOT NULL,
    amount_delta numeric(18,2) GENERATED ALWAYS AS (round(qty_delta * rate_used, 2)) STORED,
    note         text,
    -- Set on a reversal, pointing at the entry being undone. The pair stays
    -- visible: the ledger shows the mistake and the correction, not a
    -- silently tidied result.
    reverses_id  integer,
    recorded_by  integer NOT NULL,
    recorded_at  timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT boq_progress_reversal_shape_chk
      CHECK (reverses_id IS NULL OR qty_delta <> 0)
);

CREATE SEQUENCE IF NOT EXISTS public.boq_progress_id_seq AS integer START WITH 1 INCREMENT BY 1 CACHE 1;
ALTER SEQUENCE public.boq_progress_id_seq OWNED BY public.boq_progress.id;
ALTER TABLE ONLY public.boq_progress ALTER COLUMN id SET DEFAULT nextval('public.boq_progress_id_seq'::regclass);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boq_progress_pkey') THEN
    ALTER TABLE ONLY public.boq_progress ADD CONSTRAINT boq_progress_pkey PRIMARY KEY (id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boq_progress_item_fkey') THEN
    ALTER TABLE ONLY public.boq_progress ADD CONSTRAINT boq_progress_item_fkey
      FOREIGN KEY (boq_item_id) REFERENCES public.boq_items(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boq_progress_org_fkey') THEN
    ALTER TABLE ONLY public.boq_progress ADD CONSTRAINT boq_progress_org_fkey
      FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boq_progress_reverses_fkey') THEN
    ALTER TABLE ONLY public.boq_progress ADD CONSTRAINT boq_progress_reverses_fkey
      FOREIGN KEY (reverses_id) REFERENCES public.boq_progress(id);
  END IF;
  -- No on-delete action: superAdmin's sweep nulls attribution, and a ledger
  -- row must outlive the user who wrote it. recorded_by stays NOT NULL, so
  -- the sweep must DELETE nothing here — see the note at the end.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boq_progress_recorded_by_fkey') THEN
    ALTER TABLE ONLY public.boq_progress ADD CONSTRAINT boq_progress_recorded_by_fkey
      FOREIGN KEY (recorded_by) REFERENCES public.users(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_boq_progress_item ON public.boq_progress (boq_item_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_boq_progress_org  ON public.boq_progress (org_id, entry_date);
-- An entry may only be reversed once; a second reversal would double-credit.
CREATE UNIQUE INDEX IF NOT EXISTS uq_boq_progress_one_reversal
  ON public.boq_progress (reverses_id) WHERE (reverses_id IS NOT NULL);

-- Append-only. Enforced by trigger rather than by revoking privileges,
-- because the application connects as the table owner and a GRANT-based
-- rule would not apply to it.
CREATE OR REPLACE FUNCTION public.boq_progress_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'boq_progress is append-only: post a reversing entry instead of deleting (id %)', OLD.id;
  END IF;
  RAISE EXCEPTION 'boq_progress is append-only: entry % cannot be edited. Post a reversing entry.', OLD.id;
END $$;

DROP TRIGGER IF EXISTS trg_boq_progress_append_only ON public.boq_progress;
CREATE TRIGGER trg_boq_progress_append_only
  BEFORE UPDATE OR DELETE ON public.boq_progress
  FOR EACH ROW EXECUTE FUNCTION public.boq_progress_append_only();

-- =====================================================================
-- boq_variations  — approved scope change, deliberately outside the bill
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.boq_variations (
    id           integer NOT NULL,
    org_id       integer NOT NULL,
    boq_id       integer NOT NULL,
    -- Optional: a variation may add a brand new line rather than change one.
    boq_item_id  integer,
    reference    text,
    description  text    NOT NULL,
    qty_delta    numeric(16,3) NOT NULL DEFAULT 0,
    rate         numeric(16,2) NOT NULL DEFAULT 0,
    amount_delta numeric(18,2) GENERATED ALWAYS AS (round(qty_delta * rate, 2)) STORED,
    status       text    NOT NULL DEFAULT 'proposed',
    reason       text,
    approved_by  integer,
    approved_at  timestamp with time zone,
    created_by   integer,
    created_at   timestamp with time zone NOT NULL DEFAULT now(),
    updated_at   timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT boq_variations_status_chk
      CHECK (status IN ('proposed', 'approved', 'rejected')),
    -- Approval must say who and when, or "approved" means nothing.
    CONSTRAINT boq_variations_approval_shape_chk CHECK (
      status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
    )
);

CREATE SEQUENCE IF NOT EXISTS public.boq_variations_id_seq AS integer START WITH 1 INCREMENT BY 1 CACHE 1;
ALTER SEQUENCE public.boq_variations_id_seq OWNED BY public.boq_variations.id;
ALTER TABLE ONLY public.boq_variations ALTER COLUMN id SET DEFAULT nextval('public.boq_variations_id_seq'::regclass);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boq_variations_pkey') THEN
    ALTER TABLE ONLY public.boq_variations ADD CONSTRAINT boq_variations_pkey PRIMARY KEY (id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boq_variations_boq_fkey') THEN
    ALTER TABLE ONLY public.boq_variations ADD CONSTRAINT boq_variations_boq_fkey
      FOREIGN KEY (boq_id) REFERENCES public.boqs(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boq_variations_item_fkey') THEN
    ALTER TABLE ONLY public.boq_variations ADD CONSTRAINT boq_variations_item_fkey
      FOREIGN KEY (boq_item_id) REFERENCES public.boq_items(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boq_variations_org_fkey') THEN
    ALTER TABLE ONLY public.boq_variations ADD CONSTRAINT boq_variations_org_fkey
      FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boq_variations_approved_by_fkey') THEN
    ALTER TABLE ONLY public.boq_variations ADD CONSTRAINT boq_variations_approved_by_fkey
      FOREIGN KEY (approved_by) REFERENCES public.users(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boq_variations_created_by_fkey') THEN
    ALTER TABLE ONLY public.boq_variations ADD CONSTRAINT boq_variations_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_boq_variations_boq ON public.boq_variations (boq_id, status);

-- =====================================================================
-- Rollup view — planned, approved variations, spent, remaining
--
-- Kept as a view so the item table never stores a running total that could
-- drift from its ledger. Approved variations are added SEPARATELY rather
-- than folded into planned_amount, so overrun against the original bill
-- stays visible next to sanctioned growth.
-- =====================================================================
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
        p.last_entry_date
   FROM public.boq_items i
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

COMMENT ON VIEW public.boq_item_rollup IS
  'Per-BoQ-item aggregate: planned, approved variations, executed and remaining. Variations are added separately from planned_amount so overrun stays distinguishable from sanctioned scope growth.';

COMMIT;

\echo ''
\echo '=== Objects created ==='
SELECT tablename FROM pg_tables
 WHERE schemaname = 'public' AND tablename LIKE 'boq%' ORDER BY 1;
SELECT viewname FROM pg_views WHERE schemaname = 'public' AND viewname = 'boq_item_rollup';
SELECT tgname AS trigger_name FROM pg_trigger WHERE tgname = 'trg_boq_progress_append_only';

\echo ''
\echo 'NOTE: boq_progress.recorded_by is NOT NULL with no on-delete action, so a'
\echo 'user delete would be blocked by it. The superAdmin sweep must reassign or'
\echo 'refuse rather than NULL it — a ledger entry attributed to nobody is worse'
\echo 'than a blocked delete. Handle before the next user deletion.'
