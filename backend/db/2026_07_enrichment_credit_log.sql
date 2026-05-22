-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: enrichment_credit_log
-- Sprint 3 (Group E)
-- ─────────────────────────────────────────────────────────────────────────────
-- Per-call ledger of every enrichment call across providers. Used to:
--   - Show monthly usage to OrgAdmin
--   - Enforce per-org monthly credit caps
--   - Give SuperAdmin a cross-org spend view
--   - Trace which prospect/account a call was for (when known)
--
-- One row per provider call, success or failure. Failures still cost credits
-- on some endpoints (e.g. CoreSignal search returns 0 hits — still billable
-- on certain plans).
--
-- We intentionally do NOT log the API response payload here — too large, and
-- the provider modules already log to ai_processing_log if needed. This table
-- is purely an accounting ledger.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS enrichment_credit_log (
  id              SERIAL PRIMARY KEY,
  org_id          INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Provider name (e.g. 'coresignal', 'apollo') — free TEXT because providers
  -- are validated in app code (services/enrichment/index.js), not at DB level.
  provider        VARCHAR(40)  NOT NULL,

  -- 'enrichment' is the only value today. Future: 'verification', 'export'.
  purpose         VARCHAR(20)  NOT NULL DEFAULT 'enrichment',

  -- What the call did. Free TEXT keyed by provider; common values:
  --   coresignal: 'search', 'collect', 'enrich_domain'
  --   apollo:     'organization_enrich', 'person_match', 'person_search'
  operation       VARCHAR(60)  NOT NULL,

  -- Credit cost reported by the provider. Some providers (CoreSignal) charge
  -- different amounts per operation; the provider module computes this from
  -- the response and writes it here.
  credits_used    INTEGER      NOT NULL DEFAULT 1,

  -- What the call was for — nullable because some calls happen outside the
  -- prospect/account context (e.g. validating an API key by calling /me).
  prospect_id     INTEGER      REFERENCES prospects(id) ON DELETE SET NULL,
  account_id      INTEGER      REFERENCES accounts(id)  ON DELETE SET NULL,

  -- Outcome — 'ok' | 'not_found' | 'ambiguous' | 'rate_limited' | 'error'.
  -- Useful for the SuperAdmin dashboard to see error rates per provider.
  status          VARCHAR(20)  NOT NULL DEFAULT 'ok',

  -- Optional metadata: error message, ambiguous candidate count, etc.
  metadata        JSONB,

  occurred_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Indexes for the queries we'll run:
--   - Monthly usage per org: (org_id, occurred_at)
--   - Monthly usage per (org, provider): (org_id, provider, occurred_at)
--   - SuperAdmin cross-org breakdown: (occurred_at, provider) for time-bound scans

CREATE INDEX IF NOT EXISTS idx_enrichment_credit_log_org_time
  ON enrichment_credit_log (org_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_enrichment_credit_log_org_provider_time
  ON enrichment_credit_log (org_id, provider, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_enrichment_credit_log_provider_time
  ON enrichment_credit_log (provider, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_enrichment_credit_log_prospect
  ON enrichment_credit_log (prospect_id) WHERE prospect_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_enrichment_credit_log_account
  ON enrichment_credit_log (account_id) WHERE account_id IS NOT NULL;

COMMIT;
