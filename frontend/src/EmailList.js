import React, { useState, useEffect, useCallback } from 'react';
import './OutlookEmailList.css';
import { unifiedEmailAPI } from './apiService';

/**
 * EmailList.js (NEW FILE - replaces OutlookEmailList.js usage)
 *
 * DROP-IN LOCATION: frontend/src/EmailList.js
 *
 * Unified email list showing emails from all connected providers
 * with source badges and provider filtering.
 *
 * NOTE: Keep OutlookEmailList.js around for backward compat.
 * EmailView.js now imports EmailList instead.
 */

function EmailList({ userId, dealId, connectedProviders = [] }) {
  const [emails, setEmails]                 = useState([]);
  const [isLoading, setIsLoading]           = useState(false);
  const [error, setError]                   = useState(null);
  const [providerErrors, setProviderErrors] = useState([]);
  const [processingIds, setProcessingIds]   = useState(new Set());
  const [providerFilter, setProviderFilter] = useState('all');

  const fetchEmails = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const result = await unifiedEmailAPI.fetchEmails({
        top: 50,
        dealId: dealId || undefined,
      });

      let emailsArray = result?.data || [];

      // Surface any per-provider errors (e.g. Gmail token expired)
      setProviderErrors(result?.providerErrors || []);

      // Client-side provider filter
      if (providerFilter !== 'all') {
        emailsArray = emailsArray.filter(e => e.provider === providerFilter);
      }

      setEmails(emailsArray);
    } catch (err) {
      console.error('Error fetching emails:', err);
      setError(err.message || 'Failed to fetch emails');
      setEmails([]);
    } finally {
      setIsLoading(false);
    }
  }, [dealId, providerFilter]);

  useEffect(() => {
    if (userId) fetchEmails();
  }, [fetchEmails, userId, dealId]);

  const handleProcessEmail = async (email) => {
    const emailDbId = email.dbId;
    if (!emailDbId || typeof emailDbId !== 'number') {
      alert('This email hasn\'t been synced to the database yet. Try refreshing in a moment.');
      return;
    }
    try {
      setProcessingIds(prev => new Set(prev).add(emailDbId));

      const token = localStorage.getItem('token');
      const API   = process.env.REACT_APP_API_URL || '';
      const res = await fetch(API + '/sync/emails/' + emailDbId + '/analyze', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      });

      if (!res.ok) throw new Error('Failed to process');
      alert('Email queued for AI processing! Check your actions shortly.');
    } catch (err) {
      alert('Failed to process email');
      console.error('Error:', err);
    } finally {
      setProcessingIds(prev => {
        const newSet = new Set(prev);
        newSet.delete(emailDbId);
        return newSet;
      });
    }
  };

  const formatDate = (dateString) => {
    if (!dateString) return '';
    try {
      const date = new Date(dateString);
      const now = new Date();
      const diff = now - date;
      const days = Math.floor(diff / (1000 * 60 * 60 * 24));

      if (days === 0) {
        const hours = Math.floor(diff / (1000 * 60 * 60));
        if (hours === 0) {
          const minutes = Math.floor(diff / (1000 * 60));
          return minutes <= 1 ? 'Just now' : minutes + 'm ago';
        }
        return hours + 'h ago';
      }
      if (days === 1) return 'Yesterday';
      if (days < 7) return days + 'd ago';
      return date.toLocaleDateString('en-US', {
        month: 'short', day: 'numeric',
        year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
      });
    } catch (e) { return ''; }
  };

  const getProviderBadge = (provider) => {
    if (provider === 'gmail') return { icon: '\u2709', label: 'Gmail', className: 'provider-gmail' };
    return { icon: '\u2709', label: 'Outlook', className: 'provider-outlook' };
  };

  if (isLoading) {
    return (
      <div className="outlook-email-list loading">
        <div className="loading-spinner"><div className="spinner"></div><p>Loading emails...</p></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="outlook-email-list error">
        <div className="error-box">
          <p>{error}</p>
          <button onClick={fetchEmails} className="btn btn-small btn-primary">Try Again</button>
        </div>
      </div>
    );
  }

  return (
    <div className="outlook-email-list">
      <div className="email-list-header">
        <h3>{dealId ? 'Deal Emails (' + emails.length + ')' : 'Recent Emails (' + emails.length + ')'}</h3>

        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {connectedProviders.length > 1 && (
            <div className="email-provider-filter">
              <button
                className={'provider-filter-btn' + (providerFilter === 'all' ? ' active' : '')}
                onClick={() => setProviderFilter('all')}>All</button>
              {connectedProviders.includes('outlook') && (
                <button
                  className={'provider-filter-btn' + (providerFilter === 'outlook' ? ' active' : '')}
                  onClick={() => setProviderFilter('outlook')}>Outlook</button>
              )}
              {connectedProviders.includes('gmail') && (
                <button
                  className={'provider-filter-btn' + (providerFilter === 'gmail' ? ' active' : '')}
                  onClick={() => setProviderFilter('gmail')}>Gmail</button>
              )}
            </div>
          )}
          <button onClick={fetchEmails} className="btn btn-small btn-outline">Refresh</button>
        </div>
      </div>

      {providerErrors.map(pe => (
        <div key={pe.provider} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 14px', marginBottom: 8, borderRadius: 6,
          background: '#fff7ed', border: '1px solid #fed7aa', fontSize: 13,
        }}>
          <span style={{ color: '#92400e' }}>
            ⚠️ {pe.provider === 'gmail' ? 'Gmail' : 'Outlook'} failed to load: {pe.error}
          </span>
          {pe.error?.toLowerCase().includes('reconnect') && (
            <a href="/settings" style={{
              marginLeft: 12, color: '#b45309', fontWeight: 600,
              textDecoration: 'underline', whiteSpace: 'nowrap',
            }}>
              Reconnect →
            </a>
          )}
        </div>
      ))}

      {(!emails || emails.length === 0) ? (
        <div className="empty-state">
          <p>{dealId ? 'No emails found for this deal' : 'No emails found'}</p>
          <button onClick={fetchEmails} className="btn btn-small btn-primary">Refresh</button>
        </div>
      ) : (
        <div className="email-items">
          {emails.map((email) => {
            const senderName = email.from?.name || email.from?.address || 'Unknown Sender';
            const subject    = email.subject || '(No Subject)';
            const preview    = email.bodyPreview || email.body?.content?.substring(0, 150) || '';
            const date       = formatDate(email.receivedDateTime);
            const isRead     = email.isRead !== false;
            const badge      = getProviderBadge(email.provider);

            return (
              <div key={(email.provider || 'e') + '-' + email.id}
                   className={'email-item ' + (isRead ? 'read' : 'unread')}>
                <div className="email-main">
                  <div className="email-header-row">
                    <div className="email-sender">
                      <span className="sender-avatar">{senderName.charAt(0).toUpperCase()}</span>
                      <span className="sender-name">{senderName}</span>
                      <span className={'email-provider-badge ' + badge.className} title={badge.label}>
                        {email.provider === 'gmail' ? 'Gmail' : 'Outlook'}
                      </span>
                    </div>
                    <span className="email-date">{date}</span>
                  </div>

                  <h4 className="email-subject">
                    {!isRead && <span className="unread-dot">&#9679;</span>}
                    {subject}
                  </h4>

                  <p className="email-preview">{preview}</p>
                </div>

                <div className="email-actions">
                  <button
                    onClick={() => handleProcessEmail(email)}
                    disabled={!email.dbId || processingIds.has(email.dbId)}
                    className="btn btn-small btn-primary"
                    title={!email.dbId ? 'Email not yet synced — refresh to retry' : 'Process with AI and create actions'}
                  >
                    {processingIds.has(email.dbId) ? (
                      <><span className="spinner-small"></span> Processing...</>
                    ) : !email.dbId ? (
                      <>Not synced</>
                    ) : (
                      <>Create Actions</>
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default EmailList;
