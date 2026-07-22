-- ============================================================================
-- 2026_61_baseline_foundation.sql
--
-- Baseline + Assessment foundation (Phase 1, week 1):
--
--   baseline_snapshots    — the frozen pre-deployment metric snapshot.
--                           Written once per (connection, capture). Once
--                           status = 'frozen', the DATABASE rejects updates
--                           and deletes via trigger — immutability is a
--                           schema property, not an app-layer promise.
--
--   crm_schema_snapshots  — frozen discovery output: objects, fields (with
--                           fill rates + history-tracking flags), stage
--                           definitions, pipelines / record types, validation
--                           rules, automation inventory. Config-debt findings
--                           are assessment content, so "what the org looked
--                           like at capture" freezes alongside the metrics.
--
--   deal_stage_history    — forward-looking transition ledger. From this
--                           migration onward every stage change (sync-detected
--                           or in-app) writes a row, so post-baseline deltas
--                           compute natively without re-querying the CRM.
--                           source='crm_history_import' rows are the one-shot
--                           backfill from OpportunityHistory / HubSpot
--                           dealstage propertiesWithHistory.
--
-- Scope columns (org_id, client_id NULL, connection_id) are present from day
-- one per the 2026-07-22 decision: Phase 3 per-client assessments become a
-- query-parameter change, and a client→org graduation is a re-key, not a
-- re-architecture.
-- ============================================================================

BEGIN;

-- ── baseline_snapshots ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.baseline_snapshots (
    id                   SERIAL PRIMARY KEY,
    org_id               INTEGER NOT NULL REFERENCES public.organizations(id),
    client_id            INTEGER REFERENCES public.clients(id),
    connection_id        INTEGER NOT NULL REFERENCES public.crm_connections(id),
    crm_type             VARCHAR(50) NOT NULL,

    captured_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    history_from         DATE,
    history_to           DATE,

    metric_defs_version  VARCHAR(20) NOT NULL,
    baseline_config      JSONB NOT NULL DEFAULT '{}'::jsonb,  -- config AS RESOLVED at
                                                              -- capture (audit trail;
                                                              -- the connection's config
                                                              -- may change later)

    status               VARCHAR(50) NOT NULL DEFAULT 'pending',

    metrics              JSONB,   -- the frozen headline numbers
    segments             JSONB,   -- by-segment / by-rep / by-pipeline breakdowns
    evidence             JSONB,   -- CRM record IDs behind each headline
                                  -- (QBR drill-through; kept at capture, costs nothing)
    warnings             JSONB,   -- unmapped historical stages, low-fill segment
                                  -- axes, hygiene caveats — honesty layer

    computed_by          INTEGER,
    error_detail         TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT baseline_snapshots_status_check
        CHECK (status IN ('pending', 'computing', 'frozen', 'failed')),
    CONSTRAINT baseline_snapshots_crm_type_check
        CHECK (crm_type IN ('salesforce', 'hubspot')),
    -- A frozen row must actually contain its payload.
    CONSTRAINT baseline_snapshots_frozen_payload_check
        CHECK (status <> 'frozen' OR (metrics IS NOT NULL AND history_from IS NOT NULL))
);

COMMENT ON TABLE public.baseline_snapshots IS
  'Immutable pre-deployment metric snapshots (checklist Tier 1 #1). Rows with '
  'status=frozen reject UPDATE and DELETE at the trigger level. Written by '
  'BaselineCaptureService only. Introduced 2026_61.';

