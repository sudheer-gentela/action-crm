import React, { useState, useEffect, useCallback } from 'react';
import OutlookConnect from './OutlookConnect';
import OutlookEmailList from './OutlookEmailList';
import SyncStatus from './SyncStatus';
import { outlookAPI } from './apiService';
import './EmailView.css';

function EmailView() {
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  
  

  // Use useCallback to memoize the function
  const checkConnection = useCallback(async () => {
    try {
      const status = await outlookAPI.getStatus();
      setIsConnected(status.connected);
    } catch (error) {
      console.error('Error checking connection:', error);
      setIsConnected(false);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    checkConnection();
  }, [checkConnection]); // Now checkConnection is properly included

  if (isLoading) {
    return <div className="email-view loading">Loading...</div>;
  }

  return (
    <div className="email-view">
      <div className="email-header">
        <h2>📧 Email Management</h2>
      </div>

      <div className="email-content">
        {/* Always show connection status */}
        <OutlookConnect 
           
          onConnectionChange={checkConnection}
        />

        {/* Only show emails if connected */}
        {isConnected ? (
          <>
            <SyncStatus  />
            <OutlookEmailList  />
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
