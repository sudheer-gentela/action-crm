-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_98_whatsapp_message_handover.sql
--
-- Lets one person's WhatsApp conversation carry messages belonging to more than
-- one project.
--
-- THE CONSTRAINT THIS WORKS AROUND IS CORRECT AND STAYS
--   uq_wa_threads_direct is UNIQUE (org_id, wa_phone) WHERE kind = 'direct' —
--   one direct thread per person per org. That is not a limitation to remove:
--   it mirrors WhatsApp itself, where you cannot have two separate 1:1 chats
--   with the same number. There is one conversation with Sudheer, full stop.
--
--   But a person can be on several projects. Message them from project B and
--   the message necessarily lands on the single thread already owned by project
--   A — so it appeared under A and was invisible under B.
--
-- SAME SHAPE AS EMAIL, DELIBERATELY
--       email_threads : emails    ::    whatsapp_threads : whatsapp_messages
--
--   The THREAD says which project owns the conversation by default. The MESSAGE
--   says which project this particular message belongs to. A read matches
--   either, so a conversation appears in every project it actually touched
--   without any of them stealing it from the others.
--
-- Safe to run more than once.
-- NUMBERING: 97 = media_autocapture. This is 98.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE public.whatsapp_messages
  ADD COLUMN IF NOT EXISTS handover_id integer;

-- ON DELETE SET NULL, matching whatsapp_threads.handover_id, emails.handover_id
-- and storage_files.handover_id. A message outlives the project it was sent
-- for; deleting the project must not delete the conversation.
ALTER TABLE public.whatsapp_messages
  DROP CONSTRAINT IF EXISTS whatsapp_messages_handover_id_fkey;
ALTER TABLE public.whatsapp_messages
  ADD CONSTRAINT whatsapp_messages_handover_id_fkey
  FOREIGN KEY (handover_id) REFERENCES public.sales_handovers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_handover
  ON public.whatsapp_messages (handover_id) WHERE handover_id IS NOT NULL;

-- Back-fill from the thread. Every existing message belonged to whatever
-- project its conversation was on, so this preserves exactly what is on screen
-- today — nothing moves, nothing disappears. Idempotent: only fills NULLs.
UPDATE public.whatsapp_messages m
   SET handover_id = t.handover_id
  FROM public.whatsapp_threads t
 WHERE t.id = m.thread_id
   AND m.handover_id IS NULL
   AND t.handover_id IS NOT NULL;

COMMENT ON COLUMN public.whatsapp_messages.handover_id IS
  'The project THIS message belongs to. Set from the project it was sent from (outbound) or inherited from the thread (inbound). Distinct from whatsapp_threads.handover_id, which is the project that owns the conversation as a whole — one person has exactly one direct thread, but can be on several projects.';

COMMIT;
