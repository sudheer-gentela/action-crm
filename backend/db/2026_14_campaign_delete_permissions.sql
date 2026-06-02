-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Campaign-delete permission model
-- 2026_14_campaign_delete_permissions.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Adds the storage for the layered campaign-delete permission model:
--
--   LAYER 1 — Org-wide switch ("campaign owners may delete their own
--             campaigns"). Stored as a key inside a NEW per-org JSONB blob
--             column `org_action_config.campaign_settings`, following the
--             existing one-blob-per-domain convention already used by
--             `ai_settings`, `call_settings`, and `enrichment`. We deliberately
--             do NOT bury this under `ai_settings` — it is not an AI setting.
--             Read/written via services/campaignSettings.service.js.
--
--             Key: campaign_settings.owner_delete_enabled (boolean).
--             ABSENT  ⇒ treated as TRUE (owners may delete) — see
--             campaignSettings.service.js SYSTEM_DEFAULTS. So a fresh org with
--             an empty '{}' blob behaves as "enabled", matching the agreed
--             default-ON semantics with no backfill required.
--
--   LAYER 2 — Per-campaign lock. Three columns on prospecting_campaigns:
--             delete_locked (the flag, default FALSE = unlocked), plus
--             delete_locked_by / delete_locked_at for audit.
--
-- ── Schema caveats (verified against the live DB, 2026-06) ───────────────────
--   • org_action_config live columns are: id, org_id, ai_settings, updated_at,
--     updated_by, call_settings, enrichment. (Note: `prospecting_escalation`
--     is NOT a live column — that service runs on its try/catch fallback. We
--     add a real column here so the campaign-delete policy is durable.)
--   • prospecting_campaigns was owner-scoped OUT OF BAND
--     (2026_13_campaign_owner_scoping made owner_id NOT NULL + added an index);
--     that .sql is not in the repo. We therefore make NO assumptions about its
--     exact current shape and use ADD COLUMN IF NOT EXISTS throughout.
--
-- Idempotent: every ADD COLUMN uses IF NOT EXISTS; the FK is guarded by a
-- pg_constraint existence check. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── LAYER 1: org-wide switch ─────────────────────────────────────────────────
-- New domain blob. NOT NULL DEFAULT '{}' means every existing row is
-- backfilled to an empty object automatically, which the service resolves to
-- the system default (owner_delete_enabled = true). No data migration needed.
ALTER TABLE org_action_config
  ADD COLUMN IF NOT EXISTS campaign_settings JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Defensive: if the column somehow pre-existed as NULLable with NULLs present,
-- normalise them so the `||` merge in setForOrg never operates on NULL.
UPDATE org_action_config
   SET campaign_settings = '{}'::jsonb
 WHERE campaign_settings IS NULL;

-- ── LAYER 2: per-campaign lock ───────────────────────────────────────────────
-- delete_locked default FALSE = unlocked. delete_locked_by / _at are audit.
ALTER TABLE prospecting_campaigns
  ADD COLUMN IF NOT EXISTS delete_locked    BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS delete_locked_by INTEGER,
  ADD COLUMN IF NOT EXISTS delete_locked_at TIMESTAMPTZ;

-- Defensive NULL backfill in case delete_locked pre-existed as NULLable.
UPDATE prospecting_campaigns
   SET delete_locked = FALSE
 WHERE delete_locked IS NULL;

-- Audit FK for delete_locked_by → users(id). SET NULL on user delete so a
-- removed admin doesn't cascade-delete campaigns; the lock flag stays intact,
-- only the "who locked it" attribution is cleared. Guarded so re-runs are safe.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'prospecting_campaigns_delete_locked_by_fkey'
  ) THEN
    ALTER TABLE prospecting_campaigns
      ADD CONSTRAINT prospecting_campaigns_delete_locked_by_fkey
      FOREIGN KEY (delete_locked_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMIT;
