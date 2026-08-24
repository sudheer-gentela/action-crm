-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_129_baseline_freeze_repair.sql
--
-- DROP-IN LOCATION: backend/db/2026_129_baseline_freeze_repair.sql
--
-- Repairs projects whose plan is marked frozen but whose plays never got a
-- baseline. Data repair only — no schema change.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- HOW THIS STATE HAPPENS. Five separate ways, four of which are fixed in code
-- alongside this migration; this file cleans up what they already produced.
--
-- 1. freezePlanOnStart WAS NOT TRANSACTIONAL. It ran four independent
--    pool.query calls: read, then UPDATE sales_handovers (started_at +
--    baseline_frozen_at), then recompute project_start dates, then promote
--    baselines. The first UPDATE committed on its own, so any failure in the
--    third or fourth step left started_at and baseline_frozen_at durably set
--    with the baselines untouched. The caller catches and logs, so nothing
--    retried — and step 2 below guaranteed nothing ever could.
--
--    Project 91 is exactly this: plays created 19 Aug, started_at written
--    2026-08-20 by the function's own date logic, all 18 baselines still NULL.
--
-- 2. THE IDEMPOTENCE GUARD WAS ON THE WRONG FACT. `if (h.baseline_frozen_at)
--    return alreadyFrozen` meant a project left half-frozen could never be
--    repaired by pressing Start again — the flag written by the step that DID
--    succeed suppressed the steps that had not.
--
-- 3. MIGRATION 118'S BACKFILL FROZE PROJECTS WITHOUT PROMOTING THEM. It set
--    baseline_frozen_at and started_at for every project where status <> 'draft'
--    and touched project_play_instances not at all. Its own header says leaving
--    draft makes baselines 'original'; the backfill never did it. Combined with
--    (2), every project already past draft at that moment became permanently
--    unpromotable.
--
-- 4. NEITHER INSERT PATH SET A BASELINE. PlaybookPlayService and addAdHocPlay
--    both omitted baseline_due_date and baseline_source from their column
--    lists, so every play created after 2026_111 was born with NULL baselines.
--    In a frozen project nothing ever fixed that, and planVariance then reports
--    isAdHoc = true with no variance at all — silently, which is the worst part:
--    a project can show a complete plan and an empty plan-vs-actual.
--
-- 5. RETURNING TO DRAFT DID NOT UNFREEZE. Fixed in code, nothing to repair.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY 'inferred' AND NOT 'original'
--   'original' means "this is the plan somebody committed to at start".
--   Anything this migration writes is a baseline reconstructed after the fact
--   from whatever due_date happens to say today, which is not the same claim.
--   2026_111 faced the identical question and chose 'inferred'; so does this.
--   A project that wants a real committed baseline should be re-baselined
--   deliberately, with a reason, through the normal path.
--
-- WHY UNSCHEDULED PLAYS ARE LEFT ALONE
--   A play with no due_date gets no baseline. Same precedent, same words as
--   2026_111: giving an unscheduled play a baseline invents a plan that never
--   existed. Those plays keep reporting as ad-hoc, which is what they are.
--
-- NEVER TOUCHES 'rebaselined'
--   A 'rebaselined' row is a re-commitment somebody made with a written
--   reason. Overwriting it would erase the history the baseline model exists
--   to preserve.
--
-- NUMBERING: 128 = msteams_channel_readability. This is 129.
--   psql "$DATABASE_URL" -f 2026_129_baseline_freeze_repair.sql
-- Safe to run more than once — every statement is scoped to rows still in the
-- broken state.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── Before: what is about to change ─────────────────────────────────────────
\echo ''
\echo '=== Plays in FROZEN projects with no baseline (will be repaired) ==='
SELECT h.id  AS handover_id,
       h.name,
       h.status,
       count(*) FILTER (WHERE p.due_date IS NOT NULL) AS will_repair,
       count(*) FILTER (WHERE p.due_date IS NULL)     AS left_as_adhoc
  FROM public.sales_handovers h
  JOIN public.project_play_instances p
    ON p.handover_id = h.id AND p.org_id = h.org_id
 WHERE h.baseline_frozen_at IS NOT NULL
   AND p.baseline_due_date IS NULL
   AND (p.baseline_source IS NULL OR p.baseline_source = 'inferred')
 GROUP BY h.id, h.name, h.status
 ORDER BY h.id;

