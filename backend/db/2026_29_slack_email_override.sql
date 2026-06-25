-- 2026_29_slack_email_override.sql
--
-- Per-user Slack email override. When a rep's GoWarmCRM login email differs from
-- their Slack account email, the email→Slack-ID lookup fails. This lets them set
-- the address Slack should be matched on, without changing their login email.
--
-- The resolver prefers slack_email when set, else falls back to users.email.

ALTER TABLE users ADD COLUMN IF NOT EXISTS slack_email text;
