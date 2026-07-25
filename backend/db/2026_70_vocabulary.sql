-- ═══════════════════════════════════════════════════════════════════════════
-- 2026_70_vocabulary.sql
--
-- Canonical status vocabulary + org-configurable display labels.
--   not_started | in_progress | blocked | snoozed | completed | skipped | cancelled
--
-- Scope: actions, deal_play_instances, case_plays, contract_play_instances.
-- prospecting_actions is EXCLUDED — see §0 note.
--
-- Also fixes: B8 (unconstrained play status), B14 (completed/status desync),
-- B4 (unused jsonb suggestion arrays), gate/overdue filters in the rollup view.
--
-- Affects ~271 rows. Safe to run in one transaction.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- §0. PRE-FLIGHT — run these first and eyeball the output before committing.
--     If any row appears that the mapping below doesn't handle, ROLLBACK.
-- ───────────────────────────────────────────────────────────────────────────
-- SELECT 'actions' t, status, count(*) FROM actions GROUP BY 1,2
-- UNION ALL SELECT 'dpi', status, count(*) FROM deal_play_instances GROUP BY 1,2
-- UNION ALL SELECT 'case_plays', status, count(*) FROM case_plays GROUP BY 1,2
-- UNION ALL SELECT 'cpi', status, count(*) FROM contract_play_instances GROUP BY 1,2;
--
-- NOTE ON prospecting_actions: its CHECK allows an extra value, 'failed'
-- (chk_paction_status: pending|in_progress|completed|skipped|failed|snoozed).
-- 'failed' is meaningful for automated outreach and meaningless for handover
-- plays. Per D19 prospecting is deliberately a separate table, so it keeps its
-- own vocabulary and is mapped to canonical at the unified-view boundary only.
-- Decide explicitly before folding it in.


-- ───────────────────────────────────────────────────────────────────────────
-- §1. Drop old constraints so the data can move.
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE actions                  DROP CONSTRAINT IF EXISTS actions_status_check;
ALTER TABLE case_plays               DROP CONSTRAINT IF EXISTS case_plays_status_check;
ALTER TABLE contract_play_instances  DROP CONSTRAINT IF EXISTS contract_play_instances_status_check;
-- deal_play_instances has no status constraint at all (B8) — nothing to drop.


-- ───────────────────────────────────────────────────────────────────────────
-- §2. Normalize values.
--
--   Play semantics (from PlaybookPlayService):
--     'active'  = fired, ready to work        → not_started
--     'pending' = waiting on dependencies     → blocked
-- ───────────────────────────────────────────────────────────────────────────

-- actions: yet_to_start(216) in_progress(8) completed(18)
UPDATE actions SET status = 'not_started' WHERE status = 'yet_to_start';

-- deal_play_instances: active(18) pending(1) completed(10)
UPDATE deal_play_instances SET status = 'not_started' WHERE status = 'active';
UPDATE deal_play_instances SET status = 'blocked'     WHERE status = 'pending';

-- case_plays / contract_play_instances: currently 0 rows, but map defensively
-- so the statements are correct if data lands before this runs.
UPDATE case_plays              SET status = 'not_started' WHERE status IN ('pending','active');
UPDATE contract_play_instances SET status = 'not_started' WHERE status = 'active';
UPDATE contract_play_instances SET status = 'blocked'     WHERE status = 'pending';


-- ───────────────────────────────────────────────────────────────────────────
-- §3. B14 — reconcile actions.completed with actions.status.
--     One row currently has status='completed' AND completed=false.
--     Status becomes the single source of truth; completed is derived.
-- ───────────────────────────────────────────────────────────────────────────
UPDATE actions SET completed = true  WHERE status = 'completed' AND completed IS DISTINCT FROM true;
UPDATE actions SET completed = false WHERE status <> 'completed' AND completed IS DISTINCT FROM false;

CREATE OR REPLACE FUNCTION sync_action_completed() RETURNS trigger AS $$
BEGIN
  NEW.completed := (NEW.status = 'completed');
  IF NEW.status = 'completed' AND NEW.completed_at IS NULL THEN
    NEW.completed_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_action_completed ON actions;
