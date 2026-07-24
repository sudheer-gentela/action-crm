-- ═══════════════════════════════════════════════════════════════════════════
-- 2026_65_whatsapp_channel.sql
--
-- WhatsApp as a first-class communication channel.
--
-- Today `whatsapp` exists in this codebase only as a LABEL: it is a permitted
-- value in chk_paction_channel, it appears in ActionWriter's channel lists, and
-- playbook.service maps it to a prospect_channel. Nothing sends. Nothing
-- receives. notification_deliveries doesn't even allow it as a channel value.
-- This migration creates the storage the channel actually needs.
--
-- CREDENTIAL PATTERN
--   Mirrors org_slack_installs / org_twilio_accounts exactly: per-org row,
--   ciphertext + iv + tag triples via services/credentials/encryption.js,
--   last4 retained for display, status enum for revocation. No new crypto.
--
-- WHY A SEPARATE THREAD TABLE (not just messages)
--   A WhatsApp conversation has a state machine that email does not: the
--   24-hour customer service window. Whether you may send free-form text right
--   now — and whether that send is free or billable — depends on when the
--   counterparty last messaged you. That is thread state, not message state, so
--   it lives on the thread and is recomputed on every inbound.
--
-- GROUPS
--   Meta's Groups API (GA 2026) caps groups at 8 participants and permits
--   exactly one Cloud API business per group. Groups must be API-CREATED — an
--   existing customer group made on consumer WhatsApp can never be adopted.
--   whatsapp_threads therefore models both 1:1 and group with a `kind` column,
--   and `wa_group_id` is only populated for kind='group'.
--
-- IDEMPOTENT: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. PER-ORG WHATSAPP BUSINESS ACCOUNT
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.org_whatsapp_accounts (
  org_id                    integer PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- Meta identifiers
  waba_id                   text NOT NULL,           -- WhatsApp Business Account ID
  phone_number_id           text NOT NULL,           -- the sender; used in every Graph call
  display_phone_number      text,                    -- E.164, for the UI
  business_id               text,                    -- Meta Business Manager ID
  verified_name             text,                    -- the name recipients see

  -- Credentials (house encryption pattern)
  access_token_ciphertext   bytea NOT NULL,
  access_token_iv           bytea NOT NULL,
  access_token_tag          bytea NOT NULL,
  access_token_last4        text,
  app_secret_ciphertext     bytea,                   -- for X-Hub-Signature-256 verification
  app_secret_iv             bytea,
  app_secret_tag            bytea,

  -- Inbound webhook verification
  webhook_verify_token      text,

  -- Capability flags, set at onboarding
  provider                  text NOT NULL DEFAULT 'meta_cloud',
  is_official_business_account boolean NOT NULL DEFAULT false,  -- OBA gates the Groups API
  groups_enabled            boolean NOT NULL DEFAULT false,
  quality_rating            text,                    -- GREEN | YELLOW | RED, from webhook
  messaging_limit_tier      text,                    -- TIER_1K | TIER_10K | ...

  status                    text NOT NULL DEFAULT 'active',
  connected_by              integer REFERENCES public.users(id),
  created_at                timestamp with time zone NOT NULL DEFAULT now(),
  updated_at                timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT org_whatsapp_accounts_status_chk
    CHECK (status IN ('active', 'suspended', 'revoked')),
  CONSTRAINT org_whatsapp_accounts_provider_chk
    CHECK (provider IN ('meta_cloud', 'twilio'))
);

COMMENT ON TABLE public.org_whatsapp_accounts IS
  'Per-org WhatsApp Business Account. provider=meta_cloud talks to Graph directly; provider=twilio routes through the org''s existing Twilio subaccount (org_twilio_accounts). Groups API requires meta_cloud + is_official_business_account.';
COMMENT ON COLUMN public.org_whatsapp_accounts.is_official_business_account IS
  'Meta OBA status. Gates the Groups API — without it, group creation returns a permissions error regardless of scopes.';


