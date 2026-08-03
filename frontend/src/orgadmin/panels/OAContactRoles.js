/**
 * OAContactRoles.js
 *
 * DROP-IN LOCATION: frontend/src/orgadmin/panels/OAContactRoles.js  (NEW FILE)
 * Mount it in the Org Admin panel list alongside OAProjectAccess.
 *
 * Configurable roles for EXTERNAL project people, per side.
 *
 * Deliberately separate from the internal role screen (org_roles): those roles
 * are routable — playbooks assign work to them and resolve an assignee among
 * users — and these are descriptive labels for people who are not users. Mixing
 * them would let a playbook route a play to "Vendor Technical Lead".
 *
 * Also hosts the project-closure sign-off mode, because that is the setting a
 * naming an internal customer actually turns on.
 *
 * Every declaration is ordered before its first use (no-use-before-define).
 */

import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from '../../apiService';

const SIDES = [
  { key: 'customer', label: 'Customer' },
  { key: 'vendor',   label: 'Vendor'   },
  { key: 'partner',  label: 'Partner'  },
];

const S = {
  wrap:  { padding: 4 },
  h4:    { margin: '0 0 8px', fontSize: 14, color: '#374151' },
  tab:   (on) => ({ padding: '5px 12px', fontSize: 12, fontWeight: on ? 700 : 400, border: 'none',
                    background: 'none', cursor: 'pointer', color: on ? '#0369a1' : '#6b7280',
                    borderBottom: `2px solid ${on ? '#0369a1' : 'transparent'}` }),
  row:   { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0',
           borderBottom: '1px solid #f3f4f6', fontSize: 13 },
  btn:   { fontSize: 11, padding: '3px 9px', borderRadius: 4, border: '1px solid #d1d5db',
           background: '#fff', color: '#374151', cursor: 'pointer' },
  pri:   { fontSize: 12, padding: '5px 11px', borderRadius: 5, border: 'none',
           background: '#0369a1', color: '#fff', cursor: 'pointer' },
  inp:   { fontSize: 12, padding: '5px 8px', borderRadius: 6, border: '1px solid #d1d5db' },
  meta:  { fontSize: 11, color: '#6b7280' },
  err:   { padding: '6px 9px', background: '#fee2e2', color: '#991b1b', borderRadius: 5,
           fontSize: 12, margin: '8px 0' },
  pill:  { fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 999,
           background: '#f3f4f6', color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.3 },
  card:  { border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, marginBottom: 14 },
};

const errText = (e, fallback) => e?.response?.data?.error?.message || fallback;

function SignoffMode() {
  const [mode, setMode] = useState(null);
  const [msg,  setMsg]  = useState('');

  useEffect(() => {
    apiService.handovers.projectAccess()
      .then(r => setMode(r.data?.settings?.closure_signoff_mode || 'soft'))
      .catch(() => setMode('soft'));
  }, []);

  const save = async (next) => {
    setMode(next); setMsg('');
    try {
      await apiService.handovers.setProjectAccess({ closure_signoff_mode: next });
      setMsg('Saved.');
    } catch (e) { setMsg(errText(e, 'Could not save.')); }
  };

  if (mode === null) return null;

  return (
    <div style={S.card}>
      <h4 style={S.h4}>Project sign-off</h4>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        {[['soft', 'Advisory'], ['hard', 'Required to complete']].map(([k, label]) => (
          <button key={k} onClick={() => save(k)} style={{
            ...S.btn, fontWeight: 600,
            background: mode === k ? '#0369a1' : '#fff',
            color: mode === k ? '#fff' : '#374151' }}>{label}</button>
        ))}
        {msg && <span style={{ ...S.meta, alignSelf: 'center' }}>{msg}</span>}
      </div>
      <div style={S.meta}>
        With <strong>Required</strong>, a project cannot be completed until its internal customer
        accepts it. The gate only applies once an internal customer has actually been named, so
        turning this on does not freeze projects that already exist. Only the named person can
        sign off — not an admin, and not the project manager.
      </div>
    </div>
  );
}

