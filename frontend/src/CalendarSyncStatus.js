import React, { useState, useEffect } from 'react';
import './CalendarSyncStatus.css';

function CalendarSyncStatus({ userId }) {
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState(null);

  useEffect(() => {
    if (userId) {
      fetchSyncStatus();
    }
  }, [userId]);

  const fetchSyncStatus = async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(
        `${process.env.REACT_APP_API_URL || 'http://localhost:3001/api'}/calendar/sync/status`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.ok) {
        const result = await response.json();
        if (result.success && result.data.lastSyncs && result.data.lastSyncs.length > 0) {
          setLastSync(result.data.lastSyncs[0]);
        }
      }
    } catch (error) {
      console.error('Error fetching calendar sync status:', error);
    }
  };

  const handleSync = async () => {
    try {
      setSyncing(true);

      const token = localStorage.getItem('token');
      const response = await fetch(
        `${process.env.REACT_APP_API_URL || 'http://localhost:3001/api'}/calendar/sync`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            // Sync next 60 days by default
            startDate: new Date().toISOString(),
            endDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString()
          })
        }
      );

      const result = await response.json();

      if (!result.success) {
        alert(`⚠️ ${result.message || 'Calendar sync failed'}`);
        return;
      }

      const data = result.data || {};
      const found = data.found || 0;
      const stored = data.stored || 0;
      const skipped = data.skipped || 0;
      const failed = data.failed || 0;

      let message = `✅ Calendar sync completed!\n\n`;
      message += `📅 Found: ${found} events\n`;
      message += `💾 Stored: ${stored}\n`;
      message += `⏭️ Skipped: ${skipped} (already synced)\n`;
      
      if (failed > 0) {
        message += `❌ Failed: ${failed}\n`;
      }

      alert(message);

      // Refresh status and reload calendar
      await fetchSyncStatus();
      
      // Trigger parent refresh
      if (window.location.reload) {
        window.location.reload();
      }

    } catch (error) {
      console.error('Error:', error);
      
      if (error.message.includes('not connected')) {
        alert('⚠️ Outlook not connected. Please connect your Outlook account in the Emails tab first.');
      } else {
        alert(`❌ Sync failed: ${error.message}`);
      }
    } finally {
      setSyncing(false);
    }
  };

  const formatDate = (dateString) => {
    if (!dateString) return 'Never';
    
    try {
      const date = new Date(dateString);
      const now = new Date();
      const diffMs = now - date;
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);
      
      if (diffMins < 1) return 'Just now';
      if (diffMins < 60) return `${diffMins} min${diffMins > 1 ? 's' : ''} ago`;
      if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
      if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
      
      return date.toLocaleDateString('en-US', { 
        month: 'short', 
        day: 'numeric'
      });
    } catch (error) {
      return 'Unknown';
    }
  };

  return (
    <div className="calendar-sync-status">
      <button
        onClick={handleSync}
        disabled={syncing}
        className="btn btn-small btn-primary"
        title="Sync Outlook Calendar events"
      >
        {syncing ? '⟳ Syncing...' : '🔄 Sync Calendar'}
      </button>

      {lastSync && (
        <div className="sync-info">
          <span className="sync-label">Last sync:</span>
          <span className="sync-time">{formatDate(lastSync.created_at)}</span>
          {lastSync.items_processed !== undefined && (
            <span className="sync-count">
              ({lastSync.items_processed} events)
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default CalendarSyncStatus;
