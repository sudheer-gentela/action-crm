-- ============================================================================
-- db/2026_18_prompt_cache_telemetry.sql
--
-- Prompt-cache telemetry columns + skill_runs status constraint fix.
--
-- RUN THIS BEFORE deploying the matching backend code: the updated
-- TokenTrackingService.log and SkillRunnerService.persistSkillRun INSERT
-- into the new columns and will fail if they don't exist yet.
--
-- Column semantics (matching the code change):
--   prompt_tokens / input_tokens  = TOTAL input tokens
--                                   (uncached + cache reads + cache writes)
--                                   — unchanged meaning, so every existing
--                                   dashboard query keeps working.
--   cache_read_tokens             = tokens served from the prompt cache
--                                   (billed at 0.1x base input)
--   cache_creation_tokens         = tokens written to the prompt cache
--                                   (billed at 1.25x base input for 5m TTL)
--
-- ADD COLUMN ... NOT NULL DEFAULT 0 is metadata-only on PG 11+ — no table
-- rewrite, safe on the live Railway instance.
-- ============================================================================

BEGIN;

ALTER TABLE ai_token_usage
  ADD COLUMN IF NOT EXISTS cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cache_creation_tokens INTEGER NOT NULL DEFAULT 0;

ALTER TABLE skill_runs
  ADD COLUMN IF NOT EXISTS cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cache_creation_tokens INTEGER NOT NULL DEFAULT 0;

-- ----------------------------------------------------------------------------
-- BUG FIX (discovered while verifying this migration against the live schema):
--
-- skill_runs_status_check allows only ('ok','parse_failed','execution_failed'),
-- but SkillRunnerService.persistSkippedRun writes status='skipped' for
-- prospects the fit gate disqualifies before any model call. Because
-- persistSkippedRun is deliberately best-effort (try/catch + console.warn),
-- every one of those audit rows has been silently rejected by this constraint
-- since the fit gate shipped. The skip *decision* still worked — only the
-- audit trail was lost.
--
-- Adding 'skipped' to the allowed set restores the audit trail going forward.
-- (Historical skipped rows are unrecoverable; they were never inserted.)
-- ----------------------------------------------------------------------------

ALTER TABLE skill_runs DROP CONSTRAINT IF EXISTS skill_runs_status_check;
ALTER TABLE skill_runs ADD CONSTRAINT skill_runs_status_check
  CHECK (status = ANY (ARRAY[
    'ok'::text,
    'parse_failed'::text,
    'execution_failed'::text,
    'skipped'::text
  ]));

COMMIT;
