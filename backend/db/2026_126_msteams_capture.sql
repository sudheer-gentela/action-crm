-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_126_msteams_capture.sql
--
-- DROP-IN LOCATION: backend/db/2026_126_msteams_capture.sql
--
-- Microsoft Teams, phase 1: CAPTURE. Watched conversations start retaining
-- messages, attachment references, and who was present when.
--
-- Requires 2026_125_msteams_connect.sql.
--
-- NO BACKFILL. There is no historical import job and no import columns. Agreed
-- explicitly: there is not much history worth moving, and the delegated design
-- cannot bulk-export anyway — GET /users/{id}/chats/getAllMessages is
-- application-permission only. Capture starts when a conversation is watched
-- and runs forward from there, which is what capture_started_at records.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THREE DECISIONS ENCODED HERE
--
-- 1. EDITS AND DELETES — both bodies, one row.
--    Teams sends changeType 'updated' and 'deleted'; WhatsApp never did, so
--    every message we held was immutable by construction. Following Teams
--    exactly would mean evidence can silently change or vanish weeks after a
--    play was built on it. Freezing at capture would mean the timeline shows
--    text that no longer exists.
--
--    So both: body_original frozen at capture, body_current updated on edit.
--    The timeline renders current with an edited marker; evidence resolves to
--    original. This is the same principle 2026_124 already applied to files,
--    where snapshot_file_name and snapshot_web_url record what was ACCEPTED
--    rather than what the file later became.
--
--    A delete marks deleted_at and stops rendering. The row stays, because
--    evidence pointing at it must still resolve rather than 404. Actual removal
--    stays a human act through excluded_at / exclude_reason — deletion driven
--    by whoever tidied a channel in Teams is not a retention policy.
--
-- 2. SUBSCRIPTION OWNERSHIP — one per conversation, with failover.
--    Graph allows one subscription per app-and-conversation. 125 has one
--    msteams_conversations row per (connection, conversation), so two reps
--    watching one channel is two rows sharing a graph_id.
--
--    THIS FIXES A BUG IN 125. uq_msteams_subscription_conversation was a
--    partial unique index on conversation_id, which cannot see that collision
--    at all: two rows, two ids, one Graph resource. The index is replaced below
--    with one on (org_id, graph_id), which is the real invariant. graph_id is
--    denormalised onto msteams_subscriptions to make that expressible — a
--    unique index cannot reach through a join.
--
--    owner_connection_id records whose token holds it, and failed_over_from
--    plus failover_count record when that changed. When a renewal fails, the
--    job reassigns to another connection watching the same graph_id rather than
--    letting capture stop for everybody because one person's consent lapsed.
--    Graph does not backfill a lapsed subscription, so the gap between failure
--    and human response is unrecoverable time — which is why this heals itself
--    and logs, rather than only alerting.
--
-- 3. TEAMS AS PLAY EVIDENCE — schema now, picker later.
--    play_evidence_channel_chk gains 'teams' at the foot of this file. Two
--    lines, and doing it later means altering a CHECK on a table that by then
--    holds real rows for no benefit. The evidence PICKER in
--    ProjectPlayModals.js is phase 2. Until then a Teams message shows in the
--    timeline but cannot be attached to a play, which reads as not-yet-built
--    rather than broken.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY A THREADS TABLE
--   A Teams CHANNEL conversation is a rooted reply chain: every message carries
--   replyToId and belongs to exactly one thread. That is the strongest
--   attribution signal in this entire integration and nothing in WhatsApp
--   resembled it — attribute the root once and every reply inherits
--   deterministically, which is what makes a multi-project channel tractable at
--   all.
--
--   A one-to-one or group CHAT has no threading; messages are flat. Such a chat
--   gets exactly one thread row whose root_graph_id is the conversation's own
--   graph_id. That keeps one join path for both shapes instead of two.
--
-- NUMBERING: 125 = msteams_connect. This is 126.
-- Run AFTER 2026_125.
--   psql "$DATABASE_URL" -f 2026_126_msteams_capture.sql
-- Safe to run more than once.
--
-- DEPLOY ORDER IS UNUSUAL FOR THIS ONE. Graph validates the notification URL
-- before it will create a subscription, so /webhooks/msteams must be live
-- BEFORE anything subscribes. Migration → backend (webhook inert until a
-- conversation is watched) → then enable watching. Not the usual single push.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'msteams_conversations'
  ) THEN
    RAISE EXCEPTION 'apply 2026_125_msteams_connect.sql first';
  END IF;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. FIX THE SUBSCRIPTION CONSTRAINT FROM 125
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.msteams_subscriptions
  ADD COLUMN IF NOT EXISTS graph_id           text,
  ADD COLUMN IF NOT EXISTS owner_connection_id integer REFERENCES public.msteams_connections(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS failed_over_from   integer REFERENCES public.msteams_connections(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS failover_count     integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_failover_at   timestamp with time zone;

-- Backfill is a no-op today — 125 created this table empty and nothing has
-- subscribed — but written so re-running after a partial deploy is safe.
UPDATE public.msteams_subscriptions s
   SET graph_id            = c.graph_id,
       owner_connection_id = COALESCE(s.owner_connection_id, s.connection_id)
  FROM public.msteams_conversations c
 WHERE c.id = s.conversation_id
   AND s.graph_id IS NULL;

-- The index from 125 could not express the real invariant. Two reps watching
-- one channel produce two conversation_id values against one Graph resource, so
-- keying on conversation_id permitted exactly the double-subscribe it was
-- written to prevent.
DROP INDEX IF EXISTS public.uq_msteams_subscription_conversation;

CREATE UNIQUE INDEX IF NOT EXISTS uq_msteams_subscription_resource
  ON public.msteams_subscriptions (org_id, graph_id)
  WHERE status IN ('active', 'expiring');

CREATE INDEX IF NOT EXISTS idx_msteams_subscriptions_owner
  ON public.msteams_subscriptions (owner_connection_id)
  WHERE status IN ('active', 'expiring');

COMMENT ON COLUMN public.msteams_subscriptions.graph_id IS
  'Denormalised from msteams_conversations so the uniqueness rule Graph actually enforces — one subscription per app-and-conversation — can be a unique index. A unique index cannot reach through a join, and the conversation_id key it replaces could not see two reps watching the same channel.';

COMMENT ON COLUMN public.msteams_subscriptions.owner_connection_id IS
  'Whose delegated token holds this subscription and is used to renew it. May differ from connection_id after a failover; connection_id records who originally created it.';

COMMENT ON COLUMN public.msteams_subscriptions.failed_over_from IS
  'The connection that owned this before a renewal failure moved it. Kept so the original rep''s broken connection still gets fixed rather than being silently papered over by the failover.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. CAPTURE WINDOW ON CONVERSATIONS
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.msteams_conversations
  ADD COLUMN IF NOT EXISTS capture_started_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS capture_stopped_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS message_count      integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_message_at    timestamp with time zone;

COMMENT ON COLUMN public.msteams_conversations.capture_started_at IS
  'When watching began. Capture runs forward from here and never backwards: there is no backfill, and a message predating this is one nobody consented to retain. Set on watch, left in place on unwatch so a re-watch shows the original start.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. THREADS
--
-- A channel thread is a rooted reply chain. A chat is one flat thread whose
-- root_graph_id is the conversation's own graph_id — same join path for both.
--
-- handover_id lives HERE as well as on the message because thread-root
-- inheritance is the primary attribution mechanism for channels: attribute the
-- root, and every reply follows without guessing. Per-message attribution on
-- msteams_messages exists for the cases that escape it.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.msteams_threads (
  id                serial PRIMARY KEY,
  org_id            integer NOT NULL REFERENCES public.organizations(id)         ON DELETE CASCADE,
  conversation_id   integer NOT NULL REFERENCES public.msteams_conversations(id) ON DELETE CASCADE,

  -- The root message's Graph id for a channel thread; the conversation's own
  -- graph_id for a flat chat.
  root_graph_id     text NOT NULL,

  -- Channel threads frequently carry one, and teams often use it as a de facto
  -- project label. A cheap third attribution signal after replies and mentions.
  subject           text,

  -- Attribution. NULL means unassigned, which is a legitimate resting state:
  -- per 2026_108, pool-mode conversations attribute on reply context and then
  -- STOP rather than guessing.
  handover_id       integer REFERENCES public.sales_handovers(id) ON DELETE SET NULL,
  attribution_source text,
  attributed_at     timestamp with time zone,
  attributed_by     integer REFERENCES public.users(id) ON DELETE SET NULL,

  first_message_at  timestamp with time zone,
  last_message_at   timestamp with time zone,
  message_count     integer NOT NULL DEFAULT 0,

  created_at        timestamp with time zone NOT NULL DEFAULT now(),
  updated_at        timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT msteams_threads_attribution_chk
    CHECK (attribution_source IS NULL OR attribution_source IN
           ('binding', 'thread_root', 'mention', 'subject', 'manual')),

  -- An attributed thread must say how it got there. Silent attribution is
  -- unauditable, and "why is this on my project" is the first question anyone
  -- asks about a message they did not expect.
  CONSTRAINT msteams_threads_attribution_shape_chk CHECK (
    (handover_id IS NULL AND attribution_source IS NULL)
    OR (handover_id IS NOT NULL AND attribution_source IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_msteams_threads_root
  ON public.msteams_threads (conversation_id, root_graph_id);

CREATE INDEX IF NOT EXISTS idx_msteams_threads_handover
  ON public.msteams_threads (org_id, handover_id)
  WHERE handover_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_msteams_threads_unassigned
  ON public.msteams_threads (org_id, last_message_at DESC)
  WHERE handover_id IS NULL;

COMMENT ON TABLE public.msteams_threads IS
  'A rooted reply chain in a channel, or the single flat thread of a chat. Channel threading is the strongest attribution signal in this integration and has no WhatsApp equivalent: attribute the root once and every reply inherits deterministically, which is what makes a multi-project channel workable.';

COMMENT ON COLUMN public.msteams_threads.attribution_source IS
  'binding = inherited from a project-bound conversation. thread_root = inherited from this thread''s root message. mention = matched a structured mention. subject = matched the thread subject. manual = a human moved it. Never NULL when handover_id is set.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. MESSAGES
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.msteams_messages (
  id                serial PRIMARY KEY,
  org_id            integer NOT NULL REFERENCES public.organizations(id)         ON DELETE CASCADE,
  conversation_id   integer NOT NULL REFERENCES public.msteams_conversations(id) ON DELETE CASCADE,
  thread_id         integer NOT NULL REFERENCES public.msteams_threads(id)       ON DELETE CASCADE,

  graph_message_id  text NOT NULL,
  reply_to_graph_id text,

  -- Sender. entra_object_id is the reliable identity — it arrives on every
  -- message as from.user.id and matches msteams_connections.entra_object_id.
  -- user_id is the resolved GoWarmCRM user and is NULL for anyone who is not
  -- one, which is normal: an external participant is recorded and rendered but
  -- not linked, same posture as WhatsApp.
  from_entra_id     text,
  from_user_id      integer REFERENCES public.users(id) ON DELETE SET NULL,
  from_display_name text,

  message_type      text NOT NULL DEFAULT 'message',

  -- DECISION 1. body_original is frozen at capture and is what evidence
  -- resolves to. body_current follows edits and is what the timeline renders.
  -- Both are the Graph HTML; body_text is the flattened form for search and
  -- previews, derived from body_current.
  body_original     text,
  body_current      text,
  body_text         text,
  content_type      text,

  -- Structured mention array as Graph returns it. Stored whole rather than
  -- flattened because it carries resolved user and tag ids — deterministic
  -- project matching, not a regex over free text, which is precisely what
  -- WhatsApp could never offer.
  mentions          jsonb,

  importance        text,
  has_attachments   boolean NOT NULL DEFAULT false,

  -- Teams' own timestamps. sent_at orders the timeline; captured_at records
  -- when we saw it, and the gap between them is how a delayed notification
  -- shows up in support.
  sent_at           timestamp with time zone NOT NULL,
  captured_at       timestamp with time zone NOT NULL DEFAULT now(),
  edited_at         timestamp with time zone,
  deleted_at        timestamp with time zone,

  -- Per-message attribution, for what thread inheritance does not cover.
  handover_id        integer REFERENCES public.sales_handovers(id) ON DELETE SET NULL,
  attribution_source text,
  moved_by           integer REFERENCES public.users(id) ON DELETE SET NULL,
  moved_at           timestamp with time zone,

  -- Exclusion, same vocabulary as whatsapp_messages. This — not Teams'
  -- delete — is how something is genuinely removed from the record.
  excluded_at       timestamp with time zone,
  excluded_by       integer REFERENCES public.users(id) ON DELETE SET NULL,
  exclude_reason    text,

  created_at        timestamp with time zone NOT NULL DEFAULT now(),
  updated_at        timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT msteams_messages_type_chk
    CHECK (message_type IN ('message', 'systemEventMessage', 'unknown')),

  CONSTRAINT msteams_messages_attribution_chk
    CHECK (attribution_source IS NULL OR attribution_source IN
           ('binding', 'thread_root', 'mention', 'subject', 'manual')),

  CONSTRAINT msteams_messages_attribution_shape_chk CHECK (
    (handover_id IS NULL AND attribution_source IS NULL)
    OR (handover_id IS NOT NULL AND attribution_source IS NOT NULL)
  ),

  -- An exclusion without a reason is an unexplained hole in an evidence trail.
  CONSTRAINT msteams_messages_exclude_shape_chk CHECK (
    (excluded_at IS NULL AND excluded_by IS NULL)
    OR (excluded_at IS NOT NULL AND excluded_by IS NOT NULL
        AND exclude_reason IS NOT NULL AND btrim(exclude_reason) <> '')
  )
);

-- Graph redelivers on retry and a failover can replay a window, so dedup is
-- required rather than defensive. Scoped to org because a Graph message id is
-- only unique within a tenant.
CREATE UNIQUE INDEX IF NOT EXISTS uq_msteams_messages_graph
  ON public.msteams_messages (org_id, graph_message_id);

CREATE INDEX IF NOT EXISTS idx_msteams_messages_thread
  ON public.msteams_messages (thread_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_msteams_messages_conversation
  ON public.msteams_messages (conversation_id, sent_at DESC);

-- The project Communications timeline's only query.
CREATE INDEX IF NOT EXISTS idx_msteams_messages_handover
  ON public.msteams_messages (org_id, handover_id, sent_at DESC)
  WHERE handover_id IS NOT NULL AND excluded_at IS NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_msteams_messages_unassigned
  ON public.msteams_messages (org_id, sent_at DESC)
  WHERE handover_id IS NULL AND excluded_at IS NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_msteams_messages_sender
  ON public.msteams_messages (org_id, from_entra_id);

COMMENT ON TABLE public.msteams_messages IS
  'Captured Teams messages. Both bodies are kept: body_original is frozen at capture and is what play evidence resolves to; body_current follows edits and is what the timeline renders. A Teams delete marks deleted_at and stops rendering but keeps the row, so evidence pointing at it still resolves.';

COMMENT ON COLUMN public.msteams_messages.body_original IS
  'The body as first captured, never updated. Same principle as 2026_124''s snapshot_* columns on play_evidence: what was ACCEPTED, not what it later became. Evidence resolves here.';

COMMENT ON COLUMN public.msteams_messages.body_current IS
  'Follows changeType=updated notifications. What the timeline renders, with an edited marker when edited_at is set.';

COMMENT ON COLUMN public.msteams_messages.deleted_at IS
  'Set on changeType=deleted. Stops timeline rendering; does NOT remove the row, because evidence referencing it must still resolve. Genuine removal is a human act via excluded_at.';

COMMENT ON COLUMN public.msteams_messages.mentions IS
  'Graph''s mentions array, stored whole. Carries resolved user and tag ids, which makes mention-based project matching deterministic rather than a regex over free text — the main attribution advantage Teams has over WhatsApp.';

COMMENT ON COLUMN public.msteams_messages.from_user_id IS
  'The resolved GoWarmCRM user, matched via from_entra_id. NULL for external participants, who are recorded and rendered but not linked.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. ATTACHMENTS — references, not bytes
--
-- A Teams attachment is a pointer into the sender's OneDrive or a SharePoint
-- site. Phase 1 stores the pointer and fetches nothing, which is why no
-- Files.Read scope is requested.
--
-- WHY NOT media_expires_at. WhatsApp needed it because Meta reaps media on a
-- schedule. Nobody reaps a customer's SharePoint. What replaces expiry is
-- UNREACHABILITY: the owner moves the file, revokes sharing, or leaves. That is
-- a state discovered on access, not a date known in advance.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.msteams_message_attachments (
  id                serial PRIMARY KEY,
  org_id            integer NOT NULL REFERENCES public.organizations(id)     ON DELETE CASCADE,
  message_id        integer NOT NULL REFERENCES public.msteams_messages(id)  ON DELETE CASCADE,

  graph_attachment_id text,
  attachment_type     text,
  file_name           text,
  mime_type           text,
  content_url         text,

  -- Snapshot columns, mirroring 2026_124. What we saw at capture, kept even
  -- after the live pointer stops resolving — a renamed file should not make an
  -- evidence trail unreadable.
  snapshot_file_name  text,
  snapshot_mime_type  text,
  snapshot_web_url    text,

  -- Populated only if bytes are ever copied. NULL throughout phase 1.
  storage_file_id     integer REFERENCES public.storage_files(id) ON DELETE SET NULL,

  media_status        text NOT NULL DEFAULT 'linked',
  last_checked_at     timestamp with time zone,

  removed_by          integer REFERENCES public.users(id) ON DELETE SET NULL,
  removed_at          timestamp with time zone,
  removed_reason      text,

  created_at          timestamp with time zone NOT NULL DEFAULT now(),
  updated_at          timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT msteams_attachments_status_chk
    CHECK (media_status IN ('linked', 'stored', 'unreachable', 'skipped', 'removed'))
);

CREATE INDEX IF NOT EXISTS idx_msteams_attachments_message
  ON public.msteams_message_attachments (message_id);

COMMENT ON TABLE public.msteams_message_attachments IS
  'Teams attachments as REFERENCES into OneDrive or SharePoint. Phase 1 stores the pointer and fetches no bytes, which is why config/teamsScopes.js deliberately does not request Files.Read.All.';

COMMENT ON COLUMN public.msteams_message_attachments.media_status IS
  'linked = we hold a reference and it last resolved. stored = bytes copied into storage_files (not phase 1). unreachable = the pointer stopped resolving — moved, unshared, or the owner left. This replaces WhatsApp''s ''expired'', which existed because Meta reaps media on a schedule; nobody reaps a customer''s SharePoint. skipped = deliberately not captured. removed = a human took it out.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. PARTICIPANTS
--
-- Time-bounded, per the access decision: chat membership is its own
-- entitlement. Somebody added last week must not thereby gain three months of
-- history, so joined_at and left_at bound what each person may read.
--
-- Simpler than the WhatsApp equivalent: there is no phone-verification dance,
-- because an Entra object id is a real identity and the rep's own token already
-- proves membership.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.msteams_conversation_participants (
  id                serial PRIMARY KEY,
  org_id            integer NOT NULL REFERENCES public.organizations(id)         ON DELETE CASCADE,
  conversation_id   integer NOT NULL REFERENCES public.msteams_conversations(id) ON DELETE CASCADE,

  entra_object_id   text NOT NULL,
  user_id           integer REFERENCES public.users(id) ON DELETE SET NULL,
  display_name      text,
  email             text,
  is_external       boolean NOT NULL DEFAULT false,

  joined_at         timestamp with time zone,
  left_at           timestamp with time zone,
  first_seen_at     timestamp with time zone NOT NULL DEFAULT now(),
  last_seen_at      timestamp with time zone NOT NULL DEFAULT now(),

  created_at        timestamp with time zone NOT NULL DEFAULT now(),
  updated_at        timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_msteams_participants
  ON public.msteams_conversation_participants (conversation_id, entra_object_id);

CREATE INDEX IF NOT EXISTS idx_msteams_participants_user
  ON public.msteams_conversation_participants (org_id, user_id)
  WHERE user_id IS NOT NULL;

COMMENT ON TABLE public.msteams_conversation_participants IS
  'Who is in each captured conversation, time-bounded. joined_at and left_at bound what a person may read: being added last week must not grant three months of history. is_external flags a guest or cross-tenant participant, who is recorded and rendered but never linked to a GoWarmCRM user.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 7. PLAY EVIDENCE — decision 3
--
-- The constraint widening only. The picker in ProjectPlayModals.js is phase 2.
-- Done now because altering a CHECK on a table already holding real rows, later,
-- buys nothing.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.play_evidence
  ADD COLUMN IF NOT EXISTS msteams_message_id integer
    REFERENCES public.msteams_messages(id) ON DELETE SET NULL;

ALTER TABLE public.play_evidence
  DROP CONSTRAINT IF EXISTS play_evidence_channel_chk;

ALTER TABLE public.play_evidence
  ADD CONSTRAINT play_evidence_channel_chk
  CHECK (channel = ANY (ARRAY['whatsapp'::text, 'email'::text, 'file'::text,
                              'manual'::text, 'teams'::text]));

-- Extends the existing shape rule rather than replacing its intent: a
-- channel-specific row must carry the id that channel is keyed on, or the
-- evidence points at nothing.
ALTER TABLE public.play_evidence
  DROP CONSTRAINT IF EXISTS play_evidence_source_shape_chk;

ALTER TABLE public.play_evidence
  ADD CONSTRAINT play_evidence_source_shape_chk CHECK (
        ((channel <> 'whatsapp'::text) OR (whatsapp_message_id IS NOT NULL))
    AND ((channel <> 'file'::text)     OR (storage_file_id     IS NOT NULL))
    AND ((channel <> 'teams'::text)    OR (msteams_message_id  IS NOT NULL))
  );

CREATE INDEX IF NOT EXISTS idx_play_evidence_msteams
  ON public.play_evidence (msteams_message_id)
  WHERE msteams_message_id IS NOT NULL;

COMMENT ON COLUMN public.play_evidence.msteams_message_id IS
  'The Teams message backing this evidence. Resolves to msteams_messages.body_original — the body frozen at capture — so a later edit in Teams cannot change what a play was built on.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 8. RLS
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.msteams_threads                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.msteams_messages                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.msteams_message_attachments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.msteams_conversation_participants  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS msteams_threads_org_isolation ON public.msteams_threads;
CREATE POLICY msteams_threads_org_isolation ON public.msteams_threads
  USING (org_id = current_setting('app.current_org_id', true)::integer);

DROP POLICY IF EXISTS msteams_messages_org_isolation ON public.msteams_messages;
CREATE POLICY msteams_messages_org_isolation ON public.msteams_messages
  USING (org_id = current_setting('app.current_org_id', true)::integer);

DROP POLICY IF EXISTS msteams_attachments_org_isolation ON public.msteams_message_attachments;
CREATE POLICY msteams_attachments_org_isolation ON public.msteams_message_attachments
  USING (org_id = current_setting('app.current_org_id', true)::integer);

DROP POLICY IF EXISTS msteams_participants_org_isolation ON public.msteams_conversation_participants;
CREATE POLICY msteams_participants_org_isolation ON public.msteams_conversation_participants
  USING (org_id = current_setting('app.current_org_id', true)::integer);

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK — NOT total. play_evidence and msteams_subscriptions were altered.
--
--   BEGIN;
--
--   -- play_evidence back to its 2026_124 shape
--   DELETE FROM public.play_evidence WHERE channel = 'teams';
--   ALTER TABLE public.play_evidence DROP CONSTRAINT IF EXISTS play_evidence_source_shape_chk;
--   ALTER TABLE public.play_evidence ADD CONSTRAINT play_evidence_source_shape_chk CHECK (
--         ((channel <> 'whatsapp'::text) OR (whatsapp_message_id IS NOT NULL))
--     AND ((channel <> 'file'::text)     OR (storage_file_id     IS NOT NULL)));
--   ALTER TABLE public.play_evidence DROP CONSTRAINT IF EXISTS play_evidence_channel_chk;
--   ALTER TABLE public.play_evidence ADD CONSTRAINT play_evidence_channel_chk
--     CHECK (channel = ANY (ARRAY['whatsapp'::text,'email'::text,'file'::text,'manual'::text]));
--   ALTER TABLE public.play_evidence DROP COLUMN IF EXISTS msteams_message_id;
--
--   -- capture tables
--   DROP TABLE IF EXISTS public.msteams_conversation_participants;
--   DROP TABLE IF EXISTS public.msteams_message_attachments;
--   DROP TABLE IF EXISTS public.msteams_messages;
--   DROP TABLE IF EXISTS public.msteams_threads;
--
--   -- msteams_subscriptions back to its 2026_125 shape
--   DROP INDEX IF EXISTS public.uq_msteams_subscription_resource;
--   DROP INDEX IF EXISTS public.idx_msteams_subscriptions_owner;
--   CREATE UNIQUE INDEX uq_msteams_subscription_conversation
--     ON public.msteams_subscriptions (conversation_id)
--     WHERE status IN ('active','expiring');
--   ALTER TABLE public.msteams_subscriptions
--     DROP COLUMN IF EXISTS last_failover_at,
--     DROP COLUMN IF EXISTS failover_count,
--     DROP COLUMN IF EXISTS failed_over_from,
--     DROP COLUMN IF EXISTS owner_connection_id,
--     DROP COLUMN IF EXISTS graph_id;
--
--   ALTER TABLE public.msteams_conversations
--     DROP COLUMN IF EXISTS last_message_at,
--     DROP COLUMN IF EXISTS message_count,
--     DROP COLUMN IF EXISTS capture_stopped_at,
--     DROP COLUMN IF EXISTS capture_started_at;
--
--   COMMIT;
--
-- DELETE any live Graph subscriptions BEFORE rolling back, or they will keep
-- posting to a webhook whose tables are gone. msteams_subscriptions is the only
-- record of what exists on Microsoft's side.
-- ─────────────────────────────────────────────────────────────────────────────
