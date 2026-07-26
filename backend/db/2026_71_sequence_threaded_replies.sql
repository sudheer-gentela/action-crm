-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_71_sequence_threaded_replies.sql
--
-- Threaded-reply sequences (design agreed 2026-07). When a sequence opts in,
-- every email step after the first is sent as a REPLY into the same thread as
-- the enrollment's first email — same subject, provider In-Reply-To/References
-- carried forward — instead of a fresh standalone email.
--
-- Two hard invariants that this schema supports:
--
--   1. SUBJECT REUSE. Threading only holds if follow-ups reuse the root
--      subject (Gmail nests on subject match; Outlook's reply forces it). The
--      per-step subject is therefore ignored for steps 2+ in threaded mode.
--      thread_subject_mode chooses whether the wire subject is the root subject
--      verbatim ('keep') or 'Re: '-prefixed ('re').
--
--   2. SENDER PINNING. A reply must come from the SAME mailbox that sent the
--      root, so a threaded enrollment is pinned to one sender for its whole
--      life — the firer stops rotating it. pin_sender exposes the same "one
--      mailbox, no rotation" behaviour as a STANDALONE toggle (rotation off,
--      even without threading); when thread_replies is true, pinning is forced
--      on regardless of pin_sender and the UI shows it uneditable.
--
-- FAILOVER. thread_failover_mode governs what happens when the pinned sender
-- can't send (revoked token, or at daily cap):
--   * 'defer'  → PAUSE the enrollment on the first failure, notify the owner
--                immediately, then a daily digest until resolved. No grace
--                window (the earlier "N days" idea was dropped — pause first).
--   * 'break'  → do NOT pause; fail over to another eligible sender and let the
--                server-side thread reset (recipient-side continuity is still
--                preserved via subject + References).
--
-- STORAGE / SCALE. The thread anchor is cached on sequence_enrollments (not
-- rebuilt per send) because the firer's claim query already SELECTs se.* — so
-- reading the anchor costs ZERO extra queries at any firer volume, and the
-- write folds into the post-send UPDATE the firer already performs. emails
-- gains no columns: conversation_id + external_id + external_data carry the
-- provider ids (the "separate change, flagged not smuggled" noted in
-- routes/sequences.routes.js). Long Outlook Graph ids live in external_data
-- (jsonb) to sidestep the external_id varchar(255) ceiling.
--
-- Additive and idempotent — safe to run more than once. No data migration:
-- existing sequences default to thread_replies=false and behave byte-identically.
--
-- Rollback:
--   ALTER TABLE sequences            DROP COLUMN IF EXISTS thread_replies,
--                                    DROP COLUMN IF EXISTS pin_sender,
--                                    DROP COLUMN IF EXISTS thread_subject_mode,
--                                    DROP COLUMN IF EXISTS thread_failover_mode;
--   ALTER TABLE sequence_enrollments DROP COLUMN IF EXISTS pinned_sender_account_id,
--                                    DROP COLUMN IF EXISTS thread_conversation_id,
--                                    DROP COLUMN IF EXISTS thread_root_subject,
--                                    DROP COLUMN IF EXISTS thread_last_message_id,
--                                    DROP COLUMN IF EXISTS thread_references;
--   DROP INDEX IF EXISTS idx_seq_enroll_thread_paused;
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── sequences: per-sequence configuration ───────────────────────────────────
ALTER TABLE public.sequences
  ADD COLUMN IF NOT EXISTS thread_replies       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pin_sender           boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS thread_subject_mode  text    NOT NULL DEFAULT 'keep',
  ADD COLUMN IF NOT EXISTS thread_failover_mode text    NOT NULL DEFAULT 'defer';

