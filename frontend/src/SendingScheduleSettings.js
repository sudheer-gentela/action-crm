// ─────────────────────────────────────────────────────────────────────────────
// SendingScheduleSettings.js  (unified sending schedule)
//
// One coherent per-campaign / per-org sending schedule. Fields:
//   - sendWindowDays         (array of 0..6, 0=Sun)
//   - sendWindowTimezone     (IANA)
//   - startMode              ('on_activate' | 'fixed' | 'fixed_or_now')
//   - sendWindowStartHour    (0-23)  + sendWindowStartMinute (0-59)
//   - pacingMode             ('cadence' | 'spread')
//   - cadenceMinutes         (1-240, used when pacing = cadence)
//   - sendWindowEndHour      (1-24, used when pacing = spread; also a cadence
//                             safety ceiling on the backend)
//   - linkedinReleaseCap     (per-day LinkedIn connection-request RELEASE cap;
//                             soft — the action is performed manually)
//
// The email daily cap is NOT edited here: it lives on each sender account
// (prospecting_sender_accounts.daily_limit). A campaign's email capacity is
// DERIVED (Σ active senders' limits) and shown read-only via the `capacity`
// prop when available.
//
// Modes:
//   mode="org"      → every field is a direct value (no inherit).
//   mode="campaign" → each row has an "Override org default" checkbox; OFF
//                     sends null (inherit). Org defaults shown muted.
//
// Controlled component: onChange fires with the full value object.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react';

const TEAL = '#0F9D8E';
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const TIMEZONE_PRESETS = [
  { value: 'America/New_York',     label: 'America/New_York (ET)' },
  { value: 'America/Chicago',      label: 'America/Chicago (CT)' },
  { value: 'America/Denver',       label: 'America/Denver (MT)' },
  { value: 'America/Los_Angeles',  label: 'America/Los_Angeles (PT)' },
  { value: 'Europe/London',        label: 'Europe/London (GMT/BST)' },
  { value: 'Europe/Berlin',        label: 'Europe/Berlin (CET)' },
  { value: 'Asia/Kolkata',         label: 'Asia/Kolkata (IST)' },
  { value: 'Asia/Singapore',       label: 'Asia/Singapore (SGT)' },
  { value: 'Asia/Tokyo',           label: 'Asia/Tokyo (JST)' },
  { value: 'Australia/Sydney',     label: 'Australia/Sydney (AEDT)' },
];

function HourSelect({ value, onChange, min = 0, max = 23, disabled }) {
  const opts = [];
  for (let h = min; h <= max; h++) {
    let label;
    if (h === 0)        label = '12 AM';
    else if (h < 12)    label = `${h} AM`;
    else if (h === 12)  label = '12 PM';
    else if (h === 24)  label = '12 AM (next day)';
    else                label = `${h - 12} PM`;
    opts.push(<option key={h} value={h}>{label}</option>);
  }
  return (
    <select
      value={value ?? min}
      onChange={(e) => onChange(parseInt(e.target.value, 10))}
      disabled={disabled}
      style={selectStyle(disabled)}
    >{opts}</select>
  );
}

function MinuteSelect({ value, onChange, disabled }) {
  const opts = [];
  for (let m = 0; m < 60; m += 5) {
    opts.push(<option key={m} value={m}>{String(m).padStart(2, '0')}</option>);
  }
  return (
    <select
      value={value ?? 0}
      onChange={(e) => onChange(parseInt(e.target.value, 10))}
      disabled={disabled}
      style={selectStyle(disabled)}
    >{opts}</select>
  );
}

function DayPicker({ value, onChange, disabled }) {
  const days = Array.isArray(value) ? value : [];
  const toggle = (d) => {
    const next = days.includes(d) ? days.filter(x => x !== d) : [...days, d].sort();
    onChange(next);
  };
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {DAY_LABELS.map((label, idx) => {
        const on = days.includes(idx);
        return (
          <button
            key={idx} type="button" disabled={disabled}
            onClick={() => toggle(idx)}
            style={{
              padding: '4px 10px', borderRadius: 4,
              border: '1px solid ' + (on ? TEAL : '#d1d5db'),
              background: disabled ? '#f3f4f6' : (on ? TEAL : '#fff'),
              color: disabled ? '#9ca3af' : (on ? '#fff' : '#374151'),
              fontSize: 12, fontWeight: on ? 600 : 400,
              cursor: disabled ? 'not-allowed' : 'pointer', minWidth: 42,
            }}
          >{label}</button>
        );
      })}
    </div>
  );
}

