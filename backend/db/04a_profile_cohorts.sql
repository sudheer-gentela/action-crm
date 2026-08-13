-- =====================================================================
-- 04a_profile_cohorts.sql  —  READ ONLY.  Writes NOTHING.
--
-- Profiles the migrated contacts and sorts them into the cohorts agreed
-- for the first (~220 row) load into public.prospects:
--
--   A  clean profile + interaction history          → target 200
--   B  history exists, profile incomplete           → sample ~8
--   C  profile complete, no interaction history     → sample ~6
--      (B and C further split by email / LinkedIn channel)
--
-- Also reports the things that would BREAK the load if unhandled:
--   collisions with live prospects, unusable names, column overflows.
--
-- Run:  psql "$DATABASE_URL" -f 04a_profile_cohorts.sql
--
-- Everything lives in TEMP tables — they vanish when the session ends.
-- Safe to run on production. Uses only SELECTs against stg/pavan_preview
-- and a read of public.prospects for collision detection.
-- =====================================================================

\set ON_ERROR_STOP on
SET statement_timeout = '600s';

\set org_id      112
\set owner_id    18
\set mongo_user  '6630bb9fe336850c87a0a1d6'

\echo ''
\echo '=== 0. Environment sanity (must match before anything else) ==='
SELECT o.id AS org_id, o.name AS org_name,
       u.id AS pg_user_id, u.email AS user_email,
       m.mongo_id AS mapped_mongo_user
  FROM public.organizations o
  JOIN public.users u   ON u.org_id = o.id AND u.id = :owner_id
  LEFT JOIN stg.map_user m ON m.pg_user_id = u.id
 WHERE o.id = :org_id;

-- ---------------------------------------------------------------------
-- 1. Candidate set — one row per contact.
--    pavan_preview_data carries one row per (contact, workspace), so a
--    contact in two lists appears twice. Collapse to one row and keep
--    the workspace names as an array for tagging.
-- ---------------------------------------------------------------------
CREATE TEMP TABLE cand AS
SELECT
  d.contact_id,
  max(d.first_name)                          AS first_name,
  max(d.last_name)                           AS last_name,
  lower(nullif(max(d.email), ''))            AS email,
  max(d.linkedin_url)                        AS linkedin_url,
  max(d.current_title)                       AS current_title,
  max(d.current_company)                     AS current_company,
  max(d.email_count)                         AS email_count,
  array_agg(DISTINCT d.workspace_name)
    FILTER (WHERE d.workspace_name IS NOT NULL) AS workspaces
FROM public.pavan_preview_data d
WHERE d.mongo_user_id = :'mongo_user'
GROUP BY d.contact_id;

CREATE INDEX ON cand(contact_id);

\echo ''
\echo '=== 1. Candidate pool (distinct contacts currently loaded) ==='
SELECT count(*) AS distinct_contacts FROM cand;

-- ---------------------------------------------------------------------
-- 2. Enrich: LinkedIn history, derived slug, name usability, collisions.
--    Slug expression mirrors idx_prospects_linkedin_slug exactly:
--      lower(substring(linkedin_url from '/in/([^/?#]+)'))
-- ---------------------------------------------------------------------
CREATE TEMP TABLE prof AS
SELECT
  c.*,
  lower(substring(c.linkedin_url from '/in/([^/?#]+)'))        AS li_slug,
  EXISTS (SELECT 1 FROM pavan_preview.linkedin_timeline lt
           WHERE lt.contact_id = c.contact_id)                 AS has_li_history,
  (c.email_count > 0)                                          AS has_email_history,
  (c.email IS NOT NULL AND c.email <> '-' AND c.email LIKE '%@%.%') AS email_usable,
  (c.first_name IS NOT NULL AND btrim(c.first_name) NOT IN ('', '-')
   AND c.last_name IS NOT NULL AND btrim(c.last_name) NOT IN ('', '-')) AS name_usable,
  (c.current_company IS NOT NULL AND btrim(c.current_company) <> ''
   AND c.current_title IS NOT NULL AND btrim(c.current_title) <> '')    AS profile_full
FROM cand c;

