// ProspectRowMenu.js — extracted from ProspectingView.js (2026 module split).
// Verbatim component bodies; only imports added. No behavior changes.

import React, { useState, useEffect, useRef } from 'react';

function ProspectRowMenu({ prospect, onDiscard, onActivate, stopClickPropagation = true, style = {} }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  // Activation enrolls the prospect into its campaign's default sequence, so
  // it only applies to a research-stage prospect that's actually in a campaign.
  const canActivate = !!onActivate
    && prospect?.stage === 'research'
    && !!prospect?.campaign_id;

  useEffect(() => {
    if (!open) return;
    const handle = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  const stop = (e) => { if (stopClickPropagation) e.stopPropagation(); };

  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex', ...style }}>
      <button
        onClick={e => { stop(e); setOpen(o => !o); }}
        title="More actions"
        style={{
          background: 'transparent',
          border: 'none',
          color: '#6b7280',
          fontSize: 16,
          lineHeight: 1,
          padding: '2px 6px',
          borderRadius: 4,
          cursor: 'pointer',
        }}
      >
        ⋯
      </button>
      {open && (
        <div
          onClick={stop}
          style={{
            position: 'absolute',
            top: '100%', right: 0,
            marginTop: 2,
            background: '#fff',
            border: '1px solid #e5e7eb',
            borderRadius: 7,
            boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
            minWidth: 150,
            zIndex: 120,
            padding: 4,
          }}
        >
          {canActivate && (
            <button
              onClick={e => {
                stop(e);
                setOpen(false);
                onActivate(prospect);
              }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                width: '100%',
                padding: '7px 10px',
                border: 'none', background: 'transparent',
                color: '#0F9D8E',
                fontSize: 13, textAlign: 'left',
                borderRadius: 5, cursor: 'pointer',
              }}
            >
              ⚡ Activate
            </button>
          )}
          {onDiscard && (
          <button
            onClick={e => {
              stop(e);
              setOpen(false);
              if (onDiscard) onDiscard(prospect);
            }}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              width: '100%',
              padding: '7px 10px',
              border: 'none', background: 'transparent',
              color: '#dc2626',
              fontSize: 13, textAlign: 'left',
              borderRadius: 5, cursor: 'pointer',
            }}
          >
            🗑 Discard…
          </button>
          )}
        </div>
      )}
    </span>
  );
}



export default ProspectRowMenu;
