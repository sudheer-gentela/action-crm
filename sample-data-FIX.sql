-- ============================================================
-- ACTION CRM - SAMPLE DATA (FIXED)
-- ============================================================
-- Contacts created: 0 - need to fix the insert
-- Emails created: 0 - need to fix the insert
-- ============================================================

-- ============================================================
-- FIX 1: INSERT CONTACTS (Simplified approach)
-- ============================================================

-- TechStart Solutions contacts
INSERT INTO contacts (
  account_id, first_name, last_name, email, phone, title, 
  role_type, engagement_level, location, linkedin_url, notes,
  last_contact_date, created_at, updated_at
)
SELECT 
  a.id,
  'Sarah', 'Chen', 'sarah.chen@techstart.io', '+1-415-555-0101',
  'VP of Sales', 'decision_maker', 'high',
  'San Francisco, CA', 'https://linkedin.com/in/sarahchen',
  'Budget owner, wants to see ROI within 6 months. Prefers data-driven solutions.',
  NOW() - INTERVAL '2 days', NOW() - INTERVAL '40 days', NOW()
FROM accounts a WHERE a.name = 'TechStart Solutions';

INSERT INTO contacts (
  account_id, first_name, last_name, email, phone, title, 
  role_type, engagement_level, location, linkedin_url, notes,
  last_contact_date, created_at, updated_at
)
SELECT 
  a.id,
  'Michael', 'Rodriguez', 'michael.r@techstart.io', '+1-415-555-0102',
  'Sales Operations Manager', 'influencer', 'high',
  'San Francisco, CA', 'https://linkedin.com/in/mrodriguez',
  'Day-to-day user, very technical. Asked for API documentation.',
  NOW() - INTERVAL '3 days', NOW() - INTERVAL '38 days', NOW()
FROM accounts a WHERE a.name = 'TechStart Solutions';

INSERT INTO contacts (
  account_id, first_name, last_name, email, phone, title, 
  role_type, engagement_level, location, linkedin_url, notes,
  last_contact_date, created_at, updated_at
)
SELECT 
  a.id,
  'Emily', 'Thompson', 'emily.t@techstart.io', '+1-415-555-0103',
  'Account Executive', 'user', 'medium',
  'San Francisco, CA', 'https://linkedin.com/in/emilythompson',
  'End user who will be using the system daily. Concerned about ease of use.',
  NOW() - INTERVAL '10 days', NOW() - INTERVAL '35 days', NOW()
FROM accounts a WHERE a.name = 'TechStart Solutions';

-- Global Manufacturing Inc contacts
INSERT INTO contacts (
  account_id, first_name, last_name, email, phone, title, 
  role_type, engagement_level, location, linkedin_url, notes,
  last_contact_date, created_at, updated_at
)
SELECT 
  a.id,
  'James', 'Wilson', 'j.wilson@globalmfg.com', '+1-312-555-0201',
  'Chief Revenue Officer', 'decision_maker', 'high',
  'Chicago, IL', 'https://linkedin.com/in/jameswilson',
  'Final decision maker. Wants enterprise features and dedicated support.',
  NOW() - INTERVAL '5 days', NOW() - INTERVAL '28 days', NOW()
FROM accounts a WHERE a.name = 'Global Manufacturing Inc';

INSERT INTO contacts (
  account_id, first_name, last_name, email, phone, title, 
  role_type, engagement_level, location, linkedin_url, notes,
  last_contact_date, created_at, updated_at
)
SELECT 
  a.id,
  'Patricia', 'Martinez', 'p.martinez@globalmfg.com', '+1-312-555-0202',
  'Director of IT', 'influencer', 'medium',
  'Chicago, IL', 'https://linkedin.com/in/patriciamartinez',
  'Evaluating security and compliance. Needs SOC2 certification.',
  NOW() - INTERVAL '7 days', NOW() - INTERVAL '25 days', NOW()
FROM accounts a WHERE a.name = 'Global Manufacturing Inc';

