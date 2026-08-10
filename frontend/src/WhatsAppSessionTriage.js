/*
 * WhatsAppSessionTriage.js
 *
 * The screen that turns raw group capture into CRM data.
 *
 * TWO INDEPENDENT DECISIONS, deliberately not collapsed into one:
 *
 *   WATCH — "retain what is said in this group". In allowlist mode nothing is
 *           stored until this is on. A pilot on a real personal number
 *           catalogued 306 groups; almost all were family and society chatter,
 *           so capture-by-default was the wrong shape.
 *
 *   BIND  — "this is how the group is ORGANISED". Three answers, not one:
 *
 *             Project  the group IS a project — the Acme group, the cutover
 *                      crew. Sets handover_id on the thread and back-fills
 *                      already-captured messages, so binding on Friday does not
 *                      lose Monday.
 *
 *             Vendor   the group is organised around WHO IS IN IT — the
 *                      Cloudsmith group, which covers several projects and
 *                      belongs to none. No thread project, nothing back-filled.
 *
 *             Several  an internal group covering several projects, named by a
 *             projects human because there is no relationship to derive them
 *                      from.
 *
 * WHY THE LAST TWO FILE NOTHING
 *   Binding a vendor group to one project would attribute every message ever
 *   captured in it to that project. A misfiled message is worse than an unfiled
 *   one: unfiled, somebody can still find and file it; misfiled, it is
 *   invisible, because nobody audits the project they did not expect it in. So
 *   messages in a vendor or multi-project group land UNASSIGNED and are filed
 *   by a person. The copy in this screen says so plainly rather than letting
 *   somebody discover it.
 *
 * Binding implies watching (an unambiguous statement that the contents belong
 * in the CRM). Watching does not imply binding — you may want to retain a
 * group before deciding what it is.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { apiService } from './apiService';
import { AccountPicker } from './VendorsView';

const CARD  = { border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff' };
const BTN   = { padding: '6px 12px', borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: 'pointer', border: '1px solid transparent' };
const PRIMARY = { ...BTN, background: '#E8630A', color: '#fff' };
const GHOST   = { ...BTN, background: '#fff', color: '#374151', border: '1px solid #d1d5db' };
const INPUT   = { padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' };

/**
 * Per-group attachment policy.
 *
 * Watching a group is a decision about TEXT. Whether its attachments are also
 * written into the customer's Drive is a second, larger decision — one group is
 * a document-heavy implementation channel, the next is scheduling chatter where
 * the photos are somebody's lunch.
 *
 * 'documents' is the setting most groups actually want and the reason this
 * control is not a checkbox.
 */
const MEDIA_POLICY = {
  inherit:   { label: 'Default',   hint: 'Follows the session switch and the project setting.', bg: '#f3f4f6', fg: '#6b7280' },
  all:       { label: 'All files', hint: 'Every attachment is saved to the project folder.',    bg: '#ecfdf5', fg: '#065f46' },
  documents: { label: 'Docs only', hint: 'Documents saved. Photos, video, audio and stickers are not.', bg: '#eff6ff', fg: '#1e40af' },
  none:      { label: 'No files',  hint: 'No attachments from this group are saved.',           bg: '#fef2f2', fg: '#991b1b' },
};
const POLICY_ORDER = ['inherit', 'all', 'documents', 'none'];

/**
 * How a group is organised, as the user sees it.
 *
 * `bound` deliberately still means "bound to one project" — the same thing it
 * meant before these two joined it — so nothing that already filtered on it
 * changed meaning underneath.
 */
const BINDING = {
  bound:         { label: 'Project',          bg: '#ecfdf5', fg: '#065f46' },
  bound_account: { label: 'Vendor',           bg: '#eff6ff', fg: '#1e40af' },
  bound_pool:    { label: 'Several projects', bg: '#fdf4ff', fg: '#6b21a8' },
};

const MODES = [
  {
    key: 'project',
    label: 'One project',
    hint: 'This group IS a project. Messages already captured are attached to it too.',
  },
  {
    key: 'account',
    label: 'A vendor or partner',
    hint: 'Covers several projects. Nothing is filed automatically — messages wait to be filed by a person.',
  },
  {
    key: 'pool',
    label: 'Several projects',
    hint: 'An internal group. Name the projects it covers; nothing is filed automatically.',
  },
];

const FILTERS = [
  { key: 'all',      label: 'All groups' },
  { key: 'watched',  label: 'Watched' },
  { key: 'unwatched',label: 'Not watched' },
  { key: 'bound',    label: 'Bound to a project' },
  { key: 'vendor',   label: 'Vendor groups' },
  { key: 'pool',     label: 'Several projects' },
];

