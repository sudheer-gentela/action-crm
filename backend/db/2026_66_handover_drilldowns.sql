-- ═══════════════════════════════════════════════════════════════════════════
-- 2026_66_handover_drilldowns.sql
--
-- Additive schema for the handover drill-downs:
--   1. sales_handover_commitment_events — append-only activity log per
--      deliverable (what happened, and when), powering the deliverable drill-down.
--   2. deal_play_instances.completion_note / completion_evidence — how a
--      checklist item was closed out (a note plus a reference to the email /
--      WhatsApp message that closed it). Mirrors the actions-engine evidence
--      pattern (actions.completion_evidence).
--
-- No destructive changes. Idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS sales_handover_commitment_events (
  id            serial PRIMARY KEY,
  commitment_id integer     NOT NULL REFERENCES sales_handover_commitments(id) ON DELETE CASCADE,
  org_id        integer     NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_type    varchar(30) NOT NULL,   -- created | status_change | owner_change | due_change | note | closed
  detail        text,
  from_status   varchar(20),
  to_status     varchar(20),
  created_by    integer REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shce_commitment
  ON sales_handover_commitment_events (commitment_id, created_at);

-- How a checklist play was closed out.
--   completion_evidence shape:
--     { "type": "email"|"whatsapp"|"note"|"document", "refId": <int|null>, "snippet": "<text>" }
ALTER TABLE deal_play_instances ADD COLUMN IF NOT EXISTS completion_note     text;
ALTER TABLE deal_play_instances ADD COLUMN IF NOT EXISTS completion_evidence jsonb;

COMMIT;
