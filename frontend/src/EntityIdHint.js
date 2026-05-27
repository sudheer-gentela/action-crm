// EntityIdHint.js — small inline (i) icon that reveals an entity's internal ID
// on click, and copies it to clipboard. Used next to entity names in views
// where developers/admins occasionally need the ID for DB queries or API
// calls.
//
// Usage:
//   <EntityIdHint id={campaign.id} type="campaign" />
//   <EntityIdHint id={sequence.id} type="sequence" inline />
//
// Props:
//   id     — the entity's numeric ID (required)
//   type   — short label shown in the tooltip ("campaign", "sequence", etc.)
//   inline — if true, renders as inline-block with no surrounding margin
//            (useful inside text); defaults to a small left margin
//
// Behavior:
//   - Renders a small ⓘ glyph in muted grey
//   - On hover: shows "Campaign · 123" in a tooltip (no copy)
//   - On click: copies the bare ID to clipboard, shows "✓ Copied 123" briefly
//   - Keyboard accessible (Enter/Space on the focused icon)
//   - Stops propagation so clicking inside row-click contexts doesn't trigger
//     the row's own onClick

import React, { useState, useRef, useEffect } from 'react';

const TYPE_LABELS = {
  campaign:  'Campaign',
  sequence:  'Sequence',
  prospect:  'Prospect',
  account:   'Account',
  deal:      'Deal',
  contact:   'Contact',
  user:      'User',
  log:       'Log',
  enrollment:'Enrollment',
};

export default function EntityIdHint({ id, type = '', inline = false }) {
  const [showTip,  setShowTip]  = useState(false);
  const [copied,   setCopied]   = useState(false);
  const hideTimer = useRef(null);

  // If no id, render nothing — saves callers from null-guarding.
  if (id == null || id === '') return null;

  const label = TYPE_LABELS[type] || (type ? type[0].toUpperCase() + type.slice(1) : 'ID');

  const handleClick = (e) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      // Modern clipboard API. Falls back to older execCommand if needed.
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(String(id));
      } else {
        const ta = document.createElement('textarea');
        ta.value = String(id);
        ta.style.position = 'fixed';
        ta.style.opacity  = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      setShowTip(true);
      clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => {
        setCopied(false);
        setShowTip(false);
      }, 1500);
    } catch (_) {
      // Clipboard failures are non-fatal — still show the tooltip so the
      // user can see/select the ID manually.
      setShowTip(true);
      clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setShowTip(false), 2500);
    }
  };

  // Clear timer on unmount
  useEffect(() => () => clearTimeout(hideTimer.current), []);

  return (
    <span
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        marginLeft: inline ? 0 : 4,
        verticalAlign: 'middle',
      }}
      onMouseEnter={() => !copied && setShowTip(true)}
      onMouseLeave={() => !copied && setShowTip(false)}
    >
      <button
        type="button"
        onClick={handleClick}
        title={`${label} · ${id} (click to copy)`}
        aria-label={`Show ${label.toLowerCase()} ID`}
        style={{
          background: 'transparent',
          border: 'none',
          padding: 0,
          margin: 0,
          cursor: 'pointer',
          width: 14, height: 14,
          color: '#9ca3af',
          fontSize: 12,
          lineHeight: 1,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: '50%',
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        ⓘ
      </button>
      {showTip && (
        <span
          role="tooltip"
          style={{
            position: 'absolute',
            top: '100%',
            left: '50%',
            transform: 'translateX(-50%)',
            marginTop: 4,
            padding: '4px 8px',
            background: copied ? '#0F9D8E' : '#1f2937',
            color: '#fff',
            fontSize: 11,
            fontWeight: 500,
            borderRadius: 4,
            whiteSpace: 'nowrap',
            zIndex: 1000,
            pointerEvents: 'none',
            boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
          }}
        >
          {copied ? `✓ Copied ${id}` : `${label} · ${id}`}
        </span>
      )}
    </span>
  );
}
