/*
 * MSTeamsConnect.js
 *
 * DROP-IN LOCATION: frontend/src/MSTeamsConnect.js
 *
 * Microsoft Teams, phase 0: connect an account, then decide what is worth
 * capturing. Nothing is captured yet — 2026_126 is what makes "watched" mean
 * something.
 *
 * WHY TRIAGE EXISTS BEFORE CAPTURE DOES
 *   The alternative is shipping capture and triage together, which means the
 *   day it goes live every message from every chat arrives at once into an
 *   untriaged pile. Letting people decide first means the watchlist is already
 *   right when capture starts. The copy in this screen says plainly that
 *   nothing is being stored yet, because a screen with a "Watch" button that
 *   silently does nothing is worse than no screen.
 *
 * WHY THIS IS PER-REP AND NOT AN ADMIN GRID
 *   A rep's Teams token can see exactly what that rep can see. Two people in
 *   the same channel each get their own row and each decides for themselves —
 *   that follows from the delegated design rather than being a policy choice.
 *   Consequently this screen shows YOUR conversations, and an admin looking at
 *   it sees their own, not the org's.
 *
 * TWO KINDS OF DECISION, same as the WhatsApp triage screen:
 *   WATCH  — retain what is said here (once capture exists).
 *   IGNORE — this is not project traffic; stop showing it to me.
 *
 * Binding — "is this ONE project, a vendor, or SEVERAL projects" — is
 * deliberately absent here. It arrives with capture in phase 1, because binding
 * a conversation nothing is captured from would be a decision with no effect,
 * displayed as though it had one.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { apiService } from './apiService';

const CARD    = { border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff' };
const BTN     = { padding: '6px 12px', borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: 'pointer', border: '1px solid transparent' };
const PRIMARY = { ...BTN, background: '#E8630A', color: '#fff' };
const GHOST   = { ...BTN, background: '#fff', color: '#374151', border: '1px solid #d1d5db' };
const INPUT   = { padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' };

const KIND = {
  oneOnOne: { label: 'Direct',  bg: '#f3f4f6', fg: '#6b7280' },
  group:    { label: 'Group',   bg: '#eff6ff', fg: '#1e40af' },
  meeting:  { label: 'Meeting', bg: '#fdf4ff', fg: '#6b21a8' },
  channel:  { label: 'Channel', bg: '#ecfdf5', fg: '#065f46' },
};

const FILTERS = [
  { key: 'all',       label: 'All' },
  { key: 'watched',   label: 'Watching' },
  { key: 'unwatched', label: 'Not watching' },
  { key: 'ignored',   label: 'Dismissed' },
];

/**
 * Connection states the rep can actually do something about.
 *
 * Each carries its own remedy sentence rather than a generic "reconnect",
 * because the three failures need different actions: a withdrawn consent needs
 * the tenant admin, an expired token needs nothing but time, and a revoked
 * grant needs the rep. Telling everyone to reconnect sends two-thirds of them
 * down a path that cannot fix their problem.
 */
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
  disconnected: {
    tone: 'info',
    title: 'Teams is disconnected',
    body:  'Your chats and channels, and what you chose to watch, have been kept. Reconnecting picks up where you left off.',
  },
};

const TONE = {
  warn:  { bg: '#fffbeb', border: '#fde68a', fg: '#92400e' },
  error: { bg: '#fef2f2', border: '#fecaca', fg: '#991b1b' },
  info:  { bg: '#f9fafb', border: '#e5e7eb', fg: '#374151' },
};

