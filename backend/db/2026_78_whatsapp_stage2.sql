-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_78_whatsapp_stage2.sql
--
-- WhatsApp Stage 2: org-authored template governance + per-message cost ledger.
--
-- Additive and idempotent. Safe to apply on its own; changes nothing about how
-- existing WhatsApp messaging behaves until the new endpoints/screens are used.
--
-- NUMBERING: 77 = (prior). This is 78.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

-- ── Template governance ──────────────────────────────────────────────────────
-- Two independent gates live on whatsapp_templates:
--   review_status : GoWarm-internal gate (proposed → admin_approved | admin_rejected)
--   status        : Meta gate (draft → pending → approved | rejected | paused | disabled)
-- Only review_status='admin_approved' templates are submitted to Meta; only
-- status='approved' templates are usable in the composer.
ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'admin_approved';
ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS review_reason text;
ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS reviewed_by   integer;
ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS reviewed_at   timestamp with time zone;
-- 'internal'  = messages that only go to the customer-org's own team
-- 'customer'  = includes the end customer
-- 'any'       = either (default; audience is otherwise derived from participants)
ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS audience   text NOT NULL DEFAULT 'any';
-- 'org'  = visible to every user in the org (default today)
-- 'grant'= visible only to users with an explicit row in whatsapp_template_grants
ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'org';

ALTER TABLE whatsapp_templates DROP CONSTRAINT IF EXISTS whatsapp_templates_review_status_chk;
ALTER TABLE whatsapp_templates ADD  CONSTRAINT whatsapp_templates_review_status_chk
  CHECK (review_status IN ('proposed','admin_approved','admin_rejected'));
ALTER TABLE whatsapp_templates DROP CONSTRAINT IF EXISTS whatsapp_templates_audience_chk;
ALTER TABLE whatsapp_templates ADD  CONSTRAINT whatsapp_templates_audience_chk
  CHECK (audience IN ('internal','customer','any'));
ALTER TABLE whatsapp_templates DROP CONSTRAINT IF EXISTS whatsapp_templates_visibility_chk;
ALTER TABLE whatsapp_templates ADD  CONSTRAINT whatsapp_templates_visibility_chk
  CHECK (visibility IN ('org','grant'));

CREATE INDEX IF NOT EXISTS idx_wa_templates_org_status
  ON whatsapp_templates (org_id, status);
CREATE INDEX IF NOT EXISTS idx_wa_templates_org_review
  ON whatsapp_templates (org_id, review_status);

-- One-off per-user visibility grants (unused while visibility='org'; the seam for
-- the hierarchy model). A user sees a 'grant'-scoped template only via a row here.
CREATE TABLE IF NOT EXISTS whatsapp_template_grants (
  id           serial PRIMARY KEY,
  org_id       integer NOT NULL,
  template_id  integer NOT NULL REFERENCES whatsapp_templates(id) ON DELETE CASCADE,
  user_id      integer NOT NULL,
  granted_by   integer,
  created_at   timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (template_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_wa_template_grants_user ON whatsapp_template_grants (org_id, user_id);

-- ── Cost ledger ──────────────────────────────────────────────────────────────
-- One row per delivered/charged message. meta_* fields are populated from Meta's
-- status-webhook `pricing` object (source of truth). For a group send there is
-- one row per recipient. billed_amount is filled only for provider_rebill orgs.
CREATE TABLE IF NOT EXISTS whatsapp_message_costs (
  id                serial PRIMARY KEY,
  org_id            integer NOT NULL,
  message_id        integer,                 -- FK-ish to whatsapp_messages.id (nullable for group fan-out legs)
  wa_message_id     text,
  thread_id         integer,
  group_thread_id   integer,
  category          text,                    -- marketing | utility | authentication | service
  audience          text NOT NULL DEFAULT 'any',
  pricing_model     text,                    -- from Meta pricing.pricing_model (e.g. PMP, CBP)
  billable          boolean,                 -- from Meta pricing.billable
  recipient_country text,
  meta_cost_amount  numeric(12,5),           -- resolved cost (from rate card by category+country)
  meta_cost_currency text,
  billed_amount     numeric(12,5) NOT NULL DEFAULT 0,   -- provider_rebill: meta_cost * (1+markup); else 0
  billed_currency   text,
  created_at        timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (org_id, wa_message_id)
);
CREATE INDEX IF NOT EXISTS idx_wa_costs_org_time     ON whatsapp_message_costs (org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_wa_costs_org_category ON whatsapp_message_costs (org_id, category);

-- ── Rate card ────────────────────────────────────────────────────────────────
-- Estimates + fallback when Meta's webhook doesn't carry an amount. Keyed by
-- category + recipient country, effective-dated. Amounts are Meta list prices;
-- BSP/markup is applied per org via whatsapp_billing_config.
CREATE TABLE IF NOT EXISTS whatsapp_rates (
  id             serial PRIMARY KEY,
  category       text NOT NULL,              -- marketing | utility | authentication | service
  country        text NOT NULL,             -- ISO-3166 alpha-2, or 'DEFAULT'
  amount         numeric(12,5) NOT NULL,
  currency       text NOT NULL DEFAULT 'INR',
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  created_at     timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (category, country, effective_from)
);

-- Seed India + a DEFAULT fallback (Jan-2026 order-of-magnitude list prices in INR;
-- service is free. Update as Meta's rate card changes — esp. the 1-Oct-2026 shift
-- that begins charging for in-window utility/service messages).
INSERT INTO whatsapp_rates (category, country, amount, currency) VALUES
  ('utility',        'IN',      0.115, 'INR'),
  ('marketing',      'IN',      0.863, 'INR'),
  ('authentication', 'IN',      0.115, 'INR'),
  ('service',        'IN',      0.000, 'INR'),
  ('utility',        'DEFAULT', 0.020, 'USD'),
  ('marketing',      'DEFAULT', 0.050, 'USD'),
  ('authentication', 'DEFAULT', 0.020, 'USD'),
  ('service',        'DEFAULT', 0.000, 'USD')
ON CONFLICT (category, country, effective_from) DO NOTHING;

-- ── Per-org billing configuration ────────────────────────────────────────────
-- billing_mode:
--   customer_direct = the org's own WABA/card pays Meta; GoWarm only tracks usage.
--   provider_rebill = GoWarm's account pays Meta; GoWarm rebills the org (+markup).
CREATE TABLE IF NOT EXISTS whatsapp_billing_config (
  org_id        integer PRIMARY KEY,
  billing_mode  text NOT NULL DEFAULT 'customer_direct',
  markup_pct    numeric(6,3) NOT NULL DEFAULT 0,
  currency      text NOT NULL DEFAULT 'INR',
  platform_fee  numeric(12,2) NOT NULL DEFAULT 0,
  updated_by    integer,
  updated_at    timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_billing_mode_chk CHECK (billing_mode IN ('customer_direct','provider_rebill'))
);

COMMIT;
