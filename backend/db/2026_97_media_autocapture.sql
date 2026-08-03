-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_97_media_autocapture.sql
--
-- Two changes, both consequences of one decision: capture automatically rather
-- than asking first.
--
-- WHY AUTOMATIC IS THE RIGHT DEFAULT HERE
--   The number is registered to the WhatsApp Business Cloud API, which means it
--   CANNOT also be used in the consumer or Business app. There is no inbox
--   anywhere for it — the webhook is the only delivery. If GoWarm does not
--   fetch an attachment, nobody on the team can obtain it by any route.
--
--   (A human participant in the group still has it on their own phone, so a
--   manual re-upload is always possible as a backstop. But that depends on
--   somebody noticing and remembering, which is not a mechanism.)
--
--   Combined with Meta's ~30-day retention, asking before fetching means an
--   unanswered prompt is a permanently lost file. So capture happens on
--   arrival, and the team curates afterwards — Remove deletes the file from the
--   customer's storage, which is a real undo rather than a hope.
--
-- Safe to run more than once.
-- REQUIRES: 2026_95 and 2026_96.
-- NUMBERING: 96 = media_capture_mode. This is 97.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 0. Preflight ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'sales_handovers'
       AND column_name = 'media_capture_mode'
  ) THEN
    RAISE EXCEPTION
      'Migration 2026_96_media_capture_mode.sql has not been applied. Run 2026_95 then 2026_96, then re-run this file.'
      USING HINT = 'psql $DATABASE_URL -f backend/db/2026_96_media_capture_mode.sql';
  END IF;
END $$;

-- ── 1. Automatic capture becomes the default ─────────────────────────────────

ALTER TABLE public.sales_handovers
  ALTER COLUMN media_capture_mode SET DEFAULT 'always';

-- One-time normalisation of rows created under the previous default. Guarded on
-- the feature never having been used: if anyone has already answered a
-- Keep/Remove prompt, an explicit 'ask' is a real preference and must not be
-- overwritten by a default change.
UPDATE public.sales_handovers h
   SET media_capture_mode = 'always'
 WHERE h.media_capture_mode = 'ask'
   AND NOT EXISTS (
     SELECT 1 FROM public.whatsapp_messages m
      WHERE m.org_id = h.org_id AND m.media_reviewed_at IS NOT NULL
   );

COMMENT ON COLUMN public.sales_handovers.media_capture_mode IS
  'always (default) = capture on arrival, no prompt; the team can still Remove. ask = capture, then prompt to Keep/Remove. never = do not capture; the message is marked skipped and stays visible so nothing is lost quietly. Capture is automatic by default because a Cloud API number has no app inbox — an attachment GoWarm does not fetch is unreachable by anyone.';

-- ── 2. Media identity, so a failed fetch can be retried ──────────────────────
--
-- The webhook payload is the ONLY place these appear, and ingestWebhook
-- currently discards the whole media object — it writes the literal string
-- '[document]' and drops m.document.id with it. Once the webhook is processed
-- the file is unreachable.
--
-- wa_media_id is the important one: Meta's download URL expires in minutes, but
-- the ID stays valid for the full ~30-day retention and can be exchanged for a
-- fresh URL at any point. That is what makes a retry possible at all — without
-- it, one failed upload is a permanent loss rather than something a job can
-- pick up ten minutes later.

ALTER TABLE public.whatsapp_messages
  ADD COLUMN IF NOT EXISTS wa_media_id     text,
  ADD COLUMN IF NOT EXISTS media_filename  text,
  ADD COLUMN IF NOT EXISTS media_caption   text,
  ADD COLUMN IF NOT EXISTS media_expires_at timestamp with time zone;

COMMENT ON COLUMN public.whatsapp_messages.wa_media_id IS
  'Meta media id from the inbound webhook. Exchange for a short-lived download URL. Valid for roughly 30 days, which is the whole retry window — after that the file is gone from Meta and cannot be recovered.';
COMMENT ON COLUMN public.whatsapp_messages.media_expires_at IS
  'Best-effort estimate of when Meta will drop the media, set at ingest. Drives the "expiring soon, still not stored" sweep so a stuck upload surfaces before the file is unrecoverable rather than after.';

-- The sweep: still fetchable, not yet stored. Ordered by urgency.
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_media_recoverable
  ON public.whatsapp_messages (media_expires_at)
  WHERE wa_media_id IS NOT NULL AND media_status IN ('pending', 'failed');

COMMIT;
