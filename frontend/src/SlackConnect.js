/**
 * SlackConnect.js
 *
 * DROP-IN LOCATION: frontend/src/SlackConnect.js
 *
 * Org Admin panel to connect / disconnect the org's Slack workspace.
 * Reuses SalesforceConnect.css for styling (same classes HubSpotConnect uses).
 *
 * Render it inside your org-admin integrations area, e.g. in OAIntegrations.js:
 *   import SlackConnect from '../../SlackConnect';
 *   <SlackConnect />
 */

import React, { useState, useEffect, useCallback } from 'react';
import './SalesforceConnect.css';
import { slackAPI } from './apiService';

export default function SlackConnect({ onConnectionChange }) {
  const [status,  setStatus]  = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy,    setBusy]    = useState(false);
  const [error,   setError]   = useState('');
  const [success, setSuccess] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await slackAPI.getStatus();
      setStatus(res.data || { connected: false });
    } catch {
      setError('Failed to load Slack status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Handle the redirect back from Slack's OAuth screen.
    const params = new URLSearchParams(window.location.search);
    if (params.get('slack_connected') === 'true') {
      setSuccess('✅ Slack connected successfully!');
      load();
      window.history.replaceState({}, '', window.location.pathname);
    } else if (params.get('error') === 'slack_auth_failed') {
      setError(`Slack connection failed: ${params.get('message') || 'Authentication failed'}`);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [load]);

  const handleConnect = async () => {
    setError(''); setBusy(true);
    try {
      const res = await slackAPI.getAuthUrl();
      if (res.success && res.authUrl) {
        window.location.href = res.authUrl;
      } else {
        setError(res.error || 'Failed to start Slack connection. Check env vars are set.');
      }
    } catch {
      setError('Failed to start Slack connection.');
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm('Disconnect Slack? Reps will stop receiving Slack notifications (in-app alerts are unaffected).')) return;
    setError(''); setBusy(true);
    try {
      await slackAPI.disconnect();
      setSuccess('Slack disconnected.');
      setTimeout(() => setSuccess(''), 3000);
      await load();
      if (onConnectionChange) onConnectionChange();
    } catch {
      setError('Failed to disconnect Slack.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="sf-connect loading">Loading Slack settings…</div>;

  const isConnected = status?.connected;

  return (
    <div className="sf-connect">
      <div className="sf-connect-header">
        <h3>Slack</h3>
        {isConnected && (
          <p className="sf-connected-badge">
            ✅ Connected{status.team_name ? ` — ${status.team_name}` : ''}
          </p>
        )}
      </div>

      {error   && <div className="sf-alert sf-alert--error">{error}<button onClick={() => setError('')}>✕</button></div>}
      {success && <div className="sf-alert sf-alert--success">{success}</div>}

      <p className="sf-card-desc">
        Connect your Slack workspace so reps and their managers can receive action,
        escalation, and revisit notifications as Slack DMs. Each rep controls which
        categories they get under their own notification settings.
      </p>

      {isConnected ? (
        <button className="sf-btn sf-btn--danger" onClick={handleDisconnect} disabled={busy}>
          {busy ? '…' : 'Disconnect Slack'}
        </button>
      ) : (
        <button className="sf-btn sf-btn--primary" onClick={handleConnect} disabled={busy}>
          {busy ? '…' : 'Connect Slack'}
        </button>
      )}
    </div>
  );
}
