-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Campaign-level prospecting_config overrides
-- ─────────────────────────────────────────────────────────────────────────────
-- Adds a JSONB column on prospecting_campaigns that mirrors the org-level
-- prospecting_config shape (products, value_props, target_personas,
-- case_study_summaries, hook_preferences, guardrails). When non-null and a
-- given field is non-empty, the campaign value REPLACES the org value during
-- skill context resolution (banned_phrasings and required_disclaimers remain
-- additive — campaign restrictions augment org restrictions, never loosen).
--
-- Resolution cascade:
--   org_baseline → campaign_override → user_layer (add/exclude)
--
-- See services/SkillContextService.js buildOrgContext() for the merge logic
-- and config/prospectingConfigSchema.js sanitizeCampaignConfig() for the
-- accepted shape.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE prospecting_campaigns
  ADD COLUMN IF NOT EXISTS prospecting_config_override JSONB;

-- Partial index: most campaigns won't have an override, so only index rows
-- that do. Used by the (rare) admin query "list campaigns with custom configs."
CREATE INDEX IF NOT EXISTS idx_campaigns_with_config_override
  ON prospecting_campaigns ((prospecting_config_override IS NOT NULL))
  WHERE prospecting_config_override IS NOT NULL;

COMMIT;
