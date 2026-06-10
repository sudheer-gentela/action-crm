/**
 * AIModelRouting.js — shared pieces for the org and user AI settings screens.
 *
 * Exports:
 *   EffectiveRoutingTable — renders the per-call-type effective resolution
 *     table from GET /org/admin/ai/effective or GET /me/ai/effective. This is
 *     the backend's own resolver output (provider, model, and which config
 *     layer won), so the UI can never disagree with what actually runs.
 *
 *   ModelSlotSelect — a cross-provider model picker that emits
 *     provider-qualified slot values ('anthropic/claude-sonnet-4-6').
 *     Accepts legacy unqualified stored values and displays them under the
 *     supplied legacyProvider. Free-form models (custom provider) that are
 *     not in any provider's list are injected as a literal option so the
 *     selection is never silently blank.
 *
 *   qualifySlot(slot, legacyProvider, providers) — canonical display form.
 */

import React, { useState, useEffect, useCallback } from 'react';

// ── Slot helpers (mirror backend parseModelSlot semantics) ──────────────────

export function qualifySlot(slot, legacyProvider, providers) {
  if (!slot || typeof slot !== 'string') return '';
  const i = slot.indexOf('/');
  if (i > 0) {
    const prefix = slot.slice(0, i);
    if ((providers || []).some(p => p.id === prefix)) return slot;   // already qualified
  }
  // Unqualified legacy value — interpret under the legacy provider.
  return legacyProvider ? `${legacyProvider}/${slot}` : slot;
}

const SOURCE_LABELS = {
  user_call_type: { label: 'Your task override', tone: 'warn' },
  org_call_type:  { label: 'Org task override',  tone: 'info' },
  user_default:   { label: 'Your default',       tone: 'warn' },
  org_default:    { label: 'Org default',        tone: 'ok'   },
  system_default: { label: 'System default',     tone: 'neutral' },
};

const PILL_PALETTE = {
  neutral: { bg: '#F1EFE8', fg: '#444441' },
  ok:      { bg: '#E1F5EE', fg: '#0F6E56' },
  warn:    { bg: '#FAEEDA', fg: '#854F0B' },
  info:    { bg: '#E6F1FB', fg: '#0C447C' },
};

function SourcePill({ source }) {
  const meta = SOURCE_LABELS[source] || { label: source, tone: 'neutral' };
  const c = PILL_PALETTE[meta.tone] || PILL_PALETTE.neutral;
  return (
    <span style={{
      fontSize: 11, padding: '2px 8px', borderRadius: 4, fontWeight: 500,
      background: c.bg, color: c.fg, whiteSpace: 'nowrap',
    }}>{meta.label}</span>
  );
}

// ── Effective routing table ──────────────────────────────────────────────────
//
// Props:
//   fetcher     — the host file's apiFetch (path, opts) => Promise<json>
//   endpoint    — '/me/ai/effective' or '/org/admin/ai/effective'
//   callTypes   — [{id, label, group}] from the providers payload, for labels
//   refreshKey  — bump after a save to re-resolve
export function EffectiveRoutingTable({ fetcher, endpoint, callTypes = [], refreshKey = 0 }) {
  const [rows,    setRows]    = useState(null);
  const [error,   setError]   = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const r = await fetcher(endpoint);
      setRows(r.effective || []);
    } catch (e) {
      setError(e.message || 'Failed to resolve');
    } finally {
      setLoading(false);
    }
  }, [fetcher, endpoint]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const labelFor = (id) => callTypes.find(ct => ct.id === id)?.label || id;

  if (loading) return <div style={{ padding: '14px 18px', fontSize: 13, color: '#6b7280' }}>Resolving…</div>;
  if (error)   return <div style={{ padding: '14px 18px', fontSize: 13, color: '#A32D2D' }}>⚠️ {error}</div>;
  if (!rows || rows.length === 0) return null;

  return (
    <div>
      {rows.map((r, idx) => (
        <div key={r.call_type} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 18px', gap: 12,
          borderBottom: idx === rows.length - 1 ? 'none' : '1px solid #f1f1ec',
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{labelFor(r.call_type)}</div>
            <div style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace' }}>{r.call_type}</div>
          </div>
          <div style={{ fontSize: 13, fontFamily: 'monospace', color: '#374151', whiteSpace: 'nowrap' }}>
            {r.provider}/{r.model}
          </div>
          <SourcePill source={r.source} />
        </div>
      ))}
    </div>
  );
}

// ── Cross-provider model slot select ─────────────────────────────────────────
//
// Props:
//   providers      — [{id, label, models:[{id,label,tier,source?}], allowFreeFormModel}]
//   value          — stored slot ('' | 'model-id' | 'provider/model-id')
//   legacyProvider — provider that unqualified stored values belong to
//   onChange       — (qualifiedSlotOrEmptyString) => void
//   emptyLabel     — label for the '' option (e.g. 'Use default (…)')
//   style          — select style override
export function ModelSlotSelect({ providers, value, legacyProvider, onChange, emptyLabel, style }) {
  const qualified = qualifySlot(value, legacyProvider, providers);

  // Does the qualified value exist among generated options? If not (e.g. a
  // free-form custom model or a model no longer listed), inject it literally.
  const listed = (providers || []).some(p =>
    (p.models || []).some(m => `${p.id}/${m.id}` === qualified)
  );

  return (
    <select
      value={qualified || ''}
      onChange={(e) => onChange(e.target.value)}
      style={style}
    >
      <option value="">{emptyLabel || '—'}</option>
      {qualified && !listed && (
        <option value={qualified}>{qualified} (unlisted)</option>
      )}
      {(providers || []).filter(p => (p.models || []).length > 0).map(p => (
        <optgroup key={p.id} label={p.label}>
          {p.models.map(m => (
            <option key={`${p.id}/${m.id}`} value={`${p.id}/${m.id}`}>
              {m.label || m.id}{m.tier ? ` — ${m.tier}` : ''}{m.source === 'discovered' ? '  • NEW' : ''}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
