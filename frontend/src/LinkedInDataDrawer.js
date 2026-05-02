// ─────────────────────────────────────────────────────────────────────────────
// LinkedInDataDrawer — Surface B Phase 1
//
// A togglable side drawer that surfaces captured LinkedIn profile data while
// the rep is composing an email or sequence draft. Read-only display with
// per-snippet Copy + Insert actions.
//
// Props:
//   linkedinUrl  {string}       — prospect's LinkedIn URL (required to fetch)
//   onInsert     {(text) => void} — callback when rep clicks Insert on a snippet
//                                  Receives the raw snippet text. Caller decides
//                                  where to insert (cursor pos, append, etc.)
//   onClose      {() => void}    — callback when rep clicks the close button
//
// API:
//   GET /linkedin-profiles/by-url?url=<linkedinUrl>
//
// Design conventions match LinkedInProfileSection in ProspectingView.js so the
// drawer feels like a natural extension of the LinkedIn tab.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useCallback } from 'react';

const API = process.env.REACT_APP_API_URL || '';

// Mirror apiFetch from ProspectingView.js for now. (Future: extract to a shared
// http.js module so all three call sites use one implementation.)
function apiFetch(path, options = {}) {
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  return fetch(`${API}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  }).then(async r => {
    if (r.ok) return r.json();
    let errBody = {};
    try { errBody = await r.json(); } catch (_) {}
    throw new Error(errBody?.error?.message || r.statusText);
  });
}

function timeAgo(d) {
  if (!d) return '';
  const diff = Date.now() - new Date(d).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7)   return `${days}d ago`;
  if (days < 30)  return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function cleanAbout(text) {
  if (!text) return '';
  return text.replace(/^About\s*\n+/i, '').trim();
}

function cleanRelativeTime(s) {
  if (!s) return '';
  return s.replace(/\s*[•·]\s*Edited\s*[•·]?\s*$/i, '')
          .replace(/\s*[•·]\s*$/, '')
          .trim();
}

function formatMonthRange(months) {
  if (!months || months < 1) return '';
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (y === 0) return `${m}mo`;
  if (m === 0) return `${y}y`;
  return `${y}y ${m}mo`;
}

function formatExpDate(d) {
  if (!d) return null;
  const dt = new Date(d);
  if (isNaN(dt)) return null;
  return dt.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

// Build the snippet text that gets passed to onInsert / clipboard.
// Designed to read naturally if dropped into an email body.
function buildExpSnippet(exp) {
  const start = formatExpDate(exp.start_date);
  const end   = exp.end_date ? formatExpDate(exp.end_date) : 'Present';
  const dur   = formatMonthRange(exp.duration_months);
  const dates = start && end ? `${start} – ${end}` : (start || end || '');
  const tail  = [dates, dur].filter(Boolean).join(' · ');
  const head  = [exp.title, exp.company].filter(Boolean).join(' at ');
  return tail ? `${head} (${tail})` : head;
}

function buildEduSnippet(ed) {
  const yrs = ed.start_year && ed.end_year ? ` (${ed.start_year}–${ed.end_year})` : '';
  const detail = [ed.degree, ed.field_of_study].filter(Boolean).join(', ');
  return detail ? `${ed.school}, ${detail}${yrs}` : `${ed.school}${yrs}`;
}

function buildActivitySnippet(item) {
  const rel = cleanRelativeTime(item.relative_time) || 'recently';
  const text = item.text ? item.text.slice(0, 220).trim() : '';
  const kindWord = item.kind === 'reaction' ? 'reacted to' : (item.kind === 'comment' ? 'commented' : 'posted');
  if (!text) return `They ${kindWord} ${rel}`;
  return `Their ${item.kind || 'post'} from ${rel}: "${text}${item.text.length > 220 ? '…' : ''}"`;
}

// ── Snippet card ─────────────────────────────────────────────────────────────

function SnippetCard({ label, body, snippet, onInsert, sourceUrl }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch (_) {
      // Fallback for older browsers — silently fail; user can hand-copy.
    }
  }, [snippet]);

  return (
    <div style={{
      border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 12px',
      background: '#fff', marginBottom: 8,
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        marginBottom: 4,
      }}>
        <div style={{
          fontSize: 10, fontWeight: 600, color: '#9ca3af',
          textTransform: 'uppercase', letterSpacing: 0.4,
        }}>
          {label}
        </div>
        {sourceUrl && (
          <a
            href={sourceUrl} target="_blank" rel="noreferrer"
            style={{ fontSize: 10, color: '#0077B5', textDecoration: 'none' }}
          >
            view ↗
          </a>
        )}
      </div>
      <div style={{
        fontSize: 12, color: '#1a202c', lineHeight: 1.5, marginBottom: 8,
        whiteSpace: 'pre-wrap',
      }}>
        {body}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          onClick={handleCopy}
          style={{
            fontSize: 11, padding: '4px 10px', borderRadius: 5,
            border: '1px solid #d1d5db', background: '#fff', color: '#374151',
            cursor: 'pointer', fontWeight: 500,
          }}
        >
          {copied ? '✓ Copied' : 'Copy'}
        </button>
        <button
          onClick={() => onInsert && onInsert(snippet)}
          style={{
            fontSize: 11, padding: '4px 10px', borderRadius: 5,
            border: '1px solid #0077B5', background: '#0077B5', color: '#fff',
            cursor: 'pointer', fontWeight: 500,
          }}
        >
          Insert
        </button>
      </div>
    </div>
  );
}

// ── Main drawer ──────────────────────────────────────────────────────────────

export default function LinkedInDataDrawer({ linkedinUrl, onInsert, onClose }) {
  const [profile, setProfile] = useState(undefined);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (!linkedinUrl) {
      setProfile(null);
      return;
    }
    setProfile(undefined);
    setError(null);
    apiFetch(`/linkedin-profiles/by-url?url=${encodeURIComponent(linkedinUrl)}`)
      .then(r => { if (!cancelled) setProfile(r.profile || null); })
      .catch(err => {
        if (cancelled) return;
        setError(err.message || 'Failed to load profile');
        setProfile(null);
      });
    return () => { cancelled = true; };
  }, [linkedinUrl]);

  // Close on Escape — common drawer pattern, low risk.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && onClose) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const containerStyle = {
    width: 360, flexShrink: 0,
    borderLeft: '1px solid #e5e7eb', background: '#fafafa',
    display: 'flex', flexDirection: 'column',
    maxHeight: '100%', overflow: 'hidden',
  };

  const headerStyle = {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '12px 14px', borderBottom: '1px solid #e5e7eb',
    background: '#fff', flexShrink: 0,
  };

  const bodyStyle = { flex: 1, overflowY: 'auto', padding: '12px 14px' };

  // ── Empty/loading/error states ─────────────────────────────────────────────
  if (!linkedinUrl) {
    return (
      <div style={containerStyle}>
        <div style={headerStyle}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Personalize
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, color: '#6b7280', cursor: 'pointer', padding: 0, lineHeight: 1 }}>×</button>
        </div>
        <div style={{ padding: 20, fontSize: 12, color: '#6b7280', lineHeight: 1.5 }}>
          No LinkedIn URL on this prospect — add one to enable personalization data.
        </div>
      </div>
    );
  }

  if (profile === undefined) {
    return (
      <div style={containerStyle}>
        <div style={headerStyle}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Personalize
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, color: '#6b7280', cursor: 'pointer', padding: 0, lineHeight: 1 }}>×</button>
        </div>
        <div style={{ padding: 20, fontSize: 12, color: '#9ca3af' }}>Loading…</div>
      </div>
    );
  }

  if (error || profile === null) {
    return (
      <div style={containerStyle}>
        <div style={headerStyle}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Personalize
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, color: '#6b7280', cursor: 'pointer', padding: 0, lineHeight: 1 }}>×</button>
        </div>
        <div style={{ padding: 20, fontSize: 12, color: '#6b7280', lineHeight: 1.55 }}>
          {error
            ? <>⚠️ {error}</>
            : <>
                <div style={{ marginBottom: 10 }}>Profile not yet captured.</div>
                <div style={{ marginBottom: 12 }}>Visit this prospect's LinkedIn page with the GoWarmCRM extension to capture their data.</div>
                <a href={linkedinUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-block', fontSize: 11, padding: '5px 10px', borderRadius: 5, background: '#0077B5', color: '#fff', textDecoration: 'none', fontWeight: 500 }}>
                  Open LinkedIn ↗
                </a>
              </>
          }
        </div>
      </div>
    );
  }

  // ── Loaded ─────────────────────────────────────────────────────────────────
  const about      = cleanAbout(profile.about);
  const experience = Array.isArray(profile.experience) ? profile.experience : [];
  const education  = Array.isArray(profile.education)  ? profile.education  : [];
  const activity   = Array.isArray(profile.activity)   ? profile.activity   : [];

  const hasAnything = about || experience.length || education.length || activity.length;

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Personalize
          </div>
          {profile.last_captured_at && (
            <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>
              Captured {timeAgo(profile.last_captured_at)}
            </div>
          )}
        </div>
        <button
          onClick={onClose}
          aria-label="Close drawer"
          style={{ background: 'none', border: 'none', fontSize: 18, color: '#6b7280', cursor: 'pointer', padding: 0, lineHeight: 1 }}
        >
          ×
        </button>
      </div>

      <div style={bodyStyle}>
        {!hasAnything && (
          <div style={{ fontSize: 12, color: '#6b7280', padding: '10px 0', lineHeight: 1.55 }}>
            Profile exists but no detail captured yet. <a href={linkedinUrl} target="_blank" rel="noreferrer" style={{ color: '#0077B5' }}>Recapture from LinkedIn ↗</a>
          </div>
        )}

        {/* Headline + location */}
        {(profile.headline || profile.location) && (
          <div style={{ marginBottom: 12, padding: '8px 12px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 12, color: '#1a202c', lineHeight: 1.45 }}>
            {profile.headline && <div style={{ fontWeight: 500 }}>{profile.headline}</div>}
            {profile.location && <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{profile.location}</div>}
          </div>
        )}

        {/* Current role (top of experience array) */}
        {experience.length > 0 && (
          <>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4, margin: '8px 0 6px' }}>
              Current role
            </div>
            <SnippetCard
              label={(() => {
                const exp0 = experience[0];
                const dur = formatMonthRange(exp0.duration_months);
                return dur ? `${dur} in role` : 'Current';
              })()}
              body={(() => {
                const exp0 = experience[0];
                return [exp0.title, exp0.company].filter(Boolean).join(' — ');
              })()}
              snippet={buildExpSnippet(experience[0])}
              onInsert={onInsert}
            />
          </>
        )}

        {/* Prior roles */}
        {experience.length > 1 && (
          <>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4, margin: '12px 0 6px' }}>
              Prior roles
            </div>
            {experience.slice(1).map((exp, i) => (
              <SnippetCard
                key={i}
                label={(() => {
                  const dur = formatMonthRange(exp.duration_months);
                  const start = formatExpDate(exp.start_date);
                  return [start, dur].filter(Boolean).join(' · ') || 'Past role';
                })()}
                body={[exp.title, exp.company].filter(Boolean).join(' — ')}
                snippet={buildExpSnippet(exp)}
                onInsert={onInsert}
              />
            ))}
          </>
        )}

        {/* About */}
        {about && (
          <>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4, margin: '12px 0 6px' }}>
              From their About
            </div>
            <SnippetCard
              label="About excerpt"
              body={about.length > 220 ? about.slice(0, 220).trim() + '…' : about}
              snippet={about}
              onInsert={onInsert}
            />
          </>
        )}

        {/* Recent activity */}
        {activity.length > 0 && (
          <>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4, margin: '12px 0 6px' }}>
              Recent activity
            </div>
            {activity.map((item, i) => {
              const rel = cleanRelativeTime(item.relative_time);
              const kindLabel = item.kind === 'reaction' ? (item.action || 'reacted') : (item.kind || 'post');
              const labelText = [kindLabel, rel].filter(Boolean).join(' · ');
              return (
                <SnippetCard
                  key={item.id || i}
                  label={labelText}
                  body={item.text ? (item.text.length > 220 ? item.text.slice(0, 220).trim() + '…' : item.text) : '(no text)'}
                  snippet={buildActivitySnippet(item)}
                  onInsert={onInsert}
                  sourceUrl={item.source_url || null}
                />
              );
            })}
          </>
        )}

        {/* Education */}
        {education.length > 0 && (
          <>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4, margin: '12px 0 6px' }}>
              Education
            </div>
            {education.map((ed, i) => (
              <SnippetCard
                key={i}
                label={ed.start_year && ed.end_year ? `${ed.start_year}–${ed.end_year}` : 'School'}
                body={ed.school + (ed.degree || ed.field_of_study ? ` — ${[ed.degree, ed.field_of_study].filter(Boolean).join(', ')}` : '')}
                snippet={buildEduSnippet(ed)}
                onInsert={onInsert}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
