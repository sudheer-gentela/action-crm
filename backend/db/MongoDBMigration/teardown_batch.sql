-- =====================================================================
-- teardown_batch.sql  —  fully reverse one ETL batch. Run anytime.
--
--   psql "$DATABASE_URL" -v batch=aqua_pavan_001 -f teardown_batch.sql
--
-- Deletes ONLY rows this batch created (tracked in etl_row_log), in
-- reverse dependency order. App-created rows are never touched because
-- they are not in etl_row_log and carry no matching etl_batch stamp.
-- =====================================================================

\if :{?batch}
\else
  \set batch 'aqua_pavan_001'
\endif

\set ON_ERROR_STOP on
BEGIN;

\echo 'Rows to be deleted for batch:'
SELECT table_name, count(*) FROM etl_row_log WHERE batch=:'batch'
GROUP BY table_name ORDER BY table_name;

-- reverse dependency order
DELETE FROM public.linkedin_message_events WHERE id IN
  (SELECT row_id FROM etl_row_log WHERE batch=:'batch' AND table_name='linkedin_message_events');

DELETE FROM public.linkedin_connections WHERE id IN
  (SELECT row_id FROM etl_row_log WHERE batch=:'batch' AND table_name='linkedin_connections');

DELETE FROM public.emails WHERE id IN
  (SELECT row_id FROM etl_row_log WHERE batch=:'batch' AND table_name='emails');

DELETE FROM public.contact_identities WHERE id IN
  (SELECT row_id FROM etl_row_log WHERE batch=:'batch' AND table_name='contact_identities');

DELETE FROM public.prospects WHERE id IN
  (SELECT row_id FROM etl_row_log WHERE batch=:'batch' AND table_name='prospects');

DELETE FROM public.accounts WHERE id IN
  (SELECT row_id FROM etl_row_log WHERE batch=:'batch' AND table_name='accounts');

-- independent cross-check via stamp (catches anything not logged)
DELETE FROM public.prospects WHERE external_refs->>'etl_batch'=:'batch';
DELETE FROM public.accounts  WHERE external_refs->>'etl_batch'=:'batch';
DELETE FROM public.emails    WHERE external_data->>'etl_batch'=:'batch';

DELETE FROM etl_row_log WHERE batch=:'batch';

\echo 'Teardown complete for batch. Staging (stg.*) left intact for reload.'
COMMIT;
