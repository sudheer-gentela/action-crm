import React, { useState, useEffect } from 'react';
import { apiService } from './apiService';
import { mockData, enrichData } from './mockData';
import ContactForm from './ContactForm';
import './ContactsView.css';

function ContactsView() {
  const [contacts, setContacts] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [deals, setDeals] = useState([]);
  const [emails, setEmails] = useState([]);
  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingContact, setEditingContact] = useState(null);
  const [selectedContact, setSelectedContact] = useState(null);
  const [error, setError] = useState('');
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    loadContacts();
  }, []);

  const loadContacts = async () => {
    try {
      setLoading(true);
      setError('');

      const [contactsRes, accountsRes, dealsRes, emailsRes, meetingsRes] = await Promise.all([
        apiService.contacts.getAll().catch(() => ({ data: { contacts: mockData.contacts } })),
        apiService.accounts.getAll().catch(() => ({ data: { accounts: mockData.accounts } })),
        apiService.deals.getAll().catch(() => ({ data: { deals: mockData.deals } })),
        apiService.emails.getAll().catch(() => ({ data: { emails: mockData.emails } })),
        apiService.meetings.getAll().catch(() => ({ data: { meetings: mockData.meetings } }))
      ]);

      const enrichedData = enrichData({
        accounts: accountsRes.data.accounts || accountsRes.data || [],
        contacts: contactsRes.data.contacts || contactsRes.data || [],
        deals: dealsRes.data.deals || dealsRes.data || [],
        emails: emailsRes.data.emails || emailsRes.data || [],
        meetings: meetingsRes.data.meetings || meetingsRes.data || [],
        actions: []
      });

      setContacts(enrichedData.contacts);
      setAccounts(enrichedData.accounts);
      setDeals(enrichedData.deals);
      setEmails(enrichedData.emails);
      setMeetings(enrichedData.meetings);

    } catch (err) {
      console.error('Error loading contacts:', err);
      setError('Failed to load contacts. Using sample data.');
      
      const enrichedData = enrichData({
        ...mockData,
        actions: []
      });
      
      setContacts(enrichedData.contacts);
      setAccounts(enrichedData.accounts);
      setDeals(enrichedData.deals);
      setEmails(enrichedData.emails);
      setMeetings(enrichedData.meetings);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateContact = async (contactData) => {
    try {
      const response = await apiService.contacts.create(contactData);
      const newContact = response.data.contact || response.data;
      
      // Enrich the new contact
      const account = accounts.find(a => a.id === newContact.account_id);
      const enrichedContact = { ...newContact, account };
      
      setContacts([...contacts, enrichedContact]);
      setShowForm(false);
      setError('');
    } catch (err) {
      console.error('Error creating contact:', err);
      const newContact = { 
        ...contactData, 
        id: Date.now(),
        account: accounts.find(a => a.id === contactData.account_id),
        created_at: new Date().toISOString(),
        last_contact_date: new Date().toISOString()
      };
      setContacts([...contacts, newContact]);
      setShowForm(false);
    }
  };

  const handleUpdateContact = async (contactData) => {
    try {
      const response = await apiService.contacts.update(editingContact.id, contactData);
      const updatedContact = response.data.contact || response.data;
      
      // Enrich the updated contact
      const account = accounts.find(a => a.id === updatedContact.account_id);
      const enrichedContact = { ...updatedContact, account };
      
      setContacts(contacts.map(c => 
        c.id === editingContact.id ? enrichedContact : c
      ));
      setEditingContact(null);
      setError('');
    } catch (err) {
      console.error('Error updating contact:', err);
      const account = accounts.find(a => a.id === contactData.account_id);
      setContacts(contacts.map(c => 
        c.id === editingContact.id ? { ...c, ...contactData, account } : c
      ));
      setEditingContact(null);
    }
  };

  const handleDeleteContact = async (contactId) => {
    if (!window.confirm('Are you sure you want to delete this contact?')) {
      return;
    }

    try {
      await apiService.contacts.delete(contactId);
      setContacts(contacts.filter(c => c.id !== contactId));
      if (selectedContact?.id === contactId) {
        setSelectedContact(null);
      }
      setError('');
    } catch (err) {
      console.error('Error deleting contact:', err);
      setContacts(contacts.filter(c => c.id !== contactId));
      if (selectedContact?.id === contactId) {
        setSelectedContact(null);
      }
    }
  };

  const getContactDeals = (contactId) => {
    const contact = contacts.find(c => c.id === contactId);
    if (!contact) return [];
    return deals.filter(d => d.account_id === contact.account_id);
  };

  const getContactEmails = (contactId) => {
    return emails.filter(e => e.contact_id === contactId);
  };

  const getContactMeetings = (contactId) => {
    const contact = contacts.find(c => c.id === contactId);
    if (!contact) return [];
    const contactDeals = getContactDeals(contactId);
    const dealIds = contactDeals.map(d => d.id);
    return meetings.filter(m => dealIds.includes(m.deal_id));
  };

  const filteredContacts = contacts.filter(contact => {
    if (!searchTerm) return true;
    const search = searchTerm.toLowerCase();
    return (
      contact.first_name?.toLowerCase().includes(search) ||
      contact.last_name?.toLowerCase().includes(search) ||
      contact.email?.toLowerCase().includes(search) ||
      contact.title?.toLowerCase().includes(search) ||
      contact.account?.name?.toLowerCase().includes(search)
    );
  });

  // Group contacts by engagement level
  const groupedContacts = {
    high: filteredContacts.filter(c => c.engagement_level === 'high'),
    medium: filteredContacts.filter(c => c.engagement_level === 'medium'),
    low: filteredContacts.filter(c => c.engagement_level === 'low')
  };

  if (loading) {
    return (
      <div className="contacts-view">
        <div className="loading-state">
          <div className="loading-spinner"></div>
          <p>Loading contacts...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="contacts-view">
      {/* Header */}
      <div className="contacts-header">
        <div>
          <h1>Contacts</h1>
          <p className="contacts-subtitle">
            {contacts.length} contact{contacts.length !== 1 ? 's' : ''} in your CRM
          </p>
        </div>
        <button className="btn-primary" onClick={() => setShowForm(true)}>
          + New Contact
        </button>
      </div>

      {error && (
        <div className="info-banner">
          ℹ️ {error}
        </div>
      )}

      {/* Search Bar */}
      <div className="search-bar">
        <input
          type="text"
          placeholder="Search contacts by name, email, title, or company..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="search-input"
        />
        {searchTerm && (
          <button className="clear-search" onClick={() => setSearchTerm('')}>
            ✕
          </button>
        )}
      </div>

      {/* Stats */}
      <div className="contacts-stats">
        <div className="stat-card">
          <div className="stat-value">{groupedContacts.high.length}</div>
          <div className="stat-label">High Engagement</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{groupedContacts.medium.length}</div>
          <div className="stat-label">Medium Engagement</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{groupedContacts.low.length}</div>
          <div className="stat-label">Low Engagement</div>
        </div>
      </div>

      {/* Contacts Container */}
      <div className={`contacts-container ${selectedContact ? 'with-panel' : ''}`}>
        {/* Contacts List */}
        <div className="contacts-list">
          {filteredContacts.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">👥</div>
              <h3>{searchTerm ? 'No contacts found' : 'No contacts yet'}</h3>
              <p>
                {searchTerm 
                  ? 'Try a different search term'
                  : 'Create your first contact to start building relationships'}
              </p>
              {!searchTerm && (
                <button className="btn-primary" onClick={() => setShowForm(true)}>
                  + Create Contact
                </button>
              )}
            </div>
          ) : (
            filteredContacts.map(contact => (
              <ContactCard
                key={contact.id}
                contact={contact}
                deals={getContactDeals(contact.id)}
                onEdit={() => setEditingContact(contact)}
                onDelete={() => handleDeleteContact(contact.id)}
                onSelect={() => setSelectedContact(contact)}
                isSelected={selectedContact?.id === contact.id}
              />
            ))
          )}
        </div>

        {/* Contact Detail Panel */}
        {selectedContact && (
          <div className="contact-detail-panel">
            <div className="panel-header">
              <div>
                <h2>{selectedContact.first_name} {selectedContact.last_name}</h2>
                {selectedContact.title && (
                  <p className="panel-subtitle">{selectedContact.title}</p>
                )}
              </div>
              <button className="close-panel" onClick={() => setSelectedContact(null)}>×</button>
            </div>

            <div className="panel-content">
              {/* Contact Information */}
              <div className="detail-section">
                <h3>Contact Information</h3>
                <div className="detail-grid">
                  <div className="detail-item">
                    <span className="detail-label">Email</span>
                    <a href={`mailto:${selectedContact.email}`}>{selectedContact.email}</a>
                  </div>
                  {selectedContact.phone && (
                    <div className="detail-item">
                      <span className="detail-label">Phone</span>
                      <a href={`tel:${selectedContact.phone}`}>{selectedContact.phone}</a>
                    </div>
                  )}
                  {selectedContact.account && (
                    <div className="detail-item">
                      <span className="detail-label">Company</span>
                      <span>{selectedContact.account.name}</span>
                    </div>
                  )}
                  {selectedContact.role_type && (
                    <div className="detail-item">
                      <span className="detail-label">Role Type</span>
                      <span className={`detail-badge role-${selectedContact.role_type}`}>
                        {selectedContact.role_type.replace('_', ' ')}
                      </span>
                    </div>
                  )}
                  <div className="detail-item">
                    <span className="detail-label">Engagement</span>
                    <span className={`detail-badge engagement-${selectedContact.engagement_level}`}>
                      {selectedContact.engagement_level} engagement
                    </span>
                  </div>
                  {selectedContact.last_contact_date && (
                    <div className="detail-item">
                      <span className="detail-label">Last Contact</span>
                      <span>{new Date(selectedContact.last_contact_date).toLocaleDateString()}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Related Deals */}
              <div className="detail-section">
                <h3>Related Deals ({getContactDeals(selectedContact.id).length})</h3>
                {getContactDeals(selectedContact.id).length === 0 ? (
                  <p className="empty-message">No deals for this contact's company</p>
                ) : (
                  <div className="linked-items-list">
                    {getContactDeals(selectedContact.id).map(deal => (
                      <div key={deal.id} className="linked-item">
                        <span className="item-icon">💼</span>
                        <div className="item-info">
                          <div className="item-name">{deal.name}</div>
                          <div className="item-meta">
                            ${parseFloat(deal.value).toLocaleString()} • {deal.stage}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Email Activity */}
              <div className="detail-section">
                <h3>Email Activity ({getContactEmails(selectedContact.id).length})</h3>
                {getContactEmails(selectedContact.id).length === 0 ? (
                  <p className="empty-message">No email history</p>
                ) : (
                  <div className="linked-items-list">
                    {getContactEmails(selectedContact.id).map(email => (
                      <div key={email.id} className="linked-item">
                        <span className="item-icon">
                          {email.direction === 'sent' ? '📤' : '📥'}
                        </span>
                        <div className="item-info">
                          <div className="item-name">{email.subject}</div>
                          <div className="item-meta">
                            {new Date(email.sent_at).toLocaleDateString()}
                            {email.opened_at && ' • Opened'}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Meetings */}
              <div className="detail-section">
                <h3>Meetings ({getContactMeetings(selectedContact.id).length})</h3>
                {getContactMeetings(selectedContact.id).length === 0 ? (
                  <p className="empty-message">No meetings scheduled</p>
                ) : (
                  <div className="linked-items-list">
                    {getContactMeetings(selectedContact.id).map(meeting => (
                      <div key={meeting.id} className="linked-item">
                        <span className="item-icon">📅</span>
                        <div className="item-info">
                          <div className="item-name">{meeting.title}</div>
                          <div className="item-meta">
                            {new Date(meeting.start_time).toLocaleString()} • {meeting.status}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Quick Actions */}
              <div className="detail-section">
                <h3>Quick Actions</h3>
                <div className="quick-actions">
                  <button 
                    className="btn-action"
                    onClick={() => setEditingContact(selectedContact)}
                  >
                    ✏️ Edit Contact
                  </button>
                  <button 
                    className="btn-action"
                    onClick={() => handleDeleteContact(selectedContact.id)}
                  >
                    🗑️ Delete Contact
                  </button>
                  <a 
                    href={`mailto:${selectedContact.email}`}
                    className="btn-action"
                  >
                    ✉️ Send Email
                  </a>
                  {selectedContact.phone && (
                    <a 
                      href={`tel:${selectedContact.phone}`}
                      className="btn-action"
                    >
                      📞 Call Contact
                    </a>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Contact Form Modal */}
      {(showForm || editingContact) && (
        <ContactForm
          contact={editingContact}
          accounts={accounts}
          onSubmit={editingContact ? handleUpdateContact : handleCreateContact}
          onClose={() => {
            setShowForm(false);
            setEditingContact(null);
          }}
        />
      )}
    </div>
  );
}

function ContactCard({ contact, deals, onEdit, onDelete, onSelect, isSelected }) {
  const account = contact.account || { name: 'Unknown Company' };
  const activeDeals = deals.filter(d => d.stage !== 'closed_won' && d.stage !== 'closed_lost');
  
  return (
    <div 
      className={`contact-card ${isSelected ? 'selected' : ''}`}
      onClick={onSelect}
    >
      <div className="contact-card-header">
        <div className="contact-avatar">
          {contact.first_name?.[0]}{contact.last_name?.[0]}
        </div>
        <div className="contact-actions">
          <button 
            onClick={(e) => { e.stopPropagation(); onEdit(); }} 
            className="icon-btn" 
            title="Edit"
          >
            ✏️
          </button>
          <button 
            onClick={(e) => { e.stopPropagation(); onDelete(); }} 
            className="icon-btn" 
            title="Delete"
          >
            🗑️
          </button>
        </div>
      </div>

      <h3 className="contact-name">
        {contact.first_name} {contact.last_name}
      </h3>
      
      {contact.title && (
        <p className="contact-title">{contact.title}</p>
      )}

      <p className="contact-company">{account.name}</p>

      <div className="contact-meta">
        <span className="contact-email">✉️ {contact.email}</span>
        {contact.phone && (
          <span className="contact-phone">📞 {contact.phone}</span>
        )}
      </div>

      {contact.role_type && (
        <div className={`contact-role role-${contact.role_type}`}>
          {contact.role_type.replace('_', ' ')}
        </div>
      )}

      <div className="contact-footer">
        <span className={`engagement-badge ${contact.engagement_level}`}>
          {contact.engagement_level} engagement
        </span>
        <span className="deals-count">
          {activeDeals.length} active deal{activeDeals.length !== 1 ? 's' : ''}
        </span>
      </div>
    </div>
  );
}

export default ContactsView;
