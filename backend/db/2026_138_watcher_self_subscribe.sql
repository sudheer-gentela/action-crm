-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_138_watcher_self_subscribe.sql
--
-- Lets a person put THEMSELVES on a project's review alert list, and stops a
-- manager's edit from silently removing them again.
--
-- ── THE PROBLEM THIS FIXES ───────────────────────────────────────────────────
--
-- setWatchers() replaces the whole list: DELETE every row for the project, then
-- INSERT the ids it was handed. That is the right shape for a manager editing a
-- list they own, and it is fatal for self-subscription. A member opts in; the
-- Project Manager later adds one person through the panel; the PUT carries only
-- the ids the panel had on screen; the member's row is deleted. They simply
-- stop being told about anything, with no event, no message and no way to
-- notice other than the absence of mail they were not expecting to be absent.
--
-- ── WHY A COLUMN AND NOT A DERIVATION ────────────────────────────────────────
--
-- created_by = user_id already means "added themselves" for every row written
-- today, so the distinction could be derived with no migration at all. It is
-- not, for two reasons.
--
-- First, it is only incidentally true. seedWatchersFromOrgDefault writes the
-- creating user's id into created_by for people who did not ask to be there, so
-- a Project Manager who is also in the org's default watcher list gets a row
-- where created_by = user_id and has "self-subscribed" without doing anything.
-- The derivation is already wrong for that case.
--
-- Second, it fails silently when it breaks. If setWatchers is ever changed to
-- write a different created_by, every self-subscription in the product becomes
-- deletable again, and nothing anywhere raises. A column says what it means and
-- keeps saying it.
--
-- ── DEFAULT FALSE ────────────────────────────────────────────────────────────
--
-- Every existing row is a manager-managed one, which is exactly what they are.
-- No backfill: there are no self-subscriptions yet because there was no way to
-- make one.
--
-- Safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE public.project_play_watchers
  ADD COLUMN IF NOT EXISTS self_subscribed boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.project_play_watchers.self_subscribed IS
  'TRUE when the person added themselves rather than being added by a manager. setWatchers() must not delete these rows — the manager did not put them there and cannot see them in the picker. The person removes their own subscription, and removeMember/leaving the project clears it.';

COMMIT;
