// ─────────────────────────────────────────────────────────────────────────────
// ProjectBoQ.js — Bill of Quantities for one project (2026_113 / 2026_114)
//
// Three numbers per line, kept visually distinct because they answer different
// questions:
//
//   Planned      the original bill
//   Variation    approved scope change, shown SEPARATELY so overrun stays
//                distinguishable from sanctioned growth
//   Left         sanctioned minus spent; negative means this line has overrun
//
// The ledger lives inside the row, because "why is this line at 9.45L" gets
// asked while looking at the line. Reversals are shown in red next to what they
// reverse — an append-only ledger only earns its keep if the correction is
// visible, not tidied away into a total.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';

const C = {
  line: '#e5e7eb', muted: '#6b7280', danger: '#b91c1c', ok: '#047857',
  warn: '#b45309', warnBg: '#fef3c7', accent: '#0369a1', head: '#374151',
};

const PROC_LABEL = {
  not_required: 'Not required',
  to_procure:   'To procure',
  rfq_issued:   'RFQ issued',
  quoted:       'Quoted',
  po_issued:    'PO issued',
  in_transit:   'In transit',
  delivered:    'Delivered',
};
const PROC_ORDER = Object.keys(PROC_LABEL);

function money(n, currency) {
  if (n === null || n === undefined) return '—';
  const v = Number(n);
  // Indian grouping, since the default currency is INR and lakhs read wrong
  // under Western grouping.
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: currency || 'INR', maximumFractionDigits: 0,
  }).format(v);
}
function qty(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('en-IN', { maximumFractionDigits: 3 });
}
function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? '—'
    : dt.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: '2-digit' });
}

function Metric({ label, value, tone }) {
  return (
    <div style={{ background: '#f9fafb', borderRadius: 8, padding: '11px 13px', flex: '1 1 120px', minWidth: 120 }}>
      <div style={{ fontSize: 11, color: C.muted }}>{label}</div>
      <div style={{ fontSize: 19, fontWeight: 600, marginTop: 3, color: tone || '#111827' }}>{value}</div>
    </div>
  );
}

