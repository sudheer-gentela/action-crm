-- ============================================================
-- FIX: Add missing account_id column to actions table
-- ============================================================

-- Add account_id column
ALTER TABLE actions ADD COLUMN IF NOT EXISTS account_id INTEGER;

-- Add foreign key constraint (optional but good practice)
ALTER TABLE actions 
  ADD CONSTRAINT fk_actions_account 
  FOREIGN KEY (account_id) 
  REFERENCES accounts(id) 
  ON DELETE SET NULL;

-- Verify the column was added
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'actions' 
  AND column_name = 'account_id';

-- Show all columns in actions table
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'actions'
ORDER BY ordinal_position;

-- ============================================================
-- DONE! Now ActionsGenerator should work
-- ============================================================