\echo ''
\echo '=== Projects marked frozen while still in draft (inconsistent) ==='
SELECT id, name, status, started_at, baseline_frozen_at
  FROM public.sales_handovers
 WHERE status = 'draft' AND baseline_frozen_at IS NOT NULL
 ORDER BY id;


-- ── 1. Give frozen projects' scheduled plays the baseline they never got ────
--
-- Scoped to baseline_due_date IS NULL so a play that already has one is never
-- overwritten, and to due_date IS NOT NULL so nothing unscheduled is invented.
UPDATE public.project_play_instances p
   SET baseline_due_date = p.due_date,
       baseline_source   = 'inferred',
       updated_at        = now()
  FROM public.sales_handovers h
 WHERE h.id = p.handover_id
   AND h.org_id = p.org_id
   AND h.baseline_frozen_at IS NOT NULL
   AND p.baseline_due_date IS NULL
   AND p.due_date IS NOT NULL
   AND (p.baseline_source IS NULL OR p.baseline_source = 'inferred');


-- ── 2. Unfreeze projects that are back in draft ─────────────────────────────
--
-- A draft project whose plan is frozen is a contradiction: draft means the plan
-- is still provisional and date edits should move the baseline silently, but the
-- flag says every edit is tracked slip. Defect 5 in code let this state exist;
-- this clears the ones already out there.
--
-- started_at is cleared with it. A project in draft has not started, and leaving
-- a start date behind makes project_start-anchored dates resolve against a start
-- that did not happen.
UPDATE public.sales_handovers
   SET baseline_frozen_at = NULL,
       started_at         = NULL,
       updated_at         = now()
 WHERE status = 'draft'
   AND baseline_frozen_at IS NOT NULL;


-- ── 3. Demote baselines belonging to projects now back in draft ─────────────
--
-- Follows from (2): if the plan is provisional again, its baselines are not
-- committed. 'original' becomes 'inferred' rather than NULL, because the dates
-- themselves are still a reasonable reconstruction — only the CLAIM that
-- somebody committed to them is withdrawn. 'rebaselined' is untouched.
UPDATE public.project_play_instances p
   SET baseline_source = 'inferred',
       updated_at      = now()
  FROM public.sales_handovers h
 WHERE h.id = p.handover_id
   AND h.org_id = p.org_id
   AND h.status = 'draft'
   AND p.baseline_source = 'original';


-- ── After: verify ───────────────────────────────────────────────────────────
\echo ''
\echo '=== Remaining plays in frozen projects with no baseline ==='
\echo '=== (should be only genuinely unscheduled plays: due_date IS NULL) ==='
SELECT count(*) FILTER (WHERE p.due_date IS NULL)     AS unscheduled_ok,
       count(*) FILTER (WHERE p.due_date IS NOT NULL) AS should_be_zero
  FROM public.sales_handovers h
  JOIN public.project_play_instances p
    ON p.handover_id = h.id AND p.org_id = h.org_id
 WHERE h.baseline_frozen_at IS NOT NULL
   AND p.baseline_due_date IS NULL;

\echo ''
\echo '=== Draft projects still marked frozen (should be zero) ==='
SELECT count(*) AS should_be_zero
  FROM public.sales_handovers
 WHERE status = 'draft' AND baseline_frozen_at IS NOT NULL;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK: none is offered, deliberately.
--
-- This migration writes baselines where none existed and clears a flag that was
-- inconsistent with the project's own status. There is no record of the broken
-- state to restore, and restoring it would mean deliberately reintroducing
-- plays that report no variance. If a specific project's baselines are wrong
-- after this, the correct remedy is a deliberate rebaseline through the
-- application — which records who did it and why — not a bulk revert.
--
-- Take a backup of project_play_instances (id, baseline_due_date,
-- baseline_source) before running if you want an escape hatch:
--
--   CREATE TABLE ppi_baseline_backup_2026_129 AS
--     SELECT id, baseline_due_date, baseline_source FROM public.project_play_instances;
-- ─────────────────────────────────────────────────────────────────────────────
