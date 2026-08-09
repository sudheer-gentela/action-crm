/**
 * VendorsView.js
 *
 * DROP-IN LOCATION: frontend/src/VendorsView.js  (REPLACES EXISTING)
 *
 * Vendors and partners. They ARE accounts carrying a relationship, so this is
 * the account shape with one join behind it — not a parallel entity with its
 * own contact management.
 *
 * An account can hold several relationships at once and still be a customer.
 * accounts.account_type is untouched by anything here: that is sales lifecycle
 * and drives the churn and target plays. In particular 'churned' on an account
 * means the CUSTOMER relationship ended; it says nothing about whether they are
 * still a vendor, which is why an ended relationship reads "former vendor" and
 * never "churned".
 *
 * Approval is ONCE, org-wide, per relationship — not per project — and only a
 * named approver (finance) or an admin can give it.
 *
 * This screen lives inside the Projects module, so it is only reachable when
 * that module is on. Anyone with the module reads it; only an approver can act.
 *
 * Expanding a row shows the PER-PROJECT side, which the account record cannot:
 * a firm is commonly a vendor on one engagement and a partner on the next. That
 * list is scoped server-side to projects the viewer may see.
 *
 * Every declaration is ordered before its first use (no-use-before-define).
 */

import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';

const KINDS = [
  { key: 'vendor',  label: 'Vendors',  fetch: (st) => apiService.accountRelationships.vendors(st) },
  { key: 'partner', label: 'Partners', fetch: (st) => apiService.accountRelationships.partners(st) },
];

// 'Former' maps to status=ended. The API takes the value straight through, so
// no backend change. 'All' stays last as the catch-all — it is the only place a
// rejected request shows, which is right: a rejection is not history worth
// browsing.
const STATUSES = [
  { key: 'active',  label: 'Active'  },
  { key: 'pending', label: 'Pending' },
  { key: 'ended',   label: 'Former'  },
  { key: 'all',     label: 'All'     },
];

const SIDE_LABEL = { vendor: 'vendor', partner: 'partner', customer: 'customer' };

const PROJECT_STATUS_LABEL = {
  draft: 'draft', submitted: 'submitted', acknowledged: 'acknowledged',
  in_progress: 'in flight', completed: 'closed', cancelled: 'cancelled',
};

