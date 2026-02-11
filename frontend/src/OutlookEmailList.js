import React, { useState, useEffect, useCallback } from 'react';
import './OutlookEmailList.css';
import { outlookAPI } from './apiService';

function OutlookEmailList({ userId }) {
  const [emails, setEmails] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [processingIds, setProcessingIds] = useState(new Set());

  const fetchEmails = useCallback(async () => {
    try {
      setIsLoading(true);
      const result = await outlookAPI.fetchEmails(userId, { top: 20 });
      setEmails(result.data);
    } catch (error) {
      alert('Failed to fetch emails');
      console.error('Error:', error);
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    fetchEmails();
  }, [fetchEmails]);

  const handleProcessEmail = async (emailId) => {
    try {
      setProcessingIds(prev => new Set(prev).add(emailId));
      await outlookAPI.processEmail(userId, emailId);
      alert('Email queued for AI processing! Check your actions in a moment.');
    } catch (error) {
      alert('Failed to process email');
      console.error('Error:', error);
    } finally {
      setProcessingIds(prev => {
        const newSet = new Set(prev);
        newSet.delete(emailId);
        return newSet;
      });
    }
  };

  const formatDate = (dateString) => {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now - date;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days} days ago`;
    return date.toLocaleDateString();
  };

  if (isLoading) {
    return <div className="outlook-email-list loading">Loading emails...</div>;
  }

  if (emails.length === 0) {
    return (
      <div className="outlook-email-list empty">
        <p>No emails found. Try syncing your inbox.</p>
      </div>
    );
  }

  return (
    <div className="outlook-email-list">
      <div className="email-list-header">
        <h3>Recent Emails</h3>
        <button onClick={fetchEmails} className="btn btn-small">
          Refresh
        </button>
      </div>

      <div className="email-items">
        {emails.map((email) => (
          <div 
            key={email.id} 
            className={`email-item ${email.isRead ? 'read' : 'unread'}`}
          >
            <div className="email-content">
              <div className="email-meta">
                <span className="email-from">
                  {email.from?.emailAddress?.name || email.from?.emailAddress?.address}
                </span>
                <span className="email-date">
                  {formatDate(email.receivedDateTime)}
                </span>
              </div>
              
              <h4 className="email-subject">
                {email.subject || '(No Subject)'}
              </h4>
              
              <p className="email-preview">
                {email.bodyPreview}
              </p>
            </div>

            <button
              onClick={() => handleProcessEmail(email.id)}
              disabled={processingIds.has(email.id)}
              className="btn btn-small btn-primary"
              title="Process with AI and create actions"
            >
              {processingIds.has(email.id) ? '⏳ Processing...' : '✨ Create Actions'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default OutlookEmailList;
