-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_127_msteams_message_shape.sql
--
-- DROP-IN LOCATION: backend/db/2026_127_msteams_message_shape.sql
--
-- Corrects msteams_messages against what a real tenant actually returns.
-- Requires 2026_126.
--
-- WHY THIS EXISTS
--   126's msteams_messages_type_chk allowed ('message','systemEventMessage',
--   'unknown'). Those are the values the Graph documentation describes. A probe
--   against the live pilot tenant returned something else entirely: every
--   system message — call started, call ended — arrived as
--
--       messageType: "unknownFutureValue"
--       from:        null
--       body:        <systemEventMessage/>
--       eventDetail: { "@odata.type": "#microsoft.graph.callEndedEventMessageDetail", ... }
--
--   The first such message would have failed the CHECK and aborted the ingest
--   transaction. Caught before writing the ingest service rather than after.
--
-- WHY THE CHECK IS DROPPED RATHER THAN WIDENED
--   Adding 'unknownFutureValue' to the list would fix today and break again.
--   The name is OData's explicit signal that the enum is OPEN — it is what a
--   client is sent when the server has a value the client's schema version does
--   not know. Constraining a column to an open enum means every future value
--   Microsoft adds becomes a production write failure, and a message we could
--   have stored is instead lost while a transaction rolls back. Store what
--   Graph says; classify separately.
--
-- WHY eventDetail AND NOT messageType IS THE DISCRIMINATOR
--   The reliable signal that a message is machinery rather than something a
--   person said is the PRESENCE of eventDetail, not any particular messageType
--   string. is_system_event is derived from that at ingest, and event_type
--   keeps the @odata.type so "what kind of system message" stays answerable
--   without reparsing a body.
--
--   These are excluded from the project timeline by default. A construction
--   handover does not need "call started" and "call ended" for every meeting a
--   rep attended — in the measured tenant that is 405 meeting chats' worth of
--   noise against 66 real conversations, and it would bury the commitments the
--   timeline exists to surface. They are STORED rather than dropped because a
--   call having happened at a particular time is occasionally the thing
--   somebody needs to prove.
--
-- NUMBERING: 126 = msteams_capture. This is 127.
--   psql "$DATABASE_URL" -f 2026_127_msteams_message_shape.sql
-- Safe to run more than once. No data transformation — msteams_messages is
-- empty, since nothing has captured yet.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'msteams_messages'
  ) THEN
    RAISE EXCEPTION 'apply 2026_126_msteams_capture.sql first';
  END IF;
END $$;


-- ── 1. Stop constraining an open enum ────────────────────────────────────────

ALTER TABLE public.msteams_messages
  DROP CONSTRAINT IF EXISTS msteams_messages_type_chk;

-- Replaced with a shape rule rather than a value list: it must be present and
-- non-blank, which catches a genuine mapping bug, without pretending to know
-- Microsoft's future vocabulary.
ALTER TABLE public.msteams_messages
  ADD CONSTRAINT msteams_messages_type_shape_chk
  CHECK (message_type IS NOT NULL AND btrim(message_type) <> '');

COMMENT ON COLUMN public.msteams_messages.message_type IS
  'Graph''s messageType, stored VERBATIM and deliberately unconstrained. The live tenant returns ''unknownFutureValue'' for call-started and call-ended messages — OData''s signal for an open enum — so a value list here would turn every future Microsoft addition into a failed write. Classify with is_system_event, not with this.';


-- ── 2. Classify system events ────────────────────────────────────────────────

ALTER TABLE public.msteams_messages
  ADD COLUMN IF NOT EXISTS is_system_event boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS event_type      text;

-- The timeline's index from 126 filtered on handover_id, excluded_at and
-- deleted_at. It now also has to exclude machinery, or every project view pays
-- to read call-started rows it will never render.
DROP INDEX IF EXISTS public.idx_msteams_messages_handover;

