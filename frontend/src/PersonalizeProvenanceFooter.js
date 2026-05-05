// ─────────────────────────────────────────────────────────────────────────────
// PersonalizeProvenanceFooter.js — Surface B Phase 3
//
// Renders below the body textarea on AI-generated drafts to show the rep
// exactly which LinkedIn fields the AI saw and the verbatim snippet text,
// so they can verify before sending.
//
// Props:
//   sources {
//     fields_used: string[]                     // ['current_role', 'recent_activity', ...]
//     snippets:    Array<{field, value}>        // verbatim text the AI saw
//     captured_at: ISO date string | null
//   }
//
// Compact one-line summary by default. Expand-to-detail. Yellow warning if
// the source data is older than 30 days.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState } from 'react';

// Display labels — keep aligned with PersonalizeConfigBlock dimensions.
const FIELD_LABEL = {
  current_role:    'current role',
  prior_roles:     'prior roles',
  recent_activity: 'recent activity',
  education:       'education',
  about_headline:  'about + headline',
};

const STALE_DAYS = 30;

function daysSince(d) {
  if (!d) return null;
  const t = new Date(d).getTime();
  if (isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

function timeAgo(d) {
  const days = daysSince(d);
  if (days === null) return '';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7)   return `${days} days ago`;
  if (days < 30)  return `${Math.floor(days / 7)} weeks ago`;
  if (days < 60)  return `1 month ago`;
  return `${Math.floor(days / 30)} months ago`;
}

export default function PersonalizeProvenanceFooter({ sources }) {
  const [expanded, setExpanded] = useState(false);

  if (!sources || !Array.isArray(sources.fields_used) || sources.fields_used.length === 0) {
    return null;
  }

  const fields    = sources.fields_used;
  const snippets  = Array.isArray(sources.snippets) ? sources.snippets : [];
  const captured  = sources.captured_at || null;
  const days      = daysSince(captured);
  const isStale   = days !== null && days > STALE_DAYS;

  // Compact summary line
  const fieldLabels = fields.map(f => FIELD_LABEL[f] || f);
  const summary = fieldLabels.length === 1
    ? fieldLabels[0]
    : fieldLabels.length === 2
      ? `${fieldLabels[0]} · ${fieldLabels[1]}`
      : `${fieldLabels.slice(0, -1).join(' · ')} · ${fieldLabels[fieldLabels.length - 1]}`;

  return (
    <div style={{
      marginTop: 8,
      border: `1px solid ${isStale ? '#fcd34d' : '#e5e7eb'}`,
      borderRadius: 7,
      background: isStale ? '#fffbeb' : '#fafafa',
      fontSize: 11,
      overflow: 'hidden',
    }}>
      {/* ── Compact header (always visible) ───────────────────────────────── */}
      <div
        onClick={() => setExpanded(v => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '7px 10px',
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <span style={{ fontSize: 12 }}>✨</span>
        <span style={{ color: isStale ? '#92400e' : '#374151', fontWeight: 500 }}>
          AI used:
        </span>
        <span style={{ color: isStale ? '#92400e' : '#6b7280', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {summary}
        </span>
        {captured && (
          <span style={{
            fontSize: 10,
            color: isStale ? '#b45309' : '#9ca3af',
            fontWeight: isStale ? 600 : 400,
            flexShrink: 0,
          }}>
            captured {timeAgo(captured)}{isStale ? ' ⚠' : ''}
          </span>
        )}
        <span style={{ color: '#9ca3af', fontSize: 10, flexShrink: 0 }}>
          {expanded ? '▲' : '▼'}
        </span>
      </div>

      {/* ── Expanded snippet detail ─────────────────────────────────────────── */}
      {expanded && (
        <div style={{
          padding: '8px 10px 10px',
          borderTop: '1px solid #e5e7eb',
          background: '#fff',
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          {isStale && (
            <div style={{
              fontSize: 10.5, color: '#92400e',
              padding: '5px 8px', borderRadius: 5,
              background: '#fef3c7', border: '1px solid #fde68a',
              lineHeight: 1.4,
            }}>
              ⚠ This LinkedIn data was captured over {STALE_DAYS} days ago. Re-capture from
              the prospect's LinkedIn profile to refresh.
            </div>
          )}

          {snippets.length === 0 ? (
            <div style={{ fontSize: 11, color: '#9ca3af', fontStyle: 'italic' }}>
              No snippet detail recorded.
            </div>
          ) : (
            snippets.map((s, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div style={{
                  fontSize: 9.5, fontWeight: 600, color: '#9ca3af',
                  textTransform: 'uppercase', letterSpacing: 0.4,
                }}>
                  {FIELD_LABEL[s.field] || s.field}
                </div>
                <div style={{
                  fontSize: 11, color: '#374151', lineHeight: 1.45,
                  whiteSpace: 'pre-wrap',
                  paddingLeft: 8,
                  borderLeft: '2px solid #e5e7eb',
                }}>
                  {s.value}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