CREATE TRIGGER trg_sync_action_completed
  BEFORE INSERT OR UPDATE OF status ON actions
  FOR EACH ROW EXECUTE FUNCTION sync_action_completed();


-- ───────────────────────────────────────────────────────────────────────────
-- §4. Apply canonical constraints. B8 closes here.
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE actions
  ADD CONSTRAINT actions_status_check CHECK (status IN
    ('not_started','in_progress','blocked','snoozed','completed','skipped','cancelled'));

ALTER TABLE deal_play_instances
  ALTER COLUMN status SET DEFAULT 'not_started',
  ADD CONSTRAINT deal_play_instances_status_check CHECK (status IN
    ('not_started','in_progress','blocked','snoozed','completed','skipped','cancelled'));

ALTER TABLE case_plays
  ALTER COLUMN status SET DEFAULT 'not_started',
  ADD CONSTRAINT case_plays_status_check CHECK (status IN
    ('not_started','in_progress','blocked','snoozed','completed','skipped','cancelled'));

ALTER TABLE contract_play_instances
  ALTER COLUMN status SET DEFAULT 'not_started',
  ADD CONSTRAINT contract_play_instances_status_check CHECK (status IN
    ('not_started','in_progress','blocked','snoozed','completed','skipped','cancelled'));


-- ───────────────────────────────────────────────────────────────────────────
-- §5. Org-configurable DISPLAY labels.
--
--     HARD RULE: the canonical set is CLOSED. Orgs relabel; they never add,
--     remove or merge states. Every CHECK, view, query and the extraction
--     skill depend on the canonical values. Labels are presentation only and
--     are applied at the API serialization boundary, never in a WHERE clause.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS org_status_labels (
  id                bigserial PRIMARY KEY,
  org_id            integer NOT NULL,
  entity_class      text    NOT NULL,   -- action | play | commitment
  canonical_status  text    NOT NULL,
  display_label     text    NOT NULL,
  display_order     integer NOT NULL DEFAULT 0,
  color             text,
  is_hidden         boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, entity_class, canonical_status),
  CONSTRAINT osl_entity_chk CHECK (entity_class IN ('action','play','commitment')),
  CONSTRAINT osl_status_chk CHECK (
    (entity_class IN ('action','play') AND canonical_status IN
      ('not_started','in_progress','blocked','snoozed','completed','skipped','cancelled'))
    OR
    (entity_class = 'commitment' AND canonical_status IN
      ('open','in_progress','met','waived','breached'))
  )
);

CREATE INDEX IF NOT EXISTS idx_org_status_labels_lookup
  ON org_status_labels (org_id, entity_class);

COMMENT ON TABLE org_status_labels IS
  'Per-org display labels for the CLOSED canonical status vocabulary. '
  'Relabelling only — orgs cannot add, remove or merge states. '
  'Applied at API serialization; never used in query predicates.';

-- Seed defaults for every existing org, for action + play.
INSERT INTO org_status_labels (org_id, entity_class, canonical_status, display_label, display_order)
SELECT o.id, ec.entity_class, d.canonical_status, d.display_label, d.display_order
  FROM organizations o
  CROSS JOIN (VALUES ('action'), ('play')) AS ec(entity_class)
  CROSS JOIN (VALUES
      ('not_started', 'Not Started', 10),
      ('in_progress', 'In Progress', 20),
      ('blocked',     'Blocked',     30),
      ('snoozed',     'Snoozed',     40),
      ('completed',   'Completed',   50),
      ('skipped',     'Skipped',     60),
      ('cancelled',   'Cancelled',   70)
  ) AS d(canonical_status, display_label, display_order)
ON CONFLICT (org_id, entity_class, canonical_status) DO NOTHING;

-- Commitments keep their own terminal vocabulary (met/waived/breached carry
-- meaning that must not be flattened) but are relabellable on the same basis.
INSERT INTO org_status_labels (org_id, entity_class, canonical_status, display_label, display_order)
SELECT o.id, 'commitment', d.canonical_status, d.display_label, d.display_order
  FROM organizations o
  CROSS JOIN (VALUES
      ('open',        'Open',        10),
      ('in_progress', 'In Progress', 20),
      ('met',         'Met',         30),
      ('waived',      'Waived',      40),
      ('breached',    'Breached',    50)
  ) AS d(canonical_status, display_label, display_order)
