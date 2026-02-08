/**
 * Mock Data - Fallback data when API is unavailable
 * Prevents reference errors and provides realistic demo data
 */

export const mockData = {
  accounts: [
    {
      id: 1,
      name: 'Acme Corp',
      domain: 'acmecorp.com',
      industry: 'Technology',
      size: '100-500',
      location: 'San Francisco, CA',
      description: 'Leading enterprise software provider',
      owner_id: 1,
      created_at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
    },
    {
      id: 2,
      name: 'TechFlow Industries',
      domain: 'techflow.com',
      industry: 'Manufacturing',
      size: '500-1000',
      location: 'Austin, TX',
      description: 'Industrial automation solutions',
      owner_id: 1,
      created_at: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString()
    },
    {
      id: 3,
      name: 'CloudScale Inc',
      domain: 'cloudscale.io',
      industry: 'SaaS',
      size: '50-100',
      location: 'San Francisco, CA',
      description: 'Cloud infrastructure platform',
      owner_id: 1,
      created_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
    },
    {
      id: 4,
      name: 'Quantum Labs',
      domain: 'quantumlabs.com',
      industry: 'Research',
      size: '25-50',
      location: 'Boston, MA',
      description: 'Quantum computing research',
      owner_id: 1,
      created_at: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString()
    },
    {
      id: 5,
      name: 'BuildRight Co',
      domain: 'buildright.com',
      industry: 'Construction',
      size: '100-500',
      location: 'Denver, CO',
      description: 'Commercial construction',
      owner_id: 1,
      created_at: new Date(Date.now() - 75 * 24 * 60 * 60 * 1000).toISOString()
    }
  ],

  contacts: [
    {
      id: 1,
      account_id: 1,
      first_name: 'Sarah',
      last_name: 'Chen',
      email: 'sarah.chen@acmecorp.com',
      phone: '+1-555-234-5678',
      title: 'VP of Product',
      role_type: 'decision_maker',
      engagement_level: 'high',
      last_contact_date: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
      created_at: new Date(Date.now() - 85 * 24 * 60 * 60 * 1000).toISOString()
    },
    {
      id: 2,
      account_id: 2,
      first_name: 'David',
      last_name: 'Martinez',
      email: 'david.martinez@techflow.com',
      phone: '+1-555-345-6789',
      title: 'CTO',
      role_type: 'decision_maker',
      engagement_level: 'high',
      last_contact_date: new Date().toISOString(),
      created_at: new Date(Date.now() - 115 * 24 * 60 * 60 * 1000).toISOString()
    },
    {
      id: 3,
      account_id: 2,
      first_name: 'Karen',
      last_name: 'Lee',
      email: 'karen.lee@techflow.com',
      phone: '+1-555-456-7890',
      title: 'VP of Operations',
      role_type: 'influencer',
      engagement_level: 'medium',
      last_contact_date: new Date().toISOString(),
      created_at: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString()
    },
    {
      id: 4,
      account_id: 3,
      first_name: 'Michael',
      last_name: 'Rodriguez',
      email: 'michael.rodriguez@cloudscale.io',
      phone: '+1-555-567-8901',
      title: 'VP of Engineering',
      role_type: 'technical',
      engagement_level: 'medium',
      last_contact_date: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      created_at: new Date(Date.now() - 55 * 24 * 60 * 60 * 1000).toISOString()
    },
    {
      id: 5,
      account_id: 4,
      first_name: 'James',
      last_name: 'Wilson',
      email: 'james.wilson@quantumlabs.com',
      phone: '+1-555-678-9012',
      title: 'CEO',
      role_type: 'decision_maker',
      engagement_level: 'medium',
      last_contact_date: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
      created_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
    },
    {
      id: 6,
      account_id: 5,
      first_name: 'Jennifer',
      last_name: 'Kim',
      email: 'jennifer.kim@buildright.com',
      phone: '+1-555-789-0123',
      title: 'Director of Operations',
      role_type: 'champion',
      engagement_level: 'high',
      last_contact_date: new Date().toISOString(),
      created_at: new Date(Date.now() - 70 * 24 * 60 * 60 * 1000).toISOString()
    }
  ],

  deals: [
    {
      id: 1,
      account_id: 1,
      owner_id: 1,
      name: 'Acme Corp Enterprise',
      value: 85000,
      stage: 'demo',
      health: 'healthy',
      expected_close_date: new Date(Date.now() + 39 * 24 * 60 * 60 * 1000).toISOString(),
      probability: 60,
      notes: 'Strong interest in analytics module',
      created_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
    },
    {
      id: 2,
      account_id: 2,
      owner_id: 1,
      name: 'TechFlow Enterprise Platform',
      value: 125000,
      stage: 'negotiation',
      health: 'healthy',
      expected_close_date: new Date(Date.now() + 24 * 24 * 60 * 60 * 1000).toISOString(),
      probability: 75,
      notes: 'Finalizing contract terms',
      created_at: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString()
    },
    {
      id: 3,
      account_id: 3,
      owner_id: 1,
      name: 'CloudScale Platform Upgrade',
      value: 65000,
      stage: 'demo',
      health: 'healthy',
      expected_close_date: new Date(Date.now() + 49 * 24 * 60 * 60 * 1000).toISOString(),
      probability: 55,
      notes: 'Interested in premium tier',
      created_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
    },
    {
      id: 4,
      account_id: 4,
      owner_id: 1,
      name: 'Quantum Labs Enterprise',
      value: 75000,
      stage: 'qualified',
      health: 'healthy',
      expected_close_date: new Date(Date.now() + 54 * 24 * 60 * 60 * 1000).toISOString(),
      probability: 40,
      notes: 'Early stage, needs nurturing',
      created_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
    },
    {
      id: 5,
      account_id: 5,
      owner_id: 1,
      name: 'BuildRight SMB Package',
      value: 28000,
      stage: 'qualified',
      health: 'healthy',
      expected_close_date: new Date(Date.now() + 24 * 24 * 60 * 60 * 1000).toISOString(),
      probability: 50,
      notes: 'Budget approved, moving forward',
      created_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    }
  ],

  emails: [
    {
      id: 1,
      user_id: 1,
      deal_id: 1,
      contact_id: 1,
      direction: 'sent',
      subject: 'Great connecting yesterday - Next steps for Acme Corp',
      body: 'Hi Sarah, Thanks for taking the time to discuss your analytics needs...',
      to_address: 'sarah.chen@acmecorp.com',
      from_address: 'john.doe@company.com',
      sent_at: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
      opened_at: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
      replied_at: null
    },
    {
      id: 2,
      user_id: 1,
      deal_id: 1,
      contact_id: 1,
      direction: 'received',
      subject: 'Re: Demo scheduling',
      body: 'Looking forward to seeing the product in action...',
      to_address: 'john.doe@company.com',
      from_address: 'sarah.chen@acmecorp.com',
      sent_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      opened_at: null,
      replied_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
    }
  ],

  meetings: [
    {
      id: 1,
      deal_id: 2,
      user_id: 1,
      title: 'Executive Meeting - TechFlow Industries',
      description: 'Discussion on implementation timeline and technical requirements',
      meeting_type: 'executive',
      start_time: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      end_time: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
      location: 'https://meet.google.com/abc-defg-hij',
      status: 'scheduled',
      created_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    },
    {
      id: 2,
      deal_id: 1,
      user_id: 1,
      title: 'Product Demo - Acme Corp',
      description: 'Walkthrough of analytics module',
      meeting_type: 'demo',
      start_time: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
      end_time: new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString(),
      location: 'https://zoom.us/j/123456789',
      status: 'completed',
      created_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    }
  ],

  actions: []
};

// Helper to enrich data with relationships
export function enrichData(data) {
  const { accounts, contacts, deals, emails, meetings } = data;

  // Add account to deals
  const enrichedDeals = deals.map(deal => ({
    ...deal,
    account: accounts.find(a => a.id === deal.account_id)
  }));

  // Add account to contacts
  const enrichedContacts = contacts.map(contact => ({
    ...contact,
    account: accounts.find(a => a.id === contact.account_id)
  }));

  // Add contact and deal to emails
  const enrichedEmails = emails.map(email => ({
    ...email,
    contact: enrichedContacts.find(c => c.id === email.contact_id),
    deal: enrichedDeals.find(d => d.id === email.deal_id)
  }));

  // Add deal to meetings
  const enrichedMeetings = meetings.map(meeting => ({
    ...meeting,
    deal: enrichedDeals.find(d => d.id === meeting.deal_id)
  }));

  return {
    accounts,
    contacts: enrichedContacts,
    deals: enrichedDeals,
    emails: enrichedEmails,
    meetings: enrichedMeetings,
    actions: data.actions || []
  };
}

export default mockData;
