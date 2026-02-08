-- Action CRM Database Schema
-- PostgreSQL Database

-- Drop existing tables if they exist
DROP TABLE IF EXISTS conversation_starters CASCADE;
DROP TABLE IF EXISTS contact_activities CASCADE;
DROP TABLE IF EXISTS deal_activities CASCADE;
DROP TABLE IF EXISTS meeting_attendees CASCADE;
DROP TABLE IF EXISTS meetings CASCADE;
DROP TABLE IF EXISTS proposals CASCADE;
DROP TABLE IF EXISTS emails CASCADE;
DROP TABLE IF EXISTS actions CASCADE;
DROP TABLE IF EXISTS deal_contacts CASCADE;
DROP TABLE IF EXISTS contacts CASCADE;
DROP TABLE IF EXISTS deals CASCADE;
DROP TABLE IF EXISTS accounts CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- Users table (Account Executives)
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    role VARCHAR(50) DEFAULT 'ae',
    avatar_url VARCHAR(500),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Accounts (Companies)
CREATE TABLE accounts (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    domain VARCHAR(255),
    industry VARCHAR(100),
    size VARCHAR(50),
    location VARCHAR(255),
    description TEXT,
    owner_id INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Deals (Opportunities)
CREATE TABLE deals (
    id SERIAL PRIMARY KEY,
    account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
    owner_id INTEGER REFERENCES users(id),
    name VARCHAR(255) NOT NULL,
    value DECIMAL(12, 2) NOT NULL,
    stage VARCHAR(50) NOT NULL,
    -- stages: qualified, demo, proposal, negotiation, closed_won, closed_lost
    health VARCHAR(20) DEFAULT 'healthy',
    -- health: healthy, watch, risk
    expected_close_date DATE,
    probability INTEGER DEFAULT 50,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    closed_at TIMESTAMP
);

-- Contacts
CREATE TABLE contacts (
    id SERIAL PRIMARY KEY,
    account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    email VARCHAR(255),
    phone VARCHAR(50),
    title VARCHAR(255),
    role_type VARCHAR(50),
    -- role_type: decision_maker, champion, technical, influencer, user
    location VARCHAR(255),
    linkedin_url VARCHAR(500),
    engagement_level VARCHAR(20) DEFAULT 'medium',
    -- engagement_level: high, medium, low
    last_contact_date TIMESTAMP,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Deal-Contact relationship (many-to-many)
CREATE TABLE deal_contacts (
    deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE,
    contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
    role VARCHAR(50),
    -- role: primary, secondary, stakeholder
    PRIMARY KEY (deal_id, contact_id)
);

-- Actions (prioritized task list)
CREATE TABLE actions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE,
    contact_id INTEGER REFERENCES contacts(id),
    type VARCHAR(50) NOT NULL,
    -- type: email, meeting_prep, research, proposal, follow_up
    priority VARCHAR(20) DEFAULT 'medium',
    -- priority: high, medium, low
    title VARCHAR(255) NOT NULL,
    description TEXT,
    context TEXT,
    due_date TIMESTAMP,
    completed BOOLEAN DEFAULT FALSE,
    completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Emails
CREATE TABLE emails (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE,
    contact_id INTEGER REFERENCES contacts(id),
    direction VARCHAR(10) NOT NULL,
    -- direction: sent, received
    subject VARCHAR(500),
    body TEXT,
    to_address VARCHAR(255),
    from_address VARCHAR(255),
    cc_addresses TEXT,
    sent_at TIMESTAMP,
    opened_at TIMESTAMP,
    clicked_at TIMESTAMP,
    replied_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Proposals
CREATE TABLE proposals (
    id SERIAL PRIMARY KEY,
    deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    version INTEGER DEFAULT 1,
    status VARCHAR(50) DEFAULT 'draft',
    -- status: draft, sent, viewed, accepted, rejected
    pricing_tier VARCHAR(50),
    num_users INTEGER,
    contract_length INTEGER,
    -- in months
    annual_value DECIMAL(12, 2),
    implementation_fee DECIMAL(12, 2),
    discount_percent DECIMAL(5, 2) DEFAULT 0,
    total_value DECIMAL(12, 2),
    payment_terms VARCHAR(50),
    -- payment_terms: annual, quarterly, monthly
    sent_at TIMESTAMP,
    viewed_at TIMESTAMP,
    responded_at TIMESTAMP,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Meetings
CREATE TABLE meetings (
    id SERIAL PRIMARY KEY,
    deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    meeting_type VARCHAR(50),
    -- meeting_type: discovery, demo, negotiation, internal, executive
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP NOT NULL,
    location VARCHAR(255),
    -- location: zoom_url, google_meet_url, in_person address
    status VARCHAR(50) DEFAULT 'scheduled',
    -- status: scheduled, completed, cancelled
    prep_doc TEXT,
    notes TEXT,
    recording_url VARCHAR(500),
    transcript TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Meeting Attendees
CREATE TABLE meeting_attendees (
    meeting_id INTEGER REFERENCES meetings(id) ON DELETE CASCADE,
    contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
    attendance_status VARCHAR(50) DEFAULT 'invited',
    -- attendance_status: invited, accepted, declined, attended
    PRIMARY KEY (meeting_id, contact_id)
);

-- Deal Activities (audit log)
CREATE TABLE deal_activities (
    id SERIAL PRIMARY KEY,
    deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    activity_type VARCHAR(50) NOT NULL,
    -- activity_type: stage_change, note_added, email_sent, meeting_scheduled, etc.
    description TEXT,
    metadata JSONB,
    -- flexible JSON field for additional data
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Contact Activities (audit log)
CREATE TABLE contact_activities (
    id SERIAL PRIMARY KEY,
    contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id),
    activity_type VARCHAR(50) NOT NULL,
    -- activity_type: email_sent, email_opened, meeting, call, note_added
    description TEXT,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- AI-Generated Conversation Starters
CREATE TABLE conversation_starters (
    id SERIAL PRIMARY KEY,
    contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    relevance_score DECIMAL(3, 2),
    -- 0.00 to 1.00
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP
);

-- Indexes for performance
CREATE INDEX idx_deals_owner ON deals(owner_id);
CREATE INDEX idx_deals_account ON deals(account_id);
CREATE INDEX idx_deals_stage ON deals(stage);
CREATE INDEX idx_deals_expected_close ON deals(expected_close_date);
CREATE INDEX idx_contacts_account ON contacts(account_id);
CREATE INDEX idx_contacts_email ON contacts(email);
CREATE INDEX idx_contacts_last_contact ON contacts(last_contact_date);
CREATE INDEX idx_actions_user ON actions(user_id);
CREATE INDEX idx_actions_deal ON actions(deal_id);
CREATE INDEX idx_actions_due_date ON actions(due_date);
CREATE INDEX idx_actions_completed ON actions(completed);
CREATE INDEX idx_emails_contact ON emails(contact_id);
CREATE INDEX idx_emails_deal ON emails(deal_id);
CREATE INDEX idx_emails_sent_at ON emails(sent_at);
CREATE INDEX idx_meetings_user ON meetings(user_id);
CREATE INDEX idx_meetings_start_time ON meetings(start_time);
CREATE INDEX idx_deal_activities_deal ON deal_activities(deal_id);
CREATE INDEX idx_deal_activities_created ON deal_activities(created_at);
CREATE INDEX idx_contact_activities_contact ON contact_activities(contact_id);
CREATE INDEX idx_contact_activities_created ON contact_activities(created_at);

-- Insert sample data for demo purposes
INSERT INTO users (email, password_hash, first_name, last_name, role)
VALUES ('john.doe@company.com', '$2b$10$abcdefghijklmnopqrstuv', 'John', 'Doe', 'ae');

-- Sample accounts
INSERT INTO accounts (name, domain, industry, size, location, owner_id)
VALUES 
    ('Acme Corp', 'acmecorp.com', 'Technology', '100-500', 'San Francisco, CA', 1),
    ('TechFlow Industries', 'techflow.com', 'Manufacturing', '500-1000', 'Austin, TX', 1),
    ('CloudScale Inc', 'cloudscale.io', 'SaaS', '50-100', 'San Francisco, CA', 1),
    ('Quantum Labs', 'quantumlabs.com', 'Research', '25-50', 'Boston, MA', 1),
    ('BuildRight Co', 'buildright.com', 'Construction', '100-500', 'Denver, CO', 1);

-- Sample contacts
INSERT INTO contacts (account_id, first_name, last_name, email, phone, title, role_type, engagement_level, last_contact_date)
VALUES
    (1, 'Sarah', 'Chen', 'sarah.chen@acmecorp.com', '+1-555-234-5678', 'VP of Product', 'decision_maker', 'high', CURRENT_TIMESTAMP - INTERVAL '1 day'),
    (2, 'David', 'Martinez', 'david.martinez@techflow.com', '+1-555-345-6789', 'CTO', 'decision_maker', 'high', CURRENT_TIMESTAMP),
    (2, 'Karen', 'Lee', 'karen.lee@techflow.com', '+1-555-456-7890', 'VP of Operations', 'influencer', 'medium', CURRENT_TIMESTAMP),
    (3, 'Michael', 'Rodriguez', 'michael.rodriguez@cloudscale.io', '+1-555-567-8901', 'VP of Engineering', 'technical', 'medium', CURRENT_TIMESTAMP - INTERVAL '2 hours'),
    (4, 'James', 'Wilson', 'james.wilson@quantumlabs.com', '+1-555-678-9012', 'CEO', 'decision_maker', 'medium', CURRENT_TIMESTAMP - INTERVAL '1 day'),
    (5, 'Jennifer', 'Kim', 'jennifer.kim@buildright.com', '+1-555-789-0123', 'Director of Operations', 'champion', 'high', CURRENT_TIMESTAMP);

-- Sample deals
INSERT INTO deals (account_id, owner_id, name, value, stage, health, expected_close_date, probability)
VALUES
    (1, 1, 'Acme Corp Enterprise', 85000, 'demo', 'healthy', CURRENT_DATE + INTERVAL '39 days', 60),
    (2, 1, 'TechFlow Enterprise Platform', 125000, 'negotiation', 'healthy', CURRENT_DATE + INTERVAL '24 days', 75),
    (3, 1, 'CloudScale Platform Upgrade', 65000, 'demo', 'healthy', CURRENT_DATE + INTERVAL '49 days', 55),
    (4, 1, 'Quantum Labs Enterprise', 75000, 'qualified', 'healthy', CURRENT_DATE + INTERVAL '54 days', 40),
    (5, 1, 'BuildRight SMB Package', 28000, 'qualified', 'healthy', CURRENT_DATE + INTERVAL '24 days', 50);

-- Link contacts to deals
INSERT INTO deal_contacts (deal_id, contact_id, role)
VALUES
    (1, 1, 'primary'),
    (2, 2, 'primary'),
    (2, 3, 'secondary'),
    (3, 4, 'primary'),
    (4, 5, 'primary'),
    (5, 6, 'primary');

-- Sample actions
INSERT INTO actions (user_id, deal_id, contact_id, type, priority, title, description, context, due_date)
VALUES
    (1, 1, 1, 'email', 'high', 'Follow up with Sarah Chen - Acme Corp Demo', 
     'Send follow-up email after demo', 
     'Sarah attended your demo yesterday. She expressed strong interest in the analytics module. No response to your meeting recap yet.',
     CURRENT_TIMESTAMP),
    (1, 2, 2, 'meeting_prep', 'high', 'Prepare for Executive Meeting - TechFlow Industries',
     'Meeting with CTO and VP of Operations',
     'They want to discuss implementation timeline and integration with their existing systems.',
     CURRENT_TIMESTAMP + INTERVAL '2 hours'),
    (1, 3, 4, 'research', 'medium', 'Research New Contact: Michael Rodriguez',
     'Get background before next call',
     'New stakeholder added to CloudScale deal. He has been CCd on recent emails.',
     CURRENT_TIMESTAMP);

-- Sample emails
INSERT INTO emails (user_id, deal_id, contact_id, direction, subject, body, to_address, from_address, sent_at, opened_at)
VALUES
    (1, 1, 1, 'sent', 'Great connecting yesterday - Next steps for Acme Corp',
     'Hi Sarah, Thanks for taking the time...', 
     'sarah.chen@acmecorp.com', 'john.doe@company.com',
     CURRENT_TIMESTAMP - INTERVAL '1 day', CURRENT_TIMESTAMP - INTERVAL '12 hours'),
    (1, 1, 1, 'received', 'Re: Demo scheduling',
     'Looking forward to seeing the product...', 
     'john.doe@company.com', 'sarah.chen@acmecorp.com',
     CURRENT_TIMESTAMP - INTERVAL '3 days', NULL);

-- Sample meeting
INSERT INTO meetings (deal_id, user_id, title, description, meeting_type, start_time, end_time, location, status)
VALUES
    (2, 1, 'Executive Meeting - TechFlow Industries', 
     'Discussion on implementation timeline and technical requirements',
     'executive', 
     CURRENT_TIMESTAMP + INTERVAL '2 hours',
     CURRENT_TIMESTAMP + INTERVAL '3 hours',
     'https://meet.google.com/abc-defg-hij',
     'scheduled'),
    (1, 1, 'Product Demo - Acme Corp',
     'Walkthrough of analytics module',
     'demo',
     CURRENT_TIMESTAMP - INTERVAL '1 day',
     CURRENT_TIMESTAMP - INTERVAL '23 hours',
     'https://zoom.us/j/123456789',
     'completed');

-- Link attendees to meetings
INSERT INTO meeting_attendees (meeting_id, contact_id, attendance_status)
VALUES
    (1, 2, 'accepted'),
    (1, 3, 'accepted'),
    (2, 1, 'attended');

-- Sample deal activities
INSERT INTO deal_activities (deal_id, user_id, activity_type, description)
VALUES
    (1, 1, 'email_sent', 'Follow-up email sent to Sarah Chen'),
    (1, 1, 'meeting_completed', 'Product demo completed'),
    (1, 1, 'stage_change', 'Moved to Demo stage');

-- Sample contact activities
INSERT INTO contact_activities (contact_id, user_id, activity_type, description)
VALUES
    (1, 1, 'email_sent', 'Demo recap and next steps'),
    (1, 1, 'meeting', 'Product demo - Analytics module discussion'),
    (1, 1, 'email_opened', 'Opened "Schedule your demo" email');

-- Sample conversation starters
INSERT INTO conversation_starters (contact_id, text, relevance_score)
VALUES
    (1, 'I saw your recent post about team productivity challenges...', 0.95),
    (1, 'Following up on our demo - any questions about the analytics module?', 0.90),
    (1, 'I found a case study that matches your use case perfectly...', 0.85);