CREATE TEMP TABLE prof2 AS
SELECT
  p.*,
  (p.has_email_history OR p.has_li_history) AS has_history,
  -- collision with a LIVE prospect already in the org, by either identity
  EXISTS (SELECT 1 FROM public.prospects x
           WHERE x.org_id = :org_id AND x.deleted_at IS NULL
             AND p.email IS NOT NULL AND lower(x.email) = p.email) AS dup_by_email,
  EXISTS (SELECT 1 FROM public.prospects x
           WHERE x.org_id = :org_id AND x.deleted_at IS NULL
             AND x.linkedin_url IS NOT NULL AND p.li_slug IS NOT NULL
             AND lower(substring(x.linkedin_url from '/in/([^/?#]+)')) = p.li_slug) AS dup_by_slug,
  -- column width guards (prospects: first/last 100, email 255, li_url 500)
  -- COALESCE: length(NULL) is NULL, and a NULL in the OR chain below would
  -- make the whole overflow test NULL instead of false. A NULL column can
  -- never overflow, so false is the correct floor.
  COALESCE(length(p.first_name)   > 100, false) AS overflow_first,
  COALESCE(length(p.last_name)    > 100, false) AS overflow_last,
  COALESCE(length(p.email)        > 255, false) AS overflow_email,
  COALESCE(length(p.linkedin_url) > 500, false) AS overflow_liurl
FROM prof p;

\echo ''
\echo '=== 2. Data-quality profile of the whole candidate pool ==='
SELECT
  count(*)                                        AS total,
  count(*) FILTER (WHERE name_usable)             AS name_ok,
  count(*) FILTER (WHERE NOT name_usable)         AS name_unusable,
  count(*) FILTER (WHERE email_usable)            AS has_email,
  count(*) FILTER (WHERE li_slug IS NOT NULL)     AS has_linkedin,
  count(*) FILTER (WHERE email_usable AND li_slug IS NOT NULL) AS has_both,
  count(*) FILTER (WHERE NOT email_usable AND li_slug IS NULL) AS has_neither,
  count(*) FILTER (WHERE has_email_history)       AS email_history,
  count(*) FILTER (WHERE has_li_history)          AS li_history,
  count(*) FILTER (WHERE has_history)             AS any_history,
  count(*) FILTER (WHERE profile_full)            AS profile_full
FROM prof2;

\echo ''
\echo '=== 3. Collisions with prospects already live in this org ==='
\echo '    (these are SKIPPED on insert; option 3 updates their external_refs only)'
SELECT
  count(*) FILTER (WHERE dup_by_email)               AS collide_email,
  count(*) FILTER (WHERE dup_by_slug)                AS collide_slug,
  count(*) FILTER (WHERE dup_by_email OR dup_by_slug) AS collide_any
FROM prof2;

\echo ''
\echo '=== 4. Column-width overflows (would truncate or error on insert) ==='
SELECT
  count(*) FILTER (WHERE overflow_first) AS first_name_over_100,
  count(*) FILTER (WHERE overflow_last)  AS last_name_over_100,
  count(*) FILTER (WHERE overflow_email) AS email_over_255,
  count(*) FILTER (WHERE overflow_liurl) AS linkedin_url_over_500
FROM prof2;

\echo ''
\echo '=== 4b. The overflowing rows themselves (if any) ==='
SELECT contact_id, left(first_name,30) AS first_name,
       length(first_name) AS len_first, length(last_name) AS len_last,
       length(email) AS len_email, length(linkedin_url) AS len_liurl
  FROM prof2
 WHERE overflow_first OR overflow_last OR overflow_email OR overflow_liurl
 ORDER BY contact_id;

-- ---------------------------------------------------------------------
-- 5. Cohort assignment. Mutually exclusive, evaluated in order.
--    Only rows that are loadable at all (usable name, no collision,
--    no overflow) are eligible.
-- ---------------------------------------------------------------------
CREATE TEMP TABLE cohort AS
SELECT p.*,
  CASE
    WHEN NOT name_usable                             THEN 'X_unusable_name'
    WHEN dup_by_email OR dup_by_slug                 THEN 'X_collision'
    WHEN overflow_first OR overflow_last
      OR overflow_email OR overflow_liurl            THEN 'X_overflow'
    WHEN NOT email_usable AND li_slug IS NULL        THEN 'X_no_identity'
    WHEN has_history AND profile_full AND email_usable THEN 'A_clean_with_history'
    WHEN has_history AND NOT profile_full            THEN 'B_history_thin_profile'
    WHEN has_history                                 THEN 'B_history_thin_profile'
    WHEN profile_full                                THEN 'C_profile_no_history'
    ELSE 'D_leftover'
  END AS cohort
