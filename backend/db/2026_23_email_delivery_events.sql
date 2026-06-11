-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_23_email_delivery_events.sql
--
-- Phase 2 of the Outbound Insights & WBR system (docs/INSIGHTS_WBR_DESIGN.md).
--
-- Adds per-message deliverability instrumentation:
--   1. email_delivery_events  — message-grain bounce/block events, parsed from
--      NDR (mailer-daemon) messages intercepted at the inbox-sync Gate 1
--      filter by BounceDetectionService. Sends go out via real Gmail/Outlook
--      mailboxes (no ESP webhooks exist) — NDR parsing is the only
--      per-message delivery signal on this stack (decision D13).
--   2. domain_health_daily    — domain-grain health metrics. Created now,
--      populated in Phase 6 by the Google Postmaster Tools v2 nightly pull
--      (and later DMARC rua ingestion). Empty until then.
--   3. Bounce measures on prospecting_metric_daily (bounces_hard,
--      bounces_soft, blocks) so bounce rate appears in WBR frames and the
--      insight engine can attribute deliverability causes.
--
-- Bounce events are attributed to the date DETECTED (NDR received), matched
-- back to the originating sequence_step_logs row via failed-recipient →
-- prospect email → most recent email-channel send. Unmatched NDRs (e.g. a
-- bounce for a non-prospect email) are still recorded with NULL linkage for
-- org-level deliverability counting.
--
-- Org-level behavior config lives in organizations.settings.bounce_handling:
--   { "auto_stop_on_hard_bounce": true }      -- default true (decision D26)
-- Hard bounce = permanent failure (bad address). Continuing to email a dead
-- address damages sender reputation, so active enrollments for that prospect
-- are stopped (stop_reason = 'hard_bounce') unless the org opts out:
--
--   UPDATE organizations
--      SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{bounce_handling}',
--            COALESCE(settings->'bounce_handling', '{}'::jsonb)
--            || '{"auto_stop_on_hard_bounce": false}'::jsonb, true)
--    WHERE id = <org id>;
--
-- Safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. Message-grain delivery events ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.email_delivery_events (
    id                  bigserial PRIMARY KEY,
    org_id              integer      NOT NULL,
    detected_at         timestamptz  NOT NULL DEFAULT now(),  -- when the NDR was seen
    provider            varchar(20),                          -- gmail | outlook (sender's mailbox provider)
    ndr_external_id     varchar(255),                         -- provider message id of the NDR itself
    ndr_from            varchar(255),                         -- mailer-daemon@... / postmaster@...
    failed_recipient    varchar(255) NOT NULL,                -- the address that bounced
    event_type          varchar(20)  NOT NULL,                -- hard_bounce | soft_bounce | block
    smtp_code           varchar(20),                          -- e.g. '550 5.1.1', '5.7.26', '421'
    diagnostic_excerpt  text,                                 -- short snippet of the failure text
    prospect_id         integer,                              -- matched prospect (nullable)
    step_log_id         bigint,                               -- matched sequence_step_logs row (nullable)
    sender_account_id   integer,                              -- via matched step log's email (nullable)
    campaign_id         integer,                              -- prospect's campaign at detection (nullable)
    enrollment_stopped  boolean      NOT NULL DEFAULT false,  -- auto-stop fired for this event
    created_at          timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT chk_ede_event_type CHECK (event_type IN ('hard_bounce','soft_bounce','block'))
);

COMMENT ON TABLE public.email_delivery_events IS
  'Per-message bounce/block events parsed from NDR messages at inbox-sync Gate 1 by BounceDetectionService. The only per-message delivery signal available when sending via real Gmail/Outlook mailboxes. Feeds prospecting_metric_daily bounce measures and the OutboundInsightEngine deliverability causes. See docs/INSIGHTS_WBR_DESIGN.md Phase 2.';

COMMENT ON COLUMN public.email_delivery_events.event_type IS
  'hard_bounce = permanent (5.1.x, user unknown) → list-quality cause, may auto-stop enrollment. soft_bounce = transient (4.x.x, mailbox full). block = policy/reputation rejection (5.7.x, spam/blocked) → sender-health cause.';

-- Idempotency across re-syncs: one event per (org, NDR message, failed address).
CREATE UNIQUE INDEX IF NOT EXISTS uq_ede_ndr_recipient
  ON public.email_delivery_events (org_id, ndr_external_id, failed_recipient)
  WHERE ndr_external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ede_org_detected
  ON public.email_delivery_events (org_id, detected_at);

CREATE INDEX IF NOT EXISTS idx_ede_prospect
  ON public.email_delivery_events (prospect_id) WHERE prospect_id IS NOT NULL;

-- ── 2. Domain-grain health (populated in Phase 6) ────────────────────────────

CREATE TABLE IF NOT EXISTS public.domain_health_daily (
    id                bigserial PRIMARY KEY,
    org_id            integer      NOT NULL,
    domain            varchar(255) NOT NULL,
    metric_date       date         NOT NULL,
    source            varchar(30)  NOT NULL DEFAULT 'postmaster_v2',  -- postmaster_v2 | dmarc_rua
    spam_rate         numeric(7,5),          -- Gmail user-reported spam rate (0.001 = 0.1%)
    compliance_status varchar(30),           -- Postmaster v2 compliance verdict
    auth_pass_rate    numeric(7,5),          -- SPF/DKIM/DMARC alignment pass rate
    delivery_errors   jsonb,                 -- error-class breakdown
    raw               jsonb,                 -- full API response for forensics
    created_at        timestamptz  NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.domain_health_daily IS
  'Domain-level deliverability health. Created in Phase 2, populated in Phase 6 (Google Postmaster Tools v2 nightly pull; later DMARC rua). Insight-rule thresholds: spam_rate < 0.001 safe; >= 0.003 Gmail may reject. Sparse below ~200 Gmail-recipient sends/day (Google privacy suppression).';

CREATE UNIQUE INDEX IF NOT EXISTS uq_dhd_grain
  ON public.domain_health_daily (org_id, domain, metric_date, source);

-- ── 3. Bounce measures on the snapshot ───────────────────────────────────────

ALTER TABLE public.prospecting_metric_daily
  ADD COLUMN IF NOT EXISTS bounces_hard integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bounces_soft integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS blocks       integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.prospecting_metric_daily.bounces_hard IS
  'email_delivery_events hard_bounce, by detected date. Bounce rate for a period = SUM(bounces_hard + bounces_soft + blocks) / SUM(sent) over that period.';

COMMIT;