INSERT INTO contacts (
  account_id, first_name, last_name, email, phone, title, 
  role_type, engagement_level, location, linkedin_url, notes,
  last_contact_date, created_at, updated_at
)
SELECT 
  a.id,
  'David', 'Kim', 'd.kim@globalmfg.com', '+1-312-555-0203',
  'Sales Director', 'champion', 'high',
  'Chicago, IL', 'https://linkedin.com/in/davidkim',
  'Internal champion. Very excited about the platform. Pushing for quick decision.',
  NOW() - INTERVAL '1 day', NOW() - INTERVAL '30 days', NOW()
FROM accounts a WHERE a.name = 'Global Manufacturing Inc';

-- HealthTech Partners contacts
INSERT INTO contacts (
  account_id, first_name, last_name, email, phone, title, 
  role_type, engagement_level, location, linkedin_url, notes,
  last_contact_date, created_at, updated_at
)
SELECT 
  a.id,
  'Jennifer', 'Brown', 'j.brown@healthtechpartners.com', '+1-617-555-0301',
  'CEO', 'decision_maker', 'high',
  'Boston, MA', 'https://linkedin.com/in/jenniferbrown',
  'Strategic thinker. Wants solution that scales with company growth.',
  NOW() - INTERVAL '1 day', NOW() - INTERVAL '55 days', NOW()
FROM accounts a WHERE a.name = 'HealthTech Partners';

INSERT INTO contacts (
  account_id, first_name, last_name, email, phone, title, 
  role_type, engagement_level, location, linkedin_url, notes,
  last_contact_date, created_at, updated_at
)
SELECT 
  a.id,
  'Robert', 'Lee', 'r.lee@healthtechpartners.com', '+1-617-555-0302',
  'VP of Business Development', 'influencer', 'high',
  'Boston, MA', 'https://linkedin.com/in/robertlee',
  'Focused on integration capabilities with their existing tech stack.',
  NOW() - INTERVAL '4 days', NOW() - INTERVAL '50 days', NOW()
FROM accounts a WHERE a.name = 'HealthTech Partners';

INSERT INTO contacts (
  account_id, first_name, last_name, email, phone, title, 
  role_type, engagement_level, location, linkedin_url, notes,
  last_contact_date, created_at, updated_at
)
SELECT 
  a.id,
  'Lisa', 'Anderson', 'l.anderson@healthtechpartners.com', '+1-617-555-0303',
  'Head of Sales', 'user', 'high',
  'Boston, MA', 'https://linkedin.com/in/lisaanderson',
  'Will manage the team using the CRM. Wants excellent mobile app.',
  NOW() - INTERVAL '3 days', NOW() - INTERVAL '52 days', NOW()
FROM accounts a WHERE a.name = 'HealthTech Partners';

INSERT INTO contacts (
  account_id, first_name, last_name, email, phone, title, 
  role_type, engagement_level, location, linkedin_url, notes,
  last_contact_date, created_at, updated_at
)
SELECT 
  a.id,
  'William', 'Taylor', 'w.taylor@healthtechpartners.com', '+1-617-555-0304',
  'CFO', 'decision_maker', 'medium',
  'Boston, MA', 'https://linkedin.com/in/williamtaylor',
  'Budget approval required. Wants clear pricing and contract terms.',
  NOW() - INTERVAL '15 days', NOW() - INTERVAL '58 days', NOW()
FROM accounts a WHERE a.name = 'HealthTech Partners';

-- ============================================================
-- FIX 2: INSERT EMAILS (Simplified approach)
-- ============================================================

-- Get deal and contact IDs first
DO $$
DECLARE
  techstart_deal_id INTEGER;
  sarah_contact_id INTEGER;
  michael_contact_id INTEGER;
  
  globalmfg_deal_id INTEGER;
  james_contact_id INTEGER;
  david_contact_id INTEGER;
  
  healthtech_deal_id INTEGER;
  lisa_contact_id INTEGER;
  robert_contact_id INTEGER;
