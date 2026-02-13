-- ============================================================
-- TEST ACTIONSGENERATOR - Manual Trigger
-- ============================================================
-- This will manually call the ActionsGenerator to see if it works
-- ============================================================

-- First, let's check if we have the required columns in actions table
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'actions'
ORDER BY ordinal_position;

-- Check if we have any existing actions
SELECT COUNT(*) as existing_actions FROM actions WHERE user_id = 5;

-- Check the sample data we inserted
SELECT 'Deals:' as type, COUNT(*) as count FROM deals WHERE owner_id = 5
UNION ALL
SELECT 'Contacts:', COUNT(*) FROM contacts WHERE account_id IN (SELECT id FROM accounts WHERE owner_id = 5)
UNION ALL
SELECT 'Emails:', COUNT(*) FROM emails WHERE user_id = 5
UNION ALL
SELECT 'Meetings:', COUNT(*) FROM meetings WHERE user_id = 5;

-- Check deal stages (ActionsEngine looks for specific stages)
SELECT stage, COUNT(*) as count 
FROM deals 
WHERE owner_id = 5 
GROUP BY stage;

-- Check if deals have the expected_close_date field (ActionsEngine uses close_date)
SELECT 
  name,
  stage,
  expected_close_date,
  updated_at,
  value
FROM deals 
WHERE owner_id = 5
LIMIT 5;

-- ============================================================
-- The issue is likely that ActionsEngine uses `close_date` 
-- but your deals table uses `expected_close_date`
-- Let's add a migration to create the missing columns if needed
-- ============================================================

-- Add any missing columns to actions table
DO $$ 
BEGIN
  -- Add action_type column if missing
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'actions' AND column_name = 'action_type'
  ) THEN
    ALTER TABLE actions ADD COLUMN action_type VARCHAR(50);
  END IF;

  -- Add suggested_action column if missing
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'actions' AND column_name = 'suggested_action'
  ) THEN
    ALTER TABLE actions ADD COLUMN suggested_action TEXT;
  END IF;

  -- Add source column if missing
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'actions' AND column_name = 'source'
  ) THEN
    ALTER TABLE actions ADD COLUMN source VARCHAR(100);
  END IF;
END $$;

-- Add missing columns to emails if needed
DO $$ 
BEGIN
  -- Add opened_at column if missing
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'emails' AND column_name = 'opened_at'
  ) THEN
    ALTER TABLE emails ADD COLUMN opened_at TIMESTAMP;
  END IF;

  -- Add replied_at column if missing
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'emails' AND column_name = 'replied_at'
  ) THEN
    ALTER TABLE emails ADD COLUMN replied_at TIMESTAMP;
  END IF;
END $$;

-- Add missing columns to deals if needed
DO $$ 
BEGIN
  -- Add close_date column if missing (ActionsEngine expects this)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'deals' AND column_name = 'close_date'
  ) THEN
    ALTER TABLE deals ADD COLUMN close_date DATE;
    -- Copy expected_close_date to close_date
    UPDATE deals SET close_date = expected_close_date::DATE WHERE expected_close_date IS NOT NULL;
  END IF;

  -- Add deleted_at column if missing
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'deals' AND column_name = 'deleted_at'
  ) THEN
    ALTER TABLE deals ADD COLUMN deleted_at TIMESTAMP;
  END IF;
END $$;

-- Add deleted_at to other tables if missing
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'contacts' AND column_name = 'deleted_at') THEN
    ALTER TABLE contacts ADD COLUMN deleted_at TIMESTAMP;
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'emails' AND column_name = 'deleted_at') THEN
    ALTER TABLE emails ADD COLUMN deleted_at TIMESTAMP;
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'meetings' AND column_name = 'deleted_at') THEN
    ALTER TABLE meetings ADD COLUMN deleted_at TIMESTAMP;
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'accounts' AND column_name = 'deleted_at') THEN
    ALTER TABLE accounts ADD COLUMN deleted_at TIMESTAMP;
  END IF;
END $$;

-- Verify columns were added
SELECT 'Actions table columns:' as info;
SELECT column_name FROM information_schema.columns WHERE table_name = 'actions' AND column_name IN ('action_type', 'suggested_action', 'source');

SELECT 'Deals table columns:' as info;
SELECT column_name FROM information_schema.columns WHERE table_name = 'deals' AND column_name IN ('close_date', 'deleted_at');

-- ============================================================
-- DONE! Now the ActionsGenerator should work
-- Go to your CRM and click the "Generate Actions" button
-- Or restart your backend to trigger the generation
-- ============================================================
