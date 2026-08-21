/*
 * MSTeamsConnect.js
 *
 * DROP-IN LOCATION: frontend/src/MSTeamsConnect.js
 *
 * Connect Microsoft Teams, then decide what is captured and where it files.
 *
 * WHAT CHANGED FROM THE PHASE 0 VERSION
 *   Capture is real now, so the screen has to show three things it previously
 *   could not, and each exists because of something measured in a live tenant:
 *
 *   KIND FILTER + HIDDEN COUNT. The pilot tenant returned 475 chats, 405 of
 *   them auto-created meeting chats. Rendering that unfiltered buried the ~66
 *   conversations anybody cares about. Meetings are hidden by default and the
 *   count is stated, because a list that silently drops 85% of its rows is
 *   worse than one that says so.
 *
 *   WATCHED IS NOT CAPTURING. A rep can tick a channel and have nothing arrive:
 *   a private channel they are not a member of, a subscription that failed to
 *   renew. Those are separate columns from the backend and separate badges
 *   here. Showing only the tick is how a conversation sits ticked and silently
 *   empty for a fortnight.
 *
 *   BINDING. Watching says "keep this"; binding says "and it belongs to THIS".
 *   Three modes, same vocabulary as the WhatsApp triage screen, because they
 *   are the same decision on a different transport.
 *
 * WHY THE BIND DIALOG ASKS RATHER THAN GUESSES
 *   A conversation covering several projects is common and 2026_108 handles it
 *   explicitly — pool mode attributes on reply context and then STOPS rather
 *   than guessing. That only works if a human declares which projects are in
 *   play, which is what the pool option collects.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { apiService } from './apiService';

const CARD    = { border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff' };
const BTN     = { padding: '6px 12px', borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: 'pointer', border: '1px solid transparent' };
const PRIMARY = { ...BTN, background: '#E8630A', color: '#fff' };
const GHOST   = { ...BTN, background: '#fff', color: '#374151', border: '1px solid #d1d5db' };
const INPUT   = { padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' };
const PILL    = { fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, whiteSpace: 'nowrap' };

const KIND = {
  oneOnOne: { label: 'Direct',  bg: '#f3f4f6', fg: '#6b7280' },
  group:    { label: 'Group',   bg: '#eff6ff', fg: '#1e40af' },
  meeting:  { label: 'Meeting', bg: '#fdf4ff', fg: '#6b21a8' },
  channel:  { label: 'Channel', bg: '#ecfdf5', fg: '#065f46' },
};

const STATUS_FILTERS = [
  { key: 'all',       label: 'All' },
  { key: 'watching',  label: 'Capturing' },
  { key: 'unwatched', label: 'Not capturing' },
  { key: 'ignored',   label: 'Dismissed' },
];

const KIND_FILTERS = [
  { key: 'group',    label: 'Group chats' },
  { key: 'oneOnOne', label: 'Direct' },
  { key: 'channel',  label: 'Channels' },
  { key: 'meeting',  label: 'Meetings' },
];

const STATUS_COPY = {
  consent_required: {
    tone: 'warn',
    title: 'Teams permissions need approval again',
    body:  'The permissions this integration asks for changed, or were withdrawn at your organisation. Reconnecting will ask for them again — if it fails, your Microsoft 365 administrator has to approve them first.',
  },
  token_expired: {
    tone: 'warn',
    title: 'Temporarily unable to reach Teams',
    body:  'The connection could not be refreshed. This usually clears by itself within the hour. If it is still here tomorrow, reconnect.',
  },
  revoked: {
    tone: 'error',
    title: 'Access to Teams was withdrawn',
    body:  'Microsoft no longer accepts this connection — usually a password change, or an administrator revoking app access. Reconnect to restore it.',
  },
  // No 'disconnected' entry. That state gets its own view rather than a banner
  // over the connected card, because unlike the three above it has no token,
  // no fetched list, and nothing to act on except reconnecting. Adding it back
  // here would resurrect the bug where the card below claimed to be connected.
};

const TONE = {
  warn:  { bg: '#fffbeb', border: '#fde68a', fg: '#92400e' },
  error: { bg: '#fef2f2', border: '#fecaca', fg: '#991b1b' },
  info:  { bg: '#f9fafb', border: '#e5e7eb', fg: '#374151' },
};

function timeAgo(iso) {
  if (!iso) return null;
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * Pull a displayable string out of whatever an API error turns out to be.
 *
 * This exists because getting it wrong crashes the app rather than showing a
 * message. The backend uses two shapes — {error: 'text'} from the msteams
 * service and {error: {message: 'text'}} from the route's catch — and a naive
 *
 *     d?.error || d?.error?.message || err.message
 *
 * short-circuits on the OBJECT in the second shape, because an object is
 * truthy. That object then reaches JSX as a child and React throws #31,
 * swallowing the very server message that would have explained the failure.
 */
