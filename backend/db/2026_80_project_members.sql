-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_80_project_members.sql
--
-- Layer A: internal "project users" (parallel to deal_team_members) with a
-- request → approve/reject workflow, plus multi-value org email domains that
-- drive same-domain auto-approval.
--
-- Additive and idempotent.
-- NUMBERING: 79 = project_contacts. This is 80.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

-- An org can own one or more email domains. Same-domain membership requests are
-- eligible for auto-approval (when a seat is also available).
CREATE TABLE IF NOT EXISTS org_email_domains (
  id         serial PRIMARY KEY,
  org_id     integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  domain     text    NOT NULL,
  created_by integer,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_org_email_domain ON org_email_domains (org_id, lower(domain));

-- Internal team members on a project, mirroring deal_team_members but polymorphic
-- (context_type 'handover' now, 'service' later) and gated by an approval status.
-- Uniqueness is per-project, so a user can sit on many projects with different roles.
CREATE TABLE IF NOT EXISTS project_members (
  id            serial PRIMARY KEY,
  org_id        integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  context_type  text    NOT NULL DEFAULT 'handover',
  context_id    integer NOT NULL,
  user_id       integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id       integer REFERENCES org_roles(id) ON DELETE SET NULL,
  custom_role   text,
  status        text    NOT NULL DEFAULT 'pending',
  requested_by  integer,
  reviewed_by   integer,
  review_reason text,
  reviewed_at   timestamp with time zone,
  created_at    timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (context_type, context_id, user_id),
  CONSTRAINT project_members_status_chk CHECK (status IN ('pending','approved','rejected'))
);
CREATE INDEX IF NOT EXISTS idx_project_members_ctx    ON project_members (context_type, context_id, status);
CREATE INDEX IF NOT EXISTS idx_project_members_user   ON project_members (org_id, user_id);

COMMIT;
