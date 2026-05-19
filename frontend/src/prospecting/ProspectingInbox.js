// ProspectingInbox.js — extracted from ProspectingView.js (2026 module split).
// Verbatim component bodies; only imports added. No behavior changes.

import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch } from './prospectingShared';

function ProspectingInbox({ scope }) {
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

  const LIMIT = 50;

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
      };
      const [emailsRes, statsRes] = await Promise.all([
        apiFetch(`/prospecting/inbox?${new URLSearchParams(params)}`),
        apiFetch(`/prospecting/inbox/stats?${new URLSearchParams({ scope, ...(dateRange && { from: fromDate() }) })}`),
      ]);
      setEmails(emailsRes.emails || []);
      setTotal(emailsRes.total  || 0);
      setStats(statsRes.stats   || null);
      setOffset(newOffset);
    } catch (err) {
      setError(err.message || 'Failed to load inbox');
    } finally {
      setLoading(false);
    }
  }, [scope, direction, dateRange]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const RANGE_OPTS = [
    { value: '7',   label: '7 days' },
    { value: '14',  label: '14 days' },
    { value: '30',  label: '30 days' },
    { value: '90',  label: '90 days' },
    { value: '',    label: 'All time' },
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