BEGIN
  -- Get TechStart IDs
  SELECT d.id INTO techstart_deal_id FROM deals d JOIN accounts a ON d.account_id = a.id WHERE a.name = 'TechStart Solutions' LIMIT 1;
  SELECT id INTO sarah_contact_id FROM contacts WHERE email = 'sarah.chen@techstart.io';
  SELECT id INTO michael_contact_id FROM contacts WHERE email = 'michael.r@techstart.io';
  
  -- Get Global Mfg IDs
  SELECT d.id INTO globalmfg_deal_id FROM deals d JOIN accounts a ON d.account_id = a.id WHERE a.name = 'Global Manufacturing Inc' AND d.stage = 'negotiation' LIMIT 1;
  SELECT id INTO james_contact_id FROM contacts WHERE email = 'j.wilson@globalmfg.com';
  SELECT id INTO david_contact_id FROM contacts WHERE email = 'd.kim@globalmfg.com';
  
  -- Get HealthTech IDs
  SELECT d.id INTO healthtech_deal_id FROM deals d JOIN accounts a ON d.account_id = a.id WHERE a.name = 'HealthTech Partners' AND d.stage = 'demo' LIMIT 1;
  SELECT id INTO lisa_contact_id FROM contacts WHERE email = 'l.anderson@healthtechpartners.com';
  SELECT id INTO robert_contact_id FROM contacts WHERE email = 'r.lee@healthtechpartners.com';
  
  -- Insert TechStart emails
  IF sarah_contact_id IS NOT NULL THEN
    INSERT INTO emails (user_id, deal_id, contact_id, direction, subject, body, to_address, from_address, sent_at, created_at)
    VALUES (
      5, techstart_deal_id, sarah_contact_id, 'received',
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
      NOW() - INTERVAL '2 days',
      NOW()
    );
    
    INSERT INTO emails (user_id, deal_id, contact_id, direction, subject, body, to_address, from_address, sent_at, created_at)
    VALUES (
      5, techstart_deal_id, sarah_contact_id, 'sent',
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
      NOW() - INTERVAL '2 days' + INTERVAL '30 minutes',
      NOW()
    );
  END IF;
  
  IF michael_contact_id IS NOT NULL THEN
    INSERT INTO emails (user_id, deal_id, contact_id, direction, subject, body, to_address, from_address, sent_at, created_at)
    VALUES (
      5, techstart_deal_id, michael_contact_id, 'received',
      'Quick question about reporting features',
      'Hi,

Michael here from TechStart. Quick question - can the platform generate custom sales forecasting reports? This is critical for our VP.

Thanks!
Michael',
      'sudheer.gentela@outlook.com',
      'michael.r@techstart.io',
      NOW() - INTERVAL '1 day',
      NOW()
    );
  END IF;
  
  -- Insert Global Mfg emails
  IF james_contact_id IS NOT NULL THEN
    INSERT INTO emails (user_id, deal_id, contact_id, direction, subject, body, to_address, from_address, sent_at, created_at)
    VALUES (
      5, globalmfg_deal_id, james_contact_id, 'received',
      'Contract terms - legal review',
      'Hi,

Our legal team has reviewed the contract. We need clarification on the data retention policy and would like to modify the auto-renewal clause.

Can we schedule a call with your legal team next week?

Thanks,
James',
      'sudheer.gentela@outlook.com',
      'j.wilson@globalmfg.com',
      NOW() - INTERVAL '5 days',
      NOW()
    );
    
    INSERT INTO emails (user_id, deal_id, contact_id, direction, subject, body, to_address, from_address, sent_at, created_at)
    VALUES (
      5, globalmfg_deal_id, james_contact_id, 'sent',
      'Re: Contract terms - legal review',
      'Hi James,

Absolutely. I will connect you with our legal team. How does Tuesday at 10am CST work?

Meanwhile, I will send over our standard data retention policy document.

Best',
      'j.wilson@globalmfg.com',
      'sudheer.gentela@outlook.com',
      NOW() - INTERVAL '4 days',
      NOW()
    );
  END IF;
  
  IF david_contact_id IS NOT NULL THEN
    INSERT INTO emails (user_id, deal_id, contact_id, direction, subject, body, to_address, from_address, sent_at, created_at)
    VALUES (
      5, globalmfg_deal_id, david_contact_id, 'received',
      'Implementation timeline question',
      'Hi,

If we sign this week, what would the implementation timeline look like for 200 users?

Also, do you offer onsite training?

David Kim
Global Manufacturing',
      'sudheer.gentela@outlook.com',
      'd.kim@globalmfg.com',
      NOW() - INTERVAL '3 days',
      NOW()
    );
  END IF;
  
  -- Insert HealthTech emails
  IF lisa_contact_id IS NOT NULL THEN
    INSERT INTO emails (user_id, deal_id, contact_id, direction, subject, body, to_address, from_address, sent_at, created_at)
    VALUES (
      5, healthtech_deal_id, lisa_contact_id, 'received',
      'Demo follow-up and next steps',
      'Hi,

Thanks for the excellent demo yesterday. The team was impressed, especially with the mobile capabilities.

Robert has some technical questions about API rate limits and integration options. Can we set up a technical deep-dive with your engineering team?

Also, when can we schedule the executive briefing with Jennifer and William?

Best regards,
Lisa',
      'sudheer.gentela@outlook.com',
      'l.anderson@healthtechpartners.com',
      NOW() - INTERVAL '9 days',
      NOW()
    );
    
    INSERT INTO emails (user_id, deal_id, contact_id, direction, subject, body, to_address, from_address, sent_at, created_at)
    VALUES (
      5, healthtech_deal_id, lisa_contact_id, 'sent',
      'Re: Demo follow-up and next steps',
      'Hi Lisa,

Glad the demo went well! I will arrange:

1. Technical deep-dive with our Solutions Architect - this week?
2. Executive briefing - I have sent calendar invites for next Monday at 2pm EST

Looking forward to moving forward!

Best',
      'l.anderson@healthtechpartners.com',
      'sudheer.gentela@outlook.com',
      NOW() - INTERVAL '8 days',
      NOW()
    );
  END IF;
  
  IF robert_contact_id IS NOT NULL THEN
    INSERT INTO emails (user_id, deal_id, contact_id, direction, subject, body, to_address, from_address, sent_at, created_at)
    VALUES (
      5, healthtech_deal_id, robert_contact_id, 'received',
      'Competitor comparison',
      'Hi,

We are evaluating your platform against Salesforce and HubSpot. Can you send over a comparison sheet highlighting your differentiators?

Thanks,
Robert Lee
HealthTech Partners',
      'sudheer.gentela@outlook.com',
      'r.lee@healthtechpartners.com',
      NOW() - INTERVAL '6 days',
      NOW()
    );
  END IF;
  
  -- Follow-up email to Sarah
  IF sarah_contact_id IS NOT NULL THEN
    INSERT INTO emails (user_id, deal_id, contact_id, direction, subject, body, to_address, from_address, sent_at, created_at)
    VALUES (
      5, techstart_deal_id, sarah_contact_id, 'sent',
      'Following up on our proposal',
      'Hi Sarah,

Just wanted to follow up on the proposal we sent last week. Do you have any questions I can answer?

Also, I noticed you mentioned wanting better forecasting - I can schedule a quick demo of that specific feature if helpful.

Let me know what works for you.

Best',
      'sarah.chen@techstart.io',
      'sudheer.gentela@outlook.com',
      NOW() - INTERVAL '4 days',
      NOW()
    );
  END IF;
  
END $$;

-- ============================================================
-- VERIFICATION QUERIES
-- ============================================================

SELECT 'Contacts created:' as status, COUNT(*) as count FROM contacts WHERE account_id IN (SELECT id FROM accounts WHERE owner_id = 5);
SELECT 'Emails created:' as status, COUNT(*) as count FROM emails WHERE user_id = 5;

-- ============================================================
-- DONE!
-- ============================================================
