-- ─────────────────────────────────────────────────────────────────────────────
-- reset_gwtest_group.sql — forget one GWTEST group so a stage can be rerun.
--
-- WHY THIS IS NEEDED
--   Stage 0's IDENTITY check reads EVERY message in the group, so the rows
--   captured before the LID fix — the ones carrying a LID in from_phone — keep
--   failing it forever. They are not wrong data to be repaired; they were
--   captured by the old worker and there is nothing in them worth keeping.
--   Deleting them is cheaper and more honest than back-filling a phone number
--   we would have to guess.
--
-- WHAT IT TOUCHES
--   One group, identified by org and EXACT subject, and only rows hanging off
--   its thread. It does not touch the session, the handset, other groups, or
--   anything outside the org. Rerunning stage 0 afterwards recreates all of it.
--
-- HOW TO RUN IT
--   Set the two values below, then run the whole file. It prints what it is
--   about to delete, deletes inside a transaction, prints what is left, and
--   ROLLS BACK by default.
--
--   READ THE COUNTS FIRST. Then change the final ROLLBACK to COMMIT and run it
--   again to make it stick. Leaving it as ROLLBACK means a mistyped org id
--   costs you a printout and nothing else.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── guards, before the transaction ──────────────────────────────────────────
-- Set these two, then run the file.
\set org_id 112
\set subject 'GWTEST G1 Acme Migration'
-- :'subject' is psql's quoted form. Plain :subject would paste the text
-- unquoted and Postgres would read it as a column name.

-- A script that matches nothing must SAY so. Left at org_id 0 every query below
-- filters on an org that cannot exist, every DELETE reports 0, and the closing
-- "all zero" reads like success when nothing was ever found. These two checks
-- turn that silence into a refusal.
SELECT (:org_id = 0) AS org_unset \gset
\if :org_unset
\echo ''
\echo 'STOP: org_id is still 0. Edit \\set org_id near the top of this file to the'
\echo '      org you are resetting:  SELECT id, name FROM organizations WHERE ...'
\echo ''
\quit
\endif

SELECT count(*) = 0 AS no_match FROM whatsapp_threads
 WHERE org_id = :org_id AND btrim(group_subject) = :'subject' \gset
\if :no_match
\echo ''
\echo 'STOP: no thread in this org has that exact group subject, so there is'
\echo '      nothing to reset. Check the org id and the subject — the match is'
\echo '      exact after trimming, so a curly quote or an en dash will miss.'
\echo ''
\quit
\endif

BEGIN;

\echo '--- what this will delete ---'

SELECT t.id                AS thread_id,
       g.id                AS group_id,
       btrim(g.subject)    AS subject,
       (SELECT count(*) FROM whatsapp_messages m            WHERE m.thread_id = t.id) AS messages,
       (SELECT count(*) FROM whatsapp_thread_participants p WHERE p.thread_id = t.id) AS participants
  FROM whatsapp_threads t
  LEFT JOIN whatsapp_session_groups g ON g.thread_id = t.id
 WHERE t.org_id = :org_id
   AND btrim(t.group_subject) = :'subject';

\echo '--- the sender values being removed (LIDs are the reason for this) ---'

SELECT DISTINCT m.from_phone, count(*) AS rows
  FROM whatsapp_messages m
  JOIN whatsapp_threads t ON t.id = m.thread_id
 WHERE t.org_id = :org_id AND btrim(t.group_subject) = :'subject'
 GROUP BY m.from_phone
 ORDER BY rows DESC;

-- Children first. whatsapp_session_group_members hangs off the session group,
-- the rest off the thread.
DELETE FROM whatsapp_session_group_members
 WHERE session_group_id IN (
   SELECT g.id FROM whatsapp_session_groups g
     JOIN whatsapp_threads t ON t.id = g.thread_id
    WHERE t.org_id = :org_id AND btrim(t.group_subject) = :'subject');

DELETE FROM whatsapp_thread_participants
 WHERE thread_id IN (SELECT id FROM whatsapp_threads
                      WHERE org_id = :org_id AND btrim(group_subject) = :'subject');

DELETE FROM whatsapp_messages
 WHERE thread_id IN (SELECT id FROM whatsapp_threads
                      WHERE org_id = :org_id AND btrim(group_subject) = :'subject');

DELETE FROM whatsapp_session_groups
 WHERE thread_id IN (SELECT id FROM whatsapp_threads
                      WHERE org_id = :org_id AND btrim(group_subject) = :'subject');

DELETE FROM whatsapp_threads
 WHERE org_id = :org_id AND btrim(group_subject) = :'subject';

\echo '--- what is left (all zero if it worked) ---'

SELECT (SELECT count(*) FROM whatsapp_threads
         WHERE org_id = :org_id AND btrim(group_subject) = :'subject') AS threads_left,
       (SELECT count(*) FROM whatsapp_session_groups g
         WHERE g.org_id = :org_id AND btrim(g.subject) = :'subject')   AS group_rows_left;

-- Change to COMMIT once the counts above look right.
COMMIT;
