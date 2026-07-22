-- ============================================================================
-- 2026_60_crm_connections.sql
--
-- Promotes CRM connections from org_integrations (UNIQUE org_id +
-- integration_type — exactly one connection per CRM per org) to a
-- first-class crm_connections table with a generic tenancy scope:
--
--   client_id IS NULL      → the org's own connection (today's behaviour)
--   client_id IS NOT NULL  → a client-scoped connection (Phase 3)
--
-- CREDENTIAL STRATEGY (the important design decision):
--
--   Org-level rows migrated from org_integrations DO NOT copy credentials.
--   They carry integration_id → org_integrations(id) and resolve tokens
--   through it. Reason: salesforce.auth.js getValidToken() refreshes tokens
--   IN PLACE in org_integrations. Copying credentials here would fork the
--   refresh state and break within one token lifetime. Pointer mode keeps
--   the existing refresh machinery the single writer.
--
--   Client-scoped rows (Phase 3) will store their own encrypted credentials
--   in this table (integration_id NULL, credentials NOT NULL) — encrypted at
--   the app layer via services/credentials/encryption.js, same contract as
--   org_integrations.credentials ("never log this column").
--
-- Resolution rule for callers (BaselineCaptureService and later the
-- orchestrator):
--   integration_id IS NOT NULL → auth via sfAuth/hsAuth against org_id
--                                 (existing code paths, untouched)
--   integration_id IS NULL     → auth via this row's own credentials
--
-- settings shape (jsonb):
--   {
--     stage_map:      { "<crm stage label>": "<gowarm stage key>", ... },
--     field_map:      [ ... ],                  -- same shape org_integrations uses
--     sync_objects:   ["Contact","Account","Opportunity","Lead"],
--     baseline_config: {                        -- decisions 2026-07-22
--       history_months: 18,                     -- decision 2 (default 18)
--       cycle_calc: "sum_dwell",                -- decision 1: sum_dwell | first_entry
--       segment_axes: [                         -- decision 3: extensible field refs
--         { "object": "Opportunity", "field": "Amount",   "banding": "auto" },
--         { "object": "Opportunity", "field": "Industry" }
--       ],
--       min_cell_n: 5,
--       report: { "branding": "gowarm" }        -- decision 5: gowarm | white_label
--     }
--   }
--
-- org_integrations remains authoritative for the EXISTING sync engine until
-- Phase 3a flips the orchestrator to runSyncForConnection(). New code
-- (baseline / assessment / discovery) reads crm_connections only.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.crm_connections (
    id              SERIAL PRIMARY KEY,
    org_id          INTEGER NOT NULL REFERENCES public.organizations(id),
    client_id       INTEGER REFERENCES public.clients(id),
    crm_type        VARCHAR(50) NOT NULL,
    purpose         VARCHAR(50) NOT NULL DEFAULT 'standard',

    -- Pointer mode (org-level legacy rows): resolve credentials through
    -- org_integrations so the existing token-refresh path stays the only writer.
    integration_id  INTEGER REFERENCES public.org_integrations(id) ON DELETE SET NULL,

    -- Self-contained mode (client-scoped rows, Phase 3): app-layer-encrypted
    -- tokens. NULL for pointer-mode rows.
    credentials     JSONB,
    instance_url    VARCHAR(500),

    settings        JSONB NOT NULL DEFAULT '{}'::jsonb,
    status          VARCHAR(50) NOT NULL DEFAULT 'pending',

    -- Write-back is a PER-CONNECTION grant, default off. The assessment-org
    -- middleware 403 (org type check) takes precedence over this flag.
    write_back_enabled  BOOLEAN NOT NULL DEFAULT FALSE,

    sync_status     VARCHAR(50) NOT NULL DEFAULT 'idle',
    last_sync_at    TIMESTAMPTZ,
    last_sync_error TEXT,

    connected_by    INTEGER,
    connected_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT crm_connections_crm_type_check
        CHECK (crm_type IN ('salesforce', 'hubspot')),
    CONSTRAINT crm_connections_purpose_check
        CHECK (purpose IN ('standard', 'assessment')),
    -- A row must be resolvable exactly one way.
    CONSTRAINT crm_connections_credential_mode_check
        CHECK (integration_id IS NOT NULL OR credentials IS NOT NULL
               OR status = 'pending')
);

COMMENT ON TABLE public.crm_connections IS
  'First-class CRM connections. client_id NULL = org-level (migrated from '
  'org_integrations, credentials resolved via integration_id pointer). '
  'client_id set = client-scoped connection with its own credentials (Phase 3). '
  'Introduced 2026_60 for the Baseline+Assessment build.';

COMMENT ON COLUMN public.crm_connections.credentials IS
  'App-layer-encrypted tokens for self-contained (client-scoped) connections. '
  'NULL when integration_id is set. Never log this column.';

-- One org-level connection per CRM per org (mirrors the org_integrations
-- uniqueness it replaces)...
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_connections_org_level
    ON public.crm_connections (org_id, crm_type)
    WHERE client_id IS NULL;

-- ...and one per (org, client, CRM) for client-scoped rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_connections_client_level
    ON public.crm_connections (org_id, client_id, crm_type)
    WHERE client_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_crm_connections_org
    ON public.crm_connections (org_id);
CREATE INDEX IF NOT EXISTS idx_crm_connections_client
    ON public.crm_connections (client_id)
    WHERE client_id IS NOT NULL;

-- RLS: same org-isolation contract as every other tenant table.
ALTER TABLE public.crm_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_connections_org_isolation ON public.crm_connections
    USING (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::integer);

-- ── Data migration: pointer rows for existing SF / HubSpot integrations ──────
-- Copies scope + settings, NOT credentials (see header). Idempotent.

INSERT INTO public.crm_connections
    (org_id, client_id, crm_type, purpose, integration_id,
     instance_url, settings, status, write_back_enabled,
     sync_status, last_sync_at, last_sync_error,
     connected_by, connected_at, created_at, updated_at)
SELECT
    oi.org_id,
    NULL,
    oi.integration_type,
    'standard',
    oi.id,
    oi.instance_url,
    oi.settings,
    oi.status,
    COALESCE((oi.settings ->> 'write_back_enabled')::boolean, FALSE),
    oi.sync_status,
    oi.last_sync_at,
    oi.last_sync_error,
    oi.connected_by,
    oi.connected_at,
    oi.created_at,
    NOW()
FROM public.org_integrations oi
WHERE oi.integration_type IN ('salesforce', 'hubspot')
  AND NOT EXISTS (
      SELECT 1 FROM public.crm_connections cc
      WHERE cc.org_id = oi.org_id
        AND cc.crm_type = oi.integration_type
        AND cc.client_id IS NULL
  );

-- ── Assessment org type ──────────────────────────────────────────────────────
-- organizations.type: 'standard' | 'assessment'. Assessment orgs get the
-- middleware-level write-back 403 and skip playbook seeding.
-- converted_to_standard_at records the assessment → paying-customer upgrade.

ALTER TABLE public.organizations
    ADD COLUMN IF NOT EXISTS type VARCHAR(50) NOT NULL DEFAULT 'standard';
ALTER TABLE public.organizations
    ADD COLUMN IF NOT EXISTS converted_to_standard_at TIMESTAMPTZ;

-- Guard against typos, tolerant of re-run.
DO $$
BEGIN
    ALTER TABLE public.organizations
        ADD CONSTRAINT organizations_type_check
        CHECK (type IN ('standard', 'assessment'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
