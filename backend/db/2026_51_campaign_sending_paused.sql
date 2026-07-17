-- 2026_51_campaign_sending_paused.sql
--
-- Per-campaign "pause all sending" kill switch.
--
-- Distinct from the existing prospecting_campaigns.status ('active'/'paused'/
-- 'completed'/'archived'), which is a LIFECYCLE label the firer does not read.
-- This is an OPERATIONAL brake: flip it TRUE and the SequenceStepFirer stops
-- both claiming due steps and materializing new scheduled rows for every
-- enrollment whose prospect belongs to this campaign — WITHOUT touching
-- enrollment status. Because enrollments stay 'active', clearing the flag
-- resumes instantly: the next in-window tick re-selects the (still overdue)
-- enrollments and the top-up rebuilds fresh scheduled rows. No per-enrollment
-- writes, no next_step_due re-stamping.
--
-- DEFAULT FALSE: additive and inert. Every existing campaign keeps sending
-- exactly as before until someone explicitly pauses it.
--
-- NULL / no campaign → NOT paused. The firer reads it via the existing
-- LEFT JOIN prospecting_campaigns pc and guards with `pc.sending_paused IS NOT
-- TRUE`, so unattributed prospects (campaign_id IS NULL → pc.* NULL) are never
-- affected.
--
-- Rollback: ALTER TABLE prospecting_campaigns DROP COLUMN IF EXISTS sending_paused;

BEGIN;

ALTER TABLE prospecting_campaigns
  ADD COLUMN IF NOT EXISTS sending_paused boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN prospecting_campaigns.sending_paused IS
  'Operational brake. When true, SequenceStepFirer neither fires due steps nor materializes new scheduled rows for enrollments in this campaign; enrollment status is untouched so clearing the flag resumes immediately. Independent of the lifecycle status column.';

COMMIT;