function RoleRow({ role, onRename, onToggle, onRemove }) {
  const [editing, setEditing] = useState(false);
  const [name,    setName]    = useState(role.name);

  return (
    <div style={{ ...S.row, opacity: role.is_active ? 1 : 0.55 }}>
      {editing ? (
        <>
          <input value={name} onChange={e => setName(e.target.value)} style={{ ...S.inp, minWidth: 180 }} />
          <button onClick={() => { onRename(role.id, name); setEditing(false); }} style={S.btn}>Save</button>
          <button onClick={() => { setName(role.name); setEditing(false); }} style={S.btn}>Cancel</button>
        </>
      ) : (
        <>
          <span style={{ flex: 1 }}>{role.name}</span>
          <span style={S.meta}>{role.key}</span>
          {role.is_system && <span style={S.pill}>built in</span>}
          {!role.is_active && <span style={S.pill}>off</span>}
          <button onClick={() => setEditing(true)} style={S.btn}>Rename</button>
          {!role.is_system && (
            <>
              <button onClick={() => onToggle(role)} style={S.btn}>
                {role.is_active ? 'Turn off' : 'Turn on'}
              </button>
              <button onClick={() => onRemove(role)} style={{ ...S.btn, color: '#991b1b' }}>Remove</button>
            </>
          )}
        </>
      )}
    </div>
  );
}

export default function OAContactRoles() {
  const [side,    setSide]    = useState('customer');
  const [roles,   setRoles]   = useState([]);
  const [newName, setNewName] = useState('');
  const [err,     setErr]     = useState('');
  const [note,    setNote]    = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const r = await apiService.contactRoles.listAll(side);
      setRoles(r.data.roles || []);
    } catch (e) { setErr(errText(e, 'Could not load roles.')); }
    finally { setLoading(false); }
  }, [side]);

  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!newName.trim()) return;
    setErr(''); setNote('');
    try {
      await apiService.contactRoles.create({ side, name: newName.trim() });
      setNewName('');
      await load();
    } catch (e) { setErr(errText(e, 'Could not add.')); }
  };

  const rename = async (id, name) => {
    setErr('');
    try { await apiService.contactRoles.update(id, { name }); await load(); }
    catch (e) { setErr(errText(e, 'Could not rename.')); }
  };

  const toggle = async (role) => {
    setErr('');
    try { await apiService.contactRoles.update(role.id, { isActive: !role.is_active }); await load(); }
    catch (e) { setErr(errText(e, 'Could not update.')); }
  };

  const remove = async (role) => {
    if (!window.confirm(`Remove "${role.name}"?\n\nIf anyone is already using it, it is switched off instead so existing records still read correctly.`)) return;
    setErr(''); setNote('');
    try {
      const r = await apiService.contactRoles.remove(role.id);
      if (r.data.deactivated) {
        setNote(`"${role.name}" is used by ${r.data.inUse} record(s), so it was switched off rather than deleted.`);
      }
      await load();
    } catch (e) { setErr(errText(e, 'Could not remove.')); }
  };

  return (
    <div style={S.wrap}>
      <SignoffMode />

      <div style={S.card}>
        <h4 style={S.h4}>Contact roles</h4>
        <div style={{ ...S.meta, marginBottom: 10 }}>
          What people outside your own team are called on a project. Separate from internal team
          roles, which can be assigned work by a playbook.
        </div>

        <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb', marginBottom: 10 }}>
          {SIDES.map(s => (
            <button key={s.key} onClick={() => setSide(s.key)} style={S.tab(side === s.key)}>{s.label}</button>
          ))}
        </div>

        {err  && <div style={S.err}>{err}</div>}
        {note && <div style={{ ...S.err, background: '#eff6ff', color: '#1e40af' }}>{note}</div>}
        {loading && <div style={S.meta}>Loading…</div>}

        {!loading && roles.map(r => (
          <RoleRow key={r.id} role={r} onRename={rename} onToggle={toggle} onRemove={remove} />
        ))}

        <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
          <input value={newName} onChange={e => setNewName(e.target.value)}
            placeholder={`New ${side} role`} style={{ ...S.inp, minWidth: 200 }} />
          <button onClick={add} style={S.pri}>Add</button>
        </div>
      </div>
    </div>
  );
}
