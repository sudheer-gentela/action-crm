// ─────────────────────────────────────────────────────────────────────────────
// OAWhatsAppTemplates.js
//
// DROP-IN LOCATION: frontend/src/orgadmin/panels/OAWhatsAppTemplates.js
//
// Org WhatsApp template governance screen. Renders for both admins and members:
//   • Author/propose a template (name, category, language, body with {{n}},
//     friendly variable labels, audience).
//   • Admins see every template with a review queue: Approve (→ submits to Meta)
//     or Reject with a reason (shown back to the proposer).
//   • Members see their own proposals and outcomes, including rejection reasons
//     (internal admin reason and/or Meta's).
//
// Mount it wherever org-admin panels live (e.g. a new tab in OAIntegrations, or a
// nav item). It self-detects admin capability by trying the admin list and
// falling back to the personal list on 403.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from '../../apiService';

const CATS = ['UTILITY', 'MARKETING', 'AUTHENTICATION'];
const LANGS = ['en_US', 'en', 'en_GB', 'hi', 'hi_IN'];

const badge = (text, bg, fg) => (
  <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
    background: bg, color: fg, textTransform: 'uppercase', letterSpacing: 0.3 }}>{text}</span>
);

function statusBadge(t) {
  if (t.review_status === 'proposed')       return badge('awaiting review', '#fef3c7', '#92400e');
  if (t.review_status === 'admin_rejected') return badge('rejected by admin', '#fee2e2', '#991b1b');
  if (t.status === 'pending')               return badge('pending @ Meta', '#e0e7ff', '#3730a3');
  if (t.status === 'approved')              return badge('approved', '#d1fae5', '#065f46');
  if (t.status === 'rejected')              return badge('rejected by Meta', '#fee2e2', '#991b1b');
  if (t.status === 'paused')                return badge('paused', '#fef3c7', '#92400e');
  if (t.status === 'disabled')              return badge('disabled', '#f3f4f6', '#6b7280');
  return badge('draft', '#f3f4f6', '#6b7280');
}

