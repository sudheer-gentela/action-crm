// prospecting/CampaignConfigScreen.js
//
// Dedicated full-screen campaign configuration page (deep link:
// #/prospecting/campaigns/<id>/config). One home for BOTH campaign-level
// override systems:
//
//   1. Outreach config (pitch, value props, personas, products, hooks,
//      case studies, guardrails) — edited by the existing
//      CampaignConfigPanel, which already shows org defaults inline and
//      owns its own save/delete via GET/PUT/DELETE /:id/config.
//
//   2. Sending schedule — NEW per-field inherit/override editor backed by
//      GET /:id/schedule-config (provenance) and the existing campaign
//      PUT (writes). Empty / "inherit" sends an explicit null so the
//      column clears and the resolver falls back to org → default.
//
// Entry points: "Open configuration →" in the campaign drawer, and the
// gear icon on each campaign list row.

import React, { useState, useEffect } from 'react';
import { apiFetch } from './prospectingShared';
import CampaignConfigPanel from './CampaignConfigPanel';

const EMBER = '#E8630A';
const TEAL  = '#0F9D8E';

// Field definitions for the schedule section. Kept in firing order so the
// page reads the way the resolver thinks: start → pacing → window → cap.
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const SCHEDULE_FIELDS = [
  {
    key: 'start_mode', label: 'Start mode', type: 'select',
    options: [
      { value: 'fixed_or_now', label: 'Fixed start, or now if passed (fixed_or_now)' },
      { value: 'on_activate',  label: 'Start immediately on activation (on_activate)' },
      { value: 'fixed',        label: 'Fixed start only — wait for tomorrow if passed (fixed)' },
    ],
    hint: 'When the first slots of each day begin.',
  },
  {
    key: 'pacing_mode', label: 'Pacing mode', type: 'select',
    options: [
      { value: 'cadence', label: 'Cadence — one send every N minutes' },
      { value: 'spread',  label: 'Spread — even across the send window' },
    ],
    hint: 'How sends are distributed within a day.',
  },
  {
    key: 'cadence_minutes', label: 'Cadence (minutes)', type: 'number',
    min: 1, max: 240,
    hint: 'Gap between sends when pacing mode is cadence.',
  },
  {
    key: 'send_window_start_hour', label: 'Send window start (hour)', type: 'number',
    min: 0, max: 23, hint: '0–23, campaign timezone.',
  },
  {
    key: 'send_window_start_minute', label: 'Send window start (minute)', type: 'number',
    min: 0, max: 59,
  },
  {
    key: 'send_window_end_hour', label: 'Send window end (hour)', type: 'number',
    min: 1, max: 24, hint: 'Also the cadence safety ceiling — nothing fires after this.',
  },
  {
    key: 'send_window_days', label: 'Send days', type: 'days',
    hint: 'Which weekdays sends may fire.',
  },
  {
    key: 'send_window_timezone', label: 'Timezone', type: 'text',
    placeholder: 'e.g. America/New_York, Asia/Kolkata',
    hint: 'IANA timezone name — governs all window math.',
  },
  {
    key: 'daily_activation_cap', label: 'Daily activation cap', type: 'number',
    min: 1, max: 1000,
    hint: 'Per-day release cap for LinkedIn/manual-led campaigns (soft). Email-led campaigns are capped by sender limits instead.',
  },
];

function fmtVal(v) {
  if (v == null) return '—';
  if (Array.isArray(v)) return v.map(d => DAY_LABELS[d] ?? d).join(', ');
  return String(v);
}

