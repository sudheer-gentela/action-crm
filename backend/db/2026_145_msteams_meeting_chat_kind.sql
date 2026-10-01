-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_145_msteams_meeting_chat_kind.sql
--
-- Discovery stored chats whose chatType came back as 'unknownFutureValue' as
-- kind='group'. All of them are meeting chats (thread id 19:meeting_…), and
-- msteams.service now classifies them by id going forward. upsertConversation
-- deliberately never rewrites kind on conflict, so rows already written stay
-- wrong until corrected here.
--
-- Data-only and idempotent. is_watched / binding are untouched: if a rep has
-- chosen to watch one of these, it stays watched — it just stops being listed
-- as a group chat.
--
-- NUMBERING: 144 = paction_prospect_nullable. This is 145.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

UPDATE msteams_conversations
   SET kind = 'meeting', updated_at = now()
 WHERE kind = 'group'
   AND graph_id LIKE '19:meeting\_%' ESCAPE '\';

COMMIT;
