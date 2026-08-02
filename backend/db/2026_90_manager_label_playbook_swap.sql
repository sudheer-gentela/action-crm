-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_90_project_manager_label_and_playbook_swap.sql
--
-- 1. A configurable name for the person accountable for a project.
--
--    The column is assigned_service_owner_id, but the screens have been calling
--    it three different things — "Project owner" on the detail header,
--    "Service owner" in the list and the create form. Orgs also disagree about
--    the right word: Project Manager, Delivery Lead, Engagement Manager.
--
--    Resolution order: project override -> org default -> 'Project Manager'.
--    The column is NOT renamed. Renaming assigned_service_owner_id would touch
--    every query in handover.service.js plus the reporting and health services
--    for zero functional gain; the label is presentation, so it lives in
--    presentation config.
--
-- 2. Playbook swaps need a record of what was replaced.
--
--    Swapping used to be refused outright, because the old playbook's plays
--    would have been left attached with no owner. Swapping is now allowed and
--    cancels them — so the project needs to remember it happened.
--
-- Safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE public.sales_handovers
  ADD COLUMN IF NOT EXISTS manager_label       text,
  ADD COLUMN IF NOT EXISTS playbook_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS playbook_changed_by integer,
  ADD COLUMN IF NOT EXISTS previous_playbook_id integer;

-- A blank label is not an override, it is a mistake. Reject it here so the
-- resolution chain never has to distinguish '' from NULL.
ALTER TABLE public.sales_handovers
  DROP CONSTRAINT IF EXISTS sales_handovers_manager_label_chk;
ALTER TABLE public.sales_handovers
  ADD CONSTRAINT sales_handovers_manager_label_chk
  CHECK (manager_label IS NULL OR btrim(manager_label) <> '');

-- Cancelled plays are kept, not deleted, so "what was on the old checklist and
-- how far had we got" stays answerable after a swap. This index keeps the
-- active-play queries from paying for that history.
CREATE INDEX IF NOT EXISTS idx_dpi_active
  ON public.deal_play_instances (handover_id, status)
  WHERE handover_id IS NOT NULL AND status <> 'cancelled';

COMMENT ON COLUMN public.sales_handovers.manager_label IS
  'Per-project override for what the accountable person is called. NULL = use the org default.';
COMMENT ON COLUMN public.sales_handovers.previous_playbook_id IS
  'The playbook replaced by the most recent swap. Its plays are cancelled, not deleted.';

COMMIT;
