import React, { useState, useEffect } from 'react';
import './OutlookConnect.css';
import { outlookAPI } from './apiService';

function OutlookConnect({ userId }) {
  const [isConnected, setIsConnected] = useState(false);
  const [outlookEmail, setOutlookEmail] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    checkStatus();
    
    // Check for OAuth callback success
    const params = new URLSearchParams(window.location.search);
    if (params.get('outlook_connected') === 'true') {
      alert('Outlook connected successfully!');
      checkStatus();
      // Clean URL
      window.history.replaceState({}, '', '/');
    }
  }, [userId]);

  const checkStatus = async () => {
    try {
      const status = await outlookAPI.getStatus(userId);
      setIsConnected(status.connected);
      setOutlookEmail(status.email);
    } catch (error) {
      console.error('Error checking Outlook status:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleConnect = async () => {
    try {
      const response = await outlookAPI.getAuthUrl(userId);
      window.location.href = response.authUrl;
    } catch (error) {
      alert('Failed to connect to Outlook');
      console.error('Error:', error);
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm('Are you sure you want to disconnect Outlook?')) return;

    try {
      await outlookAPI.disconnect(userId);
      setIsConnected(false);
      setOutlookEmail(null);
      alert('Outlook disconnected');
    } catch (error) {
      alert('Failed to disconnect Outlook');
      console.error('Error:', error);
    }
  };

  if (isLoading) {
    return <div className="outlook-connect loading">Loading...</div>;
  }

  return (
    <div className="outlook-connect">
      <div className="outlook-header">
        <div className="outlook-icon">📧</div>
        <div className="outlook-info">
          <h3>Outlook Integration</h3>
          {isConnected && outlookEmail && (
            <p className="connected-email">✓ Connected as {outlookEmail}</p>
          )}
        </div>
      </div>

      {isConnected ? (
        <button 
          onClick={handleDisconnect}
          className="btn btn-danger"
        >
          Disconnect Outlook
        </button>
      ) : (
        <div>
          <button 
            onClick={handleConnect}
            className="btn btn-primary"
          >
            Connect Outlook
          </button>
          <p className="outlook-description">
            Connect your Outlook account to automatically sync emails and create actions from your inbox.
          </p>
        </div>
      )}
    </div>
  );
}

export default OutlookConnect;
