// ProspectingInbox.js — multi-channel inbox shell.
//
// Sub-tab structure (Option A, agreed with product):
//   [ Activity | Email Inbox ]   (Drafts will slot in as a third tab next)
//
//   • Activity     — NEW unified multi-channel feed (email + LinkedIn + call +
//                    sequence events) from GET /prospecting/activity, with
//                    type-filter chips driven by server counts.
//   • Email Inbox  — the previous email-only view, preserved verbatim and
//                    honestly labeled (it is email-only).
//
// The component still takes a `scope` prop and passes it through to both tabs.

import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch } from './prospectingShared';

const TEAL = '#0F9D8E';

// Shared date-range options (used by both tabs).
const RANGE_OPTS = [
  { value: '7',   label: '7 days' },
  { value: '14',  label: '14 days' },
  { value: '30',  label: '30 days' },
  { value: '90',  label: '90 days' },
  { value: '',    label: 'All time' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Shell: sub-tab bar + active tab.
// ─────────────────────────────────────────────────────────────────────────────
function ProspectingInbox({ scope: pageScope, onScopeChange, search }) {
  const [tab, setTab] = useState('activity'); // 'activity' | 'email'
  const [caps, setCaps] = useState({ hasSubordinates: false, isAdmin: false });
  const [scopeLocal, setScopeLocal] = useState(pageScope || 'mine');

  // Server-authoritative scope capabilities (same source the campaign list uses).
  useEffect(() => {
    apiFetch('/prospecting-campaigns/me/context')
      .then(c => setCaps({ hasSubordinates: !!c?.hasSubordinates, isAdmin: !!c?.isAdmin }))
      .catch(() => { /* only "Mine" offered */ });
  }, []);

  // Follow the page-level scope when it changes, but allow a local override here
  // so this view has its own Mine/Team/Org switch like the campaign list.
  useEffect(() => { if (pageScope) setScopeLocal(pageScope); }, [pageScope]);

  const scope = scopeLocal;
  // Setting scope here also lifts it to the page so scope-aware things outside
  // this view (the THIS WEEK metrics strip, the prospects board) stay in sync.
  const setScope = (v) => { setScopeLocal(v); if (onScopeChange) onScopeChange(v); };

  const scopeTabs = [{ key: 'mine', label: 'Mine' }];
  if (caps.hasSubordinates) scopeTabs.push({ key: 'team', label: 'Team' });
  if (caps.isAdmin)         scopeTabs.push({ key: 'org',  label: 'Org' });

  const TABS = [
    { value: 'activity', label: 'Activity' },
    { value: 'email',    label: 'Email Inbox' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, height: '100%' }}>
      {/* ── Sub-tab bar ──────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', gap: 4, alignItems: 'center', padding: '0 16px',
        borderBottom: '1px solid #e5e7eb', background: '#fff', flexShrink: 0,
      }}>
        {TABS.map(t => {
          const active = tab === t.value;
          return (
            <button
              key={t.value}
              onClick={() => setTab(t.value)}
              style={{
                padding: '11px 14px 9px', fontSize: 13, fontWeight: 600,
                border: 'none', background: 'transparent', cursor: 'pointer',
                color: active ? TEAL : '#6b7280',
                borderBottom: active ? `2px solid ${TEAL}` : '2px solid transparent',
                marginBottom: -1,
              }}
            >
              {t.label}
            </button>
          );
        })}

        {/* Scope selector — same Mine/Team/Org control the campaign list has, so
            the feed + inbox aren't stuck on the page-level toggle. Only shown
            when the user actually has more than one scope. */}
        {scopeTabs.length > 1 && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: '#9ca3af', marginRight: 2, letterSpacing: 0.3 }}>VIEW</span>
            {scopeTabs.map(s => (
              <button
                key={s.key}
                onClick={() => setScope(s.key)}
                style={{
                  padding: '4px 12px', borderRadius: 6, border: '1px solid #e5e7eb',
                  background: scope === s.key ? TEAL : '#fff',
                  color: scope === s.key ? '#fff' : '#6b7280',
                  fontSize: 12, fontWeight: 600, cursor: 'pointer',
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Active tab ───────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {tab === 'activity'
          ? <ActivityFeed scope={scope} search={search} />
          : <EmailInbox scope={scope} search={search} />}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Activity feed — unified multi-channel stream.
// ─────────────────────────────────────────────────────────────────────────────
function ActivityFeed({ scope, search }) {
  const [items, setItems]       = useState([]);
  const [counts, setCounts]     = useState({});
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [type, setType]         = useState('all');     // category filter
  const [direction, setDirection] = useState('');      // '' | 'outbound' | 'inbound'
  const [dateRange, setDateRange] = useState('30');
  const [offset, setOffset]     = useState(0);
  const [total, setTotal]       = useState(0);
  const [senderId, setSenderId] = useState(null);  // filter by one team member
  const [bySender, setBySender] = useState([]);     // per-person counts

  const LIMIT = 50;

  // Clear the per-person filter whenever the scope changes (Mine/Team/Org).
  useEffect(() => { setSenderId(null); }, [scope]);

  const fromDate = () => {
    if (!dateRange) return undefined;
    const d = new Date();
    d.setDate(d.getDate() - parseInt(dateRange));
    return d.toISOString();
  };

  const load = useCallback(async (newOffset = 0) => {
    setLoading(true);
    setError('');
    try {
      const params = {
        scope,
        type,
        limit: LIMIT,
        offset: newOffset,
        ...(direction && { direction }),
        ...(dateRange && { from: fromDate() }),
        ...(search && { search }),
        ...(senderId && { senderId }),
      };
      const res = await apiFetch(`/prospecting/activity?${new URLSearchParams(params)}`);
      setItems(res.items   || []);
      setCounts(res.counts || {});
      setTotal(res.total   || 0);
      setBySender(res.bySender || []);
      setOffset(newOffset);
    } catch (err) {
      setError(err.message || 'Failed to load activity');
    } finally {
      setLoading(false);
    }
  }, [scope, type, direction, dateRange, search, senderId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(0); }, [load]);

  // Refresh when the tab/window becomes visible again.
  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === 'visible') load(offset); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [load, offset]);

  const TYPE_CHIPS = [
    { value: 'all',      label: 'All' },
    { value: 'email',    label: '✉️ Email' },
    { value: 'linkedin', label: '🔗 LinkedIn' },
    { value: 'call',     label: '📞 Calls' },
    { value: 'sequence', label: '🔁 Sequence' },
  ];

  const DIRECTION_OPTS = [
    { value: '',         label: 'All' },
    { value: 'outbound', label: 'Outbound' },
    { value: 'inbound',  label: 'Inbound' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>

      {/* ── Type-filter chips ──────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', gap: 6, alignItems: 'center', padding: '10px 16px',
        borderBottom: '1px solid #f3f4f6', background: '#fff', flexShrink: 0, flexWrap: 'wrap',
      }}>
        {TYPE_CHIPS.map(chip => {
          const active = type === chip.value;
          const n = counts[chip.value];
          return (
            <button
              key={chip.value}
              onClick={() => setType(chip.value)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '5px 12px', fontSize: 12, fontWeight: 600,
                border: `1px solid ${active ? TEAL : '#e5e7eb'}`, borderRadius: 16,
                background: active ? TEAL : '#fff',
                color: active ? '#fff' : '#6b7280', cursor: 'pointer',
                transition: 'all 0.12s ease',
              }}
            >
              {chip.label}
              {typeof n === 'number' && (
                <span style={{
                  fontSize: 11, fontWeight: 700,
                  padding: '0 6px', borderRadius: 9, minWidth: 18, textAlign: 'center',
                  background: active ? 'rgba(255,255,255,0.25)' : '#f3f4f6',
                  color: active ? '#fff' : '#9ca3af',
                }}>{n}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Per-sender bar (team/org only) — each person's count, doubles as a
            "who is sending" filter. ──────────────────────────────────────── */}
      {scope !== 'mine' && bySender.length > 0 && (
        <div style={{
          display: 'flex', gap: 6, alignItems: 'center', padding: '8px 16px',
          borderBottom: '1px solid #e5e7eb', background: '#fff', flexShrink: 0, flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.3, marginRight: 2 }}>
            Sender
          </span>
          {(() => {
            const allCount = bySender.reduce((s, p) => s + p.count, 0);
            const chip = (active, label, count, onClick) => (
              <button
                onClick={onClick}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '4px 10px', borderRadius: 14, cursor: 'pointer',
                  border: `1px solid ${active ? TEAL : '#e5e7eb'}`,
                  background: active ? TEAL : '#fff',
                  color: active ? '#fff' : '#374151', fontSize: 12, fontWeight: 600,
                }}
              >
                {label}
                <span style={{
                  fontSize: 11, fontWeight: 700, padding: '0 6px', borderRadius: 8,
                  background: active ? 'rgba(255,255,255,0.25)' : '#f3f4f6',
                  color: active ? '#fff' : '#6b7280',
                }}>{count}</span>
              </button>
            );
            return (
              <>
                {chip(senderId === null, 'All', allCount, () => setSenderId(null))}
                {bySender.map(p => chip(senderId === p.userId, p.name, p.count, () => setSenderId(p.userId)))}
              </>
            );
          })()}
        </div>
      )}

      {/* ── Secondary filter bar (direction + date) ────────────────────────── */}
      <div style={{
        display: 'flex', gap: 8, alignItems: 'center', padding: '8px 16px',
        borderBottom: '1px solid #e5e7eb', background: '#f9fafb', flexShrink: 0, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #e5e7eb' }}>
          {DIRECTION_OPTS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setDirection(opt.value)}
              style={{
                padding: '5px 12px', fontSize: 12, fontWeight: 500, border: 'none',
                background: direction === opt.value ? TEAL : '#fff',
                color:      direction === opt.value ? '#fff' : '#6b7280',
                cursor: 'pointer', borderRight: '1px solid #e5e7eb',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <select
          value={dateRange}
          onChange={e => setDateRange(e.target.value)}
          style={{
            padding: '5px 10px', border: '1px solid #e5e7eb', borderRadius: 6,
            fontSize: 12, color: '#374151', background: '#fff', cursor: 'pointer',
          }}
        >
          {RANGE_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, color: '#94a3b8' }}>
            {total} event{total !== 1 ? 's' : ''}
          </span>
          <button
            onClick={() => load(offset)}
            disabled={loading}
            title="Refresh activity"
            style={{
              padding: '5px 9px', fontSize: 13, border: '1px solid #e5e7eb',
              borderRadius: 6, background: '#fff', color: '#6b7280',
              cursor: loading ? 'not-allowed' : 'pointer',
            }}
          >
            {loading ? '⏳' : '🔄'}
          </button>
        </div>
      </div>

      {/* ── Feed list ──────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {error && (
          <div style={{ padding: '16px 20px', color: '#dc2626', fontSize: 13 }}>⚠️ {error}</div>
        )}

        {loading && items.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
        ) : items.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>📭</div>
            <div style={{ fontWeight: 600, color: '#374151', marginBottom: 4 }}>No activity yet</div>
            <div style={{ fontSize: 13 }}>
              Emails, LinkedIn events, and calls will appear here as you work prospects.
            </div>
          </div>
        ) : (
          <>
            <div>
              {items.map((it, i) => (
                <ActivityRow key={`${it.refTable}-${it.refId}-${i}`} item={it} scope={scope} />
              ))}
            </div>

            {/* Pagination */}
            {total > LIMIT && (
              <div style={{ display: 'flex', justifyContent: 'center', gap: 8, padding: '12px 16px', borderTop: '1px solid #f3f4f6' }}>
                <button
                  disabled={offset === 0 || loading}
                  onClick={() => load(Math.max(0, offset - LIMIT))}
                  style={{ padding: '5px 14px', border: '1px solid #e5e7eb', borderRadius: 6, background: offset === 0 ? '#f9fafb' : '#fff', color: '#374151', cursor: offset === 0 ? 'default' : 'pointer', fontSize: 12 }}
                >
                  ← Prev
                </button>
                <span style={{ fontSize: 12, color: '#6b7280', padding: '5px 8px' }}>
                  {offset + 1}–{Math.min(offset + LIMIT, total)} of {total}
                </span>
                <button
                  disabled={offset + LIMIT >= total || loading}
                  onClick={() => load(offset + LIMIT)}
                  style={{ padding: '5px 14px', border: '1px solid #e5e7eb', borderRadius: 6, background: offset + LIMIT >= total ? '#f9fafb' : '#fff', color: '#374151', cursor: offset + LIMIT >= total ? 'default' : 'pointer', fontSize: 12 }}
                >
                  Next →
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Per-channel row rendering ─────────────────────────────────────────────────
const CHANNEL_VISUAL = {
  email:    { icon: '✉️', tint: '#eff6ff', accent: '#1d4ed8' },
  linkedin: { icon: '🔗', tint: '#eff8fc', accent: '#0077B5' },
  call:     { icon: '📞', tint: '#f0fdf4', accent: '#15803d' },
  sequence: { icon: '🔁', tint: '#fdf4ff', accent: '#a21caf' },
  system:   { icon: '•',  tint: '#f9fafb', accent: '#6b7280' },
};

// Strip HTML to readable plain text, preserving line breaks.
function htmlToText(html) {
  return String(html || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function ActivityRow({ item, scope }) {
  const visual = CHANNEL_VISUAL[item.category] || CHANNEL_VISUAL.system;
  const p = item.prospect || {};
  const actor = item.actor;
  const isInbound = item.direction === 'received';

  // Calls have their own dedicated inbox; everything else expands inline.
  const expandable = item.category !== 'call' && item.refId != null;

  const [open, setOpen]       = useState(false);
  const [detail, setDetail]   = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr]         = useState('');

  const toggle = async () => {
    if (!expandable) return;
    const next = !open;
    setOpen(next);
    if (next && !detail && !loading) {
      setLoading(true); setErr('');
      try {
        const qs = new URLSearchParams({ refTable: item.refTable, refId: String(item.refId), scope: scope || 'mine' });
        setDetail(await apiFetch(`/prospecting/activity/detail?${qs}`));
      } catch (e) {
        setErr(e.message || 'Failed to load details');
      } finally {
        setLoading(false);
      }
    }
  };

  const when = item.occurredAt
    ? new Date(item.occurredAt).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      })
    : '—';

  const isEmail = item.category === 'email';
  const fullText = detail ? (isEmail ? htmlToText(detail.body) : (detail.body || detail.description || '')) : '';

  return (
    <div style={{
      borderBottom: '1px solid #f3f4f6',
      background: isInbound ? '#f0fdf4' : '#fff',
    }}>
      {/* Header (clickable when expandable) */}
      <div
        onClick={toggle}
        style={{
          display: 'flex', gap: 12, padding: '12px 16px',
          cursor: expandable ? 'pointer' : 'default',
        }}
      >
        {/* Channel icon */}
        <div style={{
          flexShrink: 0, width: 34, height: 34, borderRadius: 8,
          background: visual.tint, display: 'flex', alignItems: 'center',
          justifyContent: 'center', fontSize: 16,
        }}>
          {visual.icon}
        </div>

        {/* Body */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, color: '#1a202c', fontSize: 13 }}>
              {p.firstName} {p.lastName}
            </span>
            {p.companyName && (
              <span style={{ fontSize: 12, color: '#94a3b8' }}>· {p.companyName}</span>
            )}
            <span style={{
              fontSize: 11, fontWeight: 600, color: visual.accent,
              padding: '1px 8px', borderRadius: 10, background: visual.tint,
            }}>
              {item.label}
            </span>
            {isInbound && (
              <span style={{ fontSize: 11, padding: '1px 8px', borderRadius: 10, background: '#d1fae5', color: '#065f46', fontWeight: 600 }}>
                ↩ Inbound
              </span>
            )}
          </div>

          {item.summary && (
            <div style={{
              marginTop: 3, fontSize: 13, color: '#374151',
              ...(open ? {} : { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
            }}>
              {isEmail && isInbound ? '↩ ' : ''}{item.summary}
            </div>
          )}

          {/* Collapsed snippet preview (hidden once expanded) */}
          {!open && item.snippet && (
            <div style={{
              marginTop: 2, fontSize: 12, color: '#9ca3af',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {item.snippet}
            </div>
          )}

          {item.category === 'call' && (
            <div style={{ marginTop: 3, fontSize: 11, color: visual.accent }}>
              View detail in the Calls tab
            </div>
          )}
        </div>

        {/* Meta */}
        <div style={{ flexShrink: 0, textAlign: 'right' }}>
          <div style={{ fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' }}>
            {expandable && <span style={{ color: '#cbd5e1', marginRight: 6 }}>{open ? '▾' : '▸'}</span>}
            {when}
          </div>
          {actor && (actor.firstName || actor.lastName) && (
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
              {actor.firstName} {actor.lastName}
            </div>
          )}
        </div>
      </div>

      {/* Expanded detail */}
      {open && (
        <div style={{ padding: '0 16px 14px 62px' }}>
          {loading && <div style={{ fontSize: 12, color: '#9ca3af' }}>Loading…</div>}
          {err && <div style={{ fontSize: 12, color: '#b91c1c' }}>{err}</div>}
          {detail && (
            <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {isEmail && (
                <div style={{ display: 'flex', gap: 16, fontSize: 11, color: '#6b7280', flexWrap: 'wrap' }}>
                  {detail.from && <span><strong>From:</strong> {detail.from}</span>}
                  {detail.to   && <span><strong>To:</strong> {detail.to}</span>}
                  {detail.subject && <span><strong>Subject:</strong> {detail.subject}</span>}
                </div>
              )}
              {!isEmail && (detail.event || detail.sentiment) && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {detail.event && (
                    <span style={{ fontSize: 11, fontWeight: 600, color: visual.accent, padding: '1px 8px', borderRadius: 10, background: visual.tint }}>
                      {detail.event.replace(/_/g, ' ')}
                    </span>
                  )}
                  {detail.sentiment && (
                    <span style={{ fontSize: 11, padding: '1px 8px', borderRadius: 10, background: '#eef2ff', color: '#4338ca', fontWeight: 600 }}>
                      {detail.sentiment}
                    </span>
                  )}
                </div>
              )}
              <div style={{
                background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8,
                padding: '12px 16px', fontSize: 13, color: '#374151',
                lineHeight: 1.7, whiteSpace: 'pre-wrap', maxHeight: 400,
                overflowY: 'auto', fontFamily: 'inherit',
              }}>
                {fullText
                  ? fullText
                  : <span style={{ color: '#94a3b8', fontStyle: 'italic' }}>No further detail stored for this activity.</span>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Email Inbox — the prior email-only view, preserved verbatim (only renamed
// from the component default to make the sub-tab honest).
// ─────────────────────────────────────────────────────────────────────────────
function EmailInbox({ scope, search }) {
  const [emails, setEmails]       = useState([]);
  const [stats, setStats]         = useState(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [direction, setDirection] = useState(''); // '' | 'outbound' | 'inbound'
  const [dateRange, setDateRange] = useState('30'); // days
  const [offset, setOffset]       = useState(0);
  const [total, setTotal]         = useState(0);
  const [syncing, setSyncing]     = useState(false);
  const [syncMsg, setSyncMsg]     = useState('');
  const [expandedId, setExpandedId] = useState(null); // id of expanded email row
  const [senderId, setSenderId]   = useState(null);   // filter by one team member
  const [bySender, setBySender]   = useState([]);     // per-person counts

  const LIMIT = 50;

  // Clear the per-person filter whenever the scope changes (Mine/Team/Org).
  useEffect(() => { setSenderId(null); }, [scope]);

  const fromDate = () => {
    if (!dateRange) return undefined;
    const d = new Date();
    d.setDate(d.getDate() - parseInt(dateRange));
    return d.toISOString();
  };

  const load = useCallback(async (newOffset = 0) => {
    setLoading(true);
    setError('');
    try {
      const params = {
        scope,
        limit: LIMIT,
        offset: newOffset,
        ...(direction && { direction }),
        ...(dateRange  && { from: fromDate() }),
        ...(search && { search }),
        ...(senderId && { senderId }),
      };
      const [emailsRes, statsRes] = await Promise.all([
        apiFetch(`/prospecting/inbox?${new URLSearchParams(params)}`),
        apiFetch(`/prospecting/inbox/stats?${new URLSearchParams({ scope, ...(dateRange && { from: fromDate() }), ...(search && { search }) })}`),
      ]);
      setEmails(emailsRes.emails || []);
      setTotal(emailsRes.total  || 0);
      setBySender(emailsRes.bySender || []);
      setStats(statsRes.stats   || null);
      setOffset(newOffset);
    } catch (err) {
      setError(err.message || 'Failed to load inbox');
    } finally {
      setLoading(false);
    }
  }, [scope, direction, dateRange, search, senderId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(0); }, [load]);

  // Refresh when tab becomes visible again
  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === 'visible') load(offset); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [load, offset]);

  // Sync replies from Gmail/Outlook and refresh inbox
  const handleSync = async () => {
    setSyncing(true);
    setSyncMsg('');
    try {
      const res = await apiFetch(`/prospecting/inbox/sync?days=${dateRange || 30}`, { method: 'POST' });
      setSyncMsg(res.message || `${res.saved} new replies synced`);
      await load(0); // refresh list after sync
    } catch (err) {
      setSyncMsg('Sync failed: ' + (err.message || 'Unknown error'));
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMsg(''), 5000); // clear message after 5s
    }
  };

  const DIRECTION_OPTS = [
    { value: '',          label: 'All' },
    { value: 'outbound',  label: 'Sent' },
    { value: 'inbound',   label: 'Replies' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, height: '100%' }}>

      {/* ── Stats bar ──────────────────────────────────────────────────────── */}
      {stats && (
        <div style={{
          display: 'flex', gap: 0, borderBottom: '1px solid #e5e7eb',
          background: '#fff', flexShrink: 0,
        }}>
          {[
            { label: 'Sent',       value: stats.sent       ?? 0, color: '#374151' },
            { label: 'Replies',    value: stats.replies    ?? 0, color: '#0F9D8E' },
            { label: 'Opens',      value: stats.opens      ?? 0, color: '#8b5cf6' },
            { label: 'Reply rate', value: stats.sent > 0 ? `${Math.round((stats.replies / stats.sent) * 100)}%` : '—', color: '#059669' },
            { label: 'Senders',    value: stats.senderCount ?? 0, color: '#f59e0b' },
          ].map(s => (
            <div key={s.label} style={{
              flex: 1, padding: '10px 16px', borderRight: '1px solid #f3f4f6',
              textAlign: 'center',
            }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.3 }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── Per-sender bar (team/org only) — shows each person's count and
            doubles as a "who is sending" filter. ─────────────────────────── */}
      {scope !== 'mine' && bySender.length > 0 && (
        <div style={{
          display: 'flex', gap: 6, alignItems: 'center', padding: '8px 16px',
          borderBottom: '1px solid #e5e7eb', background: '#fff', flexShrink: 0, flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.3, marginRight: 2 }}>
            Sender
          </span>
          {(() => {
            const allCount = bySender.reduce((s, p) => s + p.count, 0);
            const chip = (active, label, count, onClick) => (
              <button
                onClick={onClick}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '4px 10px', borderRadius: 14, cursor: 'pointer',
                  border: `1px solid ${active ? '#0F9D8E' : '#e5e7eb'}`,
                  background: active ? '#0F9D8E' : '#fff',
                  color: active ? '#fff' : '#374151', fontSize: 12, fontWeight: 600,
                }}
              >
                {label}
                <span style={{
                  fontSize: 11, fontWeight: 700,
                  padding: '0 6px', borderRadius: 8,
                  background: active ? 'rgba(255,255,255,0.25)' : '#f3f4f6',
                  color: active ? '#fff' : '#6b7280',
                }}>{count}</span>
              </button>
            );
            return (
              <>
                {chip(senderId === null, 'All', allCount, () => setSenderId(null))}
                {bySender.map(p => chip(senderId === p.userId, p.name, p.count, () => setSenderId(p.userId)))}
              </>
            );
          })()}
        </div>
      )}

      {/* ── Filter bar ─────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', gap: 8, alignItems: 'center', padding: '10px 16px',
        borderBottom: '1px solid #e5e7eb', background: '#f9fafb', flexShrink: 0, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #e5e7eb' }}>
          {DIRECTION_OPTS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setDirection(opt.value)}
              style={{
                padding: '5px 12px', fontSize: 12, fontWeight: 500, border: 'none',
                background: direction === opt.value ? '#0F9D8E' : '#fff',
                color:      direction === opt.value ? '#fff' : '#6b7280',
                cursor: 'pointer', borderRight: '1px solid #e5e7eb',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <select
          value={dateRange}
          onChange={e => setDateRange(e.target.value)}
          style={{
            padding: '5px 10px', border: '1px solid #e5e7eb', borderRadius: 6,
            fontSize: 12, color: '#374151', background: '#fff', cursor: 'pointer',
          }}
        >
          {RANGE_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>

        {syncMsg && (
          <span style={{ fontSize: 12, color: syncMsg.includes('failed') ? '#dc2626' : '#059669', fontWeight: 500 }}>
            {syncMsg}
          </span>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, color: '#94a3b8' }}>
            {total} email{total !== 1 ? 's' : ''}
          </span>

          <button
            onClick={handleSync}
            disabled={syncing}
            title="Fetch new replies from Gmail / Outlook"
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '5px 12px', fontSize: 12, fontWeight: 500,
              border: '1px solid #0F9D8E', borderRadius: 6,
              background: syncing ? '#f0fdfa' : '#fff',
              color: '#0F9D8E', cursor: syncing ? 'not-allowed' : 'pointer',
            }}
          >
            {syncing ? '⏳ Syncing…' : '↻ Sync Replies'}
          </button>

          <button
            onClick={() => load(offset)}
            disabled={loading}
            title="Refresh inbox"
            style={{
              padding: '5px 9px', fontSize: 13, border: '1px solid #e5e7eb',
              borderRadius: 6, background: '#fff', color: '#6b7280',
              cursor: loading ? 'not-allowed' : 'pointer',
            }}
          >
            {loading ? '⏳' : '🔄'}
          </button>
        </div>
      </div>

      {/* ── Email list ─────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {error && (
          <div style={{ padding: '16px 20px', color: '#dc2626', fontSize: 13 }}>
            ⚠️ {error}
          </div>
        )}

        {loading && emails.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
        ) : emails.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>📭</div>
            <div style={{ fontWeight: 600, color: '#374151', marginBottom: 4 }}>No outreach emails yet</div>
            <div style={{ fontSize: 13 }}>
              Emails sent via the OutreachComposer will appear here.
            </div>
          </div>
        ) : (
          <>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
                  {['Prospect', 'Company', 'Subject', 'Sent By', 'Date', 'Status'].map(h => (
                    <th key={h} style={{
                      padding: '9px 14px', textAlign: 'left', fontSize: 11,
                      fontWeight: 700, color: '#6b7280', textTransform: 'uppercase',
                      letterSpacing: 0.5, whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {emails.map(email => {
                  const prospect   = email.prospect   || {};
                  const sentBy     = email.sentBy     || {};
                  const sender     = email.senderAccount || {};
                  const isReply    = email.direction === 'inbound' || email.direction === 'received';
                  const wasOpened  = !!email.openedAt;
                  const wasReplied = !!email.repliedAt;
                  return (
                    <React.Fragment key={email.id}>
                    <tr
                      key={`${email.id}-main`}
                      onClick={() => setExpandedId(expandedId === email.id ? null : email.id)}
                      style={{
                        borderBottom: expandedId === email.id ? 'none' : '1px solid #f3f4f6',
                        background: isReply ? '#f0fdf4' : '#fff',
                        cursor: 'pointer',
                      }}
                    >
                      {/* Prospect name + email */}
                      <td style={{ padding: '10px 14px', minWidth: 160 }}>
                        <div style={{ fontWeight: 600, color: '#1a202c' }}>
                          {prospect.firstName} {prospect.lastName}
                        </div>
                        {prospect.email && (
                          <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 1 }}>
                            {prospect.email}
                          </div>
                        )}
                      </td>

                      {/* Company + stage */}
                      <td style={{ padding: '10px 14px', minWidth: 130 }}>
                        <div style={{ fontSize: 12, color: '#374151' }}>
                          {prospect.companyName || '—'}
                        </div>
                        {prospect.stage && (
                          <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 1, textTransform: 'capitalize' }}>
                            {prospect.stage}
                          </div>
                        )}
                      </td>

                      {/* Subject */}
                      <td style={{ padding: '10px 14px', maxWidth: 260 }}>
                        <div style={{
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          color: isReply ? '#065f46' : '#374151',
                          fontWeight: isReply ? 600 : 400,
                        }}>
                          {isReply ? '↩ ' : ''}{email.subject || '(no subject)'}
                        </div>
                      </td>

                      {/* Sent by — CRM user + sender account email */}
                      <td style={{ padding: '10px 14px', minWidth: 140 }}>
                        <div style={{ fontSize: 12, color: '#374151' }}>
                          {sentBy.firstName} {sentBy.lastName}
                        </div>
                        {(sender.email || email.fromAddress) && (
                          <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 1 }}>
                            {sender.email || email.fromAddress}
                          </div>
                        )}
                      </td>

                      {/* Date */}
                      <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', color: '#6b7280', fontSize: 12 }}>
                        {email.sentAt
                          ? new Date(email.sentAt).toLocaleString(undefined, {
                              month: 'short', day: 'numeric',
                              hour: '2-digit', minute: '2-digit',
                            })
                          : '—'}
                      </td>

                      {/* Status badges */}
                      <td style={{ padding: '10px 14px' }}>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {isReply && (
                            <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: '#d1fae5', color: '#065f46', fontWeight: 600 }}>
                              ↩ Reply
                            </span>
                          )}
                          {wasOpened && !isReply && (
                            <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: '#ede9fe', color: '#6d28d9', fontWeight: 600 }}>
                              Opened
                            </span>
                          )}
                          {wasReplied && !isReply && (
                            <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: '#d1fae5', color: '#065f46', fontWeight: 600 }}>
                              ✓ Replied
                            </span>
                          )}
                          {!isReply && !wasOpened && !wasReplied && (
                            <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: '#f3f4f6', color: '#9ca3af' }}>
                              Sent
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                    {expandedId === email.id && (
                      <tr key={`${email.id}-body`} style={{ borderBottom: '1px solid #f3f4f6', background: isReply ? '#f0fdf4' : '#fafafa' }}>
                        <td colSpan={6} style={{ padding: '0 14px 14px 14px' }}>
                          <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <div style={{ display: 'flex', gap: 16, fontSize: 11, color: '#6b7280', flexWrap: 'wrap' }}>
                              <span><strong>From:</strong> {email.fromAddress || sender.email || ''}</span>
                              <span><strong>To:</strong> {email.toAddress || prospect.email || ''}</span>
                              {email.sentAt && <span><strong>Date:</strong> {new Date(email.sentAt).toLocaleString()}</span>}
                            </div>
                            <div style={{
                              background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8,
                              padding: '12px 16px', fontSize: 13, color: '#374151',
                              lineHeight: 1.7, whiteSpace: 'pre-wrap', maxHeight: 400,
                              overflowY: 'auto', fontFamily: 'inherit',
                            }}>
                              {email.body
                                ? email.body.replace(/<[^>]+>/g, '').trim()
                                : <span style={{ color: '#94a3b8', fontStyle: 'italic' }}>No body content stored.</span>
                              }
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
                })}
              </tbody>
            </table>

            {/* Pagination */}
            {total > LIMIT && (
              <div style={{ display: 'flex', justifyContent: 'center', gap: 8, padding: '12px 16px', borderTop: '1px solid #f3f4f6' }}>
                <button
                  disabled={offset === 0 || loading}
                  onClick={() => load(Math.max(0, offset - LIMIT))}
                  style={{ padding: '5px 14px', border: '1px solid #e5e7eb', borderRadius: 6, background: offset === 0 ? '#f9fafb' : '#fff', color: '#374151', cursor: offset === 0 ? 'default' : 'pointer', fontSize: 12 }}
                >
                  ← Prev
                </button>
                <span style={{ fontSize: 12, color: '#6b7280', padding: '5px 8px' }}>
                  {offset + 1}–{Math.min(offset + LIMIT, total)} of {total}
                </span>
                <button
                  disabled={offset + LIMIT >= total || loading}
                  onClick={() => load(offset + LIMIT)}
                  style={{ padding: '5px 14px', border: '1px solid #e5e7eb', borderRadius: 6, background: offset + LIMIT >= total ? '#f9fafb' : '#fff', color: '#374151', cursor: offset + LIMIT >= total ? 'default' : 'pointer', fontSize: 12 }}
                >
                  Next →
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default ProspectingInbox;
