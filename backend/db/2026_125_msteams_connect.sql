-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_125_msteams_connect.sql
--
-- DROP-IN LOCATION: backend/db/2026_125_msteams_connect.sql
--
-- Microsoft Teams, phase 0: CONNECT and DISCOVER. Nothing is captured yet.
--
-- After this migration a rep can connect their Teams account, a discovery pass
-- lists the chats and channels they are in, and those appear in a triage list.
-- No message is read, stored, or subscribed to. Capture arrives in 2026_126.
--
-- WHY msteams_ AND NOT teams_
--   public.teams already exists and means SALES TEAM HIERARCHY, next to
--   team_memberships and team_dimensions. A table called teams_connections
--   would sort directly beside them and read as if it belonged to that family.
--   The prefix costs two characters and removes a whole class of future
--   misreading. Note this is a TABLE-name decision only: the channel VALUE
--   stays 'teams' in conversation_bindings.channel and in
--   messages.service.js's provider registry, both of which already hardcode it.
--
-- WHY A SEPARATE APP REGISTRATION (and therefore separate token rows)
--   config/microsoftScopes.js holds ONE scope list shared by Outlook, OneDrive
--   and calendar, and refreshMicrosoftToken() exists to survive that list
--   growing: ask for everything, and if consent is the objection, silently
--   retry with the originally granted set. Adding Teams scopes there would put
--   every already-connected user down the downgrade path — mail keeps working,
--   Teams never starts, and nothing surfaces why. Each rep would have to
--   reconnect OUTLOOK to fix TEAMS, which nobody would ever guess. Teams gets
--   its own registration (GoWarm Teams Integration), its own scopes module
--   (config/teamsScopes.js), and its own provider value in oauth_tokens.
--
-- WHY TOKENS ARE NOT IN THIS FILE
--   oauth_tokens is UNIQUE (user_id, provider). A new provider string is a
--   zero-schema-change insert, and it inherits refresh, revocation handling and
--   deleteUserTokens for free.
--
--   Known and deliberately not addressed here: oauth_tokens stores access and
--   refresh tokens as plaintext text, unlike whatsapp_session_auth's encrypted
--   triple. That is today's posture for Outlook and Google too. Changing it is
--   a migration about oauth_tokens, not a thing to fork for one provider.
--
-- CHATS AND CHANNELS IN ONE TABLE
--   They differ in how they are addressed — a chat has one id, a channel needs
--   a team id AND a channel id — and in nothing else that matters here. Both
--   are triaged, bound and subscribed to identically. Two tables would mean two
--   triage queries, two binding paths and two subscription registries to keep
--   in step. One table with a `kind` discriminator costs one CHECK.
--
-- BINDING STATUS ARRIVES COMPLETE
--   2026_101 shipped three values and 2026_108 widened it to five. This starts
--   at five. There is no legacy row to protect.
--
-- NUMBERING: 124 = evidence_and_note_attachments. This is 125.
-- Run AFTER 2026_124.
--   psql "$DATABASE_URL" -f 2026_125_msteams_connect.sql
-- Safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Preflight: conversation_bindings must exist and already accept 'teams'.
-- Everything downstream binds through it, and discovering that at bind time
-- rather than at migrate time means a triage screen listing conversations
-- nobody can act on.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'conversation_bindings'
  ) THEN
    RAISE EXCEPTION
      'conversation_bindings is missing — apply 2026_108_conversation_bindings.sql first';
  END IF;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. CONNECTIONS