export default function WhatsAppSessionTriage() {
  const [data,     setData]     = useState({ groups: [], counts: {} });
  const [loading,  setLoading]  = useState(true);
  const [busy,     setBusy]     = useState(false);
  const [error,    setError]    = useState('');
  const [notice,   setNotice]   = useState('');

  const [filter,   setFilter]   = useState('all');
  const [search,   setSearch]   = useState('');
  const [selected, setSelected] = useState(() => new Set());

  const [bindFor,   setBindFor]   = useState(null);
  const [handovers, setHandovers] = useState([]);
  const [handoverId,setHandoverId]= useState('');
  const [bindMode,  setBindMode]  = useState('project');
  const [accountId, setAccountId] = useState('');
  const [candidates,setCandidates]= useState(() => new Set());
  // Set when the server refuses a rebind that would break an existing decision.
  // Holds the server's own sentence rather than one composed here, so the reason
  // shown is the reason that fired.
  const [confirm,   setConfirm]   = useState('');

  const load = useCallback(async () => {
    try {
      const params = {};
      if (filter === 'watched')   params.watched = 'true';
      if (filter === 'unwatched') params.watched = 'false';
      if (filter === 'bound')      params.status = 'bound';
      if (filter === 'vendor')     params.status = 'bound_account';
      if (filter === 'pool')       params.status = 'bound_pool';
      if (search.trim())          params.q       = search.trim();
      const res = await apiService.whatsappSession.triageQuery(params);
      setData(res.data || { groups: [], counts: {} });
    } catch (e) {
      setError(e?.response?.data?.error?.message || 'Could not load groups.');
    } finally {
      setLoading(false);
    }
  }, [filter, search]);

  useEffect(() => {
    const t = setTimeout(load, search ? 300 : 0);   // debounce typing only
    return () => clearTimeout(t);
  }, [load, search]);

  useEffect(() => {
    apiService.handovers.list('all')
      .then(r => setHandovers(r.data?.handovers || r.data || []))
      .catch(() => setHandovers([]));
  }, []);

  // useMemo, not `data.groups || []`: the fallback creates a fresh array on
  // every render, which would make the needsAttention memo below recompute
  // every time regardless of whether anything changed.
  const groups = useMemo(() => data.groups || [], [data.groups]);
  const allSelected = groups.length > 0 && groups.every(g => selected.has(g.group_jid));

  const toggle = (id) => setSelected(s => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(groups.map(g => g.group_jid)));

  const run = async (fn, okMsg) => {
    setError(''); setNotice(''); setBusy(true);
    try {
      const out = await fn();
      if (okMsg) setNotice(typeof okMsg === 'function' ? okMsg(out) : okMsg);
      setSelected(new Set());
      await load();
    } catch (e) {
      setError(e?.response?.data?.error?.message || e.message);
    } finally {
      setBusy(false);
    }
  };

  const bulkWatch = (watched) => run(
    () => apiService.whatsappSession.watchJid({ jids: [...selected], watched }),
    (r) => `${r.data.updated} group${r.data.updated === 1 ? '' : 's'} ${watched ? 'now being captured' : 'no longer captured'}.`
  );

  // Loosening a policy requeues what the old one skipped, so the count coming
  // back is worth saying out loud — otherwise a PM has no way to know the
  // change was retroactive rather than only forward-looking.
  const bulkPolicy = (policy) => run(
    () => apiService.whatsappSession.mediaPolicy({
      groupIds: groups.filter(g => selected.has(g.group_jid) && g.id).map(g => g.id),
      policy,
    }),
    (r) => {
      const n = r.data?.requeued ?? 0;
      return `Attachment policy set to "${MEDIA_POLICY[policy].label}" for ${r.data.updated} group${r.data.updated === 1 ? '' : 's'}`
        + (n ? `, and ${n} earlier attachment${n === 1 ? '' : 's'} queued to be saved.` : '.');
    }
  );

  const openBind = (g) => {
    setBindFor(g);
    // Pre-select what the group already is, so re-opening the dialog on a bound
    // group shows its current shape rather than silently defaulting to project.
    setBindMode(g.binding_mode || 'project');
    setHandoverId(g.binding_mode === 'project' && g.handover_id ? String(g.handover_id) : '');
    setAccountId(g.bound_account_id ? String(g.bound_account_id) : '');
    setCandidates(new Set());
    setConfirm(''); setError('');
  };

  const closeBind = () => {
    setBindFor(null); setHandoverId(''); setAccountId('');
    setCandidates(new Set()); setConfirm('');
  };

  const bindPayload = (force) => {
    if (bindMode === 'project') return { mode: 'project', handoverId: Number(handoverId), force };
    if (bindMode === 'account') return { mode: 'account', accountId: Number(accountId), force };
    return { mode: 'pool', candidateIds: [...candidates].map(Number), force };
  };

  /**
   * The server owns the "are you sure" decision, not this screen.
   *
   * A 409 NEEDS_FORCE comes back with the sentence explaining what the change
   * breaks, and that sentence is shown verbatim before the same request is
   * re-sent with force. Composing the warning here would mean two places
   * deciding which transitions are dangerous, and they would drift.
   */
  const submitBind = async (force = false) => {
    if (bindMode === 'project' && !handoverId) { setError('Pick a project first.'); return; }
    if (bindMode === 'account' && !accountId)  { setError('Pick a vendor or partner first.'); return; }
    if (bindMode === 'pool' && !candidates.size) { setError('Name at least one project this group covers.'); return; }

    setError(''); setNotice(''); setConfirm(''); setBusy(true);
    try {
      const r = await apiService.whatsappSession.bind(bindFor.id, bindPayload(force));
      const d = r.data || {};
      closeBind();
      setSelected(new Set());
      await load();

      if (d.mode === 'project') {
        const n = d.backfilled ?? 0;
        setNotice(
          `Linked to the project${n ? `, and ${n} earlier message${n === 1 ? '' : 's'} attached` : ''}.`
          + (d.backfillSuppressed
              ? ' Earlier messages were NOT attached — this group covered several projects, so they stay unfiled until someone files them.'
              : '')
        );
      } else {
        const what = d.mode === 'account' ? 'a vendor' : 'several projects';
        setNotice(
          `Marked as covering ${what}. ${d.candidates || 0} project${d.candidates === 1 ? '' : 's'} on its shortlist. `
          + 'Nothing was filed automatically — messages in this group wait to be filed by a person.'
          + (d.clearedProject ? ' The old project link was removed; messages already filed to it stayed there.' : '')
          + (d.mediaStranded ? ` ${d.mediaStranded} attachment${d.mediaStranded === 1 ? '' : 's'} in flight will not be saved until its message is filed.` : '')
        );
      }
    } catch (e) {
      const body = e?.response?.data;
      if (e?.response?.status === 409 && body?.code === 'NEEDS_FORCE') {
        setConfirm(body.error?.message || body.error || 'This changes an existing link. Confirm to continue.');
      } else {
        setError(body?.error?.message || e.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const doUnbind = (g) => run(
    () => apiService.whatsappSession.unbind(g.id),
    'Binding removed. The group is still being captured.'
  );

  const counts = data.counts || {};
  const needsAttention = useMemo(
    () => groups.filter(g => g.is_watched && g.binding_status === 'unbound').length,
    [groups]
  );

  if (loading) return <div style={{ padding: 16, color: '#6b7280', fontSize: 13 }}>Loading groups…</div>;

  return (
    <div style={{ maxWidth: 940 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 600, color: '#1a202c' }}>
        WhatsApp groups
      </h3>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: '#6b7280', lineHeight: 1.5 }}>
        Every group this number belongs to is listed here, read live from WhatsApp. Nothing about
        these groups is stored in GoWarmCRM until you switch one on — close this page and the rest
        are forgotten.
      </p>

      <div style={{ display: 'flex', gap: 20, marginBottom: 14, fontSize: 12 }}>
        <Stat label="In this list" value={counts.inSnapshot ?? 0} />
        <Stat label="Capturing"   value={counts.watched ?? 0} />
        <Stat label="Projects"    value={counts.bound ?? 0} />
        <Stat label="Vendor"      value={counts.boundAccount ?? 0} />
        <Stat label="Multi"       value={counts.boundPool ?? 0} />
        <Stat label="Undecided"   value={counts.needsBinding ?? 0} warn={needsAttention > 0} />
      </div>

      {error  && <Banner tone="error">{error}</Banner>}
      {notice && <Banner tone="ok">{notice}</Banner>}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <input
          style={{ ...INPUT, flex: '1 1 220px', minWidth: 200 }}
          placeholder="Search group names…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {FILTERS.map(f => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            style={{
              ...GHOST,
              background: filter === f.key ? '#1A3A5C' : '#fff',
              color:      filter === f.key ? '#fff'    : '#374151',
              borderColor:filter === f.key ? '#1A3A5C' : '#d1d5db',
            }}
          >{f.label}</button>
        ))}
      </div>

      {selected.size > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', marginBottom: 10,
          background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8,
        }}>
          <span style={{ fontSize: 13, color: '#374151' }}>{selected.size} selected</span>
          <button style={PRIMARY} disabled={busy} onClick={() => bulkWatch(true)}>Start capturing</button>
          <button style={GHOST}   disabled={busy} onClick={() => bulkWatch(false)}>Stop capturing</button>

          <span style={{ fontSize: 13, color: '#6b7280', marginLeft: 4 }}>Attachments:</span>
          <select
            style={{ ...INPUT, padding: '5px 8px', fontSize: 12 }}
            value=""
            disabled={busy}
            onChange={e => { if (e.target.value) bulkPolicy(e.target.value); e.target.value = ''; }}
          >
            <option value="">Set policy…</option>
            {POLICY_ORDER.map(k => (
              <option key={k} value={k}>{MEDIA_POLICY[k].label}</option>
            ))}
          </select>

          <button style={{ ...GHOST, marginLeft: 'auto' }} onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      <div style={{ ...CARD, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f9fafb', textAlign: 'left', color: '#6b7280', fontSize: 12 }}>
              <th style={{ padding: '9px 12px', width: 34 }}>
                <input type="checkbox" checked={allSelected} onChange={toggleAll} />
              </th>
              <th style={{ padding: '9px 12px' }}>Group</th>
              <th style={{ padding: '9px 12px', width: 110 }}>Capturing</th>
              <th style={{ padding: '9px 12px', width: 130 }}>Attachments</th>
              <th style={{ padding: '9px 12px', width: 210 }}>Organised as</th>
              <th style={{ padding: '9px 12px', width: 120 }}>Last activity</th>
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 && (
              <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>
                No groups match this filter.
              </td></tr>
            )}
            {groups.map(g => (
              <tr key={g.group_jid} style={{ borderTop: '1px solid #f3f4f6' }}>
                <td style={{ padding: '10px 12px' }}>
                  <input type="checkbox" checked={selected.has(g.group_jid)} onChange={() => toggle(g.group_jid)} />
                </td>
                <td style={{ padding: '10px 12px' }}>
                  <div style={{ fontWeight: 500, color: '#1a202c' }}>{g.subject || '(no name)'}</div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                    {g.participant_count != null && `${g.participant_count} participants · `}
                    {g.message_count > 0 ? `${g.message_count} captured` : 'nothing captured'}
                  </div>
                  {g.is_watched && g.last_message_preview && (
                    <div style={{
                      fontSize: 11, color: '#6b7280', marginTop: 4, maxWidth: 380,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{g.last_message_preview}</div>
                  )}
                </td>
                <td style={{ padding: '10px 12px' }}>
                  <button
                    style={{
                      ...BTN, fontSize: 12, padding: '4px 10px',
                      background: g.is_watched ? '#ecfdf5' : '#f3f4f6',
                      color:      g.is_watched ? '#065f46' : '#6b7280',
                      border: `1px solid ${g.is_watched ? '#a7f3d0' : '#e5e7eb'}`,
                    }}
                    disabled={busy}
                    onClick={() => run(
                      () => apiService.whatsappSession.watchJid({ jids: [g.group_jid], watched: !g.is_watched }),
                      g.is_watched ? 'Capture stopped for that group.' : 'Now capturing that group.'
                    )}
                  >{g.is_watched ? 'On' : 'Off'}</button>
                </td>
                <td style={{ padding: '10px 12px' }}>
                  {/* Only meaningful once the group is persisted — an undecided
                      group has no row to hang a policy on. */}
                  {g.id ? (
                    <>
                      <select
                        style={{
                          ...INPUT, padding: '3px 6px', fontSize: 11, width: '100%',
                          background: (MEDIA_POLICY[g.media_policy] || MEDIA_POLICY.inherit).bg,
                          color:      (MEDIA_POLICY[g.media_policy] || MEDIA_POLICY.inherit).fg,
                          fontWeight: g.media_policy && g.media_policy !== 'inherit' ? 600 : 400,
                        }}
                        disabled={busy}
                        value={g.media_policy || 'inherit'}
                        onChange={e => run(
                          () => apiService.whatsappSession.mediaPolicy({ groupIds: [g.id], policy: e.target.value }),
                          (r) => {
                            const n = r.data?.requeued ?? 0;
                            return `Attachments: ${MEDIA_POLICY[e.target.value].label}`
                              + (n ? ` — ${n} earlier file${n === 1 ? '' : 's'} queued to be saved.` : '.');
                          }
                        )}
                        title={(MEDIA_POLICY[g.media_policy] || MEDIA_POLICY.inherit).hint}
                      >
                        {POLICY_ORDER.map(k => (
                          <option key={k} value={k}>{MEDIA_POLICY[k].label}</option>
                        ))}
                      </select>
                      {/* Files that arrived and never reached storage. The
                          number is the whole point: a group quietly dropping
                          documents looks identical to a healthy one otherwise. */}
                      {Number(g.media_unstored) > 0 && (
                        <div style={{ fontSize: 10, color: '#92400e', marginTop: 3 }}>
                          {g.media_unstored} not saved
                        </div>
                      )}
                      {g.media_policy_by_name && g.media_policy !== 'inherit' && (
                        <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>
                          set by {g.media_policy_by_name}
                        </div>
                      )}
                    </>
                  ) : (
                    <span style={{ fontSize: 11, color: '#c7c7c7' }}>—</span>
                  )}
                </td>
                <td style={{ padding: '10px 12px' }}>
                  {/* Reads binding_mode, never "has a handover_id". A vendor or
                      multi-project group is fully decided and deliberately
                      carries no project — inferring "unbound" from the missing
                      project would put it back in the queue forever. */}
                  {g.binding_mode ? (
                    <div>
                      <span style={{
                        display: 'inline-block', padding: '2px 7px', borderRadius: 4,
                        fontSize: 11, fontWeight: 600,
                        background: (BINDING[g.binding_status] || BINDING.bound).bg,
                        color:      (BINDING[g.binding_status] || BINDING.bound).fg,
                      }}>{(BINDING[g.binding_status] || BINDING.bound).label}</span>
                      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 3 }}>
                        {g.binding_mode === 'project' && (g.project_name || `#${g.handover_id}`)}
                        {g.binding_mode === 'account' && (g.bound_account_name || 'vendor')}
                        {g.binding_mode === 'pool' && `${g.candidate_count || 0} project${g.candidate_count === 1 ? '' : 's'}`}
                      </div>
                      {g.binding_mode !== 'project' && (
                        <div style={{ fontSize: 10, color: '#92400e', marginTop: 2 }}>
                          messages wait to be filed
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                        <button style={{ ...GHOST, fontSize: 11, padding: '2px 8px' }}
                          disabled={busy} onClick={() => openBind(g)}>Change</button>
                        <button style={{ ...GHOST, fontSize: 11, padding: '2px 8px' }}
                          disabled={busy} onClick={() => doUnbind(g)}>Remove</button>
                      </div>
                    </div>
                  ) : g.handover_id ? (
                    // Bound before Phase 1: a thread project with no binding row.
                    // Legacy behaviour is unchanged for these, and they are left
                    // alone until somebody decides otherwise.
                    <div>
                      <span style={{ color: '#374151' }}>{g.project_name || `#${g.handover_id}`}</span>
                      <div>
                        <button style={{ ...GHOST, fontSize: 11, padding: '2px 8px', marginTop: 4 }}
                          disabled={busy} onClick={() => openBind(g)}>Change</button>
                      </div>
                    </div>
                  ) : g.id ? (
                    <button style={{ ...GHOST, fontSize: 12, padding: '4px 10px' }}
                      onClick={() => openBind(g)}>
                      Say what this is
                    </button>
                  ) : (
                    <span style={{ fontSize: 11, color: '#c7c7c7' }}>switch capture on first</span>
                  )}
                </td>
                <td style={{ padding: '10px 12px', color: '#6b7280', fontSize: 12 }}>
                  {g.last_message_at ? new Date(g.last_message_at).toLocaleDateString() : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {bindFor && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }}>
          <div style={{
            background: '#fff', borderRadius: 10, padding: 24, width: 520, maxWidth: '92vw',
            maxHeight: '88vh', overflowY: 'auto',
          }}>
            <h4 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600 }}>
              What is “{bindFor.subject || '(no name)'}”?
            </h4>
            <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 14px', lineHeight: 1.5 }}>
              How this group is organised decides what happens to its messages.
              {!bindFor.is_watched && ' Capture will also be switched on.'}
            </p>

            <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
              {MODES.map(m => (
                <label key={m.key} style={{
                  display: 'flex', gap: 9, alignItems: 'flex-start', padding: '9px 11px',
                  border: `1px solid ${bindMode === m.key ? '#1A3A5C' : '#e5e7eb'}`,
                  background: bindMode === m.key ? '#f8fafc' : '#fff',
                  borderRadius: 7, cursor: 'pointer',
                }}>
                  <input
                    type="radio" name="bindMode" value={m.key}
                    checked={bindMode === m.key}
                    onChange={() => { setBindMode(m.key); setConfirm(''); setError(''); }}
                    style={{ marginTop: 2 }}
                  />
                  <span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#1a202c' }}>{m.label}</span>
                    <span style={{ display: 'block', fontSize: 11, color: '#6b7280', marginTop: 2, lineHeight: 1.45 }}>
                      {m.hint}
                    </span>
                  </span>
                </label>
              ))}
            </div>

            {bindMode === 'project' && (
              <select
                style={{ ...INPUT, width: '100%', marginBottom: 16 }}
                value={handoverId}
                onChange={e => setHandoverId(e.target.value)}
              >
                <option value="">Choose a project…</option>
                {handovers.map(h => (
                  <option key={h.id} value={h.id}>{h.name || h.project_name || `Project #${h.id}`}</option>
                ))}
              </select>
            )}

            {bindMode === 'account' && (
              <div style={{ marginBottom: 16 }}>
                {/* Filtered to APPROVED vendors and partners — the server
                    validates the same thing, so an unfiltered list would only
                    offer choices it is about to refuse. */}
                <AccountPicker
                  value={accountId}
                  onChange={setAccountId}
                  disabled={busy}
                  onlyRelationships
                />
                <div style={{ fontSize: 11, color: '#6b7280', marginTop: 6, lineHeight: 1.45 }}>
                  The projects this vendor is on become the shortlist for filing messages later.
                  Attachments in this group are not saved until their message is filed.
                </div>
              </div>
            )}

            {bindMode === 'pool' && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, color: '#374151', marginBottom: 6 }}>
                  Which projects does this group cover?
                </div>
                <div style={{
                  border: '1px solid #d1d5db', borderRadius: 6, maxHeight: 190,
                  overflowY: 'auto', padding: '4px 0',
                }}>
                  {handovers.length === 0 && (
                    <div style={{ padding: '8px 10px', fontSize: 12, color: '#9ca3af' }}>No projects available.</div>
                  )}
                  {handovers.map(h => (
                    <label key={h.id} style={{
                      display: 'flex', gap: 8, alignItems: 'center',
                      padding: '5px 10px', fontSize: 12, cursor: 'pointer',
                    }}>
                      <input
                        type="checkbox"
                        checked={candidates.has(h.id)}
                        onChange={() => setCandidates(s => {
                          const n = new Set(s);
                          if (n.has(h.id)) n.delete(h.id); else n.add(h.id);
                          return n;
                        })}
                      />
                      {h.name || h.project_name || `Project #${h.id}`}
                    </label>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: '#6b7280', marginTop: 6 }}>
                  {candidates.size} selected. This is a shortlist, not an assignment — nothing is filed
                  to any of them automatically.
                </div>
              </div>
            )}

            {/* The server's own sentence, not one composed here. */}
            {confirm && (
              <div style={{
                background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e',
                padding: '9px 11px', borderRadius: 6, fontSize: 12, lineHeight: 1.5, marginBottom: 12,
              }}>
                {confirm}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button style={GHOST} disabled={busy} onClick={closeBind}>Cancel</button>
              {confirm ? (
                <button style={{ ...PRIMARY, opacity: busy ? 0.6 : 1 }} disabled={busy}
                  onClick={() => submitBind(true)}>
                  {busy ? 'Saving…' : 'Yes, change it'}
                </button>
              ) : (
                <button style={{ ...PRIMARY, opacity: busy ? 0.6 : 1 }} disabled={busy}
                  onClick={() => submitBind(false)}>
                  {busy ? 'Saving…' : 'Save'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, warn }) {
  return (
    <div>
      <div style={{ color: '#9ca3af' }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 600, color: warn ? '#92400e' : '#1a202c' }}>{value}</div>
    </div>
  );
}

function Banner({ tone, children }) {
  const s = tone === 'error'
    ? { background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b' }
    : { background: '#ecfdf5', border: '1px solid #a7f3d0', color: '#065f46' };
  return <div style={{ ...s, marginBottom: 12, padding: '8px 12px', borderRadius: 6, fontSize: 13 }}>{children}</div>;
}
