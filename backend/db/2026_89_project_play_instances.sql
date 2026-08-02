-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_89_project_play_instances.sql
--
-- Lets playbook plays activate on a project that has no deal.
--
-- Today deal_play_instances.deal_id is NOT NULL, so an internal project — which
-- has no deal by design — can never hold a play. That is why "Playbook &
-- ownership" reads "No playbook linked" with no way to change it.
--
-- Extending the existing table rather than creating a parallel one:
-- sales_handover_plays already links instances to a handover, playbook-plays
-- routes, the rule evaluator and the builder all read deal_play_instances, and
-- a second table would need every one of them duplicated. The table name is now
-- slightly wrong; that is cheaper than the fork.
--
-- deal_id becomes nullable. Every existing row keeps its value and every
-- existing query that filters on deal_id keeps working unchanged — a NULL
-- simply never matches `deal_id = $1`.
--
-- Safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE public.deal_play_instances
  ADD COLUMN IF NOT EXISTS handover_id integer;

ALTER TABLE public.deal_play_instances
  ALTER COLUMN deal_id DROP NOT NULL;

-- An instance belongs to exactly one thing. Allowing both would make "whose
-- play is this" ambiguous, and allowing neither would orphan it.
ALTER TABLE public.deal_play_instances
  DROP CONSTRAINT IF EXISTS deal_play_instances_owner_chk;
ALTER TABLE public.deal_play_instances
  ADD CONSTRAINT deal_play_instances_owner_chk
  CHECK (
    (deal_id IS NOT NULL AND handover_id IS NULL)
    OR
    (deal_id IS NULL AND handover_id IS NOT NULL)
  );

ALTER TABLE public.deal_play_instances
  DROP CONSTRAINT IF EXISTS deal_play_instances_handover_fkey;
ALTER TABLE public.deal_play_instances
  ADD CONSTRAINT deal_play_instances_handover_fkey
  FOREIGN KEY (handover_id) REFERENCES public.sales_handovers(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_dpi_handover
  ON public.deal_play_instances (handover_id, stage_key)
  WHERE handover_id IS NOT NULL;

-- ── Let a project carry a playbook chosen after creation ────────────────────
-- playbook_id has only ever been written by initiate(), from the org default
-- handover_s2i playbook. Projects created any other way had no route to one.
-- No schema change is needed here — the column already exists — but the index
-- makes "which projects use this playbook" answerable, which the playbook
-- picker needs.
CREATE INDEX IF NOT EXISTS idx_sales_handovers_playbook
  ON public.sales_handovers (org_id, playbook_id)
  WHERE playbook_id IS NOT NULL;

COMMENT ON COLUMN public.deal_play_instances.handover_id IS
  'Set when the play belongs to a project rather than a deal. Exactly one of deal_id / handover_id is non-null.';

COMMIT;
