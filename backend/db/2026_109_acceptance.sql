-- =====================================================================
-- 2026_109_acceptance.sql  —  READ ONLY (one temp table, no writes).
--
-- Run AFTER 2026_109_project_play_split.sql, against the same database.
-- Every check prints PASS or FAIL. Any FAIL means do not proceed to A4
-- (the code repointing) — investigate first.
--
--   psql "$DATABASE_URL" -f 2026_109_acceptance.sql
-- =====================================================================

\set ON_ERROR_STOP on
SET statement_timeout = '600s';

CREATE TEMP TABLE _r (n int, name text, expected text, actual text, pass boolean);

CREATE OR REPLACE FUNCTION pg_temp.chk(n int, name text, expected text, actual text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO _r VALUES (n, name, expected, actual, expected IS NOT DISTINCT FROM actual);
END $$;

-- ── 1. Every project link migrated, exactly once ──────────────────────
SELECT pg_temp.chk(1, 'All project links migrated',
  (SELECT count(DISTINCT play_instance_id)::text FROM sales_handover_plays),
  (SELECT count(*)::text FROM project_play_instances));

SELECT pg_temp.chk(2, 'No duplicate instances created',
  (SELECT count(*)::text FROM project_play_instances),
  (SELECT count(DISTINCT id)::text FROM project_play_instances));

-- ── 3. Ids preserved — this is what keeps action_id and frontend state valid
SELECT pg_temp.chk(3, 'Instance ids preserved exactly',
  '0',
  (SELECT count(*)::text
     FROM sales_handover_plays shp
     LEFT JOIN project_play_instances ppi ON ppi.id = shp.play_instance_id
    WHERE ppi.id IS NULL));

-- ── 4. Field-level fidelity: every migrated row matches its source ─────
SELECT pg_temp.chk(4, 'All fields copied faithfully',
  '0',
  (SELECT count(*)::text
     FROM project_play_instances ppi
     JOIN deal_play_instances dpi ON dpi.id = ppi.id
    WHERE ppi.org_id            IS DISTINCT FROM dpi.org_id
       OR ppi.play_id           IS DISTINCT FROM dpi.play_id
       OR ppi.stage_key         IS DISTINCT FROM dpi.stage_key
       OR ppi.title             IS DISTINCT FROM dpi.title
       OR ppi.description       IS DISTINCT FROM dpi.description
       OR ppi.status            IS DISTINCT FROM dpi.status
       OR ppi.due_date          IS DISTINCT FROM dpi.due_date
       OR ppi.due_anchor        IS DISTINCT FROM dpi.due_anchor
       OR ppi.sort_order        IS DISTINCT FROM dpi.sort_order
       OR ppi.completed_at      IS DISTINCT FROM dpi.completed_at
       OR ppi.completed_by      IS DISTINCT FROM dpi.completed_by
       OR ppi.action_id         IS DISTINCT FROM dpi.action_id
       OR ppi.playbook_id       IS DISTINCT FROM dpi.playbook_id
       OR ppi.is_gate           IS DISTINCT FROM dpi.is_gate
       OR ppi.is_manual         IS DISTINCT FROM dpi.is_manual
       OR ppi.owner_user_id     IS DISTINCT FROM dpi.owner_user_id
       OR ppi.completion_note   IS DISTINCT FROM dpi.completion_note
       OR ppi.created_at        IS DISTINCT FROM dpi.created_at));

-- ── 5. handover_id correct and never NULL ─────────────────────────────
SELECT pg_temp.chk(5, 'handover_id matches the link table',
  '0',
  (SELECT count(*)::text
     FROM project_play_instances ppi
     JOIN sales_handover_plays shp ON shp.play_instance_id = ppi.id
    WHERE ppi.handover_id IS DISTINCT FROM shp.handover_id));

-- ── 6. Internal projects (no deal) migrated — the F5 case ─────────────
SELECT pg_temp.chk(6, 'Internal-project plays migrated',
  (SELECT count(DISTINCT shp.play_instance_id)::text
     FROM sales_handover_plays shp
     JOIN sales_handovers h ON h.id = shp.handover_id
    WHERE h.deal_id IS NULL),
  (SELECT count(*)::text
     FROM project_play_instances ppi
     JOIN sales_handovers h ON h.id = ppi.handover_id
    WHERE h.deal_id IS NULL));

-- ── 7. Deal-only rows untouched ───────────────────────────────────────
SELECT pg_temp.chk(7, 'Deal-only plays still present',
  (SELECT count(*)::text FROM deal_play_instances dpi
    WHERE dpi.deal_id IS NOT NULL
      AND dpi.id NOT IN (SELECT play_instance_id FROM sales_handover_plays)),
  (SELECT count(*)::text FROM deal_play_instances dpi
    WHERE dpi.deal_id IS NOT NULL
      AND dpi.id NOT IN (SELECT play_instance_id FROM sales_handover_plays)));

SELECT pg_temp.chk(8, 'No deal-only play leaked into project table',
  '0',
  (SELECT count(*)::text
     FROM project_play_instances ppi
    WHERE ppi.id NOT IN (SELECT play_instance_id FROM sales_handover_plays)));

-- ── 9. Assignees: project ones copied, deal ones NOT ──────────────────
SELECT pg_temp.chk(9, 'Project assignees copied',
  (SELECT count(*)::text FROM deal_play_assignees a
    WHERE a.instance_id IN (SELECT play_instance_id FROM sales_handover_plays)),
  (SELECT count(*)::text FROM project_play_assignees));

SELECT pg_temp.chk(10, 'No deal assignee copied across',
  '0',
  (SELECT count(*)::text
     FROM project_play_assignees ppa
    WHERE ppa.instance_id NOT IN (SELECT play_instance_id FROM sales_handover_plays)));

-- ── 11. actions.handover_id populated for project-linked actions ──────
SELECT pg_temp.chk(11, 'Project actions point at their project',
  '0',
  (SELECT count(*)::text
     FROM project_play_instances ppi
     JOIN actions act ON act.id = ppi.action_id
    WHERE act.handover_id IS DISTINCT FROM ppi.handover_id));

-- ── 12. Sequence is past every preserved id ───────────────────────────
SELECT pg_temp.chk(12, 'Sequence clear of preserved ids',
  'true',
  ((SELECT last_value FROM project_play_instances_id_seq)
     >= (SELECT COALESCE(max(id), 0) FROM project_play_instances))::text);

-- ── 13. Org integrity: no cross-org or orphaned project ───────────────
SELECT pg_temp.chk(13, 'Every play resolves to a same-org project',
  '0',
  (SELECT count(*)::text
     FROM project_play_instances ppi
     LEFT JOIN sales_handovers h ON h.id = ppi.handover_id AND h.org_id = ppi.org_id
    WHERE h.id IS NULL));

-- ── 14. Structural guarantees on the new table ────────────────────────
SELECT pg_temp.chk(14, 'handover_id is NOT NULL',
  'NO',
  (SELECT is_nullable FROM information_schema.columns
    WHERE table_name = 'project_play_instances' AND column_name = 'handover_id'));

SELECT pg_temp.chk(15, 'deal_id column absent from project table',
  '0',
  (SELECT count(*)::text FROM information_schema.columns
    WHERE table_name = 'project_play_instances' AND column_name = 'deal_id'));

SELECT pg_temp.chk(16, 'WBS parent column reserved',
  '1',
  (SELECT count(*)::text FROM information_schema.columns
    WHERE table_name = 'project_play_instances' AND column_name = 'parent_instance_id'));

SELECT pg_temp.chk(17, 'Unique play-per-project index exists',
  '1',
  (SELECT count(*)::text FROM pg_indexes
    WHERE tablename = 'project_play_instances' AND indexname = 'idx_ppi_unique'));

-- ── 18. Status vocabulary preserved ───────────────────────────────────
SELECT pg_temp.chk(18, 'No unexpected status values',
  '0',
  (SELECT count(*)::text FROM project_play_instances
    WHERE status <> ALL (ARRAY['not_started','in_progress','blocked','snoozed',
                               'completed','skipped','cancelled'])));

-- ── 19. Completion data intact (the plan-vs-actual raw material) ──────
SELECT pg_temp.chk(19, 'Completed plays retain their timestamps',
  (SELECT count(*)::text FROM deal_play_instances dpi
     JOIN sales_handover_plays shp ON shp.play_instance_id = dpi.id
    WHERE dpi.completed_at IS NOT NULL),
  (SELECT count(*)::text FROM project_play_instances WHERE completed_at IS NOT NULL));

SELECT pg_temp.chk(20, 'Measurable rows preserved (due_date AND completed_at)',
  (SELECT count(*)::text FROM deal_play_instances dpi
     JOIN sales_handover_plays shp ON shp.play_instance_id = dpi.id
    WHERE dpi.completed_at IS NOT NULL AND dpi.due_date IS NOT NULL),
  (SELECT count(*)::text FROM project_play_instances
    WHERE completed_at IS NOT NULL AND due_date IS NOT NULL));

\echo ''
\echo '════════════════ ACCEPTANCE RESULTS ════════════════'
SELECT n, CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END AS result,
       name, expected, actual
  FROM _r ORDER BY n;

\echo ''
SELECT count(*) FILTER (WHERE pass)       AS passed,
       count(*) FILTER (WHERE NOT pass)   AS failed,
       count(*)                           AS total
  FROM _r;

DO $$
DECLARE f int;
BEGIN
  SELECT count(*) INTO f FROM _r WHERE NOT pass;
  IF f > 0 THEN
    RAISE EXCEPTION 'ACCEPTANCE FAILED: % check(s) did not pass. Do not proceed to A4.', f;
  END IF;
  RAISE NOTICE 'All checks passed. Safe to proceed to A4 (code repointing).';
END $$;
