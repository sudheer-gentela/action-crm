-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_147_research_pipeline.sql
--
-- Phase 1, step 1.1b: background research on flagged prospects, with a
-- person signing off on every result.
--
-- Lifecycle (prospects.research_status):
--
--   NULL               not flagged (the default for every existing row)
--   queued             flagged; the sweeper will pick it up once
--                      research_next_attempt_at has passed
--   researching        claimed by a sweeper run (research_started_at set)
--   ready_for_review   research done; waiting on a person
--   failed             gave up after 3 tries (research_last_error says why)
--   reviewed           a person approved or rejected it — the outcome sits in
--                      research_review_outcome, NOT in research_status
--
-- The review fields are deliberately separate from disqualified_reason_code,
-- revisit_disposition (nurture) and stage. "The research wasn't good enough"
-- is a judgement about the AI's output; "this person isn't a fit" is a
-- judgement about the prospect. Mixing them would make agent research-quality
-- numbers (approval rate) unreadable and would make a bad research run look
-- like a disqualified prospect.
--
-- created_via records WHO created the row (human / agent / system), so the
-- agent's open work can be capped (25 per user, admin-editable) and its
-- results measured separately. Existing rows are 'human'.
--
-- research_fit holds the intake fit check (ProspectClassifier + FitGate)
-- result — { verdict, reasons, unknown, checked_at } — so a prospect that
-- wasn't auto-flagged shows why, and a person can flag it anyway.
--
-- Idempotent. NUMBERING: 146 = ai_spend_guard. This is 147.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

ALTER TABLE prospects
  ADD COLUMN IF NOT EXISTS research_status           varchar(20),
  ADD COLUMN IF NOT EXISTS research_flag_source      varchar(20),
  ADD COLUMN IF NOT EXISTS research_flagged_by       integer REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS research_flagged_at       timestamp without time zone,
  ADD COLUMN IF NOT EXISTS research_attempts         integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS research_next_attempt_at  timestamp without time zone,
  ADD COLUMN IF NOT EXISTS research_started_at       timestamp without time zone,
  ADD COLUMN IF NOT EXISTS research_completed_at     timestamp without time zone,
  ADD COLUMN IF NOT EXISTS research_last_error       text,
  ADD COLUMN IF NOT EXISTS research_fit              jsonb,
  ADD COLUMN IF NOT EXISTS research_review_outcome   varchar(20),
  ADD COLUMN IF NOT EXISTS research_review_reason    text,
  ADD COLUMN IF NOT EXISTS research_reviewed_by      integer REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS research_reviewed_at      timestamp without time zone,
  ADD COLUMN IF NOT EXISTS created_via               varchar(20) NOT NULL DEFAULT 'human';

-- CHECK constraints added separately so a re-run doesn't fail on "already exists".
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_prospect_research_status') THEN
    ALTER TABLE prospects ADD CONSTRAINT chk_prospect_research_status CHECK (
      research_status IS NULL OR research_status IN
        ('queued','researching','ready_for_review','failed','reviewed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_prospect_research_flag_source') THEN
    ALTER TABLE prospects ADD CONSTRAINT chk_prospect_research_flag_source CHECK (
      research_flag_source IS NULL OR research_flag_source IN
        ('intake','extension','manual','agent'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_prospect_research_review_outcome') THEN
    ALTER TABLE prospects ADD CONSTRAINT chk_prospect_research_review_outcome CHECK (
      research_review_outcome IS NULL OR research_review_outcome IN ('approved','rejected'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_prospect_created_via') THEN
    ALTER TABLE prospects ADD CONSTRAINT chk_prospect_created_via CHECK (
      created_via IN ('human','agent','system'));
  END IF;
END $$;

-- The sweeper's claim query: due, queued, live rows. Partial so it stays tiny.
CREATE INDEX IF NOT EXISTS idx_prospects_research_due
  ON prospects (research_next_attempt_at)
  WHERE research_status = 'queued' AND deleted_at IS NULL;

-- "What's waiting on me" (review list, agent cap, ready counts).
CREATE INDEX IF NOT EXISTS idx_prospects_research_owner
  ON prospects (org_id, owner_id, research_status)
  WHERE research_status IS NOT NULL AND deleted_at IS NULL;

COMMIT;
