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

/**
 * Account picker with inline creation.
 *
 * A plain <select> was the wrong control here for two reasons. It listed only
 * accounts the viewer OWNS (getAll defaults to scope 'mine'), and a vendor is
 * usually owned by somebody else — so the account frequently existed and simply
 * was not offered. And when it genuinely did not exist there was no way out of
 * the dialog: you had to leave, create the account, and come back.
 *
 * Scope is 'org' to match the project pickers in HandoverView. That makes the
 * list long, hence the type-ahead rather than a dropdown.
 */
/**
 * EXPORTED because the WhatsApp triage screen needs the same control when
 * binding a group to a vendor. Exported rather than copied: a second type-ahead
 * with its own create-inline behaviour and its own duplicate-account handling
 * would drift from this one within a release.
 *
 * @param {boolean} props.onlyRelationships  when true, offer ONLY accounts that
 *        already hold an APPROVED vendor or partner relationship, and drop the
 *        create-inline affordance with it. Default false, which is what this
 *        file's own use needs: the picker here is how a NEW vendor relationship
 *        gets requested, so filtering to existing vendors would make it
 *        impossible to add one.
 */
export function AccountPicker({ value, onChange, disabled, onlyRelationships = false }) {
  const [accounts, setAccounts] = useState([]);
  const [query,    setQuery]    = useState('');
  const [open,     setOpen]     = useState(false);
  const [creating, setCreating] = useState(false);
  const [newDomain, setNewDomain] = useState('');
  const [busy,     setBusy]     = useState(false);
  const [note,     setNote]     = useState('');

  const reload = useCallback(async () => {
    // Both relationship kinds, deduped: a firm can be approved as a vendor AND
    // a partner, and either qualifies a group to be bound to it.
    if (onlyRelationships) {
      const [v, p] = await Promise.all([
        apiService.accountRelationships.vendors('active'),
        apiService.accountRelationships.partners('active'),
      ]);
      const rows = [...(v.data.accounts || v.data || []), ...(p.data.accounts || p.data || [])];
      const list = [...new Map(rows.map(a => [a.id, a])).values()]
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      setAccounts(list);
      return list;
    }
    // 'org', not the 'mine' default: whose account it is has nothing to do with
    // whether they are a vendor to us.
    const r = await apiService.accounts.getAll('org');
    const list = r.data.accounts || r.data || [];
    setAccounts(list);
    return list;
  }, [onlyRelationships]);

  useEffect(() => { reload().catch(() => setAccounts([])); }, [reload]);

  const selected = accounts.find(a => String(a.id) === String(value));
  const q = query.trim().toLowerCase();
  const matches = !q ? accounts.slice(0, 50)
    : accounts.filter(a => (a.name || '').toLowerCase().includes(q)
                        || (a.domain || '').toLowerCase().includes(q)).slice(0, 50);
  const exact = accounts.some(a => (a.name || '').toLowerCase() === q);

  const pick = (a) => {
    onChange(String(a.id));
    setQuery(''); setOpen(false); setNote('');
  };

  const create = async () => {
    const name = query.trim();
    if (!name) return;
    setBusy(true); setNote('');
    try {
      const r = await apiService.accounts.create({ name, domain: newDomain.trim() || undefined });
      const created = r.data.account;
      await reload();
      onChange(String(created.id));
      setCreating(false); setQuery(''); setNewDomain(''); setOpen(false);
      setNote(`Created ${created.name}.`);
    } catch (e) {
      // The duplicate guard on POST /accounts is scoped to owner_id, so it only
      // fires for accounts this user already owns. When it does, it hands back
      // the existing id — use that rather than making them start over.
      const err = e?.response?.data?.error;
      if (err?.existingAccountId) {
        const list = await reload().catch(() => accounts);
        const hit = list.find(a => String(a.id) === String(err.existingAccountId));
        onChange(String(err.existingAccountId));
        setCreating(false); setQuery(''); setNewDomain(''); setOpen(false);
        setNote(hit ? `${hit.name} already exists — selected it.` : 'That account already exists — selected it.');
      } else {
        setNote(errText(e, 'Could not create the account.'));
      }
    } finally { setBusy(false); }
  };

  if (creating) {
    return (
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <input autoFocus value={query} onChange={e => setQuery(e.target.value)}
          placeholder="Account name" style={{ ...S.inp, minWidth: 190 }} />
        <input value={newDomain} onChange={e => setNewDomain(e.target.value)}
          placeholder="Domain (optional)" style={{ ...S.inp, minWidth: 150 }} />
        <button onClick={create} disabled={busy || !query.trim()} style={S.pri}>
          {busy ? 'Creating…' : 'Create account'}
        </button>
        <button onClick={() => { setCreating(false); setNote(''); }} disabled={busy} style={S.btn}>Back</button>
        {note && <span style={{ fontSize: 11, color: '#6b7280' }}>{note}</span>}
        <div style={{ ...S.meta, flexBasis: '100%' }}>
          Without a domain, emails and meetings from their people will not auto-link to this account.
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', minWidth: 260 }}>
      <input
        disabled={disabled}
        value={open ? query : (selected ? selected.name : query)}
        onChange={e => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => { setOpen(true); setQuery(''); }}
        placeholder="Search accounts…"
        style={{ ...S.inp, width: '100%' }}
      />
      {note && <div style={{ fontSize: 11, color: '#6b7280', marginTop: 3 }}>{note}</div>}
      {open && (
        <div style={{
          position: 'absolute', zIndex: 20, top: '100%', left: 0, right: 0, marginTop: 2,
          background: '#fff', border: '1px solid #d1d5db', borderRadius: 6,
          maxHeight: 240, overflowY: 'auto', boxShadow: '0 6px 16px rgba(0,0,0,0.08)',
        }}>
          {matches.map(a => (
            <button key={a.id} onClick={() => pick(a)} style={{
              display: 'block', width: '100%', textAlign: 'left', border: 'none',
              background: 'none', padding: '6px 10px', fontSize: 12, cursor: 'pointer',
            }}>
              {a.name}{a.domain ? <span style={{ color: '#9ca3af' }}> · {a.domain}</span> : null}
            </button>
          ))}
          {!matches.length && (
            <div style={{ padding: '8px 10px', fontSize: 12, color: '#9ca3af' }}>
              {onlyRelationships
                ? 'No approved vendor or partner matches. Add the relationship first.'
                : 'No account matches.'}
            </div>
          )}
          {/* Creating an account inline cannot help when the list is filtered to
              APPROVED relationships — a brand new account holds none, so it
              would vanish from the list the moment it was created. */}
          {q && !exact && !onlyRelationships && (
            <button onClick={() => { setCreating(true); setOpen(false); }} style={{
              display: 'block', width: '100%', textAlign: 'left', border: 'none',
              borderTop: '1px solid #f3f4f6', background: '#f8fafc', padding: '7px 10px',
              fontSize: 12, cursor: 'pointer', color: '#0369a1', fontWeight: 600,
            }}>
              ＋ Create “{query.trim()}” as a new account
            </button>
          )}
          <button onClick={() => setOpen(false)} style={{
            display: 'block', width: '100%', textAlign: 'left', border: 'none',
            borderTop: '1px solid #f3f4f6', background: 'none', padding: '6px 10px',
            fontSize: 11, cursor: 'pointer', color: '#6b7280',
          }}>Close</button>
        </div>
      )}
    </div>
  );
}

function AddRelationship({ kind, onDone, onCancel }) {
  const [accountId, setAccountId] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

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
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <AccountPicker value={accountId} onChange={setAccountId} disabled={saving} />
        <input value={notes} onChange={e => setNotes(e.target.value)}
          placeholder="What do we use them for? (optional)" style={{ ...S.inp, minWidth: 240 }} />
        <button onClick={save} disabled={saving} style={S.pri}>{saving ? 'Saving…' : `Add as ${kind}`}</button>
        <button onClick={onCancel} disabled={saving} style={S.btn}>Cancel</button>
      </div>
      <div style={{ ...S.meta, marginTop: 8 }}>
        Any account can be a {kind} and stay a customer — this does not change its account type
        or its place in the pipeline. Not listed? Type the name and create it.
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
              {/* One-way: the panel closes via its own Cancel. A header button
                  that relabels to 'Done' reads as a save confirmation when it
                  is really just a toggle, and nothing has been saved. */}
              <button
                onClick={() => setAdding(true)}
                disabled={adding}
                style={adding ? { ...S.pri, background: '#93c5fd', cursor: 'default' } : S.pri}
              >
                + Add {kind}
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
