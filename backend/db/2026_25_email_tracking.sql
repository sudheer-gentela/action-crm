-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_25_email_tracking.sql
--
-- Phase 7 of the Outbound Insights & WBR system (docs/INSIGHTS_WBR_DESIGN.md).
-- Open/click tracking with per-customer CNAME tracking domains.
--
-- Policies (decisions D38–D41):
--   * Tracking REQUIRES a verified customer tracking domain (status='active').
--     No shared-domain fallback, ever — if the org has no active domain,
--     emails go out untracked even when campaign toggles are on.
--   * Per-campaign toggles live in prospecting_campaigns.
--     prospecting_config_override -> 'tracking' -> {opens: bool, clicks: bool}
--     and DEFAULT OFF.
--   * The customer-facing contract is ONLY the CNAME target
--     (track.gowarmcrm.com). TLS provider (Cloudflare for SaaS today) is
--     swappable without customer action or data loss; cf_hostname_id is
--     provider metadata only.
--   * Raw engagement events are ALWAYS stored; bot-classified events are
--     FLAGGED (is_bot), not dropped. The snapshot counts only is_bot=false.
--
-- Customer setup (what the org admin does):
--   1. Choose a subdomain, e.g. t.customerco.com
--   2. Add DNS: CNAME t.customerco.com -> track.gowarmcrm.com
--   3. Click Verify in GoWarm (TrackingDomainService checks DNS, registers
--      the hostname with Cloudflare for SaaS, activates when the cert lands)
--
-- Safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS public.tracking_domains (
    id              serial PRIMARY KEY,
    org_id          integer      NOT NULL,
    hostname        varchar(255) NOT NULL,            -- t.customerco.com (lowercase)
    status          varchar(20)  NOT NULL DEFAULT 'pending',
    cf_hostname_id  varchar(64),                      -- Cloudflare custom-hostname id (provider metadata)
    last_checked_at timestamptz,
    error_message   text,
    created_by      integer,
    created_at      timestamptz  NOT NULL DEFAULT now(),
    updated_at      timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT chk_td_status CHECK (status IN ('pending','verifying','active','failed','disabled'))
);

COMMENT ON TABLE public.tracking_domains IS
  'Per-customer CNAME tracking domains (Phase 7). status=active means DNS verified AND TLS cert issued — only then does send-time decoration run. The CNAME target (track.gowarmcrm.com) is the stable customer contract; TLS provider is swappable (D38).';

CREATE UNIQUE INDEX IF NOT EXISTS uq_td_hostname ON public.tracking_domains (hostname);
CREATE INDEX IF NOT EXISTS idx_td_org ON public.tracking_domains (org_id, status);

CREATE TABLE IF NOT EXISTS public.email_engagement_events (
    id            bigserial PRIMARY KEY,
    org_id        integer      NOT NULL,
    step_log_id   bigint       NOT NULL,              -- sequence_step_logs.id
    prospect_id   integer,
    event_type    varchar(10)  NOT NULL,              -- open | click
    url           text,                               -- destination (clicks only)
    link_index    integer,                            -- position of the link in the email
    user_agent    text,
    ip            varchar(64),
    is_bot        boolean      NOT NULL DEFAULT false,
    bot_reason    varchar(40),                        -- scanner_ua | too_soon | datacenter
    occurred_at   timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT chk_eee_type CHECK (event_type IN ('open','click'))
);

COMMENT ON TABLE public.email_engagement_events IS
  'Raw open/click events from the public tracking endpoints. Bot-classified events are flagged, never dropped (D41). Snapshot measures count is_bot=false only. Opens are DIRECTIONAL (Apple MPP auto-fires pixels, Gmail proxies images) — labeled as such in the WBR grid.';

CREATE INDEX IF NOT EXISTS idx_eee_org_time ON public.email_engagement_events (org_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_eee_step_log ON public.email_engagement_events (step_log_id);

ALTER TABLE public.prospecting_metric_daily
  ADD COLUMN IF NOT EXISTS opens  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS clicks integer NOT NULL DEFAULT 0;

-- D39 AMENDED: toggles live in DEDICATED COLUMNS, not in
-- prospecting_config_override — PUT /:id/config REPLACES that whole jsonb
-- through a whitelist sanitizer (and DELETE nulls it), so a 'tracking' key
-- there would be silently wiped on every outreach-config save.
ALTER TABLE public.prospecting_campaigns
  ADD COLUMN IF NOT EXISTS tracking_opens  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tracking_clicks boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.prospecting_campaigns.tracking_clicks IS
  'Per-campaign click-tracking toggle (Phase 7, default OFF). Written ONLY via PUT /api/tracking-domains/campaign/:id/toggles — isolated from the config-override replace semantics.';

COMMENT ON COLUMN public.prospecting_metric_daily.opens IS
  'Human-classified (is_bot=false) opens by occurred date. UNIQUE per (step_log, day) — repeat opens of the same send on the same day count once. Directional metric (Apple MPP inflation).';

COMMIT;
