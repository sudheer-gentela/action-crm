// prospecting/SignalWorkPanel.js
//
// P9 addition: the "🔍 Enrich company" tap in the WHAT WE KNOW header —
// POST /prospect-work/:id/enrich (BYOK provider chain via the existing
// enrichment orchestrator; one credit → account fields fill-if-empty + the
// v1 enrich signal set → fresh context). Soft failures surface as notices
// (no key configured / cap reached / not found), never blocking errors.
// Rep-edited signal values are never overwritten (rep_override).
//
// Signal-Based Campaigns — Phase 7: the Work panel, the rep experience of the
// prioritized queue (design §7). Rendered as the "Work" tab in
// ProspectDetailPanel (only when the prospect is in a campaign).
//
// Everything on this panel is driven by GET /api/prospect-work/:prospectId —
// the LIVE work context (the verdict is re-computed when the contact opens and
// after every validation, so the hook/priority can flip in front of the rep).
//
// Sections, top to bottom:
//   1. Verdict header    — priority · why-now hook · active trigger · campaign
//   2. Validate on page  — the campaign's unknown filters as tap-to-confirm
//                          controls (writes source='rep' signals; the engine
//                          decides what they mean — confirming a failing value
//                          drops the prospect honestly)
//   3. What we know      — every current signal w/ source · recency ·
//                          confidence, with rep correction (edit / mark unknown)
//   4. Research          — saved research notes (full research lives on Intel)
//   5. Draft             — the layered signal-aware draft (angle ← trigger
//                          hook, specifics ← validations+research, voice ← skill)
//   6. Contact           — Not in role (suppress + find-replacement) ·
//                          Add better contact (capture + switch)
//   7. Outcome           — completion = the recorded outcome: Sent / Queued /
//                          Skip / Defer-with-reason, on the EXISTING
//                          prospecting-actions endpoints.
//
// Props:
//   prospectId    {number}
//   onUseDraft    {fn}  ({ messageSubject, messageBody }) => void  — opens the
//                        OutreachComposer pre-filled (same bridge as
//                        OutreachSkillPanel).
//   onOpenProspect{fn}  (prospectId) => void — switch the drawer to a new
//                        prospect (used after replace-contact).
//   onUpdate      {fn}  () => void — parent refresh (actions list, board).

import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch, timeAgo, TEAL } from './prospectingShared';

const PRIORITY_STYLES = {
  high:   { bg: '#fff7ed', border: '#fdba74', color: '#c2410c', label: 'HIGH'   },
  medium: { bg: '#fefce8', border: '#fde047', color: '#a16207', label: 'MEDIUM' },
  low:    { bg: '#f9fafb', border: '#e5e7eb', color: '#6b7280', label: 'LOW'    },
};

const SOURCE_LABELS = {
  rep: '👤 you', list: '📄 list', enrichment: '🧠 enrichment',
  extension: '🧩 extension', webhook: '🔔 webhook', dataset: '🗂 dataset', system: '⚙️ system',
};

const btn = (primary, danger) => ({
  fontSize: 11, fontWeight: 600, padding: '5px 10px', borderRadius: 6, cursor: 'pointer',
  border: primary ? 'none' : `1px solid ${danger ? '#fca5a5' : '#d1d5db'}`,
  background: primary ? TEAL : '#fff',
  color: primary ? '#fff' : (danger ? '#b91c1c' : '#374151'),
});

