// NotificationBell.js
// Bell icon with unread badge + dropdown notification inbox.
// Placed in Sidebar.js next to existing nav icons.
//
// Polls GET /api/team-notifications every 60s for unread count.
// Click on notification → marks read + navigates to related entity.

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import api from './apiService';
import { writeHash } from './hashNav';
import './NotificationBell.css';

const DEFAULT_POLL_MS = 600_000; // 10 min default; org can override via backend (organizations.settings.notifications.bell_poll_seconds)

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
  notification_immediate: { icon: '🚨', label: 'Overdue',      color: '#dc2626' },
  notification_digest:    { icon: '📋', label: 'Daily Digest', color: '#d97706' },
  sender_token_revoked:   { icon: '⚠️', label: 'Sender disconnected', color: '#dc2626' },
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
  const [pollMs,        setPollMs]        = useState(DEFAULT_POLL_MS);
  const dropdownRef = useRef(null);   // bell wrapper (for outside-click)
  const bellRef     = useRef(null);   // the bell button (anchor for positioning)
  const panelRef    = useRef(null);   // the portaled dropdown panel
  const pollRef     = useRef(null);
  const [coords, setCoords] = useState({ top: 0, left: 0 });

  // Compute the panel position from the bell's on-screen rect. The panel is
  // portaled to <body> (so the sidebar's overflow:hidden can't clip it) and
  // positioned fixed, aligned under the bell's left edge, clamped to the
  // viewport so it never spills off either side.
  const PANEL_WIDTH = 360;
  const computePosition = useCallback(() => {
    const el = bellRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 8;
    let left = r.left;
    if (left + PANEL_WIDTH > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - PANEL_WIDTH - margin);
    }
    left = Math.max(margin, left);
    setCoords({ top: r.bottom + margin, left });
  }, []);

  // ── Fetch the org-configured poll interval (backend-only setting) ──────────
  useEffect(() => {
    let cancelled = false;
    api.get('/team-notifications/config')
      .then(res => {
        const secs = res?.data?.pollSeconds;
        if (!cancelled && Number.isFinite(secs) && secs > 0) setPollMs(secs * 1000);
      })
      .catch(() => {}); // keep the default on any failure
    return () => { cancelled = true; };
  }, []);

  // ── Fetch notifications ───────────────────────────────────────────────────
  const fetchNotifications = useCallback(async (quietly = false) => {
    if (!quietly) setLoading(true);
    try {
      const res = await api.get('/team-notifications?limit=30');
      setNotifications(res.data.notifications || []);
      setUnreadCount(res.data.unread || 0);
    } catch (err) {
      // Silently fail on poll — don't show errors for background refresh
      if (!quietly) console.error('Failed to load notifications:', err);
    } finally {
      if (!quietly) setLoading(false);
    }
  }, []);

  // ── Polling (interval is org-configurable; re-arms when pollMs loads) ──────
  useEffect(() => {
    fetchNotifications();
    pollRef.current = setInterval(() => fetchNotifications(true), pollMs);
    return () => clearInterval(pollRef.current);
  }, [fetchNotifications, pollMs]);

  // ── Close on outside click (bell wrapper OR the portaled panel) ───────────
  useEffect(() => {
    if (!open) return;
    function handleClick(e) {
      const inBell  = dropdownRef.current && dropdownRef.current.contains(e.target);
      const inPanel = panelRef.current && panelRef.current.contains(e.target);
      if (!inBell && !inPanel) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // ── Keep the portaled panel anchored to the bell on scroll / resize ───────
  useEffect(() => {
    if (!open) return;
    computePosition();
    const onMove = () => computePosition();
    window.addEventListener('scroll', onMove, true); // capture: catch nested scroll containers
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open, computePosition]);

  // ── Open dropdown: fetch fresh data ──────────────────────────────────────
  const handleOpen = () => {
    const next = !open;
    if (next) computePosition();
    setOpen(next);
    if (next) fetchNotifications();
  };

  // ── Mark a single notification read + navigate ────────────────────────────
  const handleNotifClick = async (notif) => {
    if (!notif.read_at) {
      try {
        await api.patch(`/team-notifications/${notif.id}/read`);
        setNotifications(prev =>
          prev.map(n => n.id === notif.id ? { ...n, read_at: new Date().toISOString() } : n)
        );
        setUnreadCount(c => Math.max(0, c - 1));
      } catch (err) {
        console.error('Failed to mark notification read:', err);
      }
    }

    // Navigate based on entity type. Settings/actions navigation works
    // standalone via the global 'navigate' event App.js listens for, so the
    // bell functions even when no onNavigateToAction prop is wired in.
    if (notif.entity_type === 'prospecting_sender') {
      writeHash(['settings', 'preferences']);
      window.dispatchEvent(new CustomEvent('navigate', { detail: 'settings' }));
      setOpen(false);
    } else if (notif.entity_type === 'action' && notif.entity_id) {
      if (onNavigateToAction) onNavigateToAction(notif.entity_id);
      else window.dispatchEvent(new CustomEvent('navigate', { detail: 'actions' }));
      setOpen(false);
    } else if (notif.metadata?.action_ids?.length) {
      // Digest — navigate to actions view
      if (onNavigateToAction) onNavigateToAction(null);
      else window.dispatchEvent(new CustomEvent('navigate', { detail: 'actions' }));
      setOpen(false);
    }
  };

  // ── Mark all read ─────────────────────────────────────────────────────────
  const handleMarkAllRead = async () => {
    try {
      await api.patch('/team-notifications/read', { ids: [] });
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
        ref={bellRef}
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

      {open && createPortal(
        <div
          className="nb-dropdown"
          ref={panelRef}
          style={{ position: 'fixed', top: coords.top, left: coords.left, right: 'auto' }}
        >
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
        </div>,
        document.body
      )}
    </div>
  );
}
