-- =====================================================================
-- 2026_133_project_tracking_mode.sql
--
-- Adds the finite-versus-standing axis to projects, mirroring the
-- assigned-versus-recurring distinction daily work already makes for
-- work items one level down.
--
-- ── WHY A SECOND AXIS AND NOT A THIRD project_kind ───────────────────
--
-- project_kind answers "whose work is this" — customer or internal.
-- tracking_mode answers "does this ever finish" — timeboxed or
-- standing. They are independent, and the tempting shortcut of adding
-- 'standing' as a third project_kind value would make the four real
-- combinations inexpressible. All four occur:
--
--     customer + timeboxed   an implementation with a go-live
--     customer + standing    a retainer or managed service
--     internal + timeboxed   a migration with an owner and a date
--     internal + standing    Skill Development, PowerBI, AI Learning
--
-- The last row is the immediate cause of this migration. Seven rows
-- were created as project_kind='internal' so daily work would have
-- something to anchor to. They have no owner and will never complete,
-- so the Projects header reads "8 projects, 8 active, 7 unassigned"
-- permanently. Nothing is broken; the counter is answering a question
-- those rows were never in scope for.
--
-- project_kind is NOT touched by this migration, and
-- sales_handovers_project_kind_chk still permits exactly
-- ('customer','internal'). The harness asserts that, because widening
-- it is the specific wrong turn this design exists to avoid.
--
-- ── THE FENCE ────────────────────────────────────────────────────────
--
-- §12 of DESIGN_daily_work_tracking.md drew a fence around the project
-- machinery — project_play_instances, sales_handovers, project_stages,
-- handover_deliverable_rollup, baseline freeze, plan-vs-actual — so the
-- daily work build could not destabilise it. It held for that whole
-- build. This migration crosses it at exactly one point, sales_handovers,
-- with the user's explicit agreement, because the Projects module itself
-- has to read this column to change what it counts and what it demands.
-- A side table owned by daily work would not be read by the code that
-- needs it.
--
-- The crossing is kept as narrow as it can be:
--
--   * DEFAULT 'timeboxed', so every existing row behaves today exactly
--     as it did yesterday and no read anywhere changes until something
--     is explicitly set to standing.
--   * No change to any existing constraint, trigger, index or column.
--   * project_play_instances, project_stages,
--     handover_deliverable_rollup and the baseline freeze are untouched.
--
-- ── WHAT THE DATABASE ENFORCES, AND WHAT IT DELIBERATELY DOES NOT ────
--
-- Enforced here:
--
--   1. A standing initiative cannot carry a go_live_date. This follows
--      the chk_dwi_target_date_kind precedent from 2026_132 — a date by
--      which something should be done is meaningless for work that by
--      definition never finishes — and it is the user's decision.
--
--   2. A standing initiative cannot be 'completed'. It can be
--      'cancelled' (created in error, abandoned) and it can be RETIRED,
--      which is a different act with a different column.
--
--   3. Only a standing initiative can be retired, and retired_at and
--      retired_by move together. Shape mirrors the existing
--      sales_handovers_signoff_shape_chk on this same table.
--
-- NOT enforced here, on purpose:
--
--   4. "A timeboxed project requires an owner and an end date." That is
--      the right rule at CREATION and it must live in the service layer.
--      As a CHECK it would be catastrophic: every existing row defaults
--      to timeboxed, and the seven unassigned internal rows — plus any
--      customer project whose go-live is not yet known — would fail the
--      constraint and abort this migration. A rule that cannot be true
--      of the data you already have is not a database rule.
--
-- ── RETIREMENT IS A TIMESTAMP, NOT A STATUS ──────────────────────────
--
-- Daily work models retirement as a status value, because recurring
-- items have their own two-word vocabulary ('active','retired') and
-- nothing else reads it. sales_handovers.status is different: six
-- values, two transition tables in handover.service.js, a statusMeta
-- map in HandoverView.js, status filters in the list query, and a
-- status index. Adding a seventh value means every one of those either
-- learns the word or silently mishandles it — a blank badge, a rejected
-- transition, a row missing from a filter — and the ones that get it
-- wrong fail quietly.
--
-- A nullable timestamp pair costs nothing to ignore. Code that has not
-- been taught about retirement treats a retired initiative exactly as
-- it treats any other in_progress row, which is wrong but harmless,
-- rather than encountering a status it has no case for. It also matches
-- what this table already does for the other three terminal-ish acts:
-- completed_at/completed_by, cancelled_at/cancelled_by,
-- signed_off_at/signed_off_by.
--
-- ── CONVERSION IS AN OPERATION, NOT A MIGRATION ──────────────────────
--
-- standing -> timeboxed: name an owner and a date.
-- timeboxed -> standing: drop the date.
--
-- Work already logged is UNAFFECTED in both directions, and that is not
-- a promise this migration has to keep — it is a consequence of the
-- snapshot rule in §4 of the design record. daily_work_entries hold
-- their own copy of anchor_kind, anchor_id, department and account.
-- Nothing about an entry is derived from the project at read time, so
-- there is nothing for a conversion to disturb. The harness proves it
-- rather than asserting it in a comment.
--
-- TWO THINGS THE CALLER MUST HANDLE — neither is enforceable here:
--
--   a) timeboxed -> standing must clear go_live_date in the SAME
--      UPDATE. Setting tracking_mode alone on a project that has a
--      go-live raises chk_sh_standing_no_go_live, which is correct but
--      surfaces as a 500 unless the service clears the column itself.
--
--   b) Any play with due_anchor = 'go_live' keeps a due date computed
--      from a go-live the project no longer has. Two separate reasons,
--      and the obvious one is the less important:
--
--        * project_play_instances is where project checklists live
--          since 2026_109. It has NO trigger, and its go_live-anchored
--          dates are computed once at insert by computeInstanceDueDate()
--          in PlaybookPlayService. Nothing recomputes them — not on a
--          go-live move and not on a clear. This is pre-existing and
--          unrelated to tracking mode.
--        * deal_play_instances still carries the old behaviour through
--          trg_reschedule_go_live and the sales_handover_plays join.
--          2026_109 left those rows in place, so the trigger still
--          fires on them, but they are not what the module reads.
--          reschedule_go_live_anchored_plays() returns early on NULL,
--          so a clear moves nothing there either.
--
--      Net effect: clearing the date is safe in the database and
--      misleading in the UI. The service should refuse the conversion,
--      or warn, when open go_live-anchored plays exist. The harness
--      asserts all four outcomes so a later change to either path
--      cannot alter this silently.
--
--   c) update() CANNOT clear go_live_date as written. It is
--      COALESCE($2, go_live_date), so null means "leave it alone".
--      Conversion to standing needs its own statement or its own
--      code path; do not loosen the COALESCE, because every other
--      caller of update() depends on null meaning "unchanged".
--
-- ── VERIFICATION ─────────────────────────────────────────────────────
--
-- Run verify_project_tracking_133.js after applying. It asserts the
-- columns and their defaults, every constraint BY NAME, the partial
-- index and its predicate, that project_kind was not widened, that the
-- go-live trigger still exists and still no-ops on NULL, and that a
-- daily work entry survives a conversion in both directions untouched.
--
-- ── A NOTE ON THIS FILE'S NUMBER ─────────────────────────────────────
--
-- 2026_132's header, and the NOTE at the top of
-- verify_daily_work_132.js, both reserve "2026_133" for enabling row-
-- level security on the seven daily work tables. That work is still
-- parked; this file took the number because the handoff assigned it.
--
-- There is no migration ledger, so those two stale references are the
-- only place a reader would look. Fix both to say "a later migration"
-- rather than a number, or RLS will be looked for here and not found.
--
-- Idempotent: safe to re-run. Every statement guards on existence.
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;

