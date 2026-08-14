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

function Field({ label, value, onChange, placeholder, type = 'text', disabled }) {
  return (
    <label style={{ fontSize: 11, color: C.muted, display: 'block' }}>
      {label}
      <input type={type} value={value} disabled={disabled} placeholder={placeholder}
             onChange={e => onChange(e.target.value)}
             style={{ display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 3,
                      fontSize: 12, padding: '5px 7px', border: `1px solid ${C.line}`,
                      borderRadius: 5, background: disabled ? '#f3f4f6' : '#fff' }} />
    </label>
  );
}

function Metric({ label, value, tone }) {
  return (
    <div style={{ background: '#f9fafb', borderRadius: 8, padding: '11px 13px', flex: '1 1 120px', minWidth: 120 }}>
      <div style={{ fontSize: 11, color: C.muted }}>{label}</div>
      <div style={{ fontSize: 19, fontWeight: 600, marginTop: 3, color: tone || '#111827' }}>{value}</div>
    </div>
  );
}

const BLANK_LINE = {
  section: '', itemCode: '', description: '', unit: '',
  plannedQty: '', rate: '', vendorAccountId: '',
  procurementStatus: 'not_required', procurementRef: '',
};

// Common currencies first; the project's contract value may well not be INR
// even though INR is the schema default.
const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD'];

