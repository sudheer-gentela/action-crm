-- =====================================================================
-- 2026_115_project_stages.sql   —   Per-project stage definitions
--
-- THE PROBLEM
--   project_play_instances.stage_key is free text, and nothing in the
--   database knows what order those stages run in. _getPlays() and
--   planVariance both order by:
--
--       ORDER BY ps.sort_order ASC NULLS LAST, stage_key ASC, ...
--
--   where ps is playbook_stages joined on the PROJECT's playbook. A stage
--   key that is not in that playbook — every ad-hoc stage, and every stage
--   on a project with no playbook at all — misses the join, gets NULL
--   sort_order, and falls through to ALPHABETICAL by stage_key.
--
--   So a project running Discovery -> Build -> UAT renders as
--   Build, Discovery, UAT. Silently, with no error, in both the checklist
--   and Plan vs Actual.
--
--   The frontend cannot compensate. groupPlaysByStage() sorts groups by the
--   minimum sort_order of their plays, but addPlay() numbers sort_order
--   per stage from 10 — so the first play in EVERY stage is 10, all groups
--   tie, and stable sort hands back the SQL order. Alphabetical again.
--
-- THE FIX
--   Give a project its own stage list. playbook_stages stays authoritative
--   for playbook-driven projects; project_stages covers everything else and
--   lets a project add a stage without adopting a whole playbook.
--
-- PRECEDENCE
--   COALESCE(playbook_stages.sort_order, project_stages.sort_order).
--   The playbook wins where both define the same key. This is deliberate:
--   playbook_stages is the shared template and a project must not be able
--   to locally reorder a stage that other projects and cross-project
--   reporting also depend on. project_stages fills gaps; it does not
--   override.
--
-- NAMING
--   name is the display label, so the hardcoded construction vocabulary in
--   HandoverView's STAGE_LABELS ('Mobilization', 'Groundwork', ...) stops
--   being the only source of pretty names. A software project can call its
--   stages whatever it likes without a frontend change.
--
-- Run AFTER 2026_109 through 2026_114.
--   psql "$DATABASE_URL" -f 2026_115_project_stages.sql
-- =====================================================================

BEGIN;

-- ── 1. Table ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.project_stages (
    id           serial PRIMARY KEY,
    handover_id  integer NOT NULL
                   REFERENCES public.sales_handovers(id) ON DELETE CASCADE,
    org_id       integer NOT NULL,
    key          text    NOT NULL,
    name         text    NOT NULL,
    sort_order   integer NOT NULL DEFAULT 0,
    is_active    boolean NOT NULL DEFAULT TRUE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    created_by   integer,
    updated_at   timestamptz NOT NULL DEFAULT now(),

    -- One definition per key per project. This is also what makes the
    -- stage picker in Phase 3 safe: an existing key cannot be duplicated
    -- with different capitalisation slipping past as a second stage,
    -- because the API will normalise to this key before inserting.
    CONSTRAINT project_stages_handover_key_uniq UNIQUE (handover_id, key),

    -- A blank key would join to nothing and re-create the NULL-sort_order
    -- bug this migration exists to fix.
    CONSTRAINT project_stages_key_not_blank CHECK (btrim(key) <> ''),
    CONSTRAINT project_stages_name_not_blank CHECK (btrim(name) <> '')
);

-- The join in _getPlays is (handover_id, key) — same shape as the unique
-- constraint, which already provides the index. org_id is indexed
-- separately for the org-scoped predicate every service in this codebase
-- adds as defence in depth.
CREATE INDEX IF NOT EXISTS idx_project_stages_org
    ON public.project_stages (org_id, handover_id);

COMMENT ON TABLE public.project_stages IS
  'Per-project stage definitions. Supplies name + ordering for stage_key '
  'values that are not in the project playbook. playbook_stages wins on '
  'conflict — see COALESCE in handover.service._getPlays().';

-- ── 2. Backfill ──────────────────────────────────────────────────────
--
-- Three rules, each learned from testing this migration against a fixture
-- that reproduced the original bug:
--
--   (a) SEED FROM CREATION ORDER, NOT CURRENT ORDER.
--       The first draft seeded sort_order from the order stages appear
--       under the CURRENT sort — reasoning that preserving what the user
--       sees today beats guessing. That was wrong. For a project where no
--       playbook stage matched, the current order IS the alphabetical bug,
--       so the migration would have frozen the defect permanently and
--       fixed nothing for exactly the projects that were broken.
--
--       min(dpi.id) — the order the stages were first used — is a far
--       better proxy for intent: a team creates Discovery tasks before
--       Build tasks before UAT tasks. It is still a guess, which is why
--       the verification block below lists every affected project so the
--       order can be reviewed and corrected.
--
--   (b) SKIP KEYS THE PLAYBOOK ALREADY OWNS.
--       Those rows are inert (playbook wins the COALESCE) but they made
--       the sequence counter include playbook stages, which produced
--       sort_order collisions between the two scales.
--
--   (c) SKIP 'custom'.
--       The frontend already pins ad-hoc items last and labels the group
--       "Added on this project". Writing a row here would hand it the name
--       'Custom' and override that label — a visible regression on every
--       project using ad-hoc tasks.
INSERT INTO public.project_stages (handover_id, org_id, key, name, sort_order)
SELECT
    s.handover_id,
    s.org_id,
    s.stage_key,
    -- Prettify the key the way stageLabel() does in the frontend.
    -- Acronym keys come out title-cased ('uat' -> 'Uat'); renameable via
    -- PATCH /sales/:id/stages.
    initcap(replace(replace(s.stage_key, '_', ' '), '-', ' ')),
    -- Start above the highest playbook sort_order on this project so a
    -- project-local stage can never tie with a playbook stage. Ties broke
    -- alphabetically, which reintroduced arbitrary ordering on exactly the
    -- mixed projects this table exists to make deterministic.
    s.playbook_ceiling + (s.seq * 10)
