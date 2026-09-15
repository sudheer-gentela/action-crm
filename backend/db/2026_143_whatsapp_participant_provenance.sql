-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_143_whatsapp_participant_provenance.sql
--
-- E6: history visibility based on what we actually observed, not on when we
-- happened to notice someone.
--
-- THE DEFECT
--   whatsapp_thread_participants.joined_at is set to now() the first time
--   GoWarm sees a number — speaking, or in a roster sync.
--   buildVisibilityClause bounds that person's search to messages at or after
--   it. So a member who was in the group all along but stayed quiet for a
--   fortnight is cut off from a fortnight of their own group. The harness shows
--   it as a member seeing 1 of 4.
--
--   The bound is wrong in a specific direction: it UNDER-serves genuine
--   members. Nobody is seeing anything they should not; real members are being
--   denied a record they read in WhatsApp at the time.
--
-- WHAT WHATSAPP GIVES US
--   No join timestamp, in group metadata or anywhere else. There is no date to
--   recover, so this migration invents none.
--
-- THE RULE, AND IT IS ONE RULE
--   A message proves someone was present THEN. It proves nothing about before.
--   The only evidence that someone was ABSENT earlier is a roster we synced
--   that did not contain them. So:
--
--     bound their history  <=>  this thread has had a roster, and they were not
--                               in it
--
--   Everything else follows. Present in the first roster we ever synced: no
--   bound, because our record starts later than their membership, and showing
--   them all of it is the truth rather than a guess. Seen speaking with no
--   roster ever synced: no bound, because we have never held a membership list
--   for this group and cannot claim they were missing from one. Appearing after
--   a roster that lacked them: bounded, and joined_at is a real upper bound on
--   when they arrived, accurate to the sync that noticed.
--
--   whatsapp_threads.roster_synced_at is what makes "has had a roster"
--   answerable, and it is why it lives on the thread rather than being inferred
--   from participant rows: the absence of a row is exactly what we need to tell
--   apart from the absence of a roster.
--
-- THIS WIDENS ACCESS ON EXISTING DATA, ON PURPOSE
--   Every participant recorded before today becomes unbounded, because we never
--   observed their absence and the joined_at currently bounding them is not a
--   join date — it is the day we noticed. Keeping a bound we know to be
--   arbitrary would be preserving the defect rather than fixing it. The members
--   affected hold a VERIFIED number that a roster or a message placed in the
--   group; this widens nothing for anybody else, and the left_at upper bound is
--   untouched.
--
--   If that is not wanted, late_joiner_history below is not the lever — it
--   governs observed late joiners only. The lever would be to set
--   history_bounded true for the backfilled rows, which is a deliberate
--   statement that the old joined_at values should be treated as real join
--   dates. They are not.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE public.whatsapp_threads
  ADD COLUMN IF NOT EXISTS roster_synced_at timestamp with time zone;

COMMENT ON COLUMN public.whatsapp_threads.roster_synced_at IS
  'When a participant roster was last synced for this thread. NULL means we have never held a membership list for it, which is why someone seen only speaking cannot be treated as a late joiner.';

ALTER TABLE public.whatsapp_thread_participants
  ADD COLUMN IF NOT EXISTS joined_source    text,
  ADD COLUMN IF NOT EXISTS history_bounded  boolean NOT NULL DEFAULT false;

UPDATE public.whatsapp_thread_participants
   SET joined_source = 'unknown'
 WHERE joined_source IS NULL;

ALTER TABLE public.whatsapp_thread_participants
  ALTER COLUMN joined_source SET DEFAULT 'unknown',
  ALTER COLUMN joined_source SET NOT NULL;

ALTER TABLE public.whatsapp_thread_participants
  DROP CONSTRAINT IF EXISTS wa_participants_joined_source_chk;
ALTER TABLE public.whatsapp_thread_participants
  ADD CONSTRAINT wa_participants_joined_source_chk
  CHECK (joined_source = ANY (ARRAY[
    'first_roster'::text, 'later_roster'::text, 'first_message'::text, 'unknown'::text
  ]));

-- A first_roster row can never be bounded: being in the first list we ever saw
-- is the definition of predating our record. The other sources may be either,
-- because what decides them is whether a roster had already been synced.
ALTER TABLE public.whatsapp_thread_participants
  DROP CONSTRAINT IF EXISTS wa_participants_bounded_chk;
ALTER TABLE public.whatsapp_thread_participants
  ADD CONSTRAINT wa_participants_bounded_chk
  CHECK (history_bounded = false OR joined_source <> 'first_roster');

COMMENT ON COLUMN public.whatsapp_thread_participants.joined_source IS
  'How this membership was learned: first_roster (in the first roster synced for the thread), later_roster, first_message (seen speaking), unknown (recorded before 2026_143).';
COMMENT ON COLUMN public.whatsapp_thread_participants.history_bounded IS
  'True only when we OBSERVED this person''s absence: the thread had already been rostered and they were not in it. Read by whatsappAccess.buildVisibilityClause; false means no lower bound, because a bound would be a guess.';

-- ─────────────────────────────────────────────────────────────────────────────
-- The switch, for members we watched arrive.
--
--   from_join  (default) an observed late joiner reads from when we first knew
--              they were in the group. Never shows anyone a discussion that
--              predates their membership.
--   all        they read the whole captured group. Right for an org that treats
--              a project group as a shared record somebody inherits.
--
-- Affects history_bounded rows only. Someone who predates our record, or whose
-- absence we never observed, is unbounded under either setting — there is no
-- honest date to bound them by.
--
-- Per SESSION, beside capture_mode and capture_media, because that is where the
-- org-wide capture decisions already live.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.whatsapp_sessions
  ADD COLUMN IF NOT EXISTS late_joiner_history text NOT NULL DEFAULT 'from_join';

ALTER TABLE public.whatsapp_sessions
  DROP CONSTRAINT IF EXISTS wa_sessions_late_joiner_history_chk;
ALTER TABLE public.whatsapp_sessions
  ADD CONSTRAINT wa_sessions_late_joiner_history_chk
  CHECK (late_joiner_history = ANY (ARRAY['from_join'::text, 'all'::text]));

COMMENT ON COLUMN public.whatsapp_sessions.late_joiner_history IS
  'What a member we watched JOIN may read. from_join = from when we first knew they were in the group (default). all = the whole captured group. No effect on members whose absence was never observed.';

COMMIT;
