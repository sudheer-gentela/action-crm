-- ============================================================
-- COMPREHENSIVE DEBUG: Find out why ActionsGenerator produces 0 actions
-- ============================================================

-- Part 1: Verify table structure is complete
SELECT '=== PART 1: TABLE STRUCTURE ===' as section;

SELECT column_name, data_type, is_nullable
FROM information_schema.columns 
WHERE table_name = 'actions'
ORDER BY ordinal_position;

-- Part 2: Verify sample data exists
SELECT '=== PART 2: SAMPLE DATA COUNT ===' as section;

SELECT 'Deals' as table_name, COUNT(*) as count FROM deals WHERE owner_id = 5
UNION ALL
SELECT 'Contacts', COUNT(*) FROM contacts WHERE account_id IN (SELECT id FROM accounts WHERE owner_id = 5)
UNION ALL
SELECT 'Emails', COUNT(*) FROM emails WHERE user_id = 5
UNION ALL  
SELECT 'Meetings', COUNT(*) FROM meetings WHERE user_id = 5
UNION ALL
SELECT 'Accounts', COUNT(*) FROM accounts WHERE owner_id = 5;

-- Part 3: Check each ActionsEngine rule manually
SELECT '=== PART 3: RULE CHECKS ===' as section;

-- Rule 1: Qualified deals without discovery meetings
SELECT 
  'Rule 1' as rule,
  'Qualified deals need discovery' as description,
  COUNT(*) as should_trigger
FROM deals d
LEFT JOIN meetings m ON m.deal_id = d.id AND m.meeting_type = 'discovery'
WHERE d.owner_id = 5 
  AND d.stage = 'qualified'
  AND d.deleted_at IS NULL
  AND m.id IS NULL;

-- Rule 2: Demo stage deals without demo meetings  
SELECT 
  'Rule 2' as rule,
  'Demo stage needs demo' as description,
  COUNT(*) as should_trigger
FROM deals d
LEFT JOIN meetings m ON m.deal_id = d.id AND m.meeting_type = 'demo'
WHERE d.owner_id = 5 
  AND d.stage = 'demo'
  AND d.deleted_at IS NULL
  AND m.id IS NULL;

-- Rule 3: Proposal stage deals
SELECT 
  'Rule 3' as rule,
  'Proposal needs follow-up' as description,
  COUNT(*) as should_trigger
FROM deals d
WHERE d.owner_id = 5 
  AND d.stage = 'proposal'
  AND d.deleted_at IS NULL;

-- Rule 4: Negotiation stage
SELECT 
  'Rule 4' as rule,
  'Negotiation needs check-in' as description,
  COUNT(*) as should_trigger
FROM deals d
WHERE d.owner_id = 5 
  AND d.stage = 'negotiation'
  AND d.deleted_at IS NULL;

-- Rule 14: At-risk deals
SELECT 
  'Rule 14' as rule,
  'At-risk deals need intervention' as description,
  COUNT(*) as should_trigger
FROM deals d
WHERE d.owner_id = 5 
  AND d.health = 'at_risk'
  AND d.deleted_at IS NULL;

-- Part 4: Check deleted_at column (critical!)
SELECT '=== PART 4: DELETED_AT COLUMN CHECK ===' as section;

SELECT 
  table_name,
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns 
WHERE table_name IN ('deals', 'contacts', 'emails', 'meetings', 'accounts')
  AND column_name = 'deleted_at';

-- Part 5: Check actual deal data in detail
SELECT '=== PART 5: DEAL DATA DETAILS ===' as section;

SELECT 
  id,
  name,
  stage,
  health,
  owner_id,
  deleted_at,
  CASE WHEN deleted_at IS NULL THEN 'NOT DELETED' ELSE 'DELETED' END as status
FROM deals
WHERE owner_id = 5
ORDER BY id;

-- Part 6: Simulate ActionsEngine.generateActions() manually
SELECT '=== PART 6: MANUAL ACTION GENERATION TEST ===' as section;

