-- ============================================================
-- DIAGNOSTIC: Why aren't actions generating?
-- ============================================================

-- Step 1: Verify columns were added
SELECT 
  'actions table columns' as check_name,
  COUNT(*) as column_count
FROM information_schema.columns 
WHERE table_name = 'actions' 
  AND column_name IN ('action_type', 'source', 'suggested_action');

SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'actions'
ORDER BY ordinal_position;

-- Step 2: Check if we have the sample data
SELECT 
  'Sample Data Check' as check_name,
  'Accounts' as type,
  COUNT(*) as count
FROM accounts 
WHERE owner_id = 5

UNION ALL

SELECT 
  'Sample Data Check',
  'Deals',
  COUNT(*)
FROM deals 
WHERE owner_id = 5

UNION ALL

SELECT 
  'Sample Data Check',
  'Contacts',
  COUNT(*)
FROM contacts 
WHERE account_id IN (SELECT id FROM accounts WHERE owner_id = 5)

UNION ALL

SELECT 
  'Sample Data Check',
  'Emails',
  COUNT(*)
FROM emails 
WHERE user_id = 5

UNION ALL

SELECT 
  'Sample Data Check',
  'Meetings',
  COUNT(*)
FROM meetings 
WHERE user_id = 5;

-- Step 3: Check deal details (ActionsEngine looks at these fields)
SELECT 
  id,
  name,
  stage,
  health,
  value,
  expected_close_date,
  close_date,
  created_at,
  updated_at,
  owner_id
FROM deals 
WHERE owner_id = 5
ORDER BY created_at DESC;

-- Step 4: Check if ActionsGenerator has been called
SELECT 
  'Existing Actions' as check_name,
  COUNT(*) as total_actions,
  COUNT(CASE WHEN source = 'auto_generated' THEN 1 END) as auto_generated,
  COUNT(CASE WHEN source = 'rule_based' THEN 1 END) as rule_based,
  COUNT(CASE WHEN source IS NULL THEN 1 END) as no_source,
  MAX(created_at) as last_action_created
FROM actions 
WHERE user_id = 5;

-- Step 5: Check if there's a user_id column issue
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'actions' 
  AND column_name = 'user_id';

-- Step 6: Show any existing actions
SELECT 
  id,
  title,
  priority,
  source,
  action_type,
  deal_id,
  contact_id,
  created_at
FROM actions 
WHERE user_id = 5
ORDER BY created_at DESC
LIMIT 10;

-- ============================================================
-- MANUAL TEST: Simulate what ActionsEngine would find
-- ============================================================

-- Rule 1: Qualified deals without discovery meetings
SELECT 
  'Rule 1: Qualified deals need discovery' as rule_name,
  d.id as deal_id,
  d.name as deal_name,
  d.stage,
  COUNT(m.id) as discovery_meetings
FROM deals d
LEFT JOIN meetings m ON m.deal_id = d.id AND m.meeting_type = 'discovery'
WHERE d.owner_id = 5 
  AND d.stage = 'qualified'
GROUP BY d.id, d.name, d.stage
HAVING COUNT(m.id) = 0;

-- Rule 2: Demo stage deals without demo meetings
SELECT 
  'Rule 2: Demo stage needs demo' as rule_name,
  d.id as deal_id,
  d.name as deal_name,
  d.stage,
  COUNT(m.id) as demo_meetings
FROM deals d
LEFT JOIN meetings m ON m.deal_id = d.id AND m.meeting_type = 'demo'
WHERE d.owner_id = 5 
  AND d.stage = 'demo'
GROUP BY d.id, d.name, d.stage
HAVING COUNT(m.id) = 0;

-- Rule 3: Proposal stage deals (should always trigger)
SELECT 
  'Rule 3: Proposal stage needs follow-up' as rule_name,
  d.id as deal_id,
  d.name as deal_name,
  d.stage,
  MAX(e.sent_at) as last_email,
  EXTRACT(DAY FROM (NOW() - MAX(e.sent_at))) as days_since_email
FROM deals d
LEFT JOIN emails e ON e.deal_id = d.id
WHERE d.owner_id = 5 
  AND d.stage = 'proposal'
GROUP BY d.id, d.name, d.stage;

-- Rule 4: Negotiation stage deals
SELECT 
  'Rule 4: Negotiation needs check-in' as rule_name,
  d.id as deal_id,
  d.name as deal_name,
  d.stage
FROM deals d
WHERE d.owner_id = 5 
  AND d.stage = 'negotiation';

-- Rule 5: Stagnant deals (no update in 14+ days)
SELECT 
  'Rule 5: Stagnant deals' as rule_name,
  d.id as deal_id,
  d.name as deal_name,
  d.stage,
  d.updated_at,
  EXTRACT(DAY FROM (NOW() - d.updated_at)) as days_stagnant
FROM deals d
WHERE d.owner_id = 5 
  AND d.stage NOT IN ('closed_won', 'closed_lost')
  AND EXTRACT(DAY FROM (NOW() - d.updated_at)) > 14;

-- ============================================================
-- EXPECTED RESULTS
-- ============================================================

-- Based on your sample data, we should see:
-- - 2 qualified deals → 2 "Schedule discovery call" actions
-- - 1 demo deal → 1 "Schedule product demo" action  
-- - 1 proposal deal → 1 "Follow up on proposal" action
-- - 1 negotiation deal → 1 "Check negotiation status" action
-- - Several stagnant deals → Multiple "Re-engage" actions
-- 
-- Total expected: ~10-15 actions

-- ============================================================
-- If no actions exist, the issue is likely:
-- 1. ActionsGenerator hasn't been called yet
-- 2. Backend not running / not connected to database
-- 3. API route not accessible
-- ============================================================
