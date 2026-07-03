-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_38_targeting.sql
--
-- Signal-Based Campaigns — Phase 3: campaign activity_type + Target Profiles.
-- (Design D2/D3/D4/D16; §4 three-screen dependency Catalog → Profiles → Campaign.)
--
-- Two additive changes:
--
--   1. prospecting_campaigns.activity_type  (D16)
--      Campaign purpose / activity type metadata: outreach | field_event |
--      digital | discovery. Signal-based targeting is activity-AGNOSTIC — this
--      only drives which Execution fields the staged New Campaign shows
--      (playbook/sequence/schedule are outreach-only, D2). Existing campaigns
--      default to 'outreach' (migration-safe, D2), preserving today's behavior.
--
--      The Target Criteria themselves do NOT live in a column — they ride the
--      existing prospecting_config_override JSONB via a new `targeting` section
--      in prospectingConfigSchema (org → campaign → user cascade, reusing the
--      config plumbing). No schema change needed for criteria.
--
--   2. target_profiles  (D3/D4)
--      Reusable, function-tagged Target Criteria sets. A campaign STARTS FROM a
--      profile (its criteria are copied into the campaign's targeting override
--      at creation — a profile is a template, not a live link, so later profile
--      edits never silently mutate running campaigns). Org-shared, exactly like
--      the signal catalog (D10): every rep/admin reads the same library;
--      rep-created rows carry created_by and render as "rep-added".
--
--        function_tags : jsonb text[]; [] = "Any" (mirrors signal_defs, D6).
--        criteria      : jsonb — a sanitized `targeting` block
--                        ({ filters:[], prioritizers:[] }) validated by
--                        prospectingConfigSchema.cleanTargeting before write.
--
-- No RLS (matches the entity_custom_fields / signal_defs family): explicit
-- org_id scoping in every query. Safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. Campaign activity_type (D16) ─────────────────────────────────────────
ALTER TABLE prospecting_campaigns
  ADD COLUMN IF NOT EXISTS activity_type varchar(20) NOT NULL DEFAULT 'outreach';

-- Constraint added separately + guarded so re-runs don't error on the dup.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_pc_activity_type'
  ) THEN
    ALTER TABLE prospecting_campaigns
      ADD CONSTRAINT chk_pc_activity_type
      CHECK (activity_type IN ('outreach', 'field_event', 'digital', 'discovery'));
  END IF;
END $$;

COMMENT ON COLUMN prospecting_campaigns.activity_type IS
  'Campaign purpose (D16): outreach | field_event | digital | discovery. '
  'Metadata only — signal-based targeting is activity-agnostic; this drives '
  'which Execution fields the staged New Campaign shows (playbook/sequence/'
  'schedule are outreach-only). Existing rows default to outreach.';

-- ── 2. Target Profiles (D3/D4) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS target_profiles (
  id            serial       PRIMARY KEY,
  org_id        integer      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name          varchar(255) NOT NULL,
  description   text,
  function_tags jsonb        NOT NULL DEFAULT '[]'::jsonb,
  criteria      jsonb        NOT NULL DEFAULT '{"filters":[],"prioritizers":[]}'::jsonb,
  created_by    integer      REFERENCES users(id) ON DELETE SET NULL,
  active        boolean      NOT NULL DEFAULT true,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now()
);

COMMENT ON TABLE target_profiles IS
  'Reusable, function-tagged Target Criteria sets (D3/D4). A campaign starts '
  'from one: criteria are COPIED into the campaign targeting override at '
  'creation (template, not live link). Org-shared (D10); created_by ⇒ rep-added.';

-- Name unique within the org (the library listing key).
CREATE UNIQUE INDEX IF NOT EXISTS uq_target_profiles_org_name
  ON target_profiles (org_id, lower(name))
  WHERE active;

-- Listing: "all active profiles for this org".
CREATE INDEX IF NOT EXISTS idx_target_profiles_org_active
  ON target_profiles (org_id, active);

-- set_updated_at() already exists in prod (2026_05_prospecting_campaigns.sql).
DROP TRIGGER IF EXISTS trg_target_profiles_updated_at ON target_profiles;
CREATE TRIGGER trg_target_profiles_updated_at
  BEFORE UPDATE ON target_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
