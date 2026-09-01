-- 2026_134_activity_type_retire.sql
--
-- Lets an activity type be taken out of circulation without deleting it.
--
-- ── Why this migration is needed at all ──────────────────────────────
--
-- daily_activity_types' own table comment (2026_131) says system entries are
-- "renameable and deactivatable but never deleted". Renaming works — label is
-- a plain column. DEACTIVATING never did: chk_dat_status permits exactly
-- ('active', 'candidate', 'merged'), and none of those means "we do not use
-- this any more". The intent was documented and the constraint never caught up.
--
-- ── Why a fourth status rather than an is_active column ──────────────
--
-- Because the three existing values are already mutually exclusive states of
-- one lifecycle, and a boolean beside them would create combinations with no
-- meaning — is_active = false on a 'merged' row, or on a 'candidate' nobody
-- has reviewed. One column, four values, no impossible states.
--
-- ── Why RETIRE AND NOT DELETE ────────────────────────────────────────
--
-- daily_work_entries.activity_type_key is a plain text column with NO foreign
-- key. Deleting the type would leave every historical entry pointing at a key
-- that resolves to nothing — and the manager rollup
-- (dailyWorkQuery.getRollup, byActivity) groups on that raw key, so those
-- entries would silently become an unlabelled bucket rather than an error
-- anyone could see. Retiring keeps the row, so the label stays resolvable
-- forever.
--
-- This is the same reasoning as retiring a standing initiative in 2026_133,
-- and deliberately the same word.
--
-- ── Interaction with the merge constraint ────────────────────────────
--
-- chk_dat_merge_shape requires merged_into_key IS NULL for any status that is
-- not 'merged'. 'retired' satisfies that branch unchanged, so that constraint
-- needs no edit — a retired type carries no merge pointer, which is right:
-- retiring is not folding into something else.

BEGIN;

ALTER TABLE daily_activity_types
  DROP CONSTRAINT IF EXISTS chk_dat_status;

ALTER TABLE daily_activity_types
  ADD CONSTRAINT chk_dat_status
  CHECK (status = ANY (ARRAY['active'::text, 'candidate'::text,
                             'merged'::text, 'retired'::text]));

COMMENT ON COLUMN daily_activity_types.status IS
  'active: in the shared list, offered by every picker. '
  'candidate: proposed by a member via "Other", usable by them while it waits '
  'for a manager. '
  'merged: folded into merged_into_key; never offered, kept so historical '
  'entries still resolve. '
  'retired: deliberately taken out of circulation. Never offered in a picker, '
  'kept so historical entries still resolve. Reversible — see 2026_134.';

COMMIT;
