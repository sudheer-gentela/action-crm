import React, { useState, useEffect, useCallback } from 'react';
import OutlookEmailList from './OutlookEmailList';
import SyncStatus from './SyncStatus';
import { outlookAPI } from './apiService';
import './EmailView.css';

/**
 * CONSOLIDATED Email View
 * Combines Outlook integration, sync status, and email list in one place.
 *
 * Props:
 *   dealId              — optional; when set (from Resume), filters the email
 *                         list to show threads for this deal
 *   onDealFilterApplied — callback to clear pendingEmailDealId in App.js once
 *                         the filter has been acknowledged / applied
 */
function EmailView({ dealId = null, onDealFilterApplied }) {
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  // activeDealFilter mirrors the incoming prop but can also be cleared by the user
  const [activeDealFilter, setActiveDealFilter] = useState(dealId);

  // Sync prop → local state when App.js passes a new dealId (e.g. on resume)
  useEffect(() => {
    if (dealId) {
      setActiveDealFilter(dealId);
      // Notify App.js that we've picked it up so it can reset pendingEmailDealId
      if (onDealFilterApplied) onDealFilterApplied();
    }
  }, [dealId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Get user from localStorage and ensure userId is a NUMBER
  const getUserId = () => {
    try {
      const user = JSON.parse(localStorage.getItem('user'));
      const id = user?.id;
      if (id === null || id === undefined) return null;
      return typeof id === 'number' ? id : parseInt(id, 10);
    } catch (error) {
      console.error('Error getting user from localStorage:', error);
      return null;
    }
  };

  const userId = getUserId();

  // Check Outlook connection status
  const checkConnection = useCallback(async () => {
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
            {/* Resume banner — shown when navigated from a Resume action */}
            {activeDealFilter && (
              <div className="email-resume-banner">
                <span className="email-resume-banner__icon">↩</span>
                <span className="email-resume-banner__text">
                  Showing emails for this deal
                </span>
                <button
                  className="email-resume-banner__clear"
                  onClick={() => setActiveDealFilter(null)}
                  title="Show all emails"
                >
                  ✕ Show all
                </button>
              </div>
            )}

            {/* Sync Status & Controls */}
            <SyncStatus userId={userId} />

            {/* Email List — pass dealId filter when active */}
            <OutlookEmailList
              userId={userId}
              dealId={activeDealFilter || undefined}
            />

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
