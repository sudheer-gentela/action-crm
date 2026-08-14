-- =====================================================================
-- 2026_112_rollup_uses_project_plays.sql
--
-- Repoints handover_deliverable_rollup at project_play_instances.
--
-- WHY THIS IS URGENT
--   2026_109 moved project plays into project_play_instances but deliberately
--   LEFT the pre-migration copies in deal_play_instances / sales_handover_plays
--   as a rollback path. Those copies are now frozen: nothing writes to them.
--
--   This view still joins them:
--       sales_handovers -> sales_handover_plays -> deal_play_instances
--
--   So every number it produces is a snapshot of the moment 2026_109 ran.
--   Completing a play, moving a date, adding an ad-hoc item, or swapping a
--   playbook all write to project_play_instances and are invisible here.
--
--   The view is read by:
--     handover.service.js  list()        — the projects list
--     handover.service.js  (detail)      — the Summary panel
--     handover.service.js  canClose()    — whether a project may be closed
--     handoverHealthService.js           — project health signals
--     notificationService.js             — overdue-play alerts (rule mirrored)
--
--   Left as-is, a project could report gates_open = 0 and be closeable while
--   an open gate sits unfinished in the live table, and overdue alerts would
--   fire on stale dates. That is the worst class of bug here: silently wrong
--   rather than visibly broken.
--
-- WHAT CHANGES
--   Only the FROM clause. Every column, filter and status vocabulary is
--   preserved exactly, so no caller needs to change.
--
-- Run AFTER 2026_109. Safe to re-run.
--   psql "$DATABASE_URL" -f 2026_112_rollup_uses_project_plays.sql
-- =====================================================================

\set ON_ERROR_STOP on
SET statement_timeout = '600s';

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.project_play_instances') IS NULL THEN
    RAISE EXCEPTION 'HARD STOP: project_play_instances does not exist. Run 2026_109 first.';
  END IF;
END $$;

-- Capture the pre-change numbers so the report at the end can show what was
-- being under-reported. Nothing depends on this; it is evidence for the human.
CREATE TEMP TABLE _before AS
SELECT handover_id, plays_total, plays_done, plays_overdue, gates_open, is_closeable
  FROM public.handover_deliverable_rollup;

-- CREATE OR REPLACE keeps the column list and order identical, which is what
-- lets the five callers stay untouched. Postgres rejects the statement if the
-- shape changes, so this is self-checking.
CREATE OR REPLACE VIEW public.handover_deliverable_rollup AS
 SELECT h.id AS handover_id,
    h.org_id,
    h.status,
    h.go_live_date,
    (h.go_live_date - CURRENT_DATE) AS days_to_go_live,
    count(DISTINCT ppi.id) AS plays_total,
    count(DISTINCT ppi.id) FILTER (WHERE (ppi.status = ANY (ARRAY['completed'::text, 'skipped'::text, 'cancelled'::text]))) AS plays_done,
    count(DISTINCT ppi.id) FILTER (WHERE ((ppi.status <> ALL (ARRAY['completed'::text, 'skipped'::text, 'cancelled'::text, 'snoozed'::text])) AND (ppi.due_date < CURRENT_DATE))) AS plays_overdue,
    count(DISTINCT ppi.id) FILTER (WHERE (ppi.is_gate AND (ppi.status <> ALL (ARRAY['completed'::text, 'skipped'::text, 'cancelled'::text])))) AS gates_open,
    count(DISTINCT c.id) AS commitments_total,
    count(DISTINCT c.id) FILTER (WHERE ((c.status)::text = ANY ((ARRAY['met'::character varying, 'waived'::character varying, 'breached'::character varying])::text[]))) AS commitments_closed,
    count(DISTINCT c.id) FILTER (WHERE (((c.status)::text = ANY ((ARRAY['open'::character varying, 'in_progress'::character varying])::text[])) AND (c.due_date < CURRENT_DATE))) AS commitments_overdue,
    count(DISTINCT c.id) FILTER (WHERE ((c.status)::text = 'breached'::text)) AS commitments_breached,
    ((count(DISTINCT ppi.id) FILTER (WHERE (ppi.is_gate AND (ppi.status <> ALL (ARRAY['completed'::text, 'skipped'::text, 'cancelled'::text])))) = 0) AND (count(DISTINCT c.id) FILTER (WHERE ((c.status)::text = ANY ((ARRAY['open'::character varying, 'in_progress'::character varying])::text[]))) = 0)) AS is_closeable
   FROM ((public.sales_handovers h
     -- One join instead of two. project_play_instances.handover_id is the
     -- single link now, so the sales_handover_plays hop is gone with it.
     LEFT JOIN public.project_play_instances ppi ON ((ppi.handover_id = h.id)))
     LEFT JOIN public.sales_handover_commitments c ON ((c.handover_id = h.id)))
  GROUP BY h.id, h.org_id, h.status, h.go_live_date;

COMMENT ON VIEW public.handover_deliverable_rollup IS
  'Per-handover deliverable aggregate: play + commitment counts, overdue counts, and is_closeable. Read by handover.service.list(), canClose(), handoverHealthService and notificationService. Reads project_play_instances as of 2026_112 (was deal_play_instances via sales_handover_plays, which froze after the 2026_109 split).';

COMMIT;

\echo ''
\echo '=== Projects whose numbers CHANGED (were being reported from stale rows) ==='
SELECT a.handover_id,
       b.plays_total   AS was_total,   a.plays_total   AS now_total,
       b.plays_done    AS was_done,    a.plays_done    AS now_done,
       b.plays_overdue AS was_overdue, a.plays_overdue AS now_overdue,
       b.gates_open    AS was_gates,   a.gates_open    AS now_gates,
       b.is_closeable  AS was_closeable, a.is_closeable AS now_closeable
  FROM public.handover_deliverable_rollup a
  JOIN _before b ON b.handover_id = a.handover_id
 WHERE (a.plays_total, a.plays_done, a.plays_overdue, a.gates_open, a.is_closeable)
       IS DISTINCT FROM
       (b.plays_total, b.plays_done, b.plays_overdue, b.gates_open, b.is_closeable)
 ORDER BY a.handover_id;

\echo ''
\echo '=== Totals reconcile against the live table? (must match) ==='
SELECT
  (SELECT sum(plays_total)::int FROM public.handover_deliverable_rollup) AS rollup_plays,
  (SELECT count(*)::int FROM public.project_play_instances)              AS live_plays;

\echo ''
\echo 'If was_closeable = true and now_closeable = false for any project, that'
\echo 'project could previously have been closed with an open gate outstanding.'
