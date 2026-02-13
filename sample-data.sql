-- ============================================================
-- ACTION CRM - SAMPLE DATA GENERATION
-- ============================================================
-- Run this on Railway: railway run psql < sample-data.sql
-- Or copy-paste into Railway psql terminal
-- ============================================================

-- First, let's get your actual user ID
-- We'll use user_id = 5 based on your console logs

-- ============================================================
-- 1. ACCOUNTS (3 Companies)
-- ============================================================

INSERT INTO accounts (name, domain, industry, size, location, description, owner_id, created_at, updated_at)
VALUES 
  (
    'TechStart Solutions',
    'techstart.io',
    'Technology',
    '50-200',
    'San Francisco, CA',
    'Fast-growing SaaS startup focused on project management tools for remote teams. Currently using spreadsheets and looking to upgrade.',
    5,
    NOW() - INTERVAL '45 days',
    NOW() - INTERVAL '2 days'
  ),
  (
    'Global Manufacturing Inc',
    'globalmfg.com',
    'Manufacturing',
    '500-1000',
    'Chicago, IL',
    'Large manufacturing company looking to digitize their sales process. Currently in pilot phase with 20 users.',
    5,
    NOW() - INTERVAL '30 days',
    NOW() - INTERVAL '5 days'
  ),
  (
    'HealthTech Partners',
    'healthtechpartners.com',
    'Healthcare',
    '200-500',
    'Boston, MA',
    'Healthcare technology company expanding their CRM needs. Decision committee includes 5 stakeholders.',
    5,
    NOW() - INTERVAL '60 days',
    NOW() - INTERVAL '1 day'
  )
ON CONFLICT DO NOTHING;

-- ============================================================
-- 2. CONTACTS (10 People)
-- ============================================================

INSERT INTO contacts (
  account_id, first_name, last_name, email, phone, title, 
  role_type, engagement_level, location, linkedin_url, notes,
  last_contact_date, created_at, updated_at
)
SELECT 
  a.id,
  contacts_data.first_name,
  contacts_data.last_name,
  contacts_data.email,
  contacts_data.phone,
  contacts_data.title,
  contacts_data.role_type,
  contacts_data.engagement_level,
  contacts_data.location,
  contacts_data.linkedin_url,
  contacts_data.notes,
  contacts_data.last_contact_date,
  contacts_data.created_at,
  NOW()
