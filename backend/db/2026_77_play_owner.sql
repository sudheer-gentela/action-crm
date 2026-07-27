-- ═══════════════════════════════════════════════════════════════════════════
-- 2026_77_play_owner.sql
--
-- A checklist item (deal_play_instances) can now name the person accountable
-- for it — surfaced per-row in the handover checklist and set when a user adds
-- an ad-hoc item directly on a handover.
--
-- Until now ownership was only expressible at the playbook-template level
-- (playbook_plays.role_id, resolved at runtime by PlayRouteResolver). That has
-- no answer for (a) showing a concrete person on the handover checklist, or
-- (b) an ad-hoc item that never came from a playbook. A nullable per-instance
-- owner covers both without disturbing the role-based routing: NULL means
-- "unassigned — fall back to role/queue routing" exactly as before.
--
-- IDEMPOTENT: safe to re-run. Also self-provisioned by seed_impl_into_org.sql
-- so the demo seed works on an org that has not yet run this migration.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.deal_play_instances
  ADD COLUMN IF NOT EXISTS owner_user_id integer REFERENCES public.users(id);

CREATE INDEX IF NOT EXISTS idx_dpi_owner_user
  ON public.deal_play_instances (owner_user_id)
  WHERE owner_user_id IS NOT NULL;

COMMENT ON COLUMN public.deal_play_instances.owner_user_id IS
  'Person accountable for this checklist item on the handover. NULL = unassigned; role/queue routing (playbook_plays.role_id → PlayRouteResolver) still applies.';

COMMIT;