-- ─────────────────────────────────────────────────────────────────────────
-- 2. MESSAGE TEMPLATES
--
-- Business-initiated messages MUST use a template pre-approved by Meta.
-- Approval is asynchronous and can be REJECTED, so template state has to be
-- stored and polled — you cannot assume a template you defined is sendable.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.whatsapp_templates (
  id                serial PRIMARY KEY,
  org_id            integer NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  name              text NOT NULL,                   -- Meta template name (snake_case)
  language          text NOT NULL DEFAULT 'en',
  category          text NOT NULL,                   -- UTILITY | MARKETING | AUTHENTICATION
  meta_template_id  text,                            -- assigned by Meta on submission

  body_text         text NOT NULL,                   -- with {{1}} {{2}} placeholders
  header_text       text,
  footer_text       text,
  variable_map      jsonb NOT NULL DEFAULT '[]'::jsonb,  -- ordered list of source paths

  status            text NOT NULL DEFAULT 'draft',
  rejection_reason  text,

  -- Internal routing key: which GoWarmCRM event this template serves.
  purpose           text,

  submitted_at      timestamp with time zone,
  approved_at       timestamp with time zone,
  created_by        integer REFERENCES public.users(id),
  created_at        timestamp with time zone NOT NULL DEFAULT now(),
  updated_at        timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT whatsapp_templates_status_chk
    CHECK (status IN ('draft', 'pending', 'approved', 'rejected', 'paused', 'disabled')),
  CONSTRAINT whatsapp_templates_category_chk
    CHECK (category IN ('UTILITY', 'MARKETING', 'AUTHENTICATION'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_templates_org_name_lang
  ON public.whatsapp_templates (org_id, name, language);

CREATE INDEX IF NOT EXISTS idx_wa_templates_purpose
  ON public.whatsapp_templates (org_id, purpose)
  WHERE status = 'approved';

COMMENT ON COLUMN public.whatsapp_templates.category IS
  'Drives cost. In India (Jan 2026 rate card) UTILITY is ~Rs 0.115 per delivered message vs MARKETING at ~Rs 0.863 — roughly 7.5x. Every operational GoWarmCRM notification (milestone due, sign-off request, status change) is legitimately UTILITY. Mis-categorising these as MARKETING is the single most expensive mistake available on this channel.';
COMMENT ON COLUMN public.whatsapp_templates.variable_map IS
  'Ordered array of dot-paths resolved against the send context, e.g. ["stakeholder.name","commitment.description","commitment.dueDate"] maps to {{1}},{{2}},{{3}}.';


-- ─────────────────────────────────────────────────────────────────────────
-- 3. THREADS (1:1 and group)
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.whatsapp_threads (
  id                    serial PRIMARY KEY,
  org_id                integer NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  kind                  text NOT NULL DEFAULT 'direct',   -- direct | group

  -- 1:1 identity
  wa_phone              text,                             -- E.164, no '+'
  -- group identity (Groups API)
  wa_group_id           text,
  group_subject         text,
  group_invite_link     text,

  -- What this thread is ABOUT. Nullable so an inbound from an unknown number
  -- still lands somewhere and can be linked later.
  handover_id           integer REFERENCES public.sales_handovers(id) ON DELETE SET NULL,
  deal_id               integer,
  account_id            integer,
  contact_id            integer,
  prospect_id           integer,
  client_id             integer,

  -- Service-window state, recomputed on every inbound message.
  last_inbound_at       timestamp with time zone,
  last_outbound_at      timestamp with time zone,
  window_expires_at     timestamp with time zone,

  opt_in_at             timestamp with time zone,
  opt_in_source         text,
  opt_out_at            timestamp with time zone,

  status                text NOT NULL DEFAULT 'active',
  created_by            integer REFERENCES public.users(id),
  created_at            timestamp with time zone NOT NULL DEFAULT now(),
  updated_at            timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT whatsapp_threads_kind_chk   CHECK (kind IN ('direct', 'group')),
  CONSTRAINT whatsapp_threads_status_chk CHECK (status IN ('active', 'archived', 'blocked')),
  -- A direct thread needs a phone; a group thread needs a group id.
  CONSTRAINT whatsapp_threads_identity_chk CHECK (
    (kind = 'direct' AND wa_phone    IS NOT NULL) OR
    (kind = 'group'  AND wa_group_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_threads_direct
  ON public.whatsapp_threads (org_id, wa_phone)
  WHERE kind = 'direct';

CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_threads_group
  ON public.whatsapp_threads (org_id, wa_group_id)
  WHERE kind = 'group';

CREATE INDEX IF NOT EXISTS idx_wa_threads_handover
  ON public.whatsapp_threads (handover_id)
  WHERE handover_id IS NOT NULL;

COMMENT ON COLUMN public.whatsapp_threads.window_expires_at IS
  'last_inbound_at + 24h. While in the future, free-form (non-template) sends are permitted and currently free. Note: Meta has announced service-message pricing changes effective 1 Oct 2026 — the permission stays, the "free" part does not. Do not hard-code the assumption that inside-window sends cost nothing.';
COMMENT ON COLUMN public.whatsapp_threads.wa_group_id IS
  'Groups API group ID. Only ever set by group creation through our own API call — an existing consumer-app group cannot be adopted, and only one Cloud API business may occupy a group.';


-- Participants of a group thread. Cap of 8 is Meta's, enforced in the service
-- layer with a friendly error rather than as a DB constraint (a partial-failure
-- add would otherwise leave the group and our mirror out of sync).
CREATE TABLE IF NOT EXISTS public.whatsapp_thread_participants (
  id            serial PRIMARY KEY,
  thread_id     integer NOT NULL REFERENCES public.whatsapp_threads(id) ON DELETE CASCADE,
  org_id        integer NOT NULL,

  wa_phone      text NOT NULL,
  display_name  text,

  -- Who this maps to internally, if anyone.
  user_id       integer REFERENCES public.users(id),
  contact_id    integer,
  stakeholder_id integer REFERENCES public.sales_handover_stakeholders(id) ON DELETE SET NULL,
  side          text NOT NULL DEFAULT 'customer',     -- customer | internal

  joined_at     timestamp with time zone,
  left_at       timestamp with time zone,
  created_at    timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT wa_participants_side_chk CHECK (side IN ('customer', 'internal'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_participants
  ON public.whatsapp_thread_participants (thread_id, wa_phone);


-- ─────────────────────────────────────────────────────────────────────────
-- 4. MESSAGES — the auditable log
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.whatsapp_messages (
  id                serial PRIMARY KEY,
  org_id            integer NOT NULL,
  thread_id         integer NOT NULL REFERENCES public.whatsapp_threads(id) ON DELETE CASCADE,

  wa_message_id     text,                            -- Meta's wamid, for status correlation
  direction         text NOT NULL,                   -- inbound | outbound
  message_type      text NOT NULL DEFAULT 'text',    -- text | image | document | audio | video | template | system

  body              text,
  media_url         text,
  media_mime_type   text,
  media_sha256      text,

  -- Outbound provenance
  template_id       integer REFERENCES public.whatsapp_templates(id),
  sent_by_user_id   integer REFERENCES public.users(id),
  is_automated      boolean NOT NULL DEFAULT false,

  -- Inbound provenance
  from_phone        text,
  from_name         text,

  -- Delivery lifecycle (driven by status webhooks)
  status            text NOT NULL DEFAULT 'queued',
  error_code        text,
  error_message     text,
  billable          boolean,
  pricing_category  text,

  sent_at           timestamp with time zone,
  delivered_at      timestamp with time zone,
  read_at           timestamp with time zone,
  failed_at         timestamp with time zone,
  created_at        timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT wa_messages_direction_chk CHECK (direction IN ('inbound', 'outbound')),
  CONSTRAINT wa_messages_status_chk
    CHECK (status IN ('queued', 'sent', 'delivered', 'read', 'failed', 'received'))
);

-- Idempotency: Meta retries webhooks aggressively. Without this, a redelivered
-- inbound is stored twice and the thread's activity timeline lies.
CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_messages_wamid
  ON public.whatsapp_messages (org_id, wa_message_id)
  WHERE wa_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wa_messages_thread_time
  ON public.whatsapp_messages (thread_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wa_messages_org_time
  ON public.whatsapp_messages (org_id, created_at DESC);


-- Keep the service window current without an application round-trip.
CREATE OR REPLACE FUNCTION public.touch_whatsapp_thread_window()
RETURNS trigger AS $$
BEGIN
  IF NEW.direction = 'inbound' THEN
    UPDATE public.whatsapp_threads
       SET last_inbound_at   = COALESCE(NEW.sent_at, NEW.created_at),
           window_expires_at = COALESCE(NEW.sent_at, NEW.created_at) + interval '24 hours',
           updated_at        = now()
     WHERE id = NEW.thread_id;
  ELSE
    UPDATE public.whatsapp_threads
       SET last_outbound_at = COALESCE(NEW.sent_at, NEW.created_at),
           updated_at       = now()
     WHERE id = NEW.thread_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_wa_thread_window ON public.whatsapp_messages;
CREATE TRIGGER trg_wa_thread_window
  AFTER INSERT ON public.whatsapp_messages
  FOR EACH ROW EXECUTE FUNCTION public.touch_whatsapp_thread_window();


-- ─────────────────────────────────────────────────────────────────────────
-- 5. WIRE WHATSAPP INTO EXISTING CHANNEL ENUMS
-- ─────────────────────────────────────────────────────────────────────────

-- notification_deliveries currently permits in_app | email | slack | teams only,
-- so every WhatsApp delivery attempt would be silently dropped by
-- notificationDeliveryLog.record() (it returns early on an unknown channel).
ALTER TABLE public.notification_deliveries
  DROP CONSTRAINT IF EXISTS chk_notif_delivery_channel;

ALTER TABLE public.notification_deliveries
  ADD CONSTRAINT chk_notif_delivery_channel
  CHECK (channel IN ('in_app', 'email', 'slack', 'teams', 'whatsapp'));


-- Per-user opt-in for WhatsApp notifications, alongside the Slack prefs that
-- already live in the notification preferences JSON. Stored as a column rather
-- than only in JSON because consent needs to be queryable for compliance.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS whatsapp_phone       text,
  ADD COLUMN IF NOT EXISTS whatsapp_opt_in_at   timestamp with time zone;

COMMENT ON COLUMN public.users.whatsapp_opt_in_at IS
  'Explicit consent timestamp. Meta requires demonstrable opt-in before business-initiated messaging; NULL means we must not template-message this user.';

COMMIT;
