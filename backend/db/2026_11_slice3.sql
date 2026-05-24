-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Slice 3 — Per-channel/per-intent skills + dispatcher
-- ─────────────────────────────────────────────────────────────────────────────
-- Adds a column to sequence_steps for explicit step_intent override. When
-- null, the PersonalizationDispatcher infers intent from channel + position +
-- engagement_history (see services/PersonalizationDispatcher.js).
--
-- Also documents (via comments) that the old outreach-personalization skill
-- is retired in this slice — its folder remains on disk for back-compat with
-- skill_runs history rows, but no new code path invokes it. Slice 3 routes
-- the on-demand Intel-tab use case through outreach-email + outreach-linkedin
-- in parallel.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── (1) sequence_steps.step_intent ───────────────────────────────────────────
-- Nullable. Valid values are enforced application-side (in
-- PersonalizationDispatcher.VALID_INTENTS) rather than via CHECK so we can
-- add new intents in code without a migration.
--
-- When NULL: dispatcher infers intent from channel + step_order + engagement.
-- When SET : dispatcher uses the override verbatim and skips inference.
ALTER TABLE sequence_steps
  ADD COLUMN IF NOT EXISTS step_intent TEXT;

COMMENT ON COLUMN sequence_steps.step_intent IS
  'Optional override for personalization dispatcher. NULL = auto-infer. ' ||
  'Email intents: first_touch, follow_up, breakup. ' ||
  'LinkedIn intents: connection_request, post_accept_message, nurture_dm.';

-- ── (2) Documentation: retirement of outreach-personalization ────────────────
-- The old skill's folder (skills/outreach-personalization/) stays on disk so
-- existing skill_runs history rows remain queryable. No new SkillRunnerService
-- code path calls it. Slice 3 introduces:
--   skills/outreach-email/
--   skills/outreach-linkedin/
-- Both are registered in services/SkillRunnerService.js SKILL_REGISTRY.

COMMIT;
