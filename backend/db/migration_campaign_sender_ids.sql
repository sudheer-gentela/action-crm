-- Phase 2: per-campaign sender selection
-- Additive and safe. NULL (the default) means "use all of the owner's active
-- senders" — the existing behaviour — so no backfill is needed and live
-- campaigns are unaffected until a user explicitly picks a subset.
--
-- Dry-run check first (should return 0 rows if the column doesn't exist yet):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'prospecting_campaigns' AND column_name = 'sender_account_ids';

ALTER TABLE prospecting_campaigns
  ADD COLUMN IF NOT EXISTS sender_account_ids INTEGER[] DEFAULT NULL;

-- Verify:
--   SELECT id, name, sender_account_ids FROM prospecting_campaigns LIMIT 5;
