import React, { useEffect, useState } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// ImpersonationBanner
//
// Renders a fixed banner whenever a read-only impersonation session is active,
// and enforces auto-exit:
//   • IDLE timeout  — 30 min with no user activity → exit
//   • HARD expiry   — the impersonation JWT's own exp (30 min from mint) → exit
// Whichever fires first restores the stashed super-admin session and reloads.
//
// "Active" is derived purely from the presence of a stashed super-admin session
// under `sa_token` — no extra flag to keep in sync.
//
// Session model (set by SuperAdminView.beginImpersonation):
//   sa_token / sa_user  → the REAL super-admin session, stashed
//   token   / user      → the impersonated session, live
// ─────────────────────────────────────────────────────────────────────────────

const IDLE_MS = 30 * 60 * 1000; // 30 minutes of inactivity → auto-exit

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

// Read the `exp` (ms epoch) out of a JWT without verifying it — client-side we
// only need the timestamp to schedule the hard cut-off. Returns null if the
// token is missing/malformed or carries no exp.
function getTokenExpMs(token) {
  try {
    const part = token.split('.')[1];
    const json = JSON.parse(
      decodeURIComponent(
        atob(part.replace(/-/g, '+').replace(/_/g, '/'))
          .split('')
          .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
          .join('')
      )
    );
    return json && json.exp ? json.exp * 1000 : null;
  } catch (_) {
    return null;
  }
}

function fmt(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

export default function ImpersonationBanner() {
  const active = isImpersonating();
  const [remaining, setRemaining] = useState(null);

  useEffect(() => {
    if (!active) return undefined;

    const expMs = getTokenExpMs(localStorage.getItem('token')); // absolute cap
    let last = Date.now();                                       // idle tracker

    const bump = () => { last = Date.now(); };
    const events = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'];
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));

    // One 1s interval drives both the auto-exit checks and the countdown.
    const iv = setInterval(() => {
      const now = Date.now();

      // Hard cap: the token itself has expired (or is about to) → exit.
      if (expMs && now >= expMs) { exitImpersonation(); return; }

      // Idle cap: no activity for IDLE_MS → exit.
      const idleLeft = IDLE_MS - (now - last);
      if (idleLeft <= 0) { exitImpersonation(); return; }

      // Show whichever limit is nearer.
      const hardLeft = expMs ? expMs - now : Infinity;
      setRemaining(Math.min(idleLeft, hardLeft));
    }, 1000);

    return () => {
      clearInterval(iv);
      events.forEach((e) => window.removeEventListener(e, bump));
    };
  }, [active]);

  if (!active) return null;

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
      {remaining != null && (
        <span style={{ opacity: 0.85, fontVariantNumeric: 'tabular-nums' }}>
          ends in {fmt(remaining)}
        </span>
      )}
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
