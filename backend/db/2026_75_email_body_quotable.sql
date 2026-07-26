-- ═══════════════════════════════════════════════════════════════════════════
-- 2026_75_email_body_quotable.sql   (Q2)
--
-- SAFE TO DEPLOY ALONE. Purely additive and nullable; nothing reads it until the
-- firer change ships.
--
-- NUMBERING: 74 is taken by step_include_signature. This is 75.
--
-- ── What this is for ────────────────────────────────────────────────────────
--
-- Threaded replies currently set the RFC headers correctly — In-Reply-To is the
-- immediate parent and References accumulates the whole ancestry, so mail clients
-- group the conversation properly — but no quoted history appears in the body.
-- Gmail never adds any; Outlook's createReply returns a draft WITH native quoted
-- history and the firer then overwrites the body, explicitly dropping it.
--
-- To include quoted history we need the previous message's body. emails.body is
-- the obvious source and the WRONG one:
--
--   SequenceStepFirer.js
--     sendBodyHtml = await EmailTrackingService.decorateHtml(... stepLogId ...)
--     ... later ...
--     INSERT INTO emails (..., body, ...) VALUES (..., sendBodyHtml, ...)
--
-- sendBodyHtml is REASSIGNED by decorateHtml before the insert, so emails.body
-- contains that step's open-tracking pixel and rewritten click links. Quoting it
-- into a new email would re-embed both. Every open of email 4 would then fire a
-- false OPEN against steps 1-3, and any click on a quoted link a false CLICK —
-- silently corrupting the email funnel in reporting.
--
-- body_quotable therefore stores the body as it stood immediately BEFORE
-- decoration: signature included, tracking absent.
--
-- ── Why quoting only the parent is sufficient ───────────────────────────────
--
-- Each stored body_quotable already contains the quote block that was sent with
-- it. So quoting just the immediate parent reproduces the entire chain, exactly
-- as mail clients do it. One lookup per send, not one per ancestor.
--
-- Consequence worth knowing: bodies grow with each step, since step 4 embeds
-- step 3 which embeds step 2. Linear in total conversation length. Fine for the
-- 4-8 step sequences this is built for; worth a look if anyone builds a 20-step
-- sequence.
--
-- ── Nullable, and what that implies ─────────────────────────────────────────
--
-- Existing rows have NULL. An in-flight enrollment whose earlier sends predate
-- this column will produce its next reply with NO quote block — it cannot be
-- reconstructed, because the undecorated body was never stored. Threading still
-- works (the headers are intact); only the visible quote is missing, and only
-- until the next send stores a quotable body. No backfill is possible and none
-- is attempted.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- §0. PRE-FLIGHT — informational.
--
--   Query 1: how many live threaded enrollments will start their next reply
--            without a quote block, per the note above.
-- ───────────────────────────────────────────────────────────────────────────
-- SELECT count(*) AS threaded_enrollments_without_quotable_history
--   FROM sequence_enrollments se
--   JOIN sequences s ON s.id = se.sequence_id
--  WHERE s.thread_replies = TRUE
--    AND se.thread_conversation_id IS NOT NULL
--    AND se.status = 'active';


ALTER TABLE emails
  ADD COLUMN IF NOT EXISTS body_quotable text;

COMMENT ON COLUMN public.emails.body_quotable IS
  'The outbound HTML body as it stood immediately before EmailTrackingService '
  'decoration — signature included, tracking pixel and rewritten links absent. '
  'Source for the quoted-history block on threaded replies. Never send this '
  'directly; it is quote material only. NULL for rows written before 2026_75 and '
  'for inbound mail.';


-- Reply assembly looks up the newest sent message for a conversation. Partial
-- because only sent rows with a quotable body are ever candidates.
CREATE INDEX IF NOT EXISTS idx_emails_conversation_quotable
  ON emails (conversation_id, sent_at DESC)
  WHERE direction = 'sent' AND body_quotable IS NOT NULL;


-- ───────────────────────────────────────────────────────────────────────────
-- §1. VERIFY before COMMIT.
--
--   Query 1: column present, nullable.
--   Query 2: index present.
-- ───────────────────────────────────────────────────────────────────────────
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--  WHERE table_name = 'emails' AND column_name = 'body_quotable';
--
-- SELECT indexname FROM pg_indexes
--  WHERE tablename = 'emails' AND indexname = 'idx_emails_conversation_quotable';

COMMIT;
