import React, { useState, useEffect, useCallback } from 'react';
import OutlookConnect from './OutlookConnect';
import OutlookEmailList from './OutlookEmailList';
import SyncStatus from './SyncStatus';
import { outlookAPI } from './apiService';
import './EmailView.css';

function EmailView() {
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  
  // ✅ Get user from localStorage and ensure userId is a NUMBER
  const getUserId = () => {
    try {
      const user = JSON.parse(localStorage.getItem('user'));
      console.log('📝 User from localStorage:', user);
      console.log('📝 user?.id:', user?.id);
      console.log('📝 type:', typeof user?.id);
      
      // ✅ Ensure it's a number
      const id = user?.id;
      if (id === null || id === undefined) {
        return null;
      }
      
      // Convert to number if it's a string
      const userId = typeof id === 'number' ? id : parseInt(id, 10);
      console.log('📝 Final userId:', userId, 'type:', typeof userId);
      
      return userId;
    } catch (error) {
      console.error('Error getting user from localStorage:', error);
      return null;
    }
  };

  const userId = getUserId();

  // Use useCallback to memoize the function
  const checkConnection = useCallback(async () => {
    // ✅ Don't check if no userId
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
    return <div className="email-view loading">Loading...</div>;
  }

  // ✅ Show error if no userId
  if (!userId) {
    return (
      <div className="email-view">
        <div className="email-header">
          <h2>📧 Email Management</h2>
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
      <div className="email-header">
        <h2>📧 Email Management</h2>
      </div>

      <div className="email-content">
        {/* Always show connection status - pass userId as number */}
        <OutlookConnect 
          userId={userId} 
          onConnectionChange={checkConnection}
        />

        {/* Only show emails if connected - pass userId as number */}
        {isConnected ? (
          <>
            <SyncStatus userId={userId} />
            <OutlookEmailList userId={userId} />
          </>
        ) : (
          <div className="not-connected-message">
            <p>👆 Connect your Outlook account above to view and sync emails</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default EmailView;
