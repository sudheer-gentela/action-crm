// ─────────────────────────────────────────────────────────────────────────────
// AcceptInvite.js
//
// DROP-IN LOCATION: frontend/src/AcceptInvite.js
//
// Public (unauthenticated) page reached at #/accept-invite?token=… . Previews the
// invitation, then lets the invitee set their name + password to join. Uses the
// public /api/invitations endpoints (no auth token needed).
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect } from 'react';

const API = process.env.REACT_APP_API_URL || 'http://localhost:3001/api';

export default function AcceptInvite({ token }) {
  const [state, setState]   = useState('loading');   // loading | form | done | error
  const [preview, setPreview] = useState(null);
  const [err, setErr]       = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName]   = useState('');
  const [password, setPassword]   = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch(`${API}/invitations/${token}`)
      .then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d?.error?.message || 'Invalid invitation'); return d; })
      .then(d => { setPreview(d); setState('form'); })
      .catch(e => { setErr(e.message); setState('error'); });
  }, [token]);

  const submit = async () => {
    setErr('');
    if (password.length < 8) { setErr('Password must be at least 8 characters.'); return; }
    setSubmitting(true);
    try {
      const r = await fetch(`${API}/invitations/${token}/accept`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName, lastName, password }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error?.message || 'Could not accept the invitation');
      setState('done');
    } catch (e) { setErr(e.message); }
    finally { setSubmitting(false); }
  };

  const wrap = { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f8fafc' };
  const card = { width: 400, maxWidth: '90vw', background: '#fff', borderRadius: 12, padding: 28, boxShadow: '0 4px 24px rgba(0,0,0,0.08)' };
  const input = { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, boxSizing: 'border-box', marginBottom: 12 };

  return (
    <div style={wrap}>
      <div style={card}>
        <h2 style={{ margin: '0 0 4px', fontSize: 22 }}>GoWarmCRM</h2>

        {state === 'loading' && <p style={{ color: '#6b7280' }}>Checking your invitation…</p>}

        {state === 'error' && (
          <>
            <p style={{ color: '#991b1b', fontSize: 14 }}>{err}</p>
            <a href="/#/login" style={{ fontSize: 13, color: '#1d4ed8' }}>Go to sign in</a>
          </>
        )}

        {state === 'form' && preview && (
          <>
            <p style={{ color: '#374151', fontSize: 14, marginTop: 0 }}>
              You've been invited to join <b>{preview.orgName}</b> as <b>{preview.email}</b>. Set your details to continue.
            </p>
            <label style={{ fontSize: 12, color: '#6b7280' }}>First name</label>
            <input style={input} value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="First name" />
            <label style={{ fontSize: 12, color: '#6b7280' }}>Last name</label>
            <input style={input} value={lastName} onChange={e => setLastName(e.target.value)} placeholder="Last name" />
            <label style={{ fontSize: 12, color: '#6b7280' }}>Password</label>
            <input style={input} type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 8 characters" />
            {err && <div style={{ color: '#991b1b', fontSize: 12, marginBottom: 10 }}>{err}</div>}
            <button onClick={submit} disabled={submitting} style={{
              width: '100%', padding: '11px', borderRadius: 8, border: 'none',
              background: submitting ? '#9ca3af' : '#059669', color: '#fff', fontSize: 14, fontWeight: 600,
              cursor: submitting ? 'default' : 'pointer' }}>
              {submitting ? 'Joining…' : 'Accept & join'}
            </button>
          </>
        )}

        {state === 'done' && (
          <>
            <p style={{ color: '#065f46', fontSize: 15 }}>✓ You're in! Your account is ready.</p>
            <a href="/#/login" style={{ display: 'inline-block', marginTop: 8, padding: '10px 18px', borderRadius: 8, background: '#059669', color: '#fff', textDecoration: 'none', fontSize: 14, fontWeight: 600 }}>Sign in</a>
          </>
        )}
      </div>
    </div>
  );
}
