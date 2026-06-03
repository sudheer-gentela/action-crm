-- 2026_15_user_timezone_and_revisit_disposition.sql
--
-- Two related changes shipped together:
--
-- 1. users.timezone — per-rep IANA timezone (e.g. 'Asia/Kolkata').
--    Auto-captured at register / first login, editable in My Preferences.
--    NULL means "never captured" and is treated as UTC at format time.
--    No CHECK: the IANA set is large and evolves, so we validate app-side
--    (Intl.supportedValuesOf), consistent with the VALID_INTENTS precedent.
--
-- 2. prospects.disqualified_reason -> revisit_disposition.
--    The column's allowed values (kill / long_term / unable_to_decide) are a
--    revisit *disposition*, not a fit *reason*. The fit reason lives in
--    disqualified_reason_code. Renaming separates the two axes honestly.
--    RENAME COLUMN is metadata-only: data, the CHECK, and any indexes are
--    preserved automatically. The constraint is renamed to match.
--
-- Non-destructive. Safe to run once. Deploy with the code that reads/writes
-- these columns (the rename is not independently deploy-safe).

BEGIN;

-- 1. Per-rep timezone
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS timezone TEXT;

-- 2. Rename disposition column + its CHECK
ALTER TABLE prospects
  RENAME COLUMN disqualified_reason TO revisit_disposition;

ALTER TABLE prospects
  RENAME CONSTRAINT chk_prospect_disqualified_reason TO chk_prospect_revisit_disposition;

COMMIT;
