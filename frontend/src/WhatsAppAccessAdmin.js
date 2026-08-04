/*
 * WhatsAppAccessAdmin.js
 *
 * Org Admin → the three things that decide who can see captured WhatsApp
 * messages. Mount alongside WhatsAppSessionConnect and WhatsAppSessionTriage.
 *
 *   IDENTITIES        which WhatsApp number belongs to which user
 *   STEWARDS          who can triage the org-wide unassigned queue
 *   CAPTURE REQUESTS  users asking for a group to start being captured
 *
 * WHY IDENTITIES ARE ADMIN-ONLY
 *   users.whatsapp_phone is not a profile field — it is the join key that
 *   decides which WhatsApp groups a person can read. If people could set their
 *   own, anyone could enter a colleague's number and inherit that colleague's
 *   group access, including client groups they were never in. A human who
 *   knows the team confirms it instead.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';

const CARD    = { border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', padding: 16, marginBottom: 16 };
const BTN     = { padding: '6px 12px', borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: 'pointer', border: '1px solid transparent' };
const PRIMARY = { ...BTN, background: '#E8630A', color: '#fff' };
const GHOST   = { ...BTN, background: '#fff', color: '#374151', border: '1px solid #d1d5db' };
const DANGER  = { ...BTN, background: '#fff', color: '#991b1b', border: '1px solid #fecaca' };
const INPUT   = { padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' };

export default function WhatsAppAccessAdmin() {
  const [users,     setUsers]     = useState([]);
  const [stewards,  setStewards]  = useState(null);
  const [requests,  setRequests]  = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [busy,      setBusy]      = useState(false);
  const [error,     setError]     = useState('');
  const [notice,    setNotice]    = useState('');
  const [editing,   setEditing]   = useState(null);
  const [phone,     setPhone]     = useState('');

  const load = useCallback(async () => {
    try {
      const [u, s, r] = await Promise.all([
        apiService.whatsappMessages.identities().catch(() => ({ data: { users: [] } })),
        apiService.whatsappMessages.stewards().catch(() => ({ data: null })),
        apiService.whatsappMessages.captureRequests('pending').catch(() => ({ data: { requests: [] } })),
      ]);
      setUsers(u.data?.users || []);
      setStewards(s.data);
      setRequests(r.data?.requests || []);
    } catch (e) {
      setError(e?.response?.data?.error?.message || 'Could not load access settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const run = async (fn, ok) => {
    setError(''); setNotice(''); setBusy(true);
    try {
      const r = await fn();
      setNotice(typeof ok === 'function' ? ok(r) : ok);
      setEditing(null); setPhone('');
      await load();
    } catch (e) {
      setError(e?.response?.data?.error || e?.response?.data?.error?.message || e.message);
    } finally {
      setBusy(false);
    }
  };

  const saveIdentity = (u) => run(
    () => apiService.whatsappMessages.setIdentity(u.id, { phone }),
    (r) => r.data?.cleared
      ? 'Number cleared. That user can no longer search captured groups.'
      : `Number confirmed${r.data?.linkedParticipantRows ? ` and linked to ${r.data.linkedParticipantRows} group membership${r.data.linkedParticipantRows === 1 ? '' : 's'}` : ''}.`
  );

  const stewardIds = new Set((stewards?.explicit || []).map(s => s.user_id));
  const implicitIds = new Set((stewards?.implicit || []).map(s => s.user_id));

  if (loading) return <div style={{ padding: 16, color: '#6b7280', fontSize: 13 }}>Loading access settings…</div>;

  return (
    <div style={{ maxWidth: 760 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 600, color: '#1a202c' }}>
        WhatsApp access
      </h3>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: '#6b7280', lineHeight: 1.5 }}>
        Who can see captured messages, and which groups get captured at all.
      </p>

      {error  && <Banner tone="error">{error}</Banner>}
      {notice && <Banner tone="ok">{notice}</Banner>}

      {/* ── Capture requests ─────────────────────────────────────────────── */}
      {requests.length > 0 && (
        <div style={{ ...CARD, borderColor: '#fde68a', background: '#fffbeb' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#92400e', marginBottom: 4 }}>
            {requests.length} capture request{requests.length === 1 ? '' : 's'} waiting
          </div>
          <p style={{ fontSize: 12, color: '#92400e', margin: '0 0 12px', lineHeight: 1.5 }}>
            Approving stores every future message in that group. It is a retention decision about a
            room full of people, not just the person asking.
          </p>
          {requests.map(r => (
            <div key={r.id} style={{ background: '#fff', border: '1px solid #fde68a', borderRadius: 6, padding: 12, marginBottom: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: '#1a202c' }}>{r.subject || '(no name)'}</div>
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                {r.participant_count != null && `${r.participant_count} participants · `}
                asked by {r.first_name} {r.last_name}
                {r.suggested_project && ` · suggested project: ${r.suggested_project}`}
              </div>
              {r.reason && <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6, fontStyle: 'italic' }}>{r.reason}</div>}
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button style={{ ...PRIMARY, fontSize: 12, padding: '4px 10px' }} disabled={busy}
                  onClick={() => run(() => apiService.whatsappMessages.decideRequest(r.id, { approve: true }), 'Capture switched on for that group.')}>
                  Approve
                </button>
                <button style={{ ...GHOST, fontSize: 12, padding: '4px 10px' }} disabled={busy}
                  onClick={() => run(() => apiService.whatsappMessages.decideRequest(r.id, { approve: false }), 'Request declined.')}>
                  Decline
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Stewards ─────────────────────────────────────────────────────── */}
      <div style={CARD}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#1a202c', marginBottom: 4 }}>
          Communications stewards
        </div>
        <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 12px', lineHeight: 1.5 }}>
          Can triage messages nobody else can reach — from groups where no team member is a
          participant. A steward may <strong>route</strong> an unassigned message to a project;
          they cannot <strong>read</strong> messages already filed to projects they are not on.
        </p>

        {stewards?.warning && <Banner tone="warn">{stewards.warning}</Banner>}

        {(stewards?.implicit || []).length > 0 && (
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
            Org admins hold this implicitly: {stewards.implicit.map(u => `${u.first_name} ${u.last_name}`).join(', ')}
          </div>
        )}

        {(stewards?.explicit || []).map(s => (
          <Row key={s.id}>
            <span style={{ fontSize: 13 }}>{s.first_name} {s.last_name}
              <span style={{ color: '#9ca3af', fontSize: 11, marginLeft: 6 }}>{s.email}</span>
            </span>
            <button style={{ ...DANGER, fontSize: 12, padding: '3px 9px', marginLeft: 'auto' }} disabled={busy}
              onClick={() => run(() => apiService.whatsappMessages.revokeSteward(s.user_id), 'Steward access revoked.')}>
              Revoke
            </button>
          </Row>
        ))}

        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <select style={{ ...INPUT, flex: 1 }} defaultValue="" id="steward-pick">
            <option value="">Grant to…</option>
            {users.filter(u => !stewardIds.has(u.id) && !implicitIds.has(u.id)).map(u => (
              <option key={u.id} value={u.id}>{u.first_name} {u.last_name}</option>
            ))}
          </select>
          <button style={GHOST} disabled={busy} onClick={() => {
            const v = document.getElementById('steward-pick').value;
            if (!v) { setError('Pick a user first.'); return; }
            run(() => apiService.whatsappMessages.grantSteward({ userId: Number(v) }), 'Steward access granted.');
          }}>Grant</button>
        </div>
      </div>

      {/* ── Identities ───────────────────────────────────────────────────── */}
      <div style={CARD}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#1a202c', marginBottom: 4 }}>
          WhatsApp numbers
        </div>
        <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 12px', lineHeight: 1.5 }}>
          Confirming a number lets that person search messages from the groups they are in — nothing
          more, and nothing they cannot already read on their phone. Only set a number you know
          belongs to them: it is what grants the access.
        </p>

        {users.map(u => (
          <Row key={u.id}>
            <span style={{ fontSize: 13, minWidth: 160 }}>{u.first_name} {u.last_name}</span>

            {editing === u.id ? (
              <>
                <input
                  style={{ ...INPUT, width: 190 }}
                  placeholder="e.g. 919876543210"
                  value={phone}
                  onChange={e => setPhone(e.target.value)}
                  autoFocus
                />
                <button style={{ ...PRIMARY, fontSize: 12, padding: '4px 10px' }} disabled={busy}
                  onClick={() => saveIdentity(u)}>Save</button>
                <button style={{ ...GHOST, fontSize: 12, padding: '4px 10px' }}
                  onClick={() => { setEditing(null); setPhone(''); }}>Cancel</button>
              </>
            ) : (
              <>
                <span style={{ fontSize: 13, color: u.whatsapp_phone ? '#374151' : '#9ca3af' }}>
                  {u.whatsapp_phone ? `+${u.whatsapp_phone}` : 'not set'}
                </span>
                {u.whatsapp_phone && (
                  <span style={{
                    fontSize: 11, padding: '2px 7px', borderRadius: 10,
                    background: u.verified ? '#ecfdf5' : '#fffbeb',
                    color:      u.verified ? '#065f46' : '#92400e',
                  }}>
                    {u.verified
                      ? `confirmed · ${u.captured_group_count} captured group${u.captured_group_count === 1 ? '' : 's'}`
                      : 'unconfirmed — grants nothing'}
                  </span>
                )}
                <button style={{ ...GHOST, fontSize: 12, padding: '3px 9px', marginLeft: 'auto' }}
                  onClick={() => { setEditing(u.id); setPhone(u.whatsapp_phone || ''); setError(''); }}>
                  {u.whatsapp_phone ? 'Change' : 'Set'}
                </button>
              </>
            )}
          </Row>
        ))}

        <p style={{ fontSize: 11, color: '#9ca3af', marginTop: 10, lineHeight: 1.6 }}>
          Numbers already present before this feature are marked unconfirmed and grant no access
          until re-set here — they were entered when the field only decided where to send a
          notification, so trusting them silently would hand out group access nobody checked.
        </p>
      </div>
    </div>
  );
}

function Row({ children }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '8px 0', borderBottom: '1px solid #f3f4f6',
    }}>{children}</div>
  );
}

function Banner({ tone, children }) {
  const map = {
    error: { background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b' },
    warn:  { background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e' },
    ok:    { background: '#ecfdf5', border: '1px solid #a7f3d0', color: '#065f46' },
  };
  return <div style={{ ...(map[tone] || map.warn), marginBottom: 12, padding: '8px 12px', borderRadius: 6, fontSize: 13, lineHeight: 1.5 }}>{children}</div>;
}