CREATE INDEX IF NOT EXISTS idx_baseline_snapshots_org
    ON public.baseline_snapshots (org_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_baseline_snapshots_connection
    ON public.baseline_snapshots (connection_id, captured_at DESC);

ALTER TABLE public.baseline_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY baseline_snapshots_org_isolation ON public.baseline_snapshots
    USING (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::integer);

-- ── crm_schema_snapshots ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crm_schema_snapshots (
    id             SERIAL PRIMARY KEY,
    org_id         INTEGER NOT NULL REFERENCES public.organizations(id),
    client_id      INTEGER REFERENCES public.clients(id),
    connection_id  INTEGER NOT NULL REFERENCES public.crm_connections(id),
    crm_type       VARCHAR(50) NOT NULL,

    captured_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status         VARCHAR(50) NOT NULL DEFAULT 'pending',

    -- Normalized discovery payload. Shape (see services/crm/schemaDiscovery.js):
    -- {
    --   objects: [ { name, label, custom, recordCount? } ],
    --   fields:  { "<object>": [ { name, label, type, custom, required,
    --                              picklistValues?, fillRate?, fillRateSampled?,
    --                              historyTracked? } ] },
    --   stage_defs: [ { label, isActive, isClosed, isWon,
    --                   defaultProbability, sortOrder } ],
    --   pipelines:  [ { id, label, stages: [...] } ],       -- HubSpot / SF record types
    --   validation_rules: [ { object, name, active, errorMessage } ],
    --   automation: { flows: n, workflowRules: n, processBuilders: n },
    --   limits_notes: [ ... ]                               -- anything discovery
    -- }                                                     -- could not observe
    schema         JSONB,
    warnings       JSONB,

    error_detail   TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT crm_schema_snapshots_status_check
        CHECK (status IN ('pending', 'computing', 'frozen', 'failed')),
    CONSTRAINT crm_schema_snapshots_crm_type_check
        CHECK (crm_type IN ('salesforce', 'hubspot')),
    CONSTRAINT crm_schema_snapshots_frozen_payload_check
        CHECK (status <> 'frozen' OR schema IS NOT NULL)
);

COMMENT ON TABLE public.crm_schema_snapshots IS
  'Frozen CRM schema discovery: custom fields with fill rates, stage '
  'definitions from the CRM''s own metadata (OpportunityStage / HubSpot '
  'pipelines), validation rules, automation inventory. Grounds stage-mapping '
  'approval and the config-debt findings. Same freeze contract as '
  'baseline_snapshots. Introduced 2026_61.';

CREATE INDEX IF NOT EXISTS idx_crm_schema_snapshots_connection
    ON public.crm_schema_snapshots (connection_id, captured_at DESC);

ALTER TABLE public.crm_schema_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_schema_snapshots_org_isolation ON public.crm_schema_snapshots
    USING (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::integer);

-- ── Shared freeze trigger ────────────────────────────────────────────────────
-- Frozen rows are immutable: no UPDATE, no DELETE. Rows freeze exactly once
-- (any status → frozen is the last write). Failed/pending rows stay mutable
-- so retries work.

CREATE OR REPLACE FUNCTION public.reject_frozen_mutation() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status = 'frozen' THEN
            RAISE EXCEPTION 'Row % in % is frozen and cannot be deleted', OLD.id, TG_TABLE_NAME
                USING ERRCODE = 'raise_exception';
        END IF;
        RETURN OLD;
    END IF;

    -- UPDATE
    IF OLD.status = 'frozen' THEN
        RAISE EXCEPTION 'Row % in % is frozen and cannot be modified', OLD.id, TG_TABLE_NAME
            USING ERRCODE = 'raise_exception';
    END IF;
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_baseline_snapshots_freeze ON public.baseline_snapshots;
CREATE TRIGGER trg_baseline_snapshots_freeze
    BEFORE UPDATE OR DELETE ON public.baseline_snapshots
    FOR EACH ROW EXECUTE FUNCTION public.reject_frozen_mutation();

DROP TRIGGER IF EXISTS trg_crm_schema_snapshots_freeze ON public.crm_schema_snapshots;
CREATE TRIGGER trg_crm_schema_snapshots_freeze
    BEFORE UPDATE OR DELETE ON public.crm_schema_snapshots
    FOR EACH ROW EXECUTE FUNCTION public.reject_frozen_mutation();

-- ── deal_stage_history ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.deal_stage_history (
    id           BIGSERIAL PRIMARY KEY,
    org_id       INTEGER NOT NULL REFERENCES public.organizations(id),
    deal_id      INTEGER REFERENCES public.deals(id) ON DELETE CASCADE,
    -- crm_deal_id lets crm_history_import rows exist for deals never hydrated
    -- into the working tables (assessment mode computes without hydration).
    crm_deal_id  VARCHAR(100),
    from_stage   VARCHAR(255),
    to_stage     VARCHAR(255) NOT NULL,
    changed_at   TIMESTAMPTZ NOT NULL,
    source       VARCHAR(50) NOT NULL DEFAULT 'sync',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT deal_stage_history_source_check
        CHECK (source IN ('sync', 'manual', 'crm_history_import')),
    CONSTRAINT deal_stage_history_deal_ref_check
        CHECK (deal_id IS NOT NULL OR crm_deal_id IS NOT NULL)
);

COMMENT ON TABLE public.deal_stage_history IS
  'Deal stage transition ledger. sync/manual rows are written at the deal '
  'upsert choke point from 2026_61 onward; crm_history_import rows are the '
  'one-shot baseline backfill (OpportunityHistory / HubSpot dealstage '
  'history). Post-baseline deltas read this table, never the CRM. '
  'Introduced 2026_61.';

CREATE INDEX IF NOT EXISTS idx_deal_stage_history_deal
    ON public.deal_stage_history (org_id, deal_id, changed_at);
CREATE INDEX IF NOT EXISTS idx_deal_stage_history_crm_deal
    ON public.deal_stage_history (org_id, crm_deal_id, changed_at)
    WHERE crm_deal_id IS NOT NULL;

ALTER TABLE public.deal_stage_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY deal_stage_history_org_isolation ON public.deal_stage_history
    USING (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::integer);

COMMIT;
