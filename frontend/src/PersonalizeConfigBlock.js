// ─────────────────────────────────────────────────────────────────────────────
// PersonalizeConfigBlock — Surface B Phase 2
//
// Shared 5-checkbox UI for "which LinkedIn fields should the AI pull from when
// generating drafts." Used at three levels in the cascade:
//
//   1. Per-step       (SequenceBuilder)  — overrides sequence default
//   2. Sequence-level (SequenceBuilder)  — overrides user default
//   3. User-level     (SettingsView)     — bottom of cascade above SYSTEM_DEFAULT
//
// Props:
//   value          {object|null}   current config; null = inherit from next level
//   onChange       (cfg|null)=>void called with new config or null (clear/inherit)
//   inheritedFrom  {string?}       label like "sequence default" / "your preferences"
//                                    — when present, shows inheritance hint and
//                                      "Customize for this step" button
//   inheritedValue {object?}       what the inherited config resolves to — used
//                                    to preview checkbox state when value===null
//   readOnly       {boolean?}      disables all edits
//   showResetButton{boolean?}      default true. Set false at user-level (no
//                                    inheritance to reset to).
//   compact        {boolean?}      tighter spacing for per-step usage
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react';

export const PERSONALIZE_DIMENSIONS = [
  { key: 'current_role',    label: 'Current role',          hint: 'Headline + most recent experience' },
  { key: 'prior_roles',     label: 'Prior roles',           hint: 'Earlier experience entries'        },
  { key: 'recent_activity', label: 'Recent activity',       hint: 'Posts, comments, reactions'        },
  { key: 'education',       label: 'Education',             hint: 'School + degree'                   },
  { key: 'about_headline',  label: 'About + headline',      hint: 'Self-written summary'              },
];

export const SYSTEM_DEFAULT = {
  current_role:    false,
  prior_roles:     false,
  recent_activity: false,
  education:       false,
  about_headline:  false,
};

export default function PersonalizeConfigBlock({
  value,
  onChange,
  inheritedFrom = null,
  inheritedValue = null,
  readOnly = false,
  showResetButton = true,
  compact = false,
}) {
  const isInheriting = value === null || value === undefined;

  // What checkboxes show when inheriting: the resolved cascade value,
  // falling back to SYSTEM_DEFAULT (all off) if no upstream value exists.
  const displayValue = isInheriting
    ? (inheritedValue || SYSTEM_DEFAULT)
    : value;

  const handleToggle = (key) => {
    if (readOnly) return;
    // First edit while inheriting: materialize a full config object based on
    // the displayValue (so checkboxes stay in their visual state) then flip.
    const base = isInheriting ? { ...displayValue } : { ...value };
    base[key] = !base[key];
    onChange(base);
  };

  const handleReset = () => {
    if (readOnly) return;
    onChange(null);
  };

  const handleCustomize = () => {
    if (readOnly) return;
    // "Customize" button — materialize the inherited preview as the new value
    // so checkboxes become editable in the same state they're already showing.
    onChange({ ...displayValue });
  };

  const padding   = compact ? '10px 12px' : '14px 16px';
  const gap       = compact ? 6 : 8;

  return (
    <div style={{
      border: '1px solid #e5e7eb',
      borderRadius: 8,
      padding,
      background: isInheriting ? '#fafafa' : '#fff',
    }}>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 8, gap: 12,
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontSize: compact ? 11 : 12,
            fontWeight: 600,
            color: '#374151',
            textTransform: 'uppercase',
            letterSpacing: 0.4,
          }}>
            ✨ Personalize using LinkedIn data
          </div>
          {isInheriting && inheritedFrom && (
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 3 }}>
              Inherited from <strong>{inheritedFrom}</strong>
            </div>
          )}
        </div>

        {!readOnly && (
          <div style={{ flexShrink: 0 }}>
            {isInheriting && inheritedFrom && (
              <button
                type="button"
                onClick={handleCustomize}
                style={btnGhost}
              >
                Customize
              </button>
            )}
            {!isInheriting && showResetButton && (
              <button
                type="button"
                onClick={handleReset}
                style={btnGhost}
                title="Revert to inherited value"
              >
                ↺ Reset to inherited
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Checkboxes ────────────────────────────────────────────────── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: compact ? '1fr 1fr' : '1fr 1fr',
        gap,
      }}>
        {PERSONALIZE_DIMENSIONS.map(dim => {
          const checked = !!displayValue[dim.key];
          // The checkbox is editable whenever !readOnly. If the user clicks
          // while inheriting, handleToggle() materializes the displayValue
          // (the resolved cascade preview) into a real `value` and flips the
          // key — i.e. clicking auto-customizes. At user-level (no inherit)
          // the inheriting-but-no-source case starts from SYSTEM_DEFAULT
          // (all false) and ticks build up from there.
          return (
            <label
              key={dim.key}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                padding: '4px 0',
                cursor: readOnly ? 'default' : 'pointer',
                opacity: isInheriting && !readOnly ? 0.85 : 1,
              }}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={readOnly}
                onChange={() => handleToggle(dim.key)}
                style={{ marginTop: 2, cursor: readOnly ? 'default' : 'pointer' }}
              />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: '#1f2937', lineHeight: 1.3 }}>
                  {dim.label}
                </div>
                <div style={{ fontSize: 10.5, color: '#9ca3af', lineHeight: 1.3 }}>
                  {dim.hint}
                </div>
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
}

const btnGhost = {
  padding: '4px 10px',
  borderRadius: 5,
  border: '1px solid #d1d5db',
  background: '#fff',
  color: '#374151',
  fontSize: 11,
  fontWeight: 500,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};
