// ─────────────────────────────────────────────────────────────
// PreviewContacts.js  —  read-only validation UI for migrated Mongo data
//
// Shows the logged-in user's contacts WITH activity, and a merged
// email + LinkedIn timeline per contact, with tags and LinkedIn
// connection status. Reads /api/preview/* (writes nothing).
//
// Wire a route to it, e.g. in your router:
//   <Route path="/preview" element={<PreviewContacts />} />
//
// Requires apiService.preview (see previewApi.js integration note).
// ─────────────────────────────────────────────────────────────
import React, { useEffect, useState, useCallback } from 'react';
import { apiService } from './apiService';

const PAGE = 50;

export default function PreviewContacts() {
  const [summary, setSummary]     = useState(null);
  const [contacts, setContacts]   = useState([]);
  const [total, setTotal]         = useState(0);
  const [offset, setOffset]       = useState(0);
  const [q, setQ]                 = useState('');
  const [selected, setSelected]   = useState(null);
  const [timeline, setTimeline]   = useState(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingTl, setLoadingTl]     = useState(false);
  const [error, setError]         = useState(null);

  useEffect(() => {
    if (!apiService.preview) {
      setError('Preview API not available — the frontend build may be out of date. Redeploy and hard-refresh.');
      setSummary({ hasPreview: false });
      return;
    }
    apiService.preview.me()
      .then(r => setSummary(r.data))
      .catch(() => setSummary({ hasPreview: false }));
  }, []);

  const loadContacts = useCallback((newOffset, query) => {
    if (!apiService.preview) { setLoadingList(false); return; }
    setLoadingList(true);
    apiService.preview.getContacts({ q: query, limit: PAGE, offset: newOffset })
      .then(r => { setContacts(r.data.contacts); setTotal(r.data.total); setOffset(newOffset); })
      .catch(() => setError('Failed to load contacts'))
      .finally(() => setLoadingList(false));
  }, []);

  useEffect(() => { loadContacts(0, ''); }, [loadContacts]);

  const openContact = (c) => {
    setSelected(c);
    setTimeline(null);
    if (!apiService.preview) { setLoadingTl(false); return; }
    setLoadingTl(true);
    apiService.preview.getTimeline(c.contact_id)
      .then(r => setTimeline(r.data))
      .catch(() => setError('Failed to load timeline'))
      .finally(() => setLoadingTl(false));
  };

  const onSearch = (e) => {
    e.preventDefault();
    loadContacts(0, q.trim());
  };

  if (summary && !summary.hasPreview) {
    return (
      <div style={S.wrap}>
        <div style={S.empty}>
          No migrated preview data is associated with your account.
        </div>
      </div>
    );
  }

  return (
    <div style={S.wrap}>
      <div style={S.header}>
        <h2 style={S.h2}>Contact Activity Preview</h2>
        {summary && (
          <span style={S.sub}>
            {summary.contacts_with_activity} contacts with activity
          </span>
        )}
      </div>

      {error && <div style={S.error}>{error}</div>}

      <div style={S.split}>
        {/* LEFT: contact list */}
        <div style={S.listPane}>
          <form onSubmit={onSearch} style={S.searchRow}>
            <input
              style={S.search}
              placeholder="Search name or company…"
              value={q}
              onChange={e => setQ(e.target.value)}
            />
            <button style={S.btn} type="submit">Search</button>
          </form>

          {loadingList ? (
            <div style={S.muted}>Loading…</div>
          ) : (
            <div style={S.list}>
              {contacts.map(c => (
                <div
                  key={c.contact_id}
                  style={{ ...S.row, ...(selected?.contact_id === c.contact_id ? S.rowActive : {}) }}
                  onClick={() => openContact(c)}
                >
                  <div style={S.name}>
                    {(c.first_name || '') + ' ' + (c.last_name || '')}
                  </div>
                  <div style={S.company}>
                    {c.current_title ? c.current_title + ' · ' : ''}{c.current_company || '—'}
                  </div>
                  <div style={S.badges}>
                    {c.email_count > 0 && <span style={S.badge}>{c.email_count} emails</span>}
                    {c.linkedin_url && <span style={S.badgeLi}>in</span>}
                  </div>
                </div>
              ))}
              {contacts.length === 0 && <div style={S.muted}>No contacts match.</div>}
            </div>
          )}

          <div style={S.pager}>
            <button style={S.btnGhost} disabled={offset === 0}
              onClick={() => loadContacts(Math.max(0, offset - PAGE), q)}>‹ Prev</button>
            <span style={S.muted}>{offset + 1}–{Math.min(offset + PAGE, total)} of {total}</span>
            <button style={S.btnGhost} disabled={offset + PAGE >= total}
              onClick={() => loadContacts(offset + PAGE, q)}>Next ›</button>
          </div>
        </div>

        {/* RIGHT: timeline */}
        <div style={S.detailPane}>
          {!selected ? (
            <div style={S.muted}>Select a contact to see their interaction history.</div>
          ) : loadingTl ? (
            <div style={S.muted}>Loading timeline…</div>
          ) : timeline ? (
            <>
              <div style={S.detailHead}>
                <h3 style={S.h3}>
                  {(timeline.contact?.first_name || '') + ' ' + (timeline.contact?.last_name || '')}
                </h3>
                <div style={S.detailMeta}>
                  {timeline.contact?.current_title}{timeline.contact?.current_company ? ' · ' + timeline.contact.current_company : ''}
                </div>
                <div style={S.statusRow}>
                  <span style={{ ...S.status, ...(timeline.linkedin_status === 'connected' ? S.connOk : S.connNo) }}>
                    LinkedIn: {timeline.linkedin_status}
                  </span>
                  {timeline.contact?.email && <span style={S.chip}>{timeline.contact.email}</span>}
                  {timeline.contact?.linkedin_url && (
                    <a style={S.link} href={timeline.contact.linkedin_url} target="_blank" rel="noreferrer">profile</a>
                  )}
                </div>
                {timeline.tags?.length > 0 && (
                  <div style={S.tags}>
                    {timeline.tags.map((t, i) => <span key={i} style={S.tag}>{t}</span>)}
                  </div>
                )}
              </div>

              <div style={S.feed}>
                {timeline.timeline.length === 0 && <div style={S.muted}>No recorded interactions.</div>}
                {timeline.timeline.map((ev, i) => (
                  <div key={i} style={S.event}>
                    <div style={S.evLeft}>
                      <span style={{ ...S.channel, ...(ev.channel === 'email' ? S.chEmail : S.chLi) }}>
                        {ev.channel}
                      </span>
                      {ev.direction && <span style={S.dir}>{ev.direction}</span>}
                    </div>
                    <div style={S.evBody}>
                      <div style={S.evDetail}>{ev.detail || '(no subject)'}</div>
                      <div style={S.evMeta}>
                        {ev.sender ? ev.sender + ' · ' : ''}{ev.ts ? new Date(ev.ts).toLocaleString() : ''}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// inline styles keep this a single drop-in file; restyle to your design system later
const S = {
  wrap: { padding: 24, fontFamily: 'system-ui, sans-serif', color: '#1a1a1a' },
  header: { display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 16 },
  h2: { margin: 0, fontSize: 22 },
  sub: { color: '#666', fontSize: 14 },
  error: { background: '#fde8e8', color: '#9b1c1c', padding: '8px 12px', borderRadius: 6, marginBottom: 12 },
  empty: { padding: 40, textAlign: 'center', color: '#666' },
  split: { display: 'flex', gap: 20, alignItems: 'flex-start' },
  listPane: { width: 380, flexShrink: 0 },
  detailPane: { flex: 1, minHeight: 400, border: '1px solid #eee', borderRadius: 8, padding: 20 },
  searchRow: { display: 'flex', gap: 8, marginBottom: 12 },
  search: { flex: 1, padding: '8px 10px', border: '1px solid #ddd', borderRadius: 6 },
  btn: { padding: '8px 14px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' },
  btnGhost: { padding: '6px 10px', background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer' },
  list: { border: '1px solid #eee', borderRadius: 8, overflow: 'hidden' },
  row: { padding: '10px 12px', borderBottom: '1px solid #f2f2f2', cursor: 'pointer' },
  rowActive: { background: '#eff6ff' },
  name: { fontWeight: 600, fontSize: 14 },
  company: { fontSize: 12, color: '#666', marginTop: 2 },
  badges: { marginTop: 4, display: 'flex', gap: 6 },
  badge: { fontSize: 11, background: '#eef2ff', color: '#3730a3', padding: '1px 6px', borderRadius: 10 },
  badgeLi: { fontSize: 11, background: '#0a66c2', color: '#fff', padding: '1px 6px', borderRadius: 10, fontWeight: 700 },
  pager: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 },
  muted: { color: '#888', fontSize: 14, padding: 12 },
  detailHead: { borderBottom: '1px solid #eee', paddingBottom: 12, marginBottom: 12 },
  h3: { margin: 0, fontSize: 18 },
  detailMeta: { color: '#666', fontSize: 13, marginTop: 2 },
  statusRow: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' },
  status: { fontSize: 12, padding: '2px 8px', borderRadius: 10 },
  connOk: { background: '#dcfce7', color: '#166534' },
  connNo: { background: '#f3f4f6', color: '#6b7280' },
  chip: { fontSize: 12, color: '#374151', background: '#f9fafb', padding: '2px 8px', borderRadius: 10, border: '1px solid #eee' },
  link: { fontSize: 12, color: '#2563eb' },
  tags: { marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' },
  tag: { fontSize: 11, background: '#fef3c7', color: '#92400e', padding: '1px 8px', borderRadius: 10 },
  feed: { display: 'flex', flexDirection: 'column', gap: 10 },
  event: { display: 'flex', gap: 12, padding: '8px 0', borderBottom: '1px solid #f6f6f6' },
  evLeft: { width: 90, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 4 },
  channel: { fontSize: 11, padding: '1px 6px', borderRadius: 4, textAlign: 'center', textTransform: 'uppercase' },
  chEmail: { background: '#e0e7ff', color: '#3730a3' },
  chLi: { background: '#cfe5fb', color: '#0a66c2' },
  dir: { fontSize: 10, color: '#6b7280', textAlign: 'center' },
  evBody: { flex: 1 },
  evDetail: { fontSize: 14 },
  evMeta: { fontSize: 12, color: '#888', marginTop: 2 },
};
