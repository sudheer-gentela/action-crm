-- 2026_28_slack_installs.sql
--
-- Slack notification delivery — per-org workspace install + per-user Slack ID cache.
--
-- Mirrors org_twilio_accounts: one row per org, bot token encrypted at rest with
-- the same AES-256-GCM helper (services/credentials/encryption.js, AI_CREDS_KEY)
-- used for Twilio auth tokens. The token is stored as the {ciphertext, iv, tag}
-- byte triple that encrypt() returns.
--
-- default_channel_id is the team-channel seam: nullable now, used later for
-- org-level "post escalations to #sales-alerts" routing with no further migration.

CREATE TABLE IF NOT EXISTS org_slack_installs (
  org_id                  integer      NOT NULL PRIMARY KEY
                                        REFERENCES organizations(id) ON DELETE CASCADE,
  slack_team_id           text         NOT NULL,
  slack_team_name         text,
  bot_user_id             text,                       -- the app's bot user in this workspace
  bot_token_ciphertext    bytea        NOT NULL,
  bot_token_iv            bytea        NOT NULL,
  bot_token_tag           bytea        NOT NULL,
  bot_token_last4         text,
  authed_user_id          integer,                    -- GoWarmCRM user who installed it
  scopes                  text,                       -- granted scope list (audit)
  default_channel_id      text,                       -- team-channel seam (nullable, v2)
  status                  text         NOT NULL DEFAULT 'active',
  installed_at            timestamptz  NOT NULL DEFAULT now(),
  updated_at              timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT org_slack_installs_status_chk
    CHECK (status = ANY (ARRAY['active'::text, 'revoked'::text]))
);

-- Per-user cached email -> Slack user ID resolution. slack_lookup_at records the
-- last lookup ATTEMPT so we don't re-hit users.lookupByEmail every notification
-- for a rep whose email has no Slack match (retry only after 24h).
ALTER TABLE users ADD COLUMN IF NOT EXISTS slack_user_id   text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS slack_lookup_at timestamptz;