FROM accounts a
CROSS JOIN LATERAL (
  VALUES
    -- TechStart Solutions contacts
    (
      'Sarah', 'Chen', 'sarah.chen@techstart.io', '+1-415-555-0101',
      'VP of Sales', 'decision_maker', 'high',
      'San Francisco, CA', 'https://linkedin.com/in/sarahchen',
      'Budget owner, wants to see ROI within 6 months. Prefers data-driven solutions.',
      NOW() - INTERVAL '2 days', NOW() - INTERVAL '40 days'
    ),
    (
      'Michael', 'Rodriguez', 'michael.r@techstart.io', '+1-415-555-0102',
      'Sales Operations Manager', 'influencer', 'high',
      'San Francisco, CA', 'https://linkedin.com/in/mrodriguez',
      'Day-to-day user, very technical. Asked for API documentation.',
      NOW() - INTERVAL '3 days', NOW() - INTERVAL '38 days'
    ),
    (
      'Emily', 'Thompson', 'emily.t@techstart.io', '+1-415-555-0103',
      'Account Executive', 'user', 'medium',
      'San Francisco, CA', 'https://linkedin.com/in/emilythompson',
      'End user who will be using the system daily. Concerned about ease of use.',
      NOW() - INTERVAL '10 days', NOW() - INTERVAL '35 days'
    ),
    -- Global Manufacturing Inc contacts
    (
      'James', 'Wilson', 'j.wilson@globalmfg.com', '+1-312-555-0201',
      'Chief Revenue Officer', 'decision_maker', 'high',
      'Chicago, IL', 'https://linkedin.com/in/jameswilson',
      'Final decision maker. Wants enterprise features and dedicated support.',
      NOW() - INTERVAL '5 days', NOW() - INTERVAL '28 days'
    ),
    (
      'Patricia', 'Martinez', 'p.martinez@globalmfg.com', '+1-312-555-0202',
      'Director of IT', 'influencer', 'medium',
      'Chicago, IL', 'https://linkedin.com/in/patriciamartinez',
      'Evaluating security and compliance. Needs SOC2 certification.',
      NOW() - INTERVAL '7 days', NOW() - INTERVAL '25 days'
    ),
    (
      'David', 'Kim', 'd.kim@globalmfg.com', '+1-312-555-0203',
      'Sales Director', 'champion', 'high',
      'Chicago, IL', 'https://linkedin.com/in/davidkim',
      'Internal champion. Very excited about the platform. Pushing for quick decision.',
      NOW() - INTERVAL '1 day', NOW() - INTERVAL '30 days'
    ),
    -- HealthTech Partners contacts
    (
      'Jennifer', 'Brown', 'j.brown@healthtechpartners.com', '+1-617-555-0301',
      'CEO', 'decision_maker', 'high',
      'Boston, MA', 'https://linkedin.com/in/jenniferbrown',
      'Strategic thinker. Wants solution that scales with company growth.',
      NOW() - INTERVAL '1 day', NOW() - INTERVAL '55 days'
    ),
    (
      'Robert', 'Lee', 'r.lee@healthtechpartners.com', '+1-617-555-0302',
      'VP of Business Development', 'influencer', 'high',
      'Boston, MA', 'https://linkedin.com/in/robertlee',
      'Focused on integration capabilities with their existing tech stack.',
      NOW() - INTERVAL '4 days', NOW() - INTERVAL '50 days'
    ),
    (
      'Lisa', 'Anderson', 'l.anderson@healthtechpartners.com', '+1-617-555-0303',
      'Head of Sales', 'user', 'high',
      'Boston, MA', 'https://linkedin.com/in/lisaanderson',
      'Will manage the team using the CRM. Wants excellent mobile app.',
      NOW() - INTERVAL '3 days', NOW() - INTERVAL '52 days'
    ),
    (
      'William', 'Taylor', 'w.taylor@healthtechpartners.com', '+1-617-555-0304',
      'CFO', 'decision_maker', 'medium',
      'Boston, MA', 'https://linkedin.com/in/williamtaylor',
      'Budget approval required. Wants clear pricing and contract terms.',
      NOW() - INTERVAL '15 days', NOW() - INTERVAL '58 days'
    )
) AS contacts_data(
  first_name, last_name, email, phone, title, role_type, 
  engagement_level, location, linkedin_url, notes, last_contact_date, created_at
)
WHERE 
  (a.name = 'TechStart Solutions' AND contacts_data.email LIKE '%techstart.io%') OR
  (a.name = 'Global Manufacturing Inc' AND contacts_data.email LIKE '%globalmfg.com%') OR
  (a.name = 'HealthTech Partners' AND contacts_data.email LIKE '%healthtechpartners.com%')
ON CONFLICT (email) DO NOTHING;

-- ============================================================
-- 3. DEALS (5 Opportunities)
-- ============================================================

INSERT INTO deals (
  account_id, owner_id, name, value, stage, health, 
  expected_close_date, probability, notes, created_at, updated_at
)
SELECT
  a.id,
  5 as owner_id,
  deals_data.name,
  deals_data.value,
  deals_data.stage,
  deals_data.health,
  deals_data.expected_close_date,
  deals_data.probability,
  deals_data.notes,
  deals_data.created_at,
  NOW()
FROM accounts a
CROSS JOIN LATERAL (
  VALUES
    -- TechStart Solutions deals
    (
      'TechStart - Annual Enterprise',
      45000.00,
      'proposal',
      'healthy',
      NOW() + INTERVAL '15 days',
      70,
      'Sent proposal on Monday. Pricing for 50 users, annual contract. They requested some customizations around reporting.',
      NOW() - INTERVAL '35 days'
    ),
    -- Global Manufacturing Inc deals
    (
      'Global Manufacturing - Pilot Program',
      25000.00,
      'negotiation',
      'at_risk',
      NOW() + INTERVAL '10 days',
      85,
      'In final negotiations. Legal review taking longer than expected. They want better terms on the renewal clause.',
      NOW() - INTERVAL '25 days'
    ),
    (
      'Global Manufacturing - Full Rollout',
      180000.00,
      'qualified',
      'healthy',
      NOW() + INTERVAL '60 days',
      30,
      'Contingent on successful pilot. This would be 200 users, 3-year contract. Decision expected in Q2.',
      NOW() - INTERVAL '20 days'
    ),
    -- HealthTech Partners deals
    (
      'HealthTech - Premium Package',
      95000.00,
      'demo',
      'healthy',
      NOW() + INTERVAL '30 days',
      50,
      'Demo scheduled for next week with full committee. They are comparing us with 2 competitors.',
      NOW() - INTERVAL '45 days'
    ),
    (
      'HealthTech - Add-on Services',
      15000.00,
      'qualified',
      'healthy',
      NOW() + INTERVAL '45 days',
      40,
      'Training and implementation services. Upsell opportunity if main deal closes.',
      NOW() - INTERVAL '40 days'
    )
) AS deals_data(
  name, value, stage, health, expected_close_date, 
  probability, notes, created_at
)
WHERE 
  (a.name = 'TechStart Solutions' AND deals_data.name LIKE 'TechStart%') OR
  (a.name = 'Global Manufacturing Inc' AND deals_data.name LIKE 'Global Manufacturing%') OR
  (a.name = 'HealthTech Partners' AND deals_data.name LIKE 'HealthTech%')