const S = {
  page:  { padding: '16px 20px' },
  head:  { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' },
  h3:    { margin: 0, fontSize: 18, color: '#111827' },
  tab:   (on) => ({ padding: '6px 14px', fontSize: 13, fontWeight: on ? 700 : 400, border: 'none',
                    background: 'none', cursor: 'pointer', color: on ? '#0369a1' : '#6b7280',
                    borderBottom: `2px solid ${on ? '#0369a1' : 'transparent'}` }),
  btn:   { fontSize: 12, padding: '5px 11px', borderRadius: 5, border: '1px solid #d1d5db',
           background: '#fff', color: '#374151', cursor: 'pointer' },
  pri:   { fontSize: 12, padding: '5px 11px', borderRadius: 5, border: 'none',
           background: '#0369a1', color: '#fff', cursor: 'pointer' },
  card:  { border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, marginBottom: 8, background: '#fff' },
  meta:  { fontSize: 11, color: '#6b7280', display: 'flex', gap: 8, flexWrap: 'wrap' },
  pill:  (bg, fg) => ({ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 999,
                        background: bg, color: fg, textTransform: 'uppercase', letterSpacing: 0.3 }),
  inp:   { fontSize: 12, padding: '5px 8px', borderRadius: 6, border: '1px solid #d1d5db' },
  err:   { padding: '7px 10px', background: '#fee2e2', color: '#991b1b', borderRadius: 6,
           fontSize: 12, marginBottom: 10 },
  empty: { fontSize: 13, color: '#9ca3af', padding: '18px 0' },
  disc:  { background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280',
           fontSize: 12, padding: '0 4px 0 0', lineHeight: 1 },
  panel: { marginTop: 10, paddingTop: 10, borderTop: '1px dashed #e5e7eb' },
  sub:   { fontSize: 11, color: '#9ca3af', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.4 },
  prow:  { display: 'flex', alignItems: 'baseline', gap: 8, padding: '5px 0',
           borderBottom: '1px solid #f3f4f6', fontSize: 12, flexWrap: 'wrap' },
  plink: { background: 'none', border: 'none', padding: 0, fontSize: 12, color: '#0369a1',
           cursor: 'pointer', textAlign: 'left' },
};

const errText = (e, fallback) => e?.response?.data?.error?.message || fallback;

function StatusPill({ status, kind }) {
  if (status === 'active')   return <span style={S.pill('#dcfce7', '#065f46')}>active</span>;
  if (status === 'pending')  return <span style={S.pill('#fef3c7', '#92400e')}>awaiting approval</span>;
  if (status === 'rejected') return <span style={S.pill('#fee2e2', '#991b1b')}>rejected</span>;
  // Ended is a state, not an absence — the row and its history are still here.
  return <span style={S.pill('#f3f4f6', '#6b7280')}>former {kind}</span>;
}

/**
 * Per-project involvement for one account. Loaded on expand rather than with
 * the list: most rows are never opened, and this is a join across contacts,
 * projects and membership.
 */
function ProjectsPanel({ accountId, accountName, onOpenProject }) {
  const [state, setState] = useState({ loading: true, projects: [], scoped: true, err: '' });

  useEffect(() => {
    let alive = true;
    apiService.accountRelationships.projectsForAccount(accountId)
      .then(r => {
        if (!alive) return;
        setState({ loading: false, projects: r.data.projects || [], scoped: !!r.data.scoped, err: '' });
      })
      .catch(e => {
        if (!alive) return;
        setState({ loading: false, projects: [], scoped: true, err: errText(e, 'Could not load projects.') });
      });
    return () => { alive = false; };
  }, [accountId]);

  if (state.loading) return <div style={{ ...S.panel, ...S.empty, padding: '10px 0' }}>Loading projects…</div>;
  if (state.err)     return <div style={{ ...S.panel }}><div style={S.err}>{state.err}</div></div>;

  if (!state.projects.length) {
    return (
      <div style={S.panel}>
        <div style={S.empty}>
          {state.scoped
            ? `Nobody from ${accountName} is on a project you can see.`
            : `Nobody from ${accountName} is on a project yet.`}
        </div>
      </div>
    );
  }

  return (
    <div style={S.panel}>
      <div style={S.sub}>On these projects</div>
      {state.projects.map(p => (
        <div key={`${p.project_id}-${p.side}`} style={S.prow}>
          <button style={S.plink} onClick={() => onOpenProject && onOpenProject(p.project_id)}>
            {p.project_name || `Project #${p.project_id}`}
          </button>
          <span style={{ color: '#6b7280' }}>{SIDE_LABEL[p.side] || p.side}</span>
          <span style={{ color: '#9ca3af', marginLeft: 'auto' }}>
            {PROJECT_STATUS_LABEL[p.status] || p.status}
          </span>
          <div style={{ flexBasis: '100%', color: '#374151', paddingTop: 2 }}>
            {(p.people || []).map(pl => `${pl.name}${pl.role ? ` · ${pl.role}` : ''}`).join('   ')}
          </div>
        </div>
      ))}
      {state.scoped && (
        <div style={{ ...S.meta, marginTop: 8 }}>
          Showing projects you have a role on. Others may exist.
        </div>
      )}
    </div>
  );
}

function AddRelationship({ kind, onDone, onCancel }) {
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    apiService.accounts.getAll()
      .then(r => setAccounts(r.data.accounts || r.data || []))
      .catch(() => setAccounts([]));
  }, []);

  const save = async () => {
    if (!accountId) { setErr('Pick an account.'); return; }
    setErr(''); setSaving(true);
    try {
      const r = await apiService.accountRelationships.request({ accountId, relationship: kind, notes });
      await onDone(r.data);
    } catch (e) { setErr(errText(e, 'Could not save.')); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ ...S.card, background: '#f8fafc' }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={accountId} onChange={e => setAccountId(e.target.value)} style={{ ...S.inp, minWidth: 220 }}>
          <option value="">Select an account…</option>
          {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <input value={notes} onChange={e => setNotes(e.target.value)}
          placeholder="What do we use them for? (optional)" style={{ ...S.inp, minWidth: 240 }} />
        <button onClick={save} disabled={saving} style={S.pri}>{saving ? 'Saving…' : `Add as ${kind}`}</button>
        <button onClick={onCancel} disabled={saving} style={S.btn}>Cancel</button>
      </div>
      <div style={{ ...S.meta, marginTop: 8 }}>
        Any account can be a {kind} and stay a customer — this does not change its account type
        or its place in the pipeline.
      </div>
      {err && <div style={{ ...S.err, marginTop: 8, marginBottom: 0 }}>{err}</div>}
    </div>
  );
}

