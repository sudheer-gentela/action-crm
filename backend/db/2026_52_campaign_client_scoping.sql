-- ═══════════════════════════════════════════════════════════════════════════
-- 2026_52_campaign_client_scoping.sql
--
-- Agency module Phase 1 — client-scoped campaigns.
--
-- Problem: the agency module's downstream (sending) side is already
-- client-aware — SequenceStepFirer.resolveSender() / pickEmailSenderWithCapacity()
-- prefer a client-owned sender when prospect.client_id is set — but nothing
-- upstream ever SETS prospect.client_id except the manual bulk-assign endpoint
-- (POST /clients/:id/prospects/assign). Extension captures, CSV imports,
-- bulk-campaign moves, and HubSpot form inflows all land with client_id NULL,
-- so client prospects are invisible in the client dashboard and their email
-- fires from the rep's personal sender instead of the client's mailbox.
--
-- Fix, two parts:
--
--   1. prospecting_campaigns.client_id — a campaign may belong to one agency
--      client. Nullable; NULL = ordinary (non-agency) campaign, so every
--      existing campaign and every non-agency org is untouched.
--      FK style mirrors prospects.client_id: ON DELETE SET NULL (tag
--      semantics — deleting a client must not delete or orphan campaigns).
--
--   2. trg_prospects_inherit_campaign_client — BEFORE INSERT OR UPDATE OF
--      campaign_id ON prospects. When a prospect is placed into a campaign
--      that belongs to a client and the prospect has no client yet, stamp
--      the campaign's client_id onto the prospect.
--
--      A trigger rather than per-call-site app code, deliberately: prospects
--      acquire campaign_id from at least six independent write paths
--      (extension create via assignCampaignAndEnroll, CSV import INSERT,
--      POST /bulk-campaign, undelete-twin campaign sync, HubSpot form ingest,
--      push-to-target) and new paths keep being added. One trigger keeps the
--      invariant in a single place with zero changes to those paths.
--
--      Rules (conservative on purpose):
--        • set-if-null ONLY — a prospect that already belongs to a client is
--          NEVER silently reassigned when moved into another client's
--          campaign. Cross-client moves stay visible instead of hidden.
--        • never clears — removing a prospect from a campaign
--          (campaign_id → NULL) does NOT strip client membership; leaving a
--          campaign is not leaving the client.
--        • org-checked — the campaign lookup is keyed on (id, org_id) so a
--          forged cross-org campaign_id can never leak another org's client.
--
--      Cost: one PK SELECT per prospect write that touches campaign_id, and
--      only when campaign_id lands non-NULL on a client-less prospect.
--      UPDATE OF campaign_id keeps the trigger off the (much hotter)
--      stage/engagement update paths.
--
-- Backfill of EXISTING prospects when a campaign is later assigned to a
-- client happens in app code (PUT /prospecting-campaigns/:id stamps current
-- members set-if-null, and reports the count) — not here, because at
-- migration time no campaign has a client_id yet, so a backfill would be a
-- no-op by construction.
--
-- ADD COLUMN with no default is metadata-only (no table rewrite). Idempotent:
-- IF NOT EXISTS on the column/index, guarded DO-block on the FK, and
-- CREATE OR REPLACE + DROP IF EXISTS on the trigger pair. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. prospecting_campaigns.client_id ───────────────────────────────────────

ALTER TABLE prospecting_campaigns
  ADD COLUMN IF NOT EXISTS client_id integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'prospecting_campaigns_client_id_fkey'
       AND conrelid = 'prospecting_campaigns'::regclass
  ) THEN
    ALTER TABLE prospecting_campaigns
      ADD CONSTRAINT prospecting_campaigns_client_id_fkey
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_campaigns_client_id
  ON prospecting_campaigns (client_id)
  WHERE client_id IS NOT NULL;

COMMENT ON COLUMN prospecting_campaigns.client_id IS
  'Agency module: the client this campaign runs for. NULL = ordinary campaign. '
  'Prospects placed into a client campaign inherit client_id (set-if-null) via '
  'trg_prospects_inherit_campaign_client — see 2026_52_campaign_client_scoping.sql.';

-- ── 2. Inherit trigger on prospects ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION trg_prospects_inherit_campaign_client()
RETURNS trigger AS $$
DECLARE
  v_client_id integer;
BEGIN
  -- Only act when the prospect is being placed into a campaign and does not
  -- already belong to a client. Set-if-null; never overwrite; never clear.
  IF NEW.campaign_id IS NOT NULL AND NEW.client_id IS NULL THEN
    SELECT client_id
      INTO v_client_id
      FROM prospecting_campaigns
     WHERE id     = NEW.campaign_id
       AND org_id = NEW.org_id;          -- org-checked: no cross-org leak

    IF v_client_id IS NOT NULL THEN
      NEW.client_id := v_client_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prospects_inherit_campaign_client ON prospects;

CREATE TRIGGER trg_prospects_inherit_campaign_client
  BEFORE INSERT OR UPDATE OF campaign_id ON prospects
  FOR EACH ROW
  EXECUTE FUNCTION trg_prospects_inherit_campaign_client();

COMMIT;

-- ── Verification (run manually after applying) ───────────────────────────────
--
--   \d prospecting_campaigns          -- client_id column + FK + partial index
--   \d prospects                      -- trigger listed under Triggers
--
--   -- Dry-run the inheritance on a test org:
--   --   1. UPDATE prospecting_campaigns SET client_id = <cid> WHERE id = <camp>;
--   --   2. UPDATE prospects SET campaign_id = <camp> WHERE id = <test prospect>;
--   --   3. SELECT id, campaign_id, client_id FROM prospects WHERE id = <test prospect>;
--   --      → client_id should now equal <cid>.
--
-- Rollback (manual, if ever needed):
--   DROP TRIGGER IF EXISTS trg_prospects_inherit_campaign_client ON prospects;
--   DROP FUNCTION IF EXISTS trg_prospects_inherit_campaign_client();
--   ALTER TABLE prospecting_campaigns DROP COLUMN IF EXISTS client_id;
--   (Column drop also removes the FK and partial index. prospects.client_id
--    values already stamped are left as-is — they are legitimate data.)