export default function ProjectBoQ({ handoverId }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [openRow, setOpenRow] = useState(null);
  const [ledger, setLedger] = useState({});      // itemId -> { loading, entries }
  const [vendors, setVendors] = useState([]);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);

  const load = useCallback(async () => {
    setState(s => ({ ...s, loading: true, error: null }));
    try {
      // Raw axios: the payload is at r.data, not on the response itself.
      const r = await apiService.handovers.boq(handoverId);
      setState({ loading: false, error: null, data: r.data });
    } catch (err) {
      setState({ loading: false, data: null,
        error: err?.response?.data?.error?.message || err.message || 'Could not load the bill' });
    }
  }, [handoverId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    apiService.handovers.boqVendors()
      .then(r => setVendors(r.data?.vendors || []))
      // A failed vendor list must not block the bill — the column just shows
      // ids-less blanks rather than the screen erroring.
      .catch(() => setVendors([]));
  }, []);

  const say = (kind, msg) => { setFlash({ kind, msg }); setTimeout(() => setFlash(null), 4000); };

  const expand = async (itemId) => {
    if (openRow === itemId) { setOpenRow(null); return; }
    setOpenRow(itemId);
    if (ledger[itemId]) return;
    setLedger(l => ({ ...l, [itemId]: { loading: true } }));
    try {
      const r = await apiService.handovers.boqItemProgress(itemId);
      setLedger(l => ({ ...l, [itemId]: { loading: false, entries: r.data?.entries || [] } }));
    } catch (err) {
      setLedger(l => ({ ...l, [itemId]: { loading: false, error: err.message } }));
    }
  };

  const refreshRow = async (itemId) => {
    const r = await apiService.handovers.boqItemProgress(itemId);
    setLedger(l => ({ ...l, [itemId]: { loading: false, entries: r.data?.entries || [] } }));
    await load();
  };

  const recordProgress = async (item) => {
    const raw = window.prompt(
      `Quantity completed for ${item.itemCode || item.description} (${item.unit || 'units'}).\n` +
      `Enter the amount done SINCE the last entry, not the running total.`
    );
    if (raw === null) return;
    const n = Number(raw);
    if (!Number.isFinite(n) || n === 0) { say('error', 'Enter a non-zero quantity.'); return; }
    const note = window.prompt('Note (optional) — what does this cover?') || '';
    setBusy(true);
    try {
      await apiService.handovers.recordBoqProgress(item.id, { qtyDelta: n, note });
      await refreshRow(item.id);
      say('ok', 'Progress recorded.');
    } catch (err) {
      say('error', err?.response?.data?.error?.message || 'Could not record progress');
    } finally { setBusy(false); }
  };

  const reverse = async (entry, itemId) => {
    const note = window.prompt('Why is this entry being reversed?');
    if (note === null) return;
    setBusy(true);
    try {
      await apiService.handovers.reverseBoqEntry(entry.id, { note: note.trim() || undefined });
      await refreshRow(itemId);
      say('ok', 'Reversing entry posted.');
    } catch (err) {
      say('error', err?.response?.data?.error?.message || 'Could not reverse that entry');
    } finally { setBusy(false); }
  };

  const setProcurement = async (item, status) => {
    const bill = state.data?.bill;
    if (!bill) return;
    // If the line shares a PO with others, offer to advance them together —
    // that is the whole point of the reference, and doing it one line at a
    // time is how statuses go stale.
    let payload = { itemId: item.id, status };
    if (item.procurementRef) {
      const sameRef = (state.data.items || [])
        .filter(i => i.procurementRef === item.procurementRef && i.id !== item.id).length;
      if (sameRef > 0 && window.confirm(
        `${sameRef} other line${sameRef === 1 ? '' : 's'} share ${item.procurementRef}. ` +
        `Advance all of them to "${PROC_LABEL[status]}"?`)) {
        payload = { procurementRef: item.procurementRef, status };
      }
    }
    setBusy(true);
    try {
      const r = await apiService.handovers.setBoqProcurement(bill.id, payload);
      const n = r.data?.updated ?? 0;
      await load();
      say('ok', `Updated ${n} line${n === 1 ? '' : 's'}.`);
    } catch (err) {
      say('error', err?.response?.data?.error?.message || 'Could not update procurement');
    } finally { setBusy(false); }
  };

  const setVendor = async (item, vendorAccountId) => {
    setBusy(true);
    try {
      await apiService.handovers.updateBoqItem(item.id, { vendorAccountId: vendorAccountId || null });
      await load();
    } catch (err) {
      say('error', err?.response?.data?.error?.message || 'Could not set the vendor');
    } finally { setBusy(false); }
  };

  const createBill = async () => {
    setBusy(true);
    try { await apiService.handovers.createBoq(handoverId, {}); await load(); }
    catch (err) { say('error', err?.response?.data?.error?.message || 'Could not create the bill'); }
    finally { setBusy(false); }
  };

  if (state.loading) return <div style={{ padding: 20, fontSize: 13, color: C.muted }}>Loading bill…</div>;
  if (state.error) {
    return (
      <div style={{ padding: 20 }}>
        <div style={{ background: '#fee2e2', color: '#991b1b', padding: '8px 12px', borderRadius: 6, fontSize: 13 }}>
          {state.error}
        </div>
        <button onClick={load} style={{ marginTop: 10, fontSize: 12, padding: '5px 10px', cursor: 'pointer' }}>Retry</button>
      </div>
    );
  }

  // Per-key guards rather than one fallback object: a 200 with an unexpected
  // shape must still render, not throw on .length or .map.
  const d0       = state.data || {};
  const bill     = d0.bill || null;
  const items    = Array.isArray(d0.items) ? d0.items : [];
  const sections = Array.isArray(d0.sections) ? d0.sections : [];
  const totals   = d0.totals || {};
  const config   = d0.config || {};

  if (!bill) {
    return (
      <div style={{ padding: 24, fontSize: 13, color: C.muted, lineHeight: 1.7 }}>
        This project has no bill of quantities yet.
        <div style={{ marginTop: 12 }}>
          <button onClick={createBill} disabled={busy}
                  style={{ padding: '7px 14px', fontSize: 13, borderRadius: 6, border: 'none',
                           background: C.accent, color: '#fff', cursor: 'pointer' }}>
            Create a bill
          </button>
        </div>
      </div>
    );
  }

  const cur = bill.currency;
  const grouped = [];
  const seen = new Map();
  for (const it of items) {
    const key = it.section || 'Unsectioned';
    if (!seen.has(key)) { seen.set(key, { section: key, items: [] }); grouped.push(seen.get(key)); }
    seen.get(key).items.push(it);
  }
  const sectionTotals = Object.fromEntries(sections.map(s => [s.section, s]));

  return (
    <div style={{ padding: '16px 20px 30px' }}>

      {flash && (
        <div style={{ marginBottom: 12, padding: '7px 11px', borderRadius: 6, fontSize: 12,
                      background: flash.kind === 'ok' ? '#ecfdf5' : '#fee2e2',
                      color: flash.kind === 'ok' ? C.ok : C.danger }}>{flash.msg}</div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div>
          <span style={{ fontSize: 14, fontWeight: 600 }}>{bill.name}</span>
          <span style={{ marginLeft: 8, fontSize: 11, padding: '2px 7px', borderRadius: 4,
                         background: bill.status === 'active' ? '#ecfdf5' : '#f3f4f6',
                         color: bill.status === 'active' ? C.ok : C.muted }}>{bill.status}</span>
          {config?.itemsLocked && (
            <span style={{ marginLeft: 6, fontSize: 11, padding: '2px 7px', borderRadius: 4,
                           background: C.warnBg, color: C.warn }}>quantities locked</span>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <Metric label="Bill value" value={money(totals?.plannedAmount, cur)} />
        <Metric label="Approved variations" value={money(totals?.variationAmount, cur)}
                tone={totals?.variationAmount ? C.warn : undefined} />
        <Metric label="Spent" value={money(totals?.spentAmount, cur)} />
        <Metric label="Left" value={money(totals?.remainingAmount, cur)}
                tone={totals?.remainingAmount < 0 ? C.danger : C.ok} />
        <Metric label="Lines overrun" value={totals?.overrunItems ?? 0}
                tone={totals?.overrunItems ? C.danger : undefined} />
      </div>

      {totals?.unstartedItems > 0 && totals.itemCount > 0 && (
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 12 }}>
          {totals.unstartedItems} of {totals.itemCount} lines have nothing booked yet, so the
          remaining figure will move a lot as work starts.
        </div>
      )}

      {items.length === 0 ? (
        <div style={{ fontSize: 13, color: C.muted, padding: '12px 0' }}>
          The bill has no lines yet.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: C.muted, fontSize: 10 }}>
                <th style={{ padding: '0 6px 7px', fontWeight: 600, width: '26%' }}>Item</th>
                <th style={{ padding: '0 6px 7px', fontWeight: 600 }}>Qty</th>
                <th style={{ padding: '0 6px 7px', fontWeight: 600 }}>Rate</th>
                <th style={{ padding: '0 6px 7px', fontWeight: 600 }}>Planned</th>
                <th style={{ padding: '0 6px 7px', fontWeight: 600 }}>Var.</th>
                <th style={{ padding: '0 6px 7px', fontWeight: 600 }}>Spent</th>
                <th style={{ padding: '0 6px 7px', fontWeight: 600 }}>Left</th>
                <th style={{ padding: '0 6px 7px', fontWeight: 600, width: '15%' }}>Vendor</th>
                <th style={{ padding: '0 6px 7px', fontWeight: 600, width: '12%' }}>Procurement</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map(g => {
                const st = sectionTotals[g.section];
                return (
                  <React.Fragment key={g.section}>
                    <tr>
                      <td colSpan={9} style={{ padding: '11px 6px 4px' }}>
                        <span style={{ fontSize: 10, color: C.muted, letterSpacing: '0.04em' }}>
                          {g.section.toUpperCase()}
                        </span>
                        {st && (
                          <span style={{ fontSize: 11, color: C.muted, marginLeft: 10 }}>
                            {money(st.plannedAmount, cur)} planned · {money(st.spentAmount, cur)} spent
                            {st.overrunItems > 0 && (
                              <span style={{ color: C.danger }}> · {st.overrunItems} overrun</span>
                            )}
                          </span>
                        )}
                      </td>
                    </tr>

                    {g.items.map(it => {
                      const open = openRow === it.id;
                      const L = ledger[it.id];
                      return (
                        <React.Fragment key={it.id}>
                          <tr style={{ borderTop: `1px solid ${C.line}`,
                                       background: open ? '#f9fafb' : 'transparent' }}>
                            <td style={{ padding: '8px 6px', cursor: 'pointer' }} onClick={() => expand(it.id)}>
                              <span style={{ color: C.muted, marginRight: 4 }}>{open ? '▾' : '▸'}</span>
                              {it.itemCode ? `${it.itemCode} ` : ''}{it.description}
                              <div style={{ fontSize: 10, color: C.muted }}>
                                {it.unit || '—'} · {qty(it.executedQty)} of {qty(it.plannedQty)} done
                              </div>
                            </td>
                            <td style={{ padding: '8px 6px' }}>{qty(it.plannedQty)}</td>
                            <td style={{ padding: '8px 6px' }}>{money(it.rate, cur)}</td>
                            <td style={{ padding: '8px 6px' }}>{money(it.plannedAmount, cur)}</td>
                            <td style={{ padding: '8px 6px', color: it.variationAmount ? C.warn : C.muted }}>
                              {it.variationAmount ? `+${money(it.variationAmount, cur)}` : '—'}
                            </td>
                            <td style={{ padding: '8px 6px' }}>
                              {it.entryCount ? money(it.spentAmount, cur) : <span style={{ color: C.muted }}>—</span>}
                            </td>
                            <td style={{ padding: '8px 6px', color: it.isOverrun ? C.danger : undefined,
                                         fontWeight: it.isOverrun ? 600 : 400 }}>
                              {money(it.remainingAmount, cur)}
                            </td>
                            <td style={{ padding: '8px 6px' }}>
                              <select value={it.vendorAccountId || ''} disabled={busy}
                                      onChange={e => setVendor(it, e.target.value ? parseInt(e.target.value, 10) : null)}
                                      style={{ fontSize: 11, maxWidth: '100%', padding: '2px 4px',
                                               border: `1px solid ${C.line}`, borderRadius: 4 }}>
                                <option value="">—</option>
                                {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                              </select>
                            </td>
                            <td style={{ padding: '8px 6px' }}>
                              <select value={it.procurementStatus} disabled={busy}
                                      onChange={e => setProcurement(it, e.target.value)}
                                      style={{ fontSize: 11, maxWidth: '100%', padding: '2px 4px',
                                               border: `1px solid ${C.line}`, borderRadius: 4 }}>
                                {PROC_ORDER.map(k => <option key={k} value={k}>{PROC_LABEL[k]}</option>)}
                              </select>
                              {it.procurementRef && (
                                <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>{it.procurementRef}</div>
                              )}
                            </td>
                          </tr>

                          {open && (
                            <tr style={{ background: '#f9fafb' }}>
                              <td colSpan={9} style={{ padding: '0 6px 12px 24px' }}>
                                {L?.loading && <div style={{ fontSize: 12, color: C.muted }}>Loading ledger…</div>}
                                {L?.error && <div style={{ fontSize: 12, color: C.danger }}>{L.error}</div>}
                                {L && !L.loading && !L.error && (
                                  <>
                                    <div style={{ fontSize: 10, color: C.muted, margin: '4px 0 5px' }}>Ledger</div>
                                    {L.entries.length === 0 ? (
                                      <div style={{ fontSize: 12, color: C.muted }}>Nothing booked against this line yet.</div>
                                    ) : (
                                      <div style={{ borderLeft: `2px solid ${C.line}`, paddingLeft: 11 }}>
                                        {L.entries.map(e => (
                                          <div key={e.id} style={{ fontSize: 11, lineHeight: 1.9,
                                                                   color: e.isReversal ? C.danger : C.head }}>
                                            {fmtDate(e.entryDate)} &nbsp;
                                            {e.qtyDelta > 0 ? '+' : ''}{qty(e.qtyDelta)} {it.unit || ''} @{money(e.rateUsed, cur)}
                                            &nbsp;<span style={{ color: C.muted }}>
                                              {e.isReversal ? `reverses entry ${e.reversesId}` : (e.note || '')}
                                              {e.recordedByName ? ` · ${e.recordedByName}` : ''}
                                            </span>
                                            {!e.isReversal && !e.isReversed && (
                                              <button onClick={() => reverse(e, it.id)} disabled={busy}
                                                      style={{ marginLeft: 8, fontSize: 10, padding: '1px 6px',
                                                               border: `1px solid ${C.line}`, background: '#fff',
                                                               borderRadius: 4, color: C.danger, cursor: 'pointer' }}>
                                                Reverse
                                              </button>
                                            )}
                                            {e.isReversed && (
                                              <span style={{ marginLeft: 8, fontSize: 10, color: C.muted }}>reversed</span>
                                            )}
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                    <div style={{ marginTop: 9 }}>
                                      <button onClick={() => recordProgress(it)} disabled={busy}
                                              style={{ fontSize: 11, padding: '4px 10px', borderRadius: 5,
                                                       border: `1px solid ${C.line}`, background: '#fff',
                                                       cursor: 'pointer' }}>
                                        Record progress
                                      </button>
                                    </div>
                                    <div style={{ fontSize: 10, color: C.muted, marginTop: 7, lineHeight: 1.6 }}>
                                      Entries cannot be edited. A correction is posted as a reversal at the
                                      rate the original was booked at, so both stay on record.
                                    </div>
                                  </>
                                )}
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ fontSize: 11, color: C.muted, marginTop: 14, lineHeight: 1.7 }}>
        A negative figure in Left means the line has overrun what was sanctioned for it.
        Proposed variations are not counted until approved.
        {config?.entryMode === 'bulk_sheet' && ' This organisation records progress as a measurement sheet across lines.'}
      </div>
    </div>
  );
}
