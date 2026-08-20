-- =====================================================================
-- 2026_119_actions_handover_diagnostics.sql
--
-- Lets PROJECT diagnostics be persisted at all.
--
-- THE BUG
--   ActionPersister.FK_COLUMN.handover = 'deal_id', and
--   handover.service.runNightlySweep passes entityId: handoverRow.deal_id.
--   But sales_handovers_kind_shape_chk enforces that an INTERNAL project
--   has deal_id IS NULL.
--
--   So for every internal project the upsert targets
--       (deal_id, source_rule) WHERE deal_id IS NOT NULL
--   with deal_id NULL. The partial index does not apply, ON CONFLICT
--   matches nothing, and the alert is either dropped or silently
--   duplicated on each nightly run. Internal projects — SchematicIQ
--   included — are invisible to the diagnostic engine entirely.
--
--   This is not new design. Phase 109 already fixed the identical
--   problem for PLAY-derived actions: PlaybookPlayService branches on
--   deal_id vs handover_id, and 2026_110 added uq_actions_handover_play
--   as the mirror index. The DIAGNOSTIC path was simply never migrated,
--   and the stale comments in HandoverRulesEngine and syncScheduler
--   ("no handover_id FK exists on actions") date from before the column
--   was added.
--
-- WHAT THIS DOES
--   Adds uq_actions_handover_rule, the diagnostic mirror of
--   uq_actions_handover_play, so ActionPersister can target handover_id
--   for entityType 'project'.
--
-- ON EXISTING ROWS
--   Handover diagnostics currently sit on deal_id. They are BACKFILLED
--   with handover_id rather than moved: deal_id stays, so anything
--   reading them by deal keeps working, and the new index picks them up.
--   A customer project therefore carries both keys during the
--   transition, which is why the new index is on (handover_id,
--   source_rule) and cannot collide with the deal one.
--
-- Run AFTER 2026_118.
--   psql "$DATABASE_URL" -f 2026_119_actions_handover_diagnostics.sql
-- =====================================================================

BEGIN;

-- ── 1. Backfill handover_id on existing handover diagnostics ─────────
--
-- Matched through the deal: a diagnostic written by the handover sweep
-- carries the deal_id of the project it came from. Restricted to
-- handover_* source_rules so deal-side diagnostics are untouched.
UPDATE public.actions a
   SET handover_id = h.id
  FROM public.sales_handovers h
 WHERE a.handover_id IS NULL
   AND a.deal_id IS NOT NULL
   AND h.deal_id = a.deal_id
   AND h.org_id  = a.org_id
   AND a.source_rule LIKE 'handover\_%';

-- ── 2. The diagnostic mirror index ───────────────────────────────────
--
-- Same shape as uq_actions_deal_rule, keyed on handover_id. This is what
-- makes ON CONFLICT work for a project with no deal.
CREATE UNIQUE INDEX IF NOT EXISTS uq_actions_handover_rule
  ON public.actions (handover_id, source_rule)
  WHERE handover_id IS NOT NULL AND source_rule IS NOT NULL;

COMMIT;

-- ── Verification ─────────────────────────────────────────────────────

\echo ''
\echo '=== Index present? ==='
SELECT indexname FROM pg_indexes
 WHERE tablename = 'actions'
   AND indexname IN ('uq_actions_handover_rule', 'uq_actions_handover_play')
 ORDER BY indexname;

\echo ''
\echo '=== Handover diagnostics by key ==='
SELECT count(*) FILTER (WHERE handover_id IS NOT NULL) AS with_handover_id,
       count(*) FILTER (WHERE handover_id IS NULL)     AS still_deal_only,
       count(*)                                        AS total
  FROM public.actions
 WHERE source_rule LIKE 'handover\_%';

\echo ''
\echo '=== Internal projects — previously unreachable by diagnostics ==='
SELECT count(*) AS internal_projects
  FROM public.sales_handovers
 WHERE deal_id IS NULL;

\echo ''
\echo 'ActionPersister can now use entityType "project" -> handover_id.'
