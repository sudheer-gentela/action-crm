// InfoRow.js — extracted from ProspectingView.js (2026 module split).
// Verbatim component bodies; only imports added. No behavior changes.

import React from 'react';

function InfoRow({ label, value, optional = false, editMode = false, editValue, onEdit }) {
  // optional=true rows are hidden when empty in view mode
  if (!editMode && optional && !value && value !== 0) return null;
  const isEmpty = value === null || value === undefined || value === '';
  return (
    <div className="pv-info-row">
      <span className="pv-info-label">{label}</span>
      {editMode && onEdit ? (
        <input
          value={editValue ?? ''}
          onChange={e => onEdit(e.target.value)}
          style={{
            flex: 1, fontSize: 12, padding: '2px 6px',
            border: '1px solid #d1d5db', borderRadius: 4,
            color: '#374151', background: '#fff', minWidth: 0,
          }}
        />
      ) : (
        <span className="pv-info-value" style={isEmpty ? { color: '#9ca3af' } : {}}>
          {!isEmpty ? value : '—'}
        </span>
      )}
    </div>
  );
}



// ═════════════════════════════════════════════════════════════════════════════
// CALLS PANEL
// Renders the call history for a prospect inside the Calls tab. Pure
// display + a "Log call" CTA — actual logging is handled by LogCallModal
// owned by ProspectDetailPanel.
// ═════════════════════════════════════════════════════════════════════════════


export default InfoRow;
