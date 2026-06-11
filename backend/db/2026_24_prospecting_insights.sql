-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_24_prospecting_insights.sql
--
-- Phase 3 of the Outbound Insights & WBR system (docs/INSIGHTS_WBR_DESIGN.md).
--
-- Creates `prospecting_insights` — aggregate-level diagnostic findings written
-- nightly by OutboundInsightEngine (the aggregate sibling of
-- ProspectDiagnosticsEngine's per-prospect alerts).
--
-- Every row carries FULL LINEAGE (decision D16): the metric, both comparison
-- windows, the isolated segment, observed/baseline values with sample sizes,
-- a cause code from the fixed taxonomy, and arrays of evidence row IDs
-- (step logs / prospects / delivery events). The dashboard's "double-click"
-- is an `id = ANY(...)` lookup over those arrays — the user inspects exactly
-- the records the engine reasoned over, never a re-derivation.
--
-- Lifecycle (upsert-and-resolve, same pattern as ProspectDiagnosticsEngine):
--   * Upsert key: (org_id, metric, cause_code, segment_hash). Re-detection
--     refreshes values/windows/evidence + last_seen_at, preserves status and
--     first_detected_at.
--   * Insights whose condition no longer holds are auto-resolved
--     (status='resolved', resolved_at=now()) at the end of each run.
--   * status: new → acknowledged (user action, Phase 4 API) → resolved (auto).
--
-- Cause taxonomy (engine writes only these):
--   list_targeting | deliverability_sender | deliverability_domain |
--   message_step | timing_cadence | rep_execution | capacity_volume |
--   list_exhaustion | mixed_confounded
--
-- Engine thresholds are config-gated per org in
-- organizations.settings.insight_engine (defaults in OutboundInsightEngine.js):
--   { "min_current_sends": 30, "min_baseline_sends": 60,
--     "rel_delta_threshold": 0.30, "bounce_rate_abs_floor": 0.02,
--     "max_insights": 5 }
--
-- Safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS public.prospecting_insights (
    id                     bigserial PRIMARY KEY,
    org_id                 integer      NOT NULL,

    -- what moved
    metric                 varchar(50)  NOT NULL,   -- reply_rate | bounce_rate | send_volume | list_runway
    cause_code             varchar(40)  NOT NULL,
    segment                jsonb        NOT NULL DEFAULT '{}'::jsonb,  -- {} = org-wide; {"dim":"sender_account_id","value":44,"label":"..."}
    segment_hash           varchar(32)  NOT NULL,   -- md5 of canonical segment JSON (upsert key part)

    -- comparison lineage
    current_window_start   date         NOT NULL,
    current_window_end     date         NOT NULL,
    baseline_window_start  date         NOT NULL,
    baseline_window_end    date         NOT NULL,
    observed               numeric      NOT NULL,   -- current-window value (rate or count)
    baseline               numeric      NOT NULL,   -- baseline-window value (rate or per-week count)
    observed_n             integer      NOT NULL DEFAULT 0,  -- sample size (sends) behind observed
    baseline_n             integer      NOT NULL DEFAULT 0,
    delta_rel              numeric,                 -- relative change, e.g. -0.42

    -- the human-readable finding
    headline               text         NOT NULL,   -- one-line "what happened + where"
    hypothesis             text,                    -- "why" with the evidence basis
    impact_estimate        text,                    -- quantified cost, e.g. "~4 lost replies/week"
    recommended_action     text,

    -- the double-click (D16)
    evidence               jsonb        NOT NULL DEFAULT '{}'::jsonb,
    -- shape: { step_log_ids: [], prospect_ids: [], delivery_event_ids: [],
    --          breakdown: [{value,label,cur_rate,base_rate,cur_n,base_n}] }

    status                 varchar(20)  NOT NULL DEFAULT 'new',
    first_detected_at      timestamptz  NOT NULL DEFAULT now(),
    last_seen_at           timestamptz  NOT NULL DEFAULT now(),
    acknowledged_at        timestamptz,
    acknowledged_by        integer,
    resolved_at            timestamptz,

    CONSTRAINT chk_pi_status CHECK (status IN ('new','acknowledged','resolved')),
    CONSTRAINT chk_pi_cause CHECK (cause_code IN (
      'list_targeting','deliverability_sender','deliverability_domain',
      'message_step','timing_cadence','rep_execution','capacity_volume',
      'list_exhaustion','mixed_confounded'))
);

COMMENT ON TABLE public.prospecting_insights IS
  'Aggregate diagnostic findings for the outbound motion, written nightly by OutboundInsightEngine from prospecting_metric_daily. Full lineage per row; evidence arrays are the drill-down. Upsert key (org_id, metric, cause_code, segment_hash); auto-resolves when the condition clears. See docs/INSIGHTS_WBR_DESIGN.md Phase 3.';

COMMENT ON COLUMN public.prospecting_insights.evidence IS
  'Drill-down payload: sampled raw-row IDs (step_log_ids, prospect_ids, delivery_event_ids — capped at 50 each) plus the per-segment breakdown table shown at drill level 2. IDs are samples from the current window matching the segment, not exhaustive.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_pi_finding
  ON public.prospecting_insights (org_id, metric, cause_code, segment_hash);

CREATE INDEX IF NOT EXISTS idx_pi_org_status
  ON public.prospecting_insights (org_id, status, last_seen_at DESC);

COMMIT;
