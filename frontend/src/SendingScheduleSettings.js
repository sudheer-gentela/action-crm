// ─────────────────────────────────────────────────────────────────────────────
// SendingScheduleSettings.js
//
// Reusable form for the five sending-schedule fields:
//   - dailyActivationCap        (int)
//   - sendWindowStartHour       (0-23)
//   - sendWindowEndHour         (1-24)
//   - sendWindowDays            (array of 0..6, 0=Sun)
//   - sendWindowTimezone        (IANA, e.g. America/New_York)
//
// Two usage modes:
//
//   <SendingScheduleSettings
//     mode="org"
//     value={settings}
//     onChange={setSettings}
//   />
//   // Used in SettingsView — controls become the org defaults. No
//   // "override" notion; every field is required.
//
//   <SendingScheduleSettings
//     mode="campaign"
//     value={settings}
//     orgDefaults={orgDefaults}
//     onChange={setSettings}
//   />
//   // Used in CampaignFormModal — each field has an "Override org default"
//   // checkbox; unchecked sends NULL on submit (inherit). Org defaults are
//   // shown in muted text next to each field.
//
// The onChange callback fires with the full settings object on every keystroke.
// Parent is responsible for the actual save (POST/PUT). Component is purely
// presentational/controlled.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Sensible IANA timezone choices for the dropdown. The component allows
// free-form entry too via the "Other..." option for power users.
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

// Render an hour-of-day select (0..23 or 1..24 depending on min).
function HourSelect({ value, onChange, min = 0, max = 23, disabled }) {
  const opts = [];
  for (let h = min; h <= max; h++) {
    // Display as 12-hour with am/pm hint
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
      style={{
        padding: '6px 8px', borderRadius: 4,
        border: '1px solid #d1d5db', fontSize: 13,
        background: disabled ? '#f3f4f6' : '#fff',
        color: disabled ? '#9ca3af' : '#111827',
      }}
    >{opts}</select>
  );
}

