// NotificationBell.js
// Bell icon with unread badge + dropdown notification inbox.
// Placed in Sidebar.js next to existing nav icons.
//
// Polls GET /api/notifications every 60s for unread count.
// Click on notification → marks read + navigates to related entity.

import React, { useState, useEffect, useRef, useCallback } from 'react';
import api from './apiService';
import './NotificationBell.css';

const POLL_INTERVAL_MS = 60_000; // 1 minute

// ── Relative time formatter ───────────────────────────────────────────────────
function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins  = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days  = Math.floor(diff / 86_400_000);
  if (mins  < 1)   return 'just now';
  if (mins  < 60)  return `${mins}m ago`;
  if (hours < 24)  return `${hours}h ago`;
  if (days  < 7)   return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// ── Notification type config ──────────────────────────────────────────────────
const TYPE_CONFIG = {
  escalation_immediate: { icon: '🚨', label: 'Overdue',      color: '#dc2626' },
  escalation_digest:    { icon: '📋', label: 'Daily Digest', color: '#d97706' },
};
function getTypeConfig(type) {
  return TYPE_CONFIG[type] || { icon: '🔔', label: 'Notification', color: '#6366f1' };
}

// ═════════════════════════════════════════════════════════════════════════════
// NotificationBell
// ═════════════════════════════════════════════════════════════════════════════

export default function NotificationBell({ onNavigateToAction }) {
  const [notifications, setNotifications] = useState([]);
  const [unreadCount,   setUnreadCount]   = useState(0);
  const [open,          setOpen]          = useState(false);
  const [loading,       setLoading]       = useState(false);
  const dropdownRef = useRef(null);
  const pollRef     = useRef(null);

  // ── Fetch notifications ───────────────────────────────────────────────────
  const fetchNotifications = useCallback(async (quietly = false) => {
    if (!quietly) setLoading(true);
    try {
      const res = await api.get('/notifications?limit=30');
      setNotifications(res.data.notifications || []);
      setUnreadCount(res.data.unread || 0);
    } catch (err) {
      // Silently fail on poll — don't show errors for background refresh
      if (!quietly) console.error('Failed to load notifications:', err);
    } finally {
      if (!quietly) setLoading(false);
    }
  }, []);

  // ── Polling ───────────────────────────────────────────────────────────────
  useEffect(() => {
    fetchNotifications();
    pollRef.current = setInterval(() => fetchNotifications(true), POLL_INTERVAL_MS);
    return () => clearInterval(pollRef.current);
  }, [fetchNotifications]);

  // ── Close on outside click ────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    function handleClick(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // ── Open dropdown: fetch fresh data ──────────────────────────────────────
  const handleOpen = () => {
    const next = !open;
    setOpen(next);
    if (next) fetchNotifications();
  };

  // ── Mark a single notification read + navigate ────────────────────────────
  const handleNotifClick = async (notif) => {
    if (!notif.read_at) {
      try {
        await api.patch(`/notifications/${notif.id}/read`);
        setNotifications(prev =>
          prev.map(n => n.id === notif.id ? { ...n, read_at: new Date().toISOString() } : n)
        );
        setUnreadCount(c => Math.max(0, c - 1));
      } catch (err) {
        console.error('Failed to mark notification read:', err);
      }
    }

    // Navigate to entity if it's an action
    if (notif.entity_type === 'action' && notif.entity_id && onNavigateToAction) {
      onNavigateToAction(notif.entity_id);
      setOpen(false);
    } else if (notif.metadata?.action_ids?.length && onNavigateToAction) {
      // Digest — navigate to actions view
      onNavigateToAction(null);
      setOpen(false);
    }
  };

  // ── Mark all read ─────────────────────────────────────────────────────────
  const handleMarkAllRead = async () => {
    try {
      await api.patch('/notifications/read', { ids: [] });
      setNotifications(prev => prev.map(n => ({ ...n, read_at: n.read_at || new Date().toISOString() })));
      setUnreadCount(0);
    } catch (err) {
      console.error('Failed to mark all read:', err);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="nb-wrapper" ref={dropdownRef}>
      <button
        className={`nb-bell ${open ? 'nb-bell--active' : ''}`}
        onClick={handleOpen}
        title="Notifications"
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
      >
        <span className="nb-bell-icon">🔔</span>
        {unreadCount > 0 && (
          <span className="nb-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
        )}
      </button>

      {open && (
        <div className="nb-dropdown">
          {/* Header */}
          <div className="nb-dropdown-header">
            <span className="nb-dropdown-title">Notifications</span>
            {unreadCount > 0 && (
              <button className="nb-mark-all-read" onClick={handleMarkAllRead}>
                Mark all read
              </button>
            )}
          </div>

          {/* Body */}
          <div className="nb-dropdown-body">
            {loading ? (
              <div className="nb-empty">
                <div className="nb-spinner" />
              </div>
            ) : notifications.length === 0 ? (
              <div className="nb-empty">
                <span className="nb-empty-icon">🔔</span>
                <p>All caught up!</p>
              </div>
            ) : (
              notifications.map(notif => {
                const tc = getTypeConfig(notif.type);
                return (
                  <div
                    key={notif.id}
                    className={`nb-item ${notif.read_at ? 'nb-item--read' : 'nb-item--unread'}`}
                    onClick={() => handleNotifClick(notif)}
                  >
                    <div className="nb-item-icon" style={{ color: tc.color }}>{tc.icon}</div>
                    <div className="nb-item-content">
                      <div className="nb-item-title">{notif.title}</div>
                      {notif.body && (
                        <div className="nb-item-body">{notif.body}</div>
                      )}
                      <div className="nb-item-meta">
                        <span className="nb-item-type" style={{ color: tc.color }}>{tc.label}</span>
                        <span className="nb-item-time">{timeAgo(notif.created_at)}</span>
                      </div>
                    </div>
                    {!notif.read_at && <div className="nb-unread-dot" />}
                  </div>
                );
              })
            )}
          </div>

          {/* Footer */}
          {notifications.length > 0 && (
            <div className="nb-dropdown-footer">
              {unreadCount > 0
                ? `${unreadCount} unread notification${unreadCount > 1 ? 's' : ''}`
                : 'No new notifications'
              }
            </div>
          )}
        </div>
      )}
    </div>
  );
}
