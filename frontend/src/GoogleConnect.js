import React, { useState, useEffect, useCallback } from 'react';
import './GoogleConnect.css';
import { googleAPI } from './apiService';

function GoogleConnect({ userId, onConnectionChange }) {
  const [isConnected, setIsConnected] = useState(false);
  const [googleEmail, setGoogleEmail] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  const getValidUserId = useCallback(() => {
    if (userId) return userId;
    try {
      const user = JSON.parse(localStorage.getItem('user'));
      return user?.id;
    } catch {
      return null;
    }
  }, [userId]);

  const effectiveUserId = getValidUserId();

  const checkStatus = useCallback(async () => {
    const currentUserId = getValidUserId();
    if (!currentUserId) {
      setIsConnected(false);
      setGoogleEmail(null);
      setIsLoading(false);
      return;
    }
    try {
      const status = await googleAPI.getStatus(currentUserId);
      setIsConnected(status.connected);
      setGoogleEmail(status.email);
      if (onConnectionChange) onConnectionChange();
    } catch {
      setIsConnected(false);
      setGoogleEmail(null);
    } finally {
      setIsLoading(false);
    }
  }, [getValidUserId, onConnectionChange]);

  useEffect(() => {
    checkStatus();
    const params = new URLSearchParams(window.location.search);
    if (params.get('google_connected') === 'true') {
      alert('✅ Google account connected successfully!');
      checkStatus();
      window.history.replaceState({}, '', window.location.pathname);
    } else if (params.get('error') === 'google_auth_failed') {
      const msg = params.get('message');
      alert(`❌ Failed to connect Google: ${msg || 'Unknown error'}`);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [checkStatus, effectiveUserId]);

  const handleConnect = async () => {
    const currentUserId = getValidUserId();
    if (!currentUserId) {
      alert('❌ Session error: Please refresh the page and try again.');
      return;
    }
    try {
      const response = await googleAPI.getAuthUrl(currentUserId);
      if (response && response.success && response.authUrl) {
        window.location.href = response.authUrl;
      } else {
        throw new Error(response.error || 'Invalid response');
      }
    } catch (error) {
      alert('❌ Failed to connect Google. Please try again.');
      console.error('Error connecting Google:', error);
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm('Are you sure you want to disconnect your Google account?')) return;
    const currentUserId = getValidUserId();
    if (!currentUserId) {
      alert('❌ Session error: Please refresh the page.');
      return;
    }
    try {
      await googleAPI.disconnect(currentUserId);
      setIsConnected(false);
      setGoogleEmail(null);
      alert('✅ Google disconnected successfully');
      if (onConnectionChange) onConnectionChange();
    } catch {
      alert('❌ Failed to disconnect Google. Please try again.');
    }
  };

  if (isLoading) return <div className="google-connect loading">Loading...</div>;

  if (!effectiveUserId) {
    return (
      <div className="google-connect">
        <div className="google-error">
          <p>⚠️ Unable to load user session. Please refresh the page.</p>
          <button onClick={() => window.location.reload()} className="btn btn-primary">Refresh Page</button>
        </div>
      </div>
    );
  }

  return (
    <div className="google-connect">
      <div className="google-header">
        <div className="google-icon">🟢</div>
        <div className="google-info">
          <h3>Google Integration</h3>
          {isConnected && googleEmail && (
            <p className="connected-email">✓ Connected as {googleEmail}</p>
          )}
        </div>
      </div>

      {isConnected ? (
        <button onClick={handleDisconnect} className="btn btn-danger">
          Disconnect Google
        </button>
      ) : (
        <div>
          <button onClick={handleConnect} className="btn btn-primary btn-google">
            Connect Google Account
          </button>
          <p className="google-description">
            Connect your Google account to sync Gmail, Google Calendar events, and browse Google Drive files.
          </p>
        </div>
      )}
    </div>
  );
}

export default GoogleConnect;
