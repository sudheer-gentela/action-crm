-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_26_org_twilio_accounts.sql
--
-- Per-org Twilio SUBACCOUNT credentials (Model A — GoWarmCRM as reseller).
--
-- Moves Twilio from a single deployment-wide account (TWILIO_ACCOUNT_SID /
-- TWILIO_AUTH_TOKEN env vars) to one Twilio SUBACCOUNT per organization. The
-- env vars now hold the PARENT account credentials, used only for subaccount
-- lifecycle (create / suspend / close). All per-org telephony (DIDs, calls,
-- webhooks, browser-dial tokens) runs against the org's own subaccount.
--
-- Billing model: subaccount usage rolls up to the parent balance (one card),
-- but cost is reported per subaccount via the Twilio Usage Records API — that
-- is what the per-org cost screen reads.
--
-- Crypto: subaccount auth token and API-key secret are encrypted at rest with
-- AES-256-GCM via services/credentials/encryption.js (AI_CREDS_KEY), stored as
-- the same {ciphertext, iv, tag} bytea triplet + last4 pattern used by
-- org_credentials. Plaintext secrets never persist outside the encrypt() call
-- stack and are never returned by a route.
--
-- Columns api_key_* and twiml_app_sid support browser-based dialing
-- (Voice JS SDK v2): the access-token endpoint signs with the subaccount's API
-- key and grants the subaccount's TwiML App. They are nullable so a subaccount
-- can exist before the softphone resources are provisioned.
--
-- Safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS org_twilio_accounts (
  org_id                     INTEGER     PRIMARY KEY
                                         REFERENCES organizations(id) ON DELETE CASCADE,

  -- Subaccount identity + auth (auth token encrypted at rest)
  subaccount_sid             TEXT        NOT NULL,           -- ACxxxxxxxx (the subaccount)
  auth_token_ciphertext      BYTEA       NOT NULL,
  auth_token_iv              BYTEA       NOT NULL,
  auth_token_tag             BYTEA       NOT NULL,
  auth_token_last4           TEXT,

  -- Browser-dial (Voice JS SDK v2) resources — provisioned under the subaccount.
  -- API key secret is shown by Twilio exactly once at creation, so encrypt + store.
  api_key_sid                TEXT,                           -- SKxxxxxxxx
  api_key_secret_ciphertext  BYTEA,
  api_key_secret_iv          BYTEA,
  api_key_secret_tag         BYTEA,
  api_key_secret_last4       TEXT,
  twiml_app_sid              TEXT,                           -- APxxxxxxxx

  status                     TEXT        NOT NULL DEFAULT 'active',
  friendly_name              TEXT,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT org_twilio_accounts_status_chk
    CHECK (status IN ('active', 'suspended', 'closed'))
);

-- A Twilio subaccount SID maps to exactly one org.
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_twilio_accounts_subaccount_sid
  ON org_twilio_accounts (subaccount_sid);

COMMIT;
