-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_140_per_play_watchers.sql
--
-- Lets someone follow ONE task rather than a whole project.
--
-- ── SHAPE: A NULLABLE COLUMN, NOT A SIBLING TABLE ────────────────────────────
--
-- project_play_watchers gains play_instance_id. NULL means what every existing
-- row means — watch the whole project. A value means watch that one task.
--
-- The alternative was a second table. This is smaller, and more importantly it
-- keeps playReviewNotifier.resolveRecipients to ONE union arm:
--
--     WHERE w.handover_id = $1
--       AND (w.play_instance_id IS NULL OR w.play_instance_id = $n)
--
-- A sibling table would mean a second arm, a second set of predicates about
-- active users and org scoping, and two places to remember when the rule
-- changes. The recipient resolver is the one function in this area where a
-- missed edit is silent in both directions at once — someone stops being told,
-- or starts being told about a project they left.
--
-- ── THE UNIQUE CONSTRAINT IS THE TRAP ────────────────────────────────────────
--
-- The old constraint is UNIQUE (handover_id, user_id). It cannot simply gain
-- the new column, because Postgres treats NULLs as DISTINCT in a unique index:
-- UNIQUE (handover_id, user_id, play_instance_id) would happily accept
-- (10, 42, NULL) a hundred times over. The project-level uniqueness that every
-- ON CONFLICT in the codebase relies on would silently evaporate, and the
-- symptom would be duplicate notifications rather than an error.
--
-- So it becomes two partial indexes, each covering exactly one of the two kinds
-- of row:
--
--   idx_ppw_project_unique  (handover_id, user_id) WHERE play_instance_id IS NULL
--   idx_ppw_play_unique     (handover_id, user_id, play_instance_id)
--                                                  WHERE play_instance_id IS NOT NULL
--
-- Postgres 15 added NULLS NOT DISTINCT, which would also work here — this
-- database is 17.11. Partial indexes are used anyway because they need no
-- version floor, and because they state the two rules separately, which is what
-- they are.
--
-- ── EVERY ON CONFLICT MUST BE UPDATED WITH THIS MIGRATION ────────────────────
--
-- `ON CONFLICT (handover_id, user_id)` infers a unique index on exactly those
-- columns. After this migration no such index exists, and every one of those
-- statements FAILS AT RUNTIME with "there is no unique or exclusion constraint
-- matching the ON CONFLICT specification". They must become
--
--     ON CONFLICT (handover_id, user_id) WHERE play_instance_id IS NULL
--
-- which is how a partial index is inferred. Three call sites, all in
-- playReview.service.js: setWatchers, seedWatchersFromOrgDefault, setSelfWatch.
-- This is a loud failure rather than a quiet one, but it is a failure on the
-- first watcher write after deploy — so the service file ships WITH this.
--
-- ── DELETION ─────────────────────────────────────────────────────────────────
--
-- ON DELETE CASCADE, because plays are HARD deleted: handover.service.removePlay
-- runs a real DELETE FROM project_play_instances. Without the cascade, removing
-- a task would leave watcher rows pointing at an id that no longer exists —
-- invisible, since resolveRecipients would simply never match them again, and
-- accumulating forever.
--
-- Safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE public.project_play_watchers
  ADD COLUMN IF NOT EXISTS play_instance_id integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'project_play_watchers_play_instance_fkey'
  ) THEN
    ALTER TABLE public.project_play_watchers
      ADD CONSTRAINT project_play_watchers_play_instance_fkey
      FOREIGN KEY (play_instance_id)
      REFERENCES public.project_play_instances(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Order matters: create the replacement indexes BEFORE dropping the old
-- constraint, so there is no window in which two concurrent subscribes could
-- both insert a project-level row for the same person.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ppw_project_unique
  ON public.project_play_watchers (handover_id, user_id)
  WHERE play_instance_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ppw_play_unique
  ON public.project_play_watchers (handover_id, user_id, play_instance_id)
  WHERE play_instance_id IS NOT NULL;

ALTER TABLE public.project_play_watchers
  DROP CONSTRAINT IF EXISTS project_play_watchers_handover_id_user_id_key;

-- resolveRecipients filters on (play_instance_id IS NULL OR = $n) for every
-- review event on the project, so this is on the hot path for the checklist.
CREATE INDEX IF NOT EXISTS idx_ppw_play_instance
  ON public.project_play_watchers (play_instance_id)
  WHERE play_instance_id IS NOT NULL;

COMMENT ON COLUMN public.project_play_watchers.play_instance_id IS
  'NULL = watching the whole project (every existing row). Set = watching only that one task, and receiving nothing about the rest of the project. Cascades when the task is deleted.';

COMMIT;
