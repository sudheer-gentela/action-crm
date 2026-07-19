-- ═══════════════════════════════════════════════════════════════════════════
-- backfill-prospect-client-from-campaign.sql       (Agency Phase 2, operational)
--
-- One-time, re-runnable backfill: stamp prospects.client_id from their
-- campaign's client_id for prospects created BEFORE the campaign was tagged
-- to a client (or before 2026_52 was applied).
--
-- Normally NOT needed: saving a campaign with a client in the UI already
-- stamps its current members (PUT /prospecting-campaigns/:id), and the
-- 2026_52 trigger covers every prospect placed into a campaign afterwards.
-- Use this only for a bulk sweep across ALL campaigns at once.
--
-- Same rules as the trigger: set-if-null only, org-matched, live rows only.
-- Idempotent — a second run matches zero rows.
--
-- STEP 1 — DRY RUN. Review before writing anything.
-- ═══════════════════════════════════════════════════════════════════════════

SELECT c.org_id,
       cl.name  AS client,
       c.name   AS campaign,
       COUNT(p.id) AS prospects_to_stamp
  FROM prospects p
  JOIN prospecting_campaigns c  ON c.id  = p.campaign_id AND c.org_id = p.org_id
  JOIN clients               cl ON cl.id = c.client_id
 WHERE c.client_id IS NOT NULL
   AND p.client_id IS NULL
   AND p.deleted_at IS NULL
 GROUP BY c.org_id, cl.name, c.name
 ORDER BY c.org_id, cl.name, c.name;

-- Optional row-level preview:
-- SELECT p.id, p.first_name, p.last_name, c.name AS campaign, cl.name AS client
--   FROM prospects p
--   JOIN prospecting_campaigns c  ON c.id  = p.campaign_id AND c.org_id = p.org_id
--   JOIN clients               cl ON cl.id = c.client_id
--  WHERE c.client_id IS NOT NULL AND p.client_id IS NULL AND p.deleted_at IS NULL
--  ORDER BY p.id;

-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 2 — APPLY. Uncomment ONLY after the dry-run counts look right.
-- Wrapped in a transaction: check the reported row count against the dry run,
-- then COMMIT (or ROLLBACK if it doesn't match).
-- ═══════════════════════════════════════════════════════════════════════════

-- BEGIN;
--
-- UPDATE prospects p
--    SET client_id  = c.client_id,
--        updated_at = CURRENT_TIMESTAMP
--   FROM prospecting_campaigns c
--  WHERE c.id        = p.campaign_id
--    AND c.org_id    = p.org_id
--    AND c.client_id IS NOT NULL
--    AND p.client_id IS NULL
--    AND p.deleted_at IS NULL;
--
-- -- Row count printed above must equal the dry-run total. Then:
-- -- COMMIT;   -- or ROLLBACK;
