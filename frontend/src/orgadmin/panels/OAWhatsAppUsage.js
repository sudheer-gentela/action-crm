// ─────────────────────────────────────────────────────────────────────────────
// OAWhatsAppUsage.js
//
// DROP-IN LOCATION: frontend/src/orgadmin/panels/OAWhatsAppUsage.js
//
// Org WhatsApp usage + billing screen. Shows the period rollup from the cost
// ledger (messages, billable vs free, Meta cost, and — in provider_rebill mode —
// what GoWarm bills), plus lets an org admin choose their billing model.
// Mount next to the WhatsApp Business / Templates tabs in the org-admin area.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from '../../apiService';

const money = (n, cur) => `${cur || 'INR'} ${Number(n || 0).toFixed(3)}`;
const cap = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');

export default function OAWhatsAppUsage() {
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
  const [from, setFrom] = useState(monthStart);
  const [to, setTo]     = useState('');
  const [data, setData] = useState(null);
  const [err, setErr]   = useState('');
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState('');

  const load = useCallback(async () => {
    setErr('');
    const q = `?from=${from}${to ? `&to=${to}` : ''}`;
    try { const res = await apiService.whatsapp.usage(q); setData(res.data); }
    catch (e) { setErr(e?.response?.data?.error?.message || 'Could not load usage.'); }
  }, [from, to]);
  useEffect(() => { load(); }, [load]);

  const setMode = async (mode) => {
    setSaving(true); setSavedMsg(''); setErr('');
    try { await apiService.whatsapp.setBilling({ billing_mode: mode }); setSavedMsg('Billing model updated.'); await load(); }
    catch (e) { setErr(e?.response?.data?.error?.message || 'Could not update.'); }
    finally { setSaving(false); }
  };

  const cfg = data?.config;
  const cur = data?.totals && data.byCategory?.[0]?.currency;
  const th = { textAlign: 'left', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.3, color: '#6b7280', padding: '6px 10px', borderBottom: '1px solid #e5e7eb' };
  const td = { fontSize: 13, padding: '8px 10px', borderBottom: '1px solid #f3f4f6' };

  return (
    <div style={{ maxWidth: 900 }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 4px' }}>WhatsApp Usage & Billing</h2>
      <p style={{ color: '#6b7280', fontSize: 13, margin: '0 0 16px' }}>
        Message volume and cost for the selected period. Costs are captured from Meta's per-message
        pricing. Note: from 1 Oct 2026 Meta begins charging for in-window service/utility messages too.
      </p>

      {/* Billing model */}
      <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 16, marginBottom: 20, background: '#fff' }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>Billing model</div>
        <div style={{ fontSize: 13, color: '#374151', marginBottom: 10 }}>
          Choose who pays Meta for this org's WhatsApp messages.
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {[
            { m: 'customer_direct', t: 'We pay Meta directly', d: 'Your own WABA/card is billed by Meta. GoWarm only tracks usage.' },
            { m: 'provider_rebill', t: 'GoWarm bills us', d: 'GoWarm’s account pays Meta and rebills you (with any agreed markup).' },
          ].map(o => {
            const active = cfg?.billing_mode === o.m;
            return (
              <button key={o.m} disabled={saving} onClick={() => setMode(o.m)}
                style={{ flex: 1, minWidth: 260, textAlign: 'left', padding: 12, borderRadius: 8, cursor: 'pointer',
                  border: active ? '2px solid #059669' : '1px solid #d1d5db', background: active ? '#ecfdf5' : '#fff' }}>
                <div style={{ fontWeight: 700, fontSize: 13 }}>{o.t}{active ? ' ✓' : ''}</div>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 3 }}>{o.d}</div>
              </button>
            );
          })}
        </div>
        {cfg?.billing_mode === 'provider_rebill' && (
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 8 }}>
            Markup applied by GoWarm: {Number(cfg.markup_pct || 0)}%.
          </div>
        )}
        {savedMsg && <div style={{ fontSize: 12, color: '#059669', marginTop: 8 }}>{savedMsg}</div>}
      </div>

      {/* Period */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 14 }}>
        <div><label style={{ fontSize: 11, color: '#6b7280', display: 'block' }}>From</label>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)}
            style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13 }} /></div>
        <div><label style={{ fontSize: 11, color: '#6b7280', display: 'block' }}>To (optional)</label>
          <input type="date" value={to} onChange={e => setTo(e.target.value)}
            style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13 }} /></div>
      </div>

      {err && <div style={{ fontSize: 12, color: '#991b1b', marginBottom: 10 }}>{err}</div>}

      {/* Totals */}
      {data && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          {[
            { k: 'Messages', v: data.totals.messages },
            { k: 'Billable', v: data.totals.billable_messages },
            { k: 'Meta cost', v: money(data.totals.meta_cost, cur) },
            ...(cfg?.billing_mode === 'provider_rebill' ? [{ k: 'Billed to you', v: money(data.totals.billed, cur) }] : []),
          ].map(c => (
            <div key={c.k} style={{ flex: 1, minWidth: 140, border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, background: '#fff' }}>
              <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.3, color: '#6b7280' }}>{c.k}</div>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>{c.v}</div>
            </div>
          ))}
        </div>
      )}

      {/* Breakdown */}
      <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={th}>Category</th><th style={th}>Audience</th><th style={th}>Messages</th>
            <th style={th}>Billable</th><th style={th}>Meta cost</th>
            {cfg?.billing_mode === 'provider_rebill' && <th style={th}>Billed</th>}
          </tr></thead>
          <tbody>
            {(data?.byCategory || []).length === 0 ? (
              <tr><td style={{ ...td, color: '#9ca3af' }} colSpan={6}>No messages in this period.</td></tr>
            ) : data.byCategory.map((r, i) => (
              <tr key={i}>
                <td style={td}>{cap(r.category)}</td>
                <td style={td}>{cap(r.audience)}</td>
                <td style={td}>{r.messages}</td>
                <td style={td}>{r.billable_messages}</td>
                <td style={td}>{money(r.meta_cost, r.currency)}</td>
                {cfg?.billing_mode === 'provider_rebill' && <td style={td}>{money(r.billed, r.currency)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