-- ── 0. Prerequisite ──────────────────────────────────────────────────
--
-- Guarded on project_kind rather than on the table, because this
-- migration's entire premise is that it is adding a SECOND axis beside
-- an existing one. Applying it to a database without 2026_87 would
-- produce a coherent-looking schema built on a wrong assumption, which
-- is worse than a failure.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'sales_handovers'
       AND column_name  = 'project_kind'
  ) THEN
    RAISE EXCEPTION 'sales_handovers.project_kind is missing — apply 2026_87 first';
  END IF;
END $$;

-- ── 1. tracking_mode ─────────────────────────────────────────────────
--
-- NOT NULL DEFAULT rather than nullable: a NULL would mean "nobody has
-- decided", and every read would need a COALESCE that somebody would
-- eventually forget. Postgres 11+ fills the default without rewriting
-- the table, so this is cheap regardless of row count.

ALTER TABLE sales_handovers
  ADD COLUMN IF NOT EXISTS tracking_mode text NOT NULL DEFAULT 'timeboxed';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sales_handovers_tracking_mode_chk'
  ) THEN
    ALTER TABLE sales_handovers
      ADD CONSTRAINT sales_handovers_tracking_mode_chk
      CHECK (tracking_mode = ANY (ARRAY['timeboxed'::text, 'standing'::text]));
  END IF;
END $$;

COMMENT ON COLUMN sales_handovers.tracking_mode IS
  'Does this project ever finish? timeboxed = owner and end date, completes '
  'once, counts in the project statistics. standing = no end date, never '
  'completes, can only be retired, excluded from the active count. '
  'ORTHOGONAL to project_kind: a retainer is customer+standing and a '
  'migration is internal+timeboxed. Never fold the two into one column.';

-- ── 2. A standing initiative has no end date ─────────────────────────
--
-- Same shape and same reasoning as chk_dwi_target_date_kind on
-- daily_work_items: the database enforces what the form enforces, so
-- the rule survives a caller that forgets it.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_sh_standing_no_go_live'
  ) THEN
    ALTER TABLE sales_handovers
      ADD CONSTRAINT chk_sh_standing_no_go_live
      CHECK (go_live_date IS NULL OR tracking_mode = 'timeboxed');
  END IF;
