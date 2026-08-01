-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_87_internal_projects.sql
--
-- Lets a project exist without a deal, and adds internal (non-customer)
-- projects alongside customer delivery.
--
-- Four changes:
--   1. `name`         — sales_handovers has never had one. Today the label on
--                       every project screen comes from deals.name, which is
--                       why a project cannot exist without a deal even in
--                       principle. Customer projects keep falling back to the
--                       deal name; nothing is backfilled.
--   2. `project_kind` — 'customer' | 'internal'. Internal projects carry no
--                       account: adding your own company to Accounts to satisfy
--                       a foreign key would pollute pipeline, prospecting and
--                       every account-grouped report.
--   3. `budget`       — internal projects only, for now. Deliberately NOT
--                       reusing contract_value: revenue is money in, budget is
--                       money out, and summing them silently produces a
--                       plausible, wrong number. Keeping them apart also leaves
--                       room for margin later, when a customer project needs
--                       both on the same row.
--   4. deal_id and account_id become nullable. UNIQUE (deal_id) is unaffected —
--      Postgres allows many NULLs in a unique index.
--
-- `project_kind` and "has a deal" stay independent, so a customer project with
-- no deal is a supported exception rather than a special case.
--
-- Safe to run more than once. No data is rewritten: every existing row is a
-- customer project with a deal, which is exactly what the defaults express.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE public.sales_handovers
  ADD COLUMN IF NOT EXISTS name         text,
  ADD COLUMN IF NOT EXISTS project_kind text NOT NULL DEFAULT 'customer',
  ADD COLUMN IF NOT EXISTS budget       numeric(15,2);

ALTER TABLE public.sales_handovers
  DROP CONSTRAINT IF EXISTS sales_handovers_project_kind_chk;
ALTER TABLE public.sales_handovers
  ADD CONSTRAINT sales_handovers_project_kind_chk
  CHECK (project_kind IN ('customer','internal'));

-- Drop NOT NULL. Existing rows all have values, so nothing changes for them.
ALTER TABLE public.sales_handovers ALTER COLUMN deal_id    DROP NOT NULL;
ALTER TABLE public.sales_handovers ALTER COLUMN account_id DROP NOT NULL;

-- Guard rails the application would otherwise have to remember:
--   internal  → never an account, never a deal
--   customer  → must be identifiable, so an account or a deal (usually a deal;
--               a customer project without one is the documented exception)
ALTER TABLE public.sales_handovers
  DROP CONSTRAINT IF EXISTS sales_handovers_kind_shape_chk;
ALTER TABLE public.sales_handovers
  ADD CONSTRAINT sales_handovers_kind_shape_chk
  CHECK (
    (project_kind = 'internal' AND account_id IS NULL AND deal_id IS NULL)
    OR
    (project_kind = 'customer' AND (account_id IS NOT NULL OR deal_id IS NOT NULL))
  );

-- A project with no deal has no deal name to borrow, so it must carry its own.
ALTER TABLE public.sales_handovers
  DROP CONSTRAINT IF EXISTS sales_handovers_name_required_chk;
ALTER TABLE public.sales_handovers
  ADD CONSTRAINT sales_handovers_name_required_chk
  CHECK (deal_id IS NOT NULL OR (name IS NOT NULL AND btrim(name) <> ''));

-- Budget is meaningless on a customer project until margin exists, and the UI
-- does not surface it there. Enforcing that here stops a stray write from
-- creating rows that later break a revenue-vs-budget report.
ALTER TABLE public.sales_handovers
  DROP CONSTRAINT IF EXISTS sales_handovers_budget_internal_chk;
ALTER TABLE public.sales_handovers
  ADD CONSTRAINT sales_handovers_budget_internal_chk
  CHECK (budget IS NULL OR project_kind = 'internal');

CREATE INDEX IF NOT EXISTS idx_sales_handovers_kind
  ON public.sales_handovers (org_id, project_kind);

COMMENT ON COLUMN public.sales_handovers.name IS
  'Project name. Required when there is no deal; otherwise falls back to deals.name.';
COMMENT ON COLUMN public.sales_handovers.project_kind IS
  'customer = delivery for an account. internal = run inside the org, no account, no deal.';
COMMENT ON COLUMN public.sales_handovers.budget IS
  'Planned spend, internal projects only. Not revenue — see contract_value.';

COMMIT;
