-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_21_backfill_prospect_campaigns.sql
--
-- Backfills prospects.campaign_id for prospects that were created without a
-- campaign but are demonstrably part of one — inferred from their sequence
-- enrollment: if a prospect is enrolled in a sequence that is the DEFAULT
-- sequence of exactly ONE campaign in the org, that campaign is the
-- attribution. Ambiguous cases (two campaigns sharing a default sequence,
-- or enrollments pointing at different campaigns) are deliberately left
-- untouched — review those by hand via the preview query.
--
-- This is a DATA fix, not schema. Run the PREVIEW first, eyeball it, then
-- run the APPLY block. Every backfilled prospect gets an audit row in
-- prospecting_activities (activity_type 'campaign_backfill') so the change
-- is visible on the prospect timeline and reversible by hand.
--
-- Known cases from the 2026-06-11 investigation: prospects 1289 (Bala) and
-- 273 (Jessica) had campaign_id NULL while their email replies were live.
-- If the inference below does not cover them (e.g. never enrolled), assign
-- them manually:
--   UPDATE prospects SET campaign_id = <id>, updated_at = now()
--    WHERE id IN (1289, 273) AND org_id = <org>;
-- ─────────────────────────────────────────────────────────────────────────────

-- ── PREVIEW — run this first, nothing is written ─────────────────────────────
SELECT p.id            AS prospect_id,
       p.first_name, p.last_name, p.company_name,
       p.stage,
       COUNT(DISTINCT c.id)         AS candidate_campaigns,
       MIN(c.id)                    AS inferred_campaign_id,
       MIN(c.name)                  AS inferred_campaign_name,
       CASE WHEN COUNT(DISTINCT c.id) = 1 THEN 'WILL BACKFILL'
            ELSE 'AMBIGUOUS — review by hand' END AS verdict
  FROM prospects p
  JOIN sequence_enrollments se
    ON se.prospect_id = p.id AND se.org_id = p.org_id
  JOIN prospecting_campaigns c
    ON c.org_id = p.org_id AND c.default_sequence_id = se.sequence_id
 WHERE p.campaign_id IS NULL
   AND p.deleted_at  IS NULL
 GROUP BY p.id, p.first_name, p.last_name, p.company_name, p.stage
 ORDER BY verdict, p.id;

-- ── APPLY — run after reviewing the preview ──────────────────────────────────
BEGIN;

WITH inferred AS (
  SELECT p.id          AS prospect_id,
         p.org_id,
         p.owner_id,
         MIN(c.id)     AS campaign_id,
         MIN(c.name)   AS campaign_name
    FROM prospects p
    JOIN sequence_enrollments se
      ON se.prospect_id = p.id AND se.org_id = p.org_id
    JOIN prospecting_campaigns c
      ON c.org_id = p.org_id AND c.default_sequence_id = se.sequence_id
   WHERE p.campaign_id IS NULL
     AND p.deleted_at  IS NULL
   GROUP BY p.id, p.org_id, p.owner_id
  HAVING COUNT(DISTINCT c.id) = 1          -- unambiguous matches only
),
updated AS (
  UPDATE prospects p
     SET campaign_id = i.campaign_id,
         updated_at  = CURRENT_TIMESTAMP
    FROM inferred i
   WHERE p.id = i.prospect_id
     AND p.org_id = i.org_id
     AND p.campaign_id IS NULL              -- re-check under the write lock
  RETURNING p.id, p.org_id, p.owner_id, i.campaign_id, i.campaign_name
)
INSERT INTO prospecting_activities
            (org_id, prospect_id, user_id, activity_type, description, metadata)
SELECT u.org_id,
       u.id,
       u.owner_id,
       'campaign_backfill',
       'Campaign attribution backfilled to "' || u.campaign_name ||
       '" (inferred from sequence enrollment; 2026_21 data fix)',
       jsonb_build_object(
         'campaign_id', u.campaign_id,
         'source',      'migration_2026_21',
         'inferred_from', 'sequence_enrollment_default_sequence'
       )
  FROM updated u;

-- Sanity: how many rows were backfilled (matches the INSERT count above).
SELECT COUNT(*) AS backfilled
  FROM prospecting_activities
 WHERE activity_type = 'campaign_backfill'
   AND metadata->>'source' = 'migration_2026_21';

COMMIT;