END $$;

-- ── 3. A standing initiative never completes ─────────────────────────
--
-- Separate constraint rather than one combined shape check, so the
-- harness — and a 400 handler — can tell "you gave a standing
-- initiative a date" apart from "you tried to complete one". A single
-- constraint name would make both failures report the same thing.
--
-- completed_at is included because it catches the other direction:
-- converting an already-completed timeboxed project to standing would
-- otherwise leave a completion timestamp on something that by
-- definition cannot have completed.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_sh_standing_never_completes'
  ) THEN
    ALTER TABLE sales_handovers
      ADD CONSTRAINT chk_sh_standing_never_completes
      CHECK (tracking_mode = 'timeboxed'
             OR (status <> 'completed' AND completed_at IS NULL));
  END IF;
END $$;

-- ── 4. Retirement ────────────────────────────────────────────────────

ALTER TABLE sales_handovers
  ADD COLUMN IF NOT EXISTS retired_at timestamp with time zone;

ALTER TABLE sales_handovers
  ADD COLUMN IF NOT EXISTS retired_by integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sales_handovers_retired_by_fkey'
  ) THEN
    -- No ON DELETE clause, matching completed_by and signed_off_by on this
    -- same table. Attribution for a deliberate administrative act should
    -- block the deletion of the person who performed it rather than
    -- quietly becoming anonymous.
    ALTER TABLE sales_handovers
      ADD CONSTRAINT sales_handovers_retired_by_fkey
      FOREIGN KEY (retired_by) REFERENCES users(id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_sh_retired_shape'
  ) THEN
    ALTER TABLE sales_handovers
      ADD CONSTRAINT chk_sh_retired_shape
      CHECK ((retired_at IS NULL AND retired_by IS NULL)
          OR (retired_at IS NOT NULL AND retired_by IS NOT NULL
              AND tracking_mode = 'standing'));
  END IF;
END $$;

COMMENT ON COLUMN sales_handovers.retired_at IS
  'Retirement, the standing-initiative equivalent of completion. Deliberately '
  'a timestamp and NOT a seventh sales_handovers.status value: a new status '
  'word would have to be taught to two transition tables, the statusMeta map, '
  'the status filter and the status index, and every one that missed it would '
  'fail silently. Retiring a timeboxed project is refused by chk_sh_retired_shape.';

COMMENT ON COLUMN sales_handovers.retired_by IS
  'Who retired it. Moves with retired_at — never set one alone.';

-- ── 5. Index ─────────────────────────────────────────────────────────
--
-- Partial on the SMALL side. Standing initiatives are the minority and
-- get their own screen; the timeboxed list is the existing whole-org
-- access pattern already served by idx_sales_handovers_org_status, and
-- a partial index over the majority of rows would earn nothing.
--
-- retired_at is a leading column, not just a predicate, so the default
-- "active initiatives" read and the "everything including retired" read
-- both come off the same index.

CREATE INDEX IF NOT EXISTS idx_sales_handovers_standing
  ON sales_handovers (org_id, retired_at, created_at DESC)
  WHERE tracking_mode = 'standing';

-- ── 6. Prove the crossing stayed narrow ──────────────────────────────
--
-- Belt and braces before COMMIT. If a later edit to this file ever
-- widens project_kind, this fails here rather than in review.

DO $$
DECLARE def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint WHERE conname = 'sales_handovers_project_kind_chk';

  IF def IS NULL THEN
    RAISE EXCEPTION 'sales_handovers_project_kind_chk vanished — something else changed project_kind';
  END IF;

  IF position('standing' in def) > 0 THEN
    RAISE EXCEPTION 'project_kind now mentions standing — the two axes have been merged, which this migration exists to prevent';
  END IF;
END $$;

COMMIT;

-- =====================================================================
-- Deploy notes — what breaks if a piece is missing
--
-- 1. Without the DEFAULT, existing rows read NULL and every count,
--    filter and form in the Projects module needs a COALESCE. The first
--    one that forgets drops rows from a list silently.
--
-- 2. Without chk_sh_standing_no_go_live, a standing initiative can hold
--    a go-live date, handover_deliverable_rollup.days_to_go_live starts
--    counting down on it, and the module reports something as late that
--    by design has no deadline.
--
-- 3. Without chk_sh_standing_never_completes, a standing initiative can
--    be completed, which is the exact bug this whole model exists to
--    remove — it re-creates a permanent row in the completed count.
--
-- 4. Without chk_sh_retired_shape, retired_at can be set on a timeboxed
--    project, giving it two contradictory terminal states.
--
-- 5. Nothing here changes any read. Until handover.service.js filters on
--    tracking_mode, applying this migration is invisible in the product.
--    That is intended: schema first, verified, then the module.
--
-- 6. STILL OPEN after this migration, both application-layer:
--    - a timeboxed project created without an owner or an end date is
--      still accepted by the database (see note 4 in the header)
--    - who may create a standing initiative is not a schema question;
--      see handovers.routes.js
-- =====================================================================
