-- =====================================================================
-- 2026_116_project_stages_authoritative.sql
--
-- Makes project_stages the SINGLE source of truth for a project's stages.
--
-- WHY THIS SUPERSEDES 2026_115's DESIGN
--   2026_115 shipped with COALESCE(playbook_stages.sort_order,
--   project_stages.sort_order) — playbook wins, project fills gaps. Two
--   problems with that, found after it was already deployed:
--
--   1. playbook_stages is DEAD. The only write endpoint for it
--      (orgAdmin PUT /playbooks/:id/stages) begins with an unconditional
--      `return res.status(400)` — the INSERT below that line is
--      unreachable. Its own comment says stages are managed org-wide via
--      pipeline_stages. The sole surviving writer is the internal-project
--      seed in 2026_91. So the COALESCE's high-precedence branch is empty
--      for essentially every project, and the "playbook wins" rule that
--      shaped the whole design never actually fires.
--
--   2. Precedence logic has to be repeated identically in every reader —
--      _getPlays, planVariance, and anything added later. It was already
--      got wrong once (project-local stages collided with playbook
--      sort_order values, which testing caught only because a fixture
--      happened to cover the mixed case). A rule duplicated across
--      queries drifts; a single join cannot.
--
-- THE MODEL
--   Mirror what this codebase already does for PLAYS. playbook_plays is
--   the template; project_play_instances is a materialized per-project
--   copy. That is why a project owns its plays, why editing a template
--   does not rewrite live projects, and why per-project deviation is
--   free. Stages now work identically:
--
--       pipeline_stages        (org-wide catalogue — the template)
--               |
--               |  copied when a project is created / gets a playbook
--               v
--       project_stages         (this project's stages — AUTHORITATIVE)
--
--   Readers do a plain LEFT JOIN to project_stages. No COALESCE anywhere.
--
--   The two playbook types requested fall out of this for free:
--     • org-wide reusable  -> materialized from pipeline_stages
--     • per-project custom -> rows created directly, source='custom'
--   Same table, same queries, distinguished only for provenance.
--
-- TRADE-OFF, STATED EXPLICITLY
--   Renaming a stage in the org catalogue no longer propagates to
--   projects that already exist. That is intentional and consistent with
--   plays: a plan of record should not be relabelled underneath a running
--   project. New projects pick up the change.
--
-- Run AFTER 2026_115.
--   psql "$DATABASE_URL" -f 2026_116_project_stages_authoritative.sql
-- =====================================================================

BEGIN;

-- ── 1. Provenance ────────────────────────────────────────────────────
ALTER TABLE public.project_stages
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'custom';

ALTER TABLE public.project_stages
  DROP CONSTRAINT IF EXISTS project_stages_source_chk;
ALTER TABLE public.project_stages
  ADD CONSTRAINT project_stages_source_chk
  CHECK (source IN ('catalogue', 'custom'));

COMMENT ON COLUMN public.project_stages.source IS
  'catalogue = materialized from pipeline_stages at project creation; '
  'custom = created directly on this project. Provenance only — it does '
  'not affect resolution, because this table is authoritative either way.';

-- ── 2. Complete the backfill ─────────────────────────────────────────
--
-- 2026_115 deliberately SKIPPED two classes of stage_key, because under
-- the old precedence another table was expected to supply them:
--
--   (b) keys owned by the project's playbook -> playbook_stages
--   (c) 'custom'                             -> frontend STAGE_LABELS
--
-- Neither holds now. project_stages is authoritative, so a key it does
-- not define resolves to NULL and sorts last. Both classes must be
-- materialized or projects lose stage names and ordering they had
-- before this migration.

-- 2a. Keys the playbook owned (only ever populated for internal-project
--     playbooks via 2026_91, but those projects are real and must not
--     regress). Ordering and names come straight from playbook_stages.
INSERT INTO public.project_stages (handover_id, org_id, key, name, sort_order, source)
SELECT DISTINCT
       dpi.handover_id,
       dpi.org_id,
       dpi.stage_key,
       ps.name,
       ps.sort_order,
       'catalogue'
  FROM public.project_play_instances dpi
  JOIN public.sales_handovers h  ON h.id = dpi.handover_id
  JOIN public.playbook_stages ps ON ps.playbook_id = h.playbook_id
                                AND ps.key = dpi.stage_key
                                AND ps.is_active = TRUE
 WHERE dpi.stage_key IS NOT NULL
   AND btrim(dpi.stage_key) <> ''
ON CONFLICT (handover_id, key) DO NOTHING;

-- 2b. Keys that match the org's pipeline catalogue.
--
--     Resolves pipeline from playbooks.type using the same legacy mapping
--     as playbook-plays.routes.js: sales/custom/market/product all mean
--     the 'sales' pipeline; everything else is its own type. Keeping
--     these in step matters — if this mapping and that one disagree, a
--     stage validates on create but fails to resolve on read.
INSERT INTO public.project_stages (handover_id, org_id, key, name, sort_order, source)
SELECT DISTINCT
       dpi.handover_id,
       dpi.org_id,
       dpi.stage_key,
       pls.name,
       pls.sort_order,
       'catalogue'
  FROM public.project_play_instances dpi
  JOIN public.sales_handovers h ON h.id = dpi.handover_id
  JOIN public.playbooks pb      ON pb.id = h.playbook_id
  JOIN public.pipeline_stages pls
       ON pls.org_id = dpi.org_id
      AND pls.key    = dpi.stage_key
      AND pls.is_active = TRUE
      AND pls.pipeline = CASE
            WHEN pb.type IN ('sales','custom','market','product') THEN 'sales'
            ELSE pb.type
          END
 WHERE dpi.stage_key IS NOT NULL
   AND btrim(dpi.stage_key) <> ''
ON CONFLICT (handover_id, key) DO NOTHING;

-- 2c. 'custom' — the ad-hoc bucket.
--
--     2026_115 skipped this so the frontend's STAGE_LABELS could keep
--     labelling it "Added on this project". With project_stages
--     authoritative that fallback is no longer reachable, so the name is
--     materialized here VERBATIM to preserve the existing UI label. Do
--     not "tidy" this to 'Custom' — that changes what users see.
--
--     9000 keeps it after every real stage, matching groupPlaysByStage's
--     hard rule that ad-hoc items sort last.
INSERT INTO public.project_stages (handover_id, org_id, key, name, sort_order, source)
SELECT DISTINCT dpi.handover_id, dpi.org_id, 'custom',
       'Added on this project', 9000, 'custom'
  FROM public.project_play_instances dpi
 WHERE dpi.stage_key = 'custom'
ON CONFLICT (handover_id, key) DO NOTHING;

-- 2d. Anything still undefined. By this point a key with no row has no
--     definition anywhere, so prettify it the way the frontend used to
--     and place it after the known stages rather than losing it.
INSERT INTO public.project_stages (handover_id, org_id, key, name, sort_order, source)
SELECT s.handover_id, s.org_id, s.stage_key,
       initcap(replace(replace(s.stage_key, '_', ' '), '-', ' ')),
       8000 + (s.seq * 10),
       'custom'
  FROM (
    SELECT dpi.handover_id, dpi.org_id, dpi.stage_key,
           row_number() OVER (PARTITION BY dpi.handover_id ORDER BY min(dpi.id)) AS seq
      FROM public.project_play_instances dpi
      LEFT JOIN public.project_stages pst
             ON pst.handover_id = dpi.handover_id AND pst.key = dpi.stage_key
     WHERE pst.id IS NULL
       AND dpi.stage_key IS NOT NULL
       AND btrim(dpi.stage_key) <> ''
     GROUP BY dpi.handover_id, dpi.org_id, dpi.stage_key
  ) s
ON CONFLICT (handover_id, key) DO NOTHING;

-- ── 3. Let the catalogue correct 2026_115's guesses ─────────────────
--
-- 2026_115 ran before pipeline_stages was known to be the live catalogue, so
-- where it found no definition it GUESSED: name prettified from the key,
-- sort_order derived from when the stage was first used. Those guesses were
-- the best available then. They are not now — if the org catalogue defines
-- the key, it has the real name and the real running order.
--
-- Without this the guesses win, because every INSERT above uses ON CONFLICT
-- DO NOTHING. Testing caught exactly that: a delivery project came out as
-- Signoff -> Mobilize -> Installation -> Groundwork -> Finishing (the order
-- its plays happened to be created in) instead of the catalogue's
-- Mobilization -> Groundwork -> Installation -> Finishing -> Sign-off.
--
-- SCOPED TO source = 'custom' so this only ever corrects a 2026_115 guess.
-- Rows already marked 'catalogue' came from playbook_stages in step 2a and
-- are left alone.
--
-- NOTE: if a stage was renamed by hand between running 2026_115 and this
-- migration, that edit is reverted here. There is no UI to rename stages yet,
-- so in practice nothing is at risk — but check project_stages before running
-- this if you have edited any rows directly in SQL.
UPDATE public.project_stages pst
   SET name       = pls.name,
       sort_order = pls.sort_order,
       source     = 'catalogue',
       updated_at = now()
  FROM public.sales_handovers h
  JOIN public.playbooks pb ON pb.id = h.playbook_id
  JOIN public.pipeline_stages pls ON pls.org_id = h.org_id
                                 AND pls.is_active = TRUE
                                 AND pls.pipeline = CASE
                                       WHEN pb.type IN ('sales','custom','market','product') THEN 'sales'
                                       ELSE pb.type
                                     END
 WHERE pst.handover_id = h.id
   AND pls.key = pst.key
   AND pst.key <> 'custom'
   AND pst.source = 'custom';

COMMIT;

-- ── Verification ─────────────────────────────────────────────────────

\echo ''
\echo '=== Coverage: every stage_key in use must now have a definition ==='
\echo '    (0 rows = project_stages is genuinely authoritative)'
SELECT DISTINCT dpi.handover_id, dpi.stage_key
  FROM public.project_play_instances dpi
  LEFT JOIN public.project_stages pst
         ON pst.handover_id = dpi.handover_id AND pst.key = dpi.stage_key
 WHERE pst.id IS NULL
   AND dpi.stage_key IS NOT NULL
   AND btrim(dpi.stage_key) <> '';

\echo ''
\echo '=== Stage rows by provenance ==='
SELECT source, count(*) AS rows, count(DISTINCT handover_id) AS projects
  FROM public.project_stages WHERE is_active GROUP BY source ORDER BY source;

\echo ''
\echo '=== Resolved stage order per project (spot-check these) ==='
SELECT h.id AS handover_id,
       COALESCE(h.name, '(unnamed)') AS project,
       string_agg(pst.name, ' -> ' ORDER BY pst.sort_order) AS stage_order
  FROM public.sales_handovers h
  JOIN public.project_stages pst ON pst.handover_id = h.id AND pst.is_active
 GROUP BY h.id, h.name
 ORDER BY h.id
 LIMIT 30;

\echo ''
\echo '=== Duplicate sort_order within a project (ties order arbitrarily) ==='
SELECT handover_id, sort_order, count(*) AS colliding_stages
  FROM public.project_stages WHERE is_active
 GROUP BY handover_id, sort_order HAVING count(*) > 1
 ORDER BY handover_id;

\echo ''
\echo 'project_stages is now authoritative. Readers join it directly — no COALESCE.'
\echo 'Reorder:  UPDATE project_stages SET sort_order = ? WHERE handover_id = ? AND key = ?;'
\echo 'Rename:   UPDATE project_stages SET name = ? WHERE handover_id = ? AND key = ?;'