CREATE INDEX IF NOT EXISTS idx_msteams_messages_handover
  ON public.msteams_messages (org_id, handover_id, sent_at DESC)
  WHERE handover_id IS NOT NULL
    AND excluded_at IS NULL
    AND deleted_at  IS NULL
    AND is_system_event = false;

DROP INDEX IF EXISTS public.idx_msteams_messages_unassigned;

CREATE INDEX IF NOT EXISTS idx_msteams_messages_unassigned
  ON public.msteams_messages (org_id, sent_at DESC)
  WHERE handover_id IS NULL
    AND excluded_at IS NULL
    AND deleted_at  IS NULL
    AND is_system_event = false;

COMMENT ON COLUMN public.msteams_messages.is_system_event IS
  'True when Graph attached an eventDetail block — call started, member added, chat renamed. Derived from the PRESENCE of eventDetail rather than from messageType, which is an open enum and unreliable for this. Excluded from the project timeline by default: a handover does not need call-started for every meeting a rep attended.';

COMMENT ON COLUMN public.msteams_messages.event_type IS
  'The eventDetail @odata.type, e.g. #microsoft.graph.callEndedEventMessageDetail. Kept so "what kind of system message" is answerable without reparsing a body.';


-- ── 3. Sender is optional ────────────────────────────────────────────────────
--
-- 126 already made from_entra_id nullable, which turns out to be load-bearing
-- rather than defensive: the live tenant returns from: null on every system
-- message. Recorded here so the next reader knows it was verified, not assumed.

COMMENT ON COLUMN public.msteams_messages.from_entra_id IS
  'The sender''s Entra object id from chatMessage.from.user.id. NULL on system messages, where Graph sends from: null — confirmed against the live tenant, not assumed. For those, the actors are inside eventDetail instead.';


-- ── 4. Meeting chats ─────────────────────────────────────────────────────────
--
-- Not a schema change, a note. The measured tenant returned 475 chats of which
-- 405 were chatType 'meeting' — Teams creates one per call. They are stored
-- like anything else and msteams_conversations.kind already distinguishes them;
-- what changes is that triage and capture default to leaving them alone, since
-- ten-to-one noise makes the 66 real conversations unfindable. A rep can still
-- watch one deliberately.

COMMENT ON COLUMN public.msteams_conversations.kind IS
  'oneOnOne, group, meeting (auto-created per Teams call), or channel. Meeting chats dominate by volume — 405 of 475 in the measured pilot tenant — so triage hides them by default and capture ignores them unless somebody deliberately watches one. Graph''s chatType is an open enum; unrecognised values are mapped to ''group'' at ingest rather than failing the poll.';

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK:
--
--   BEGIN;
--   DROP INDEX IF EXISTS public.idx_msteams_messages_unassigned;
--   DROP INDEX IF EXISTS public.idx_msteams_messages_handover;
--   CREATE INDEX idx_msteams_messages_handover
--     ON public.msteams_messages (org_id, handover_id, sent_at DESC)
--     WHERE handover_id IS NOT NULL AND excluded_at IS NULL AND deleted_at IS NULL;
--   CREATE INDEX idx_msteams_messages_unassigned
--     ON public.msteams_messages (org_id, sent_at DESC)
--     WHERE handover_id IS NULL AND excluded_at IS NULL AND deleted_at IS NULL;
--   ALTER TABLE public.msteams_messages
--     DROP COLUMN IF EXISTS event_type,
--     DROP COLUMN IF EXISTS is_system_event;
--   ALTER TABLE public.msteams_messages DROP CONSTRAINT IF EXISTS msteams_messages_type_shape_chk;
--   ALTER TABLE public.msteams_messages ADD CONSTRAINT msteams_messages_type_chk
--     CHECK (message_type IN ('message','systemEventMessage','unknown'));
--   COMMIT;
--
-- Restoring the old CHECK will reject real Graph values. It is written out only
-- so the rollback is honest about returning to 126's exact shape.
-- ─────────────────────────────────────────────────────────────────────────────