export default function OAWhatsAppTemplates() {
  const [isAdmin, setIsAdmin] = useState(false);
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr]         = useState('');
  const [ok, setOk]           = useState('');
  const [rejecting, setRejecting] = useState({}); // { [id]: reasonText }

  // Author form
  const [f, setF] = useState({ name: '', category: 'UTILITY', language: 'en_US', bodyText: '', audience: 'any' });
  const varCount = [...new Set((f.bodyText.match(/\{\{\s*(\d+)\s*\}\}/g) || []).map(m => m.replace(/[^\d]/g, '')))].length;
  const [labels, setLabels] = useState({}); // { [i]: {label, example} }

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const res = await apiService.whatsapp.tplAll();
      setIsAdmin(true); setRows(res.data.templates || []);
    } catch (e) {
      if (e?.response?.status === 403) {
        setIsAdmin(false);
        try { const res = await apiService.whatsapp.tplMine(); setRows(res.data.templates || []); }
        catch { setRows([]); }
      } else { setErr(e?.response?.data?.error?.message || 'Could not load templates.'); }
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    setErr(''); setOk('');
    if (!f.name.trim() || !f.bodyText.trim()) { setErr('Name and body are required.'); return; }
    const variableMap = Array.from({ length: varCount }, (_, i) => ({
      index: i + 1, label: (labels[i]?.label || '').trim() || `Variable ${i + 1}`,
      example: (labels[i]?.example || '').trim(),
    }));
    try {
      await apiService.whatsapp.tplPropose({ ...f, variableMap });
      setOk(isAdmin ? 'Template submitted to Meta for approval.' : 'Template proposed — an admin will review it.');
      setF({ name: '', category: 'UTILITY', language: 'en_US', bodyText: '', audience: 'any' });
      setLabels({}); await load();
    } catch (e) { setErr(e?.response?.data?.error?.message || 'Could not save the template.'); }
  };

  const approve = async (id) => {
    setErr(''); setOk('');
    try { await apiService.whatsapp.tplReview(id, { action: 'approve' }); setOk('Approved and submitted to Meta.'); await load(); }
    catch (e) { setErr(e?.response?.data?.error?.message || 'Could not approve.'); }
  };
  const reject = async (id) => {
    const reason = (rejecting[id] || '').trim();
    if (!reason) { setErr('Enter a rejection reason.'); return; }
    setErr(''); setOk('');
    try {
      await apiService.whatsapp.tplReview(id, { action: 'reject', reason });
      setRejecting(r => ({ ...r, [id]: undefined })); setOk('Template rejected.'); await load();
    } catch (e) { setErr(e?.response?.data?.error?.message || 'Could not reject.'); }
  };

  const input = { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box' };
  const lbl = { fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.3, display: 'block', marginBottom: 4 };

  return (
    <div style={{ maxWidth: 900 }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 4px' }}>WhatsApp Templates</h2>
      <p style={{ color: '#6b7280', fontSize: 13, margin: '0 0 16px' }}>
        Author message templates for your team. {isAdmin
          ? 'Your templates go straight to Meta for approval; member proposals wait for your review.'
          : 'Your proposals are reviewed by an admin before being submitted to Meta.'}
      </p>

      {/* Author / propose */}
      <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 16, marginBottom: 24, background: '#fff' }}>
        <div style={{ fontWeight: 700, marginBottom: 12 }}>{isAdmin ? 'New template' : 'Propose a template'}</div>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
          <div><label style={lbl}>Name (lowercase_underscores)</label>
            <input style={input} value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder="e.g. handover_intro" /></div>
          <div><label style={lbl}>Category</label>
            <select style={input} value={f.category} onChange={e => setF({ ...f, category: e.target.value })}>
              {CATS.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
          <div><label style={lbl}>Language</label>
            <select style={input} value={f.language} onChange={e => setF({ ...f, language: e.target.value })}>
              {LANGS.map(l => <option key={l} value={l}>{l}</option>)}</select></div>
        </div>
        <div style={{ marginBottom: 10 }}>
          <label style={lbl}>Body — use {'{{1}}'}, {'{{2}}'} for variables</label>
          <textarea style={{ ...input, minHeight: 80, resize: 'vertical' }} value={f.bodyText}
            onChange={e => setF({ ...f, bodyText: e.target.value })}
            placeholder="Hi {{1}}, this is {{2}} from {{3}}. Your project update for today is ready." />
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>
            {varCount} variable{varCount === 1 ? '' : 's'} detected · a placeholder cannot be at the very start or end of the body.
          </div>
        </div>
        {varCount > 0 && (
          <div style={{ marginBottom: 10 }}>
            <label style={lbl}>Variable labels & samples</label>
            {Array.from({ length: varCount }, (_, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '40px 1fr 1fr', gap: 8, marginBottom: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: '#6b7280' }}>{`{{${i + 1}}}`}</span>
                <input style={input} placeholder={`Label (e.g. Customer name)`} value={labels[i]?.label || ''}
                  onChange={e => setLabels(l => ({ ...l, [i]: { ...l[i], label: e.target.value } }))} />
                <input style={input} placeholder="Sample value (for Meta review)" value={labels[i]?.example || ''}
                  onChange={e => setLabels(l => ({ ...l, [i]: { ...l[i], example: e.target.value } }))} />
              </div>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: '0 0 auto' }}>
            <label style={lbl}>Audience</label>
            <select style={{ ...input, width: 200 }} value={f.audience} onChange={e => setF({ ...f, audience: e.target.value })}>
              <option value="any">Any</option>
              <option value="internal">Internal team only</option>
              <option value="customer">Includes customer</option>
            </select>
          </div>
          <button onClick={submit} style={{ marginTop: 18, padding: '9px 18px', borderRadius: 6, border: 'none',
            background: '#059669', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
            {isAdmin ? 'Create & submit to Meta' : 'Propose template'}
          </button>
        </div>
        {ok  && <div style={{ marginTop: 10, fontSize: 12, color: '#059669' }}>{ok}</div>}
        {err && <div style={{ marginTop: 10, fontSize: 12, color: '#991b1b' }}>{err}</div>}
      </div>

      {/* List */}
      <div style={{ fontWeight: 700, marginBottom: 10 }}>{isAdmin ? 'All templates' : 'My templates'}</div>
      {loading ? <div style={{ color: '#9ca3af', fontSize: 13 }}>Loading…</div>
        : rows.length === 0 ? <div style={{ color: '#9ca3af', fontSize: 13 }}>No templates yet.</div>
        : rows.map(t => (
          <div key={t.id} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, marginBottom: 8, background: '#fff' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700 }}>{t.name}</span>
              <span style={{ fontSize: 12, color: '#6b7280' }}>{t.language} · {t.category}</span>
              {statusBadge(t)}
            </div>
            <div style={{ fontSize: 13, color: '#374151', margin: '8px 0', whiteSpace: 'pre-wrap' }}>{t.body_text}</div>
            {t.review_status === 'admin_rejected' && t.review_reason && (
              <div style={{ fontSize: 12, color: '#991b1b', marginBottom: 6 }}>Admin rejection: {t.review_reason}</div>
            )}
            {t.status === 'rejected' && t.rejection_reason && (
              <div style={{ fontSize: 12, color: '#991b1b', marginBottom: 6 }}>Meta rejection: {t.rejection_reason}</div>
            )}
            {isAdmin && t.review_status === 'proposed' && (
              <div style={{ borderTop: '1px solid #f3f4f6', paddingTop: 10, marginTop: 6 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button onClick={() => approve(t.id)} style={{ padding: '6px 14px', borderRadius: 6, border: 'none',
                    background: '#059669', color: '#fff', fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>Approve & submit</button>
                  <input style={{ ...input, flex: 1, minWidth: 200 }} placeholder="Rejection reason…"
                    value={rejecting[t.id] || ''} onChange={e => setRejecting(r => ({ ...r, [t.id]: e.target.value }))} />
                  <button onClick={() => reject(t.id)} style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #fca5a5',
                    background: '#fff', color: '#991b1b', fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>Reject</button>
                </div>
              </div>
            )}
          </div>
        ))}
    </div>
  );
}
