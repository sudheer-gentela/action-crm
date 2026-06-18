/* Extracted from OrgAdminView.js — Phase 0 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Shared helpers/formatters for OrgAdmin. */
import { STATIC_NAV_GROUPS, MODULE_NAV_DEFS, DIMENSION_COLORS } from './constants';

export const API_OA = process.env.REACT_APP_API_URL || '';

export function apiFetchOA(path, options = {}) {
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  // ...options is spread BEFORE headers so a caller passing options.headers
  // merges into (rather than replaces) the auth + content-type defaults.
  return fetch(`${API_OA}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  }).then(r => {
    if (!r.ok) return r.json().then(e => Promise.reject(new Error(e?.error?.message || r.statusText)));
    return r.json();
  });
}

export function buildNavGroups(orgModules) {
  const enabledModuleItems = MODULE_NAV_DEFS
    .filter(m => orgModules[m.moduleKey])
    .map(m => ({ id: m.navId, icon: m.icon, label: m.label }));

  // 🧩 Modules is always present — it's the only way to re-enable a disabled module.
  // Enabled modules appear as sub-items below it.
  const moduleGroup = {
    label: 'Modules',
    items: [
      { id: 'modules', icon: '🧩', label: 'Modules' },
      ...enabledModuleItems,
    ],
  };

  const groups = [...STATIC_NAV_GROUPS];
  const generalIdx = groups.findIndex(g => g.label === 'General');
  groups.splice(generalIdx, 0, moduleGroup);
  return groups;
}

export function formatTokens(n) {
  if (!n || n === 0) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000)    return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

export function formatCost(c) {
  if (!c || c === 0) return '$0.00';
  if (c < 0.01) return '<$0.01';
  return '$' + parseFloat(c).toFixed(2);
}

export function getDimColor(key) {
  return DIMENSION_COLORS[key] || '#6b7280';
}