function TimezoneSelect({ value, onChange, disabled }) {
  const matchesPreset = TIMEZONE_PRESETS.some(p => p.value === value);
  const [isCustom, setIsCustom] = React.useState(!matchesPreset && !!value);
  if (isCustom) {
    return (
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          type="text" value={value || ''} placeholder="e.g. Pacific/Auckland"
          onChange={(e) => onChange(e.target.value)} disabled={disabled}
          style={{ padding: '6px 8px', borderRadius: 4, border: '1px solid #d1d5db', fontSize: 13, flex: 1, background: disabled ? '#f3f4f6' : '#fff' }}
        />
        <button type="button" onClick={() => { setIsCustom(false); onChange('America/New_York'); }} disabled={disabled}
          style={{ padding: '6px 8px', borderRadius: 4, border: '1px solid #d1d5db', background: '#fff', fontSize: 11, cursor: disabled ? 'not-allowed' : 'pointer' }}>
          Use preset
        </button>
      </div>
    );
  }
  return (
    <select
      value={value || 'America/New_York'}
      onChange={(e) => { if (e.target.value === '__custom__') { setIsCustom(true); return; } onChange(e.target.value); }}
      disabled={disabled} style={{ ...selectStyle(disabled), width: '100%' }}
    >
      {TIMEZONE_PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
      <option value="__custom__">Other (custom IANA)...</option>
    </select>
  );
}

// Radio group helper.
function RadioGroup({ name, value, options, onChange, disabled }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {options.map(opt => (
        <label key={opt.value} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, color: disabled ? '#9ca3af' : '#374151', cursor: disabled ? 'not-allowed' : 'pointer' }}>
          <input
            type="radio" name={name} value={opt.value}
            checked={value === opt.value} disabled={disabled}
            onChange={() => onChange(opt.value)}
            style={{ marginTop: 2 }}
          />
          <span>
            <span style={{ fontWeight: value === opt.value ? 600 : 400 }}>{opt.label}</span>
            {opt.hint && <span style={{ display: 'block', fontSize: 11, color: '#9ca3af' }}>{opt.hint}</span>}
          </span>
        </label>
      ))}
    </div>
  );
}

