-- 2026_50_campaign_stop_on_reply.sql
--
-- Per-campaign toggle for the reply auto-stop (design doc P5b follow-up).
-- DEFAULT TRUE: replying prospects stop receiving sequence steps unless a
-- campaign explicitly opts out (e.g. a nurture drip where a "thanks!" reply
-- should not end the program). Governs BOTH reply sources uniformly — inbound
-- email and inbound LinkedIn (linkedin_message_events).
--
-- NULL / no campaign  → treated as TRUE (stop). The firer reads
-- camp_stop_on_reply via LEFT JOIN and guards with `!== false`, so
-- enrollments without a campaign keep today's safe behavior.
--
-- Note the asymmetry with stop_on_connection_accept (2026_43): accept-stop is
-- per-SEQUENCE and opt-IN; reply-stop is per-CAMPAIGN and opt-OUT. Replying is
-- a universal "stop selling at me" signal; accepting is merely a milestone.
--
-- Rollback: ALTER TABLE prospecting_campaigns DROP COLUMN IF EXISTS stop_on_reply;

BEGIN;

ALTER TABLE prospecting_campaigns
  ADD COLUMN IF NOT EXISTS stop_on_reply boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN prospecting_campaigns.stop_on_reply IS
  'When true (default), an inbound reply (email or LinkedIn) stops active sequence enrollments for prospects in this campaign. Opt-out per campaign.';

COMMIT;