ON CONFLICT (org_id, entity_class, canonical_status) DO NOTHING;


-- ───────────────────────────────────────────────────────────────────────────
-- §6. B4 — drop the unused jsonb suggestion arrays (confirmed 0 rows use them).
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE actions
  DROP COLUMN IF EXISTS pending_suggestions,
  DROP COLUMN IF EXISTS dismissed_suggestions;


-- ───────────────────────────────────────────────────────────────────────────
-- §7. Rebuild handover_deliverable_rollup for the new vocabulary.
--
--     Two real fixes beyond the rename:
--       - 'cancelled' now clears a gate. An abandoned deliverable must not
--         block closure forever.
--       - 'snoozed' no longer counts as overdue. Deliberate deferral is not
--         the same as slipping.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW handover_deliverable_rollup AS
SELECT h.id AS handover_id,
       h.org_id,
       h.status,
       h.go_live_date,
       (h.go_live_date - CURRENT_DATE) AS days_to_go_live,

       count(DISTINCT dpi.id) AS plays_total,

       count(DISTINCT dpi.id) FILTER (
         WHERE dpi.status IN ('completed','skipped','cancelled')
       ) AS plays_done,

       count(DISTINCT dpi.id) FILTER (
         WHERE dpi.status NOT IN ('completed','skipped','cancelled','snoozed')
           AND dpi.due_date < CURRENT_DATE
       ) AS plays_overdue,

       count(DISTINCT dpi.id) FILTER (
         WHERE dpi.is_gate
           AND dpi.status NOT IN ('completed','skipped','cancelled')
       ) AS gates_open,

       count(DISTINCT c.id) AS commitments_total,

       count(DISTINCT c.id) FILTER (
         WHERE c.status IN ('met','waived','breached')
       ) AS commitments_closed,

       count(DISTINCT c.id) FILTER (
         WHERE c.status IN ('open','in_progress') AND c.due_date < CURRENT_DATE
       ) AS commitments_overdue,

       count(DISTINCT c.id) FILTER (WHERE c.status = 'breached') AS commitments_breached,

       (count(DISTINCT dpi.id) FILTER (
          WHERE dpi.is_gate AND dpi.status NOT IN ('completed','skipped','cancelled')) = 0
        AND
        count(DISTINCT c.id) FILTER (
          WHERE c.status IN ('open','in_progress')) = 0
       ) AS is_closeable

  FROM sales_handovers h
  LEFT JOIN sales_handover_plays       shp ON shp.handover_id = h.id
  LEFT JOIN deal_play_instances        dpi ON dpi.id = shp.play_instance_id
  LEFT JOIN sales_handover_commitments c   ON c.handover_id = h.id
 GROUP BY h.id, h.org_id, h.status, h.go_live_date;

COMMENT ON VIEW handover_deliverable_rollup IS
  'Per-handover deliverable aggregate: play + commitment counts, overdue counts, '
  'and is_closeable. Read by handover.service.list() and canClose(). '
  'Canonical status vocabulary as of 2026_70.';


-- ───────────────────────────────────────────────────────────────────────────
-- §8. Deactivate the superseded 'handovers' playbook type (handover_s2i is
--     canonical). Keeps the rows for history; stops them being instantiated.
-- ───────────────────────────────────────────────────────────────────────────
UPDATE playbook_plays pp
   SET is_active = false
  FROM playbooks p
 WHERE p.id = pp.playbook_id
   AND p.type = 'handovers'
   AND pp.is_active = true;


-- ───────────────────────────────────────────────────────────────────────────
-- §9. VERIFY before COMMIT. All three should return zero rows.
-- ───────────────────────────────────────────────────────────────────────────
-- SELECT 'actions' t, status, count(*) FROM actions
--   WHERE status NOT IN ('not_started','in_progress','blocked','snoozed','completed','skipped','cancelled')
--   GROUP BY 1,2;
-- SELECT count(*) FROM actions WHERE completed <> (status = 'completed');
-- SELECT handover_id, gates_open, is_closeable FROM handover_deliverable_rollup;

COMMIT;
