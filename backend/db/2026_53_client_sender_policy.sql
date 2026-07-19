-- ═══════════════════════════════════════════════════════════════════════════
-- 2026_53_client_sender_policy.sql
--
-- Agency module Phase 3 — sender-identity hardening.
--
-- clients.require_client_sender: per-client hard block on the rep-mailbox
-- fallback. Today, when a client prospect's email step fires and the client
-- has no active connected sender, BOTH resolution paths silently fall back to
-- the rep's PERSONAL mailbox (SequenceStepFirer.resolveSender /
-- pickEmailSenderWithCapacity, and the manual send endpoint never used client
-- senders at all). For an agency that is a wrong-identity send: wrong From
-- domain, wrong signature, invisible to the client's reporting.
--
-- With the flag TRUE:
--   • auto-send: the step fails visibly via the existing failAndPause path
--     ("connect a mailbox for <client>") instead of borrowing the rep's.
--   • manual send (drafts): blocked with a 400 + actionable message.
--   • DEFAULT FALSE: additive and inert — every existing client keeps
--     today's fallback behaviour until the flag is explicitly enabled per
--     client in Agency → client → Senders.
--
-- Also documents sequences.client_id as reserved: the column + index have
-- existed since the clients schema landed but NOTHING reads or writes them —
-- per-client sequence attribution is derived through enrollments → prospects.
-- Deliberately NOT dropped (non-destructive; a future "client-private
-- sequence templates" feature may claim it). The comment stops the next
-- reader from assuming it is live.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; COMMENT ON is naturally re-runnable.
-- ADD COLUMN with a constant default is metadata-only on PG11+ (no rewrite).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS require_client_sender boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN clients.require_client_sender IS
  'Agency Phase 3 (2026_53): when true, email steps for this client''s prospects '
  'may ONLY use a client-owned sender (prospecting_sender_accounts.client_id = '
  'clients.id). No active client sender → auto-send fails the step visibly '
  '(failAndPause) and manual draft-send is blocked, instead of falling back to '
  'the rep''s personal mailbox. Default false = legacy fallback behaviour.';

COMMENT ON COLUMN sequences.client_id IS
  'RESERVED — not read or written by any code path as of 2026_53. Per-client '
  'sequence attribution is DERIVED via enrollments → prospects.client_id (see '
  'GET /clients/all/sequences). Kept for a possible future client-private '
  'sequence-template feature; do not assume it is populated.';

COMMIT;

-- ── Verification (run manually after applying) ───────────────────────────────
--   \d clients                        -- require_client_sender present, default false
--   SELECT count(*) FROM clients WHERE require_client_sender;   -- 0 right after
--
-- Rollback (manual, if ever needed):
--   ALTER TABLE clients DROP COLUMN IF EXISTS require_client_sender;
--   COMMENT ON COLUMN sequences.client_id IS NULL;
