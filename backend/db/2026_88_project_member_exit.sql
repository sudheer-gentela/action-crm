-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_88_project_member_exit.sql
--
-- Lets a project member decline an invitation or leave a project they were on,
-- and records who did it and why.
--
-- Two new statuses rather than reusing 'rejected':
--   rejected  — an admin refused the request           ("we said no")
--   declined  — the person turned down the invitation   ("they said no")
--   left      — the person was on the project and stepped off
--
-- Collapsing these would destroy the distinction between a refusal by the org
-- and a refusal by the individual, which is exactly what someone reviewing a
-- project's history needs to tell apart.
--
-- Separate exit_* columns rather than reusing review_by / reviewed_at /
-- review_reason: those mean "an admin reviewed this request". Writing a
-- self-departure into them would make the audit trail claim an admin acted when
-- nobody did.
--
-- Safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE public.project_members
  ADD COLUMN IF NOT EXISTS exited_at   timestamptz,
  ADD COLUMN IF NOT EXISTS exit_reason text;

ALTER TABLE public.project_members
  DROP CONSTRAINT IF EXISTS project_members_status_chk;
ALTER TABLE public.project_members
  ADD CONSTRAINT project_members_status_chk
  CHECK (status IN ('pending','approved','rejected','declined','left'));

-- A row that records a departure must say when it happened; a row that does not
-- must not carry a stale timestamp from an earlier state.
ALTER TABLE public.project_members
  DROP CONSTRAINT IF EXISTS project_members_exit_shape_chk;
ALTER TABLE public.project_members
  ADD CONSTRAINT project_members_exit_shape_chk
  CHECK (
    (status IN ('declined','left') AND exited_at IS NOT NULL)
    OR
    (status NOT IN ('declined','left') AND exited_at IS NULL)
  );

-- The partial index matters: every "is this person on the project" lookup
-- filters status = 'approved', and departed rows are kept for history rather
-- than deleted, so the table will accumulate rows that those queries ignore.
CREATE INDEX IF NOT EXISTS idx_project_members_approved
  ON public.project_members (context_type, context_id, user_id)
  WHERE status = 'approved';

COMMENT ON COLUMN public.project_members.exited_at IS
  'When the member declined or left. NULL for every other status.';
COMMENT ON COLUMN public.project_members.exit_reason IS
  'Optional note from the member on why they declined or left. Distinct from review_reason, which is an admin decision.';

COMMIT;
