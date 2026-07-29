-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_82_invite_provisioning.sql
--
-- Batch 2A: new-user provisioning via invitations. Extends org_invitations so an
-- invite carries a MODULE SCOPE, an optional project context (to add the accepted
-- user to a project), an optional hierarchy parent, and an APPROVAL gate (project-
-- context invites for new users wait for an admin before the email is sent).
--
-- Additive/idempotent. NUMBERING: 81 = user_module_access. This is 82.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

ALTER TABLE org_invitations ADD COLUMN IF NOT EXISTS modules      jsonb   NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE org_invitations ADD COLUMN IF NOT EXISTS role_id      integer REFERENCES org_roles(id) ON DELETE SET NULL;
ALTER TABLE org_invitations ADD COLUMN IF NOT EXISTS context_type text;                 -- 'handover' | null
ALTER TABLE org_invitations ADD COLUMN IF NOT EXISTS context_id   integer;              -- project id
ALTER TABLE org_invitations ADD COLUMN IF NOT EXISTS reports_to   integer;              -- requested hierarchy parent
ALTER TABLE org_invitations ADD COLUMN IF NOT EXISTS status       text NOT NULL DEFAULT 'approved';
ALTER TABLE org_invitations ADD COLUMN IF NOT EXISTS approved_by  integer;
ALTER TABLE org_invitations ADD COLUMN IF NOT EXISTS requested_by integer;

-- status lifecycle:
--   pending_approval → (admin approves) → approved → (invitee accepts) → accepted
--                    → (admin rejects)  → rejected
ALTER TABLE org_invitations DROP CONSTRAINT IF EXISTS org_invitations_status_chk;
ALTER TABLE org_invitations ADD  CONSTRAINT org_invitations_status_chk
  CHECK (status IN ('pending_approval','approved','accepted','rejected'));

CREATE INDEX IF NOT EXISTS idx_org_invitations_status ON org_invitations (org_id, status);

COMMIT;
