-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_79_project_contacts.sql
--
-- Replace the bespoke, denormalised sales_handover_stakeholders table with a
-- clean polymorphic join, project_contacts, mirroring deal_contacts. Every
-- project person is now a real contact (contact_id NOT NULL) — so phone/email
-- always resolve and WhatsApp/email work with no special-casing.
--
-- CLEAN CUTOVER: no production data yet, so we drop the old table rather than
-- backfill. (Sample-seed rows are re-created into project_contacts by the seed.)
--
-- Also adds a per-project contact_add_policy (who may add project contacts).
--
-- NUMBERING: 78 = whatsapp_stage2. This is 79.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

-- Polymorphic project ↔ contact join. context_type is 'handover' today; a
-- future Services module reuses the same table with context_type='service'.
CREATE TABLE IF NOT EXISTS project_contacts (
  id           serial PRIMARY KEY,
  org_id       integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  context_type text    NOT NULL DEFAULT 'handover',
  context_id   integer NOT NULL,
  contact_id   integer NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  role         text    NOT NULL DEFAULT 'other',
  is_primary   boolean NOT NULL DEFAULT false,
  notes        text,
  created_by   integer,
  created_at   timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (context_type, context_id, contact_id),
  CONSTRAINT project_contacts_role_chk CHECK (role IN
    ('implementation_lead','day_to_day_admin','go_live_approver','exec_sponsor','technical_lead','other'))
);
CREATE INDEX IF NOT EXISTS idx_project_contacts_ctx     ON project_contacts (context_type, context_id);
CREATE INDEX IF NOT EXISTS idx_project_contacts_contact ON project_contacts (org_id, contact_id);

-- Per-project policy for who may add project contacts. Defaults to deal owner +
-- project/service owner + admins; owners/admins can narrow, widen, or name users.
ALTER TABLE sales_handovers ADD COLUMN IF NOT EXISTS contact_add_policy jsonb NOT NULL
  DEFAULT '{"deal_owner":true,"service_owner":true,"admins":true,"named_users":[]}'::jsonb;

-- The old table has an inbound FK from whatsapp_thread_participants.stakeholder_id.
-- That link is redundant now (participants already carry contact_id), so drop it.
ALTER TABLE whatsapp_thread_participants DROP CONSTRAINT IF EXISTS whatsapp_thread_participants_stakeholder_id_fkey;
ALTER TABLE whatsapp_thread_participants DROP COLUMN     IF EXISTS stakeholder_id;

DROP TABLE IF EXISTS sales_handover_stakeholders;

COMMIT;
