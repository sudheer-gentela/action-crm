-- ═══════════════════════════════════════════════════════════════════════════
-- test_trigger_70c.sql — proves 2026_70c behaves correctly, then ROLLS BACK.
--
-- Writes nothing permanent. Every statement runs inside a transaction that ends
-- in ROLLBACK, so it is safe against production. Run it AFTER applying 70c.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f test_trigger_70c.sql
--
-- Read the expectation comment above each case and compare to the row returned.
-- Six cases; all six must match.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- Case A — the Salesforce shape: completed + completed_at supplied, no status.
-- EXPECT status='completed', completed=true, completed_at='2026-01-15 10:00:00'
--        (the supplied date, NOT now() — an imported date must be preserved)
INSERT INTO actions (org_id, title, completed, completed_at, source)
VALUES ((SELECT id FROM organizations ORDER BY id LIMIT 1),
        'TEST-70C-A', true, '2026-01-15 10:00:00', 'salesforce_task')
RETURNING 'A: sf completed import' AS case, status, completed, completed_at;

-- Case B — nothing supplied. EXPECT status='not_started', completed=false,
--          completed_at IS NULL
INSERT INTO actions (org_id, title)
VALUES ((SELECT id FROM organizations ORDER BY id LIMIT 1), 'TEST-70C-B')
RETURNING 'B: bare insert' AS case, status, completed, completed_at;

-- Case C — status='completed' supplied, completed omitted.
-- EXPECT completed=true, completed_at stamped to roughly now()
INSERT INTO actions (org_id, title, status)
VALUES ((SELECT id FROM organizations ORDER BY id LIMIT 1), 'TEST-70C-C', 'completed')
RETURNING 'C: explicit completed status' AS case, status, completed, completed_at;

-- Case D — completed=false supplied alongside status='completed'.
-- EXPECT status wins on the ELSE branch: completed=true
INSERT INTO actions (org_id, title, status, completed)
VALUES ((SELECT id FROM organizations ORDER BY id LIMIT 1), 'TEST-70C-D', 'completed', false)
RETURNING 'D: status beats false flag' AS case, status, completed;

-- Case E — complete B via UPDATE. EXPECT completed=true, completed_at stamped
UPDATE actions SET status = 'completed'
 WHERE title = 'TEST-70C-B'
RETURNING 'E: update to completed' AS case, status, completed, completed_at;

-- Case F — reopen it. EXPECT completed=false AND completed_at back to NULL
--          (this is the problem-2 fix; before 70c completed_at stayed set)
UPDATE actions SET status = 'not_started'
 WHERE title = 'TEST-70C-B'
RETURNING 'F: reopen clears stamp' AS case, status, completed, completed_at;

-- Case G — regression guard: no test row is left desynced.
-- EXPECT 0
SELECT count(*) AS desynced_test_rows
  FROM actions
 WHERE title LIKE 'TEST-70C-%'
   AND completed IS DISTINCT FROM (status = 'completed');

ROLLBACK;

-- ───────────────────────────────────────────────────────────────────────────
-- Confirm the rollback worked. Must return 0 rows.
-- ───────────────────────────────────────────────────────────────────────────
SELECT count(*) AS leftover_test_rows FROM actions WHERE title LIKE 'TEST-70C-%';