-- This simulates what ActionsEngine should generate
WITH potential_actions AS (
  -- Rule 1: Qualified deals
  SELECT 
    d.id as deal_id,
    d.owner_id as user_id,
    'Schedule discovery call with ' || d.name as title,
    'meeting' as action_type,
    'high' as priority,
    'Rule 1: Qualified stage' as source_rule
  FROM deals d
  LEFT JOIN meetings m ON m.deal_id = d.id AND m.meeting_type = 'discovery'
  WHERE d.owner_id = 5 
    AND d.stage = 'qualified'
    AND (d.deleted_at IS NULL OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'deals' AND column_name = 'deleted_at'))
    AND m.id IS NULL

  UNION ALL

  -- Rule 2: Demo stage
  SELECT 
    d.id,
    d.owner_id,
    'Schedule product demo for ' || d.name,
    'meeting',
    'high',
    'Rule 2: Demo stage'
  FROM deals d
  LEFT JOIN meetings m ON m.deal_id = d.id AND m.meeting_type = 'demo'
  WHERE d.owner_id = 5 
    AND d.stage = 'demo'
    AND (d.deleted_at IS NULL OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'deals' AND column_name = 'deleted_at'))
    AND m.id IS NULL

  UNION ALL

  -- Rule 3: Proposal stage
  SELECT 
    d.id,
    d.owner_id,
    'Follow up on proposal with ' || d.name,
    'follow_up',
    'medium',
    'Rule 3: Proposal stage'
  FROM deals d
  WHERE d.owner_id = 5 
    AND d.stage = 'proposal'
    AND (d.deleted_at IS NULL OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'deals' AND column_name = 'deleted_at'))

  UNION ALL

  -- Rule 4: Negotiation
  SELECT 
    d.id,
    d.owner_id,
    'Check negotiation status for ' || d.name,
    'review',
    'high',
    'Rule 4: Negotiation stage'
  FROM deals d
  WHERE d.owner_id = 5 
    AND d.stage = 'negotiation'
    AND (d.deleted_at IS NULL OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'deals' AND column_name = 'deleted_at'))

  UNION ALL

  -- Rule 14: At-risk
  SELECT 
    d.id,
    d.owner_id,
    'Intervention needed for at-risk deal: ' || d.name,
    'review',
    'high',
    'Rule 14: At-risk health'
  FROM deals d
  WHERE d.owner_id = 5 
    AND d.health = 'at_risk'
    AND (d.deleted_at IS NULL OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'deals' AND column_name = 'deleted_at'))
)
SELECT 
  COUNT(*) as total_actions_should_generate,
  STRING_AGG(DISTINCT source_rule, ', ') as rules_triggered
FROM potential_actions;

-- Show what actions should be created
SELECT 
  user_id,
  deal_id,
  title,
  action_type,
  priority,
  source_rule
FROM (
  -- Rule 1: Qualified deals
  SELECT 
    d.owner_id as user_id,
    d.id as deal_id,
    'Schedule discovery call with ' || d.name as title,
    'meeting' as action_type,
    'high' as priority,
    'Rule 1: Qualified stage' as source_rule
  FROM deals d
  LEFT JOIN meetings m ON m.deal_id = d.id AND m.meeting_type = 'discovery'
  WHERE d.owner_id = 5 
    AND d.stage = 'qualified'
    AND (d.deleted_at IS NULL OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'deals' AND column_name = 'deleted_at'))
    AND m.id IS NULL

  UNION ALL

  SELECT 
    d.owner_id,
    d.id,
    'Schedule product demo for ' || d.name,
    'meeting',
    'high',
    'Rule 2: Demo stage'
  FROM deals d
  LEFT JOIN meetings m ON m.deal_id = d.id AND m.meeting_type = 'demo'
  WHERE d.owner_id = 5 
    AND d.stage = 'demo'
    AND (d.deleted_at IS NULL OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'deals' AND column_name = 'deleted_at'))
    AND m.id IS NULL

  UNION ALL

  SELECT 
    d.owner_id,
    d.id,
    'Follow up on proposal with ' || d.name,
    'follow_up',
    'medium',
    'Rule 3: Proposal stage'
  FROM deals d
  WHERE d.owner_id = 5 
    AND d.stage = 'proposal'
    AND (d.deleted_at IS NULL OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'deals' AND column_name = 'deleted_at'))

  UNION ALL

  SELECT 
    d.owner_id,
    d.id,
    'Check negotiation status for ' || d.name,
    'review',
    'high',
    'Rule 4: Negotiation stage'
  FROM deals d
  WHERE d.owner_id = 5 
    AND d.stage = 'negotiation'
    AND (d.deleted_at IS NULL OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'deals' AND column_name = 'deleted_at'))

  UNION ALL

  SELECT 
    d.owner_id,
    d.id,
    'Intervention needed for at-risk deal: ' || d.name,
    'review',
    'high',
    'Rule 14: At-risk health'
  FROM deals d
  WHERE d.owner_id = 5 
    AND d.health = 'at_risk'
    AND (d.deleted_at IS NULL OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'deals' AND column_name = 'deleted_at'))
) as actions
ORDER BY priority DESC, deal_id;

-- ============================================================
-- EXPECTED OUTPUT:
-- Should show 5-6 actions that SHOULD be generated
-- If this shows 0, then the deleted_at column is the issue
-- ============================================================