export default function ProjectBoQ({ handoverId }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [openRow, setOpenRow] = useState(null);
  const [ledger, setLedger] = useState({});      // itemId -> { loading, entries }
  const [vendors, setVendors] = useState([]);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  // null = closed, 'new' = adding, or an item id = editing that line.
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(BLANK_LINE);
  const [showSettings, setShowSettings] = useState(false);

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

  // ── Line editing ───────────────────────────────────────────────────────────
  const openNew = () => {
    // Prefill the section from the last line added: a bill is usually entered
    // section by section, and retyping "Civil" twenty times is where typos
    // creep in and split one section into two.
    const lastSection = (state.data?.items || []).slice(-1)[0]?.section || '';
    setForm({ ...BLANK_LINE, section: lastSection });
    setEditing('new');
  };

  const openEdit = (it) => {
    setForm({
      section:           it.section || '',
      itemCode:          it.itemCode || '',
      description:       it.description || '',
      unit:              it.unit || '',
      plannedQty:        String(it.plannedQty ?? ''),
      rate:              String(it.rate ?? ''),
      vendorAccountId:   it.vendorAccountId || '',
      procurementStatus: it.procurementStatus || 'not_required',
      procurementRef:    it.procurementRef || '',
    });
    setEditing(it.id);
  };

  const saveLine = async () => {
    const desc = (form.description || '').trim();
    if (!desc) { say('error', 'A description is required.'); return; }
    const q = form.plannedQty === '' ? 0 : Number(form.plannedQty);
    const r = form.rate === '' ? 0 : Number(form.rate);
    if (!Number.isFinite(q) || q < 0) { say('error', 'Quantity must be zero or more.'); return; }
    if (!Number.isFinite(r) || r < 0) { say('error', 'Rate must be zero or more.'); return; }

    const payload = {
      section:           form.section.trim() || null,
      itemCode:          form.itemCode.trim() || null,
      description:       desc,
      unit:              form.unit.trim() || null,
      vendorAccountId:   form.vendorAccountId ? parseInt(form.vendorAccountId, 10) : null,
      procurementStatus: form.procurementStatus,
      procurementRef:    form.procurementRef.trim() || null,
    };
    // Quantity and rate are omitted entirely when the bill is locked, rather
    // than sent and rejected — the server would 409 the whole save and the
    // other edits would be lost with it.
    // Read from state rather than the `bill`/`config` consts declared further
    // down: those sit after the early returns, so referencing them here would
    // be a temporal-dead-zone hazard if this ever ran before that point.
    const cfg = state.data?.config || {};
    if (!cfg.itemsLocked) { payload.plannedQty = q; payload.rate = r; }

    setBusy(true);
    try {
      const billId = state.data?.bill?.id;
      if (!billId) throw new Error('No bill loaded.');
      if (editing === 'new') await apiService.handovers.addBoqItem(billId, payload);
      else                   await apiService.handovers.updateBoqItem(editing, payload);
      setEditing(null); setForm(BLANK_LINE);
      await load();
      say('ok', editing === 'new' ? 'Line added.' : 'Line updated.');
    } catch (err) {
      say('error', err?.response?.data?.error?.message || 'Could not save the line');
    } finally { setBusy(false); }
  };

  const removeLine = async (it) => {
    if (!window.confirm(`Delete "${it.itemCode || it.description}"? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await apiService.handovers.removeBoqItem(it.id);
      await load();
      say('ok', 'Line deleted.');
    } catch (err) {
      // The server refuses to delete a line that has progress booked against
      // it — deleting recorded spend is what append-only exists to prevent.
      say('error', err?.response?.data?.error?.message || 'Could not delete the line');
    } finally { setBusy(false); }
  };

  const saveBillSettings = async (patch) => {
    setBusy(true);
    try {
      const billId = state.data?.bill?.id;
      if (!billId) throw new Error('No bill loaded.');
      await apiService.handovers.updateBoq(billId, patch);
      await load();
      say('ok', 'Bill updated.');
    } catch (err) {
      say('error', err?.response?.data?.error?.message || 'Could not update the bill');
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
        <div style={{ display: 'flex', gap: 7 }}>
          <button onClick={() => setShowSettings(v => !v)} disabled={busy}
                  style={{ fontSize: 12, padding: '5px 11px', borderRadius: 6,
                           border: `1px solid ${C.line}`, background: '#fff', cursor: 'pointer' }}>
            Bill settings
          </button>
          {!config?.itemsLocked && (
            <button onClick={openNew} disabled={busy || editing === 'new'}
                    style={{ fontSize: 12, padding: '5px 13px', borderRadius: 6, border: 'none',
                             background: C.accent, color: '#fff', cursor: 'pointer' }}>
              Add line
            </button>
          )}
        </div>
      </div>

      {showSettings && (
        <div style={{ background: '#f9fafb', border: `1px solid ${C.line}`, borderRadius: 8,
                      padding: '12px 14px', marginBottom: 14, display: 'flex',
                      gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ fontSize: 11, color: C.muted }}>
            Currency
            {/* The bill defaults to INR, but a project's contract value may be in
                another currency — every figure on this screen is formatted from
                this setting, so it must be changeable. */}
            <select value={bill.currency} disabled={busy}
                    onChange={e => saveBillSettings({ currency: e.target.value })}
                    style={{ display: 'block', marginTop: 3, fontSize: 12, padding: '4px 6px',
                             border: `1px solid ${C.line}`, borderRadius: 5 }}>
              {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label style={{ fontSize: 11, color: C.muted }}>
            Status
            <select value={bill.status} disabled={busy}
                    onChange={e => saveBillSettings({ status: e.target.value })}
                    style={{ display: 'block', marginTop: 3, fontSize: 12, padding: '4px 6px',
                             border: `1px solid ${C.line}`, borderRadius: 5 }}>
              <option value="draft">Draft — still being built</option>
              <option value="active">Active — work is measured against it</option>
              <option value="archived">Archived — superseded</option>
            </select>
          </label>
          <div style={{ fontSize: 11, color: C.muted, maxWidth: 340, lineHeight: 1.6 }}>
            Archiving keeps the bill and its ledger, and frees the project to hold a new one.
            Nothing is deleted.
          </div>
        </div>
      )}

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

      {editing && (
        <div style={{ background: '#f9fafb', border: `1px solid ${C.line}`, borderRadius: 8,
                      padding: '13px 15px', marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 10 }}>
            {editing === 'new' ? 'Add a line' : 'Edit line'}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: 10 }}>
            <Field label="Section" value={form.section}
                   onChange={v => setForm(f => ({ ...f, section: v }))} placeholder="Civil" />
            <Field label="Item code" value={form.itemCode}
                   onChange={v => setForm(f => ({ ...f, itemCode: v }))} placeholder="C-101" />
            <Field label="Unit" value={form.unit}
                   onChange={v => setForm(f => ({ ...f, unit: v }))} placeholder="m3" />
            <Field label={`Quantity${config?.itemsLocked ? ' (locked)' : ''}`} value={form.plannedQty}
                   onChange={v => setForm(f => ({ ...f, plannedQty: v }))}
                   type="number" disabled={config?.itemsLocked} placeholder="1000" />
            <Field label={`Rate${config?.itemsLocked ? ' (locked)' : ''}`} value={form.rate}
                   onChange={v => setForm(f => ({ ...f, rate: v }))}
                   type="number" disabled={config?.itemsLocked} placeholder="250" />
            <Field label="PO / RFQ ref" value={form.procurementRef}
                   onChange={v => setForm(f => ({ ...f, procurementRef: v }))} placeholder="PO-2291" />
          </div>

          <div style={{ marginTop: 10 }}>
            <Field label="Description" value={form.description}
                   onChange={v => setForm(f => ({ ...f, description: v }))}
                   placeholder="Excavation in ordinary soil" />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))',
                        gap: 10, marginTop: 10 }}>
            <label style={{ fontSize: 11, color: C.muted }}>
              Vendor
              <select value={form.vendorAccountId}
                      onChange={e => setForm(f => ({ ...f, vendorAccountId: e.target.value }))}
                      style={{ display: 'block', width: '100%', marginTop: 3, fontSize: 12,
                               padding: '5px 6px', border: `1px solid ${C.line}`, borderRadius: 5 }}>
                <option value="">—</option>
                {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
              {vendors.length === 0 && (
                <span style={{ fontSize: 10, color: C.muted }}>
                  No approved vendors yet — add one under Accounts first.
                </span>
              )}
            </label>
            <label style={{ fontSize: 11, color: C.muted }}>
              Procurement
              <select value={form.procurementStatus}
                      onChange={e => setForm(f => ({ ...f, procurementStatus: e.target.value }))}
                      style={{ display: 'block', width: '100%', marginTop: 3, fontSize: 12,
                               padding: '5px 6px', border: `1px solid ${C.line}`, borderRadius: 5 }}>
                {PROC_ORDER.map(k => <option key={k} value={k}>{PROC_LABEL[k]}</option>)}
              </select>
            </label>
          </div>

          <div style={{ fontSize: 11, color: C.muted, margin: '10px 0 0', lineHeight: 1.6 }}>
            Leave procurement as “Not required” for own-labour lines — otherwise they sit in the
            procurement counts forever.
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 11 }}>
            <button onClick={saveLine} disabled={busy || !form.description.trim()}
                    style={{ fontSize: 12, padding: '6px 14px', borderRadius: 6, border: 'none',
                             background: form.description.trim() ? C.accent : '#cbd5e1',
                             color: '#fff', cursor: form.description.trim() ? 'pointer' : 'not-allowed' }}>
              {busy ? 'Saving…' : (editing === 'new' ? 'Add line' : 'Save changes')}
            </button>
            <button onClick={() => { setEditing(null); setForm(BLANK_LINE); }} disabled={busy}
                    style={{ fontSize: 12, padding: '6px 14px', borderRadius: 6,
                             border: `1px solid ${C.line}`, background: '#fff', cursor: 'pointer' }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {items.length === 0 ? (
        <div style={{ fontSize: 13, color: C.muted, padding: '12px 0', lineHeight: 1.7 }}>
          The bill has no lines yet.
          {!config?.itemsLocked && !editing && (
            <div style={{ marginTop: 10 }}>
              <button onClick={openNew}
                      style={{ fontSize: 12, padding: '6px 14px', borderRadius: 6, border: 'none',
                               background: C.accent, color: '#fff', cursor: 'pointer' }}>
                Add the first line
              </button>
            </div>
          )}
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
                                    <div style={{ marginTop: 9, display: 'flex', gap: 7 }}>
                                      <button onClick={() => recordProgress(it)} disabled={busy}
                                              style={{ fontSize: 11, padding: '4px 10px', borderRadius: 5,
                                                       border: `1px solid ${C.line}`, background: '#fff',
                                                       cursor: 'pointer' }}>
                                        Record progress
                                      </button>
                                      <button onClick={() => openEdit(it)} disabled={busy}
                                              style={{ fontSize: 11, padding: '4px 10px', borderRadius: 5,
                                                       border: `1px solid ${C.line}`, background: '#fff',
                                                       cursor: 'pointer' }}>
                                        Edit line
                                      </button>
                                      {/* Only offered when nothing is booked. The server refuses
                                          otherwise, and showing a button that always fails is worse
                                          than not showing it. */}
                                      {it.entryCount === 0 && !config?.itemsLocked && (
                                        <button onClick={() => removeLine(it)} disabled={busy}
                                                style={{ fontSize: 11, padding: '4px 10px', borderRadius: 5,
                                                         border: `1px solid ${C.line}`, background: '#fff',
                                                         color: C.danger, cursor: 'pointer' }}>
                                          Delete line
                                        </button>
                                      )}
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
