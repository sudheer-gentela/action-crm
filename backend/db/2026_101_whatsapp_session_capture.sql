-- ═══════════════════════════════════════════════════════════════════════════
-- 2026_101_whatsapp_session_capture.sql
--
-- Session-based capture of EXISTING WhatsApp groups.
--
-- WHY THIS EXISTS
--   2026_65 modelled groups for Meta's Groups API. That path can only ever see
--   groups WE created: the API cannot adopt a group made on consumer WhatsApp,
--   it requires OBA, and it caps at 8 participants. Our customers do not work
--   that way — they create a project group on their phone, add the client, and
--   talk. Cloud API is structurally blind to those conversations.
--
--   A session client (Baileys) authenticates as a COMPANION DEVICE of an
--   ordinary WhatsApp number — the same mechanism as WhatsApp Web — and
--   therefore receives every message that number receives, including groups
--   created years ago by someone else.
--
-- WHAT THIS IS NOT
--   This is not a Meta API. It is an unofficial client. It carries ban risk on
--   the number it runs as. Everything here is deliberately READ-ONLY and every
--   row it writes is tagged so the send path can refuse to touch it. See
--   docs/whatsapp-session-capture.md before enabling for a tenant.
--
-- TWO NAMESPACES, ONE TABLE
--   whatsapp_threads.wa_group_id already holds Meta's Groups API group id.
--   Session groups are keyed by JID ('1203630432...@g.us'). They will never
--   collide in practice, but they are NOT interchangeable — sending a Cloud API
--   message to a JID fails. `source` is the discriminator that keeps the send
--   path honest, and it is NOT NULL so a new thread cannot forget to declare
--   which world it lives in.
--
-- IDEMPOTENT: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. PROVENANCE ON EXISTING TABLES
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE public.whatsapp_threads
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'cloud_api';

ALTER TABLE public.whatsapp_threads
  DROP CONSTRAINT IF EXISTS whatsapp_threads_source_chk;
ALTER TABLE public.whatsapp_threads
  ADD  CONSTRAINT whatsapp_threads_source_chk
  CHECK (source IN ('cloud_api', 'session'));

COMMENT ON COLUMN public.whatsapp_threads.source IS
  'Which transport owns this thread. cloud_api = Meta Graph, sendable. session = observed via a companion-device client, READ-ONLY — wa_group_id holds a JID, not a Meta group id, and any Graph send against it will fail. listSendTargets() must exclude source=''session''.';

-- A session thread is only ever a group we were added to. Enforcing it here
-- stops a future code path from quietly creating a "sendable" direct thread
-- that the send layer would then try to use.
ALTER TABLE public.whatsapp_threads
  DROP CONSTRAINT IF EXISTS whatsapp_threads_session_group_only_chk;
ALTER TABLE public.whatsapp_threads
  ADD  CONSTRAINT whatsapp_threads_session_group_only_chk
  CHECK (source <> 'session' OR kind = 'group');

ALTER TABLE public.whatsapp_messages
  ADD COLUMN IF NOT EXISTS capture_source text NOT NULL DEFAULT 'cloud_api',
  ADD COLUMN IF NOT EXISTS capture_meta   jsonb;

ALTER TABLE public.whatsapp_messages
  DROP CONSTRAINT IF EXISTS whatsapp_messages_capture_source_chk;
ALTER TABLE public.whatsapp_messages
  ADD  CONSTRAINT whatsapp_messages_capture_source_chk
  CHECK (capture_source IN ('cloud_api', 'session'));

COMMENT ON COLUMN public.whatsapp_messages.capture_meta IS
  'Session-capture provenance, mirroring the LinkedIn extension''s capture_meta discipline: { sessionId, workerVersion, baileysVersion, jid, participantJid, receivedAt, msgType }. Lets us tell later which worker build produced a row when a normaliser bug is found.';

-- Group threads that nobody has bound to a project yet. This is the triage
-- inbox query; without the index it is a seq scan on every poll.
CREATE INDEX IF NOT EXISTS idx_wa_threads_session_unbound
  ON public.whatsapp_threads (org_id, updated_at DESC)
  WHERE source = 'session' AND handover_id IS NULL;


-- ─────────────────────────────────────────────────────────────────────────
-- 2. SESSIONS
--
-- One row per WhatsApp number we observe with. Deliberately per-org and NOT
-- global: one number sitting in many unrelated tenants' groups is both a spam
-- signal to WhatsApp and a cross-tenant data path that fights RLS.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.whatsapp_sessions (
  id                serial PRIMARY KEY,
  org_id            integer NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  label             text,                -- 'Implementation observer', for the UI
  wa_phone          text,                -- E.164 no '+', learned at link time
  push_name         text,                -- the profile name other members see

  -- Lifecycle. 'pending_qr' means a worker is up and waiting for someone to
  -- scan; 'logged_out' means WhatsApp invalidated us and only a human with the
  -- handset can fix it.
  status            text NOT NULL DEFAULT 'pending_qr',
  status_detail     text,

  -- Liveness. last_seen_at is written on every successful socket event; the
  -- health check alerts on staleness. A capture feature that silently stops
  -- capturing is worse than no feature, so this is not optional.
  connected_at      timestamp with time zone,
  last_seen_at      timestamp with time zone,
  last_message_at   timestamp with time zone,

  -- Meta's rule: if the PRIMARY handset goes untouched for 14 days every
  -- companion device is logged out. We warn well before that.
  phone_last_seen_at timestamp with time zone,

  -- Operational guardrails, per-session so one noisy tenant cannot be
  -- reconfigured globally by accident.
  capture_enabled   boolean NOT NULL DEFAULT true,
  capture_media     boolean NOT NULL DEFAULT false,

  created_by        integer REFERENCES public.users(id),
  created_at        timestamp with time zone NOT NULL DEFAULT now(),
  updated_at        timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT whatsapp_sessions_status_chk
    CHECK (status IN ('pending_qr', 'connecting', 'connected', 'disconnected',
                      'logged_out', 'disabled'))
);