function ApproverPolicy({ onClose }) {
  const [policy, setPolicy] = useState(null);
  const [users, setUsers] = useState([]);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    Promise.all([
      apiService.accountRelationships.getPolicy(),
      apiService.handovers.assignableUsers(),
    ]).then(([p, u]) => {
      setPolicy(p.data.policy);
      setUsers(u.data.users || []);
    }).catch(() => setMsg('Could not load.'));
  }, []);

  const toggle = (uid) => setPolicy(p => {
    const set = new Set((p.named_users || []).map(Number));
    if (set.has(uid)) set.delete(uid); else set.add(uid);
    return { ...p, named_users: [...set] };
  });

  const save = async () => {
    try {
      await apiService.accountRelationships.setPolicy(policy);
      setMsg('Saved.');
    } catch (e) { setMsg(errText(e, 'Could not save.')); }
  };

  if (!policy) return <div style={S.card}>{msg || 'Loading…'}</div>;

  return (
    <div style={S.card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <strong style={{ fontSize: 13 }}>Who can approve a vendor or partner</strong>
        <button onClick={onClose} style={{ ...S.btn, marginLeft: 'auto' }}>Close</button>
      </div>
      <label style={{ display: 'block', fontSize: 12, marginBottom: 8 }}>
        <input type="checkbox" checked={!!policy.admins}
          onChange={e => setPolicy(p => ({ ...p, admins: e.target.checked }))} />
        {' '}Org admins can always approve
      </label>
      <div style={{ ...S.meta, marginBottom: 6 }}>Named approvers — typically finance:</div>
      <div style={{ maxHeight: 180, overflowY: 'auto', marginBottom: 8 }}>
        {users.map(u => (
          <label key={u.id} style={{ display: 'block', fontSize: 12, padding: '2px 0' }}>
            <input type="checkbox"
              checked={(policy.named_users || []).map(Number).includes(u.id)}
              onChange={() => toggle(u.id)} />
            {' '}{u.name || `${u.first_name} ${u.last_name}`}
          </label>
        ))}
      </div>
      <button onClick={save} style={S.pri}>Save</button>
      {msg && <span style={{ marginLeft: 8, fontSize: 12, color: '#6b7280' }}>{msg}</span>}
    </div>
  );
}

