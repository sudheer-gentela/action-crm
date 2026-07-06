-- ============================================================================
-- 2026_41_activity_inflow.sql
--
-- Phase 8 of Signal-Based Campaigns — Motion 2 (activity webhooks).
--
-- One table: activity_inflow_events — the durable log of every inbound
-- activity event (HubSpot form submissions first; the provider column keeps
-- the surface generic for later sources). Every event is recorded whether it
-- executes immediately (mode='auto', the default) or parks for review
-- (mode='review' or guard overflow), so the org admin can always inspect
-- "the first few" even in auto mode.
--
-- Status lifecycle:
--   pending_review → processed | skipped        (review mode / cap overflow)
--   processed / skipped / error                 (auto mode, terminal)
--
-- dedupe_key makes webhook retries and the two-property subscription
-- (recent_conversion_event_name + recent_conversion_date fire per submission)
-- idempotent: one row per (provider, contact, minute bucket) per org.
--
-- resolution jsonb records what happened (or would happen, for review):
--   { routed_via: 'existing_prospect'|'account_campaign'|'default_campaign',
--     campaign_id, campaign_name, prospect_id, prospect_created: bool,
--     owner_id, signal_written: bool, skip_reason?: text }
--
-- Idempotent: safe to re-run. No-op if already applied.
-- Run AFTER 2026_36 → 2026_40.
-- ============================================================================

CREATE TABLE IF NOT EXISTS activity_inflow_events (
  id              serial PRIMARY KEY,
  org_id          integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider        text    NOT NULL,                 -- 'hubspot' (more later)
  dedupe_key      text    NOT NULL,                 -- provider-scoped idempotency key
  event_type      text    NOT NULL DEFAULT 'form_submission',
  form_name       text,                             -- recent_conversion_event_name
  occurred_at     timestamptz NOT NULL,             -- event time (why-now anchor)
  external_id     text,                             -- provider object id (HubSpot contact id)
  contact_snapshot jsonb  NOT NULL DEFAULT '{}'::jsonb,  -- what we read back from the provider
  status          text    NOT NULL DEFAULT 'pending_review',
  resolution      jsonb   NOT NULL DEFAULT '{}'::jsonb,
  error_detail    text,
  reviewed_by     integer REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_aie_status
    CHECK (status IN ('pending_review', 'processed', 'skipped', 'error')),
  CONSTRAINT chk_aie_event_type
    CHECK (event_type IN ('form_submission'))
);

-- Idempotency: HubSpot retries + the dual-property subscription collapse to
-- one row. dedupe_key already embeds portal + contact + minute bucket.
CREATE UNIQUE INDEX IF NOT EXISTS uq_aie_org_provider_dedupe
  ON activity_inflow_events (org_id, provider, dedupe_key);

-- The admin panel's two reads: recent events, and the pending-review queue.
CREATE INDEX IF NOT EXISTS idx_aie_org_created
  ON activity_inflow_events (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aie_org_status
  ON activity_inflow_events (org_id, status)
  WHERE status = 'pending_review';

-- updated_at trigger — reuse the house trigger fn if present, else create it
-- (schema.sql ships update_updated_at_column; guard anyway for partial DBs).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at_column'
  ) THEN
    CREATE FUNCTION update_updated_at_column() RETURNS trigger AS $fn$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_aie_updated_at ON activity_inflow_events;
CREATE TRIGGER trg_aie_updated_at
  BEFORE UPDATE ON activity_inflow_events
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE activity_inflow_events IS
  'P8 Motion-2 inbound activity log (HubSpot form submissions). Every inbound event is recorded here regardless of form_inflow.mode; auto mode executes immediately, review mode parks as pending_review. dedupe_key = provider-scoped idempotency (portal:contact:minute for HubSpot).';
