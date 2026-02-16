import React, { useState, useEffect, useCallback } from 'react';
import './SyncStatus.css';
import { syncAPI } from './apiService';

function SyncStatus() {
  const [syncHistory, setSyncHistory] = useState([]);
  const [isSyncing, setIsSyncing] = useState(false);

  const fetchSyncStatus = useCallback(async () => {
    try {
      const result = await syncAPI.getStatus();
      
      // ✅ FIXED: Safe access to nested data
      if (result?.success && result?.data?.lastSyncs) {
        setSyncHistory(result.data.lastSyncs);
      } else {
        setSyncHistory([]);
      }
    } catch (error) {
      console.error('Error fetching sync status:', error);
      setSyncHistory([]);
    }
  }, []);

  useEffect(() => {
    fetchSyncStatus();
  }, [fetchSyncStatus]);

  const handleManualSync = async () => {
    try {
      setIsSyncing(true);
      
      const result = await syncAPI.triggerSync();
      
      // ✅ FIXED: Check if sync succeeded before accessing data
      if (!result.success) {
        // Sync failed or disabled
        alert(`⚠️ ${result.message || 'Email sync failed'}`);
        return;
      }
      
      // ✅ FIXED: Safe access to result data with defaults
      const data = result.data || {};
      const found = data.found || 0;
      const stored = data.stored || 0;
      const skipped = data.skipped || 0;
      const failed = data.failed || 0;
      const aiJobsQueued = data.aiJobsQueued || 0;
      
      // ✅ ENHANCED: Better success message with all stats
      let message = `✅ Email sync completed!\n\n`;
      message += `📧 Found: ${found} emails\n`;
      message += `💾 Stored: ${stored}\n`;
      message += `⏭️ Skipped: ${skipped} (duplicates)\n`;
      
      if (failed > 0) {
        message += `❌ Failed: ${failed}\n`;
      }
      
      if (aiJobsQueued > 0) {
        message += `\n🤖 AI jobs queued: ${aiJobsQueued}`;
      } else if (data.aiAutoEnabled === false) {
        message += `\n💡 Tip: Click "🤖 AI Analyze" on emails for intelligent actions`;
      }
      
      alert(message);
      
      // Refresh sync history
      await fetchSyncStatus();
      
    } catch (error) {
      console.error('Error:', error);
      
      // ✅ FIXED: Better error messages
      if (error.message.includes('not connected') || error.message.includes('No tokens')) {
        alert('⚠️ Outlook not connected. Please connect your Outlook account first.');
      } else if (error.message.includes('disabled')) {
        alert('⚠️ Email sync is disabled. Please contact your administrator.');
      } else {
        alert(`❌ Sync failed: ${error.message}`);
      }
    } finally {
      setIsSyncing(false);
    }
  };

  // ✅ FIXED: Safe access with optional chaining
  const lastSync = syncHistory?.[0];
  
  const formatDate = (dateString) => {
    if (!dateString) return 'Never';
    
    try {
      const date = new Date(dateString);
      const now = new Date();
      const diffMs = now - date;
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);
      
      // Show relative time for recent syncs
      if (diffMins < 1) return 'Just now';
      if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
      if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
      if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
      
      // Show absolute date for older syncs
      return date.toLocaleDateString('en-US', { 
        month: 'short', 
        day: 'numeric',
        year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
      });
    } catch (error) {
      console.error('Date formatting error:', error);
      return 'Unknown';
    }
  };

  return (
    <div className="sync-status">
      <div className="sync-header">
        <h4>📊 Email Sync</h4>
        <button
          onClick={handleManualSync}
          disabled={isSyncing}
          className="btn btn-small btn-primary"
        >
          {isSyncing ? '⟳ Syncing...' : '🔄 Sync Emails'}
        </button>
      </div>

      {lastSync ? (
        <div className="last-sync">
          <div className={`sync-status-badge ${lastSync.status}`}>
            {lastSync.status === 'completed' ? '✓' : 
             lastSync.status === 'in_progress' ? '⟳' : 
             lastSync.status === 'failed' ? '✗' : '?'}
          </div>
          <div className="sync-details">
            <p className="sync-time">
              <strong>Last sync:</strong> {formatDate(lastSync.created_at)}
            </p>
            {lastSync.items_processed !== undefined && (
              <p className="sync-items">
                <strong>Processed:</strong> {lastSync.items_processed} emails
              </p>
            )}
            {lastSync.status === 'failed' && lastSync.error_message && (
              <p className="sync-error">
                <strong>Error:</strong> {lastSync.error_message}
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="no-sync-history">
          <p className="sync-hint">
            💡 No sync history yet. Click "Sync Emails" to get started.
          </p>
        </div>
      )}
    </div>
  );
}

export default SyncStatus;
