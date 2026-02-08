import React, { useState, useEffect } from 'react';
import { apiService } from './apiService';
import { mockData, enrichData } from './mockData';
import EmailComposer from './EmailComposer';
import './EmailView.css';

function EmailView() {
  const [emails, setEmails] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [deals, setDeals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showComposer, setShowComposer] = useState(false);
  const [replyingTo, setReplyingTo] = useState(null);
  const [selectedEmail, setSelectedEmail] = useState(null);
  const [currentFolder, setCurrentFolder] = useState('inbox');
  const [error, setError] = useState('');

  useEffect(() => {
    loadEmails();
  }, []);

  const loadEmails = async () => {
    try {
      setLoading(true);
      setError('');

      const [emailsRes, contactsRes, dealsRes] = await Promise.all([
        apiService.emails.getAll().catch(() => ({ data: { emails: mockData.emails } })),
        apiService.contacts.getAll().catch(() => ({ data: { contacts: mockData.contacts } })),
        apiService.deals.getAll().catch(() => ({ data: { deals: mockData.deals } }))
      ]);

      const enrichedData = enrichData({
        accounts: mockData.accounts,
        contacts: contactsRes.data.contacts || contactsRes.data || [],
        deals: dealsRes.data.deals || dealsRes.data || [],
        emails: emailsRes.data.emails || emailsRes.data || [],
        meetings: [],
        actions: []
      });

      setEmails(enrichedData.emails);
      setContacts(enrichedData.contacts);
      setDeals(enrichedData.deals);

    } catch (err) {
      console.error('Error loading emails:', err);
      setError('Failed to load emails. Using sample data.');
      
      const enrichedData = enrichData({
        ...mockData,
        meetings: [],
        actions: []
      });
      
      setEmails(enrichedData.emails);
      setContacts(enrichedData.contacts);
      setDeals(enrichedData.deals);
    } finally {
      setLoading(false);
    }
  };

  const handleSendEmail = async (emailData) => {
    try {
      const response = await apiService.emails.create(emailData);
      const newEmail = response.data.email || response.data;
      
      // Enrich the new email
      const contact = contacts.find(c => c.id === newEmail.contact_id);
      const deal = deals.find(d => d.id === newEmail.deal_id);
      const enrichedEmail = { 
        ...newEmail, 
        contact,
        deal,
        direction: 'sent',
        sent_at: new Date().toISOString()
      };
      
      setEmails([enrichedEmail, ...emails]);
      setShowComposer(false);
      setReplyingTo(null);
      setError('');
      setCurrentFolder('sent');
    } catch (err) {
      console.error('Error sending email:', err);
      const newEmail = { 
        ...emailData,
        id: Date.now(),
        direction: 'sent',
        sent_at: new Date().toISOString(),
        contact: contacts.find(c => c.id === emailData.contact_id),
        deal: deals.find(d => d.id === emailData.deal_id),
        from_address: 'you@company.com',
        to_address: contacts.find(c => c.id === emailData.contact_id)?.email
      };
      setEmails([newEmail, ...emails]);
      setShowComposer(false);
      setReplyingTo(null);
      setCurrentFolder('sent');
    }
  };

  const handleDeleteEmail = async (emailId) => {
    if (!window.confirm('Are you sure you want to delete this email?')) {
      return;
    }

    try {
      await apiService.emails.delete(emailId);
      setEmails(emails.filter(e => e.id !== emailId));
      if (selectedEmail?.id === emailId) {
        setSelectedEmail(null);
      }
      setError('');
    } catch (err) {
      console.error('Error deleting email:', err);
      setEmails(emails.filter(e => e.id !== emailId));
      if (selectedEmail?.id === emailId) {
        setSelectedEmail(null);
      }
    }
  };

  const filteredEmails = emails.filter(email => {
    if (currentFolder === 'inbox') {
      return email.direction === 'received';
    } else if (currentFolder === 'sent') {
      return email.direction === 'sent';
    } else if (currentFolder === 'tracked') {
      return email.direction === 'sent' && email.opened_at;
    }
    return true;
  });

  const getEmailCounts = () => {
    return {
      inbox: emails.filter(e => e.direction === 'received').length,
      sent: emails.filter(e => e.direction === 'sent').length,
      tracked: emails.filter(e => e.direction === 'sent' && e.opened_at).length
    };
  };

  const counts = getEmailCounts();

  if (loading) {
    return (
      <div className="email-view">
        <div className="loading-state">
          <div className="loading-spinner"></div>
          <p>Loading emails...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="email-view">
      {/* Header */}
      <div className="email-header">
        <div>
          <h1>Email Center</h1>
          <p className="email-subtitle">
            {counts.inbox} inbox • {counts.sent} sent • {counts.tracked} tracked opens
          </p>
        </div>
        <button className="btn-primary" onClick={() => setShowComposer(true)}>
          ✉️ Compose Email
        </button>
      </div>

      {error && (
        <div className="info-banner">
          ℹ️ {error}
        </div>
      )}

      {/* Email Container */}
      <div className={`email-container ${selectedEmail ? 'with-preview' : ''}`}>
        {/* Sidebar */}
        <div className="email-sidebar">
          <div className="folder-list">
            <button
              className={`folder-item ${currentFolder === 'inbox' ? 'active' : ''}`}
              onClick={() => {
                setCurrentFolder('inbox');
                setSelectedEmail(null);
              }}
            >
              <span className="folder-icon">📥</span>
              <span className="folder-name">Inbox</span>
              <span className="folder-count">{counts.inbox}</span>
            </button>

            <button
              className={`folder-item ${currentFolder === 'sent' ? 'active' : ''}`}
              onClick={() => {
                setCurrentFolder('sent');
                setSelectedEmail(null);
              }}
            >
              <span className="folder-icon">📤</span>
              <span className="folder-name">Sent</span>
              <span className="folder-count">{counts.sent}</span>
            </button>

            <button
              className={`folder-item ${currentFolder === 'tracked' ? 'active' : ''}`}
              onClick={() => {
                setCurrentFolder('tracked');
                setSelectedEmail(null);
              }}
            >
              <span className="folder-icon">📊</span>
              <span className="folder-name">Tracked Opens</span>
              <span className="folder-count">{counts.tracked}</span>
            </button>
          </div>
        </div>

        {/* Email List */}
        <div className="email-list-container">
          {filteredEmails.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">📭</div>
              <h3>No emails in {currentFolder}</h3>
              <p>
                {currentFolder === 'inbox' 
                  ? 'No received emails yet'
                  : currentFolder === 'sent'
                  ? 'No sent emails yet'
                  : 'No tracked opens yet'}
              </p>
              {currentFolder !== 'tracked' && (
                <button className="btn-primary" onClick={() => setShowComposer(true)}>
                  ✉️ Compose Email
                </button>
              )}
            </div>
          ) : (
            <div className="email-list">
              {filteredEmails.map(email => (
                <EmailListItem
                  key={email.id}
                  email={email}
                  isSelected={selectedEmail?.id === email.id}
                  onClick={() => setSelectedEmail(email)}
                  onDelete={() => handleDeleteEmail(email.id)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Email Preview */}
        {selectedEmail && (
          <div className="email-preview">
            <div className="preview-header">
              <div>
                <h2 className="preview-subject">{selectedEmail.subject}</h2>
                <div className="preview-meta">
                  {selectedEmail.direction === 'received' ? 'From:' : 'To:'} 
                  <strong>
                    {selectedEmail.contact 
                      ? ` ${selectedEmail.contact.first_name} ${selectedEmail.contact.last_name}` 
                      : selectedEmail.direction === 'received'
                      ? ` ${selectedEmail.from_address}`
                      : ` ${selectedEmail.to_address}`}
                  </strong>
                  {selectedEmail.contact?.account && (
                    <span className="company-tag">• {selectedEmail.contact.account.name}</span>
                  )}
                </div>
                <div className="preview-date">
                  {new Date(selectedEmail.sent_at).toLocaleString()}
                </div>
              </div>
              <button className="close-preview" onClick={() => setSelectedEmail(null)}>
                ✕
              </button>
            </div>

            <div className="preview-body">
              <div className="email-tracking-info">
                {selectedEmail.opened_at && (
                  <div className="tracking-badge opened">
                    ✓ Opened {new Date(selectedEmail.opened_at).toLocaleString()}
                  </div>
                )}
                {selectedEmail.direction === 'sent' && !selectedEmail.opened_at && (
                  <div className="tracking-badge pending">
                    ⏳ Not opened yet
                  </div>
                )}
                {selectedEmail.replied_at && (
                  <div className="tracking-badge replied">
                    ↩️ Replied {new Date(selectedEmail.replied_at).toLocaleString()}
                  </div>
                )}
              </div>

              {selectedEmail.deal && (
                <div className="email-deal-link">
                  <span className="deal-icon">💼</span>
                  <strong>Related Deal:</strong> {selectedEmail.deal.name} 
                  (${parseFloat(selectedEmail.deal.value).toLocaleString()})
                </div>
              )}

              <div className="email-content">
                {selectedEmail.body}
              </div>
            </div>

            <div className="preview-actions">
              {selectedEmail.direction === 'received' && (
                <button
                  className="btn-action"
                  onClick={() => {
                    setReplyingTo(selectedEmail);
                    setShowComposer(true);
                  }}
                >
                  ↩️ Reply
                </button>
              )}
              <button
                className="btn-action"
                onClick={() => handleDeleteEmail(selectedEmail.id)}
              >
                🗑️ Delete
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Email Composer Modal */}
      {(showComposer || replyingTo) && (
        <EmailComposer
          email={replyingTo}
          contacts={contacts}
          deals={deals}
          onSubmit={handleSendEmail}
          onClose={() => {
            setShowComposer(false);
            setReplyingTo(null);
          }}
        />
      )}
    </div>
  );
}

function EmailListItem({ email, isSelected, onClick, onDelete }) {
  const getPreview = (text) => {
    if (!text) return 'No content';
    return text.length > 100 ? text.substring(0, 100) + '...' : text;
  };

  const getContactName = () => {
    if (email.contact) {
      return `${email.contact.first_name} ${email.contact.last_name}`;
    }
    return email.direction === 'received' ? email.from_address : email.to_address;
  };

  return (
    <div
      className={`email-list-item ${isSelected ? 'selected' : ''} ${!email.opened_at && email.direction === 'received' ? 'unread' : ''}`}
      onClick={onClick}
    >
      <div className="email-item-header">
        <div className="email-from">
          <span className="direction-icon">
            {email.direction === 'sent' ? '📤' : '📥'}
          </span>
          {getContactName()}
        </div>
        <div className="email-actions">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="icon-btn"
            title="Delete"
          >
            🗑️
          </button>
        </div>
      </div>

      <div className="email-subject">{email.subject}</div>
      <div className="email-preview">{getPreview(email.body)}</div>

      <div className="email-meta">
        <span className="email-date">
          {new Date(email.sent_at).toLocaleDateString()}
        </span>
        {email.opened_at && email.direction === 'sent' && (
          <span className="email-status opened">✓ Opened</span>
        )}
        {email.replied_at && (
          <span className="email-status replied">↩️ Replied</span>
        )}
        {email.deal && (
          <span className="email-deal">💼 {email.deal.name}</span>
        )}
      </div>
    </div>
  );
}

export default EmailView;
