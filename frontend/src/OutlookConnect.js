import React, { useState, useEffect, useCallback } from 'react';
import './OutlookConnect.css';
import { outlookAPI } from './apiService';

function OutlookConnect({ userId, onConnectionChange }) {
  const [isConnected, setIsConnected] = useState(false);
  const [outlookEmail, setOutlookEmail] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  const checkStatus = useCallback(async () => {
    // ✅ Safety check: Don't make request if no userId
    if (!userId) {
      console.warn('OutlookConnect: No userId provided, skipping status check');
      setIsConnected(false);
      setOutlookEmail(null);
      setIsLoading(false);
      return;
    }

    try {
      setError(null);
      const status = await outlookAPI.getStatus(userId);
      
      // ✅ Handle response gracefully
      if (status && status.success !== false) {
        setIsConnected(status.connected || false);
        setOutlookEmail(status.email || null);
      } else {
        // API returned error
        setIsConnected(false);
        setOutlookEmail(null);
      }
      
      // Notify parent component of connection change
      if (onConnectionChange) {
        onConnectionChange();
      }
    } catch (error) {
      console.error('Error checking Outlook status:', error);
      // ✅ Graceful fallback - assume not connected
      setIsConnected(false);
      setOutlookEmail(null);
      setError('Failed to check connection status');
    } finally {
      setIsLoading(false);
    }
  }, [userId, onConnectionChange]);

  useEffect(() => {
    checkStatus();
    
    // ✅ Check for OAuth callback success/error
    const params = new URLSearchParams(window.location.search);
    
    if (params.get('outlook_connected') === 'true') {
      // Success!
      setError(null);
      alert('✅ Outlook connected successfully!');
      checkStatus();
      // Clean URL
      window.history.replaceState({}, '', window.location.pathname);
    } else if (params.get('error')) {
      // OAuth error
      const errorType = params.get('error');
      const errorMessage = params.get('message');
      
      let userMessage = '❌ Failed to connect Outlook. ';
      
      if (errorType === 'no_code') {
        userMessage += 'Authorization code not received.';
      } else if (errorType === 'invalid_state') {
        userMessage += 'Invalid session state.';
      } else if (errorType === 'auth_failed') {
        userMessage += errorMessage || 'Authentication failed.';
      } else {
        userMessage += 'Please try again.';
      }
      
      setError(userMessage);
      alert(userMessage);
      
      // Clean URL
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [checkStatus]);

  const handleConnect = async () => {
    // ✅ Validate userId before attempting connection
    if (!userId) {
      setError('Unable to connect: User session not found. Please refresh and try again.');
      alert('Please refresh the page and try again.');
      return;
    }

    try {
      setError(null);
      const response = await outlookAPI.getAuthUrl(userId);
      
      if (response && response.authUrl) {
        // Redirect to Microsoft OAuth
        window.location.href = response.authUrl;
      } else {
        throw new Error('Invalid response from server');
      }
    } catch (error) {
      const errorMessage = 'Failed to connect to Outlook. Please try again.';
      setError(errorMessage);
      alert(errorMessage);
      console.error('Error connecting to Outlook:', error);
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm('Are you sure you want to disconnect Outlook?')) {
      return;
    }

    // ✅ Validate userId
    if (!userId) {
      setError('Unable to disconnect: User session not found.');
      return;
    }

    try {
      setError(null);
      await outlookAPI.disconnect(userId);
      setIsConnected(false);
      setOutlookEmail(null);
      alert('✅ Outlook disconnected successfully');
      
      // Notify parent component
      if (onConnectionChange) {
        onConnectionChange();
      }
    } catch (error) {
      const errorMessage = 'Failed to disconnect Outlook. Please try again.';
      setError(errorMessage);
      alert(errorMessage);
      console.error('Error disconnecting Outlook:', error);
    }
  };

  if (isLoading) {
    return (
      <div className="outlook-connect loading">
        <div className="spinner"></div>
        <p>Loading connection status...</p>
      </div>
    );
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
          {!isConnected && !error && (
            <p className="not-connected">Not connected</p>
          )}
        </div>
      </div>

      {/* ✅ Show error message if any */}
      {error && (
        <div className="outlook-error">
          <p>⚠️ {error}</p>
          <button onClick={checkStatus} className="btn btn-small">
            Retry
          </button>
        </div>
      )}

      {isConnected ? (
        <button 
          onClick={handleDisconnect}
          className="btn btn-danger"
          disabled={!userId}
        >
          Disconnect Outlook
        </button>
      ) : (
        <div>
          <button 
            onClick={handleConnect}
            className="btn btn-primary"
            disabled={!userId}
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
