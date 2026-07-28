// ─────────────────────────────────────────────────────────────────────────────
// SAWhatsAppBilling.js
//
// DROP-IN LOCATION: frontend/src/SAWhatsAppBilling.js
//
// GoWarm (superadmin) cross-org WhatsApp billing. Per-org usage, Meta cost, what
// each org is billed, and margin — plus inline control of each org's billing
// model, markup %, and platform fee. Mount inside the superadmin area.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';

const money = (n, cur) => `${cur || 'INR'} ${Number(n || 0).toFixed(3)}`;

export default function SAWhatsAppBilling() {
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
  const [from, setFrom] = useState(monthStart);
  const [to, setTo]     = useState('');
  const [data, setData] = useState(null);
  const [err, setErr]   = useState('');
  const [edits, setEdits] = useState({});   // { [orgId]: { billing_mode, markup_pct, platform_fee } }
  const [savedOrg, setSavedOrg] = useState(null);

  const load = useCallback(async () => {
    setErr('');
    const q = `?from=${from}${to ? `&to=${to}` : ''}`;
    try { const res = await apiService.whatsapp.adminUsage(q); setData(res.data); }
    catch (e) { setErr(e?.response?.data?.error?.message || 'Could not load billing.'); }
  }, [from, to]);
  useEffect(() => { load(); }, [load]);

  const editFor = (o) => edits[o.org_id] || { billing_mode: o.billing_mode, markup_pct: o.markup_pct, platform_fee: 0 };
  const setEdit = (orgId, patch) => setEdits(e => ({ ...e, [orgId]: { ...editFor({ org_id: orgId, ...patch }), ...(e[orgId] || {}), ...patch } }));

  const save = async (o) => {
    const e = editFor(o);
    setErr(''); setSavedOrg(null);
    try {
      await apiService.whatsapp.adminSetBilling(o.org_id, {
        billing_mode: e.billing_mode, markup_pct: Number(e.markup_pct) || 0, platform_fee: Number(e.platform_fee) || 0,
      });
      setSavedOrg(o.org_id); await load();
    } catch (err) { setErr(err?.response?.data?.error?.message || 'Could not save.'); }
  };

  const th = { textAlign: 'left', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.3, color: '#6b7280', padding: '6px 10px', borderBottom: '1px solid #e5e7eb' };
  const td = { fontSize: 13, padding: '8px 10px', borderBottom: '1px solid #f3f4f6', verticalAlign: 'middle' };
  const inp = { padding: '5px 8px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 12 };

  return (
    <div style={{ maxWidth: 1100 }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 4px' }}>WhatsApp Billing — all orgs</h2>
      <p style={{ color: '#6b7280', fontSize: 13, margin: '0 0 16px' }}>
        Cross-org usage and cost. Margin (billed − Meta cost) is meaningful only for orgs on
        “GoWarm bills them.” Costs come from Meta's per-message pricing webhook.
      </p>

      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 14 }}>
        <div><label style={{ fontSize: 11, color: '#6b7280', display: 'block' }}>From</label>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={{ ...inp, fontSize: 13 }} /></div>
        <div><label style={{ fontSize: 11, color: '#6b7280', display: 'block' }}>To (optional)</label>
          <input type="date" value={to} onChange={e => setTo(e.target.value)} style={{ ...inp, fontSize: 13 }} /></div>
      </div>

      {err && <div style={{ fontSize: 12, color: '#991b1b', marginBottom: 10 }}>{err}</div>}

      {data && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          {[
            { k: 'Orgs', v: data.orgs.length },
            { k: 'Messages', v: data.totals.messages },
            { k: 'Meta cost', v: money(data.totals.meta_cost) },
            { k: 'Billed', v: money(data.totals.billed) },
            { k: 'Margin', v: money(data.totals.margin) },
          ].map(c => (
            <div key={c.k} style={{ flex: 1, minWidth: 130, border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, background: '#fff' }}>
              <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.3, color: '#6b7280' }}>{c.k}</div>
              <div style={{ fontSize: 19, fontWeight: 700, marginTop: 4 }}>{c.v}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'auto', background: '#fff' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
          <thead><tr>
            <th style={th}>Org</th><th style={th}>Msgs</th><th style={th}>Meta cost</th>
            <th style={th}>Billed</th><th style={th}>Margin</th>
            <th style={th}>Model</th><th style={th}>Markup %</th><th style={th}>Fee</th><th style={th}></th>
          </tr></thead>
          <tbody>
            {(data?.orgs || []).length === 0 ? (
              <tr><td style={{ ...td, color: '#9ca3af' }} colSpan={9}>No usage in this period.</td></tr>
            ) : data.orgs.map(o => {
              const e = editFor(o);
              return (
                <tr key={o.org_id}>
                  <td style={td}><strong>{o.org_name}</strong><div style={{ fontSize: 11, color: '#9ca3af' }}>#{o.org_id}</div></td>
                  <td style={td}>{o.messages}</td>
                  <td style={td}>{money(o.meta_cost, o.currency)}</td>
                  <td style={td}>{money(o.billed, o.currency)}</td>
                  <td style={{ ...td, color: o.margin >= 0 ? '#065f46' : '#991b1b' }}>{money(o.margin, o.currency)}</td>
                  <td style={td}>
                    <select value={e.billing_mode} onChange={ev => setEdit(o.org_id, { billing_mode: ev.target.value })} style={inp}>
                      <option value="customer_direct">Customer pays</option>
                      <option value="provider_rebill">GoWarm bills</option>
                    </select>
                  </td>
                  <td style={td}>
                    <input type="number" step="0.1" value={e.markup_pct} onChange={ev => setEdit(o.org_id, { markup_pct: ev.target.value })}
                      style={{ ...inp, width: 70 }} disabled={e.billing_mode !== 'provider_rebill'} />
                  </td>
                  <td style={td}>
                    <input type="number" step="1" value={e.platform_fee} onChange={ev => setEdit(o.org_id, { platform_fee: ev.target.value })}
                      style={{ ...inp, width: 70 }} />
                  </td>
                  <td style={td}>
                    <button onClick={() => save(o)} style={{ padding: '5px 12px', borderRadius: 6, border: 'none',
                      background: '#059669', color: '#fff', fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>
                      {savedOrg === o.org_id ? 'Saved ✓' : 'Save'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
