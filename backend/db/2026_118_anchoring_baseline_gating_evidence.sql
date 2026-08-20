-- =====================================================================
-- 2026_118_anchoring_baseline_gating_evidence.sql
--
-- Four related changes, one migration because they touch the same two
-- tables and must land together:
--
--   1. 'project_start' due anchor
--   2. Baseline freeze on leaving draft
--   3. Stage-level gating (gate-only)
--   4. Evidence requirement config (org default, project override)
--
-- ─────────────────────────────────────────────────────────────────────
-- 1. THE ANCHORING BUG
--
--   computeInstanceDueDate() resolves due_anchor='created' as:
--       const dt = new Date();                       // TODAY
--       dt.setDate(dt.getDate() + (offsetDays || 3));
--
--   "Forward from the moment the row was inserted" — not from any
--   project milestone. A project drafted in July and started in
--   September opens with every task 20-30 days overdue against dates
--   that never meant anything. That is the state project 91 is in.
--
--   'go_live' already demonstrates the fix: it stores an offset and
--   resolves the date later, and 2026_109 even ships an index
--   (idx_ppi_go_live_anchored) for "plays awaiting a date". This adds
--   'project_start' on the same principle — resolve when the project
--   actually starts.
--
-- 2. WHY THE BASELINE MUST FREEZE
--
--   2026_111 gives every play baseline_due_date + baseline_source
--   ('original' | 'inferred' | 'rebaselined'), and planVariance measures
--   slip against it. Its backfill set existing rows to 'inferred'.
--
--   Without a freeze point, a draft project's baseline is whatever the
--   rows happened to contain, so Plan vs Actual reports slip against a
--   plan nobody committed to. Every newly drafted project starts broken.
--
--   The rule: while status = 'draft' the plan is PROVISIONAL — editing a
--   due date silently moves baseline_due_date with it, no rebaseline
--   recorded, no permission needed. Leaving draft freezes the current
--   dates as baseline_source = 'original'. After that, changing a date
--   is a tracked rebaseline (permission + reason), which is the
--   behaviour updatePlay already implements.
--
--   Freeze fires on leaving 'draft' — 'submitted' for customer projects,
--   'in_progress' for internal ones. NOT at 'in_progress' for both:
--   customer plans sit in submitted/acknowledged while the delivery team
--   reviews them, and that is precisely when the dates must stop moving.
--
-- 3. STAGE GATING IS GATE-ONLY
--
--   A stage is locked while an EARLIER stage still has an incomplete
--   is_gate task. Not "all tasks" — one forgotten checklist item should
--   not freeze a project, and is_gate already marks the steps that
--   genuinely matter.
--
--   Composes with 2026_117 task dependencies: a task is startable iff
--   its own prerequisites are clear AND its stage is unlocked.
--
-- 4. EVIDENCE CONFIG
--
--   Org default in organizations.settings.evidence (jsonb — same pattern
--   as settings.modules and settings.diagnostic_rules, both already
--   managed from Org Admin, so no column and no new convention).
--   Per-project override in sales_handovers.evidence_config.
--
--   Defaults: not required generally, REQUIRED for is_gate plays.
--
-- Run AFTER 2026_117.
--   psql "$DATABASE_URL" -f 2026_118_anchoring_baseline_gating_evidence.sql
-- =====================================================================

BEGIN;

-- ── 1. 'project_start' anchor ────────────────────────────────────────
--
-- Widened on BOTH tables. playbook_plays is the template a project
-- copies from; project_play_instances holds the copy. A value valid in
-- one and not the other would pass validation at authoring time and
-- fail at activation.
ALTER TABLE public.playbook_plays
  DROP CONSTRAINT IF EXISTS playbook_plays_due_anchor_check;
ALTER TABLE public.playbook_plays
  ADD CONSTRAINT playbook_plays_due_anchor_check
  CHECK (due_anchor::text = ANY (ARRAY['created', 'go_live', 'project_start']));

ALTER TABLE public.project_play_instances
  DROP CONSTRAINT IF EXISTS project_play_instances_due_anchor_check;
ALTER TABLE public.project_play_instances
  ADD CONSTRAINT project_play_instances_due_anchor_check
  CHECK (due_anchor::text = ANY (ARRAY['created', 'go_live', 'project_start']));

COMMENT ON COLUMN public.project_play_instances.due_anchor IS
  'created = offset from row insertion (legacy; the source of phantom '
  'overdue on unstarted projects). go_live = signed offset from the '
  'project go-live date. project_start = offset from started_at, '
  'resolved when the project leaves draft.';