// Render the Mon-Sun day pills. Multi-select.
function DayPicker({ value, onChange, disabled }) {
  const days = Array.isArray(value) ? value : [];
  const toggle = (d) => {
    const next = days.includes(d)
      ? days.filter(x => x !== d)
      : [...days, d].sort();
    onChange(next);
  };
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {DAY_LABELS.map((label, idx) => {
        const on = days.includes(idx);
        return (
          <button
            key={idx}
            type="button"
            disabled={disabled}
            onClick={() => toggle(idx)}
            style={{
              padding: '4px 10px',
              borderRadius: 4,
              border: '1px solid ' + (on ? '#0F9D8E' : '#d1d5db'),
              background: disabled ? '#f3f4f6' : (on ? '#0F9D8E' : '#fff'),
              color: disabled ? '#9ca3af' : (on ? '#fff' : '#374151'),
              fontSize: 12,
              fontWeight: on ? 600 : 400,
              cursor: disabled ? 'not-allowed' : 'pointer',
              minWidth: 42,
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
          type="text"
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder="e.g. Pacific/Auckland"
          disabled={disabled}
          style={{
            padding: '6px 8px', borderRadius: 4, border: '1px solid #d1d5db',
            fontSize: 13, flex: 1, background: disabled ? '#f3f4f6' : '#fff',
          }}
        />
        <button
          type="button"
          onClick={() => { setIsCustom(false); onChange('America/New_York'); }}
          disabled={disabled}
          style={{
            padding: '6px 8px', borderRadius: 4, border: '1px solid #d1d5db',
            background: '#fff', fontSize: 11, cursor: disabled ? 'not-allowed' : 'pointer',
          }}
        >Use preset</button>
      </div>
    );
  }
  return (
    <select
      value={value || 'America/New_York'}
      onChange={(e) => {
        if (e.target.value === '__custom__') { setIsCustom(true); return; }
        onChange(e.target.value);
      }}
      disabled={disabled}
      style={{
        padding: '6px 8px', borderRadius: 4, border: '1px solid #d1d5db',
        fontSize: 13, width: '100%',
        background: disabled ? '#f3f4f6' : '#fff',
        color: disabled ? '#9ca3af' : '#111827',
      }}
    >
      {TIMEZONE_PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
      <option value="__custom__">Other (custom IANA)...</option>
    </select>
  );
}

// Render a labeled row with an optional "Override org default" checkbox
// (only shown in mode='campaign'). When the checkbox is unchecked, the
// underlying control is disabled and the org-default hint is shown.
function Row({ label, hint, mode, isOverride, onToggleOverride, orgDefault, children }) {
  const isCampaign = mode === 'campaign';
  const effectivelyEnabled = !isCampaign || isOverride;
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <label style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>{label}</label>
        {isCampaign && (
          <label style={{ fontSize: 11, color: '#6b7280', display: 'flex', alignItems: 'center', gap: 4 }}>
            <input
              type="checkbox"
              checked={!!isOverride}
              onChange={(e) => onToggleOverride(e.target.checked)}
            />
            Override org default
          </label>
        )}
      </div>
      {hint && <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6 }}>{hint}</div>}
      <div style={{ opacity: effectivelyEnabled ? 1 : 0.55 }}>{children}</div>
      {isCampaign && !isOverride && orgDefault != null && (
        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
          Org default: {orgDefault}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────
export default function SendingScheduleSettings({ mode = 'org', value, orgDefaults, onChange, disabled }) {
  // In 'campaign' mode, each field has an associated override boolean
  // tracked alongside the value. A field with null value = "inherit from org"
  // (override OFF). A field with a value = "use this" (override ON).
  const isCampaign = mode === 'campaign';
  const v = value || {};
  const od = orgDefaults || {};

  // For each field: is it currently overriding the org default?
  // - org mode: always "true" (no inherit)
  // - campaign mode: true if value is non-null
  const ovr = isCampaign
    ? {
        dailyActivationCap:  v.dailyActivationCap  != null,
        sendWindowStartHour: v.sendWindowStartHour != null,
        sendWindowEndHour:   v.sendWindowEndHour   != null,
        sendWindowDays:      v.sendWindowDays      != null,
        sendWindowTimezone:  v.sendWindowTimezone  != null,
      }
    : {
        dailyActivationCap:  true, sendWindowStartHour: true,
        sendWindowEndHour:   true, sendWindowDays:      true,
        sendWindowTimezone:  true,
      };

  // Effective values (what to display in each control). In campaign mode,
  // when override is off we show the org default in the control as a hint.
  const eff = {
    dailyActivationCap:  ovr.dailyActivationCap  ? v.dailyActivationCap  : (od.dailyActivationCap  ?? 25),
    sendWindowStartHour: ovr.sendWindowStartHour ? v.sendWindowStartHour : (od.sendWindowStartHour ?? 9),
    sendWindowEndHour:   ovr.sendWindowEndHour   ? v.sendWindowEndHour   : (od.sendWindowEndHour   ?? 11),
    sendWindowDays:      ovr.sendWindowDays      ? v.sendWindowDays      : (od.sendWindowDays      ?? [1,2,3,4,5]),
    sendWindowTimezone:  ovr.sendWindowTimezone  ? v.sendWindowTimezone  : (od.sendWindowTimezone  ?? 'America/New_York'),
  };

  const update = (field, newValue) => {
    onChange({ ...v, [field]: newValue });
  };

  // In campaign mode, toggling an override on copies the current effective
  // value into the field; toggling off sets it to null (inherit).
  const toggleOverride = (field, isOn) => {
    if (isOn) {
      onChange({ ...v, [field]: eff[field] });
    } else {
      onChange({ ...v, [field]: null });
    }
  };

  return (
    <div>
      <Row
        label="Daily activation cap"
        hint="Max new prospects to start sequencing per day. Spread across the send window."
        mode={mode}
        isOverride={ovr.dailyActivationCap}
        onToggleOverride={(on) => toggleOverride('dailyActivationCap', on)}
        orgDefault={od.dailyActivationCap}
      >
        <input
          type="number"
          min="1"
          max="500"
          value={eff.dailyActivationCap ?? 25}
          onChange={(e) => update('dailyActivationCap', parseInt(e.target.value, 10) || 1)}
          disabled={disabled || (isCampaign && !ovr.dailyActivationCap)}
          style={{
            padding: '6px 8px', borderRadius: 4, border: '1px solid #d1d5db',
            fontSize: 13, width: 100,
            background: (disabled || (isCampaign && !ovr.dailyActivationCap)) ? '#f3f4f6' : '#fff',
          }}
        />
        <span style={{ fontSize: 11, color: '#6b7280', marginLeft: 8 }}>prospects / day</span>
      </Row>

      <Row
        label="Send window"
        hint="Time of day to send emails (and release LinkedIn tasks). Emails are spread across this band; LinkedIn tasks all release at the start hour."
        mode={mode}
        isOverride={ovr.sendWindowStartHour || ovr.sendWindowEndHour}
        onToggleOverride={(on) => {
          toggleOverride('sendWindowStartHour', on);
          toggleOverride('sendWindowEndHour', on);
        }}
        orgDefault={(od.sendWindowStartHour != null && od.sendWindowEndHour != null)
          ? `${formatHour(od.sendWindowStartHour)} – ${formatHour(od.sendWindowEndHour)}`
          : null}
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <HourSelect
            value={eff.sendWindowStartHour}
            onChange={(h) => update('sendWindowStartHour', h)}
            min={0} max={23}
            disabled={disabled || (isCampaign && !ovr.sendWindowStartHour)}
          />
          <span style={{ color: '#6b7280' }}>to</span>
          <HourSelect
            value={eff.sendWindowEndHour}
            onChange={(h) => update('sendWindowEndHour', h)}
            min={1} max={24}
            disabled={disabled || (isCampaign && !ovr.sendWindowEndHour)}
          />
        </div>
      </Row>

      <Row
        label="Active days"
        hint="Which days of the week are eligible for sending."
        mode={mode}
        isOverride={ovr.sendWindowDays}
        onToggleOverride={(on) => toggleOverride('sendWindowDays', on)}
        orgDefault={Array.isArray(od.sendWindowDays)
          ? od.sendWindowDays.map(d => DAY_LABELS[d]).join(', ')
          : null}
      >
        <DayPicker
          value={eff.sendWindowDays}
          onChange={(days) => update('sendWindowDays', days)}
          disabled={disabled || (isCampaign && !ovr.sendWindowDays)}
        />
      </Row>

      <Row
        label="Timezone"
        hint="Send window hours are interpreted in this timezone (matters for cross-region recipients)."
        mode={mode}
        isOverride={ovr.sendWindowTimezone}
        onToggleOverride={(on) => toggleOverride('sendWindowTimezone', on)}
        orgDefault={od.sendWindowTimezone}
      >
        <TimezoneSelect
          value={eff.sendWindowTimezone}
          onChange={(tz) => update('sendWindowTimezone', tz)}
          disabled={disabled || (isCampaign && !ovr.sendWindowTimezone)}
        />
      </Row>
    </div>
  );
}

function formatHour(h) {
  if (h === 0)        return '12 AM';
  if (h < 12)         return `${h} AM`;
  if (h === 12)       return '12 PM';
  if (h === 24)       return '12 AM next';
  return `${h - 12} PM`;
}
