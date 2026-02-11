-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- OAuth tokens for Outlook
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(50) NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at TIMESTAMP,
  account_data JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, provider)
);

-- Email sync history
CREATE TABLE IF NOT EXISTS email_sync_history (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sync_type VARCHAR(50) DEFAULT 'email',
  status VARCHAR(50),
  items_processed INTEGER DEFAULT 0,
  items_failed INTEGER DEFAULT 0,
  last_sync_date TIMESTAMP,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Add Outlook fields to existing users table (if not exists)
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name='users' AND column_name='outlook_connected') THEN
    ALTER TABLE users ADD COLUMN outlook_connected BOOLEAN DEFAULT false;
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name='users' AND column_name='outlook_email') THEN
    ALTER TABLE users ADD COLUMN outlook_email VARCHAR(255);
  END IF;
END $$;

-- Add email source to existing actions table (if not exists)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name='actions' AND column_name='source') THEN
    ALTER TABLE actions ADD COLUMN source VARCHAR(50);
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name='actions' AND column_name='source_id') THEN
    ALTER TABLE actions ADD COLUMN source_id VARCHAR(255);
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name='actions' AND column_name='metadata') THEN
    ALTER TABLE actions ADD COLUMN metadata JSONB;
  END IF;
END $$;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user_provider ON oauth_tokens(user_id, provider);
CREATE INDEX IF NOT EXISTS idx_email_sync_history_user ON email_sync_history(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_actions_source ON actions(source, source_id);

-- Comments for documentation
COMMENT ON TABLE oauth_tokens IS 'Stores OAuth tokens for external services like Outlook';
COMMENT ON TABLE email_sync_history IS 'Tracks email synchronization history and status';
COMMENT ON COLUMN users.outlook_connected IS 'Whether user has connected their Outlook account';
COMMENT ON COLUMN users.outlook_email IS 'Users Outlook email address';
COMMENT ON COLUMN actions.source IS 'Source of the action (e.g., outlook_email, manual, calendar)';
COMMENT ON COLUMN actions.source_id IS 'ID from the source system (e.g., Outlook message ID)';