ON CONFLICT DO NOTHING;

-- ============================================================
-- 4. DEAL-CONTACT ASSOCIATIONS
-- ============================================================

-- Associate contacts with their deals
INSERT INTO deal_contacts (deal_id, contact_id, role)
SELECT DISTINCT
  d.id as deal_id,
  c.id as contact_id,
  CASE 
    WHEN c.role_type = 'decision_maker' THEN 'primary'
    WHEN c.role_type = 'champion' THEN 'primary'
    ELSE 'secondary'
  END as role
FROM deals d
JOIN accounts a ON d.account_id = a.id
JOIN contacts c ON c.account_id = a.id
WHERE d.owner_id = 5
ON CONFLICT DO NOTHING;

-- ============================================================
-- 5. MEETINGS (5 Meetings - Past and Future)
-- ============================================================

INSERT INTO meetings (
  deal_id, user_id, title, description, meeting_type, 
  start_time, end_time, location, status, notes, created_at, updated_at
)
SELECT
  d.id,
  5 as user_id,
  meetings_data.title,
  meetings_data.description,
  meetings_data.meeting_type,
  meetings_data.start_time,
  meetings_data.end_time,
  meetings_data.location,
  meetings_data.status,
  meetings_data.notes,
  meetings_data.created_at,
  NOW()
FROM deals d
JOIN accounts a ON d.account_id = a.id
CROSS JOIN LATERAL (
  VALUES
    -- Past meetings
    (
      'Discovery Call - TechStart Solutions',
      'Initial discovery to understand their requirements and current pain points with existing system.',
      'discovery',
      NOW() - INTERVAL '30 days',
      NOW() - INTERVAL '30 days' + INTERVAL '45 minutes',
      'Zoom',
      'completed',
      'Great call. Sarah mentioned they need better forecasting. Team of 50 sales reps. Budget approved for Q1. Next: Send proposal.',
      NOW() - INTERVAL '35 days'
    ),
    (
      'Product Demo - HealthTech Partners',
      'Full platform demo with focus on healthcare compliance features and mobile capabilities.',
      'demo',
      NOW() - INTERVAL '10 days',
      NOW() - INTERVAL '10 days' + INTERVAL '60 minutes',
      'Microsoft Teams',
      'completed',
      'Demo went well. Jennifer loved the mobile app. Robert concerned about API limits. Need to schedule technical deep-dive.',
      NOW() - INTERVAL '12 days'
    ),
    -- Future meetings
    (
      'Proposal Review - TechStart Solutions',
      'Walk through proposal, answer questions, discuss implementation timeline.',
      'proposal',
      NOW() + INTERVAL '3 days',
      NOW() + INTERVAL '3 days' + INTERVAL '45 minutes',
      'In-person at their office',
      'scheduled',
      NULL,
      NOW() - INTERVAL '2 days'
    ),
    (
      'Executive Briefing - HealthTech Partners',
      'Present to full decision committee including CEO and CFO. Focus on ROI and strategic value.',
      'executive',
      NOW() + INTERVAL '7 days',
      NOW() + INTERVAL '7 days' + INTERVAL '90 minutes',
      'Zoom',
      'scheduled',
      NULL,
      NOW() - INTERVAL '1 day'
    ),
    (
      'Contract Negotiation - Global Manufacturing',
      'Final contract terms discussion with James Wilson and legal team.',
      'negotiation',
      NOW() + INTERVAL '5 days',
      NOW() + INTERVAL '5 days' + INTERVAL '60 minutes',
      'Phone',
      'scheduled',
      NULL,
      NOW() - INTERVAL '3 days'
    )
) AS meetings_data(
  title, description, meeting_type, start_time, end_time, 
  location, status, notes, created_at
)
WHERE 
  (a.name = 'TechStart Solutions' AND meetings_data.title LIKE '%TechStart%') OR
  (a.name = 'HealthTech Partners' AND meetings_data.title LIKE '%HealthTech%') OR
  (a.name = 'Global Manufacturing Inc' AND meetings_data.title LIKE '%Global Manufacturing%')
