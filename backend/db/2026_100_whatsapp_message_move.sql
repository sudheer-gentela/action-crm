-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_100_whatsapp_message_move.sql
--
-- Lets a person move a WhatsApp message to the right project by hand, and makes
-- that correction STICK for the replies that follow.
--
-- WHY A SECOND MIGRATION AND NOT AN EDIT TO 99
--   99 may already be applied. Shipped migrations are not rewritten.
--
-- WHY handover_tagged_at EXISTS
--   Inbound attribution compares two signals: the last outbound on the thread,
--   and the most recent manual correction. Comparing them needs the time the
--   MOVE happened, which is not sent_at — a rep moving yesterday's reply is
--   acting today. Without this column, a manual correction would sort behind
--   the outbound that caused the mistake and lose to it forever.
--
-- Mirrors emails.tagged_by / emails.tagged_at deliberately.
--
-- Safe to run more than once.
-- NUMBERING: 99 = whatsapp_message_attribution. This is 100.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Preflight: 100 is meaningless without 99's handover_source column.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'whatsapp_messages'
       AND column_name = 'handover_source'
  ) THEN
    RAISE EXCEPTION
      'whatsapp_messages.handover_source is missing — apply 2026_99_whatsapp_message_attribution.sql first';
  END IF;
END $$;

ALTER TABLE public.whatsapp_messages
  ADD COLUMN IF NOT EXISTS handover_tagged_by integer REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS handover_tagged_at timestamp with time zone;

-- 'manual_recent' joins the vocabulary: an inbound message that inherited its
-- project from a human's recent correction rather than from an outbound send.
ALTER TABLE public.whatsapp_messages
  DROP CONSTRAINT IF EXISTS wa_messages_handover_source_chk;
ALTER TABLE public.whatsapp_messages
  ADD CONSTRAINT wa_messages_handover_source_chk
  CHECK (handover_source IS NULL OR handover_source IN
         ('send', 'reply_context', 'recent_outbound', 'manual_recent', 'thread', 'manual'));

-- The resolver asks: what is the most recent manual correction on this thread?
CREATE INDEX IF NOT EXISTS idx_wa_messages_thread_manual
  ON public.whatsapp_messages (thread_id, handover_tagged_at DESC)
  WHERE handover_source = 'manual';

COMMENT ON COLUMN public.whatsapp_messages.handover_tagged_at IS
  'When a person last moved this message to a different project. Distinct from sent_at: moving yesterday''s reply is an action taken today, and inbound attribution compares this against the last outbound to decide which signal is fresher.';
COMMENT ON COLUMN public.whatsapp_messages.handover_tagged_by IS
  'Who moved this message. NULL for every message whose project was inferred rather than chosen.';

COMMIT;
