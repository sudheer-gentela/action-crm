// prospectingShared.js — shared helpers, constants, and context for the
// Prospecting feature. Extracted verbatim from ProspectingView.js during the
// 2026 module split — NO behavior changes. apiFetch (with token-refresh retry)
// is intentionally kept here rather than switching to apiService.js, which has
// no refresh logic and a different base URL.

import { createContext, useContext } from 'react';


// Fallback stages used while loading or if API fails
export const DEFAULT_PROSPECT_STAGES = [
  { key: 'target',        label: 'Target',               icon: '🎯', color: '#6b7280' },
  { key: 'research',      label: 'Research',             icon: '🔍', color: '#8b5cf6' },
  { key: 'outreach',      label: 'Outreach',             icon: '📤', color: '#3b82f6' },
  { key: 'engaged',       label: 'Engaged',              icon: '💬', color: '#0F9D8E' },
  { key: 'discovery_call',label: 'Sales Discovery Call', icon: '📞', color: '#f59e0b' },
  { key: 'qualified_sal', label: 'Sales Accepted Lead (SAL)', icon: '✅', color: '#10b981' },
];

export const DEFAULT_TERMINAL_STAGES = [
  { key: 'converted',    label: 'Converted',    icon: '🎉', color: '#059669' },
  { key: 'disqualified', label: 'Disqualified', icon: '❌', color: '#ef4444' },
  { key: 'nurture',      label: 'Nurture',      icon: '🌱', color: '#f59e0b' },
];

export const STAGE_ICONS = {
  targeting: '🎯', research: '🔍', outreach: '📤', engagement: '💬',
  qualification: '✅', converted: '🎉', disqualified: '❌', nurture: '🌱', custom: '⚙️',
};

// ── Stages Context — avoids prop-drilling stages through every child ────────
export const StagesContext = createContext({
  prospectStages: DEFAULT_PROSPECT_STAGES,
  terminalStages: DEFAULT_TERMINAL_STAGES,
  allStages: [...DEFAULT_PROSPECT_STAGES, ...DEFAULT_TERMINAL_STAGES],
});
export const useStages = () => useContext(StagesContext);

export const CHANNEL_ICONS = {
  email:    '✉️',
  linkedin: '🔗',
  phone:    '📞',
  sms:      '💬',
  whatsapp: '📱',
};

export const TEAL = '#0F9D8E';

// ── LinkedIn constants ───────────────────────────────────────────────────────

// Canonical LinkedIn event/status vocabulary. These keys MUST match the
// backend exactly — both the `connection_status` pointer written to
// prospects.channel_data.linkedin AND the `event` values accepted by
// POST /prospects/:id/linkedin-event (VALID_EVENTS in prospects.routes.js).
// Earlier these used short aliases (request_sent / connected / replied),
// which caused the Connected button to 400 and broke status dots/labels.
export const LI_EVENTS = [
  { key: 'connection_request_sent', label: 'Request Sent',   color: '#2563eb', bg: '#eff6ff', dot: '#2563eb' },
  { key: 'connection_accepted',     label: 'Connected',      color: '#059669', bg: '#ecfdf5', dot: '#059669' },
  { key: 'message_sent',            label: 'Message Sent',   color: '#d97706', bg: '#fffbeb', dot: '#d97706' },
  { key: 'reply_received',          label: 'Reply Received', color: '#0F9D8E', bg: '#f0fdfa', dot: '#0F9D8E' },
];

export const LI_STATUS_LABELS = {
  connection_request_sent: 'Request sent',
  connection_accepted:     'Connected',
  message_sent:            'Messaged',
  reply_received:          'Replied',
  meeting_booked:          'Meeting booked',
};

export function getLiStatus(prospect) {
  return prospect?.channel_data?.linkedin?.connection_status || null;
}

export function getLiDotColor(status) {
  const ev = LI_EVENTS.find(e => e.key === status);
  return ev ? ev.dot : '#d1d5db';
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export const API = process.env.REACT_APP_API_URL || '';


let _refreshPromise = null;

async function _refreshToken() {
  if (_refreshPromise) return _refreshPromise;
  _refreshPromise = fetch(`${API}/auth/refresh`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('token') || localStorage.getItem('authToken')}`,
    },
  }).then(async r => {
    if (!r.ok) throw new Error('refresh_failed');
    const { token } = await r.json();
    localStorage.setItem('token', token);
    return token;
  }).finally(() => { _refreshPromise = null; });
  return _refreshPromise;
}

export function apiFetch(path, options = {}, _isRetry = false) {
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  return fetch(`${API}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  }).then(async r => {
    if (r.ok) return r.json();
    let errBody = {};
    try { errBody = await r.json(); } catch (_) {}
    const errMsg = errBody?.error?.message || r.statusText;
    if (r.status === 403 && errMsg === 'Invalid or expired token' && !_isRetry) {
      try {
        await _refreshToken();
        return apiFetch(path, options, true);
      } catch {
        localStorage.removeItem('token');
        localStorage.removeItem('authToken');
        localStorage.removeItem('user');
        window.location.href = '/login';
        return new Promise(() => {});
      }
    }
    const err = new Error(errMsg);
    err.status = r.status;
    return Promise.reject(err);
  });
}

/**
 * Authenticated CSV download. apiFetch always JSON-parses, so it can't be
 * used for file responses — this fetches with the bearer token, reads the
 * body as text, and triggers a client-side download via a Blob URL.
 * `path` is an API path like '/prospects/export.csv?campaignId=12'.
 */
export async function downloadCsv(path, filename = 'export.csv') {
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  const r = await fetch(`${API}${path}`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json())?.error?.message || msg; } catch (_) {}
    throw new Error(msg);
  }
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function timeAgo(d) {
  if (!d) return '';
  const diff = Date.now() - new Date(d).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function stripHtml(str) {
  if (!str) return '';
  return str.replace(/(<([^>]+)>)/gi, '');
}

// ── ProspectingView ──────────────────────────────────────────────────────────

// Read the gowarm_debug flag from localStorage. Returns true if set to
// '1' or 'true', else false. Used by ProspectingView (for the keyboard
// shortcut + toast) and ProspectDetailPanel (for the IDs strip). Both
// stay in sync via the 'gowarm-debug-changed' custom event.
export function readDebugFlag() {
  try {
    const v = window.localStorage?.getItem('gowarm_debug');
    return v === '1' || v === 'true';
  } catch (_) { return false; }
}