FROM (
    SELECT
        dpi.handover_id,
        dpi.org_id,
        dpi.stage_key,
        COALESCE((SELECT max(ps2.sort_order)
                    FROM public.playbook_stages ps2
                    JOIN public.sales_handovers h2 ON h2.id = dpi.handover_id
                   WHERE ps2.playbook_id = h2.playbook_id
                     AND ps2.is_active = TRUE), 0) AS playbook_ceiling,
        row_number() OVER (
            PARTITION BY dpi.handover_id
            ORDER BY min(dpi.id) ASC
        ) AS seq
    FROM public.project_play_instances dpi
    LEFT JOIN public.sales_handovers h ON h.id = dpi.handover_id
    WHERE dpi.stage_key IS NOT NULL
      AND btrim(dpi.stage_key) <> ''
      AND dpi.stage_key <> 'custom'                      -- rule (c)
      AND NOT EXISTS (                                   -- rule (b)
        SELECT 1 FROM public.playbook_stages ps
         WHERE ps.playbook_id = h.playbook_id
           AND ps.key = dpi.stage_key
           AND ps.is_active = TRUE)
    GROUP BY dpi.handover_id, dpi.org_id, dpi.stage_key
) s
ON CONFLICT (handover_id, key) DO NOTHING;

-- ── 3. updated_at trigger ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.project_stages_touch()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_project_stages_touch ON public.project_stages;
CREATE TRIGGER trg_project_stages_touch
  BEFORE UPDATE ON public.project_stages
  FOR EACH ROW EXECUTE FUNCTION public.project_stages_touch();

COMMIT;

-- ── Verification ─────────────────────────────────────────────────────

\echo ''
\echo '=== Rows created ==='
SELECT count(*) AS stage_rows,
       count(DISTINCT handover_id) AS projects_covered
  FROM public.project_stages;

\echo ''
\echo '=== Orphan check: stage_key with NO definition anywhere (should be zero) ==='
\echo '    Excludes custom (frontend labels it) and playbook-owned keys'
\echo '    (playbook_stages supplies those) — both are skipped by design.'
SELECT DISTINCT dpi.handover_id, dpi.stage_key
  FROM public.project_play_instances dpi
  LEFT JOIN public.sales_handovers h ON h.id = dpi.handover_id
  LEFT JOIN public.project_stages pst
         ON pst.handover_id = dpi.handover_id AND pst.key = dpi.stage_key
 WHERE pst.id IS NULL
   AND dpi.stage_key IS NOT NULL
   AND btrim(dpi.stage_key) <> ''
   AND dpi.stage_key <> 'custom'
   AND NOT EXISTS (
     SELECT 1 FROM public.playbook_stages ps
      WHERE ps.playbook_id = h.playbook_id
        AND ps.key = dpi.stage_key
        AND ps.is_active = TRUE);

\echo ''
\echo '=== REVIEW REQUIRED: projects whose stage order was GUESSED ==='
\echo '    These had no playbook stage to sort by. Order is seeded from when'
\echo '    each stage was first used, which is a guess. Check and correct:'
SELECT h.id AS handover_id,
       h.name AS project_name,
       string_agg(pst.name, ' -> ' ORDER BY pst.sort_order) AS seeded_order
  FROM public.sales_handovers h
  JOIN public.project_stages pst ON pst.handover_id = h.id
 WHERE pst.is_active
 GROUP BY h.id, h.name
 HAVING count(*) > 1
 ORDER BY count(*) DESC
 LIMIT 30;

\echo ''
\echo '=== Sort-order collisions between playbook and project scales ==='
\echo '    (should be zero — a tie orders arbitrarily)'
SELECT pst.handover_id, pst.key AS project_stage, ps.key AS playbook_stage, ps.sort_order
  FROM public.project_stages pst
  JOIN public.sales_handovers h ON h.id = pst.handover_id
  JOIN public.playbook_stages ps ON ps.playbook_id = h.playbook_id
                                AND ps.is_active = TRUE
                                AND ps.sort_order = pst.sort_order
 WHERE pst.is_active;

\echo ''
\echo 'Stage order is now COALESCE(playbook_stages.sort_order, project_stages.sort_order).'
\echo 'Reorder a project stage:  UPDATE project_stages SET sort_order = ? WHERE handover_id = ? AND key = ?;'
\echo 'Rename a project stage:   UPDATE project_stages SET name = ? WHERE handover_id = ? AND key = ?;'
