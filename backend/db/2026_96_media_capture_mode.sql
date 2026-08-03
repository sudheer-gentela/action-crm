-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_96_media_capture_mode.sql
--
-- Per-project control over what happens to an inbound WhatsApp attachment.
--
-- CAPTURE FIRST, CONFIRM AFTER — and the ordering is forced, not chosen.
--   Meta's media download URL is valid for minutes and the media itself for
--   about 30 days. "Prompt the user, then fetch if they agree" means a prompt
--   left unanswered over a weekend is a permanently lost attachment. So the
--   bytes are fetched and written to the configured folder at ingest, and the
--   confirmation that follows is about CURATION — does this belong in the
--   project folder — not about permission to write.
--
--   Permission was already given: an admin connected a storage account and
--   marked a folder as the upload target. Nothing is written to a customer's
--   storage before both of those happen.
--
--   'Remove' is a real undo, not a hope: GoWarm created the file, so it can
--   delete it from the customer's storage. That is why capture-first is safe
--   here in a way it would not be if we could only ask.
--
-- Safe to run more than once.
-- NUMBERING: 95 = org_storage_accounts. This is 96.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. Per-project capture mode ──────────────────────────────────────────────
--
-- Per PROJECT, not per thread: the upload target is per project, and a project
-- with three WhatsApp groups should not need the same answer three times.
--
-- Defaults to 'ask' so the first attachment on any project surfaces a decision
-- rather than silently writing. Choosing "Always store for this project" flips
-- it to 'always' — the one-time configuration, after which capture is quiet.

ALTER TABLE public.sales_handovers
  ADD COLUMN IF NOT EXISTS media_capture_mode text NOT NULL DEFAULT 'ask';

ALTER TABLE public.sales_handovers
  DROP CONSTRAINT IF EXISTS sales_handovers_media_capture_mode_chk;
ALTER TABLE public.sales_handovers
  ADD CONSTRAINT sales_handovers_media_capture_mode_chk
  CHECK (media_capture_mode IN ('ask', 'always', 'never'));

COMMENT ON COLUMN public.sales_handovers.media_capture_mode IS
  'ask = capture, then prompt to Keep/Remove on the message. always = capture silently. never = do not capture; the attachment is marked skipped and stays visible so nothing is lost quietly. Inherits from organizations.settings->project_access->media_capture_mode when the project is created.';

-- ── 2. 'removed' — deliberately taken out, not failed ────────────────────────
--
-- Without this, a file the team chose to remove is indistinguishable from one
-- that failed to store, so it would either sit in the retry queue forever or be
-- reported as an error. Two different facts need two different words.

ALTER TABLE public.whatsapp_messages
  DROP CONSTRAINT IF EXISTS whatsapp_messages_media_status_chk;
ALTER TABLE public.whatsapp_messages
  ADD CONSTRAINT whatsapp_messages_media_status_chk
  CHECK (media_status IS NULL
      OR media_status IN ('pending', 'stored', 'failed', 'expired', 'skipped', 'removed'));

ALTER TABLE public.whatsapp_messages
  ADD COLUMN IF NOT EXISTS media_reviewed_by integer REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS media_reviewed_at timestamp with time zone;

COMMENT ON COLUMN public.whatsapp_messages.media_status IS
  'pending = accepted, not yet fetched. stored = in the customer''s storage, see storage_file_id. failed = retryable. expired = Meta no longer has it, permanent loss. skipped = no storage configured, or capture is off. removed = stored, then deliberately deleted from the customer''s storage by a project member.';
COMMENT ON COLUMN public.whatsapp_messages.media_reviewed_by IS
  'Who answered the Keep/Remove prompt. Absent while the answer is still outstanding, which is how the UI knows to keep asking.';

-- The prompt queue: stored but nobody has answered yet. Distinct from the retry
-- queue, which is about failures.
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_media_unreviewed
  ON public.whatsapp_messages (org_id, media_status)
  WHERE media_status = 'stored' AND media_reviewed_at IS NULL;

COMMIT;