-- One active session per org. A second concurrent socket on the same number is
-- the classic way to desync Signal keys and kill the session.
CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_sessions_org
  ON public.whatsapp_sessions (org_id)
  WHERE status <> 'disabled';

COMMENT ON TABLE public.whatsapp_sessions IS
  'A WhatsApp number observed via a companion-device client. Read-only by design: this table has no send-side columns and the worker never calls sendMessage or readMessages.';


-- ─────────────────────────────────────────────────────────────────────────
-- 3. AUTH STATE
--
-- Baileys' useMultiFileAuthState writes creds + Signal key material to local
-- disk. Railway containers are ephemeral, so the next deploy would wipe the
-- session and force a QR rescan — the single most common way a first attempt
-- at this dies. Key material lives here instead.
--
-- Encrypted with the house AES-256-GCM helper (services/credentials/
-- encryption.js), same ciphertext/iv/tag triple as org_whatsapp_accounts.
-- This is somebody's live WhatsApp identity; it does not sit in plaintext.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.whatsapp_session_auth (
  session_id    integer NOT NULL REFERENCES public.whatsapp_sessions(id) ON DELETE CASCADE,

  -- 'creds' for the root credential blob, else '<keytype>:<id>' e.g.
  -- 'pre-key:31', 'session:919...@s.whatsapp.net', 'sender-key:...'.
  key_id        text NOT NULL,

  value_ciphertext bytea NOT NULL,
  value_iv         bytea NOT NULL,
  value_tag        bytea NOT NULL,

  updated_at    timestamp with time zone NOT NULL DEFAULT now(),

  PRIMARY KEY (session_id, key_id)
);

COMMENT ON TABLE public.whatsapp_session_auth IS
  'Baileys AuthenticationState persisted per session. Rows are written on nearly every message (Signal ratchet advance), so keep this table out of any broad audit trigger.';


-- ─────────────────────────────────────────────────────────────────────────
-- 4. GROUP BINDINGS
--
-- The worker is org-blind: it sees JIDs. This table is what turns a JID into a
-- tenant + project, and therefore what satisfies RLS on the write. A group we
-- have not bound yet still gets its messages stored (against an unbound
-- thread) — dropping them would mean the audit trail has a hole that no later
-- binding can fill.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.whatsapp_session_groups (
  id                serial PRIMARY KEY,
  session_id        integer NOT NULL REFERENCES public.whatsapp_sessions(id) ON DELETE CASCADE,
  org_id            integer NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  group_jid         text NOT NULL,
  subject           text,
  subject_owner_jid text,
  group_created_at  timestamp with time zone,
  participant_count integer,

  -- The mirrored thread in whatsapp_threads (source='session').
  thread_id         integer REFERENCES public.whatsapp_threads(id) ON DELETE SET NULL,

  -- Triage state. 'ignored' is a first-class outcome: a rep's personal group
  -- should be dismissable permanently, not re-surfaced every time it is noisy.
  binding_status    text NOT NULL DEFAULT 'unbound',
  bound_by          integer REFERENCES public.users(id),
  bound_at          timestamp with time zone,

  first_seen_at     timestamp with time zone NOT NULL DEFAULT now(),
  last_message_at   timestamp with time zone,
  message_count     integer NOT NULL DEFAULT 0,

  created_at        timestamp with time zone NOT NULL DEFAULT now(),
  updated_at        timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT wa_session_groups_binding_chk
    CHECK (binding_status IN ('unbound', 'bound', 'ignored'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_session_groups_jid
  ON public.whatsapp_session_groups (session_id, group_jid);

CREATE INDEX IF NOT EXISTS idx_wa_session_groups_triage
  ON public.whatsapp_session_groups (org_id, binding_status, last_message_at DESC);

COMMENT ON COLUMN public.whatsapp_session_groups.binding_status IS
  'unbound = captured but not yet attached to a project (shows in triage). bound = thread_id has a handover_id. ignored = a human said this group is not project traffic; keep capturing nothing further and stop surfacing it.';


-- ─────────────────────────────────────────────────────────────────────────
-- 5. RLS
--
-- Match the existing org-scoped policy shape so these tables are not the one
-- hole in the tenant boundary.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE public.whatsapp_sessions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_session_groups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_sessions_org_isolation ON public.whatsapp_sessions;
CREATE POLICY whatsapp_sessions_org_isolation ON public.whatsapp_sessions
  USING (org_id = current_setting('app.current_org_id', true)::integer);

DROP POLICY IF EXISTS whatsapp_session_groups_org_isolation ON public.whatsapp_session_groups;
CREATE POLICY whatsapp_session_groups_org_isolation ON public.whatsapp_session_groups
  USING (org_id = current_setting('app.current_org_id', true)::integer);

COMMIT;
