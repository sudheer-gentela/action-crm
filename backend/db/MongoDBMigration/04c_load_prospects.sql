-- =====================================================================
-- 04c_load_prospects.sql
--   Loads the agreed first cohort of migrated Mongo contacts into
--   public.prospects for Pavan (user 18) in org 112.
--
--   Composition:  200  A — clean profile + interaction history
--                   8  B — history present, profile thin (4 email / 4 LI)
--                   6  C — profile complete, no history (3 email / 3 LI)
--                 ---
--                 214  rows
--
-- SAFETY MODEL
--   • Runs in ONE transaction. Any guard failure rolls the whole thing back.
--   • Every row is stamped external_refs.etl_batch AND logged to
--     etl_row_log, so teardown_batch.sql reverses it two independent ways.
--   • campaign_id NULL  -> invisible to CampaignSweeps.
--   • stage 'target', all activity counters at default -> every rule in
--     ProspectHurdleIdentifier returns null, so the 02:45 and 03:00
--     nightly sweeps generate NO actions, NO straps, and NO AI calls.
--   • No sequence enrollment is created -> SequenceStepFirer cannot send.
--   • external_refs carries NO salesforce/hubspot key -> the CRM
--     orchestrator's `external_refs @> {crm:{id}}` match can never find
--     these rows, so they are never synced out or overwritten.
--
-- USAGE
--   Step 1 — dry run (writes nothing, prints exactly what would load):
--       psql "$DATABASE_URL" -v dry_run=1 -f 04c_load_prospects.sql
--   Step 2 — commit the load:
--       psql "$DATABASE_URL" -v dry_run=0 -f 04c_load_prospects.sql
--
--   Teardown at any time:
--       psql "$DATABASE_URL" \
--         -v batch=pavan_fujitsu_rapidigm_apps_relationships_001 \
--         -f teardown_batch.sql
-- =====================================================================

\set ON_ERROR_STOP on
SET statement_timeout = '600s';

\if :{?dry_run}
\else
  \set dry_run 1
\endif

\set batch       'pavan_fujitsu_rapidigm_apps_relationships_001'
\set org_id      112
\set owner_id    18
\set mongo_user  '6630bb9fe336850c87a0a1d6'
\set n_cohort_a  200
\set n_cohort_b  8
\set n_cohort_c  6

\echo ''
\echo '########################################################'
\echo '#  dry_run = 1 means NOTHING is written (default).      #'
\echo '#  Current setting:'
\echo :dry_run
\echo '########################################################'

-- ---------------------------------------------------------------------
-- 0. Environment guard — refuse to run against the wrong database.
-- ---------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  SELECT o.id, o.name INTO r FROM public.organizations o WHERE o.id = 112;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HARD STOP: org 112 not found — wrong database?';
  END IF;
  IF lower(r.name) NOT LIKE '%aquarient%' THEN
    RAISE EXCEPTION 'HARD STOP: org 112 is "%", not Aquarient.', r.name;
  END IF;

  PERFORM 1 FROM public.users WHERE id = 18 AND org_id = 112;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HARD STOP: user 18 is not a member of org 112.';
  END IF;

  PERFORM 1 FROM stg.map_user WHERE pg_user_id = 18;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HARD STOP: no stg.map_user row for user 18. '
      'Run 04b_map_user_org_scope.sql first.';
  END IF;
END $$;

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Candidate set — one row per contact.
--    pavan_preview_data holds one row per (contact, workspace); a contact
--    on two of Pavan's lists appears twice. Collapsing here is what stops
--    the same person being inserted as two prospects.
-- ---------------------------------------------------------------------
CREATE TEMP TABLE cand ON COMMIT DROP AS
SELECT
  d.contact_id,
  max(d.first_name)               AS first_name,
  max(d.last_name)                AS last_name,
  lower(nullif(max(d.email), '')) AS email,
  max(d.linkedin_url)             AS linkedin_url,
  max(d.current_title)            AS current_title,
  max(d.current_company)          AS current_company,
  max(d.email_count)              AS email_count,
  array_agg(DISTINCT d.workspace_name)
    FILTER (WHERE d.workspace_name IS NOT NULL) AS workspaces
FROM public.pavan_preview_data d
WHERE d.mongo_user_id = :'mongo_user'
GROUP BY d.contact_id;

