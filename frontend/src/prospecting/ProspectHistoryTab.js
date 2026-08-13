// ProspectHistoryTab.js — migrated interaction timeline for a prospect.
// Drop into frontend/src/prospecting/. Renders inside ProspectDetailPanel's
// tab area. Fetches /api/preview/by-prospect/:id/timeline, shows a merged
// email + LinkedIn feed with inline-expandable email bodies. Read-only.
import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from '../apiService';

function fmt(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return isNaN(d) ? '' : d.toLocaleString(undefined,
    { year:'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
}

export default function ProspectHistoryTab({ prospectId }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [openBody, setOpenBody] = useState({});   // { message_id: {loading|body|isHtml|error} }

  const load = useCallback(() => {
    if (!apiService.preview || !prospectId) { setLoading(false); return; }
    setLoading(true);
    apiService.preview.byProspectTimeline(prospectId)
      .then(r => setData(r.data))
      .catch(() => setError('Failed to load history'))
      .finally(() => setLoading(false));
  }, [prospectId]);

  useEffect(() => { load(); }, [load]);

  const toggleBody = (messageId) => {
    if (!messageId) return;
    // collapse if open
    if (openBody[messageId] && !openBody[messageId].loading) {
      setOpenBody(prev => { const n = { ...prev }; delete n[messageId]; return n; });
      return;
    }
    setOpenBody(prev => ({ ...prev, [messageId]: { loading: true } }));
    apiService.preview.getEmail(messageId)
      .then(r => setOpenBody(prev => ({ ...prev, [messageId]:
        r.data.found ? { body: r.data.body, isHtml: r.data.isHtml } : { error: 'Body not found' } })))
      .catch(() => setOpenBody(prev => ({ ...prev, [messageId]: { error: 'Failed to load' } })));
  };

  if (loading) return <div style={S.muted}>Loading history…</div>;
  if (error)   return <div style={S.error}>{error}</div>;
  if (!data || data.found === false)
    return (
      <div style={S.empty}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>🗒️</div>
        No migrated interaction history for this prospect.
      </div>
    );

  const { contact, linkedin_status, tags, timeline } = data;

  return (
    <div style={S.wrap}>
      <div style={S.head}>
        <div style={S.statusRow}>
          <span style={{ ...S.status, ...(linkedin_status === 'connected' ? S.connOk : S.connNo) }}>
            LinkedIn: {linkedin_status}
          </span>
          {contact?.email && <span style={S.chip}>{contact.email}</span>}
          {contact?.linkedin_url &&
            <a style={S.link} href={contact.linkedin_url} target="_blank" rel="noreferrer">profile</a>}
        </div>
        {tags?.length > 0 && (
          <div style={S.tags}>{tags.map((t, i) => <span key={i} style={S.tag}>{t}</span>)}</div>
        )}
      </div>

      {timeline.length === 0 && <div style={S.muted}>No recorded interactions.</div>}

      <div style={S.feed}>
        {timeline.map((ev, i) => {
          const isEmail = ev.channel === 'email';
          const opened = ev.message_id && openBody[ev.message_id];
          return (
            <div key={i} style={S.event}>
              <div style={S.evLeft}>
                <span style={{ ...S.channel, ...(isEmail ? S.chEmail : S.chLi) }}>{ev.channel}</span>
                {ev.direction && <span style={S.dir}>{ev.direction}</span>}
              </div>
              <div style={S.evBody}>
                <div
                  style={{ ...S.evDetail, ...(isEmail && ev.message_id ? S.clickable : {}) }}
                  onClick={() => isEmail && ev.message_id && toggleBody(ev.message_id)}
                  title={isEmail && ev.message_id ? 'Click to expand' : ''}
                >
                  {isEmail && ev.message_id && <span style={S.caret}>{opened ? '▾' : '▸'}</span>}
                  {ev.detail || '(no subject)'}
                </div>
                <div style={S.evMeta}>
                  {ev.sender ? ev.sender + ' · ' : ''}{fmt(ev.ts)}
                </div>
                {opened && (
                  <div style={S.bodyBox}>
                    {opened.loading ? <span style={S.muted}>Loading…</span>
                     : opened.error ? <span style={S.error}>{opened.error}</span>
                     : opened.isHtml
                        ? <div style={S.bodyHtml} dangerouslySetInnerHTML={{ __html: sanitize(opened.body) }} />
                        : <pre style={S.bodyText}>{opened.body}</pre>}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// minimal sanitizer: strip script/style/on* handlers. For a hardened
// version use DOMPurify if it's already a dependency.
function sanitize(html) {
  if (!html) return '';
  return html
    .replace(/<\s*script[^>]*>[\s\S]*?<\s*\/\s*script>/gi, '')
    .replace(/<\s*style[^>]*>[\s\S]*?<\s*\/\s*style>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript:/gi, '');
}

const S = {
  wrap: { padding: 4 },
  head: { borderBottom: '1px solid #eee', paddingBottom: 10, marginBottom: 10 },
  statusRow: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
  status: { fontSize: 12, padding: '2px 8px', borderRadius: 10 },
  connOk: { background: '#dcfce7', color: '#166534' },
  connNo: { background: '#f3f4f6', color: '#6b7280' },
  chip: { fontSize: 12, color: '#374151', background: '#f9fafb', padding: '2px 8px', borderRadius: 10, border: '1px solid #eee' },
  link: { fontSize: 12, color: '#2563eb' },
  tags: { marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' },
  tag: { fontSize: 11, background: '#fef3c7', color: '#92400e', padding: '1px 8px', borderRadius: 10 },
  feed: { display: 'flex', flexDirection: 'column', gap: 8 },
  event: { display: 'flex', gap: 12, padding: '8px 0', borderBottom: '1px solid #f6f6f6' },
  evLeft: { width: 84, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 4 },
  channel: { fontSize: 11, padding: '1px 6px', borderRadius: 4, textAlign: 'center', textTransform: 'uppercase' },
  chEmail: { background: '#e0e7ff', color: '#3730a3' },
  chLi: { background: '#cfe5fb', color: '#0a66c2' },
  dir: { fontSize: 10, color: '#6b7280', textAlign: 'center' },
  evBody: { flex: 1, minWidth: 0 },
  evDetail: { fontSize: 14 },
  clickable: { cursor: 'pointer', color: '#1f2937' },
  caret: { display: 'inline-block', width: 14, color: '#6b7280' },
  evMeta: { fontSize: 12, color: '#888', marginTop: 2 },
  bodyBox: { marginTop: 8, padding: 10, background: '#fafafa', border: '1px solid #eee', borderRadius: 6 },
  bodyText: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13, fontFamily: 'inherit', margin: 0 },
  bodyHtml: { fontSize: 13, lineHeight: 1.5, overflowX: 'auto' },
  muted: { color: '#888', fontSize: 13, padding: 10 },
  error: { color: '#9b1c1c', fontSize: 13, padding: 10 },
  empty: { textAlign: 'center', color: '#888', padding: 30, fontSize: 14 },
};
