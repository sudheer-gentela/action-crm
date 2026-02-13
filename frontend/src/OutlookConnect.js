import React, { useState, useEffect, useCallback } from 'react';
import './OutlookConnect.css';
import { outlookAPI } from './apiService';

function OutlookConnect({ userId, onConnectionChange }) {
  const [isConnected, setIsConnected] = useState(false);
  const [outlookEmail, setOutlookEmail] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  // ✅ Get userId from localStorage if not provided via props
  const getValidUserId = useCallback(() => {
    if (userId) return userId;
    
    try {
      const user = JSON.parse(localStorage.getItem('user'));
      return user?.id;
    } catch (error) {
      console.error('Error getting user from localStorage:', error);
      return null;
    }
  }, [userId]);

  const effectiveUserId = getValidUserId();

  const checkStatus = useCallback(async () => {
    const currentUserId = getValidUserId();
    
    // ✅ Don't make request if no userId
    if (!currentUserId) {
      console.warn('⚠️  No userId available, skipping status check');
      setIsConnected(false);
      setOutlookEmail(null);
      setIsLoading(false);
      return;
    }

    try {
      const status = await outlookAPI.getStatus(currentUserId);
      setIsConnected(status.connected);
      setOutlookEmail(status.email);
      
      if (onConnectionChange) {
        onConnectionChange();
      }
    } catch (error) {
      console.error('Error checking Outlook status:', error);
      setIsConnected(false);
      setOutlookEmail(null);
    } finally {
      setIsLoading(false);
    }
  }, [getValidUserId, onConnectionChange]);

  useEffect(() => {
    checkStatus();
    
    // Check for OAuth callback success
    const params = new URLSearchParams(window.location.search);
    if (params.get('outlook_connected') === 'true') {
      alert('✅ Outlook connected successfully!');
      checkStatus();
      // Clean URL
      window.history.replaceState({}, '', window.location.pathname);
    } else if (params.get('error')) {
      const errorType = params.get('error');
      const errorMessage = params.get('message');
      alert(`❌ Failed to connect Outlook: ${errorMessage || errorType}`);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [checkStatus, effectiveUserId]);

  const handleConnect = async () => {
    const currentUserId = getValidUserId();
    
    console.log('🔍 DEBUG - userId:', currentUserId, 'type:', typeof currentUserId);
    
    // ✅ Validate userId before attempting connection
    if (!currentUserId) {
      alert('❌ Session error: Please refresh the page and try again.');
      console.error('❌ Cannot connect: userId is undefined');
      return;
    }

    try {
      const response = await outlookAPI.getAuthUrl(currentUserId);
      
      if (response && response.success && response.authUrl) {
        // Redirect to Microsoft OAuth
        window.location.href = response.authUrl;
      } else {
        throw new Error(response.error || 'Invalid response from server');
      }
    } catch (error) {
      alert('❌ Failed to connect to Outlook. Please try again.');
      console.error('Error connecting to Outlook:', error);
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm('Are you sure you want to disconnect Outlook?')) {
      return;
    }

    const currentUserId = getValidUserId();
    
    if (!currentUserId) {
      alert('❌ Session error: Please refresh the page and try again.');
      return;
    }

    try {
      await outlookAPI.disconnect(currentUserId);
      setIsConnected(false);
      setOutlookEmail(null);
      alert('✅ Outlook disconnected successfully');
      
      if (onConnectionChange) {
        onConnectionChange();
      }
    } catch (error) {
      alert('❌ Failed to disconnect Outlook. Please try again.');
      console.error('Error disconnecting Outlook:', error);
    }
  };

  if (isLoading) {
    return <div className="outlook-connect loading">Loading...</div>;
  }

  // ✅ Show message if no userId available
  if (!effectiveUserId) {
    return (
      <div className="outlook-connect">
        <div className="outlook-error">
          <p>⚠️ Unable to load user session. Please refresh the page.</p>
          <button onClick={() => window.location.reload()} className="btn btn-primary">
            Refresh Page
          </button>
        </div>
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