ON CONFLICT DO NOTHING;

-- ============================================================
-- 6. EMAILS (10 Realistic Email Threads)
-- ============================================================

INSERT INTO emails (
  user_id, deal_id, contact_id, direction, subject, body, 
  to_address, from_address, sent_at, created_at
)
SELECT
  5 as user_id,
  d.id as deal_id,
  c.id as contact_id,
  emails_data.direction,
  emails_data.subject,
  emails_data.body,
  emails_data.to_address,
  emails_data.from_address,
  emails_data.sent_at,
  NOW()
FROM deals d
JOIN accounts a ON d.account_id = a.id
JOIN contacts c ON c.account_id = a.id
CROSS JOIN LATERAL (
  VALUES
    -- TechStart email thread
    (
      'received',
      'Re: Pricing question for 50 users',
      'Hi,

Thanks for the detailed proposal. The pricing looks competitive. I have a few questions:

1. Can we get a discount for annual pre-payment?
2. What is included in the "Premium Support" tier?
3. Is there a cost for the mobile app access?

Looking forward to discussing this week.

Best,
Sarah',
      'sudheer.gentela@outlook.com',
      'sarah.chen@techstart.io',
      NOW() - INTERVAL '2 days'
    ),
    (
      'sent',
      'Re: Pricing question for 50 users',
      'Hi Sarah,

Great questions! Here are the answers:

1. Yes - we offer 10% discount for annual pre-payment
2. Premium Support includes 24/7 phone support, dedicated CSM, and priority feature requests
3. Mobile app is included in all plans at no extra cost

Happy to jump on a call this week to discuss. How does Thursday at 2pm work?

Best regards',
      'sarah.chen@techstart.io',
      'sudheer.gentela@outlook.com',
      NOW() - INTERVAL '2 days' + INTERVAL '30 minutes'
    ),
    -- Global Manufacturing email thread
    (
      'received',
      'Contract terms - legal review',
      'Hi,

Our legal team has reviewed the contract. We need clarification on the data retention policy and would like to modify the auto-renewal clause.

Can we schedule a call with your legal team next week?

Thanks,
James',
      'sudheer.gentela@outlook.com',
      'j.wilson@globalmfg.com',
      NOW() - INTERVAL '5 days'
    ),
    (
      'sent',
      'Re: Contract terms - legal review',
      'Hi James,

Absolutely. I will connect you with our legal team. How does Tuesday at 10am CST work?

Meanwhile, I will send over our standard data retention policy document.

Best',
      'j.wilson@globalmfg.com',
      'sudheer.gentela@outlook.com',
      NOW() - INTERVAL '4 days'
    ),
    -- HealthTech email thread
    (
      'received',
      'Demo follow-up and next steps',
      'Hi,

Thanks for the excellent demo yesterday. The team was impressed, especially with the mobile capabilities.

Robert has some technical questions about API rate limits and integration options. Can we set up a technical deep-dive with your engineering team?

Also, when can we schedule the executive briefing with Jennifer and William?

Best regards,
Lisa',
      'sudheer.gentela@outlook.com',
      'l.anderson@healthtechpartners.com',
      NOW() - INTERVAL '9 days'
    ),
    (
      'sent',
      'Re: Demo follow-up and next steps',
      'Hi Lisa,

Glad the demo went well! I will arrange:

1. Technical deep-dive with our Solutions Architect - this week?
2. Executive briefing - I have sent calendar invites for next Monday at 2pm EST

Looking forward to moving forward!

Best',
      'l.anderson@healthtechpartners.com',
      'sudheer.gentela@outlook.com',
      NOW() - INTERVAL '8 days'
    ),
    -- More recent emails
    (
      'received',
      'Quick question about reporting features',
      'Hi,

Michael here from TechStart. Quick question - can the platform generate custom sales forecasting reports? This is critical for our VP.

Thanks!
Michael',
      'sudheer.gentela@outlook.com',
      'michael.r@techstart.io',
      NOW() - INTERVAL '1 day'
    ),
    (
      'received',
      'Implementation timeline question',
      'Hi,

If we sign this week, what would the implementation timeline look like for 200 users?

Also, do you offer onsite training?

David Kim
Global Manufacturing',
      'sudheer.gentela@outlook.com',
      'd.kim@globalmfg.com',
      NOW() - INTERVAL '3 days'
    ),
    (
      'received',
      'Competitor comparison',
      'Hi,

We are evaluating your platform against Salesforce and HubSpot. Can you send over a comparison sheet highlighting your differentiators?

Thanks,
Robert Lee
HealthTech Partners',
      'sudheer.gentela@outlook.com',
      'r.lee@healthtechpartners.com',
      NOW() - INTERVAL '6 days'
    ),
    (
      'sent',
      'Following up on our proposal',
      'Hi Sarah,

Just wanted to follow up on the proposal we sent last week. Do you have any questions I can answer?

Also, I noticed you mentioned wanting better forecasting - I can schedule a quick demo of that specific feature if helpful.

Let me know what works for you.

Best',
      'sarah.chen@techstart.io',
      'sudheer.gentela@outlook.com',
      NOW() - INTERVAL '4 days'
    )
) AS emails_data(
  direction, subject, body, to_address, from_address, sent_at
)
WHERE 
  (c.email = emails_data.from_address AND emails_data.direction = 'received') OR
  (c.email = emails_data.to_address AND emails_data.direction = 'sent')
