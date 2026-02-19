import React, { useState, useEffect, useCallback } from 'react';
import OutlookEmailList from './OutlookEmailList';
import SyncStatus from './SyncStatus';
import { outlookAPI } from './apiService';
import './EmailView.css';

/**
 * CONSOLIDATED Email View
 * Combines Outlook integration, sync status, and email list in one place
 * Replaces both "Email" and "Outlook Emails" tabs
 */
function EmailView() {
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  
  // Get user from localStorage and ensure userId is a NUMBER
  const getUserId = () => {
    try {
      const user = JSON.parse(localStorage.getItem('user'));
      const id = user?.id;
      
      if (id === null || id === undefined) {
        return null;
      }
      
      // Convert to number if it's a string
      const userId = typeof id === 'number' ? id : parseInt(id, 10);
      return userId;
    } catch (error) {
      console.error('Error getting user from localStorage:', error);
      return null;
    }
  };

  const userId = getUserId();

  // Check Outlook connection status
  const checkConnection = useCallback(async () => {
    // Don't check if no userId
    if (!userId) {
      console.warn('⚠️  No userId available in EmailView');
      setIsConnected(false);
      setIsLoading(false);
      return;
    }

    try {
      const status = await outlookAPI.getStatus(userId);
      setIsConnected(status.connected);
    } catch (error) {
      console.error('Error checking connection:', error);
      setIsConnected(false);
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    checkConnection();
  }, [checkConnection]);

  if (isLoading) {
    return (
      <div className="email-view loading">
        <div className="loading-spinner">
          <div className="spinner"></div>
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  // Show error if no userId
  if (!userId) {
    return (
      <div className="email-view">
        <div className="email-header">
          <div>
            <h2>📧 Email Management</h2>
            <p className="email-subtitle">Sync and manage your Outlook emails</p>
          </div>
        </div>
        <div className="email-content">
          <div className="error-message">
            <p>⚠️ Unable to load user session. Please refresh the page.</p>
            <button onClick={() => window.location.reload()} className="btn btn-primary">
              Refresh Page
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="email-view">
      {/* Header */}
      <div className="email-header">
        <div>
          <h2>📧 Email Management</h2>
          <p className="email-subtitle">
            {isConnected 
              ? 'Your Outlook account is connected and syncing' 
              : 'Connect your Outlook account to get started'}
          </p>
        </div>
      </div>

      <div className="email-content">
        {isConnected ? (
          <>
            {/* Sync Status & Controls */}
            <SyncStatus userId={userId} />
            
            {/* Email List with AI Analysis Button */}
            <OutlookEmailList userId={userId} />
            
            {/* Help Text */}
            <div className="email-help-section">
              <h3>💡 How it works</h3>
              <div className="help-cards">
                <div className="help-card">
                  <div className="help-icon">⚙️</div>
                  <h4>1. Sync Emails</h4>
                  <p>Click "Sync Emails" to import your Outlook inbox. Rule-based actions are created automatically.</p>
                </div>
                <div className="help-card">
                  <div className="help-icon">🤖</div>
                  <h4>2. AI Analysis</h4>
                  <p>Click "🤖 AI Analyze" on any email for context-aware action recommendations powered by Claude.</p>
                </div>
                <div className="help-card">
                  <div className="help-icon">🎯</div>
                  <h4>3. Take Action</h4>
                  <p>View all generated actions in the Actions tab. Filter by rule-based (⚙️) or AI-powered (🤖).</p>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="not-connected-message">
            <div className="connect-prompt">
              <div className="connect-icon">🔌</div>
              <h3>Outlook Not Connected</h3>
              <p>Connect your Microsoft account to start syncing emails.</p>
              <ul>
                <li>✅ Sync emails to your CRM</li>
                <li>✅ Auto-generate follow-up actions</li>
                <li>✅ Get AI-powered recommendations</li>
                <li>✅ Link emails to deals and contacts</li>
              </ul>
              <a
                href="#settings"
                className="btn btn-primary"
                onClick={e => { e.preventDefault(); window.dispatchEvent(new CustomEvent('navigate', { detail: 'settings' })); }}
              >
                ⚙️ Go to Settings → Integrations
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default EmailView;
