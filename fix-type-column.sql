-- ============================================================
-- FIX: actions.type column is NOT NULL but we're not setting it
-- ============================================================

-- Solution 1: Make 'type' nullable (recommended)
ALTER TABLE actions ALTER COLUMN type DROP NOT NULL;

-- Solution 2: Set 'type' to same value as 'action_type'
-- (We'll use this as INSERT should set both)

-- Verify the change
SELECT 
  column_name, 
  data_type, 
  is_nullable 
FROM information_schema.columns 
WHERE table_name = 'actions' 
  AND column_name IN ('type', 'action_type');

-- ============================================================
-- Now update the INSERT to set BOTH columns
-- ============================================================