-- CHECK constraints added guarded (re-run safe — mirrors 2026_42's pattern).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_seq_thread_subject_mode') THEN
    ALTER TABLE public.sequences
      ADD CONSTRAINT chk_seq_thread_subject_mode
      CHECK (thread_subject_mode = ANY (ARRAY['keep'::text, 're'::text]));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_seq_thread_failover_mode') THEN
    ALTER TABLE public.sequences
      ADD CONSTRAINT chk_seq_thread_failover_mode
      CHECK (thread_failover_mode = ANY (ARRAY['defer'::text, 'break'::text]));
  END IF;
END $$;

COMMENT ON COLUMN public.sequences.thread_replies IS
  'When true, email steps after the first are sent as replies into the enrollment''s first-email thread (subject reused, In-Reply-To/References carried). Forces sender pinning on. Opt-in per sequence; default false = today''s standalone sends.';
COMMENT ON COLUMN public.sequences.pin_sender IS
  'Standalone "pin to one mailbox, stop rotation" toggle. Independent of threading, but threading forces pinning on regardless of this flag. v1 pins to whichever sender sends the enrollment''s first email; a named-mailbox selection can layer on later.';
COMMENT ON COLUMN public.sequences.thread_subject_mode IS
  'keep = reply uses the root subject verbatim; re = root subject prefixed with "Re: " (only if not already present). Applies to steps 2+ in threaded mode.';
COMMENT ON COLUMN public.sequences.thread_failover_mode IS
  'defer = on pinned-sender failure, pause the enrollment + notify + daily digest until resolved. break = fail over to another sender and let the server-side thread reset. Only consulted when thread_replies (or pin_sender) is true.';

-- ── sequence_enrollments: cached thread anchor (read comes free with se.*) ───
-- pinned_sender_account_id is a soft reference (plain integer, no FK) to match
-- how sender_account_id is carried elsewhere in the prospecting schema and to
-- avoid ON DELETE cascade surprises if a sender row is ever removed; app logic
-- owns the relationship. All *_message_id / *_references columns are text
-- (unbounded) so long Outlook Graph ids and multi-step References chains are
-- never truncated.
ALTER TABLE public.sequence_enrollments
  ADD COLUMN IF NOT EXISTS pinned_sender_account_id integer,
  ADD COLUMN IF NOT EXISTS thread_conversation_id   text,
  ADD COLUMN IF NOT EXISTS thread_root_subject      text,
  ADD COLUMN IF NOT EXISTS thread_last_message_id   text,
  ADD COLUMN IF NOT EXISTS thread_references        text;

COMMENT ON COLUMN public.sequence_enrollments.pinned_sender_account_id IS
  'The prospecting_sender_accounts.id this enrollment is pinned to once its first email sends (threading or pin_sender). NULL until the first email; after that the firer restricts the sender pool to this id. Soft reference — app logic owns integrity.';
COMMENT ON COLUMN public.sequence_enrollments.thread_conversation_id IS
  'Immutable thread anchor stamped at the first email: Gmail threadId / Outlook conversationId. Passed to the provider on every subsequent email step so it nests in the same server-side thread.';
COMMENT ON COLUMN public.sequence_enrollments.thread_root_subject IS
  'Subject of the enrollment''s first email. Reused (optionally Re:-prefixed per sequences.thread_subject_mode) on all later email steps so the thread stays coherent.';
COMMENT ON COLUMN public.sequence_enrollments.thread_last_message_id IS
  'RFC822 Message-ID of the most recent email sent for this enrollment. Set as In-Reply-To on the next email step.';
COMMENT ON COLUMN public.sequence_enrollments.thread_references IS
  'Accumulated RFC822 References chain (space-separated Message-IDs, root first). Grows one id per email step; sent as the References header so non-provider recipient clients also thread correctly.';

-- ── Digest support: find paused-by-thread-failover enrollments cheaply ───────
-- Partial index keeps the daily digest scan flat at scale — it only touches
-- rows parked by the defer path, not the whole enrollments table.
CREATE INDEX IF NOT EXISTS idx_seq_enroll_thread_paused
  ON public.sequence_enrollments (org_id, enrolled_by)
  WHERE status = 'paused' AND stop_reason = 'thread_sender_blocked';

COMMIT;
