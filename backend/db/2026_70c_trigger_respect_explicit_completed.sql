-- ═══════════════════════════════════════════════════════════════════════════
-- 2026_70c_trigger_respect_explicit_completed.sql
--
-- Second hotfix to 2026_70. Numbered 70c so the 71→77 sequence claimed by A5b
-- and the plan's downstream migrations stays untouched.
--
-- Replaces the sync_action_completed() function only. The TRIGGER definition is
-- deliberately NOT dropped or recreated — it references the function by name, so
-- CREATE OR REPLACE FUNCTION is sufficient and avoids a window with no trigger
-- attached.
--
-- ── Problem 1: INSERT clobbered an explicitly-supplied completed ─────────────
--
-- 2026_70's function ran `NEW.completed := (NEW.status = 'completed')`
-- unconditionally, including on INSERT. Callers that import already-finished
-- work supply completed / completed_at from the source system and never supply
-- status:
--
--   backend/services/salesforce.sync.service.js:252
--     INSERT INTO actions (..., completed, completed_at, ...)
--     VALUES (..., sfTask.Status = 'Completed', ..., )   -- no status column
--
-- Before 2026_70b those inserts failed outright on the illegal 'yet_to_start'
-- default, so the interaction was masked. 70b made them succeed, at which point
-- status took the new 'not_started' default and the trigger overwrote completed
-- to false — producing completed = false WITH completed_at set (the exact B14
-- desync 2026_70 existed to remove) and surfacing finished Salesforce tasks as
-- open work in the Actions view.
--
-- Fix: on INSERT, an explicit completed = true is treated as authoritative and
-- promotes status to 'completed'. Everywhere else status remains the single
-- source of truth, exactly as 2026_70 intended.
--
-- Detection of "explicit" relies on actions.completed defaulting to false, so a
-- true value cannot have come from the default. Verified against schema.sql.
--
-- ── Problem 2: completed_at was stamped but never cleared ────────────────────
--
-- The original function stamps completed_at on completion and leaves it in place
-- forever. Reopening an action (status 'completed' → 'not_started') therefore
-- leaves completed_at populated, and ACTION_STATE_CASE in reporting.routes.js
-- classifies on `completed_at IS NOT NULL OR status = 'completed'` — so a
-- reopened action still counts as rep_completed in the activity report.
--
-- Fix: clear completed_at (and completed_by) when status leaves 'completed'.
--
-- §3 below is scoped strictly to reopened rows and is a no-op if there are none.
-- If you want ONLY problem 1 fixed, delete §3 and the two completed_by/
-- completed_at clearing lines in §2 marked "problem 2".
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- §1. PRE-FLIGHT — run and eyeball before committing.
--
--   Query 1: rows already desynced (status not completed, completed_at set).
--            These are what §3 repairs. Expect a small number or zero.
--   Query 2: the harder error — completed disagrees with status. 2026_70
--            reconciled these, so expect 0. Non-zero means something wrote
--            around the trigger.
-- ───────────────────────────────────────────────────────────────────────────
-- SELECT count(*) AS reopened_but_stamped
--   FROM actions WHERE status <> 'completed' AND completed_at IS NOT NULL;
--
-- SELECT count(*) AS completed_flag_desync
--   FROM actions WHERE completed IS DISTINCT FROM (status = 'completed');


-- ───────────────────────────────────────────────────────────────────────────
-- §2. Replace the function.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION sync_action_completed() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- An explicit completed = true wins and drags status with it. Cannot have
    -- come from the column default (false), so it is always intentional.
    IF NEW.completed IS TRUE AND NEW.status IS DISTINCT FROM 'completed' THEN
      NEW.status := 'completed';
    ELSE
      NEW.completed := (NEW.status = 'completed');
    END IF;
  ELSE
    -- UPDATE OF status — status is authoritative, unchanged from 2026_70.
    NEW.completed := (NEW.status = 'completed');
  END IF;

  IF NEW.status = 'completed' THEN
    -- Stamp only if absent, so an imported completion date is preserved rather
    -- than being overwritten with now().
    IF NEW.completed_at IS NULL THEN
      NEW.completed_at := now();
    END IF;
  ELSE
    -- problem 2: leaving these set makes a reopened action read as completed to
    -- anything keyed on completed_at (e.g. ACTION_STATE_CASE).
    NEW.completed_at := NULL;
    NEW.completed_by := NULL;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION sync_action_completed() IS
  'Keeps actions.completed / completed_at in step with actions.status. '
  'status is authoritative on UPDATE; on INSERT an explicit completed = true '
  'promotes status to completed so imported finished work survives. '
  'completed_at is preserved if supplied, stamped if absent, cleared on reopen. '
  'As of 2026_70c.';


-- ───────────────────────────────────────────────────────────────────────────
-- §3. Repair rows already in the reopened-but-stamped state.
--     No-op when §1 query 1 returned 0.
-- ───────────────────────────────────────────────────────────────────────────
UPDATE actions
   SET completed_at = NULL,
       completed_by = NULL
 WHERE status <> 'completed'
   AND completed_at IS NOT NULL;


-- ───────────────────────────────────────────────────────────────────────────
-- §4. VERIFY before COMMIT. Both must return 0.
-- ───────────────────────────────────────────────────────────────────────────
-- SELECT count(*) AS still_desynced
--   FROM actions WHERE completed IS DISTINCT FROM (status = 'completed');
--
-- SELECT count(*) AS still_stamped
--   FROM actions WHERE status <> 'completed' AND completed_at IS NOT NULL;

COMMIT;
