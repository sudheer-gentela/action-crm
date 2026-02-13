import React, { useState, useEffect, useCallback } from 'react';
import './OutlookEmailList.css';
import { outlookAPI } from './apiService';

function OutlookEmailList({ userId }) {
  const [emails, setEmails] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [processingIds, setProcessingIds] = useState(new Set());

  const fetchEmails = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      
      console.log('📧 Fetching emails for userId:', userId);
      const result = await outlookAPI.fetchEmails(userId, { top: 20 });
      
      console.log('📧 API Result:', result);
      console.log('📧 Emails array:', result?.data);
      
      // ✅ Safe access with fallback
      const emailsArray = result?.data || [];
      
      // Debug: Log first email structure
      if (emailsArray.length > 0) {
        console.log('📧 First email structure:', emailsArray[0]);
      }
      
      setEmails(emailsArray);
    } catch (error) {
      console.error('Error fetching emails:', error);
      setError(error.message || 'Failed to fetch emails');
      setEmails([]);
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (userId) {
      fetchEmails();
    }
  }, [fetchEmails, userId]);

  const handleProcessEmail = async (emailId) => {
    try {
      setProcessingIds(prev => new Set(prev).add(emailId));
      await outlookAPI.processEmail(userId, emailId);
      alert('✅ Email queued for AI processing! Check your actions in a moment.');
    } catch (error) {
      alert('❌ Failed to process email');
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
          return minutes <= 1 ? 'Just now' : `${minutes}m ago`;
        }
        return `${hours}h ago`;
      }
      if (days === 1) return 'Yesterday';
      if (days < 7) return `${days}d ago`;
      
      return date.toLocaleDateString('en-US', { 
        month: 'short', 
        day: 'numeric',
        year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
      });
    } catch (error) {
      console.error('Date formatting error:', error);
      return '';
    }
  };

  const getSenderName = (email) => {
    // Try multiple possible structures
    const fromData = email.from || email.sender;
    
    if (!fromData) return 'Unknown Sender';
    
    // Microsoft Graph API structure
    if (fromData.emailAddress) {
      return fromData.emailAddress.name || fromData.emailAddress.address || 'Unknown';
    }
    
    // Fallback structures
    if (fromData.name) return fromData.name;
    if (fromData.email) return fromData.email;
    if (fromData.address) return fromData.address;
    
    return 'Unknown Sender';
  };

  if (isLoading) {
    return (
      <div className="outlook-email-list loading">
        <div className="loading-spinner">
          <div className="spinner"></div>
          <p>Loading emails...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="outlook-email-list error">
        <div className="error-box">
          <p>⚠️ {error}</p>
          <button onClick={fetchEmails} className="btn btn-small btn-primary">
            Try Again
          </button>
        </div>
      </div>
    );
  }

  if (!emails || emails.length === 0) {
    return (
      <div className="outlook-email-list empty">
        <div className="empty-state">
          <p>📭 No emails found</p>
          <p className="empty-subtitle">Try syncing your inbox or check your connection</p>
          <button onClick={fetchEmails} className="btn btn-small btn-primary">
            Refresh
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="outlook-email-list">
      <div className="email-list-header">
        <h3>Recent Emails ({emails.length})</h3>
        <button onClick={fetchEmails} className="btn btn-small btn-outline">
          🔄 Refresh
        </button>
      </div>

      <div className="email-items">
        {emails.map((email) => {
          const senderName = getSenderName(email);
          const subject = email.subject || '(No Subject)';
          const preview = email.bodyPreview || email.body?.content?.substring(0, 150) || '';
          const date = formatDate(email.receivedDateTime || email.sentDateTime);
          const isRead = email.isRead !== false; // Default to read if not specified
          
          return (
            <div 
              key={email.id} 
              className={`email-item ${isRead ? 'read' : 'unread'}`}
            >
              <div className="email-main">
                <div className="email-header-row">
                  <div className="email-sender">
                    <span className="sender-avatar">
                      {senderName.charAt(0).toUpperCase()}
                    </span>
                    <span className="sender-name">{senderName}</span>
                  </div>
                  <span className="email-date">{date}</span>
                </div>
                
                <h4 className="email-subject">
                  {!isRead && <span className="unread-dot">●</span>}
                  {subject}
                </h4>
                
                <p className="email-preview">
                  {preview}
                </p>
              </div>

              <div className="email-actions">
                <button
                  onClick={() => handleProcessEmail(email.id)}
                  disabled={processingIds.has(email.id)}
                  className="btn btn-small btn-primary"
                  title="Process with AI and create actions"
                >
                  {processingIds.has(email.id) ? (
                    <>
                      <span className="spinner-small"></span>
                      Processing...
                    </>
                  ) : (
                    <>✨ Create Actions</>
                  )}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default OutlookEmailList;
