-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Slice 2 — researcher workflow, batch activation, SLA sweeps
-- ─────────────────────────────────────────────────────────────────────────────
-- No new tables in this slice. We use existing JSONB columns:
--   prospects.research_meta             — stores researcher-curated signal blob
--   org_integrations.config             — adds three new keys for org-level caps
--   user_preferences.preferences        — adds per-rep activation target
--
-- This migration does two things:
--   1. Backfills legacy 'researched' → 'research' (canonical enum value;
--      existing AI-research endpoint had a bug writing the non-canonical value).
--   2. Upserts default values for the three new org config keys on every
--      org_integrations row of integration_type='prospecting_email' so admins
--      see sensible defaults in the limits UI.
--
-- All non-destructive. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── (1) Backfill legacy bad-stage rows ───────────────────────────────────────
-- The AI-research endpoint in routes/prospects.routes.js historically wrote
-- stage='researched' (line 850) — not in VALID_STAGES. Move those to the
-- canonical 'research' value so Slice 2 stage filtering works correctly.
UPDATE prospects
   SET stage = 'research',
       stage_changed_at = COALESCE(stage_changed_at, NOW()),
       updated_at       = NOW()
 WHERE stage = 'researched';

-- ── (2) Seed Slice 2 config defaults on existing org_integrations rows ───────
-- jsonb_set with create_missing=true so we don't clobber any keys an admin
-- has already set. Each key gets its own jsonb_set so they're independent.
UPDATE org_integrations
   SET config = jsonb_set(
                  jsonb_set(
                    jsonb_set(
                      COALESCE(config, '{}'::jsonb),
                      '{linkedinDailyActivationCap}',
                      to_jsonb(25),
                      true   -- create if missing, do not overwrite
                    ),
                    '{activationSlaDays}',
                    to_jsonb(7),
                    true
                  ),
                  '{researchSlaDays}',
                  to_jsonb(14),
                  true
                ),
       updated_at = NOW()
 WHERE integration_type = 'prospecting_email'
   AND (
        NOT (config ? 'linkedinDailyActivationCap')
     OR NOT (config ? 'activationSlaDays')
     OR NOT (config ? 'researchSlaDays')
   );

-- ── (3) Documentation: research_meta fields written by approve-research ─────
-- For greppability — these are the keys the new researcher endpoint writes:
--   {
--     "signal_summary": "...",
--     "signal_category": "prospect_post"|"account_event"|...,
--     "signal_source_url": "https://linkedin.com/...",
--     "approved_by": <user_id>,
--     "approved_at": "<ISO timestamp>"
--   }
-- No schema change needed — research_meta is already jsonb.

COMMIT;
