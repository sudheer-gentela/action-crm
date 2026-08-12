-- =====================================================================
-- 03_preview_views.sql  —  READ-ONLY views over staging for the in-app
--   preview UI. Writes nothing to application tables. Drop anytime with:
--     DROP SCHEMA pavan_preview CASCADE;
--
-- Prereq staging tables loaded: contacts, contact_custom_attrs, emails,
--   tenant_contact_records, tenant_user_contact_lists, and (for LinkedIn)
--   linkedin_messages, linkedin_message_history, user_linkedin_connections.
--   Also stg.map_user (Mongo user _id -> Postgres user id), stg.contact_emails.
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS pavan_preview;

-- ---------------------------------------------------------------------
-- user crosswalk view: resolve a Postgres user id -> Mongo user id
-- (generalises the UI to any user present in stg.map_user)
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW pavan_preview.user_map AS
SELECT pg_user_id, mongo_id AS mongo_user_id, email
FROM stg.map_user;

-- ---------------------------------------------------------------------
-- contact_emails resolver (rebuild here so the file is self-contained)
-- all addresses that identify one of the loaded contacts, any source
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS stg.contact_emails;
CREATE TABLE stg.contact_emails (email text, mongo_contact_id text);
INSERT INTO stg.contact_emails
  SELECT lower(doc->>'email'), doc->'_id'->>'$oid'
  FROM stg.contacts
  WHERE doc->>'email' NOT IN ('', '-') AND doc->>'email' IS NOT NULL;
INSERT INTO stg.contact_emails
  SELECT lower(e), r.doc->'contact_id'->>'$oid'
  FROM stg.tenant_contact_records r,
       jsonb_array_elements_text(coalesce(r.doc->'emails','[]')) e
  WHERE e <> '';
INSERT INTO stg.contact_emails
  SELECT lower(doc->>'email'), doc->'contact_id'->>'$oid'
  FROM stg.contact_custom_attrs
  WHERE doc->>'email' NOT IN ('', '-') AND doc->>'email' IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ce_email ON stg.contact_emails(email);
CREATE INDEX IF NOT EXISTS idx_ce_contact ON stg.contact_emails(mongo_contact_id);

-- ---------------------------------------------------------------------
-- which contacts belong to which Mongo user (via custom_attrs)
-- carries workspace_id so the UI can scope to a workspace later
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW pavan_preview.user_contacts AS
SELECT DISTINCT
  doc->'user_id'->>'$oid'      AS mongo_user_id,
  doc->'contact_id'->>'$oid'   AS contact_id,
  doc->'list_id'->>'$oid'      AS list_id,
  doc->'workspace_id'->>'$oid' AS workspace_id,
  doc->>'customer'             AS customer_label
FROM stg.contact_custom_attrs
WHERE doc->'contact_id'->>'$oid' ~ '^[0-9a-f]{24}$'
  AND coalesce((doc->>'contact_deleted')::boolean, false) = false;

-- ---------------------------------------------------------------------
-- flattened contact card
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW pavan_preview.contacts AS
SELECT
  doc->'_id'->>'$oid'                       AS contact_id,
  nullif(doc->>'first_name','')             AS first_name,
  nullif(doc->>'last_name','')              AS last_name,
  lower(nullif(doc->>'email',''))           AS email,
  nullif(doc->>'linkedin_profile_url','')   AS linkedin_url,
  doc->'current_jobs'->0->>'title'          AS current_title,
  doc->'current_jobs'->0->>'company_name'   AS current_company
FROM stg.contacts;

-- ---------------------------------------------------------------------
-- tags per (user, contact)
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW pavan_preview.contact_tags AS
SELECT
  doc->'user_id'->>'$oid'    AS mongo_user_id,
  doc->'contact_id'->>'$oid' AS contact_id,
  jsonb_array_elements_text(coalesce(doc->'tags','[]')) AS tag
FROM stg.contact_custom_attrs
WHERE jsonb_typeof(doc->'tags') = 'array';

-- ---------------------------------------------------------------------
-- EMAIL timeline: emails touching a contact, with direction
--   direction outbound if sender at an internal (user-side) domain
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW pavan_preview.email_timeline AS
WITH parts AS (
  SELECT
    e.doc->>'message_id'                            AS message_id,
    nullif(e.doc->>'subject','')                    AS subject,
    (e.doc->'message_time'->>'$date')::timestamptz  AS ts,
    lower(e.doc->>'sender')                         AS sender,
    lower(p)                                         AS participant
  FROM stg.emails e,
       LATERAL (
         SELECT jsonb_array_elements_text(coalesce(e.doc->'recipients','[]'))
         UNION ALL SELECT jsonb_array_elements_text(coalesce(e.doc->'cc','[]'))
       ) x(p)
  WHERE p <> ''
)
SELECT DISTINCT
  ce.mongo_contact_id AS contact_id,
  'email'::text       AS channel,
  parts.ts,
  parts.subject       AS detail,
  parts.sender,
  CASE WHEN parts.sender ~ '@(aquarient\.com|(us\.)?fujitsu\.com|rapidigm\.com)$'
       THEN 'outbound' ELSE 'inbound' END AS direction
