-- ============================================================================
-- 2026_62_baseline_reports.sql
--
-- Findings reports generated from frozen baseline_snapshots (Phase 1,
-- weeks 3–4). A report row is DERIVED and REGENERABLE — the underlying
-- snapshot is the immutable artifact, so reports carry no freeze trigger.
-- Regenerating (e.g. after a narrative re-run or branding change) INSERTs a
-- new row; history is kept, and "the report" for a snapshot is the newest.
--
-- Two-layer content model (design decision, mirrors the plan):
--   findings  jsonb — DETERMINISTIC. Computed by findingsEngine from the
--                     frozen metrics + schema snapshot. Every dollar figure
--                     traces to snapshot evidence. Reproducible from the
--                     snapshot alone.
--   narrative jsonb — AI-composed executive layer over the computed findings
--                     (AIClientResolver, callType 'baseline_report'). The
--                     model NEVER produces a number — it narrates numbers the
--                     engine computed. NULL when AI is unavailable/denied
--                     (entitlements): the report ships findings-only, noted.
--
-- share_token: unauthenticated read of the rendered HTML (the customer /
-- their CFO opens a link). Same trust model as clients.report_token and the
-- portal magic-link — the token IS the credential. 64 hex chars from
-- crypto.randomBytes(32); revocable by nulling the column.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.baseline_reports (
    id             SERIAL PRIMARY KEY,
    org_id         INTEGER NOT NULL REFERENCES public.organizations(id),
    client_id      INTEGER REFERENCES public.clients(id),
    snapshot_id    INTEGER NOT NULL REFERENCES public.baseline_snapshots(id),
    connection_id  INTEGER NOT NULL REFERENCES public.crm_connections(id),

    branding       VARCHAR(50) NOT NULL DEFAULT 'gowarm',
    label_name     VARCHAR(255),           -- white_label display name
    label_logo_url TEXT,                    -- white_label logo

    findings       JSONB NOT NULL,          -- deterministic findings list
    narrative      JSONB,                   -- AI exec layer; NULL = findings-only
    narrative_model  VARCHAR(100),          -- model that wrote the narrative
    narrative_status VARCHAR(50) NOT NULL DEFAULT 'none',
                                            -- none | ok | unavailable | failed
    html           TEXT NOT NULL,           -- self-contained rendered report

    share_token    VARCHAR(64) UNIQUE,      -- NULL = not shared / revoked
    generated_by   INTEGER,
    generated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT baseline_reports_branding_check
        CHECK (branding IN ('gowarm', 'white_label')),
    CONSTRAINT baseline_reports_narrative_status_check
        CHECK (narrative_status IN ('none', 'ok', 'unavailable', 'failed'))
);

COMMENT ON TABLE public.baseline_reports IS
  'Findings reports rendered from frozen baseline_snapshots. Derived + '
  'regenerable (no freeze trigger — the snapshot is the immutable artifact). '
  'findings = deterministic engine output; narrative = AI layer that never '
  'produces numbers. share_token grants unauthenticated HTML read. '
  'Introduced 2026_62.';

CREATE INDEX IF NOT EXISTS idx_baseline_reports_snapshot
    ON public.baseline_reports (snapshot_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_baseline_reports_org
    ON public.baseline_reports (org_id, generated_at DESC);

ALTER TABLE public.baseline_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY baseline_reports_org_isolation ON public.baseline_reports
    USING (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::integer);

COMMIT;
