/**
 * ProjectPeoplePanel.js
 *
 * DROP-IN LOCATION: frontend/src/ProjectPeoplePanel.js  (NEW FILE)
 *
 * The "Customer team" card, widened to every external side plus the internal
 * customer.
 *
 * ONE CARD, TWO TABLES. Contacts live in project_contacts; internal customers
 * are USERS and live in project_members with side='internal_customer'. Adding
 * either happens here, but they are never mixed in storage — an employee never
 * becomes a customer contact.
 *
 * Roles come from contact_roles (configurable per org, per side), so nothing
 * here hard-codes a role list.
 *
 * Every declaration is ordered before its first use (no-use-before-define).
 */

import React, { useState, useEffect, useCallback } from 'react';
import apiService from './apiService';

const SIDES = [
  { key: 'customer', label: 'Customer team', icon: '🏛️' },
  { key: 'vendor',   label: 'Vendors',       icon: '🔧' },
  { key: 'partner',  label: 'Partners',      icon: '🤝' },
];

const S = {
  h5:    { margin: '14px 0 6px', fontSize: 12, fontWeight: 700, color: '#374151' },
  row:   { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', fontSize: 13 },
  meta:  { fontSize: 11, color: '#6b7280' },
  btn:   { fontSize: 11, padding: '3px 9px', borderRadius: 4, border: '1px solid #d1d5db',
           background: '#fff', color: '#374151', cursor: 'pointer' },
  add:   { fontSize: 12, padding: '4px 10px', borderRadius: 4, background: '#f0f9ff',
           color: '#0369a1', border: '1px dashed #93c5fd', cursor: 'pointer' },
  inp:   { fontSize: 12, padding: '5px 8px', borderRadius: 6, border: '1px solid #d1d5db' },
  err:   { fontSize: 12, color: '#991b1b', background: '#fee2e2', padding: '5px 8px',
           borderRadius: 5, marginTop: 6 },
  empty: { fontSize: 12, color: '#9ca3af', margin: '4px 0' },
  pill:  { fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 999,
           textTransform: 'uppercase', letterSpacing: 0.3 },
};

const errText = (e, fallback) => e?.response?.data?.error?.message || fallback;

function Pill({ text, bg, fg }) {
  return <span style={{ ...S.pill, background: bg, color: fg }}>{text}</span>;
}

// ── One side's contacts ──────────────────────────────────────────────────────

function SideList({ side, people, canEdit, onRemove, onOpenContact }) {
  const meta = SIDES.find(s => s.key === side);
  if (!people.length) return null;
  return (
    <div>
      <div style={S.h5}>{meta.icon} {meta.label}</div>
      {people.map(p => (
        <div key={p.id} style={S.row}>
          <button
            onClick={() => onOpenContact && onOpenContact(p.contactId)}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                     color: '#0369a1', fontSize: 13, textAlign: 'left', fontWeight: 600 }}>
            {p.name}
          </button>
          <span style={S.meta}>
            {p.handoverRoleLabel || p.handoverRole}
            {p.accountName ? ` · ${p.accountName}` : ''}
          </span>
          {p.isPrimaryContact && <Pill text="primary" bg="#eff6ff" fg="#1d4ed8" />}
          {canEdit && (
            <button onClick={() => onRemove(p.id)} title="Remove"
              style={{ marginLeft: 'auto', background: 'none', border: 'none',
                       cursor: 'pointer', color: '#ef4444', fontSize: 12 }}>✕</button>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Internal customers (users, not contacts) ─────────────────────────────────

function InternalCustomers({ acceptors, signoff, canEdit, onRemove }) {
  if (!acceptors.length) return null;
  return (
    <div>
      <div style={S.h5}>
        🧑‍💼 Internal customer
        <span style={{ fontWeight: 400, color: '#9ca3af' }}> · signs the project off</span>
      </div>
      {acceptors.map(m => (
        <div key={m.id} style={S.row}>
          <span style={{ fontWeight: 600 }}>{m.name}</span>
          <span style={S.meta}>{m.roleName || m.customRole || 'Internal customer'}</span>
          {m.status === 'pending'  && <Pill text="awaiting approval" bg="#fef3c7" fg="#92400e" />}
          {m.status === 'rejected' && <Pill text="rejected" bg="#fee2e2" fg="#991b1b" />}
          {m.status === 'approved' && signoff?.signedOffAt && <Pill text="signed off" bg="#dcfce7" fg="#065f46" />}
          {canEdit && (
            <button onClick={() => onRemove(m.id)} title="Remove"
              style={{ marginLeft: 'auto', background: 'none', border: 'none',
                       cursor: 'pointer', color: '#ef4444', fontSize: 12 }}>✕</button>
          )}
        </div>
      ))}
      {signoff?.signedOffAt && (
        <div style={{ ...S.meta, marginTop: 4 }}>
          Accepted by {signoff.signedOffByName} on{' '}
          {new Date(signoff.signedOffAt).toLocaleDateString()}
          {signoff.note ? ` — “${signoff.note}”` : ''}
        </div>
      )}
    </div>
  );
}

// ── Add form ─────────────────────────────────────────────────────────────────

function AddPerson({ handoverId, accountId, onDone, onCancel }) {
  // Contact is the default. An internal customer is the exception, and it is a
  // different table, a different approval path and a different meaning.
  const [kind,      setKind]      = useState('contact');   // 'contact' | 'internal'
  const [side,      setSide]      = useState('customer');
  const [mode,      setMode]      = useState('existing');  // 'existing' | 'new'
  const [roles,     setRoles]     = useState([]);
  const [role,      setRole]      = useState('');
  const [contactId, setContactId] = useState('');
  const [name,      setName]      = useState('');
  const [phone,     setPhone]     = useState('');
  const [email,     setEmail]     = useState('');
  const [users,     setUsers]     = useState([]);
  const [userId,    setUserId]    = useState('');
  const [contacts,  setContacts]  = useState([]);
  const [saving,    setSaving]    = useState(false);
  const [err,       setErr]       = useState('');
  const [msg,       setMsg]       = useState('');

  useEffect(() => {
    if (kind !== 'contact') return;
    apiService.contactRoles.list(side)
      .then(r => {
        const list = r.data.roles || [];
        setRoles(list);
        setRole(list[0]?.key || 'other');
      })
      .catch(() => { setRoles([]); setRole('other'); });
  }, [kind, side]);

  useEffect(() => {
    if (kind !== 'contact' || mode !== 'existing' || !accountId) return;
    apiService.contacts.getByAccount(accountId)
      .then(r => setContacts(r.data.contacts || r.data || []))
      .catch(() => setContacts([]));
  }, [kind, mode, accountId]);

  useEffect(() => {
    if (kind !== 'internal') return;
    apiService.handovers.assignableUsers()
      .then(r => setUsers(r.data.users || []))
      .catch(() => setUsers([]));
  }, [kind]);

  const save = async () => {
    setErr(''); setMsg(''); setSaving(true);
    try {
      if (kind === 'internal') {
        if (!userId) { setErr('Pick a person.'); setSaving(false); return; }
        const r = await apiService.handovers.requestMember(handoverId, {
          userId, side: 'internal_customer',
        });
        // Always pending — naming your own acceptor is exactly what sign-off
        // exists to prevent, so the backend routes it to an admin regardless of
        // who adds them.
        setMsg(r.data.status === 'approved'
          ? 'Added as internal customer.'
          : 'Sent to an admin to approve — an internal customer is never auto-approved.');
        await onDone({ silent: true });
        setSaving(false);
        return;
      }

      if (mode === 'existing' && !contactId) { setErr('Pick a contact.'); setSaving(false); return; }
      if (mode === 'new' && !name.trim())    { setErr('Enter a name.');   setSaving(false); return; }

      const payload = mode === 'existing'
        ? { contactId, side, handoverRole: role }
        : { name: name.trim(), phone: phone.trim() || null, email: email.trim() || null, side, handoverRole: role };
      await apiService.handovers.addStakeholder(handoverId, payload);
      await onDone({});
    } catch (e) {
      setErr(errText(e, 'Could not add.'));
    } finally { setSaving(false); }
  };

  const toggle = (opts, val, set) => (
    <div style={{ display: 'inline-flex', border: '1px solid #d1d5db', borderRadius: 6, overflow: 'hidden' }}>
      {opts.map(([k, label]) => (
        <button key={k} onClick={() => set(k)} style={{
          padding: '4px 10px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
          background: val === k ? '#0369a1' : '#fff', color: val === k ? '#fff' : '#374151' }}>{label}</button>
      ))}
    </div>
  );

  return (
    <div style={{ marginTop: 10, padding: 10, background: '#f8fafc', borderRadius: 8,
                  border: '1px solid #e5e7eb', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>

      {toggle([['contact', 'Contact'], ['internal', 'Internal customer']], kind, setKind)}

      {kind === 'contact' && (
        <>
          <select value={side} onChange={e => setSide(e.target.value)} style={S.inp}>
            {SIDES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
          {toggle([['existing', 'Existing'], ['new', 'New']], mode, setMode)}
          {mode === 'existing' ? (
            <select value={contactId} onChange={e => setContactId(e.target.value)} style={{ ...S.inp, minWidth: 180 }}>
              <option value="">Select a contact…</option>
              {contacts.map(c => (
                <option key={c.id} value={c.id}>
                  {c.first_name} {c.last_name}{c.title ? ` — ${c.title}` : ''}
                </option>
              ))}
            </select>
          ) : (
            <>
              <input value={name}  onChange={e => setName(e.target.value)}  placeholder="Full name" style={{ ...S.inp, minWidth: 150 }} />
              <input value={email} onChange={e => setEmail(e.target.value)} placeholder="email (optional)" style={S.inp} />
              <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="phone (optional)" style={S.inp} />
            </>
          )}
          <select value={role} onChange={e => setRole(e.target.value)} style={S.inp}>
            {roles.map(r => <option key={r.id} value={r.key}>{r.name}</option>)}
          </select>
        </>
      )}

      {kind === 'internal' && (
        <>
          <select value={userId} onChange={e => setUserId(e.target.value)} style={{ ...S.inp, minWidth: 200 }}>
            <option value="">Who signs this project off?</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.name || `${u.first_name} ${u.last_name}`}</option>)}
          </select>
          <span style={{ ...S.meta, flexBasis: '100%' }}>
            The person the work is for — a sponsor, a department head, finance. They accept the
            project as done. Always goes to an admin to approve.
          </span>
        </>
      )}

      <button onClick={save} disabled={saving} style={{
        fontSize: 12, padding: '5px 11px', borderRadius: 4, border: 'none',
        background: '#0369a1', color: '#fff', cursor: saving ? 'default' : 'pointer' }}>
        {saving ? 'Saving…' : 'Add'}
      </button>
      <button onClick={onCancel} disabled={saving} style={S.btn}>Cancel</button>

      {err && <div style={{ ...S.err, flexBasis: '100%' }}>{err}</div>}
      {msg && <div style={{ flexBasis: '100%', fontSize: 12, color: '#065f46',
                            background: '#dcfce7', padding: '5px 8px', borderRadius: 5 }}>{msg}</div>}
    </div>
  );
}

// ── Panel ────────────────────────────────────────────────────────────────────

export default function ProjectPeoplePanel({ detail, onRefresh, onOpenContact, currentUserId }) {
  const [adding, setAdding] = useState(false);
  const [err,    setErr]    = useState('');
  const [busy,   setBusy]   = useState(false);

  const handoverId  = detail?.id;
  const stakeholders = detail?.stakeholders || [];
  const members      = detail?.projectMembers || [];
  const signoff      = detail?.signoff || null;
  const canEdit      = !!detail?.canAddContacts;

  // Internal customers are members, not contacts — different table, same card.
  const acceptors = members.filter(m => m.side === 'internal_customer'
    && !['declined', 'left'].includes(m.status));

  const refresh = useCallback(async () => { if (onRefresh) await onRefresh(); }, [onRefresh]);

  const removeContact = async (sid) => {
    setErr(''); setBusy(true);
    try { await apiService.handovers.removeStakeholder(handoverId, sid); await refresh(); }
    catch (e) { setErr(errText(e, 'Could not remove.')); }
    finally { setBusy(false); }
  };

  const removeMember = async (mid) => {
    setErr(''); setBusy(true);
    try { await apiService.handovers.removeMember(handoverId, mid); await refresh(); }
    catch (e) { setErr(errText(e, 'Could not remove.')); }
    finally { setBusy(false); }
  };

  const doSignOff = async () => {
    const note = window.prompt('Anything to note with your sign-off? (optional)') ?? null;
    setErr(''); setBusy(true);
    try { await apiService.handovers.signOff(handoverId, note); await refresh(); }
    catch (e) { setErr(errText(e, 'Could not sign off.')); }
    finally { setBusy(false); }
  };

  const revoke = async () => {
    if (!window.confirm('Withdraw your sign-off on this project?')) return;
    setErr(''); setBusy(true);
    try { await apiService.handovers.revokeSignOff(handoverId); await refresh(); }
    catch (e) { setErr(errText(e, 'Could not withdraw.')); }
    finally { setBusy(false); }
  };

  // The button only shows for a named acceptor. The service enforces the same
  // rule — an admin cannot sign on someone else's behalf, because the record
  // would then claim something untrue.
  const iAmAcceptor = !!signoff?.acceptors?.some(a => a.userId === currentUserId);
  const nobodyYet   = !stakeholders.length && !acceptors.length;

  return (
    <div>
      {nobodyYet && !adding && <p style={S.empty}>No contacts added yet.</p>}

      {SIDES.map(s => (
        <SideList key={s.key} side={s.key}
          people={stakeholders.filter(p => (p.side || 'customer') === s.key)}
          canEdit={canEdit && !busy} onRemove={removeContact} onOpenContact={onOpenContact} />
      ))}

      <InternalCustomers acceptors={acceptors} signoff={signoff}
        canEdit={canEdit && !busy} onRemove={removeMember} />

      {iAmAcceptor && (
        <div style={{ marginTop: 10 }}>
          {signoff?.signedOffAt ? (
            <button onClick={revoke} disabled={busy} style={S.btn}>Withdraw sign-off</button>
          ) : (
            <button onClick={doSignOff} disabled={busy} style={{
              fontSize: 12, padding: '5px 11px', borderRadius: 4, border: 'none',
              background: '#059669', color: '#fff', cursor: 'pointer' }}>
              ✓ Accept this project as done
            </button>
          )}
          {signoff?.mode === 'hard' && !signoff?.signedOffAt && (
            <span style={{ ...S.meta, marginLeft: 8 }}>The project cannot be completed until you do.</span>
          )}
        </div>
      )}

      {err && <div style={S.err}>{err}</div>}

      {canEdit && !adding && (
        <button onClick={() => { setAdding(true); setErr(''); }} style={{ ...S.add, marginTop: 10 }}>
          + Add contact
        </button>
      )}

      {adding && (
        <AddPerson
          handoverId={handoverId}
          accountId={detail?.accountId}
          onCancel={() => setAdding(false)}
          onDone={async ({ silent }) => { if (!silent) setAdding(false); await refresh(); }}
        />
      )}
    </div>
  );
}