FROM prof2 p;

\echo ''
\echo '=== 5. Cohort sizes (A must be >= 200 for the planned first load) ==='
SELECT cohort, count(*) AS n,
       count(*) FILTER (WHERE email_usable AND li_slug IS NULL) AS email_only,
       count(*) FILTER (WHERE li_slug IS NOT NULL AND NOT email_usable) AS linkedin_only,
       count(*) FILTER (WHERE email_usable AND li_slug IS NOT NULL) AS both
  FROM cohort
 GROUP BY cohort
 ORDER BY cohort;

\echo ''
\echo '=== 6. Cohort A preview — top 15 by interaction volume ==='
SELECT contact_id, first_name, last_name, email,
       current_company, email_count, has_li_history, workspaces
  FROM cohort
 WHERE cohort = 'A_clean_with_history'
 ORDER BY email_count DESC, last_name
 LIMIT 15;

\echo ''
\echo '=== 7. Cohort B preview (history, thin profile) — up to 10 ==='
SELECT contact_id, first_name, last_name, email, li_slug,
       current_title, current_company, email_count, has_li_history
  FROM cohort
 WHERE cohort = 'B_history_thin_profile'
 ORDER BY email_count DESC
 LIMIT 10;

\echo ''
\echo '=== 8. Cohort C preview (full profile, no history) — up to 10 ==='
SELECT contact_id, first_name, last_name, email, li_slug,
       current_title, current_company
  FROM cohort
 WHERE cohort = 'C_profile_no_history'
 ORDER BY last_name
 LIMIT 10;

\echo ''
\echo '=== 9. Tag vocabulary that would land on prospects.tags ==='
SELECT t.tag, count(DISTINCT t.contact_id) AS contacts
  FROM pavan_preview.contact_tags t
  JOIN cohort c ON c.contact_id = t.contact_id
 WHERE t.mongo_user_id = :'mongo_user'
   AND c.cohort IN ('A_clean_with_history','B_history_thin_profile','C_profile_no_history')
 GROUP BY t.tag
 ORDER BY contacts DESC, t.tag
 LIMIT 40;

\echo ''
\echo '=== 10. History-resolution check for the loadable cohorts ==='
\echo '    Confirms each row can actually resolve a timeline once loaded.'
\echo '    resolves_by_email uses stg.contact_emails (the route path today).'
SELECT c.cohort,
       count(*) AS n,
       count(*) FILTER (
         WHERE EXISTS (SELECT 1 FROM stg.contact_emails ce
                        WHERE ce.email = c.email
                          AND ce.mongo_contact_id = c.contact_id)) AS resolves_by_email,
       count(*) FILTER (WHERE c.li_slug IS NOT NULL)               AS resolves_by_slug,
       count(*) FILTER (
         WHERE NOT EXISTS (SELECT 1 FROM stg.contact_emails ce
                            WHERE ce.email = c.email
                              AND ce.mongo_contact_id = c.contact_id)
           AND c.li_slug IS NULL)                                  AS needs_external_refs_path
  FROM cohort c
 WHERE c.cohort IN ('A_clean_with_history','B_history_thin_profile','C_profile_no_history')
 GROUP BY c.cohort
 ORDER BY c.cohort;

\echo ''
\echo '=== 11. Ambiguous email->contact mappings (why the route LIMIT 1 matters) ==='
SELECT count(*) AS emails_mapping_to_multiple_contacts
  FROM (SELECT email FROM stg.contact_emails
         WHERE email IS NOT NULL
         GROUP BY email
        HAVING count(DISTINCT mongo_contact_id) > 1) z;

\echo ''
\echo 'Profiling complete. NOTHING was written. Send back sections 2,3,4,5,10,11.'
