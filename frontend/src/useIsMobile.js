// useIsMobile.js — shared viewport-width hook.
//
// Why this exists: modules written entirely with inline style={{ }} props
// (HandoverView, CampaignsView, ProspectDetailPanel, SequencesView, ...) have
// no stylesheet for a media query to attach to. Branching the style object on
// this hook is the cheapest way to make those responsive without extracting
// several thousand inline styles into CSS files first.
//
// Prefer a CSS media query wherever the module already has a stylesheet. Reach
// for this hook only when the styles live in JS, or when the change is
// structural (rendering a different component on small screens) rather than
// merely visual.
//
// Uses matchMedia rather than a resize listener: the callback fires only when
// the breakpoint is actually crossed, not on every pixel of a resize or on
// every mobile-browser toolbar collapse.
//
//   const isMobile = useIsMobile();
//   <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row' }}>

import { useState, useEffect } from 'react';

export const MOBILE_BREAKPOINT = 768;

export default function useIsMobile(breakpoint = MOBILE_BREAKPOINT) {
  const query = `(max-width: ${breakpoint - 1}px)`;

  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;

    const mql = window.matchMedia(query);
    const onChange = (e) => setIsMobile(e.matches);

    // Re-sync on mount: the breakpoint may have been crossed between the lazy
    // initialiser running and this effect firing.
    setIsMobile(mql.matches);

    // addEventListener on MediaQueryList is unsupported before Safari 14.
    if (mql.addEventListener) {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, [query]);

  return isMobile;
}