-- Mirror of idx_ppi_go_live_anchored: find plays whose date is still
-- unresolved because the project has not started.
CREATE INDEX IF NOT EXISTS idx_ppi_project_start_anchored
  ON public.project_play_instances (handover_id)
  WHERE due_anchor = 'project_start'
    AND status <> ALL (ARRAY['completed', 'skipped']);

-- ── 2. Baseline freeze ───────────────────────────────────────────────
ALTER TABLE public.sales_handovers
  ADD COLUMN IF NOT EXISTS started_at        timestamptz,
  ADD COLUMN IF NOT EXISTS baseline_frozen_at timestamptz;

COMMENT ON COLUMN public.sales_handovers.started_at IS
  'When the project left draft. Anchor date for due_anchor = '
  'project_start.';
COMMENT ON COLUMN public.sales_handovers.baseline_frozen_at IS
  'When the plan stopped being provisional. NULL = still in draft, due '
  'date edits move baseline_due_date silently. Set = every later date '
  'change is a tracked rebaseline.';

-- Projects already past draft are treated as frozen: their plan has been
-- acted on, so retroactively making it editable would let historical
-- slip be erased. created_at stands in for started_at, which was never
-- recorded.
UPDATE public.sales_handovers
   SET baseline_frozen_at = COALESCE(baseline_frozen_at, created_at),
       started_at         = COALESCE(started_at, created_at)
 WHERE status <> 'draft';

-- ── 3. Stage gating ──────────────────────────────────────────────────
ALTER TABLE public.project_stages
  ADD COLUMN IF NOT EXISTS gating text NOT NULL DEFAULT 'none';

ALTER TABLE public.project_stages
  DROP CONSTRAINT IF EXISTS project_stages_gating_chk;
ALTER TABLE public.project_stages
  ADD CONSTRAINT project_stages_gating_chk
  CHECK (gating IN ('none', 'gates', 'strict'));

COMMENT ON COLUMN public.project_stages.gating IS
  'How this stage is locked by earlier stages. none = never locked '
  '(default, so existing projects are unaffected). gates = locked while '
  'an earlier stage has an incomplete is_gate task. strict = locked '
  'while an earlier stage has ANY incomplete task.';

-- ── 4. Evidence config ───────────────────────────────────────────────
ALTER TABLE public.sales_handovers
  ADD COLUMN IF NOT EXISTS evidence_config jsonb;

COMMENT ON COLUMN public.sales_handovers.evidence_config IS
  'Per-project override of the org default in '
  'organizations.settings.evidence. Keys: required (bool), '
  'requiredForGates (bool). NULL = inherit the org setting.';

-- Org default, only where an org has not already configured one.
UPDATE public.organizations
   SET settings = jsonb_set(
         COALESCE(settings, '{}'::jsonb), '{evidence}',
         '{"required": false, "requiredForGates": true}'::jsonb, true)
 WHERE settings->'evidence' IS NULL;

COMMIT;

-- ── Verification ─────────────────────────────────────────────────────

\echo ''
\echo '=== New columns ==='
SELECT table_name, column_name
  FROM information_schema.columns
 WHERE (table_name = 'sales_handovers'
        AND column_name IN ('started_at','baseline_frozen_at','evidence_config'))
    OR (table_name = 'project_stages' AND column_name = 'gating')
 ORDER BY table_name, column_name;

\echo ''
\echo '=== project_start anchor now accepted? ==='
DO $$
BEGIN
  BEGIN
    UPDATE public.project_play_instances SET due_anchor = 'project_start'
     WHERE id = (SELECT min(id) FROM public.project_play_instances);
    RAISE NOTICE 'OK - project_start accepted';
    UPDATE public.project_play_instances SET due_anchor = 'created'
     WHERE id = (SELECT min(id) FROM public.project_play_instances);
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'FAIL - constraint still rejects project_start';
  END;
END $$;

\echo ''
\echo '=== Baseline freeze state by project ==='
SELECT status,
       count(*)                                        AS projects,
       count(*) FILTER (WHERE baseline_frozen_at IS NULL) AS still_provisional
  FROM public.sales_handovers
 GROUP BY status ORDER BY status;

\echo ''
\echo '=== Orgs with evidence defaults ==='
SELECT count(*) FILTER (WHERE settings->'evidence' IS NOT NULL) AS configured,
       count(*)                                                 AS total
  FROM public.organizations;

\echo ''
\echo 'Draft projects remain provisional: date edits move the baseline silently.'
\echo 'Leaving draft freezes the plan as baseline_source = original.'