LIMIT 1
ON CONFLICT DO NOTHING;

-- ============================================================
-- 7. CONTACT ACTIVITIES (Track engagement history)
-- ============================================================

INSERT INTO contact_activities (contact_id, user_id, activity_type, description, created_at)
SELECT
  c.id,
  5,
  activities_data.activity_type,
  activities_data.description,
  activities_data.created_at
FROM contacts c
CROSS JOIN LATERAL (
  VALUES
    ('email_sent', 'Sent proposal with pricing details', NOW() - INTERVAL '2 days'),
    ('email_received', 'Received questions about pricing and support', NOW() - INTERVAL '2 days'),
    ('meeting_completed', 'Discovery call - discussed requirements', NOW() - INTERVAL '30 days'),
    ('call_completed', 'Quick sync on timeline', NOW() - INTERVAL '7 days')
) AS activities_data(activity_type, description, created_at)
WHERE c.engagement_level = 'high'
LIMIT 3
ON CONFLICT DO NOTHING;

-- ============================================================
-- 8. DEAL ACTIVITIES (Track deal progression)
-- ============================================================

INSERT INTO deal_activities (deal_id, user_id, activity_type, description, created_at)
SELECT
  d.id,
  5,
  activities_data.activity_type,
  activities_data.description,
  activities_data.created_at
FROM deals d
CROSS JOIN LATERAL (
  VALUES
    ('deal_created', 'Opportunity created after discovery call', NOW() - INTERVAL '35 days'),
    ('stage_change', 'Moved to Proposal stage', NOW() - INTERVAL '10 days'),
    ('note_added', 'Customer requested customization options', NOW() - INTERVAL '5 days')
) AS activities_data(activity_type, description, created_at)
WHERE d.stage IN ('proposal', 'negotiation', 'demo')
LIMIT 1
ON CONFLICT DO NOTHING;

-- ============================================================
-- VERIFICATION QUERIES
-- ============================================================
-- Run these to verify data was inserted:

SELECT 'Accounts created:' as status, COUNT(*) as count FROM accounts WHERE owner_id = 5;
SELECT 'Contacts created:' as status, COUNT(*) as count FROM contacts WHERE account_id IN (SELECT id FROM accounts WHERE owner_id = 5);
SELECT 'Deals created:' as status, COUNT(*) as count FROM deals WHERE owner_id = 5;
SELECT 'Meetings created:' as status, COUNT(*) as count FROM meetings WHERE user_id = 5;
SELECT 'Emails created:' as status, COUNT(*) as count FROM emails WHERE user_id = 5;

-- ============================================================
-- DONE! 
-- Now you have realistic sample data to test ActionsGenerator
-- ============================================================