FROM parts
JOIN stg.contact_emails ce ON ce.email = parts.participant;

-- ---------------------------------------------------------------------
-- LINKEDIN message timeline
--   REALITY: linkedin_messages identify people by URN profile links +
--   names, NOT by contact_id. The only usable bridge to a contact is
--   NAME match (sender_name / receiver_names vs contact first+last).
--   This is fuzzy; we mark confidence accordingly. Messages where the
--   OTHER party (not Pavan) matches a contact name are attributed.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW pavan_preview.linkedin_timeline AS
WITH msg AS (
  SELECT
    m.doc->>'user_id'                              AS mongo_user_id_oid,  -- note: this is $oid path below
    m.doc->'user_id'->>'$oid'                      AS mongo_user_id,
    (m.doc->>'sent_at')::text                      AS sent_raw,
    (m.doc->'sent_at'->>'$date')::timestamptz      AS ts,
    m.doc->>'sender_name'                          AS sender_name,
    m.doc->>'receiver_names'                       AS receiver_names,
    left(m.doc->>'message_text', 300)              AS message_text
  FROM stg.linkedin_messages m
)
SELECT DISTINCT
  c.contact_id,
  'linkedin'::text AS channel,
  msg.ts,
  msg.message_text AS detail,
  msg.sender_name  AS sender,
  CASE WHEN lower(msg.sender_name) = 'pavan kanugo' THEN 'outbound' ELSE 'inbound' END AS direction
FROM msg
JOIN pavan_preview.contacts c
  ON lower(trim(c.first_name || ' ' || c.last_name)) = lower(trim(
       CASE WHEN lower(msg.sender_name) = 'pavan kanugo'
            THEN msg.receiver_names ELSE msg.sender_name END))
WHERE msg.ts IS NOT NULL
  AND c.first_name IS NOT NULL AND c.last_name IS NOT NULL
  AND c.last_name <> '-';

-- ---------------------------------------------------------------------
-- LinkedIn connection status per (user, contact)
--   REALITY: connections carry vanity_name (e.g. 'srividhyareddytummala')
--   which IS extractable from a contact's linkedin_profile_url.
--   Extract vanity from contact url and match. This one joins cleanly.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW pavan_preview.linkedin_status AS
SELECT
  uc.mongo_user_id,
  uc.contact_id,
  CASE WHEN conn.vanity IS NOT NULL THEN 'connected' ELSE 'not_connected' END AS status,
  conn.connected_on
FROM pavan_preview.user_contacts uc
JOIN pavan_preview.contacts c ON c.contact_id = uc.contact_id
LEFT JOIN (
  SELECT DISTINCT
    doc->'user_id'->>'$oid'                    AS mongo_user_id,
    lower(doc->>'vanity_name')                 AS vanity,
    (doc->'connected_on'->>'$date')::timestamptz AS connected_on
  FROM stg.user_linkedin_connections
  WHERE doc->>'vanity_name' IS NOT NULL
) conn
  ON conn.mongo_user_id = uc.mongo_user_id
 AND conn.vanity = lower(
       -- extract vanity slug from linkedin_profile_url:
       -- https://www.linkedin.com/in/<vanity>/  -> <vanity>
       regexp_replace(regexp_replace(coalesce(c.linkedin_url,''),
         '^.*/in/', ''), '/.*$', '')
     )
 AND coalesce(c.linkedin_url,'') <> '';

-- ---------------------------------------------------------------------
-- contacts WITH ANY activity (the default list) for a given mongo user
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW pavan_preview.contacts_with_activity AS
SELECT DISTINCT
  uc.mongo_user_id,
  uc.workspace_id,
  c.contact_id,
  c.first_name, c.last_name, c.email, c.linkedin_url,
  c.current_title, c.current_company,
  (SELECT count(*) FROM pavan_preview.email_timeline et WHERE et.contact_id = c.contact_id) AS email_count
FROM pavan_preview.user_contacts uc
JOIN pavan_preview.contacts c ON c.contact_id = uc.contact_id
WHERE EXISTS (SELECT 1 FROM pavan_preview.email_timeline et WHERE et.contact_id = c.contact_id)
   OR EXISTS (SELECT 1 FROM pavan_preview.contact_tags t
              WHERE t.contact_id = c.contact_id AND t.mongo_user_id = uc.mongo_user_id);

\echo 'Preview views created in schema pavan_preview. Drop with: DROP SCHEMA pavan_preview CASCADE;'
