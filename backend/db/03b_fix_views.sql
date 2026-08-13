-- =====================================================================
-- 03b_fix_views.sql  —  make preview views scale by reading from the
--   materialized stg.email_contact_match table (built once, indexed).
--   Fixes the connection-crash on contacts_with_activity.
--   Safe to re-run.
-- =====================================================================

-- email_timeline now just reads the materialized matches (fast)
CREATE OR REPLACE VIEW pavan_preview.email_timeline AS
SELECT
  contact_id,
  'email'::text AS channel,
  ts,
  subject       AS detail,
  sender,
  direction
FROM stg.email_contact_match;

-- pre-aggregate per-contact email counts once (indexed table -> cheap)
DROP MATERIALIZED VIEW IF EXISTS pavan_preview.contact_email_counts;
CREATE MATERIALIZED VIEW pavan_preview.contact_email_counts AS
SELECT contact_id, count(*)::int AS email_count
FROM stg.email_contact_match
GROUP BY contact_id;
CREATE UNIQUE INDEX idx_cec_contact ON pavan_preview.contact_email_counts(contact_id);

-- contacts_with_activity: cheap join to the count table + tags, no EXISTS
CREATE OR REPLACE VIEW pavan_preview.contacts_with_activity AS
SELECT DISTINCT
  uc.mongo_user_id,
  uc.workspace_id,
  c.contact_id,
  c.first_name, c.last_name, c.email, c.linkedin_url,
  c.current_title, c.current_company,
  coalesce(cec.email_count, 0) AS email_count
FROM pavan_preview.user_contacts uc
JOIN pavan_preview.contacts c ON c.contact_id = uc.contact_id
LEFT JOIN pavan_preview.contact_email_counts cec ON cec.contact_id = c.contact_id
WHERE cec.contact_id IS NOT NULL   -- has email activity
   OR EXISTS (
     SELECT 1 FROM pavan_preview.contact_tags t
     WHERE t.contact_id = c.contact_id AND t.mongo_user_id = uc.mongo_user_id
   );

\echo 'Views fixed. contacts_with_activity now reads indexed matches.'
