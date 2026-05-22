-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Prospecting Escalations + prospecting_activities.org_id
-- Sprint 1 (Group A)
-- ─────────────────────────────────────────────────────────────────────────────
-- Two related changes bundled because both are required for prospecting
-- notifications/escalations to work cleanly:
--
--   1. prospecting_actions gains escalation tracking columns so the notification
--      service can decide who to notify, when, and at which tier — and avoid
--      re-notifying for the same overdue action.
--
--   2. prospecting_activities gains its own org_id column. Previously, org-scope
--      was reached via JOIN prospects p ON p.id = pa.prospect_id. That works
--      for correctness but means every campaign-level aggregation query carries
--      an extra join. With org_id on the row, the new campaign union query
--      (Sprint 2) and the escalation queries (this sprint) can index directly.
--
-- Idempotent: all ADD COLUMN clauses use IF NOT EXISTS. Backfill is safe to
-- re-run (UPDATE only touches rows where org_id IS NULL).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. prospecting_actions escalation columns ────────────────────────────────
-- notification_sent_at: when an immediate alert was sent. NULL = never sent
--   yet. Used by findProspectingActionsForImmediateNotification to skip rows
--   already notified (mirrors actions.notification_sent_at semantics).
--
-- escalated_at:    when the action was last escalated to a higher tier. NULL
--                  if no escalation has occurred yet. Used as a debounce.
-- escalation_tier: 0 = none, 1 = rep nudged, 2 = manager notified, 3 = skip-level.
--                  Monotonic — only goes up.

ALTER TABLE prospecting_actions
  ADD COLUMN IF NOT EXISTS notification_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS escalated_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS escalation_tier      SMALLINT NOT NULL DEFAULT 0;

-- Partial index for the immediate-notification scan: only the rows we'd ever
-- look at. Without this, the scan does a sequential scan over completed/
-- snoozed rows we don't care about.
CREATE INDEX IF NOT EXISTS idx_prospecting_actions_immediate_scan
  ON prospecting_actions (org_id, due_date)
  WHERE status = 'pending' AND notification_sent_at IS NULL;

-- Partial index for the escalation scan: pending rows that are eligible for
-- a tier bump (i.e. their current tier is below 3).
CREATE INDEX IF NOT EXISTS idx_prospecting_actions_escalation_scan
  ON prospecting_actions (org_id, due_date, escalation_tier)
  WHERE status = 'pending' AND escalation_tier < 3;

-- ── 2. prospecting_activities.org_id ─────────────────────────────────────────
-- Add the column nullable first so the backfill can run, then set NOT NULL.

ALTER TABLE prospecting_activities
  ADD COLUMN IF NOT EXISTS org_id INTEGER;

-- Backfill from prospects.org_id. Safe to re-run (only touches NULL rows).
UPDATE prospecting_activities pa
   SET org_id = p.org_id
  FROM prospects p
 WHERE pa.prospect_id = p.id
   AND pa.org_id IS NULL;

-- If any activities are orphaned (prospect deleted but activity row remained),
-- they'll be left with org_id IS NULL after the backfill. Surface this to
-- ops via a SELECT log — if any exist, the NOT NULL constraint below will
-- fail and we'll know to clean them up first.
DO $$
DECLARE
  orphaned_count INT;
BEGIN
  SELECT COUNT(*) INTO orphaned_count
    FROM prospecting_activities WHERE org_id IS NULL;
  IF orphaned_count > 0 THEN
    RAISE NOTICE 'prospecting_activities: % rows have NULL org_id after backfill (orphaned, prospect deleted). Delete or fix before this migration completes.', orphaned_count;
  END IF;
END $$;

-- Lock in the constraint. If the NOTICE above fired with a non-zero count,
-- this statement will fail and the whole transaction rolls back. That's the
-- correct safety behaviour — don't add NOT NULL with junk data present.
ALTER TABLE prospecting_activities
  ALTER COLUMN org_id SET NOT NULL;

-- FK now that the column is fully populated.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'prospecting_activities_org_id_fkey'
  ) THEN
    ALTER TABLE prospecting_activities
      ADD CONSTRAINT prospecting_activities_org_id_fkey
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Indexes for the queries that will use this column:
--   - Campaign union (Sprint 2): filter by org + time range
--   - Per-prospect activity feed: already covered by prospect_id index
--   - Aggregations by activity_type within an org

CREATE INDEX IF NOT EXISTS idx_prospecting_activities_org_created
  ON prospecting_activities (org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_prospecting_activities_org_prospect_type
  ON prospecting_activities (org_id, prospect_id, activity_type);

COMMIT;
