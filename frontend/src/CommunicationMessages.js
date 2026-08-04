/*
 * CommunicationMessages.js
 *
 * Communication → Messages. Org-level view of captured WhatsApp messages.
 *
 * WHY THIS SCREEN EXISTS
 *   Until now the only way to see a captured message was inside the project it
 *   had already been filed to — which is useless when the problem is that it
 *   was filed to the wrong one, or to none. You cannot find a mis-filed message
 *   by opening the project you think it should be in.
 *
 * WHAT MAKES IT SAFE
 *   Results are scoped to WhatsApp groups the user was actually a participant
 *   of, plus projects they belong to. A group participant can already read
 *   these messages on their phone, so retrieving them here grants nothing new.
 *   No role is involved for the common case.
 *
 * THE EMPTY STATE IS THE FEATURE
 *   When a search finds nothing we ask the server WHY and show the answer.
 *   "No results" for a message someone can see on their phone is how people
 *   decide a feature is broken. Most real misses are "that group isn't being
 *   captured", which no amount of re-searching will fix.
 */

import React, { useState, useCallback, useEffect } from 'react';
import { apiService } from './apiService';

const CARD    = { border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff' };
const BTN     = { padding: '6px 12px', borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: 'pointer', border: '1px solid transparent' };
const PRIMARY = { ...BTN, background: '#E8630A', color: '#fff' };
const GHOST   = { ...BTN, background: '#fff', color: '#374151', border: '1px solid #d1d5db' };
const INPUT   = { padding: '8px 11px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' };

const SCOPES = [
  { key: 'all',         label: 'Everything I can see' },
  { key: 'participant', label: 'Groups I am in' },
  { key: 'assigned',    label: 'My projects' },
  { key: 'unassigned',  label: 'Unassigned queue', stewardOnly: true },
];

export default function CommunicationMessages() {
  const [q,        setQ]        = useState('');
  const [from,     setFrom]     = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo,   setDateTo]   = useState('');
  const [scope,    setScope]    = useState('all');
  const [channel,  setChannel]  = useState('all');
  const [channels, setChannels] = useState([]);
  const [isDefault,setIsDefault]= useState(true);

  const [messages,  setMessages]  = useState([]);
  const [diagnosis, setDiagnosis] = useState(null);
  const [searched,  setSearched]  = useState(false);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState('');
  const [notice,    setNotice]    = useState('');

  const [identity,  setIdentity]  = useState(null);
  const [handovers, setHandovers] = useState([]);
  const [fileFor,   setFileFor]   = useState(null);
  const [target,    setTarget]    = useState('');
  const [fileScope, setFileScope] = useState('message');

  useEffect(() => {
    apiService.whatsappMessages.identity()
      .then(r => setIdentity(r.data))
      .catch(() => setIdentity({ linked: false }));
    apiService.handovers.list('all')
      .then(r => setHandovers(r.data?.handovers || r.data || []))
      .catch(() => setHandovers([]));
    apiService.whatsappMessages.channels()
      .then(r => setChannels(r.data?.channels || []))
      .catch(() => setChannels([]));
  }, []);

  const runSearch = useCallback(async () => {
    setLoading(true); setError(''); setNotice(''); setDiagnosis(null);
    try {
      const res = await apiService.whatsappMessages.search({
        ...(q && { q }), ...(from && { from }),
        ...(dateFrom && { dateFrom }), ...(dateTo && { dateTo }),
        scope, channel,
      });
      const found = res.data?.messages || [];
      setMessages(found);
      setIsDefault(!!res.data?.isDefaultView);
      setSearched(true);

      // Only pay for the diagnosis when it is needed — it costs several extra
      // queries and most searches succeed. Skip it on the default view: an
      // empty inbox is not a failed search and does not need explaining.
      if (found.length === 0 && !res.data?.isDefaultView) {
        const d = await apiService.whatsappMessages.diagnose({ q });
        setDiagnosis(d.data);
      }
    } catch (e) {
      setError(e?.response?.data?.error?.message || e?.response?.data?.error || 'Search failed.');
      setMessages([]);
    } finally {
      setLoading(false);
    }
  }, [q, from, dateFrom, dateTo, scope, channel]);

  // Open with recent traffic rather than an empty page. Someone arriving here
  // usually wants to see what came in, not to compose a query first.
  useEffect(() => { runSearch(); }, [channel]);   // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (fn, ok) => {
    setError(''); setNotice('');
    try {
      const r = await fn();
      setNotice(typeof ok === 'function' ? ok(r) : ok);
      setFileFor(null); setTarget('');
      await runSearch();
    } catch (e) {
      setError(e?.response?.data?.error || e?.response?.data?.error?.message || e.message);
    }
  };

  const doFile = () => {
    if (!target && target !== 'none') { setError('Choose a project, or "Unassigned".'); return; }
    act(
      () => apiService.whatsappMessages.file(fileFor.nativeId, {
        handoverId: target === 'none' ? null : Number(target),
        scope: fileScope,
      }),
      (r) => `${r.data.moved} message${r.data.moved === 1 ? '' : 's'} ${target === 'none' ? 'sent back to the unassigned queue' : 'filed'}.`
    );
  };

  const doExclude = (m) => {
    const reason = window.prompt('Why is this not CRM material? (optional)');
    if (reason === null) return;
    act(
      () => apiService.whatsappMessages.exclude(m.nativeId, { reason }),
      'Message excluded. It stays out of all project views and search, but is kept for audit.'
    );
  };

  const requestCapture = (g) => act(
    () => apiService.whatsappMessages.requestCapture({ sessionGroupId: g.id, reason: q ? `Looking for: ${q}` : null }),
    `Requested capture for "${g.subject}". An admin will review it.`
  );

  const isSteward = identity?.steward?.steward;

  return (
    <div style={{ maxWidth: 980 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 600, color: '#1a202c' }}>Messages</h3>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: '#6b7280', lineHeight: 1.5 }}>
        WhatsApp messages captured from groups you are in, and from projects you belong to.
        Find a message that landed in the wrong place and move it.
      </p>

      {identity && !identity.linked && (
        <Banner tone="warn">
          Your WhatsApp number has not been confirmed, so we cannot tell which groups you are in.
          Ask an org admin to set it before searching.
        </Banner>
      )}
      {error  && <Banner tone="error">{error}</Banner>}
      {notice && <Banner tone="ok">{notice}</Banner>}

      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {[{ channel: 'all', label: 'All', available: true }, ...channels].map(c => (
          <button
            key={c.channel}
            onClick={() => c.available && setChannel(c.channel)}
            disabled={!c.available}
            title={c.available ? '' : 'Not connected yet'}
            style={{
              ...BTN,
              background:  channel === c.channel ? '#1A3A5C' : '#fff',
              color:       !c.available ? '#c7c7c7' : channel === c.channel ? '#fff' : '#374151',
              border: `1px solid ${channel === c.channel ? '#1A3A5C' : '#d1d5db'}`,
              cursor: c.available ? 'pointer' : 'not-allowed',
            }}
          >
            {c.label}{!c.available && ' ·'}
          </button>
        ))}
      </div>

      <div style={{ ...CARD, padding: 14, marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <input
            style={{ ...INPUT, flex: '2 1 260px' }}
            placeholder="Words from the message…"
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && runSearch()}
          />
          <input
            style={{ ...INPUT, flex: '1 1 160px' }}
            placeholder="Sender name or number"
            value={from}
            onChange={e => setFrom(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && runSearch()}
          />
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input type="date" style={INPUT} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
          <span style={{ fontSize: 12, color: '#9ca3af' }}>to</span>
          <input type="date" style={INPUT} value={dateTo} onChange={e => setDateTo(e.target.value)} />
          <select style={{ ...INPUT, minWidth: 180 }} value={scope} onChange={e => setScope(e.target.value)}>
            {SCOPES.filter(s => !s.stewardOnly || isSteward).map(s => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
          <button style={{ ...PRIMARY, marginLeft: 'auto' }} disabled={loading} onClick={runSearch}>
            {loading ? 'Searching…' : 'Search'}
          </button>
        </div>
      </div>

      {searched && messages.length === 0 && diagnosis && (
        <Diagnosis diagnosis={diagnosis} onRequestCapture={requestCapture} />
      )}

      {messages.length > 0 && (
        <div style={{ ...CARD, overflow: 'hidden' }}>
          <div style={{ padding: '8px 14px', background: '#f9fafb', fontSize: 12, color: '#6b7280', borderBottom: '1px solid #e5e7eb' }}>
            {isDefault
              ? `${messages.length} most recent message${messages.length === 1 ? '' : 's'}`
              : `${messages.length} match${messages.length === 1 ? '' : 'es'}`}
          </div>
          {messages.map(m => (
            <div key={m.id} style={{ padding: '12px 14px', borderBottom: '1px solid #f3f4f6' }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 500, fontSize: 13, color: '#1a202c' }}>
                  {m.senderName || 'Unknown'}
                </span>
                <span style={{ fontSize: 12, color: '#9ca3af' }}>
                  {m.conversationName || m.conversationId || 'Direct'}
                </span>
                {channel === 'all' && (
                  <span style={{ fontSize: 10, color: '#6b7280', background: '#f3f4f6', padding: '1px 6px', borderRadius: 8 }}>
                    {m.channelLabel}
                  </span>
                )}
                <span style={{ fontSize: 12, color: '#9ca3af' }}>
                  {new Date(m.at).toLocaleString()}
                </span>
                <span style={{ marginLeft: 'auto' }}>
                  {m.handoverId
                    ? <Pill tone="ok">{m.projectName || `Project #${m.handoverId}`}</Pill>
                    : <Pill tone="warn">Unassigned</Pill>}
                </span>
              </div>
              <div style={{ fontSize: 13, color: '#374151', marginTop: 6, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                {m.body}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button style={{ ...GHOST, fontSize: 12, padding: '4px 10px' }}
                  onClick={() => { setFileFor(m); setTarget(''); setFileScope('message'); setError(''); }}>
                  {m.handoverId ? 'Move' : 'File to project'}
                </button>
                <button style={{ ...GHOST, fontSize: 12, padding: '4px 10px', color: '#991b1b', borderColor: '#fecaca' }}
                  onClick={() => doExclude(m)}>
                  Not CRM material
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {fileFor && (
        <Modal onClose={() => setFileFor(null)}>
          <h4 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600 }}>
            {fileFor.handoverId ? 'Move this message' : 'File this message'}
          </h4>
          <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 14px', lineHeight: 1.5 }}>
            From <strong>{fileFor.conversationName || 'this conversation'}</strong>
            {fileFor.handoverId && <>, currently on <strong>{fileFor.projectName || `#${fileFor.handoverId}`}</strong></>}.
          </p>

          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Destination</label>
          <select style={{ ...INPUT, width: '100%', marginBottom: 12 }} value={target} onChange={e => setTarget(e.target.value)}>
            <option value="">Choose…</option>
            {handovers.map(h => (
              <option key={h.id} value={h.id}>{h.name || h.project_name || `Project #${h.id}`}</option>
            ))}
            {fileFor.handoverId && <option value="none">— Unassigned queue —</option>}
          </select>

          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Apply to</label>
          <select style={{ ...INPUT, width: '100%', marginBottom: 6 }} value={fileScope} onChange={e => setFileScope(e.target.value)}>
            <option value="message">Just this message</option>
            <option value="thread">Every message filed the same way in this conversation</option>
          </select>
          <p style={{ fontSize: 11, color: '#9ca3af', margin: '0 0 16px', lineHeight: 1.5 }}>
            Choose the second option when the whole conversation belongs to one project — it also
            picks up the messages that were never filed anywhere.
          </p>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button style={GHOST} onClick={() => setFileFor(null)}>Cancel</button>
            <button style={PRIMARY} onClick={doFile}>Confirm</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* The empty state, which carries most of this screen's value. */
function Diagnosis({ diagnosis, onRequestCapture }) {
  const tone = { blocking: 'error', actionable: 'warn', informational: 'plain' };
  return (
    <div style={{ ...CARD, padding: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 500, color: '#1a202c', marginBottom: 10 }}>
        Nothing found — here is why
      </div>

      {(diagnosis.findings || []).map((f, i) => (
        <div key={i} style={{ marginBottom: 14 }}>
          <Banner tone={tone[f.severity] || 'plain'}>{f.message}</Banner>

          {f.code === 'NOT_CAPTURED' && (
            <div style={{ marginTop: 8 }}>
              {f.groups.map(g => (
                <div key={g.id} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                  border: '1px solid #f3f4f6', borderRadius: 6, marginBottom: 6,
                }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, color: '#1a202c' }}>{g.subject}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>
                      {g.participants != null ? `${g.participants} participants` : 'group'}
                    </div>
                  </div>
                  {g.requestPending
                    ? <span style={{ fontSize: 12, color: '#92400e' }}>Request pending</span>
                    : <button style={{ ...GHOST, fontSize: 12, padding: '4px 10px' }}
                        onClick={() => onRequestCapture(g)}>Request capture</button>}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      <div style={{ fontSize: 11, color: '#9ca3af', borderTop: '1px solid #f3f4f6', paddingTop: 10 }}>
        You are in {diagnosis.groups?.captured ?? 0} captured group
        {diagnosis.groups?.captured === 1 ? '' : 's'} and {diagnosis.groups?.uncaptured ?? 0} that
        {diagnosis.groups?.uncaptured === 1 ? ' is' : ' are'} not captured.
      </div>
    </div>
  );
}

function Pill({ tone, children }) {
  const s = tone === 'ok'
    ? { background: '#ecfdf5', color: '#065f46', border: '1px solid #a7f3d0' }
    : { background: '#fffbeb', color: '#92400e', border: '1px solid #fde68a' };
  return <span style={{ ...s, padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600 }}>{children}</span>;
}

function Banner({ tone, children }) {
  const map = {
    error: { background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b' },
    warn:  { background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e' },
    ok:    { background: '#ecfdf5', border: '1px solid #a7f3d0', color: '#065f46' },
    plain: { background: '#f9fafb', border: '1px solid #e5e7eb', color: '#374151' },
  };
  return <div style={{ ...(map[tone] || map.plain), marginBottom: 12, padding: '8px 12px', borderRadius: 6, fontSize: 13, lineHeight: 1.5 }}>{children}</div>;
}

function Modal({ children, onClose }) {
  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
      onClick={onClose}
    >
      <div style={{ background: '#fff', borderRadius: 10, padding: 24, width: 460, maxWidth: '90vw' }} onClick={e => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