const sectionTitle = { fontSize: 12, fontWeight: 700, color: '#374151', letterSpacing: 0.3, marginBottom: 8 };
const card = { border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 12px', marginBottom: 8, background: '#fff' };

function fmtValue(v) {
  if (v === true) return 'Yes';
  if (v === false) return 'No';
  if (v == null) return '—';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ─────────────────────────────────────────────────────────────────────────────
// Validate control — one confirmation row. The input adapts to the criterion's
// predicate so a tap writes a REAL typed value, never a vague "confirmed" flag.
// ─────────────────────────────────────────────────────────────────────────────
function ConfirmationRow({ conf, busy, onValidate }) {
  const [numVal, setNumVal]   = useState('');
  const [textVal, setTextVal] = useState('');
  const [dateVal, setDateVal] = useState('');

  const op = conf.predicate?.operator;
  const send = (value) => onValidate(conf.signalKey, value, conf.entityType);

  let control = null;
  if (op === 'is_true' || op === 'is_false' || conf.predicateType === 'boolean' || op === 'exists') {
    control = (
      <div style={{ display: 'flex', gap: 6 }}>
        <button style={btn(true)} disabled={busy} onClick={() => send(true)}>✓ Yes</button>
        <button style={btn(false)} disabled={busy} onClick={() => send(false)}>✗ No</button>
      </div>
    );
  } else if (op === 'one_of' && Array.isArray(conf.predicate?.value)) {
    control = (
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {conf.predicate.value.map((opt) => (
          <button key={opt} style={btn(true)} disabled={busy} onClick={() => send(opt)}>{opt}</button>
        ))}
        <input
          placeholder="Other…"
          value={textVal}
          onChange={(e) => setTextVal(e.target.value)}
          style={{ fontSize: 11, padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 6, width: 110 }}
        />
        <button style={btn(false)} disabled={busy || !textVal.trim()} onClick={() => send(textVal.trim())}>Save</button>
      </div>
    );
  } else if (op === 'gte' || op === 'lte' || conf.predicateType === 'number') {
    control = (
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          type="number" value={numVal} onChange={(e) => setNumVal(e.target.value)}
          placeholder="Value seen on the page"
          style={{ fontSize: 11, padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 6, width: 150 }}
        />
        <button style={btn(true)} disabled={busy || numVal === '' || !Number.isFinite(Number(numVal))}
          onClick={() => send(Number(numVal))}>Confirm</button>
      </div>
    );
  } else if (op === 'within_days' || conf.predicateType === 'recency') {
    control = (
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <button style={btn(true)} disabled={busy} onClick={() => send(new Date().toISOString())}>✓ Saw it today</button>
        <input
          type="date" value={dateVal} onChange={(e) => setDateVal(e.target.value)}
          style={{ fontSize: 11, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6 }}
        />
        <button style={btn(false)} disabled={busy || !dateVal} onClick={() => send(new Date(dateVal).toISOString())}>Confirm date</button>
      </div>
    );
  } else {
    control = (
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          value={textVal} onChange={(e) => setTextVal(e.target.value)}
          placeholder="What did you see?"
          style={{ fontSize: 11, padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 6, width: 170 }}
        />
        <button style={btn(true)} disabled={busy || !textVal.trim()} onClick={() => send(textVal.trim())}>Confirm</button>
      </div>
    );
  }

  return (
    <div style={{ ...card, background: '#fffbeb', borderColor: '#fde68a' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#92400e' }}>❓ {conf.label}</div>
        <span style={{ fontSize: 10, color: '#a16207' }}>
          {conf.reason === 'stale'
            ? `last seen ${fmtValue(conf.staleValue)}${conf.lastObservedAt ? ' · ' + timeAgo(conf.lastObservedAt) : ''} — re-confirm`
            : 'never observed — confirm on the page'}
        </span>
      </div>
      <div style={{ marginTop: 7 }}>{control}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal row — what we know, with rep correction.
// ─────────────────────────────────────────────────────────────────────────────
function SignalRow({ sig, busy, onValidate, onClear }) {
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState('');

  const stale = sig.state === 'unknown';
  const saveEdit = () => {
    let v = editVal.trim();
    if (sig.predicateType === 'boolean') v = /^(true|yes|1)$/i.test(v);
    else if (sig.predicateType === 'number' && Number.isFinite(Number(v))) v = Number(v);
    onValidate(sig.key, v, sig.entityType);
    setEditing(false);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #f3f4f6', flexWrap: 'wrap' }}>
      <div style={{ flex: 1, minWidth: 160 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: stale ? '#9ca3af' : '#374151' }}>
          {sig.label}
          <span style={{ fontSize: 10, fontWeight: 400, color: '#9ca3af', marginLeft: 6 }}>
            ({sig.entityType === 'account' ? 'company' : 'contact'})
          </span>
        </div>
        <div style={{ fontSize: 12, color: stale ? '#9ca3af' : '#111827' }}>
          {stale
            ? <>unknown <span style={{ fontSize: 10 }}>· last seen {fmtValue(sig.staleValue)}</span></>
            : fmtValue(sig.value)}
        </div>
      </div>
      <div style={{ fontSize: 10, color: '#9ca3af', textAlign: 'right' }}>
        {SOURCE_LABELS[sig.source] || sig.source} · {timeAgo(sig.observedAt)} · {sig.confidence}
        {sig.repWritten && <span style={{ color: TEAL, fontWeight: 700 }}> ✓</span>}
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        {editing ? (
          <>
            <input
              value={editVal} onChange={(e) => setEditVal(e.target.value)} autoFocus
              placeholder={sig.predicateType === 'boolean' ? 'yes / no' : 'value'}
              style={{ fontSize: 11, padding: '3px 6px', border: '1px solid #d1d5db', borderRadius: 5, width: 100 }}
            />
            <button style={btn(true)} disabled={busy || !editVal.trim()} onClick={saveEdit}>Save</button>
            <button style={btn(false)} onClick={() => setEditing(false)}>✕</button>
          </>
        ) : (
          <>
            <button style={btn(false)} disabled={busy} title="Correct this value (writes a rep signal — vendors can't overwrite it)"
              onClick={() => { setEditing(true); setEditVal(''); }}>✎</button>
            <button style={btn(false, true)} disabled={busy} title="That's wrong, and unknown is the truth"
              onClick={() => onClear(sig.key, sig.entityType)}>⌫</button>
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The panel
// ─────────────────────────────────────────────────────────────────────────────
export default function SignalWorkPanel({ prospectId, onUseDraft, onOpenProspect, onUpdate }) {
  const [ctx, setCtx]         = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy]       = useState(false);
  const [enriching, setEnriching] = useState(false); // P9 enrich tap
  const [error, setError]     = useState(null);
  const [notice, setNotice]   = useState(null);

  // Draft state
  const [draftChannel, setDraftChannel] = useState('email');
  const [drafting, setDrafting]         = useState(false);
  const [draft, setDraft]               = useState(null); // skill result

  // Replace-contact mini form
  const [showReplace, setShowReplace] = useState(false);
  const [replaceForm, setReplaceForm] = useState({ firstName: '', lastName: '', title: '', email: '', linkedinUrl: '' });

  // Outcome controls
  const [skipReason, setSkipReason]     = useState('');
  const [showSkip, setShowSkip]         = useState(false);
  const [showDefer, setShowDefer]       = useState(false);
  const [deferDuration, setDeferDuration] = useState('1_week');
  const [deferReason, setDeferReason]   = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const c = await apiFetch(`/prospect-work/${prospectId}`);
      setCtx(c);
    } catch (err) {
      setError(err.message || 'Failed to load work context');
    } finally {
      setLoading(false);
    }
  }, [prospectId]);

  useEffect(() => { load(); }, [load]);

  // Validate / clear both return a FRESH context — the priority/hook can flip
  // right here, which is the whole point (§7).
  const doValidate = async (key, value, entityType) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const prevPriority = ctx?.verdict?.priority;
      const fresh = await apiFetch(`/prospect-work/${prospectId}/validate`, {
        method: 'POST', body: JSON.stringify({ key, value, entityType }),
      });
      setCtx(fresh);
      if (fresh.verdict && !fresh.verdict.qualifies) {
        setNotice('That confirmation disqualifies this contact for the campaign — the action was resolved. Honest beats silent.');
      } else if (fresh.verdict && prevPriority && fresh.verdict.priority !== prevPriority) {
        setNotice(`Priority moved ${prevPriority} → ${fresh.verdict.priority}.`);
      }
      if (onUpdate) onUpdate();
    } catch (err) {
      setError(err.message || 'Validation failed');
    } finally { setBusy(false); }
  };

  const doClear = async (key, entityType) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const fresh = await apiFetch(`/prospect-work/${prospectId}/clear-signal`, {
        method: 'POST', body: JSON.stringify({ key, entityType }),
      });
      setCtx(fresh);
      if (onUpdate) onUpdate();
    } catch (err) {
      setError(err.message || 'Clear failed');
    } finally { setBusy(false); }
  };

  // P9 — one BYOK enrichment tap: fields applied + enrich signals written →
  // fresh context. Soft failures (no key / cap / not found / no account)
  // arrive as ctx.enrichment.ok === false — a notice, never an error state.
  const ENRICH_FAIL_NOTICES = {
    no_api_key:              'No enrichment key configured — an org admin can add an Apollo or CoreSignal key in Settings → Prospecting → Enrichment.',
    no_providers_configured: 'No enrichment provider configured — an org admin can add a key in Settings → Prospecting → Enrichment.',
    monthly_cap_reached:     'Monthly enrichment cap reached — the tap was not charged. An org admin can raise the cap in Settings.',
    not_found:               'The provider had no record for this company — nothing was written.',
    ambiguous:               'The provider returned multiple possible companies — nothing was written. Setting the account\'s domain usually disambiguates.',
    prospect_has_no_account: 'This prospect has no account yet, so there\'s no company to enrich.',
  };
  const doEnrich = async () => {
    setEnriching(true); setError(null); setNotice(null);
    try {
      const prevPriority = ctx?.verdict?.priority;
      const fresh = await apiFetch(`/prospect-work/${prospectId}/enrich`, {
        method: 'POST', body: JSON.stringify({}),
      });
      setCtx(fresh);
      const e = fresh.enrichment || {};
      if (!e.ok) {
        setNotice(ENRICH_FAIL_NOTICES[e.reason] || `Enrichment didn't complete (${e.reason || 'unknown reason'}).`);
      } else {
        const n = (e.signals && e.signals.written) ? e.signals.written.length : 0;
        const kept = (e.signals && e.signals.skipped) ? e.signals.skipped.filter(s => s.reason === 'rep_override').length : 0;
        let msg = n > 0
          ? `Enriched via ${e.provider} — ${n} signal${n === 1 ? '' : 's'} updated.`
          : `Enriched via ${e.provider} — nothing new to write.`;
        if (kept > 0) msg += ` ${kept} kept your edit${kept === 1 ? '' : 's'} (rep data always wins).`;
        if (fresh.verdict && prevPriority && fresh.verdict.priority !== prevPriority) {
          msg += ` Priority moved ${prevPriority} → ${fresh.verdict.priority}.`;
        }
        setNotice(msg);
      }
      if (onUpdate) onUpdate();
    } catch (err) {
      setError(err.message || 'Enrichment failed');
    } finally { setEnriching(false); }
  };

  const doNotInRole = async () => {
    if (!window.confirm('Mark this contact as no longer in role? Their queue action is suppressed and a find-replacement task is created.')) return;
    setBusy(true); setError(null);
    try {
      await apiFetch(`/prospect-work/${prospectId}/not-in-role`, { method: 'POST', body: JSON.stringify({}) });
      await load();
      if (onUpdate) onUpdate();
    } catch (err) { setError(err.message || 'Failed'); }
    finally { setBusy(false); }
  };

  const doClearNotInRole = async () => {
    setBusy(true); setError(null);
    try {
      await apiFetch(`/prospect-work/${prospectId}/clear-not-in-role`, { method: 'POST', body: JSON.stringify({}) });
      await load();
      if (onUpdate) onUpdate();
    } catch (err) { setError(err.message || 'Failed'); }
    finally { setBusy(false); }
  };

  const doReplace = async () => {
    setBusy(true); setError(null);
    try {
      const r = await apiFetch(`/prospect-work/${prospectId}/replace-contact`, {
        method: 'POST', body: JSON.stringify(replaceForm),
      });
      setShowReplace(false);
      setNotice(`Added ${r.prospect.first_name} ${r.prospect.last_name} and switched the campaign seat to them.`);
      if (onUpdate) onUpdate();
      if (onOpenProspect && r.prospect?.id) onOpenProspect(r.prospect.id);
    } catch (err) { setError(err.message || 'Replace failed'); }
    finally { setBusy(false); }
  };

  const doDraft = async () => {
    setDrafting(true); setError(null); setDraft(null);
    try {
      const r = await apiFetch(`/prospect-work/${prospectId}/draft`, {
        method: 'POST', body: JSON.stringify({ channel: draftChannel }),
      });
      if (r.status === 'skipped') {
        setError('Fit gate recommends skipping this prospect: ' + (r.reasons || []).join('; '));
      } else if (r.ok && r.status === 'ok') {
        setDraft(r);
      } else {
        setError('Draft failed' + (r.error ? ': ' + r.error : ''));
      }
    } catch (err) { setError(err.message || 'Draft failed'); }
    finally { setDrafting(false); }
  };

  // Completion = the recorded outcome (§7) — existing queue endpoints.
  const recordOutcome = async (kind) => {
    if (!ctx?.action) return;
    setBusy(true); setError(null);
    try {
      if (kind === 'defer') {
        await apiFetch(`/prospecting-actions/${ctx.action.id}/snooze`, {
          method: 'PATCH', body: JSON.stringify({ duration: deferDuration, reason: deferReason || null }),
        });
        setShowDefer(false);
      } else if (kind === 'skip') {
        await apiFetch(`/prospecting-actions/${ctx.action.id}/status`, {
          method: 'PATCH', body: JSON.stringify({ status: 'skipped', outcome: skipReason || 'skipped' }),
        });
        setShowSkip(false);
      } else {
        // 'sent' | 'queued'
        await apiFetch(`/prospecting-actions/${ctx.action.id}/status`, {
          method: 'PATCH', body: JSON.stringify({ status: 'completed', outcome: kind }),
        });
      }
      await load();
      if (onUpdate) onUpdate();
    } catch (err) { setError(err.message || 'Failed to record outcome'); }
    finally { setBusy(false); }
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  if (loading) return <div style={{ padding: 20, fontSize: 13, color: '#6b7280' }}>Assembling live context…</div>;
  if (!ctx) return <div style={{ padding: 20, fontSize: 13, color: '#b91c1c' }}>⚠️ {error || 'Could not load work context.'}</div>;

  const v = ctx.verdict;
  const pr = PRIORITY_STYLES[v?.priority] || PRIORITY_STYLES.low;
  const email = draft?.output?.email || null;
  const liBody = draft?.output?.linkedin?.body || null;
  const actionOpen = ctx.action && ctx.action.status === 'pending';

  return (
    <div>
      {error &&  <div style={{ padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, fontSize: 12, color: '#b91c1c', marginBottom: 10 }}>⚠️ {error}</div>}
      {notice && <div style={{ padding: '8px 12px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, fontSize: 12, color: '#1d4ed8', marginBottom: 10 }}>ℹ️ {notice}</div>}

      {/* ── 0. No-campaign / not-in-role / disqualified banners ─────────────── */}
      {!ctx.campaign && (
        <div style={{ ...card, background: '#f9fafb' }}>
          <div style={{ fontSize: 12, color: '#6b7280' }}>
            This prospect isn't in a campaign, so there's no signal targeting to work.
            The signal list below still shows (and lets you correct) what's known.
          </div>
        </div>
      )}
      {ctx.notInRole && (
        <div style={{ ...card, background: '#fef2f2', borderColor: '#fecaca' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 12, color: '#b91c1c', fontWeight: 600 }}>
              🚫 Marked not-in-role — queue action suppressed, a find-replacement task is on your queue.
            </div>
            <button style={btn(false)} disabled={busy} onClick={doClearNotInRole}>Undo</button>
          </div>
        </div>
      )}
      {v && !v.qualifies && !ctx.notInRole && (
        <div style={{ ...card, background: '#fef2f2', borderColor: '#fecaca' }}>
          <div style={{ fontSize: 12, color: '#b91c1c', fontWeight: 600 }}>
            ✗ Disqualified for this campaign — a fresh signal fails a qualifier. Correct it below if the page says otherwise.
          </div>
        </div>
      )}

      {/* ── 1. Verdict header ────────────────────────────────────────────────── */}
      {v && v.qualifies && !ctx.notInRole && (
        <div style={{ ...card, background: pr.bg, borderColor: pr.border }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: pr.color, border: `1px solid ${pr.border}`, borderRadius: 10, padding: '2px 9px', background: '#fff' }}>
              {pr.label}
            </span>
            {v.activeTrigger && (
              <span style={{ fontSize: 11, fontWeight: 600, color: '#374151' }}>⚡ {v.activeTrigger.label}</span>
            )}
            {ctx.campaign && (
              <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 'auto' }}>🚀 {ctx.campaign.name}</span>
            )}
          </div>
          {v.whyNow && (
            <div style={{ fontSize: 13, color: '#1f2937', marginTop: 6, fontStyle: 'italic' }}>
              💡 Why now: {v.whyNow}
            </div>
          )}
        </div>
      )}

      {/* ── 2. Validate on the page ──────────────────────────────────────────── */}
      {ctx.confirmations.length > 0 && !ctx.notInRole && (
        <div style={{ marginTop: 14 }}>
          <div style={sectionTitle}>✅ VALIDATE ON THE PAGE ({ctx.confirmations.length})</div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 8 }}>
            Unknowns never drop a contact — they become your checks. Confirming writes a rep signal
            (high confidence, vendors can't overwrite it) and can flip the hook and priority live.
          </div>
          {ctx.confirmations.map((conf) => (
            <ConfirmationRow key={conf.signalKey} conf={conf} busy={busy} onValidate={doValidate} />
          ))}
        </div>
      )}

      {/* ── 3. What we know ──────────────────────────────────────────────────── */}
      <div style={{ marginTop: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={sectionTitle}>📡 WHAT WE KNOW ({ctx.signals.length})</div>
          {/* P9: one BYOK enrichment tap — company signals only; person
              enrichment (email/phone reveal) stays on its own Intel-tab
              control. Rep-edited values are never overwritten. */}
          <button
            style={{ ...btn(false), fontSize: 11 }}
            disabled={busy || enriching}
            onClick={doEnrich}
            title="Fetch company facts from your enrichment provider (Apollo/CoreSignal). Uses one credit. Your edits are never overwritten."
          >
            {enriching ? '⏳ Enriching…' : '🔍 Enrich company'}
          </button>
        </div>
        {ctx.signals.length === 0 ? (
          <div style={{ fontSize: 12, color: '#9ca3af' }}>No signals captured yet for this contact or their company.</div>
        ) : (
          <div style={card}>
            {ctx.signals.map((s) => (
              <SignalRow key={`${s.entityType}:${s.key}`} sig={s} busy={busy} onValidate={doValidate} onClear={doClear} />
            ))}
          </div>
        )}
      </div>

      {/* ── 4. Research ──────────────────────────────────────────────────────── */}
      {ctx.research && (
        <div style={{ marginTop: 14 }}>
          <div style={sectionTitle}>📝 SAVED RESEARCH</div>
          <div style={{ ...card, background: '#f8fafc', maxHeight: 180, overflowY: 'auto' }}>
            <div style={{ fontSize: 12, color: '#374151', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
              {ctx.research.notes}
            </div>
          </div>
          <div style={{ fontSize: 10, color: '#9ca3af' }}>Re-run research from the Intel tab.</div>
        </div>
      )}

      {/* ── 5. Draft ─────────────────────────────────────────────────────────── */}
      {ctx.campaign && !ctx.notInRole && (!v || v.qualifies) && (
        <div style={{ marginTop: 14 }}>
          <div style={sectionTitle}>✨ SIGNAL-AWARE DRAFT</div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 8 }}>
            Layered: angle ← the active trigger's hook{v?.whyNow ? '' : ' (campaign angle for now)'} ·
            specifics ← research + your validations · voice ← the outreach skill.
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <select value={draftChannel} onChange={(e) => setDraftChannel(e.target.value)} disabled={drafting}
              style={{ fontSize: 12, padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6 }}>
              <option value="email">✉️ Email (first touch)</option>
              <option value="linkedin">🔗 LinkedIn (connection request)</option>
            </select>
            <button style={btn(true)} disabled={drafting} onClick={doDraft}>
              {drafting ? '⏳ Generating…' : '▶ Generate draft'}
            </button>
          </div>
          {draft && (
            <div style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, flexWrap: 'wrap', gap: 6 }}>
                <span style={{ fontSize: 11, background: '#E1F5EE', color: '#0F6E56', padding: '3px 9px', borderRadius: 12 }}>
                  ⚓ {draft.signalContext?.why_now || draft.output?.hook?.category || 'draft'}
                </span>
                {email && (
                  <button style={btn(true)} onClick={() => onUseDraft && onUseDraft({ messageSubject: email.subject || '', messageBody: email.body || '' })}>
                    → Use this draft
                  </button>
                )}
                {liBody && (
                  <button style={btn(false)} onClick={() => navigator.clipboard?.writeText(liBody)}>⧉ Copy note</button>
                )}
              </div>
              {email && (
                <div style={{ fontSize: 12, marginBottom: 5 }}>
                  <span style={{ color: '#9ca3af' }}>Subject:</span> {email.subject || '—'}
                </div>
              )}
              <div style={{ fontSize: 12, color: '#374151', lineHeight: 1.6, whiteSpace: 'pre-wrap', borderTop: '1px dashed #e5e7eb', paddingTop: 6 }}>
                {email ? email.body : liBody}
              </div>
              {draft.validation && draft.validation.route !== 'send' && (
                <div style={{ marginTop: 6, fontSize: 11, color: '#a16207' }}>
                  ⚠ Review lane: {(draft.validation.warnings || []).join('; ') || 'manual review recommended'}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── 6. Contact ───────────────────────────────────────────────────────── */}
      {ctx.campaign && (
        <div style={{ marginTop: 14 }}>
          <div style={sectionTitle}>👥 CONTACT</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {!ctx.notInRole && (
              <button style={btn(false, true)} disabled={busy} onClick={doNotInRole}>🚫 Not in role</button>
            )}
            <button style={btn(false)} disabled={busy} onClick={() => setShowReplace(!showReplace)}>
              ＋ Add better contact seen on the page
            </button>
          </div>
          {showReplace && (
            <div style={{ ...card, marginTop: 8 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 6 }}>
                {[['firstName', 'First name *'], ['lastName', 'Last name *'], ['title', 'Title'], ['email', 'Email'], ['linkedinUrl', 'LinkedIn URL']].map(([k, ph]) => (
                  <input key={k} placeholder={ph} value={replaceForm[k]}
                    onChange={(e) => setReplaceForm({ ...replaceForm, [k]: e.target.value })}
                    style={{ fontSize: 12, padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6, gridColumn: k === 'linkedinUrl' ? '1 / -1' : 'auto' }}
                  />
                ))}
              </div>
              <div style={{ fontSize: 11, color: '#9ca3af', margin: '6px 0' }}>
                Creates them at the same company + campaign, marks this contact not-in-role, and switches the seat.
              </div>
              <button style={btn(true)} disabled={busy || !replaceForm.firstName.trim() || !replaceForm.lastName.trim()} onClick={doReplace}>
                {busy ? '⏳…' : 'Capture & switch'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── 7. Outcome ───────────────────────────────────────────────────────── */}
      {ctx.action && (
        <div style={{ marginTop: 14, marginBottom: 8 }}>
          <div style={sectionTitle}>🏁 OUTCOME</div>
          {!actionOpen ? (
            <div style={{ fontSize: 12, color: '#6b7280' }}>
              {ctx.action.status === 'snoozed'
                ? <>💤 Deferred until {ctx.action.snoozed_until ? new Date(ctx.action.snoozed_until).toLocaleDateString() : 'later'}{ctx.action.snooze_reason ? ` — ${ctx.action.snooze_reason}` : ''}</>
                : <>Recorded: <b>{ctx.action.outcome || ctx.action.status}</b>{ctx.action.auto_completed ? ' (auto-resolved)' : ''}</>}
            </div>
          ) : (
            <>
              <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 8 }}>
                The draft isn't the finish line — the recorded outcome is.
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button style={btn(true)} disabled={busy} onClick={() => recordOutcome('sent')}>✉️ Sent</button>
                <button style={btn(true)} disabled={busy} onClick={() => recordOutcome('queued')}>⏱ Queued in sequence</button>
                <button style={btn(false)} disabled={busy} onClick={() => { setShowSkip(!showSkip); setShowDefer(false); }}>⤼ Skip</button>
                <button style={btn(false)} disabled={busy} onClick={() => { setShowDefer(!showDefer); setShowSkip(false); }}>💤 Defer</button>
              </div>
              {showSkip && (
                <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
                  <input placeholder="Why skip? (recorded as the outcome)" value={skipReason} onChange={(e) => setSkipReason(e.target.value)}
                    style={{ fontSize: 12, padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6, flex: 1 }} />
                  <button style={btn(false, true)} disabled={busy} onClick={() => recordOutcome('skip')}>Record skip</button>
                </div>
              )}
              {showDefer && (
                <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <select value={deferDuration} onChange={(e) => setDeferDuration(e.target.value)}
                    style={{ fontSize: 12, padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6 }}>
                    <option value="1_week">1 week</option>
                    <option value="2_weeks">2 weeks</option>
                    <option value="1_month">1 month</option>
                    <option value="indefinite">Indefinitely</option>
                  </select>
                  <input placeholder="Reason" value={deferReason} onChange={(e) => setDeferReason(e.target.value)}
                    style={{ fontSize: 12, padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6, flex: 1, minWidth: 140 }} />
                  <button style={btn(false)} disabled={busy} onClick={() => recordOutcome('defer')}>Defer</button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