export default function VendorsView({ onOpenProject }) {
  const [kind,     setKind]     = useState('vendor');
  const [status,   setStatus]   = useState('active');
  const [rows,     setRows]     = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [err,      setErr]      = useState('');
  const [adding,   setAdding]   = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [canApprove, setCanApprove] = useState(false);
  const [openId,   setOpenId]   = useState(null);   // relationship_id of the expanded row

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const entry = KINDS.find(k => k.key === kind);
      const r = await entry.fetch(status);
      setRows(r.data.accounts || []);
    } catch (e) { setErr(errText(e, 'Could not load.')); }
    finally { setLoading(false); }
  }, [kind, status]);

  useEffect(() => { load(); }, [load]);

  // Collapse on filter change: the expanded row is usually gone from the new
  // result set, and a panel left open under a different account misleads.
  useEffect(() => { setOpenId(null); }, [kind, status]);

  useEffect(() => {
    apiService.accountRelationships.getPolicy()
      .then(r => setCanApprove(!!r.data.canApprove))
      .catch(() => setCanApprove(false));
  }, []);

  const review = async (id, action) => {
    const reason = action === 'reject'
      ? window.prompt('Why is this being rejected?')
      : null;
    if (action === 'reject' && !reason) return;
    setErr('');
    try { await apiService.accountRelationships.review(id, { action, reason }); await load(); }
    catch (e) { setErr(errText(e, 'Could not update.')); }
  };

  // Not "end" in the copy: nothing is removed. The row stays, ended_at is set,
  // and re-requesting the same account reopens this same record.
  const markFormer = async (id, name) => {
    const ok = window.confirm(
      `Mark ${name} as a former ${kind}?\n\n` +
      `They won't appear as an approved ${kind} when someone adds people to a new project.\n\n` +
      `Nothing is deleted. Past and current projects keep showing who was involved, and the ` +
      `approval on file stays. You can re-approve them later and this same record reopens.`
    );
    if (!ok) return;
    setErr('');
    try { await apiService.accountRelationships.end(id); await load(); }
    catch (e) { setErr(errText(e, 'Could not update.')); }
  };

  const emptyCopy = () => {
    if (status === 'ended')   return `No former ${kind}s. ${kind === 'vendor' ? 'Vendors' : 'Partners'} you stop working with will appear here.`;
    if (status === 'pending') return `No ${kind} requests waiting for approval.`;
    if (status === 'all')     return `No ${kind}s yet. Any account can be added as one — including a customer.`;
    return `No active ${kind}s yet. Any account can be added as one — including a customer.`;
  };

  return (
    <div style={S.page}>
      <div style={S.head}>
        <h3 style={S.h3}>Vendors &amp; partners</h3>
        <div style={{ display: 'flex', marginLeft: 12 }}>
          {KINDS.map(k => (
            <button key={k.key} onClick={() => setKind(k.key)} style={S.tab(kind === k.key)}>{k.label}</button>
          ))}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <select value={status} onChange={e => setStatus(e.target.value)} style={S.inp}>
            {STATUSES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
          {canApprove && (
            <>
              <button onClick={() => setPolicyOpen(o => !o)} style={S.btn}>Approvers…</button>
              <button onClick={() => setAdding(a => !a)} style={S.pri}>
                {adding ? 'Done' : `+ Add ${kind}`}
              </button>
            </>
          )}
        </div>
      </div>

      {err && <div style={S.err}>⚠️ {err}</div>}
      {policyOpen && <ApproverPolicy onClose={() => setPolicyOpen(false)} />}
      {adding && <AddRelationship kind={kind} onCancel={() => setAdding(false)}
        onDone={async () => { setAdding(false); await load(); }} />}

      {loading && <p style={S.empty}>Loading…</p>}
      {!loading && !rows.length && <p style={S.empty}>{emptyCopy()}</p>}

      {rows.map(a => {
        const open = openId === a.relationship_id;
        return (
          <div key={a.relationship_id} style={S.card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <button
                style={S.disc}
                aria-expanded={open}
                aria-label={open ? `Collapse ${a.name}` : `Expand ${a.name}`}
                onClick={() => setOpenId(open ? null : a.relationship_id)}
              >
                {open ? '▾' : '▸'}
              </button>
              <strong style={{ fontSize: 14, cursor: 'pointer' }}
                onClick={() => setOpenId(open ? null : a.relationship_id)}>{a.name}</strong>
              <StatusPill status={a.status} kind={kind} />
              {a.account_type === 'customer' && (
                <span style={S.pill('#eff6ff', '#1d4ed8')}>also a customer</span>
              )}
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                {canApprove && a.status === 'pending' && (
                  <>
                    <button onClick={() => review(a.relationship_id, 'approve')} style={{
                      ...S.btn, background: '#059669', color: '#fff', border: 'none' }}>Approve</button>
                    <button onClick={() => review(a.relationship_id, 'reject')} style={S.btn}>Reject</button>
                  </>
                )}
                {canApprove && a.status === 'active' && (
                  <button onClick={() => markFormer(a.relationship_id, a.name)} style={S.btn}>
                    No longer a {kind}
                  </button>
                )}
              </div>
            </div>
            <div style={{ ...S.meta, marginTop: 6 }}>
              {a.domain   && <span>{a.domain}</span>}
              {a.industry && <span>· {a.industry}</span>}
              {a.location && <span>· {a.location}</span>}
              {a.approved_by_name && <span>· approved by {a.approved_by_name}</span>}
              {a.created_by_name  && <span>· added by {a.created_by_name}</span>}
            </div>
            {a.notes && <div style={{ fontSize: 12, color: '#374151', marginTop: 6 }}>{a.notes}</div>}
            {open && (
              <ProjectsPanel
                accountId={a.id}
                accountName={a.name}
                onOpenProject={onOpenProject}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