-- ---------------------------------------------------------------------
-- 2. Classify — identical logic to 04a so cohort sizes reconcile.
-- ---------------------------------------------------------------------
CREATE TEMP TABLE classified ON COMMIT DROP AS
SELECT c.*,
  lower(substring(c.linkedin_url from '/in/([^/?#]+)')) AS li_slug,
  EXISTS (SELECT 1 FROM pavan_preview.linkedin_timeline lt
           WHERE lt.contact_id = c.contact_id)          AS has_li_history,
  (c.email_count > 0)                                   AS has_email_history,
  (c.email IS NOT NULL AND c.email <> '-'
   AND c.email LIKE '%@%.%')                            AS email_usable,
  (c.first_name IS NOT NULL AND btrim(c.first_name) NOT IN ('', '-')
   AND c.last_name IS NOT NULL AND btrim(c.last_name) NOT IN ('', '-')) AS name_usable,
  (c.current_company IS NOT NULL AND btrim(c.current_company) <> ''
   AND c.current_title IS NOT NULL AND btrim(c.current_title) <> '')    AS profile_full,
  COALESCE(length(c.first_name)   > 100, false) AS overflow_first,
  COALESCE(length(c.last_name)    > 100, false) AS overflow_last,
  COALESCE(length(c.email)        > 255, false) AS overflow_email,
  COALESCE(length(c.linkedin_url) > 500, false) AS overflow_liurl
FROM cand c;

CREATE TEMP TABLE eligible ON COMMIT DROP AS
SELECT p.*,
  (p.has_email_history OR p.has_li_history) AS has_history,
  -- Collision with a prospect ALREADY live in the org. 04a reported zero,
  -- but the guard stays: batch two will collide with batch one, and an
  -- app user may create a matching prospect between now and then.
  EXISTS (SELECT 1 FROM public.prospects x
           WHERE x.org_id = :org_id AND x.deleted_at IS NULL
             AND p.email IS NOT NULL AND lower(x.email) = p.email) AS dup_by_email,
  EXISTS (SELECT 1 FROM public.prospects x
           WHERE x.org_id = :org_id AND x.deleted_at IS NULL
             AND x.linkedin_url IS NOT NULL AND p.li_slug IS NOT NULL
             AND lower(substring(x.linkedin_url from '/in/([^/?#]+)')) = p.li_slug)
                                                                   AS dup_by_slug
FROM classified p;

CREATE TEMP TABLE cohort ON COMMIT DROP AS
SELECT e.*,
  CASE
    WHEN NOT name_usable                               THEN 'X_unusable_name'
    WHEN dup_by_email OR dup_by_slug                   THEN 'X_collision'
    WHEN overflow_first OR overflow_last
      OR overflow_email OR overflow_liurl              THEN 'X_overflow'
    WHEN NOT email_usable AND li_slug IS NULL          THEN 'X_no_identity'
    WHEN has_history AND profile_full AND email_usable THEN 'A_clean_with_history'
    WHEN has_history                                   THEN 'B_history_thin_profile'
    WHEN profile_full                                  THEN 'C_profile_no_history'
    ELSE 'D_leftover'
  END AS cohort
FROM eligible e;

-- ---------------------------------------------------------------------
-- 3. Selection — deterministic. Ties break on contact_id so the dry run
--    and the real run pick the SAME rows.
--      A: heaviest interaction volume first (best validation signal)
--      B: 4 email-only + 4 LinkedIn-only
--      C: 3 email-only + 3 LinkedIn-only
-- ---------------------------------------------------------------------
CREATE TEMP TABLE picked ON COMMIT DROP AS
  (SELECT *, 'A' AS pick_group FROM cohort
    WHERE cohort = 'A_clean_with_history'
    ORDER BY email_count DESC, contact_id
    LIMIT :n_cohort_a)
UNION ALL
  (SELECT *, 'B_email' FROM cohort
    WHERE cohort = 'B_history_thin_profile'
      AND email_usable AND li_slug IS NULL
    ORDER BY email_count DESC, contact_id
    LIMIT (:n_cohort_b / 2))
UNION ALL
  (SELECT *, 'B_linkedin' FROM cohort
    WHERE cohort = 'B_history_thin_profile'
      AND li_slug IS NOT NULL AND NOT email_usable
    ORDER BY email_count DESC, contact_id
    LIMIT (:n_cohort_b / 2))
UNION ALL
  (SELECT *, 'C_email' FROM cohort
    WHERE cohort = 'C_profile_no_history'
      AND email_usable AND li_slug IS NULL
    ORDER BY contact_id
    LIMIT (:n_cohort_c / 2))
UNION ALL
  (SELECT *, 'C_linkedin' FROM cohort
    WHERE cohort = 'C_profile_no_history'
      AND li_slug IS NOT NULL AND NOT email_usable
    ORDER BY contact_id
    LIMIT (:n_cohort_c / 2));

