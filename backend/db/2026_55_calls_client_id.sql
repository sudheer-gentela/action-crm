-- ═══════════════════════════════════════════════════════════════════════════
-- 2026_55_calls_client_id.sql
--
-- Agency module Phase 7A — client attribution on calls (the foundation slice).
--
-- Today the calling subsystem is entirely org- and rep-scoped: a call row knows
-- its org_id and user_id (the rep) but NOT which agency client the call was made
-- on behalf of. Client is only *derivable* at read time via
-- calls.prospect_id → prospects.client_id, which (a) costs a join on every
-- client-grain report and (b) is not frozen: reassigning a prospect to another
-- client later would silently re-attribute all its historical calls.
--
-- Phase 7A denormalizes the client onto the call row, STAMPED AT CREATION, so a
-- call's client attribution behaves like an invoice line — frozen at call time,
-- surviving later prospect edits/reassignment, and directly indexable for the
-- per-client reporting and caps that 7C builds on top.
--
--   calls.client_id: nullable integer FK → clients(id).
--     • Stamped at all four call-creation sites from the prospect's client
--       (SELECT client_id FROM prospects WHERE id = <prospect> AND org_id = <org>).
--     • NULL when the call has no prospect (inbound webhook with no phone match)
--       or the prospect belongs to no client — i.e. every non-agency org and
--       every CRM/deal call stays client_id NULL and is excluded from client
--       attribution/caps/reporting (per handoff §1.4). Byte-identical behaviour
--       for non-agency orgs.
--
-- FK style mirrors prospects.client_id and prospecting_campaigns.client_id:
-- ON DELETE SET NULL (tag semantics — deleting a client must NEVER delete or
-- orphan call history; the historical call simply loses its client tag).
--
-- Attribution is FROZEN: no write path ever reassigns calls.prospect_id after
-- insert (verified across every `UPDATE calls` in the backend), so a value
-- stamped here stays consistent with prospect_id for the life of the row with
-- zero maintenance. Reassigning the *prospect* to another client later does NOT
-- retro-change historical call attribution — intended, matches the invoice-line
-- model (handoff §8).
--
-- Index idx_calls_client_id (client_id, occurred_at DESC) WHERE client_id IS NOT
-- NULL — mirrors the existing partial per-entity indexes (idx_calls_prospect,
-- idx_calls_account, idx_calls_deal). Serves the 7C hot paths: the monthly-
-- minutes/reporting range scan (WHERE client_id = $1 AND occurred_at >= <month>)
-- directly, and the concurrency count (WHERE client_id = $1 AND status IN (...))
-- via the client_id prefix. Partial so non-agency rows (client_id NULL) add no
-- index bloat.
--
-- ADD COLUMN with no default is metadata-only (no table rewrite). Idempotent:
-- IF NOT EXISTS on the column/index, guarded DO-block on the FK. Safe to re-run.
--
-- NO automatic backfill: 7A is correct without one (attribution matters going
-- forward; historical calls staying NULL is acceptable). A one-time, dry-run-
-- first, opt-in backfill is provided as a commented manual block at the bottom.
--
-- After deploying: re-dump schema.sql (pg_dump artifact — never hand-edit).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── calls.client_id column ───────────────────────────────────────────────────

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS client_id integer;

-- ── FK → clients(id) ON DELETE SET NULL (guarded; mirrors prospects.client_id)─

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'calls_client_id_fkey'
       AND conrelid = 'calls'::regclass
  ) THEN
    ALTER TABLE calls
      ADD CONSTRAINT calls_client_id_fkey
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── Partial index for 7C caps + client-grain reporting ───────────────────────

CREATE INDEX IF NOT EXISTS idx_calls_client_id
  ON calls (client_id, occurred_at DESC)
  WHERE client_id IS NOT NULL;

COMMENT ON COLUMN calls.client_id IS
  'Agency Phase 7A (2026_55): the client this call was made on behalf of, '
  'DENORMALIZED and STAMPED AT CREATION from the prospect (prospects.client_id, '
  'org-checked) at the four call-creation sites. NULL = no prospect (unmatched '
  'inbound) or prospect has no client (every non-agency org / CRM call). Frozen '
  'like an invoice line: prospect_id is never reassigned post-insert, and later '
  'reassigning the prospect to another client does NOT retro-change this. FK '
  'ON DELETE SET NULL so deleting a client never deletes call history. '
  'See 2026_55_calls_client_id.sql.';

COMMIT;

-- ── Verification (run manually after applying) ───────────────────────────────
--   \d calls                                   -- client_id column + FK + partial index
--   SELECT count(*) FROM calls WHERE client_id IS NOT NULL;   -- 0 right after (no backfill)
--
--   -- Confirm the derivation shape the app stamps with:
--   --   SELECT client_id FROM prospects WHERE id = <prospect> AND org_id = <org>;
--
--   -- Confirm ON DELETE SET NULL semantics on a throwaway client:
--   --   (deleting a client leaves its calls, with client_id reset to NULL)
--
-- ── OPTIONAL one-time backfill (NOT run by this migration) ────────────────────
-- Attribution is only required going forward, so historical calls may stay NULL.
-- If you DO want to stamp existing prospecting calls, run the DRY-RUN first and
-- only then the (currently commented) txn-wrapped APPLY.
--
--   -- DRY RUN (read-only): how many rows WOULD be stamped, and a sample.
--   SELECT count(*) AS would_stamp
--     FROM calls c
--     JOIN prospects p
--       ON p.id = c.prospect_id
--      AND p.org_id = c.org_id          -- org-safety, mirrors the insert-path guard
--    WHERE c.client_id IS NULL
--      AND p.client_id IS NOT NULL;
--
--   -- APPLY (commented out; uncomment the whole block to run):
--   -- BEGIN;
--   --   UPDATE calls c
--   --      SET client_id = p.client_id
--   --     FROM prospects p
--   --    WHERE c.prospect_id = p.id
--   --      AND c.org_id      = p.org_id      -- org-safety (redundant by FK, kept explicit)
--   --      AND c.client_id   IS NULL
--   --      AND p.client_id   IS NOT NULL;
--   -- COMMIT;
--
-- ── Rollback (manual, if ever needed) ────────────────────────────────────────
--   ALTER TABLE calls DROP COLUMN IF EXISTS client_id;
--   (Dropping the column also removes calls_client_id_fkey and idx_calls_client_id.
--    Any client_id values already stamped are legitimate data; the drop discards
--    them. No other object depends on calls.client_id.)
