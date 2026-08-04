-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_99_whatsapp_message_attribution.sql
--
-- 98 gave a message its own project. It did not say HOW that project was
-- decided — and for an inbound message the answer was always "inherited from
-- the thread", which is wrong the moment a person is on two projects.
--
--   Project A messages Sudheer      → thread created, owned by A
--   Project B sends him a template  → message stamped B (98 did this)
--   Sudheer replies                 → stamped A, because the THREAD is A's
--
-- The reply belongs to whatever prompted it. These two columns let the service
-- record which signal it used, so a message on the wrong project can be
-- explained instead of guessed at:
--
--   reply_to_wa_message_id  the wamid the customer tapped Reply on, when Meta
--                           sends `context.id`. The authoritative signal.
--   handover_source         'reply_context' | 'recent_outbound' | 'thread'
--                           | 'send' | 'manual'
--
-- Same shape as emails.tag_source, deliberately.
--
-- Safe to run more than once.
-- NUMBERING: 98 = whatsapp_message_handover. This is 99.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Preflight: 99 is meaningless without 98's handover_id column.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'whatsapp_messages'
       AND column_name = 'handover_id'
  ) THEN
    RAISE EXCEPTION
      'whatsapp_messages.handover_id is missing — apply 2026_98_whatsapp_message_handover.sql first';
  END IF;
END $$;

ALTER TABLE public.whatsapp_messages
  ADD COLUMN IF NOT EXISTS handover_source        text,
  ADD COLUMN IF NOT EXISTS reply_to_wa_message_id text;

ALTER TABLE public.whatsapp_messages
  DROP CONSTRAINT IF EXISTS wa_messages_handover_source_chk;
ALTER TABLE public.whatsapp_messages
  ADD CONSTRAINT wa_messages_handover_source_chk
  CHECK (handover_source IS NULL OR handover_source IN
         ('send', 'reply_context', 'recent_outbound', 'thread', 'manual'));

-- Resolving a reply's project reads the thread's recent outbound messages.
CREATE INDEX IF NOT EXISTS idx_wa_messages_thread_outbound
  ON public.whatsapp_messages (thread_id, sent_at DESC)
  WHERE direction = 'outbound' AND handover_id IS NOT NULL;

-- Back-fill provenance for what already exists. Nothing MOVES: every existing
-- handover_id came from 98's back-fill off the thread, which is exactly what
-- 'thread' means. Outbound rows carry the project they were sent from.
UPDATE public.whatsapp_messages
   SET handover_source = CASE WHEN direction = 'outbound' THEN 'send' ELSE 'thread' END
 WHERE handover_source IS NULL AND handover_id IS NOT NULL;

COMMENT ON COLUMN public.whatsapp_messages.handover_source IS
  'How this message got its handover_id. send = stamped by the project it was sent from; reply_context = the customer replied to a specific message (Meta context.id); recent_outbound = inferred from the last outbound on this thread within 24h; thread = inherited from the conversation owner; manual = moved by a person.';
COMMENT ON COLUMN public.whatsapp_messages.reply_to_wa_message_id IS
  'wamid of the message this one replies to, from the webhook context object. Present only when the customer used Reply.';

COMMIT;
