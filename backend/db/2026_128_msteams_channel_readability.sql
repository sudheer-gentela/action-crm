-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_128_msteams_channel_readability.sql
--
-- DROP-IN LOCATION: backend/db/2026_128_msteams_channel_readability.sql
--
-- Records whether a discovered channel can actually be READ, not just listed.
-- Requires 2026_127.
--
-- WHY THIS EXISTS
--   Channel.ReadBasic.All lists every channel in a team the rep has joined.
--   ChannelMessage.Read.All reads the messages — but ONLY for channels the rep
--   is a member of, and a private channel carries its own membership separate
--   from the team's. Measured in the pilot tenant: 7 channels, 4 standard and 3
--   private, and all three private ones returned 403 Forbidden because the
--   signed-in user owns the team without being in those channels.
--
--   That is the delegated model working correctly — you see what you are in —
--   but it means discovery writes triage rows for channels that would capture
--   nothing if watched. Without this, a rep ticks a channel, a subscription
--   fails or silently returns nothing, and the failure looks like our bug
--   rather than a membership fact.
--
--   is_readable is therefore a THIRD state, not a boolean over is_watched:
--   NULL = never probed, true = a message read succeeded, false = 403. The UI
--   shows unreadable channels greyed with a reason rather than hiding them,
--   because "why is the Commercial channel missing" is a worse question than
--   "why is it greyed out" — one has an answer on screen.
--
-- SHARED CHANNELS
--   membershipType can also be 'shared', which is cross-tenant. Not seen in the
--   pilot tenant and not special-cased; it will simply probe like any other and
--   record what happens.
--
-- NUMBERING: 127 = msteams_message_shape. This is 128.
--   psql "$DATABASE_URL" -f 2026_128_msteams_channel_readability.sql
-- Safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'msteams_messages'
       AND column_name = 'is_system_event'
  ) THEN
    RAISE EXCEPTION 'apply 2026_127_msteams_message_shape.sql first';
  END IF;
END $$;

ALTER TABLE public.msteams_conversations
  ADD COLUMN IF NOT EXISTS membership_type        text,
  ADD COLUMN IF NOT EXISTS is_readable            boolean,
  ADD COLUMN IF NOT EXISTS readability_checked_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS readability_error      text;

-- Only channels have a membership type; chats are governed by their own
-- participant list and always readable by a participant.
ALTER TABLE public.msteams_conversations
  DROP CONSTRAINT IF EXISTS msteams_conversations_membership_chk;

ALTER TABLE public.msteams_conversations
  ADD CONSTRAINT msteams_conversations_membership_chk CHECK (
    membership_type IS NULL
    OR (kind = 'channel' AND membership_type IN ('standard', 'private', 'shared', 'unknown'))
  );

-- Triage's "what can I actually watch" query.
CREATE INDEX IF NOT EXISTS idx_msteams_conversations_readable
  ON public.msteams_conversations (org_id, connection_id, is_readable)
  WHERE kind = 'channel';

COMMENT ON COLUMN public.msteams_conversations.membership_type IS
  'Graph channel membershipType: standard, private, or shared. NULL for chats. Private channels have membership separate from the team, so a rep who owns a team can list a private channel and still be forbidden from reading it.';

COMMENT ON COLUMN public.msteams_conversations.is_readable IS
  'Three states, deliberately. NULL = never probed. true = a message read succeeded. false = 403, almost always because the rep is not a member of a private channel. Watching a false is refused up front rather than producing a subscription that captures nothing.';

COMMENT ON COLUMN public.msteams_conversations.readability_error IS
  'What the probe got back. Surfaced to the rep verbatim-ish, because the remedy — ask a channel owner to add you — is something only they can action.';

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK:
--   BEGIN;
--   DROP INDEX IF EXISTS public.idx_msteams_conversations_readable;
--   ALTER TABLE public.msteams_conversations
--     DROP CONSTRAINT IF EXISTS msteams_conversations_membership_chk;
--   ALTER TABLE public.msteams_conversations
--     DROP COLUMN IF EXISTS readability_error,
--     DROP COLUMN IF EXISTS readability_checked_at,
--     DROP COLUMN IF EXISTS is_readable,
--     DROP COLUMN IF EXISTS membership_type;
--   COMMIT;
-- ─────────────────────────────────────────────────────────────────────────────
