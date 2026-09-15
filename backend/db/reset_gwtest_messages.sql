-- ─────────────────────────────────────────────────────────────────────────────
-- reset_gwtest_messages.sql — forget one GWTEST group's TRAFFIC, keep the group.
--
-- USE THIS RATHER THAN reset_gwtest_group.sql WHEN THE SNAPSHOT IS EMPTY.
--
--   The Captured Groups screen has two different sources. The stored row — the
--   one with the On switch — comes from Postgres. "In this list" comes from the
--   worker's live snapshot, held in memory for five minutes and refilled only
--   when the worker answers a refresh request on its next heartbeat.
--
--   Deleting the whole group removes the stored row, and switching capture back
--   on then REQUIRES the live snapshot, because an undecided group has no
--   database id to switch. With "In this list" showing 0 — a worker that has
--   just restarted and not yet reported — there would be nothing to switch on,
--   and G1 would sit uncapturable until the snapshot returns.
--
--   Deleting only the traffic avoids that entirely. is_watched stays true, the
--   group keeps capturing, and the next message is stored by the new worker
--   with a real phone number on it.
--
-- WHAT IT TOUCHES
--   Messages and participant rows for ONE group, by org and exact subject. The
--   thread, the group row, the watch state, the session and every other group
--   are left alone.
--
-- HOW TO RUN IT
--   Set org_id below, run the whole file, READ THE COUNTS, then change the
--   final ROLLBACK to COMMIT and run it again. As written it undoes itself, so
--   a mistyped org id costs a printout and nothing else.
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

\echo '--- senders currently stored (14+ digits means the old worker captured them) ---'

SELECT m.from_phone,
       length(regexp_replace(coalesce(m.from_phone, ''), '[^0-9]', '', 'g')) AS digits,
       count(*) AS rows,
       min(m.created_at) AS first_seen,
       max(m.created_at) AS last_seen
  FROM whatsapp_messages m
  JOIN whatsapp_threads t ON t.id = m.thread_id
 WHERE t.org_id = :org_id AND btrim(t.group_subject) = :'subject'
 GROUP BY 1, 2
 ORDER BY rows DESC;

DELETE FROM whatsapp_thread_participants
 WHERE thread_id IN (SELECT id FROM whatsapp_threads
                      WHERE org_id = :org_id AND btrim(group_subject) = :'subject');

DELETE FROM whatsapp_messages
 WHERE thread_id IN (SELECT id FROM whatsapp_threads
                      WHERE org_id = :org_id AND btrim(group_subject) = :'subject');

-- The counter on the Captured Groups screen is stored, not derived, so it has
-- to be reset too or the row keeps claiming messages that are gone.
UPDATE whatsapp_session_groups g
   SET message_count = 0, last_message_at = NULL, updated_at = now()
  FROM whatsapp_threads t
 WHERE t.id = g.thread_id
   AND t.org_id = :org_id AND btrim(t.group_subject) = :'subject';

-- A fresh roster should be treated as the FIRST one for this thread, so the
-- members it names are read as predating capture rather than as late arrivals
-- (2026_143). Without this the thread still looks rostered and everyone in the
-- next sync is bounded.
UPDATE whatsapp_threads
   SET roster_synced_at = NULL
 WHERE org_id = :org_id AND btrim(group_subject) = :'subject';

\echo '--- after (messages 0, and the group row still watched) ---'

SELECT (SELECT count(*) FROM whatsapp_messages m
          JOIN whatsapp_threads t ON t.id = m.thread_id
         WHERE t.org_id = :org_id AND btrim(t.group_subject) = :'subject') AS messages_left,
       g.is_watched, g.binding_status, g.message_count
  FROM whatsapp_session_groups g
  JOIN whatsapp_threads t ON t.id = g.thread_id
 WHERE t.org_id = :org_id AND btrim(t.group_subject) = :'subject';

-- Change to COMMIT once the counts above look right.
COMMIT;
