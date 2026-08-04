-- ─────────────────────────────────────────────────────────────────────────────
-- verify_whatsapp_attribution.sql
--
-- Diagnostics for the shared-contact problem, plus a DRY-RUN back-fill for
-- replies that were already filed under the wrong project. Run AFTER
-- 2026_99_whatsapp_message_attribution.sql.
--
-- Nothing here writes anything. The one UPDATE is commented out and is meant to
-- be run only after its matching SELECT has been read.
-- ─────────────────────────────────────────────────────────────────────────────

\set org_id 0   -- ← set your org id

-- 1. Which people are on more than one project? These are the only contacts the
--    problem can affect. If this is empty, nothing below will find anything.
SELECT regexp_replace(c.phone, '[^0-9]', '', 'g') AS wa_phone,
       c.first_name || ' ' || c.last_name         AS contact,
       count(DISTINCT pc.context_id)              AS projects,
       array_agg(DISTINCT pc.context_id ORDER BY pc.context_id) AS handover_ids
  FROM project_contacts pc
  JOIN contacts c ON c.id = pc.contact_id
 WHERE pc.org_id = :org_id
   AND pc.context_type = 'handover'
   AND c.phone IS NOT NULL
 GROUP BY 1, 2
HAVING count(DISTINCT pc.context_id) > 1
 ORDER BY projects DESC;

-- 2. Conversations that carry messages for more than one project. The thread's
--    handover_id is the OWNER; the message handover_ids are what each message
--    is actually about.
SELECT t.id AS thread_id, t.wa_phone, t.handover_id AS owned_by,
       array_agg(DISTINCT m.handover_id) FILTER (WHERE m.handover_id IS NOT NULL) AS message_projects,
       count(*) AS messages
  FROM whatsapp_threads t
  JOIN whatsapp_messages m ON m.thread_id = t.id
 WHERE t.org_id = :org_id AND t.kind = 'direct'
 GROUP BY t.id, t.wa_phone, t.handover_id
HAVING count(DISTINCT m.handover_id) > 1
    OR bool_or(m.handover_id IS DISTINCT FROM t.handover_id)
 ORDER BY t.id;

-- 3. DRY RUN — inbound messages whose project disagrees with the outbound that
--    prompted them (within 24h). These are the replies that landed on the wrong
--    project before the fix. Read this list before running anything.
WITH prompted AS (
  SELECT m.id,
         m.thread_id,
         m.handover_id AS current_handover_id,
         COALESCE(m.sent_at, m.created_at) AS at,
         left(m.body, 60) AS body,
         ( SELECT o.handover_id
             FROM whatsapp_messages o
            WHERE o.org_id = m.org_id
              AND o.thread_id = m.thread_id
              AND o.direction = 'outbound'
              AND o.handover_id IS NOT NULL
              AND COALESCE(o.sent_at, o.created_at) < COALESCE(m.sent_at, m.created_at)
              AND COALESCE(o.sent_at, o.created_at) >
                  COALESCE(m.sent_at, m.created_at) - interval '24 hours'
            ORDER BY COALESCE(o.sent_at, o.created_at) DESC, o.id DESC
            LIMIT 1 ) AS should_be_handover_id
    FROM whatsapp_messages m
   WHERE m.org_id = :org_id
     AND m.direction = 'inbound'
)
SELECT * FROM prompted
 WHERE should_be_handover_id IS NOT NULL
   AND should_be_handover_id IS DISTINCT FROM current_handover_id
 ORDER BY at DESC;

-- 4. THE WRITE. Only after reading (3). Same CTE, so it moves exactly the rows
--    listed above and nothing else; handover_source records that it was a
--    back-fill inference rather than something a person chose.
--
-- BEGIN;
-- WITH prompted AS ( ... paste the CTE from (3) ... )
-- UPDATE whatsapp_messages m
--    SET handover_id = p.should_be_handover_id,
--        handover_source = 'recent_outbound'
--   FROM prompted p
--  WHERE m.id = p.id
--    AND p.should_be_handover_id IS NOT NULL
--    AND p.should_be_handover_id IS DISTINCT FROM p.current_handover_id;
-- -- Check the row count matches (3) before committing.
-- COMMIT;
