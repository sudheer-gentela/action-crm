-- =====================================================================
-- 2026_122_boq_progress_delete_with_item.sql
--
-- The same contradiction as 2026_121, on a different table.
--
-- THE BUG
--     boq_progress_item_fkey  FOREIGN KEY (boq_item_id) REFERENCES boq_items(id) ON DELETE CASCADE
--     boq_progress_org_fkey   FOREIGN KEY (org_id)      REFERENCES organizations(id) ON DELETE CASCADE
--     trg_boq_progress_append_only  RAISE EXCEPTION on TG_OP = 'DELETE'
--
--   Reproduced:
--
--     DELETE FROM boq_items WHERE id = 78;
--     ERROR: boq_progress is append-only: post a reversing entry instead
--            of deleting (id 1)
--
--   So DELETE /handovers/boq/items/:itemId — a live route — fails for any
--   item that has ever had progress recorded against it.
--
-- WHY THIS IS IN THE SAME BATCH AS 2026_121
--   Both tables sit under organizations with ON DELETE CASCADE, so BOTH
--   block super-admin org deletion (superAdmin.routes.js:490). Fixing
--   only play_evidence moves the failure from one table to the other and
--   org deletion stays broken. They are separate files so each can be
--   reviewed on its own, but org deletion needs both.
--
-- SAME DECISION, SAME REASONING
--   A progress entry measures work against ONE bill item. With the item
--   gone it measures nothing. Reversal remains the correct way to
--   correct an entry on an item that still exists; what changes is only
--   that the item's own removal is no longer blocked.
--
--   Scoped the same way: the cascade predicate is
--   `WHERE boq_item_id = <deleted item>`, so progress recorded against
--   any other item is untouched.
--
-- WHY UPDATE-ONLY RATHER THAN DROPPING THE DELETE ARM
--   boq_progress_append_only() raises unconditionally on both paths, so
--   the DELETE branch cannot simply be removed without the UPDATE
--   message then being raised for deletes. The trigger is re-created as
--   BEFORE UPDATE, and a TG_OP guard is kept inside the function so
--   re-attaching DELETE later degrades to a no-op.
--
-- Run AFTER 2026_121.
--   psql "$DATABASE_URL" -f 2026_122_boq_progress_delete_with_item.sql
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.boq_progress_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Unreachable while the trigger below is UPDATE-only; kept so that
  -- re-attaching DELETE cannot resurrect the cascade deadlock.
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'boq_progress is append-only: entry % cannot be edited. Post a reversing entry.', OLD.id;
END $$;

DROP TRIGGER IF EXISTS trg_boq_progress_append_only ON public.boq_progress;
CREATE TRIGGER trg_boq_progress_append_only
  BEFORE UPDATE ON public.boq_progress
  FOR EACH ROW EXECUTE FUNCTION public.boq_progress_append_only();

COMMENT ON CONSTRAINT boq_progress_item_fkey ON public.boq_progress IS
  'ON DELETE CASCADE, and now actually reachable (2026_122). Scoped to the '
  'deleted item: progress against any other bill item is untouched.';

COMMIT;

-- ── Verification ─────────────────────────────────────────────────────

\echo ''
\echo '=== Trigger is now UPDATE-only ==='
SELECT tgname,
       (tgtype & 8) > 0  AS fires_on_delete,
       (tgtype & 16) > 0 AS fires_on_update
  FROM pg_trigger
 WHERE tgrelid = 'public.boq_progress'::regclass AND NOT tgisinternal;

\echo ''
\echo '=== Bill items that could not previously be deleted ==='
SELECT count(DISTINCT boq_item_id) AS items_with_progress,
       count(*)                    AS progress_entries
  FROM public.boq_progress;