--
-- One row per (org, user) who has connected Teams. Per-user and not per-org,
-- unlike whatsapp_sessions: WhatsApp observes with ONE number sitting in
-- groups, Teams reads AS the signed-in person and sees exactly what that person
-- sees. That is the entire privacy argument for the delegated design, and it
-- only holds if the connection is per-rep.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.msteams_connections (
  id                serial PRIMARY KEY,
  org_id            integer NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id           integer NOT NULL REFERENCES public.users(id)         ON DELETE CASCADE,

  -- Entra identity, learned from /me at connect time.
  --
  -- entra_object_id is the load-bearing one: chatMessage.from.user.id carries
  -- the same value on every inbound message, so it turns "who sent this" into a
  -- GoWarmCRM user without matching on display names. UPN is for humans reading
  -- the admin screen, and for the case where an object id changes because
  -- somebody was deleted and recreated.
  entra_tenant_id   text,
  entra_object_id   text,
  entra_upn         text,
  display_name      text,

  status            text NOT NULL DEFAULT 'connected',
  status_detail     text,

  -- Distinct from status. A rep may stay connected — identity intact, token
  -- refreshing — while capture is paused, during a customer freeze window or
  -- while an admin works out what should be watched. Folding the two would make
  -- "pause capture" mean "disconnect and re-consent".
  capture_enabled   boolean NOT NULL DEFAULT true,

  -- Discovery is a POLL, not a push: nothing tells us a rep was added to a
  -- channel. This is when we last enumerated /me/chats and /me/joinedTeams.
  -- Staleness here is the signal that triage is showing an incomplete list.
  last_discovery_at        timestamp with time zone,
  last_discovery_error     text,
  discovered_chat_count    integer NOT NULL DEFAULT 0,
  discovered_channel_count integer NOT NULL DEFAULT 0,

  connected_at      timestamp with time zone NOT NULL DEFAULT now(),
  disconnected_at   timestamp with time zone,
  created_at        timestamp with time zone NOT NULL DEFAULT now(),
  updated_at        timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT msteams_connections_status_chk
    CHECK (status IN ('connected', 'consent_required', 'token_expired',
                      'revoked', 'disconnected')),

  -- One connection per person. Two rows would mean two discovery passes writing
  -- the same conversations and, once 126 lands, two subscription attempts on
  -- the same chat — which Graph refuses anyway: one subscription per app-and-
  -- chat combination.
  CONSTRAINT uq_msteams_connection_user UNIQUE (org_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_msteams_connections_stale
  ON public.msteams_connections (org_id, last_discovery_at)
  WHERE status = 'connected' AND capture_enabled = true;

CREATE INDEX IF NOT EXISTS idx_msteams_connections_entra
  ON public.msteams_connections (org_id, entra_object_id)
  WHERE entra_object_id IS NOT NULL;

COMMENT ON TABLE public.msteams_connections IS
  'A rep who has connected Microsoft Teams via delegated OAuth. Read-only by design: no send-side columns. Access and refresh tokens live in oauth_tokens under provider ''teams''; this table holds Entra identity, discovery state and the capture switch.';

COMMENT ON COLUMN public.msteams_connections.entra_object_id IS
  'The signed-in user''s Entra object id from /me. chatMessage.from.user.id carries the same value on every message, so this is how a sender resolves to a GoWarmCRM user without name matching. Nullable only between row creation and the first /me call.';

COMMENT ON COLUMN public.msteams_connections.status IS
  'connected = token refreshing normally. consent_required = a scope was added or withdrawn at the tenant and the user must re-approve. token_expired = refresh failed but not identifiably revoked; retryable. revoked = access withdrawn, needs fresh consent. disconnected = the user or an admin switched it off here.';

COMMENT ON COLUMN public.msteams_connections.capture_enabled IS
  'Pauses capture without tearing down the connection. Deliberately separate from status so a freeze window does not cost a re-consent.';

COMMENT ON COLUMN public.msteams_connections.last_discovery_at IS
  'Teams membership changes silently — nothing notifies us that a rep joined a channel. Discovery is a poll, and the age of this column is how the UI knows the triage list may be incomplete.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. CONVERSATIONS (the triage list)
--
-- Sibling of whatsapp_session_groups. A row appears here because DISCOVERY saw
-- it, not because anybody said anything — the opposite of WhatsApp, where a
-- group became known by being noisy. That difference is worth the extra poll: a
-- rep triaging on day one sees their real list rather than whichever chats
-- happened to be busy that morning.
--
-- Nothing here is captured. is_watched exists in phase 0 so the triage decision
-- can be made and stored before there is machinery to act on it; 126 reads it
-- to decide what to subscribe to.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.msteams_conversations (
  id                serial PRIMARY KEY,
  org_id            integer NOT NULL REFERENCES public.organizations(id)        ON DELETE CASCADE,
  connection_id     integer NOT NULL REFERENCES public.msteams_connections(id)  ON DELETE CASCADE,

  kind              text NOT NULL,

  -- Graph identifiers, as text, exactly as Graph returns them.
  --
  -- graph_id is the chat id ('19:...@unq.gbl.spaces') for a chat, or the
  -- CHANNEL id ('19:...@thread.tacv2') for a channel. team_id is the owning
  -- team and is NULL for chats. Both are needed to address a channel:
  -- /teams/{team_id}/channels/{graph_id}/messages.
  --
  -- graph_id is also what goes into conversation_bindings.thread_ref, which is
  -- why it is text and never a local integer — see that table's header.
  graph_id          text NOT NULL,
  team_id           text,

  -- topic is a chat's optional name; a group chat frequently has none, in which
  -- case the UI falls back to member names. display_name is what discovery
  -- resolved for the list, computed once rather than on every triage render.
  topic             text,
  display_name      text,
  team_name         text,
  member_count      integer,
  web_url           text,

  -- Triage. Mirrors whatsapp_session_groups so the existing screen's logic
  -- transfers, but arrives with all five binding_status values.
  is_watched        boolean NOT NULL DEFAULT false,
  binding_status    text    NOT NULL DEFAULT 'unbound',
  watched_by        integer REFERENCES public.users(id) ON DELETE SET NULL,
  watched_at        timestamp with time zone,
  bound_by          integer REFERENCES public.users(id) ON DELETE SET NULL,
  bound_at          timestamp with time zone,

  first_seen_at      timestamp with time zone NOT NULL DEFAULT now(),
  last_discovered_at timestamp with time zone NOT NULL DEFAULT now(),

  -- Graph's own last-activity stamp, not ours. Sorting triage by "when did
  -- anything happen here" is the difference between a usable list and 400 rows
  -- in creation order — and we have no message timestamps of our own until 126.
  last_activity_at  timestamp with time zone,

  created_at        timestamp with time zone NOT NULL DEFAULT now(),
  updated_at        timestamp with time zone NOT NULL DEFAULT now(),

  -- Graph's chatType enum is open — it documents an unknownFutureValue member —
  -- so the discovery service maps anything unrecognised to 'group' rather than
  -- letting a new Microsoft enum value fail the whole poll at the database.
  CONSTRAINT msteams_conversations_kind_chk
    CHECK (kind IN ('oneOnOne', 'group', 'meeting', 'channel')),

  CONSTRAINT msteams_conversations_binding_chk
    CHECK (binding_status IN ('unbound', 'bound', 'bound_account', 'bound_pool', 'ignored')),

  -- A channel needs its team; a chat must not carry one. Getting this wrong
  -- produces a subscription URL that fails at RENEWAL rather than at creation,
  -- which is the expensive place to find out.
  CONSTRAINT msteams_conversations_shape_chk CHECK (
       (kind =  'channel' AND team_id IS NOT NULL)
    OR (kind <> 'channel' AND team_id IS NULL)
  ),

  -- Same invariant as 2026_106's decided-check: an unwatched conversation is
  -- one nobody has ruled on, so it may only sit in a state meaning "undecided"
  -- or "explicitly dismissed".
  CONSTRAINT msteams_conversations_decided_chk
    CHECK (is_watched = true OR binding_status IN ('unbound', 'ignored'))
);

-- Two reps in the same channel each get a row. That is correct, not
-- duplication: watching is a per-rep decision and their tokens differ. Graph
-- allows one subscription per app-and-chat combination, so 126 picks ONE
-- connection to subscribe through; deduplication for display happens on read.
CREATE UNIQUE INDEX IF NOT EXISTS uq_msteams_conversations_graph
  ON public.msteams_conversations (connection_id, graph_id);

CREATE INDEX IF NOT EXISTS idx_msteams_conversations_triage
  ON public.msteams_conversations (org_id, binding_status, last_activity_at DESC);

CREATE INDEX IF NOT EXISTS idx_msteams_conversations_watched
  ON public.msteams_conversations (org_id, is_watched)
  WHERE is_watched = true;

-- 126 resolves an inbound notification back to a row by graph_id alone; the
-- notification does not say which connection it arrived through.
CREATE INDEX IF NOT EXISTS idx_msteams_conversations_graph_lookup
  ON public.msteams_conversations (org_id, graph_id);

COMMENT ON TABLE public.msteams_conversations IS
  'Chats and channels a connected rep belongs to, as found by discovery. One row per (connection, conversation) — two reps in the same channel is two rows, because watching is a per-rep decision. Phase 0 WRITES this table and captures nothing; 2026_126 reads is_watched to decide what to subscribe to.';

COMMENT ON COLUMN public.msteams_conversations.graph_id IS
  'The chat id for a chat, or the channel id for a channel — as Graph returns it, never a local id. This is the value that goes into conversation_bindings.thread_ref.';

COMMENT ON COLUMN public.msteams_conversations.team_id IS
  'The team owning a channel. NULL for chats. Required for channels because addressing one takes both ids: /teams/{team_id}/channels/{graph_id}/messages.';

COMMENT ON COLUMN public.msteams_conversations.binding_status IS
  'unbound = discovered, nobody has said how this is organised (shows in triage). bound = one project; messages inherit it. bound_account = organised around a vendor/partner. bound_pool = several declared projects. ignored = a human said this is not project traffic. Same vocabulary as whatsapp_session_groups so one triage component serves both channels.';

COMMENT ON COLUMN public.msteams_conversations.last_activity_at IS
  'Graph''s own last-activity stamp for the conversation, not ours. It is the only ordering signal triage has before capture exists.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. SUBSCRIPTIONS
--
-- Created EMPTY. 2026_126 writes it. It lives here because a subscription is a
-- property of the connection, and dropping this migration should take the whole
-- connect story with it rather than leave an orphan registry behind.
--
-- WHY MIRROR GRAPH'S STATE AT ALL
--   Graph is the source of truth and we could list from it. We do not, for two
--   reasons. Listing costs a call per connection on every renewal sweep. And a
--   subscription Graph has silently dropped is INVISIBLE in a list — you learn
--   about it by noticing messages stopped arriving. A local row with an expiry
--   we own turns that into a query.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.msteams_subscriptions (
  id                serial PRIMARY KEY,
  org_id            integer NOT NULL REFERENCES public.organizations(id)          ON DELETE CASCADE,
  connection_id     integer NOT NULL REFERENCES public.msteams_connections(id)    ON DELETE CASCADE,
  conversation_id   integer NOT NULL REFERENCES public.msteams_conversations(id)  ON DELETE CASCADE,

  -- Graph's subscription id, and the resource path we asked about. The path is
  -- STORED rather than rebuilt from the conversation row: if a channel is later
  -- moved between teams, the subscription that must be DELETED is the one at
  -- the old path, and a rebuilt path would silently leak it.
  subscription_id   text NOT NULL,
  resource_path     text NOT NULL,

  -- Sent on creation, echoed back on every notification. A notification whose
  -- clientState does not match is discarded — this is the only thing standing
  -- between the webhook and anyone who learns the URL.
  client_state      text NOT NULL,

  expires_at        timestamp with time zone NOT NULL,
  last_renewed_at   timestamp with time zone,
  renewal_failures  integer NOT NULL DEFAULT 0,
  last_error        text,

  status            text NOT NULL DEFAULT 'active',

  created_at        timestamp with time zone NOT NULL DEFAULT now(),
  updated_at        timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT msteams_subscriptions_status_chk
    CHECK (status IN ('active', 'expiring', 'expired', 'failed', 'deleted')),

  CONSTRAINT uq_msteams_subscription_graph UNIQUE (subscription_id)
);

-- Graph enforces one subscription per app-and-conversation combination. Enforce
-- it here too, so a double-click on "watch" fails locally instead of burning a
-- rejected Graph call and leaving a half-written row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_msteams_subscription_conversation
  ON public.msteams_subscriptions (conversation_id)
  WHERE status IN ('active', 'expiring');

-- The renewal sweep's only query: what expires soonest.
CREATE INDEX IF NOT EXISTS idx_msteams_subscriptions_renewal
  ON public.msteams_subscriptions (expires_at)
  WHERE status IN ('active', 'expiring');

COMMENT ON TABLE public.msteams_subscriptions IS
  'Graph change-notification subscriptions, one per watched conversation. Created empty by 2026_125; written by 2026_126. Mirrored locally rather than listed from Graph because a silently dropped subscription does not appear in a list — you find it by noticing messages stopped.';

COMMENT ON COLUMN public.msteams_subscriptions.resource_path IS
  'The resource we subscribed to, stored rather than rebuilt. If a channel moves between teams, the subscription to DELETE is the one at the OLD path; a rebuilt path would leak it.';

COMMENT ON COLUMN public.msteams_subscriptions.client_state IS
  'Secret echoed by Graph on every notification. A notification that does not match it is discarded — the only thing protecting the webhook from anyone who learns the URL.';

COMMENT ON COLUMN public.msteams_subscriptions.status IS
  'active = live. expiring = inside the renewal window, the sweep will extend it. expired = lapsed, needs recreating not renewing. failed = renewal_failures exhausted, a human should look. deleted = torn down on unwatch, kept briefly for audit.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RLS
--
-- Same org-scoped policy shape as 2026_101/104/105/108, so these are not the
-- one hole in the tenant boundary.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.msteams_connections    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.msteams_conversations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.msteams_subscriptions  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS msteams_connections_org_isolation ON public.msteams_connections;
CREATE POLICY msteams_connections_org_isolation ON public.msteams_connections
  USING (org_id = current_setting('app.current_org_id', true)::integer);

DROP POLICY IF EXISTS msteams_conversations_org_isolation ON public.msteams_conversations;
CREATE POLICY msteams_conversations_org_isolation ON public.msteams_conversations
  USING (org_id = current_setting('app.current_org_id', true)::integer);

DROP POLICY IF EXISTS msteams_subscriptions_org_isolation ON public.msteams_subscriptions;
CREATE POLICY msteams_subscriptions_org_isolation ON public.msteams_subscriptions
  USING (org_id = current_setting('app.current_org_id', true)::integer);

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (total — nothing existing was altered or transformed):
--
--   BEGIN;
--   DROP TABLE IF EXISTS public.msteams_subscriptions;
--   DROP TABLE IF EXISTS public.msteams_conversations;
--   DROP TABLE IF EXISTS public.msteams_connections;
--   DELETE FROM public.oauth_tokens WHERE provider = 'teams';
--   COMMIT;
--
-- The oauth_tokens delete is only needed if anyone actually connected. No
-- existing table gained a column, a constraint or a policy here, so there is
-- nothing else to undo.
-- ─────────────────────────────────────────────────────────────────────────────
