-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Prospecting Campaigns
-- ─────────────────────────────────────────────────────────────────────────────
-- A campaign is a project that runs while you prospect for a particular
-- solution. It groups prospects and, optionally, points at an existing
-- prospecting playbook and a default sequence used by "enroll all".
--
-- Design notes:
--   • One campaign per prospect (nullable FK on prospects), mirroring
--     prospects.playbook_id. A prospect can be moved between campaigns.
--   • playbook_id references an EXISTING prospecting playbook (playbooks.type
--     = 'prospecting'). There is no separate "campaign playbook" concept. It
--     is nullable — a campaign need not have a playbook at all.
--   • playbook_id / default_sequence_id are SET NULL on delete so a campaign
--     survives deletion of its playbook/sequence (it just loses the default).
--   • org_id everywhere for tenant isolation. All campaign queries MUST filter
--     by org_id.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── prospecting_campaigns ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS prospecting_campaigns (
  id                  SERIAL PRIMARY KEY,
  org_id              INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  name                TEXT    NOT NULL,
  description         TEXT,

  -- The solution this campaign prospects for. Free text so a campaign can be
  -- created before a formal product_catalog row exists.
  solution            TEXT,

  -- Optional: an existing prospecting playbook (playbooks.type = 'prospecting').
  -- SET NULL keeps the campaign alive if the playbook is later deleted.
  playbook_id         INTEGER REFERENCES playbooks(id) ON DELETE SET NULL,

  -- Optional default sequence for "enroll all".
  default_sequence_id INTEGER REFERENCES sequences(id) ON DELETE SET NULL,

  -- active | paused | completed | archived
  status              TEXT    NOT NULL DEFAULT 'active',

  -- Optional goal: number of prospects the campaign aims to qualify
  -- (stage = 'qualified_sal'). Drives the progress bar in the UI;
  -- NULL = no goal set.
  goal_qualified      INTEGER,

  -- Soft scheduling — informational only, no engine acts on these.
  start_date          DATE,
  end_date            DATE,

  owner_id            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT prospecting_campaigns_status_chk
    CHECK (status IN ('active', 'paused', 'completed', 'archived'))
);

CREATE INDEX IF NOT EXISTS idx_prospecting_campaigns_org
  ON prospecting_campaigns (org_id);
CREATE INDEX IF NOT EXISTS idx_prospecting_campaigns_org_status
  ON prospecting_campaigns (org_id, status);
CREATE INDEX IF NOT EXISTS idx_prospecting_campaigns_owner
  ON prospecting_campaigns (owner_id);

-- ── prospects.campaign_id ────────────────────────────────────────────────────
-- One campaign per prospect. ON DELETE SET NULL so deleting a campaign just
-- un-assigns its prospects rather than destroying them.
ALTER TABLE prospects
  ADD COLUMN IF NOT EXISTS campaign_id INTEGER
  REFERENCES prospecting_campaigns(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_prospects_campaign
  ON prospects (campaign_id) WHERE campaign_id IS NOT NULL;

-- Composite index for the common "campaign funnel" query
-- (WHERE org_id = ? AND campaign_id = ? GROUP BY stage).
CREATE INDEX IF NOT EXISTS idx_prospects_org_campaign_stage
  ON prospects (org_id, campaign_id, stage) WHERE deleted_at IS NULL;

-- ── updated_at trigger ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prospecting_campaigns_updated_at ON prospecting_campaigns;
CREATE TRIGGER trg_prospecting_campaigns_updated_at
  BEFORE UPDATE ON prospecting_campaigns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
