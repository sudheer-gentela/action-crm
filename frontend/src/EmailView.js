import React, { useState, useEffect, useCallback } from 'react';
import EmailList from './EmailList';
import SyncStatus from './SyncStatus';
import { unifiedEmailAPI } from './apiService';
import './EmailView.css';

/**
 * EmailView.js (REPLACEMENT)
 *
 * DROP-IN LOCATION: frontend/src/EmailView.js
 *
 * Key changes from original:
 *   - Shows emails from ALL connected providers (Outlook + Gmail)
 *   - Detects connected providers dynamically
 *   - Uses unified email API
 *   - Provider-aware messaging throughout UI
 */

function EmailView({ dealId = null, onDealFilterApplied }) {
  const [connectedProviders, setConnectedProviders] = useState([]);
  const [isLoading, setIsLoading]                   = useState(true);
  const [activeDealFilter, setActiveDealFilter]     = useState(dealId);

  useEffect(() => {
    if (dealId) {
      setActiveDealFilter(dealId);
      if (onDealFilterApplied) onDealFilterApplied();
    }
  }, [dealId]); // eslint-disable-line react-hooks/exhaustive-deps

  const getUserId = () => {
    try {
      const user = JSON.parse(localStorage.getItem('user'));
      const id = user?.id;
      if (id === null || id === undefined) return null;
      return typeof id === 'number' ? id : parseInt(id, 10);
    } catch (error) {
      return null;
    }
  };

  const userId = getUserId();

  const checkConnections = useCallback(async () => {
    if (!userId) {
      setConnectedProviders([]);
      setIsLoading(false);
      return;
    }
    try {
      const providers = await unifiedEmailAPI.getConnectedProviders();
      setConnectedProviders(providers);
    } catch (error) {
      console.error('Error checking connections:', error);
      setConnectedProviders([]);
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    checkConnections();
  }, [checkConnections]);

  const isConnected = connectedProviders.length > 0;

  const providerLabel = connectedProviders
    .map(p => p === 'outlook' ? 'Outlook' : 'Gmail')
    .join(' & ');

  if (isLoading) {
    return (
      <div className="email-view loading">
        <div className="loading-spinner"><div className="spinner"></div><p>Loading...</p></div>
      </div>
    );
  }

  if (!userId) {
    return (
      <div className="email-view">
        <div className="email-header">
          <div><h2>Email Management</h2></div>
        </div>
        <div className="email-content">
          <div className="error-message">
            <p>Unable to load user session. Please refresh the page.</p>
            <button onClick={() => window.location.reload()} className="btn btn-primary">Refresh Page</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="email-view">
      <div className="email-header">
        <div>
          <h2>Email Management</h2>
          <p className="email-subtitle">
            {isConnected
              ? 'Connected: ' + providerLabel
              : 'Connect an email account to get started'}
          </p>
        </div>
      </div>

      <div className="email-content">
        {isConnected ? (
          <>
            {activeDealFilter && (
              <div className="email-resume-banner">
                <span className="email-resume-banner__icon">&#8617;</span>
                <span className="email-resume-banner__text">Showing emails for this deal</span>
                <button className="email-resume-banner__clear"
                  onClick={() => setActiveDealFilter(null)} title="Show all emails">
                  Show all
                </button>
              </div>
            )}

            <SyncStatus userId={userId} connectedProviders={connectedProviders} />

            <EmailList
              userId={userId}
              dealId={activeDealFilter || undefined}
              connectedProviders={connectedProviders}
            />

            <div className="email-help-section">
              <h3>How it works</h3>
              <div className="help-cards">
                <div className="help-card">
                  <div className="help-icon">&#9881;</div>
                  <h4>1. Sync Emails</h4>
                  <p>Click "Sync Emails" to import from {providerLabel}. Rule-based actions are created automatically.</p>
                </div>
                <div className="help-card">
                  <div className="help-icon">&#129302;</div>
                  <h4>2. AI Analysis</h4>
                  <p>Click "AI Analyze" on any email for context-aware action recommendations.</p>
                </div>
                <div className="help-card">
                  <div className="help-icon">&#127919;</div>
                  <h4>3. Take Action</h4>
                  <p>View all generated actions in the Actions tab. Each action shows its email source.</p>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="not-connected-message">
            <div className="connect-prompt">
              <div className="connect-icon">&#128268;</div>
              <h3>No Email Connected</h3>
              <p>Connect your Microsoft or Google account to start syncing emails.</p>
              <ul>
                <li>Sync emails from Outlook or Gmail</li>
                <li>Auto-generate follow-up actions</li>
                <li>AI-powered recommendations</li>
                <li>Link emails to deals and contacts</li>
              </ul>
              <a href="#settings" className="btn btn-primary"
                onClick={e => { e.preventDefault(); window.dispatchEvent(new CustomEvent('navigate', { detail: 'settings' })); }}>
                Go to Settings - Integrations
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default EmailView;
