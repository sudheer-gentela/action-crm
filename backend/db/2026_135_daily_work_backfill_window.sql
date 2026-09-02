-- 2026_135_daily_work_backfill_window.sql
--
-- Lets a person write yesterday's work this morning.
--
-- THE PROBLEM. POST /daily-work/day derived entry_date from the server clock
-- and refused to take one from the client, so an entry always landed on the
-- day it was typed. Writing up Monday over Tuesday's coffee is not a
-- correction, it is when most people actually write -- and under that rule
-- every one of those landed on the wrong day, and "logged 4 of 5 working days"
-- under-reported somebody who had in fact worked and written up all five.
--
-- WHY A WINDOW RATHER THAN FREE CHOICE. The old comment on that route was
-- right about the risk: if the client picks the date, a month of history can be
-- constructed on the 30th and the logging rate stops meaning anything. A bounded
-- window keeps the ordinary case working without granting that. Five days back,
-- never forward. The bound is enforced in the service, not here, because it is
-- a policy that may be tuned per org later; what the schema has to do is keep
-- the DISTINCTION, so that tuning the policy never silently rewrites how
-- earlier entries read.
--
-- WHAT THIS COLUMN IS. written_on is the author's LOCAL date at the moment they
-- saved. entry_date is the day the work happened. They are equal for an entry
-- written the same day; written_on is later for a backfilled one. Keeping the
-- author's local date rather than a timestamp matters: created_at is already
-- there and is a server-side timestamptz, so deriving "was this late" from it
-- means re-deriving the author's timezone at read time, and the answer changes
-- if their timezone changes. A date resolved once, at write time, in the zone
-- that applied then, does not drift.
--
-- Nullable on purpose, with no backfill of existing rows. Every entry written
-- before this migration was written on its own entry_date -- that was the only
-- thing the code could do -- so NULL reads as "same day, and we did not have to
-- record it". Filling them in with entry_date would assert a fact we merely
-- infer, and would make it impossible to tell later which rows predated the
-- feature.

ALTER TABLE public.daily_work_entries
  ADD COLUMN IF NOT EXISTS written_on date;

COMMENT ON COLUMN public.daily_work_entries.written_on IS
  'Author local date at save time. NULL or = entry_date means written the same '
  'day; later than entry_date means backfilled within the allowed window. Set '
  'once at insert and left alone by later edits to the same entry, so it '
  'records when the day was first written up, not when it was last touched.';

-- Guards the invariant the service enforces, at the level that cannot be
-- bypassed by a future caller that forgets. Forward-dating is the failure that
-- matters -- logging work that has not happened yet -- and it is cheap to make
-- structurally impossible. The five-day bound is deliberately NOT here: it is
-- policy, and a CHECK would make an org-level setting a migration.
ALTER TABLE public.daily_work_entries
  DROP CONSTRAINT IF EXISTS daily_work_entries_written_on_not_before_entry;
ALTER TABLE public.daily_work_entries
  ADD CONSTRAINT daily_work_entries_written_on_not_before_entry
  CHECK (written_on IS NULL OR written_on >= entry_date);

-- Finding backfilled entries is a reporting question ("who writes up late"),
-- not a hot path, so this is a partial index on the rows that can answer it
-- rather than an index over the whole table.
-- user_id, not owner_user_id. The owning column is called owner_user_id on
-- daily_work_items and user_id on daily_work_entries; the first version of this
-- migration used the items name here and failed. The existing compliance index
-- on this table, idx_daily_work_entries_user_date, uses (org_id, user_id,
-- entry_date) and is the shape to match.
CREATE INDEX IF NOT EXISTS idx_daily_work_entries_backfilled
  ON public.daily_work_entries (org_id, user_id, entry_date)
  WHERE written_on IS NOT NULL AND written_on > entry_date;
