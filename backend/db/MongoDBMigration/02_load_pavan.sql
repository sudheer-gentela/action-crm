-- =====================================================================
-- 02_load_pavan.sql  —  load ONLY Pavan/Aquarient data into staging,
--                       derive his contact + account id sets for the
--                       local filter of the big global pools.
--
-- Space-safe: never loads an unfiltered global pool. Check DB size
-- between steps; it should stay far under the volume.
--
-- Interleaves with filter-pavan.ps1:
--   A) run 00_staging.sql (staging tables) if not already
--   B) \copy the small pre-filtered files (below, section 1)
--   C) \copy Pavan's filtered custom_attrs (cca_pavan.ndjson)
--   D) run section 2 -> produces pavan_ids.txt
--   E) powershell: .\filter-pavan.ps1 -Step contacts
--   F) \copy contacts_pavan.ndjson ; run section 3 -> pavan_account_ids.txt
--   G) powershell: .\filter-pavan.ps1 -Step orgs
--   H) \copy contact_orgs_pavan.ndjson
-- =====================================================================

\set ON_ERROR_STOP on
SET client_encoding TO 'UTF8';

\echo '=== size before load ==='
SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size;

-- =====================================================================
-- SECTION 1 — load small, already-Aquarient-filtered files
-- (run these \copy lines; paths assume the MongoDB Backup folder)
-- =====================================================================
-- \copy stg.users(doc)                     FROM 'C:\Projects\MongoDB Backup\_global\users.ndjson'                     WITH (FORMAT csv, QUOTE E'\x01', DELIMITER E'\x02')
-- \copy stg.tenants(doc)                   FROM 'C:\Projects\MongoDB Backup\_global\tenants.ndjson'                   WITH (FORMAT csv, QUOTE E'\x01', DELIMITER E'\x02')
-- \copy stg.emails(doc)                    FROM 'C:\Projects\MongoDB Backup\aquarient\emails.ndjson'                    WITH (FORMAT csv, QUOTE E'\x01', DELIMITER E'\x02')
-- \copy stg.tenant_contact_records(doc)    FROM 'C:\Projects\MongoDB Backup\aquarient\tenant_contact_records.ndjson'    WITH (FORMAT csv, QUOTE E'\x01', DELIMITER E'\x02')
-- \copy stg.tenant_user_contact_lists(doc) FROM 'C:\Projects\MongoDB Backup\aquarient\tenant_user_contact_lists.ndjson' WITH (FORMAT csv, QUOTE E'\x01', DELIMITER E'\x02')
-- \copy stg.contact_custom_attrs(doc)      FROM 'C:\Projects\MongoDB Backup\_user_scoped\cca_pavan.ndjson'              WITH (FORMAT csv, QUOTE E'\x01', DELIMITER E'\x02')

/*
\echo '=== staging counts (compare to manifest) ==='
SELECT 'users' t, count(*) FROM stg.users
UNION ALL SELECT 'tenants',                   count(*) FROM stg.tenants
UNION ALL SELECT 'emails',                    count(*) FROM stg.emails
UNION ALL SELECT 'tenant_contact_records',    count(*) FROM stg.tenant_contact_records
UNION ALL SELECT 'tenant_user_contact_lists', count(*) FROM stg.tenant_user_contact_lists
UNION ALL SELECT 'contact_custom_attrs',      count(*) FROM stg.contact_custom_attrs
ORDER BY t;

\echo '=== size after small loads (should be tiny bump) ==='
SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size;

-- =====================================================================
-- SECTION 2 — derive Pavan's distinct contact ids (his working set)
--   from BOTH bridges: his custom_attrs and his contact lists.
-- =====================================================================
DROP TABLE IF EXISTS stg.pavan_contact_ids;
CREATE TABLE stg.pavan_contact_ids (mongo_id text PRIMARY KEY);

-- from custom attributes (already Pavan-only in staging)
INSERT INTO stg.pavan_contact_ids
SELECT DISTINCT doc->'contact_id'->>'$oid'
FROM stg.contact_custom_attrs
WHERE doc->'contact_id'->>'$oid' IS NOT NULL
  AND doc->'contact_id'->>'$oid' ~ '^[0-9a-f]{24}$'
ON CONFLICT DO NOTHING;

-- from his tenant_user_contact_lists (unnest contacts[] DBRefs)
-- NOTE: tenant_user_contact_lists here is Aquarient-wide (293 lists).
-- We narrow to Pavan by his user DBRef on the list.
INSERT INTO stg.pavan_contact_ids
SELECT DISTINCT c->'contact'->'$id'->>'$oid'
FROM stg.tenant_user_contact_lists l,
     jsonb_array_elements(coalesce(l.doc->'contacts','[]')) AS c
WHERE l.doc->'user'->'$id'->>'$oid' = '6630bb9fe336850c87a0a1d6'
  AND c->'contact'->'$id'->>'$oid' ~ '^[0-9a-f]{24}$'
  -- only non-deleted entries
  AND coalesce((c->>'deleted')::int, 0) = 0
ON CONFLICT DO NOTHING;

\echo '=== Pavan distinct contact count (drives contacts load size) ==='
SELECT count(*) AS pavan_distinct_contacts FROM stg.pavan_contact_ids;

-- export the id list for the local contacts filter
\copy (SELECT mongo_id FROM stg.pavan_contact_ids) TO 'C:\Projects\MongoDB Backup\pavan_ids.txt'
\echo 'Wrote pavan_ids.txt — now run:  .\filter-pavan.ps1 -Step contacts'
\echo 'Then \copy contacts_pavan.ndjson into stg.contacts, and run SECTION 3 below.'

*/

-- =====================================================================
-- SECTION 3 — after stg.contacts (filtered) is loaded, derive the
--   account (contact_organization) ids Pavan's contacts reference,
--   for filtering contact_organizations.
--   Run this block only AFTER contacts_pavan.ndjson is \copy'd in.
-- =====================================================================
 DROP TABLE IF EXISTS stg.pavan_account_ids;
 CREATE TABLE stg.pavan_account_ids (mongo_id text PRIMARY KEY);

-- contacts reference orgs via previous_jobs[].contact_org DBRef and/or
-- -- a current org field. Pull any contact_organizations oid referenced.
 INSERT INTO stg.pavan_account_ids
 SELECT DISTINCT ref->>'$oid'
 FROM stg.contacts c,
      jsonb_path_query(c.doc, '$.**."$ref" ? (@ == "contact_organizations")') AS dummy,
      LATERAL (SELECT c.doc) x,
      jsonb_array_elements(coalesce(c.doc->'previous_jobs','[]')) pj,
      LATERAL (SELECT pj->'contact_org'->'$id') AS r(ref)
 WHERE ref->>'$oid' ~ '^[0-9a-f]{24}$'
 ON CONFLICT DO NOTHING;

 SELECT count(*) AS pavan_account_ids FROM stg.pavan_account_ids;
\copy (SELECT mongo_id FROM stg.pavan_account_ids) TO 'C:\Projects\MongoDB Backup\pavan_account_ids.txt'
\echo 'Wrote pavan_account_ids.txt — run:  .\filter-pavan.ps1 -Step orgs'

\echo '=== final size check ==='
SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size;
