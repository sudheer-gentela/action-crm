// DesktopOnlyNotice.js — small-screen interstitial for desktop-class tooling.
//
// Some surfaces in GoWarm are genuinely desktop work: builders with many
// side-by-side columns, canvases, column-mapping grids, admin consoles. Making
// them usable on a 390px screen would cost far more than it returns, and a
// cramped version is worse than an honest one.
//
// This is a guide, not a gate. "Show it anyway" always works — someone with a
// real reason to push on is not blocked, they are just told what to expect
// first. A hard block would be the wrong call: it turns an inconvenience into a
// dead end, and there is always a case we did not think of.
//
// Usage — wrap the surface, nothing else changes:
//
//   <DesktopOnlyNotice
//     title="The sequence builder needs a wider screen"
//     detail="Steps, delays and A/B variants sit side by side..."
//   >
//     {...the real content...}
//   </DesktopOnlyNotice>
//
// Children are constructed but never mounted while the notice shows, so their
// effects and data fetching do not run.

import React, { useState } from 'react';
import useIsMobile from './useIsMobile';

const NAVY  = '#1A3A5C';
const EMBER = '#E8630A';

export default function DesktopOnlyNotice({
  title = 'This works better on a wider screen',
  detail,
  breakpoint = 768,
  children,
}) {
  const isMobile = useIsMobile(breakpoint);
  const [shownAnyway, setShownAnyway] = useState(false);

  if (!isMobile || shownAnyway) return children;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', textAlign: 'center',
      padding: '48px 24px', minHeight: 260, gap: 14,
    }}>
      <div aria-hidden="true" style={{
        width: 52, height: 52, borderRadius: 14, background: '#EEF4FA',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 26, lineHeight: 1,
      }}>
        🖥️
      </div>

      <h3 style={{
        margin: 0, fontSize: 17, fontWeight: 600, color: NAVY,
        maxWidth: 340, lineHeight: 1.35,
      }}>
        {title}
      </h3>

      {detail && (
        <p style={{
          margin: 0, fontSize: 13, lineHeight: 1.6, color: '#6b7280',
          maxWidth: 380,
        }}>
          {detail}
        </p>
      )}

      <button
        type="button"
        onClick={() => setShownAnyway(true)}
        style={{
          marginTop: 4, padding: '10px 20px', minHeight: 44,
          borderRadius: 8, border: `1px solid ${EMBER}`,
          background: '#fff', color: EMBER,
          fontSize: 14, fontWeight: 600, fontFamily: 'inherit',
          cursor: 'pointer',
        }}
      >
        Show it anyway
      </button>

      <span style={{ fontSize: 12, color: '#9ca3af' }}>
        Everything else in GoWarm works on your phone.
      </span>
    </div>
  );
}
