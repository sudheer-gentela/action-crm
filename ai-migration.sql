-- ============================================================
-- DATABASE MIGRATION: Support for AI Email Processing & Playbooks
-- ============================================================

-- Table to store user-specific playbook customizations
CREATE TABLE IF NOT EXISTS user_playbooks (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  playbook_data JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id)
);

CREATE INDEX idx_user_playbooks_user_id ON user_playbooks(user_id);

-- Add AI-specific columns to actions table (if not already present)
DO $$ 
BEGIN
  -- Add context column for AI explanations
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'actions' AND column_name = 'context'
  ) THEN
    ALTER TABLE actions ADD COLUMN context TEXT;
  END IF;

  -- Add metadata column for AI confidence, triggers, etc.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'actions' AND column_name = 'metadata'
  ) THEN
    ALTER TABLE actions ADD COLUMN metadata JSONB;
  END IF;

  -- Add source_id for tracking which email/document generated the action
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'actions' AND column_name = 'source_id'
  ) THEN
    ALTER TABLE actions ADD COLUMN source_id VARCHAR(255);
  END IF;
END $$;

-- Table to track AI processing history (optional but useful for debugging)
CREATE TABLE IF NOT EXISTS ai_processing_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source VARCHAR(50) NOT NULL, -- 'outlook', 'gmail', 'google_drive', etc.
  source_id VARCHAR(255) NOT NULL, -- email ID or document ID
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  confidence_score DECIMAL(3,2),
  actions_generated INTEGER,
  success BOOLEAN DEFAULT true,
  error_message TEXT,
  processing_time_ms INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_ai_log_user_id ON ai_processing_log(user_id);
CREATE INDEX idx_ai_log_created_at ON ai_processing_log(created_at);

-- Verify migrations
SELECT 'user_playbooks table' as migration, 
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_playbooks') 
            THEN '✅ Created' 
            ELSE '❌ Failed' 
       END as status
UNION ALL
SELECT 'ai_processing_log table',
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ai_processing_log') 
            THEN '✅ Created' 
            ELSE '❌ Failed' 
       END
UNION ALL
SELECT 'actions.context column',
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'actions' AND column_name = 'context') 
            THEN '✅ Added' 
            ELSE '❌ Failed' 
       END
UNION ALL
SELECT 'actions.metadata column',
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'actions' AND column_name = 'metadata') 
            THEN '✅ Added' 
            ELSE '❌ Failed' 
       END;

-- ============================================================
-- DONE! Database is ready for AI processing
-- ============================================================