function timeAgo(iso) {
  if (!iso) return null;
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1)   return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function MSTeamsConnect() {
  const [status,   setStatus]   = useState(null);
  const [convs,    setConvs]    = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [busy,     setBusy]     = useState(false);
  const [error,    setError]    = useState('');
  const [notice,   setNotice]   = useState('');

  const [filter,   setFilter]   = useState('all');
  const [search,   setSearch]   = useState('');
  const [selected, setSelected] = useState(() => new Set());

  const load = useCallback(async () => {
    setError('');
    try {
      const s = await apiService.msteams.status();
      setStatus(s.data);

      if (s.data?.status && s.data.status !== 'disconnected') {
        const c = await apiService.msteams.conversations({});
        setConvs(c.data?.conversations || []);
      } else {
        setConvs([]);
      }
    } catch (err) {
      // A 404 means "never connected", which is the normal first visit and not
      // an error worth showing in red.
      if (err.response?.status === 404) {
        setStatus({ connected: false });
        setConvs([]);
      } else {
        setError(err.response?.data?.error?.message || err.message);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // The OAuth round trip lands back on the app root with a query flag rather
  // than here, because the callback has no idea which screen started it. Read
  // it once, say something, and strip it so a refresh does not repeat the
  // message.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('msteams_connected')) {
      setNotice('Teams connected. Finding your chats and channels…');
      params.delete('msteams_connected');
    } else if (params.get('msteams_admin_consent') === 'granted') {
      setNotice('Your organisation approved the Teams integration. Reps can connect now.');
      params.delete('msteams_admin_consent');
      params.delete('tenant');
    } else if (params.get('msteams_error')) {
      setError(params.get('message') || `Teams connection failed: ${params.get('msteams_error')}`);
      params.delete('msteams_error');
      params.delete('message');
    } else {
      return;
    }
    const qs = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
  }, []);

  const connect = async () => {
    setBusy(true); setError('');
    try {
      const { data } = await apiService.msteams.connect();
      window.location.href = data.authUrl;
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message);
      setBusy(false);
    }
  };

  const adminConsent = async () => {
    setBusy(true); setError('');
    try {
      const { data } = await apiService.msteams.adminConsentUrl();
      window.open(data.url, '_blank', 'noopener');
      setNotice('Opened the approval page. Your Microsoft 365 administrator signs in there and approves once for the whole organisation.');
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message);
    } finally {
      setBusy(false);
    }
  };

  const discover = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const { data } = await apiService.msteams.discover();
      setNotice(
        `Found ${data.chatCount} chat${data.chatCount === 1 ? '' : 's'} and ` +
        `${data.channelCount} channel${data.channelCount === 1 ? '' : 's'}.` +
        (data.warnings?.length ? ` Some could not be read — see below.` : '')
      );
      await load();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!window.confirm('Disconnect Teams? What you chose to watch is kept, and reconnecting picks up where you left off.')) return;
    setBusy(true); setError('');
    try {
      await apiService.msteams.disconnect();
      setNotice('Teams disconnected.');
      await load();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message);
    } finally {
      setBusy(false);
    }
  };

  const applyWatch = async (watched) => {
    if (!selected.size) return;
    setBusy(true); setError('');
    try {
      await apiService.msteams.watch({ conversationIds: [...selected], watched });
      setSelected(new Set());
      setNotice(watched
        ? 'Marked for capture. Nothing is stored yet — this takes effect when message capture ships.'
        : 'No longer marked for capture.');
      await load();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message);
    } finally {
      setBusy(false);
    }
  };

  const applyIgnore = async (ignored) => {
    if (!selected.size) return;
    setBusy(true); setError('');
    try {
      await apiService.msteams.ignore({ conversationIds: [...selected], ignored });
      setSelected(new Set());
      setNotice(ignored ? 'Dismissed.' : 'Restored to the list.');
      await load();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message);
    } finally {
      setBusy(false);
    }
  };

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return convs.filter(c => {
      if (filter === 'watched'   && !c.is_watched) return false;
      if (filter === 'unwatched' && (c.is_watched || c.binding_status === 'ignored')) return false;
      if (filter === 'ignored'   && c.binding_status !== 'ignored') return false;
      if (filter !== 'ignored'   && c.binding_status === 'ignored' && filter !== 'all') return false;
      if (!q) return true;
      return [c.display_name, c.topic, c.team_name].filter(Boolean)
        .some(s => s.toLowerCase().includes(q));
    });
  }, [convs, filter, search]);

  const counts = useMemo(() => ({
    total:   convs.length,
    watched: convs.filter(c => c.is_watched).length,
    ignored: convs.filter(c => c.binding_status === 'ignored').length,
  }), [convs]);

  const toggle = (id) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  if (loading) {
    return <div style={{ padding: 24, fontSize: 13, color: '#6b7280' }}>Loading Teams…</div>;
  }

  const statusCopy = status?.status && status.status !== 'connected'
    ? STATUS_COPY[status.status]
    : null;

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

      {/* ── Not connected ─────────────────────────────────────────────── */}
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

      {/* ── Connected, or connected-but-degraded ──────────────────────── */}
      {status?.status && (
        <>
          {statusCopy && (
            <div style={{
              ...CARD, padding: 14, marginBottom: 16,
              background: TONE[statusCopy.tone].bg,
              borderColor: TONE[statusCopy.tone].border,
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: TONE[statusCopy.tone].fg }}>
                {statusCopy.title}
              </div>
              <div style={{ fontSize: 13, color: TONE[statusCopy.tone].fg, marginTop: 4, lineHeight: 1.6 }}>
                {statusCopy.body}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button style={PRIMARY} onClick={connect} disabled={busy}>Reconnect</button>
                {status.status === 'consent_required' && (
                  <button style={GHOST} onClick={adminConsent} disabled={busy}>
                    Get administrator approval
                  </button>
                )}
              </div>
            </div>
          )}

          <div style={{ ...CARD, padding: 16, marginBottom: 16, display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'center' }}>
            <div style={{ flex: '1 1 220px' }}>
              <div style={{ fontSize: 11, textTransform: 'uppercase', color: '#94a3b8', fontWeight: 600, letterSpacing: 0.3 }}>
                Connected as
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#374151', marginTop: 2 }}>
                {status.displayName || status.upn || '—'}
              </div>
              {status.upn && status.displayName && (
                <div style={{ fontSize: 12, color: '#9ca3af' }}>{status.upn}</div>
              )}
            </div>

            <div>
              <div style={{ fontSize: 11, textTransform: 'uppercase', color: '#94a3b8', fontWeight: 600, letterSpacing: 0.3 }}>
                Found
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#374151', marginTop: 2 }}>
                {status.chatCount || 0} chats · {status.channelCount || 0} channels
              </div>
              <div style={{ fontSize: 12, color: '#9ca3af' }}>
                {status.lastDiscoveryAt
                  ? `Refreshed ${timeAgo(status.lastDiscoveryAt)}`
                  : 'Not refreshed yet'}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
              <button style={GHOST} onClick={discover} disabled={busy}>
                {busy ? 'Refreshing…' : 'Refresh list'}
              </button>
              <button style={GHOST} onClick={disconnect} disabled={busy}>Disconnect</button>
            </div>
          </div>

          {/* Discovery is a poll on an hourly schedule, so a rep added to a
              channel minutes ago genuinely will not see it until they press
              Refresh. Saying so is cheaper than fielding the question. */}
          {status.lastDiscoveryError && (
            <div style={{ ...CARD, padding: 12, marginBottom: 16, background: TONE.warn.bg, borderColor: TONE.warn.border, color: TONE.warn.fg, fontSize: 13, lineHeight: 1.6 }}>
              <strong>Some conversations could not be read.</strong> The rest of the list is complete.
              <div style={{ fontFamily: 'monospace', fontSize: 12, marginTop: 6, opacity: 0.9 }}>
                {status.lastDiscoveryError}
              </div>
            </div>
          )}

          <div style={{ ...CARD, padding: 12, marginBottom: 16, background: '#eff6ff', borderColor: '#bfdbfe', color: '#1e40af', fontSize: 13, lineHeight: 1.6 }}>
            <strong>Nothing is being captured yet.</strong> Marking a conversation here records
            your decision — messages start being retained when Teams capture ships. Choosing now
            means the right conversations are already selected on day one instead of everything
            arriving at once.
          </div>

          {/* ── Triage ──────────────────────────────────────────────── */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
            {FILTERS.map(f => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                style={{
                  ...BTN,
                  background:  filter === f.key ? '#1A3A5C' : '#fff',
                  color:       filter === f.key ? '#fff' : '#374151',
                  border: `1px solid ${filter === f.key ? '#1A3A5C' : '#d1d5db'}`,
                }}
              >
                {f.label}
              </button>
            ))}
            <input
              style={{ ...INPUT, marginLeft: 'auto', minWidth: 220 }}
              placeholder="Search chats, channels, teams…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 10 }}>
            {counts.total} conversation{counts.total === 1 ? '' : 's'} ·{' '}
            {counts.watched} marked for capture · {counts.ignored} dismissed
          </div>

          {selected.size > 0 && (
            <div style={{ ...CARD, padding: 12, marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center', background: '#f9fafb' }}>
              <span style={{ fontSize: 13, color: '#374151', fontWeight: 500 }}>
                {selected.size} selected
              </span>
              <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
                <button style={PRIMARY} onClick={() => applyWatch(true)}  disabled={busy}>Capture these</button>
                <button style={GHOST}   onClick={() => applyWatch(false)} disabled={busy}>Do not capture</button>
                <button style={GHOST}   onClick={() => applyIgnore(true)} disabled={busy}>Dismiss</button>
                {filter === 'ignored' && (
                  <button style={GHOST} onClick={() => applyIgnore(false)} disabled={busy}>Restore</button>
                )}
                <button style={GHOST} onClick={() => setSelected(new Set())}>Clear</button>
              </div>
            </div>
          )}

          <div style={{ ...CARD, overflow: 'hidden' }}>
            {visible.length === 0 ? (
              <div style={{ padding: 24, fontSize: 13, color: '#9ca3af', textAlign: 'center' }}>
                {convs.length === 0
                  ? 'No chats or channels found yet. Press Refresh list.'
                  : 'Nothing matches that filter.'}
              </div>
            ) : visible.map((c, i) => {
              const kind = KIND[c.kind] || KIND.group;
              const isIgnored = c.binding_status === 'ignored';
              return (
                <div
                  key={c.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '10px 14px',
                    borderTop: i === 0 ? 'none' : '1px solid #f3f4f6',
                    opacity: isIgnored ? 0.55 : 1,
                    background: selected.has(c.id) ? '#fff7ed' : '#fff',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    onChange={() => toggle(c.id)}
                    style={{ cursor: 'pointer' }}
                  />

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.display_name || c.topic || c.graph_id}
                    </div>
                    <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
                      {c.member_count ? `${c.member_count} members · ` : ''}
                      {c.last_activity_at ? `active ${timeAgo(c.last_activity_at)}` : 'no recent activity'}
                    </div>
                  </div>

                  <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: kind.bg, color: kind.fg }}>
                    {kind.label}
                  </span>

                  {c.is_watched && (
                    <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: '#fff7ed', color: '#9a3412' }}>
                      Capture
                    </span>
                  )}
                  {isIgnored && (
                    <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: '#f3f4f6', color: '#6b7280' }}>
                      Dismissed
                    </span>
                  )}

                  {c.web_url && (
                    <a
                      href={c.web_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontSize: 12, color: '#2563eb', textDecoration: 'none' }}
                    >
                      Open
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
