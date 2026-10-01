-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_144_paction_prospect_nullable.sql
--
-- CampaignSweeps (09:00 UTC) writes ONE rolled-up prospecting_action per
-- campaign — "N prospects waiting to be activated" — with prospect_id NULL by
-- design. prospect_id was NOT NULL, so every run failed with
--   null value in column "prospect_id" of relation "prospecting_actions"
-- and the campaign SLA nag has never fired.
--
-- Readers are already null-safe: prospecting-actions, unified-actions and
-- actions routes all LEFT JOIN prospects, and unified-actions maps a null
-- prospect_id to prospect:null. The escalation/notification scans INNER JOIN
-- prospects, so campaign-level rows are simply not escalated — acceptable,
-- they are owner nags, not per-prospect tasks.
--
-- The FK is kept: a non-null prospect_id must still point at a real prospect.
-- The CHECK stops anything other than the two sweep types from being written
-- without a prospect, so this cannot quietly become a dumping ground.
--
-- NUMBERING: 143 is the latest. This is 144.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

ALTER TABLE prospecting_actions ALTER COLUMN prospect_id DROP NOT NULL;

ALTER TABLE prospecting_actions DROP CONSTRAINT IF EXISTS chk_paction_prospect_required;
ALTER TABLE prospecting_actions ADD CONSTRAINT chk_paction_prospect_required
  CHECK (
    prospect_id IS NOT NULL
    OR action_type IN ('campaign_activation_overdue', 'campaign_research_overdue')
  );

COMMIT;