// ── ScheduleFieldRow ─────────────────────────────────────────────────────────
// One three-column row: label+state | inherited value | campaign editor.
// `value === null` means inheriting; flipping to override seeds the input
// with the inherited value so the rep edits from reality, not a blank.
function ScheduleFieldRow({ def, prov, value, onChange }) {
  const overriding = value !== null && value !== undefined;
  const inherited  = prov?.inheritedValue;
  const fromLabel  = prov?.inheritedFrom === 'org' ? 'org' : 'default';

  const startOverride = () => {
    if (def.type === 'days')   return onChange([...(Array.isArray(inherited) ? inherited : [1,2,3,4,5])]);
    if (def.type === 'select') return onChange(inherited ?? def.options[0].value);
    return onChange(inherited ?? '');
  };

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '170px 1fr 1.2fr', gap: '0 14px',
      padding: '10px 0', borderTop: '1px solid #f1f5f9', fontSize: 13,
      alignItems: 'start',
    }}>
      <div>
        <div style={{ fontWeight: 600, color: '#1f2937' }}>{def.label}</div>
        <div style={{ fontSize: 11, marginTop: 2, color: overriding ? '#92400e' : '#9ca3af', fontWeight: overriding ? 600 : 400 }}>
          {overriding ? 'override' : 'inheriting'}
        </div>
        {def.hint && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3, lineHeight: 1.4 }}>{def.hint}</div>}
      </div>

      <div style={{ fontSize: 12, color: '#6b7280', paddingTop: 2 }}>
        {fmtVal(inherited)}
        <span style={{ color: '#cbd5e1' }}> · {fromLabel}</span>
      </div>

      <div>
        {!overriding ? (
          <button
            onClick={startOverride}
            style={{
              background: 'none', border: '1px solid #cbd5e1', borderRadius: 5,
              padding: '4px 10px', fontSize: 12, color: '#475569', cursor: 'pointer',
            }}
          >
            Override for this campaign
          </button>
        ) : (
          <div>
            {def.type === 'select' && (
              <select
                value={value}
                onChange={e => onChange(e.target.value)}
                style={{ fontSize: 12, padding: '5px 8px', borderRadius: 5, border: '1px solid #d1d5db', maxWidth: '100%' }}
              >
                {def.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            )}
            {def.type === 'number' && (
              <input
                type="number" min={def.min} max={def.max} value={value}
                onChange={e => onChange(e.target.value === '' ? '' : parseInt(e.target.value, 10))}
                style={{ fontSize: 12, padding: '5px 8px', borderRadius: 5, border: '1px solid #d1d5db', width: 100 }}
              />
            )}
            {def.type === 'text' && (
              <input
                type="text" value={value} placeholder={def.placeholder}
                onChange={e => onChange(e.target.value)}
                style={{ fontSize: 12, padding: '5px 8px', borderRadius: 5, border: '1px solid #d1d5db', width: '100%', maxWidth: 260 }}
              />
            )}
            {def.type === 'days' && (
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {DAY_LABELS.map((d, i) => {
                  const on = Array.isArray(value) && value.includes(i);
                  return (
                    <button
                      key={d}
                      onClick={() => {
                        const cur = Array.isArray(value) ? value : [];
                        onChange(on ? cur.filter(x => x !== i) : [...cur, i].sort());
                      }}
                      style={{
                        padding: '3px 9px', fontSize: 11, borderRadius: 12, cursor: 'pointer',
                        border: on ? `1px solid ${EMBER}` : '1px solid #e5e7eb',
                        background: on ? '#FEF1E7' : '#fff',
                        color: on ? EMBER : '#6b7280', fontWeight: on ? 700 : 400,
                      }}
                    >
                      {d}
                    </button>
                  );
                })}
              </div>
            )}
            <button
              onClick={() => onChange(null)}
              style={{
                display: 'block', marginTop: 5, background: 'none', border: 'none',
                padding: 0, fontSize: 11, color: TEAL, cursor: 'pointer',
              }}
            >
              revert to inherited ({fmtVal(inherited)})
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── ScheduleConfigSection ────────────────────────────────────────────────────
function ScheduleConfigSection({ campaignId }) {
  const [prov, setProv]       = useState(null);    // provenance from the API
  const [draft, setDraft]     = useState({});      // key → value | null(inherit)
  const [saved, setSaved]     = useState({});      // last-saved snapshot for dirty check
  const [error, setError]     = useState('');
  const [saving, setSaving]   = useState(false);
  const [flash, setFlash]     = useState('');

  useEffect(() => {
    let cancelled = false;
    apiFetch(`/prospecting-campaigns/${campaignId}/schedule-config`)
      .then(r => {
        if (cancelled) return;
        const d = {};
        for (const def of SCHEDULE_FIELDS) d[def.key] = r.fields?.[def.key]?.campaignValue ?? null;
        setProv(r.fields || {});
        setDraft(d);
        setSaved(d);
      })
      .catch(err => !cancelled && setError(err.message || 'Failed to load schedule config'));
    return () => { cancelled = true; };
  }, [campaignId]);

  const dirtyKeys = SCHEDULE_FIELDS
    .map(f => f.key)
    .filter(k => JSON.stringify(draft[k] ?? null) !== JSON.stringify(saved[k] ?? null));

  const save = async () => {
    setSaving(true); setError('');
    try {
      // Send ONLY the dirty fields. null = explicit clear → inherit. The
      // campaign PUT only touches keys present in the body, so untouched
      // fields keep their stored values.
      const body = {};
      for (const k of dirtyKeys) body[k] = draft[k] === '' ? null : draft[k];
      await apiFetch(`/prospecting-campaigns/${campaignId}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      setSaved({ ...draft });
      setFlash('Schedule saved.');
      setTimeout(() => setFlash(''), 3000);
    } catch (err) {
      setError(err.message || 'Failed to save schedule');
    } finally {
      setSaving(false);
    }
  };

  if (error && !prov) {
    return <div style={{ padding: 14, fontSize: 13, color: '#991b1b', background: '#fef2f2', borderRadius: 6 }}>{error}</div>;
  }
  if (!prov) return <div style={{ padding: 14, fontSize: 13, color: '#9ca3af' }}>Loading schedule…</div>;

  return (
    <div style={{
      background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: '14px 16px',
    }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: '#1A3A5C', marginBottom: 2 }}>
        📅 Sending schedule
      </div>
      <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 8 }}>
        Empty fields inherit the org schedule (or the platform default where the org sets nothing).
        Overrides apply only to this campaign's sends.
      </div>

      <div style={{
        display: 'grid', gridTemplateColumns: '170px 1fr 1.2fr', gap: '0 14px',
        fontSize: 11, color: '#9ca3af', paddingBottom: 4,
      }}>
        <span />
        <span>Inherited value</span>
        <span>This campaign</span>
      </div>

      {SCHEDULE_FIELDS.map(def => (
        <ScheduleFieldRow
          key={def.key}
          def={def}
          prov={prov[def.key]}
          value={draft[def.key]}
          onChange={v => setDraft(prev => ({ ...prev, [def.key]: v }))}
        />
      ))}

      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, marginTop: 12,
        paddingTop: 12, borderTop: '1px solid #f1f5f9',
      }}>
        {error && <span style={{ fontSize: 12, color: '#991b1b' }}>{error}</span>}
        {flash && <span style={{ fontSize: 12, color: '#047857' }}>{flash}</span>}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9ca3af' }}>
          {dirtyKeys.length > 0 ? `${dirtyKeys.length} unsaved change${dirtyKeys.length === 1 ? '' : 's'}` : 'No unsaved changes'}
        </span>
        <button
          onClick={() => setDraft({ ...saved })}
          disabled={dirtyKeys.length === 0 || saving}
          style={{
            background: 'none', border: '1px solid #cbd5e1', borderRadius: 5,
            padding: '6px 14px', fontSize: 12, color: '#475569',
            cursor: dirtyKeys.length === 0 ? 'default' : 'pointer',
            opacity: dirtyKeys.length === 0 ? 0.5 : 1,
          }}
        >
          Discard
        </button>
        <button
          onClick={save}
          disabled={dirtyKeys.length === 0 || saving}
          style={{
            background: dirtyKeys.length === 0 ? '#9ca3af' : TEAL, border: 'none', borderRadius: 5,
            padding: '6px 14px', fontSize: 12, color: '#fff', fontWeight: 600,
            cursor: dirtyKeys.length === 0 ? 'default' : 'pointer',
          }}
        >
          {saving ? 'Saving…' : 'Save schedule'}
        </button>
      </div>
    </div>
  );
}

// ── CampaignConfigScreen ─────────────────────────────────────────────────────
export default function CampaignConfigScreen({ campaignId, onBack }) {
  const [campaign, setCampaign] = useState(null);
  const [overrides, setOverrides] = useState(null);
  // Active tab: 'outreach' | 'schedule'. Deep-linked as hash segment 4
  // (#/prospecting/campaigns/<id>/config/schedule) — outreach, the
  // default, keeps the clean /config URL.
  const [tab, setTab] = useState(() => {
    const parts = (window.location.hash || '').replace(/^#\/?/, '').split('/');
    return parts[4]?.toLowerCase() === 'schedule' ? 'schedule' : 'outreach';
  });

  useEffect(() => {
    const parts = (window.location.hash || '').replace(/^#\/?/, '').split('/');
    if (parts[0]?.toLowerCase() !== 'prospecting' || parts[1]?.toLowerCase() !== 'campaigns') return;
    if (parts[3]?.toLowerCase() !== 'config') return;
    const want = tab === 'schedule' ? `#/prospecting/campaigns/${campaignId}/config/schedule`
                                    : `#/prospecting/campaigns/${campaignId}/config`;
    if (window.location.hash !== want) window.history.replaceState(null, '', want);
  }, [tab, campaignId]);

  useEffect(() => {
    let cancelled = false;
    apiFetch(`/prospecting-campaigns/${campaignId}`)
      .then(r => {
        if (cancelled) return;
        setCampaign(r.campaign || null);
        setOverrides(r.overrides || null);
      })
      .catch(() => { /* header degrades gracefully */ });
    return () => { cancelled = true; };
  }, [campaignId]);

  const schedN = overrides?.schedule?.length || 0;
  const cfgN   = overrides?.config?.hasOverride ? (overrides.config.overriddenKeys?.length || 0) : 0;
  const chip = (text, active, goTab) => (
    <span
      onClick={goTab ? () => setTab(goTab) : undefined}
      style={{
        fontSize: 11, padding: '3px 10px', borderRadius: 12, fontWeight: active ? 700 : 400,
        background: active ? '#FEF1E7' : '#f3f4f6',
        color: active ? '#92400e' : '#6b7280',
        cursor: goTab ? 'pointer' : 'default',
      }}
    >
      {text}
    </span>
  );

  const TABS = [
    { key: 'outreach', label: '🛠 Outreach config',  badge: cfgN },
    { key: 'schedule', label: '📅 Sending schedule', badge: schedN },
  ];

  return (
    <div style={{ maxWidth: 920, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: 14 }}>
        <button
          onClick={onBack}
          style={{
            background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            fontSize: 12, color: '#6b7280', marginBottom: 4,
          }}
        >
          ← {campaign?.name || 'Back to campaign'}
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: 18, color: '#1A3A5C' }}>Campaign configuration</h2>
          {overrides && chip(
            cfgN > 0 ? `outreach: ${cfgN} override${cfgN === 1 ? '' : 's'}` : 'outreach: inheriting org',
            cfgN > 0, 'outreach'
          )}
          {overrides && chip(
            schedN > 0 ? `schedule: ${schedN} override${schedN === 1 ? '' : 's'}` : 'schedule: inheriting org',
            schedN > 0, 'schedule'
          )}
        </div>
      </div>

      {/* ── Tab bar ── two clearly separate surfaces: the outreach config
          editor and the sending-schedule editor. */}
      <div style={{
        display: 'flex', gap: 0, borderBottom: '2px solid #e5e7eb', marginBottom: 16,
      }}>
        {TABS.map(tb => {
          const active = tab === tb.key;
          return (
            <button
              key={tb.key}
              onClick={() => setTab(tb.key)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                padding: '9px 16px', fontSize: 13.5,
                fontWeight: active ? 700 : 500,
                color: active ? '#1A3A5C' : '#9ca3af',
                borderBottom: active ? `2px solid ${TEAL}` : '2px solid transparent',
                marginBottom: -2,
              }}
            >
              {tb.label}
              {tb.badge > 0 && (
                <span style={{
                  marginLeft: 6, fontSize: 10.5, fontWeight: 700,
                  background: '#FEF1E7', color: '#92400e',
                  borderRadius: 9, padding: '1px 7px',
                }}>
                  {tb.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {tab === 'outreach' && (
        /* The existing editor, complete with every field (pitch, value
           props, personas, products, hooks, case studies, guardrails)
           and its own save/delete controls. */
        <CampaignConfigPanel campaignId={campaignId} />
      )}

      {tab === 'schedule' && (
        <ScheduleConfigSection campaignId={campaignId} />
      )}
    </div>
  );
}
