-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_83_module_access_requests.sql
--
-- Batch 3: self-service module access. A user requests access to a module the org
-- has enabled but they haven't been granted; an admin approves (→ grant) or rejects
-- with a reason. Mirrors the project_members request/approve pattern.
--
-- Additive/idempotent. NUMBERING: 82 = invite_provisioning. This is 83.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

CREATE TABLE IF NOT EXISTS module_access_requests (
  id            serial PRIMARY KEY,
  org_id        integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id       integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- the colleague who would GET access
  requested_by  integer,                                                   -- the member who asked on their behalf
  module_key    text    NOT NULL,
  status        text    NOT NULL DEFAULT 'pending',
  reason        text,                       -- optional note from the requester
  review_reason text,                       -- admin's reason on reject
  reviewed_by   integer,
  reviewed_at   timestamp with time zone,
  created_at    timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT module_access_requests_status_chk CHECK (status IN ('pending','approved','rejected'))
);
-- If the table pre-existed (batch-3 v1), add the new column.
ALTER TABLE module_access_requests ADD COLUMN IF NOT EXISTS requested_by integer;

-- One open (pending) request per user+module.
CREATE UNIQUE INDEX IF NOT EXISTS uq_module_req_pending
  ON module_access_requests (org_id, user_id, module_key) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_module_req_org_status ON module_access_requests (org_id, status);

COMMIT;