function Row({ label, hint, mode, isOverride, onToggleOverride, orgDefault, children }) {
  const isCampaign = mode === 'campaign';
  const effectivelyEnabled = !isCampaign || isOverride;
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <label style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>{label}</label>
        {isCampaign && (
          <label style={{ fontSize: 11, color: '#6b7280', display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={!!isOverride} onChange={(e) => onToggleOverride(e.target.checked)} />
            Override org default
          </label>
        )}
      </div>
      {hint && <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6 }}>{hint}</div>}
      <div style={{ opacity: effectivelyEnabled ? 1 : 0.55 }}>{children}</div>
      {isCampaign && !isOverride && orgDefault != null && (
        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>Org default: {orgDefault}</div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
export default function SendingScheduleSettings({ mode = 'org', value, orgDefaults, onChange, disabled, capacity }) {
  const isCampaign = mode === 'campaign';
  const v  = value || {};
  const od = orgDefaults || {};

  const DEF = {
    startMode: 'fixed_or_now', pacingMode: 'cadence', cadenceMinutes: 5,
    sendWindowStartHour: 8, sendWindowStartMinute: 0, sendWindowEndHour: 18,
    sendWindowDays: [1, 2, 3, 4, 5], sendWindowTimezone: 'America/New_York',
    linkedinReleaseCap: 25,
  };

  // Per-field override state (campaign mode). A row groups related fields.
  const isOvr = (field) => isCampaign ? v[field] != null : true;
  const eff = (field) => {
    if (!isCampaign || isOvr(field)) return v[field] ?? od[field] ?? DEF[field];
    return od[field] ?? DEF[field];
  };

  const update = (patch) => onChange({ ...v, ...patch });

  // Toggle override on/off for a group of fields. On → copy effective values;
  // off → set all to null (inherit).
  const toggleGroup = (fields, isOn) => {
    const patch = {};
    for (const f of fields) patch[f] = isOn ? eff(f) : null;
    onChange({ ...v, ...patch });
  };

  const startMode  = eff('startMode');
  const pacingMode = eff('pacingMode');

  return (
    <div>
      {/* Active days */}
      <Row
        label="Send on days" mode={mode}
        hint="Which days of the week are eligible for sending."
        isOverride={isOvr('sendWindowDays')}
        onToggleOverride={(on) => toggleGroup(['sendWindowDays'], on)}
        orgDefault={Array.isArray(od.sendWindowDays) ? od.sendWindowDays.map(d => DAY_LABELS[d]).join(', ') : null}
      >
        <DayPicker value={eff('sendWindowDays')} onChange={(d) => update({ sendWindowDays: d })}
          disabled={disabled || (isCampaign && !isOvr('sendWindowDays'))} />
      </Row>

      {/* Timezone */}
      <Row
        label="Time zone" mode={mode}
        hint="Start/end times are interpreted in this timezone."
        isOverride={isOvr('sendWindowTimezone')}
        onToggleOverride={(on) => toggleGroup(['sendWindowTimezone'], on)}
        orgDefault={od.sendWindowTimezone}
      >
        <TimezoneSelect value={eff('sendWindowTimezone')} onChange={(tz) => update({ sendWindowTimezone: tz })}
          disabled={disabled || (isCampaign && !isOvr('sendWindowTimezone'))} />
      </Row>

      {/* Start each day */}
      <Row
        label="Start each day" mode={mode}
        hint="When the day's sending begins."
        isOverride={isOvr('startMode')}
        onToggleOverride={(on) => toggleGroup(['startMode', 'sendWindowStartHour', 'sendWindowStartMinute'], on)}
        orgDefault={startModeLabel(od.startMode)}
      >
        <RadioGroup
          name={`startmode-${mode}`} value={startMode}
          disabled={disabled || (isCampaign && !isOvr('startMode'))}
          onChange={(m) => update({ startMode: m })}
          options={[
            { value: 'fixed_or_now', label: 'At a set time, or now if it has passed', hint: 'Recommended — fills today if the start time already went by' },
            { value: 'fixed',        label: 'At a set time only', hint: 'If the time has passed today, the first sends land tomorrow' },
            { value: 'on_activate',  label: 'Start now, when I activate' },
          ]}
        />
        {startMode !== 'on_activate' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
            <span style={{ fontSize: 12, color: '#6b7280' }}>Start time:</span>
            <HourSelect value={eff('sendWindowStartHour')} onChange={(h) => update({ sendWindowStartHour: h })}
              min={0} max={23} disabled={disabled || (isCampaign && !isOvr('startMode'))} />
            <span style={{ color: '#6b7280' }}>:</span>
            <MinuteSelect value={eff('sendWindowStartMinute')} onChange={(m) => update({ sendWindowStartMinute: m })}
              disabled={disabled || (isCampaign && !isOvr('startMode'))} />
          </div>
        )}
      </Row>

      {/* Pacing */}
      <Row
        label="Pacing" mode={mode}
        hint="How the day's sends are distributed."
        isOverride={isOvr('pacingMode')}
        onToggleOverride={(on) => toggleGroup(['pacingMode', 'cadenceMinutes', 'sendWindowEndHour'], on)}
        orgDefault={pacingLabel(od.pacingMode, od.cadenceMinutes)}
      >
        <RadioGroup
          name={`pacing-${mode}`} value={pacingMode}
          disabled={disabled || (isCampaign && !isOvr('pacingMode'))}
          onChange={(m) => update({ pacingMode: m })}
          options={[
            { value: 'cadence', label: 'Cadence', hint: 'One send every N minutes from the start time' },
            { value: 'spread',  label: 'Even spread', hint: 'Distribute evenly across a start–end window' },
          ]}
        />
        {pacingMode === 'cadence' ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
            <span style={{ fontSize: 12, color: '#6b7280' }}>Every</span>
            <input type="number" min="1" max="240"
              value={eff('cadenceMinutes') ?? 5}
              onChange={(e) => update({ cadenceMinutes: parseInt(e.target.value, 10) || 1 })}
              disabled={disabled || (isCampaign && !isOvr('pacingMode'))}
              style={{ ...selectStyle(disabled || (isCampaign && !isOvr('pacingMode'))), width: 70 }} />
            <span style={{ fontSize: 12, color: '#6b7280' }}>minutes (± a little jitter)</span>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
            <span style={{ fontSize: 12, color: '#6b7280' }}>End by</span>
            <HourSelect value={eff('sendWindowEndHour')} onChange={(h) => update({ sendWindowEndHour: h })}
              min={1} max={24} disabled={disabled || (isCampaign && !isOvr('pacingMode'))} />
          </div>
        )}
      </Row>

      {/* LinkedIn release cap */}
      <Row
        label="LinkedIn requests / day" mode={mode}
        hint="Soft cap on LinkedIn connection-request tasks released per day. The action is performed manually on LinkedIn, so this paces your queue — it isn't a hard send limit."
        isOverride={isOvr('linkedinReleaseCap')}
        onToggleOverride={(on) => toggleGroup(['linkedinReleaseCap'], on)}
        orgDefault={od.linkedinReleaseCap}
      >
        <input type="number" min="1" max="200"
          value={eff('linkedinReleaseCap') ?? 25}
          onChange={(e) => update({ linkedinReleaseCap: parseInt(e.target.value, 10) || 1 })}
          disabled={disabled || (isCampaign && !isOvr('linkedinReleaseCap'))}
          style={{ ...selectStyle(disabled || (isCampaign && !isOvr('linkedinReleaseCap'))), width: 90 }} />
        <span style={{ fontSize: 11, color: '#6b7280', marginLeft: 8 }}>requests / day</span>
      </Row>

      {/* Email capacity — derived, read-only */}
      <div style={{ marginTop: 4, padding: '12px 14px', background: '#f0fdfa', border: '1px solid #ccfbf1', borderRadius: 6 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#0f766e', marginBottom: 4 }}>Email daily capacity</div>
        {capacity && capacity.kind === 'email' && capacity.weighted ? (
          // Weighted mode: the backend descriptor carries the campaign's slice
          // and a ready-made label (e.g. "100% of 100 emails/day = 100/day", or
          // "No share assigned…" when excluded). It does NOT carry activeSenders,
          // so we must NOT fall back to the sender ternary here — doing so would
          // misreport "No active email senders connected" for every weighted
          // email campaign regardless of real senders. Sender presence is
          // surfaced in shared mode (below) and in Settings → Outreach.
          <div style={{ fontSize: 12, color: capacity.excluded ? '#b45309' : '#334155' }}>
            {capacity.label}
          </div>
        ) : capacity && capacity.kind === 'email' ? (
          <div style={{ fontSize: 12, color: '#334155' }}>
            {capacity.activeSenders > 0
              ? <>{capacity.activeSenders} active sender{capacity.activeSenders === 1 ? '' : 's'}
                  {capacity.perAccountLimits && capacity.perAccountLimits.length
                    ? ` (${capacity.perAccountLimits.join(' + ')})` : ''} = <strong>{capacity.perDayFull}/day</strong>
                  {Number.isFinite(capacity.todayRemaining) && <> · <span style={{ color: '#0f766e' }}>{capacity.todayRemaining} left today</span></>}
                </>
              : <span style={{ color: '#b45309' }}>No active email senders connected. Connect Gmail/Outlook in Settings → Outreach.</span>}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: '#64748b' }}>
            Derived from each sender account's daily limit (Settings → Outreach). Email volume is governed per sending account, not here.
          </div>
        )}
      </div>
    </div>
  );
}

function selectStyle(disabled) {
  return {
    padding: '6px 8px', borderRadius: 4, border: '1px solid #d1d5db', fontSize: 13,
    background: disabled ? '#f3f4f6' : '#fff', color: disabled ? '#9ca3af' : '#111827',
  };
}
function startModeLabel(m) {
  if (m === 'on_activate') return 'Start on activate';
  if (m === 'fixed') return 'Fixed time';
  if (m === 'fixed_or_now') return 'Fixed time or now';
  return null;
}
function pacingLabel(m, cadence) {
  if (m === 'cadence') return `Cadence${cadence ? ` (every ${cadence}m)` : ''}`;
  if (m === 'spread') return 'Even spread';
  return null;
}
