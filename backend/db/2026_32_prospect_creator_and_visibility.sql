-- 2026_32_prospect_creator_and_visibility.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Prospect ownership refinements:
--
--   1. created_by  — the immutable CREATOR of the prospect, distinct from
--                    owner_id (which is mutable and reassignable). By default
--                    the creator is the initial owner; reassigning the owner
--                    never changes the creator. Backfilled from owner_id for
--                    every existing row, so nothing changes for current data.
--
--   2. Org-level cross-owner visibility switch — stored as a JSONB key
--      (restrict_prospect_view_to_scope) in the existing
--      org_action_config.campaign_settings blob, read/written via
--      campaignSettings.service.js. NO DDL (JSONB key); documented here as the
--      single record of the change.
--        ABSENT ⇒ FALSE ⇒ current behavior: anyone in the org may open any
--        prospect's detail (owner is highlighted in the UI).
--        TRUE ⇒ a rep may open full detail only for prospects whose owner is
--        within their reporting scope (self / their team for a manager / all
--        for an admin). Out-of-scope prospects return a restricted payload so
--        the UI can show "owned by <name>, another rep in your org" without
--        leaking detail. Enforced in GET /prospects/:id via AccessPolicy +
--        ReportingScopeService.
--
-- This migration is ADDITIVE and non-destructive: it only adds a nullable
-- column and backfills it. The "dry run" below is a read-only pre-check you can
-- run first to preview exactly what the backfill will touch.
-- ─────────────────────────────────────────────────────────────────────────────


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ DRY RUN — read-only. Run this block FIRST, on its own, and eyeball it.     ║
-- ║ It writes nothing. It reports how many rows the backfill will set and      ║
-- ║ confirms there are no prospects with a NULL owner_id (there shouldn't be — ║
-- ║ owner_id is NOT NULL — but we assert it so the backfill can't surprise us).║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
-- SELECT
--   COUNT(*)                                        AS total_prospects,
--   COUNT(*) FILTER (WHERE owner_id IS NULL)         AS rows_with_null_owner,   -- expect 0
--   COUNT(*)                                         AS rows_backfill_will_set  -- created_by ← owner_id
-- FROM prospects;
--
-- Proceed only if rows_with_null_owner = 0. Then run everything below.


-- ── 1. Add the column (nullable for the backfill window) ─────────────────────
ALTER TABLE prospects
  ADD COLUMN IF NOT EXISTS created_by integer;

-- ── 2. Backfill: existing prospects' creator = their current owner ───────────
--    Idempotent — only fills rows that don't have it yet, so re-running the
--    migration won't clobber a creator that later diverged from the owner.
UPDATE prospects
   SET created_by = owner_id
 WHERE created_by IS NULL;

-- ── 3. Lock it down once backfilled ──────────────────────────────────────────
--    Every row now has a creator, and all three insert paths (manual create,
--    CSV import, CRM sync) set it going forward — so NOT NULL is safe. Wrapped
--    so a re-run on an already-NOT-NULL column is a no-op rather than an error.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'prospects'
       AND column_name = 'created_by'
       AND is_nullable = 'YES'
  ) AND NOT EXISTS (
    SELECT 1 FROM prospects WHERE created_by IS NULL
  ) THEN
    ALTER TABLE prospects ALTER COLUMN created_by SET NOT NULL;
  END IF;
END $$;

-- ── 4. Index for "prospects I created" lookups (cheap, supports creator views)─
CREATE INDEX IF NOT EXISTS idx_prospects_created_by
  ON prospects (org_id, created_by);


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ POST-CHECK — read-only. Run after the block above to confirm success.      ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
-- SELECT
--   COUNT(*)                                          AS total_prospects,
--   COUNT(*) FILTER (WHERE created_by IS NULL)          AS still_null,            -- expect 0
--   COUNT(*) FILTER (WHERE created_by <> owner_id)      AS creator_differs_owner  -- expect 0 right after migrate
-- FROM prospects;
