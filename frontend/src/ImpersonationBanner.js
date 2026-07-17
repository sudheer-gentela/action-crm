import React from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// ImpersonationBanner
//
// Renders a fixed banner whenever a read-only impersonation session is active.
// "Active" is derived purely from the presence of a stashed super-admin session
// under `sa_token` — no extra flag to keep in sync.
//
// Session model (set by SuperAdminView.beginImpersonation):
//   sa_token / sa_user  → the REAL super-admin session, stashed
//   token   / user      → the impersonated session, live
//
// Exit restores the stashed super-admin session and reloads so the whole app
// re-initialises from localStorage as the super admin again.
// ─────────────────────────────────────────────────────────────────────────────

export function isImpersonating() {
  return !!localStorage.getItem('sa_token');
}

export function exitImpersonation() {
  const saToken = localStorage.getItem('sa_token');
  const saUser  = localStorage.getItem('sa_user');
  if (saToken && saUser) {
    localStorage.setItem('token', saToken);
    localStorage.setItem('user', saUser);
  }
  localStorage.removeItem('sa_token');
  localStorage.removeItem('sa_user');
  // Full reload so App re-reads the restored super-admin session cleanly.
  window.location.reload();
}

export default function ImpersonationBanner() {
  if (!isImpersonating()) return null;

  let label = 'a user';
  try {
    const u = JSON.parse(localStorage.getItem('user') || '{}');
    const name = [u.firstName, u.lastName].filter(Boolean).join(' ');
    label = name || u.email || 'a user';
  } catch (_) { /* fall back to default label */ }

  return (
    <div
      role="status"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: '8px 16px',
        background: '#7c2d12',
        color: '#fff',
        fontSize: 13,
        fontWeight: 600,
        boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
      }}
    >
      <span>
        🔒 Read-only support session — viewing as <strong>{label}</strong>. Changes are disabled.
      </span>
      <button
        onClick={exitImpersonation}
        style={{
          background: '#fff',
          color: '#7c2d12',
          border: 'none',
          borderRadius: 6,
          padding: '4px 12px',
          fontSize: 12,
          fontWeight: 700,
          cursor: 'pointer',
        }}
      >
        Exit
      </button>
    </div>
  );
}