-- ---------------------------------------------------------------------
-- 4. Tags — shape-tolerant extraction.
--    Mongo tags are OBJECTS ({"_id":{...},"name":"DNP"}), not strings.
--    pavan_preview.contact_tags feeds them through
--    jsonb_array_elements_text, which returns the raw JSON text of each
--    object — writing that into prospects.tags would render literal JSON
--    blobs as tag chips. Extract ->>'name' instead, tolerate legacy
--    plain-string tags, and drop malformed/empty entries.
-- ---------------------------------------------------------------------
CREATE TEMP TABLE tags_by_contact ON COMMIT DROP AS
SELECT contact_id, jsonb_agg(DISTINCT tag_name) AS tags
FROM (
  SELECT
    a.doc->'contact_id'->>'$oid' AS contact_id,
    CASE jsonb_typeof(el)
      WHEN 'object' THEN nullif(btrim(el->>'name'), '')
      WHEN 'string' THEN nullif(btrim(el #>> '{}'), '')
      ELSE NULL
    END AS tag_name
  FROM stg.contact_custom_attrs a,
       jsonb_array_elements(COALESCE(a.doc->'tags', '[]'::jsonb)) el
  WHERE jsonb_typeof(a.doc->'tags') = 'array'
    AND a.doc->'user_id'->>'$oid' = :'mongo_user'
) z
WHERE tag_name IS NOT NULL
GROUP BY contact_id;

-- =====================================================================
--                          DRY-RUN REPORT
-- =====================================================================
\echo ''
\echo '=== R1. Selected rows by group (expect A=200 B_*=4+4 C_*=3+3) ==='
SELECT pick_group, count(*) AS n,
       min(email_count) AS min_emails, max(email_count) AS max_emails
  FROM picked GROUP BY pick_group ORDER BY pick_group;

\echo ''
\echo '=== R2. Shortfalls — any group below target is a problem ==='
SELECT 'A' AS grp, :n_cohort_a AS wanted,
       count(*) FILTER (WHERE pick_group = 'A') AS got FROM picked
UNION ALL SELECT 'B_email',    (:n_cohort_b/2), count(*) FILTER (WHERE pick_group='B_email')    FROM picked
UNION ALL SELECT 'B_linkedin', (:n_cohort_b/2), count(*) FILTER (WHERE pick_group='B_linkedin') FROM picked
UNION ALL SELECT 'C_email',    (:n_cohort_c/2), count(*) FILTER (WHERE pick_group='C_email')    FROM picked
UNION ALL SELECT 'C_linkedin', (:n_cohort_c/2), count(*) FILTER (WHERE pick_group='C_linkedin') FROM picked;

\echo ''
\echo '=== R3. Ambiguous-email exposure (04a section 11 was 215 org-wide) ==='
\echo '    These rows sit on an address mapping to >1 contact. Without the'
\echo '    external_refs path they could show ANOTHER contact history.'
SELECT count(*) AS picked_rows_on_ambiguous_email
  FROM picked p
 WHERE p.email IS NOT NULL
   AND (SELECT count(DISTINCT ce.mongo_contact_id)
          FROM stg.contact_emails ce WHERE ce.email = p.email) > 1;

\echo ''
\echo '=== R4. Tag coverage on the selected rows ==='
SELECT count(*) FILTER (WHERE t.tags IS NOT NULL) AS rows_with_tags,
       count(*)                                   AS rows_total
  FROM picked p LEFT JOIN tags_by_contact t ON t.contact_id = p.contact_id;

\echo ''
\echo '=== R5. Sample of exactly what would be written (10 rows) ==='
SELECT p.pick_group, p.first_name, p.last_name, p.email,
       left(p.current_title, 28)   AS title,
       left(p.current_company, 28) AS company,
       p.email_count,
       COALESCE(t.tags, '[]'::jsonb) AS tags
  FROM picked p LEFT JOIN tags_by_contact t ON t.contact_id = p.contact_id
 ORDER BY p.pick_group, p.email_count DESC
 LIMIT 10;

\echo ''
\echo '=== R6. Final safety assertions on the selected set ==='
SELECT
  count(*)                                                      AS total,
  count(*) FILTER (WHERE first_name IS NULL OR last_name IS NULL) AS null_names_MUST_BE_0,
  count(*) FILTER (WHERE dup_by_email OR dup_by_slug)             AS collisions_MUST_BE_0,
  count(DISTINCT contact_id)                                      AS distinct_contacts,
  count(*) - count(DISTINCT contact_id)                           AS dupes_MUST_BE_0
FROM picked;

-- ---------------------------------------------------------------------
-- 5. Hard assertions — abort rather than write a half-broken batch.
-- ---------------------------------------------------------------------
DO $$
DECLARE n int; d int;
BEGIN
  SELECT count(*), count(DISTINCT contact_id) INTO n, d FROM picked;
  IF n <> d THEN
    RAISE EXCEPTION 'HARD STOP: picked set contains duplicate contacts (% rows, % distinct).', n, d;
  END IF;
  IF n = 0 THEN
    RAISE EXCEPTION 'HARD STOP: nothing selected.';
  END IF;

  SELECT count(*) INTO n FROM picked
   WHERE first_name IS NULL OR last_name IS NULL
      OR btrim(first_name) = '' OR btrim(last_name) = '';
  IF n > 0 THEN
    RAISE EXCEPTION 'HARD STOP: % selected row(s) have an empty name; '
      'prospects.first_name/last_name are NOT NULL.', n;
  END IF;

  SELECT count(*) INTO n FROM picked WHERE dup_by_email OR dup_by_slug;
  IF n > 0 THEN
    RAISE EXCEPTION 'HARD STOP: % selected row(s) collide with a live prospect.', n;
  END IF;
END $$;

-- =====================================================================
-- 6. THE WRITE — skipped entirely when dry_run = 1.
-- =====================================================================
\if :dry_run
  \echo ''
  \echo '>>> DRY RUN — no rows written. Re-run with -v dry_run=0 to commit. <<<'
\else

  \echo ''
  \echo '>>> WRITING to public.prospects <<<'

  WITH ins AS (
    INSERT INTO public.prospects (
      org_id, owner_id, created_by,
      first_name, last_name, email, linkedin_url,
      title, company_name,
      account_id, company_domain, campaign_id, playbook_id, client_id,
      stage, stage_changed_at,
      source, tags, external_refs,
      created_at, updated_at
    )
    SELECT
      :org_id,
      :owner_id,
      :owner_id,
      left(p.first_name, 100),
      left(p.last_name, 100),
      p.email,
      p.linkedin_url,
      left(p.current_title, 255),
      left(p.current_company, 255),
      NULL,            -- account_id: deliberately unresolved (see decision 4)
      NULL,            -- company_domain: mirrors account_id being NULL
      NULL,            -- campaign_id: keeps CampaignSweeps away
      NULL,            -- playbook_id: no action generation
      NULL,            -- client_id
      'target',
      CURRENT_TIMESTAMP,
      'mongo_migration',
      COALESCE(t.tags, '[]'::jsonb),
      jsonb_build_object(
        'etl_batch',        :'batch',
        'mongo_contact_id', p.contact_id,
        'mongo_user_id',    :'mongo_user',
        'source_workspaces', to_jsonb(COALESCE(p.workspaces, ARRAY[]::text[])),
        'cohort',           p.pick_group
      ),
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    FROM picked p
    LEFT JOIN tags_by_contact t ON t.contact_id = p.contact_id
    RETURNING id
  )
  INSERT INTO public.etl_row_log (batch, table_name, row_id)
  SELECT :'batch', 'prospects', id FROM ins;

  \echo ''
  \echo '=== W1. Rows written this batch ==='
  SELECT count(*) AS prospects_inserted
    FROM public.etl_row_log
   WHERE batch = :'batch' AND table_name = 'prospects';

  \echo ''
  \echo '=== W2. Post-write verification ==='
  SELECT count(*)                                                  AS in_prospects,
         count(*) FILTER (WHERE campaign_id IS NOT NULL)            AS campaign_MUST_BE_0,
         count(*) FILTER (WHERE stage <> 'target')                  AS wrong_stage_MUST_BE_0,
         count(*) FILTER (WHERE owner_id <> :owner_id)              AS wrong_owner_MUST_BE_0,
         count(*) FILTER (WHERE external_refs->>'mongo_contact_id'
                                IS NULL)                           AS missing_mongo_id_MUST_BE_0,
         count(*) FILTER (WHERE external_refs ? 'salesforce'
                             OR external_refs ? 'hubspot')          AS crm_keys_MUST_BE_0
    FROM public.prospects
   WHERE org_id = :org_id
     AND external_refs->>'etl_batch' = :'batch';

  \echo ''
  \echo '=== W3. Sweep-safety recheck: these must all be 0 ==='
  \echo '    (non-zero => the nightly sweeps would generate work for these rows)'
  SELECT count(*) FILTER (WHERE last_outreach_at IS NOT NULL) AS has_outreach_ts,
         count(*) FILTER (WHERE icp_score IS NOT NULL)        AS has_icp,
         count(*) FILTER (WHERE outreach_count <> 0)          AS has_outreach_count,
         count(*) FILTER (WHERE response_count <> 0)          AS has_response_count,
         count(*) FILTER (WHERE research_notes IS NOT NULL)   AS has_research_notes
    FROM public.prospects
   WHERE org_id = :org_id AND external_refs->>'etl_batch' = :'batch';

\endif

COMMIT;

\echo ''
\echo '=== Batch identity (for teardown) ==='
\echo :batch
\echo ''
\echo 'Teardown:  psql "$DATABASE_URL" -v batch=pavan_fujitsu_rapidigm_apps_relationships_001 -f teardown_batch.sql'