function errText(err, fallback = 'Something went wrong.') {
  const d = err?.response?.data;
  const candidates = [
    typeof d?.error === 'string' ? d.error : null,
    d?.error?.message,
    d?.message,
    typeof d === 'string' ? d : null,
    err?.message,
  ];
  const found = candidates.find(v => typeof v === 'string' && v.trim());
  return found || fallback;
}

/* ── Bind dialog ─────────────────────────────────────────────────────────── */

function BindDialog({ conversation, projects, vendors, onClose, onDone }) {
  const [mode, setMode]         = useState('project');
  const [handoverId, setH]      = useState('');
  const [accountId, setA]       = useState('');
  const [candidates, setCands]  = useState([]);
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState('');
  // NEEDS_FORCE is not a failure — it is the server asking to confirm a
  // transition that loses something. Held separately so the retry carries
  // force: true rather than the user wondering why nothing happened.
  const [confirm, setConfirm]   = useState('');

  const submit = async (force = false) => {
    setBusy(true); setError('');
    try {
      const body = { mode, force };
      if (mode === 'project') body.handoverId = parseInt(handoverId, 10);
      if (mode === 'account') body.accountId  = parseInt(accountId, 10);
      if (mode === 'pool')    body.candidateIds = candidates;

      const { data } = await apiService.msteams.bind(conversation.id, body);
      onDone(data);
    } catch (err) {
      const d = err.response?.data;
      if (d?.code === 'NEEDS_FORCE') { setConfirm(errText(err)); setBusy(false); return; }
      setError(errText(err, 'Could not link this conversation.'));
      setBusy(false);
    }
  };

  const canSubmit = mode === 'project' ? !!handoverId
                  : mode === 'account' ? !!accountId
                  : candidates.length > 0;

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <div style={{ ...CARD, width: 520, maxWidth: '92vw', maxHeight: '86vh', overflowY: 'auto', padding: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: '#111827' }}>
          What is this conversation about?
        </div>
        <div style={{ fontSize: 13, color: '#6b7280', marginTop: 4, marginBottom: 16 }}>
          {conversation.display_name}
        </div>

        {confirm && (
          <div style={{ ...CARD, padding: 12, marginBottom: 14, background: TONE.warn.bg, borderColor: TONE.warn.border, color: TONE.warn.fg, fontSize: 13, lineHeight: 1.6 }}>
            {confirm}
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button style={PRIMARY} disabled={busy} onClick={() => submit(true)}>Yes, change it</button>
              <button style={GHOST} onClick={() => setConfirm('')}>Cancel</button>
            </div>
          </div>
        )}

        {error && (
          <div style={{ ...CARD, padding: 10, marginBottom: 12, background: TONE.error.bg, borderColor: TONE.error.border, color: TONE.error.fg, fontSize: 13 }}>
            {error}
          </div>
        )}

        {!confirm && (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
              {[
                { key: 'project', title: 'One project',
                  hint: 'Everything said here belongs to that project, including what was said before now.' },
                { key: 'account', title: 'A vendor or partner',
                  hint: 'Organised around a company rather than a project. Messages file per-thread, not all to one project.' },
                { key: 'pool', title: 'Several projects',
                  hint: 'An internal conversation covering more than one. Messages that cannot be placed confidently stay unassigned rather than being guessed at.' },
              ].map(o => (
                <label key={o.key} style={{
                  display: 'flex', gap: 10, padding: 10, borderRadius: 6, cursor: 'pointer',
                  border: `1px solid ${mode === o.key ? '#E8630A' : '#e5e7eb'}`,
                  background: mode === o.key ? '#fff7ed' : '#fff',
                }}>
                  <input type="radio" checked={mode === o.key} onChange={() => setMode(o.key)} style={{ marginTop: 3 }} />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>{o.title}</div>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2, lineHeight: 1.5 }}>{o.hint}</div>
                  </div>
                </label>
              ))}
            </div>

            {mode === 'project' && (
              <select style={{ ...INPUT, width: '100%' }} value={handoverId} onChange={e => setH(e.target.value)}>
                <option value="">Pick a project…</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name || `Project ${p.id}`}</option>)}
              </select>
            )}

            {mode === 'account' && (
              <select style={{ ...INPUT, width: '100%' }} value={accountId} onChange={e => setA(e.target.value)}>
                <option value="">Pick a vendor or partner…</option>
                {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            )}

            {mode === 'pool' && (
              <div style={{ ...CARD, maxHeight: 200, overflowY: 'auto', padding: 8 }}>
                {projects.length === 0 && (
                  <div style={{ fontSize: 13, color: '#9ca3af', padding: 8 }}>No projects available.</div>
                )}
                {projects.map(p => (
                  <label key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '5px 4px', fontSize: 13, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={candidates.includes(p.id)}
                      onChange={() => setCands(c => c.includes(p.id) ? c.filter(x => x !== p.id) : [...c, p.id])}
                    />
                    {p.name || `Project ${p.id}`}
                  </label>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: 'flex-end' }}>
              <button style={GHOST} onClick={onClose} disabled={busy}>Cancel</button>
              <button style={PRIMARY} onClick={() => submit(false)} disabled={busy || !canSubmit}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ── Main ────────────────────────────────────────────────────────────────── */

export default function MSTeamsConnect() {
  const [status,  setStatus]  = useState(null);
  const [convs,   setConvs]   = useState([]);
  const [counts,  setCounts]  = useState(null);
  const [projects, setProjects] = useState([]);
  const [vendors,  setVendors]  = useState([]);

  const [loading, setLoading] = useState(true);
  const [busy,    setBusy]    = useState(false);
  const [error,   setError]   = useState('');
  const [notice,  setNotice]  = useState('');

  const [statusFilter, setStatusFilter] = useState('all');
  const [kinds,        setKinds]        = useState([]);   // empty = default (meetings hidden)
  const [search,       setSearch]       = useState('');
  const [selected,     setSelected]     = useState(() => new Set());
  const [binding,      setBinding]      = useState(null);

  const load = useCallback(async (kindList = kinds) => {
    setError('');
    try {
      const s = await apiService.msteams.status();
      setStatus(s.data);

      if (s.data?.status && s.data.status !== 'disconnected') {
        const params = {};
        if (kindList.length) params.kinds = kindList.join(',');
        const c = await apiService.msteams.conversations(params);
        setConvs(c.data?.conversations || []);
        setCounts(c.data?.counts || null);
      } else {
        setConvs([]); setCounts(null);
      }
    } catch (err) {
      if (err.response?.status === 404) { setStatus({ connected: false }); setConvs([]); }
      else setError(errText(err));
    } finally {
      setLoading(false);
    }
  }, [kinds]);

  useEffect(() => { load(); }, [load]);

  // Projects and vendors are only needed by the bind dialog, so they load once
  // and quietly. A failure here must not break triage — you can still capture
  // and dismiss without ever linking anything.
  useEffect(() => {
    (async () => {
      try {
        // Positional args: (scope, status, kind). Default scope 'mine' is what
        // a rep should be linking to — binding a conversation to a project they
        // cannot see would produce a row they then cannot open.
        const p = await apiService.handovers.list();
        const rows = p?.data?.handovers || p?.data?.items || p?.data || [];
        setProjects(Array.isArray(rows) ? rows : []);
      } catch { /* bind dialog degrades to an empty list */ }
      try {
        const v = await apiService.accountRelationships.vendors();
        const rows = v?.data?.vendors || v?.data || [];
        setVendors(Array.isArray(rows) ? rows : []);
      } catch { /* same */ }
    })();
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('msteams_connected')) {
      setNotice('Teams connected. Finding your conversations…');
      params.delete('msteams_connected');
    } else if (params.get('msteams_admin_consent') === 'granted') {
      setNotice('Your organisation approved the Teams integration. Reps can connect now.');
      params.delete('msteams_admin_consent'); params.delete('tenant');
    } else if (params.get('msteams_error')) {
      setError(params.get('message') || `Teams connection failed: ${params.get('msteams_error')}`);
      params.delete('msteams_error'); params.delete('message');
    } else return;
    const qs = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
  }, []);

  const run = async (fn, ok) => {
    setBusy(true); setError(''); setNotice('');
    try { const r = await fn(); if (ok) setNotice(ok(r)); await load(); }
    catch (err) { setError(errText(err)); }
    finally { setBusy(false); }
  };

  const connect = async () => {
    setBusy(true); setError('');
    try {
      const { data } = await apiService.msteams.connect();
      window.location.href = data.authUrl;
    } catch (err) { setError(errText(err)); setBusy(false); }
  };

  const adminConsent = () => run(
    async () => {
      const { data } = await apiService.msteams.adminConsentUrl();
      window.open(data.url, '_blank', 'noopener');
    },
    () => 'Opened the approval page. Your Microsoft 365 administrator signs in there and approves once for the whole organisation.'
  );

  const discover = () => run(
    () => apiService.msteams.discover(),
    (r) => `Found ${r.data.chatCount} chats and ${r.data.channelCount} channels.` +
           (r.data.warnings?.length ? ' Some could not be read — see below.' : '')
  );

  const applyWatch = (watched) => run(
    async () => {
      const { data } = await apiService.msteams.watch({ conversationIds: [...selected], watched });
      setSelected(new Set());
      return data;
    },
    (r) => {
      const failed = (r.updated || []).filter(u => u.is_watched && u.capturing === false);
      if (!watched) return 'Capture stopped.';
      if (failed.length) {
        // Never claim capture started when it did not. The most common cause is
        // a private channel the rep is not a member of, and the remedy is
        // theirs to action.
        return `Capture started for ${(r.updated || []).length - failed.length}. ` +
               `${failed.length} could not start: ${failed[0].error || 'see the row for details'}`;
      }
      return 'Capture started.';
    }
  );

  const applyIgnore = (ignored) => run(
    async () => {
      const { data } = await apiService.msteams.ignore({ conversationIds: [...selected], ignored });
      setSelected(new Set());
      return data;
    },
    () => (ignored ? 'Dismissed.' : 'Restored to the list.')
  );

  const unbind = (id) => run(
    () => apiService.msteams.unbind(id),
    () => 'Link removed. Messages already filed to a project stay where they are.'
  );

  const toggleKind = (k) => {
    const next = kinds.includes(k) ? kinds.filter(x => x !== k) : [...kinds, k];
    setKinds(next);
    setSelected(new Set());
    load(next);
  };

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return convs.filter(c => {
      if (statusFilter === 'watching'  && !c.is_watched) return false;
      if (statusFilter === 'unwatched' && (c.is_watched || c.binding_status === 'ignored')) return false;
      if (statusFilter === 'ignored'   && c.binding_status !== 'ignored') return false;
      if (statusFilter === 'all'       && c.binding_status === 'ignored') return false;
      if (!q) return true;
      return [c.display_name, c.topic, c.team_name].filter(Boolean)
        .some(s => s.toLowerCase().includes(q));
    });
  }, [convs, statusFilter, search]);

  const toggle = (id) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  if (loading) return <div style={{ padding: 24, fontSize: 13, color: '#6b7280' }}>Loading Teams…</div>;

  const statusCopy = status?.status && status.status !== 'connected' ? STATUS_COPY[status.status] : null;
  const meetingsHidden = !kinds.length && counts ? counts.meetings : 0;

  // 'disconnected' is a truthy status, which is why gating the card below on
  // `status?.status` alone rendered the connected view — counts, Refresh and
  // Disconnect — underneath a banner saying the opposite.
  //
  // It is its own state, not merely "degraded". consent_required, token_expired
  // and revoked all still have a usable connection row and a conversation list
  // worth showing; disconnected has no token at all, so Refresh would fail and
  // the list was never fetched. Everything except the reconnect prompt is
  // hidden, and what was RETAINED is stated — because the whole point of
  // keeping those rows is that the rep does not lose their triage, and they can
  // only be reassured of that if somebody tells them.
  const isDisconnected = status?.status === 'disconnected';
  const isLive = !!status?.status && !isDisconnected;

  return (
    <div>
      <p style={{ fontSize: 14, color: '#6b7280', marginBottom: 20, lineHeight: 1.6 }}>
        Connect Microsoft Teams to bring project conversations in alongside email and
        WhatsApp. GoWarmCRM reads as <strong>you</strong> — it sees the chats and
        channels you are already in, and nothing else. It never sends.
      </p>

      {error && (
        <div style={{ ...CARD, padding: 12, marginBottom: 16, background: TONE.error.bg, borderColor: TONE.error.border, color: TONE.error.fg, fontSize: 13 }}>
          {error}
        </div>
      )}
      {notice && !error && (
        <div style={{ ...CARD, padding: 12, marginBottom: 16, background: '#ecfdf5', borderColor: '#a7f3d0', color: '#065f46', fontSize: 13 }}>
          {notice}
        </div>
      )}

      {!status?.status && (
        <div style={{ ...CARD, padding: 20 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: '#111827', marginBottom: 6 }}>
            Teams is not connected
          </div>
          <div style={{ fontSize: 13, color: '#6b7280', lineHeight: 1.6, marginBottom: 16 }}>
            You will be asked to sign in with your work Microsoft account and approve
            read access to your Teams chats and channels. Make sure you pick your{' '}
            <strong>work</strong> account — a personal Microsoft account has no Teams
            chats and will connect to an empty list.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={PRIMARY} onClick={connect} disabled={busy}>
              {busy ? 'Opening…' : 'Connect Teams'}
            </button>
            <button style={GHOST} onClick={adminConsent} disabled={busy}>
              Get administrator approval
            </button>
          </div>
          <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 10, lineHeight: 1.6 }}>
            Reading Teams <em>channels</em> requires a one-time approval from your Microsoft 365
            administrator. If connecting fails with a permissions error, send them that second link.
          </div>
        </div>
      )}

      {isDisconnected && (
        <div style={{ ...CARD, padding: 20 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: '#111827', marginBottom: 6 }}>
            Teams is disconnected
          </div>
          <div style={{ fontSize: 13, color: '#6b7280', lineHeight: 1.6, marginBottom: 4 }}>
            Nothing is being captured. Your conversations and what you chose to capture have
            been kept, so reconnecting picks up exactly where you left off.
          </div>
          {(status.chatCount > 0 || status.channelCount > 0) && (
            <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 16 }}>
              {status.chatCount || 0} chats and {status.channelCount || 0} channels are still on file
              from {status.displayName || status.upn || 'your last connection'}.
            </div>
          )}
          <button style={PRIMARY} onClick={connect} disabled={busy}>
            {busy ? 'Opening…' : 'Reconnect Teams'}
          </button>
        </div>
      )}

      {isLive && (
        <>
          {statusCopy && (
            <div style={{ ...CARD, padding: 14, marginBottom: 16, background: TONE[statusCopy.tone].bg, borderColor: TONE[statusCopy.tone].border }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: TONE[statusCopy.tone].fg }}>{statusCopy.title}</div>
              <div style={{ fontSize: 13, color: TONE[statusCopy.tone].fg, marginTop: 4, lineHeight: 1.6 }}>{statusCopy.body}</div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button style={PRIMARY} onClick={connect} disabled={busy}>Reconnect</button>
                {status.status === 'consent_required' && (
                  <button style={GHOST} onClick={adminConsent} disabled={busy}>Get administrator approval</button>
                )}
              </div>
            </div>
          )}

          <div style={{ ...CARD, padding: 16, marginBottom: 16, display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'center' }}>
            <div style={{ flex: '1 1 200px' }}>
              <div style={{ fontSize: 11, textTransform: 'uppercase', color: '#94a3b8', fontWeight: 600 }}>Connected as</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#374151', marginTop: 2 }}>
                {status.displayName || status.upn || '—'}
              </div>
              {status.upn && status.displayName && (
                <div style={{ fontSize: 12, color: '#9ca3af' }}>{status.upn}</div>
              )}
            </div>
            <div>
              <div style={{ fontSize: 11, textTransform: 'uppercase', color: '#94a3b8', fontWeight: 600 }}>Found</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#374151', marginTop: 2 }}>
                {status.chatCount || 0} chats · {status.channelCount || 0} channels
              </div>
              <div style={{ fontSize: 12, color: '#9ca3af' }}>
                {status.lastDiscoveryAt ? `Refreshed ${timeAgo(status.lastDiscoveryAt)}` : 'Not refreshed yet'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
              <button style={GHOST} onClick={discover} disabled={busy}>
                {busy ? 'Refreshing…' : 'Refresh list'}
              </button>
              <button style={GHOST} disabled={busy}
                onClick={() => { if (window.confirm('Disconnect Teams? What you chose to capture is kept, and reconnecting picks up where you left off.')) run(() => apiService.msteams.disconnect(), () => 'Teams disconnected.'); }}>
                Disconnect
              </button>
            </div>
          </div>

          {status.lastDiscoveryError && (
            <div style={{ ...CARD, padding: 12, marginBottom: 16, background: TONE.warn.bg, borderColor: TONE.warn.border, color: TONE.warn.fg, fontSize: 13, lineHeight: 1.6 }}>
              <strong>Some conversations could not be read.</strong> The rest of the list is complete.
              <div style={{ fontFamily: 'monospace', fontSize: 12, marginTop: 6, opacity: 0.9 }}>
                {status.lastDiscoveryError}
              </div>
            </div>
          )}

          {/* ── Filters ─────────────────────────────────────────────── */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
            {STATUS_FILTERS.map(f => (
              <button key={f.key} onClick={() => setStatusFilter(f.key)} style={{
                ...BTN,
                background: statusFilter === f.key ? '#1A3A5C' : '#fff',
                color:      statusFilter === f.key ? '#fff' : '#374151',
                border: `1px solid ${statusFilter === f.key ? '#1A3A5C' : '#d1d5db'}`,
              }}>{f.label}</button>
            ))}
            <input style={{ ...INPUT, marginLeft: 'auto', minWidth: 220 }}
                   placeholder="Search conversations, teams…"
                   value={search} onChange={e => setSearch(e.target.value)} />
          </div>

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontSize: 12, color: '#9ca3af', marginRight: 4 }}>Show:</span>
            {KIND_FILTERS.map(f => (
              <button key={f.key} onClick={() => toggleKind(f.key)} style={{
                ...BTN, padding: '4px 10px', fontSize: 12,
                background: kinds.includes(f.key) ? '#fff7ed' : '#fff',
                color:      kinds.includes(f.key) ? '#9a3412' : '#6b7280',
                border: `1px solid ${kinds.includes(f.key) ? '#fdba74' : '#e5e7eb'}`,
              }}>{f.label}</button>
            ))}
          </div>

          {/* Saying how many are hidden, rather than quietly dropping 85% of
              the list. Clicking through is one tap. */}
          {meetingsHidden > 0 && (
            <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 10 }}>
              {counts.total} conversations · {counts.watched} capturing · {counts.ignored} dismissed ·{' '}
              <button onClick={() => toggleKind('meeting')} style={{
                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                color: '#2563eb', fontSize: 12, textDecoration: 'underline',
              }}>
                {meetingsHidden} meeting chats hidden
              </button>
            </div>
          )}

          {selected.size > 0 && (
            <div style={{ ...CARD, padding: 12, marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center', background: '#f9fafb', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, color: '#374151', fontWeight: 500 }}>{selected.size} selected</span>
              <div style={{ display: 'flex', gap: 8, marginLeft: 'auto', flexWrap: 'wrap' }}>
                <button style={PRIMARY} onClick={() => applyWatch(true)}  disabled={busy}>Start capturing</button>
                <button style={GHOST}   onClick={() => applyWatch(false)} disabled={busy}>Stop capturing</button>
                <button style={GHOST}   onClick={() => applyIgnore(true)} disabled={busy}>Dismiss</button>
                {statusFilter === 'ignored' && (
                  <button style={GHOST} onClick={() => applyIgnore(false)} disabled={busy}>Restore</button>
                )}
                <button style={GHOST} onClick={() => setSelected(new Set())}>Clear</button>
              </div>
            </div>
          )}

          {/* ── Rows ────────────────────────────────────────────────── */}
          <div style={{ ...CARD, overflow: 'hidden' }}>
            {visible.length === 0 ? (
              <div style={{ padding: 24, fontSize: 13, color: '#9ca3af', textAlign: 'center' }}>
                {convs.length === 0 ? 'No conversations found yet. Press Refresh list.' : 'Nothing matches that filter.'}
              </div>
            ) : visible.map((c, i) => {
              const kind = KIND[c.kind] || KIND.group;
              const unreadable = c.is_readable === false;
              const stalled = c.is_watched && !c.is_capturing;

              return (
                <div key={c.id} style={{
                  borderTop: i === 0 ? 'none' : '1px solid #f3f4f6',
                  padding: '10px 14px',
                  opacity: c.binding_status === 'ignored' ? 0.55 : 1,
                  background: selected.has(c.id) ? '#fff7ed' : '#fff',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <input type="checkbox" checked={selected.has(c.id)}
                           onChange={() => toggle(c.id)} disabled={unreadable}
                           style={{ cursor: unreadable ? 'not-allowed' : 'pointer' }} />

                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.display_name || c.topic || c.graph_id}
                      </div>
                      <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
                        {c.member_count ? `${c.member_count} members · ` : ''}
                        {c.message_count ? `${c.message_count} captured · ` : ''}
                        {c.last_activity_at ? `active ${timeAgo(c.last_activity_at)}` : 'no recent activity'}
                      </div>
                    </div>

                    <span style={{ ...PILL, background: kind.bg, color: kind.fg }}>{kind.label}</span>
                    {c.membership_type === 'private' && (
                      <span style={{ ...PILL, background: '#f3f4f6', color: '#6b7280' }}>Private</span>
                    )}

                    {/* Watched and capturing are separate facts. A row that is
                        ticked but not receiving says so plainly. */}
                    {c.is_capturing && (
                      <span style={{ ...PILL, background: '#ecfdf5', color: '#065f46' }}>Capturing</span>
                    )}
                    {stalled && (
                      <span style={{ ...PILL, background: '#fffbeb', color: '#92400e' }}>Not receiving</span>
                    )}

                    {c.bound_handover_id && (
                      <span style={{ ...PILL, background: '#eff6ff', color: '#1e40af' }}>
                        {c.bound_project_name || 'Project'}
                      </span>
                    )}
                    {c.binding_mode === 'account' && (
                      <span style={{ ...PILL, background: '#fdf4ff', color: '#6b21a8' }}>
                        {c.bound_account_name || 'Vendor'}
                      </span>
                    )}
                    {c.binding_mode === 'pool' && (
                      <span style={{ ...PILL, background: '#fdf4ff', color: '#6b21a8' }}>
                        {c.candidate_count || 0} projects
                      </span>
                    )}

                    {!unreadable && (
                      <button style={{ ...GHOST, padding: '4px 10px', fontSize: 12 }} disabled={busy}
                              onClick={() => setBinding(c)}>
                        {c.binding_mode ? 'Change' : 'Link'}
                      </button>
                    )}
                    {c.binding_mode && (
                      <button style={{ ...GHOST, padding: '4px 8px', fontSize: 12 }} disabled={busy}
                              onClick={() => unbind(c.id)}>Unlink</button>
                    )}
                    {c.web_url && (
                      <a href={c.web_url} target="_blank" rel="noopener noreferrer"
                         style={{ fontSize: 12, color: '#2563eb', textDecoration: 'none' }}>Open</a>
                    )}
                  </div>

                  {/* The reason, not just the greyed-out row. The remedy —
                      ask a channel owner to add you — is only actionable if
                      somebody is told what it is. */}
                  {unreadable && (
                    <div style={{ fontSize: 12, color: '#92400e', background: TONE.warn.bg,
                                  border: `1px solid ${TONE.warn.border}`, borderRadius: 6,
                                  padding: '6px 10px', marginTop: 8, lineHeight: 1.5 }}>
                      {c.readability_error || 'This conversation cannot be read with your account.'}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {binding && (
        <BindDialog
          conversation={binding}
          projects={projects}
          vendors={vendors}
          onClose={() => setBinding(null)}
          onDone={(r) => {
            setBinding(null);
            setNotice(
              r.backfilled
                ? `Linked. ${r.backfilled} earlier message${r.backfilled === 1 ? '' : 's'} filed to the project.`
                : 'Linked.'
            );
            load();
          }}
        />
      )}
    </div>
  );
}
