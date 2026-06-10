-- ============================================================================
-- db/2026_19_lowercase_emails.sql
--
-- Normalize users.email to lowercase and enforce case-insensitive uniqueness.
--
-- WHY: login/register/forgot-password now lowercase the *input* before
-- lookup. Code-side this is paired with LOWER(email) comparisons, so nothing
-- breaks before this migration runs — but normalizing the stored values keeps
-- the data canonical, and the unique index makes case-variant duplicate
-- accounts impossible at the database level (the app-level duplicate check
-- has a read-then-write race window; this closes it).
--
-- RUN ORDER: deploy order vs. the backend code does not matter (the code uses
-- LOWER() comparisons either way), but run this soon after deploying so the
-- unique index protects registration.
--
-- SAFETY: step 1 ABORTS the whole transaction if two existing accounts differ
-- only by case (e.g. Foo@x.com and foo@x.com). Merging accounts is a human
-- decision — resolve those rows manually, then re-run. The error message
-- lists the colliding emails.
-- ============================================================================

BEGIN;

-- ── 1. Abort if case-collision duplicates exist ──────────────────────────────
DO $$
DECLARE
  dup_list TEXT;
BEGIN
  SELECT string_agg(lower_email || ' (' || cnt || ' accounts)', ', ')
    INTO dup_list
  FROM (
    SELECT LOWER(email) AS lower_email, COUNT(*) AS cnt
    FROM users
    GROUP BY LOWER(email)
    HAVING COUNT(*) > 1
  ) d;

  IF dup_list IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot lowercase emails — case-collision duplicates exist: %. '
      'Merge or remove these accounts manually, then re-run this migration.',
      dup_list;
  END IF;
END $$;

-- ── 2. Lowercase all stored emails ───────────────────────────────────────────
UPDATE users
   SET email = LOWER(email), updated_at = NOW()
 WHERE email <> LOWER(email);

-- ── 3. Enforce case-insensitive uniqueness going forward ─────────────────────
-- Expression index on LOWER(email): also makes the code's
-- WHERE LOWER(email) = $1 lookups index-backed instead of seq scans.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_lower
  ON users (LOWER(email));

COMMIT;
