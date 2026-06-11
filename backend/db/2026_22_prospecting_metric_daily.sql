-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_22_prospecting_metric_daily.sql
--
-- Phase 1 of the Outbound Insights & WBR system (see docs/INSIGHTS_WBR_DESIGN.md).
--
-- Creates `prospecting_metric_daily` — the daily-grain snapshot table that
-- feeds the WBR grid (Phase 4/5) and the OutboundInsightEngine (Phase 3).
--
-- Design rules (decisions D1, D7, D8, D19 in the design doc):
--   * RAW COUNTS ONLY. No rates are ever stored. Every rate is recomputed at
--     read time from summed numerators/denominators for whatever period is
--     requested (ratios must never be averaged across weeks).
--   * One row per (org, org-local date, segment grain). Dimensions that do
--     not apply to a given fact use SENTINEL values (0 / 'none' / 'unknown')
--     instead of NULL — Postgres unique indexes treat NULLs as distinct,
--     which would break the upsert grain. campaign_id = 0 means
--     "unattributed" (prospects.campaign_id IS NULL — see 2026_21 backfill).
--   * metric_date is the ORG-LOCAL calendar date (org timezone from
--     organizations.settings -> 'calendar' ->> 'timezone', default 'UTC'),
--     not the UTC date. Rows are written by MetricSnapshotService, which
--     does the timezone conversion at write time.
--   * Writer contract: DELETE + INSERT per (org_id, metric_date range)
--     inside one transaction. The nightly job recomputes the trailing
--     7 org-local days to absorb late-arriving events (replies, LinkedIn
--     connection syncs). Safe to recompute any range at any time.
--
-- Calendar config (decisions D2, D3) — no schema change needed; lives in
-- organizations.settings jsonb under the 'calendar' key:
--
--   { "calendar": { "timezone": "Asia/Kolkata",
--                   "week_start_day": 1,            -- 1 = Monday (ISO)
--                   "fiscal_year_start_month": 1 } } -- 1 = January
--
-- Defaults when absent: UTC / Monday / January. To set your org (example):
--
--   UPDATE organizations
--      SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{calendar}',
--            COALESCE(settings->'calendar', '{}'::jsonb)
--            || '{"timezone":"Asia/Kolkata","week_start_day":1,"fiscal_year_start_month":1}'::jsonb,
--            true),
--          updated_at = now()
--    WHERE id = <your org id>;
--
-- Safe to run more than once (IF NOT EXISTS everywhere).
-- Dry-run: execute inside the transaction and ROLLBACK instead of COMMIT.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS public.prospecting_metric_daily (
    id                   bigserial PRIMARY KEY,
    org_id               integer      NOT NULL,
    metric_date          date         NOT NULL,

    -- ── segment grain (sentinels, never NULL — see header) ──────────────────
    campaign_id          integer      NOT NULL DEFAULT 0,   -- 0 = unattributed
    sequence_id          integer      NOT NULL DEFAULT 0,   -- 0 = n/a
    sequence_step_id     integer      NOT NULL DEFAULT 0,   -- 0 = n/a
    channel              varchar(50)  NOT NULL DEFAULT 'none',
    sender_account_id    integer      NOT NULL DEFAULT 0,   -- 0 = n/a (LinkedIn/calls) or unknown
    owner_id             integer      NOT NULL DEFAULT 0,   -- prospects.owner_id; 0 = unknown
    fit_band             varchar(20)  NOT NULL DEFAULT 'unknown',  -- high|medium|low|unknown (icp_score bands)

    -- ── measures: raw counts (flows) ─────────────────────────────────────────
    enrolled             integer      NOT NULL DEFAULT 0,   -- sequence_enrollments by enrolled_at
    sent                 integer      NOT NULL DEFAULT 0,   -- step logs status IN (sent, completed, replied) by fired_at
    failed               integer      NOT NULL DEFAULT 0,   -- step logs status = failed
    replied_steps        integer      NOT NULL DEFAULT 0,   -- step logs status = replied (subset of sent)
    replies              integer      NOT NULL DEFAULT 0,   -- activities response_received / email_received, by received date
    ooo_replies          integer      NOT NULL DEFAULT 0,   -- rule-based OOO subset of replies (D4)
    connections_sent     integer      NOT NULL DEFAULT 0,   -- LinkedIn connection requests
    connections_accepted integer      NOT NULL DEFAULT 0,   -- LinkedIn acceptances (extension sync)
    calls_logged         integer      NOT NULL DEFAULT 0,
    meetings_booked      integer      NOT NULL DEFAULT 0,   -- meetings.prospect_id IS NOT NULL, by created_at
    qualified            integer      NOT NULL DEFAULT 0,   -- stage transition INTO 'qualified' (approximation — D21)
    converted            integer      NOT NULL DEFAULT 0,   -- stage transition INTO 'converted' (approximation — D21)
    prospects_added      integer      NOT NULL DEFAULT 0,   -- prospects by created_at

    -- ── measures: point-in-time gauge (written only for the current org-local
    --    day; historically unknowable, never backfilled — D22) ───────────────
    tasks_overdue        integer      NOT NULL DEFAULT 0,

    computed_at          timestamptz  NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.prospecting_metric_daily IS
  'Daily-grain raw-count snapshot of the outbound motion. Written nightly by MetricSnapshotService (trailing 7 org-local days, DELETE+INSERT). Feeds WBR frames and OutboundInsightEngine. Rates are NEVER stored here — always recomputed from summed counts. See docs/INSIGHTS_WBR_DESIGN.md.';

COMMENT ON COLUMN public.prospecting_metric_daily.metric_date IS
  'Org-local calendar date (org timezone from organizations.settings->calendar->>timezone), not UTC.';

COMMENT ON COLUMN public.prospecting_metric_daily.campaign_id IS
  '0 = unattributed (prospects.campaign_id IS NULL). Never NULL — sentinel keeps the unique grain sound.';

COMMENT ON COLUMN public.prospecting_metric_daily.replies IS
  'Replies counted on the date RECEIVED (period-based reply attribution, D18). Reply rate for a period = SUM(replies)/SUM(sent) over that period — not a per-send cohort rate.';

COMMENT ON COLUMN public.prospecting_metric_daily.replied_steps IS
  'Step logs whose status reached ''replied''. Subset of sent. team-overview parity: its "sent" = this table''s (sent - replied_steps); its "replied" = replied_steps.';

COMMENT ON COLUMN public.prospecting_metric_daily.tasks_overdue IS
  'Point-in-time gauge: open prospecting_actions past due as of the nightly run. Only written for the current org-local date; zero for historical dates.';

-- Upsert grain — the writer DELETEs by (org_id, metric_date) range first, but
-- the unique index is the safety net against double-writes from overlapping runs.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pmd_grain
  ON public.prospecting_metric_daily
  (org_id, metric_date, campaign_id, sequence_id, sequence_step_id,
   channel, sender_account_id, owner_id, fit_band);

-- Primary read path: WBR frames and insight baselines scan (org, date range).
CREATE INDEX IF NOT EXISTS idx_pmd_org_date
  ON public.prospecting_metric_daily (org_id, metric_date);

COMMIT;
