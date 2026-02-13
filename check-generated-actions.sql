-- Check what actions were created
SELECT 
  id,
  user_id,
  type,
  action_type,
  title,
  priority,
  deal_id,
  contact_id,
  source,
  created_at
FROM actions
WHERE user_id = 5
  AND source = 'auto_generated'
ORDER BY created_at DESC
LIMIT 10;

-- Check for any NULL values in critical fields
SELECT 
  'NULL type' as issue,
  COUNT(*) as count
FROM actions
WHERE user_id = 5 AND type IS NULL

UNION ALL

SELECT 
  'NULL action_type',
  COUNT(*)
FROM actions
WHERE user_id = 5 AND action_type IS NULL

UNION ALL

SELECT 
  'NULL title',
  COUNT(*)
FROM actions
WHERE user_id = 5 AND title IS NULL;
