/**
 * EnrollInCampaignModal.js
 *
 * Campaign-first enrollment for a SINGLE prospect (prospect detail panel).
 * Replaces the old "Enroll in Sequence" flow: the rep picks a campaign, the
 * modal shows the campaign's default sequence AND the exact time the first
 * touch will go out (from the campaign's schedule-preview), then enrolls.
 *
 * Why the first-touch time matters: adding a prospect to a campaign without an
 * action being scheduled silently drops them. Surfacing "first touch will go
 * out at …" before confirming — and refusing campaigns with no default
 * sequence — guarantees the rep knows an action is (or isn't) queued.
 *
 * Props:
 *   prospect   — the prospect object to enroll (single)
 *   onEnrolled — callback(result) after a successful enroll
 *   onClose
 */

import React, { useState, useEffect } from 'react';

const API = process.env.REACT_APP_API_URL || '';

function apiFetch(path, options = {}) {
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  return fetch(`${API}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
    ...options,
  }).then(r => {
    if (!r.ok) return r.json().then(e => Promise.reject(new Error(e?.error?.message || r.statusText)));
    return r.json();
  });
}

const TEAL       = '#0F9D8E';
const TEAL_LIGHT = '#e6f7f6';
const CHANNEL_ICONS = { email: '✉️', linkedin: '🔗', call: '📞', task: '📋' };

// Format an ISO timestamp in a specific IANA timezone, e.g.
// "Mon, Jul 21, 9:12 AM (America/New_York)". Falls back gracefully.
function formatInTz(iso, tz) {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    const opts = {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
      ...(tz ? { timeZone: tz } : {}),
    };
    return new Intl.DateTimeFormat('en-US', opts).format(d);
  } catch (_) {
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  }
}

export default function EnrollInCampaignModal({ prospect, onEnrolled, onClose }) {
  const [campaigns,    setCampaigns]    = useState([]);
  const [loadingCamps, setLoadingCamps] = useState(true);
  const [selected,     setSelected]     = useState(null); // campaign row

  // Per-selected-campaign detail
  const [steps,        setSteps]        = useState([]);
  const [preview,      setPreview]      = useState(null);  // { firstAt, tz, channel } | null
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError,  setDetailError]  = useState('');

  const [enrolling,    setEnrolling]    = useState(false);
  const [error,        setError]        = useState('');
  const [done,         setDone]         = useState(null);  // enroll result

  // ── Load active campaigns ──────────────────────────────────────────────────
  useEffect(() => {
    apiFetch('/prospecting-campaigns?status=active')
      .then(r => setCampaigns(r.campaigns || []))
      .catch(() => setCampaigns([]))
      .finally(() => setLoadingCamps(false));
  }, []);

  // ── Select a campaign → load its default sequence + first-touch preview ────
  const handleSelect = async (camp) => {
    setSelected(camp);
    setSteps([]);
    setPreview(null);
    setDetailError('');
    setError('');
    if (!camp.default_sequence_id) {
      // No default sequence → nothing can be scheduled. Say so plainly.
      setDetailError('This campaign has no default sequence, so no outreach would be scheduled. Set a default sequence on the campaign first.');
      return;
    }
    setLoadingDetail(true);
    try {
      // Sequence steps for the plan preview + schedule-preview for the first
      // touch time. Run together; the preview is the important one.
      const [seqRes, prevRes] = await Promise.allSettled([
        apiFetch(`/sequences/${camp.default_sequence_id}`),
        apiFetch(`/prospecting-campaigns/${camp.id}/schedule-preview?count=1`),
      ]);
      if (seqRes.status === 'fulfilled') {
        setSteps(seqRes.value?.sequence?.steps || []);
      }
      if (prevRes.status === 'fulfilled') {
        const p = prevRes.value;
        setPreview({
          firstAt: p?.summary?.firstAt || null,
          tz:      p?.settings?.sendWindowTimezone || null,
          channel: p?.channel || null,
        });
      } else {
        setDetailError(prevRes.reason?.message || 'Could not compute the first-touch time.');
      }
    } catch (err) {
      setDetailError(err.message);
    } finally {
      setLoadingDetail(false);
    }
  };

  // ── Enroll ─────────────────────────────────────────────────────────────────
  const handleEnroll = async () => {
    if (!selected?.id || !selected.default_sequence_id) return;
    setEnrolling(true);
    setError('');
    try {
      const res = await apiFetch(`/prospecting-campaigns/${selected.id}/enroll-one`, {
        method: 'POST',
        body: JSON.stringify({ prospectId: prospect.id }),
      });
      if (res.alreadyEnrolled) {
        setError('This prospect is already enrolled in the campaign\u2019s sequence.');
        setEnrolling(false);
        return;
      }
      setDone(res);
      onEnrolled && onEnrolled(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setEnrolling(false);
    }
  };

  const prospectName = `${prospect?.first_name || ''} ${prospect?.last_name || ''}`.trim();
  const firstTouchLabel = preview?.firstAt ? formatInTz(preview.firstAt, preview.tz) : null;

  return (
    <div onClick={onClose} style={overlayStyle}>
      <div onClick={e => e.stopPropagation()} style={modalStyle}>

        {/* Header */}
        <div style={headerStyle}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111827' }}>
              {done ? '✅ Enrolled in Campaign' : 'Enroll in Campaign'}
            </h3>
            <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>
              {prospectName}{prospect?.company_name ? ` · ${prospect.company_name}` : ''}
            </p>
          </div>
          <button onClick={onClose} style={closeBtn}>✕</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 22px' }}>
          {error && (
            <div style={errBox}>⚠️ {error}</div>
          )}

          {/* ── DONE ─────────────────────────────────────────────────────── */}
          {done ? (
            <div style={{ textAlign: 'center', padding: '24px 12px' }}>
              <div style={{ fontSize: 44, marginBottom: 12 }}>🚀</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#111827', marginBottom: 6 }}>
                {prospectName} enrolled in “{selected?.name}”
              </div>
              <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 16 }}>
                Sequence: <strong>{done.sequenceName || selected?.default_sequence_name}</strong>
              </div>
              <div style={firstTouchBox}>
                <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: '#065f46', fontWeight: 700, marginBottom: 4 }}>
                  First touch scheduled
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#065f46' }}>
                  {formatInTz(done.firstSendAt, done.timezone) || 'on schedule'}
                </div>
                {done.timezone && (
                  <div style={{ fontSize: 11, color: '#047857', marginTop: 2 }}>{done.timezone}</div>
                )}
              </div>
              <button onClick={onClose} style={{ ...primaryBtn, marginTop: 20 }}>Done</button>
            </div>
          ) : (
            <>
              {/* ── Campaign picker ──────────────────────────────────────── */}
              <div style={labelStyle}>Choose a campaign</div>
              {loadingCamps ? (
                <div style={{ textAlign: 'center', padding: 30, color: '#9ca3af' }}>Loading campaigns…</div>
              ) : campaigns.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 30, color: '#6b7280', fontSize: 13 }}>
                  No active campaigns. Create one in the Campaigns tab first.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {campaigns.map(c => {
                    const isSel   = selected?.id === c.id;
                    const noSeq   = !c.default_sequence_id;
                    return (
                      <div
                        key={c.id}
                        onClick={() => handleSelect(c)}
                        style={{
                          padding: '11px 14px', borderRadius: 10,
                          border: `1.5px solid ${isSel ? TEAL : '#e5e7eb'}`,
                          background: isSel ? TEAL_LIGHT : '#fff',
                          cursor: 'pointer', transition: 'all 0.15s',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                          <div style={{ fontWeight: 600, fontSize: 14, color: '#111827' }}>{c.name}</div>
                          {noSeq ? (
                            <span style={{ fontSize: 11, color: '#b45309', background: '#fef3c7', padding: '2px 8px', borderRadius: 10, whiteSpace: 'nowrap' }}>
                              no default sequence
                            </span>
                          ) : (
                            <span style={{ fontSize: 11, color: '#6b7280', whiteSpace: 'nowrap' }}>
                              {c.default_sequence_name || 'default sequence'}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* ── Selected campaign detail: first touch + plan ─────────── */}
              {selected && (
                <div style={{ marginTop: 16 }}>
                  {detailError && <div style={warnBox}>⚠️ {detailError}</div>}

                  {loadingDetail && (
                    <div style={{ textAlign: 'center', padding: 16, color: '#9ca3af', fontSize: 13 }}>
                      Calculating first-touch time…
                    </div>
                  )}

                  {!loadingDetail && preview && (
                    <div style={firstTouchBox}>
                      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: '#065f46', fontWeight: 700, marginBottom: 4 }}>
                        📅 First touch will go out
                      </div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: '#065f46' }}>
                        {firstTouchLabel || 'on the next available slot'}
                      </div>
                      <div style={{ fontSize: 11, color: '#047857', marginTop: 2 }}>
                        {preview.channel ? `${CHANNEL_ICONS[preview.channel] || ''} ${preview.channel}` : ''}
                        {preview.tz ? `  ·  ${preview.tz}` : ''}
                      </div>
                    </div>
                  )}

                  {!loadingDetail && !detailError && steps.length > 0 && (
                    <div style={{ marginTop: 14 }}>
                      <div style={labelStyle}>What happens after enrolling</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {steps.map((step, idx) => (
                          <div key={step.id || idx} style={stepRow}>
                            <span style={stepNum}>{idx + 1}</span>
                            <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>
                              {CHANNEL_ICONS[step.channel] || '📋'} {step.channel}
                            </span>
                            <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 'auto' }}>
                              {(step.delay_days === 0 && !(step.delay_hours > 0))
                                ? (idx === 0 ? 'first touch' : 'same day')
                                : `+${step.delay_days > 0 ? `${step.delay_days}d` : ''}${step.delay_hours > 0 ? ` ${step.delay_hours}h` : ''}`}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {!done && (
          <div style={footerStyle}>
            <span style={{ fontSize: 11, color: '#9ca3af' }}>
              {selected?.default_sequence_id
                ? 'Sets campaign membership and schedules the first touch.'
                : 'Pick a campaign with a default sequence to enroll.'}
            </span>
            <button
              onClick={handleEnroll}
              disabled={enrolling || !selected || !selected.default_sequence_id || loadingDetail}
              style={{
                ...primaryBtn,
                background: (enrolling || !selected || !selected.default_sequence_id || loadingDetail) ? '#9ca3af' : TEAL,
                cursor: (enrolling || !selected || !selected.default_sequence_id || loadingDetail) ? 'not-allowed' : 'pointer',
              }}
            >
              {enrolling ? '⏳ Enrolling…' : '🚀 Enroll in Campaign'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const overlayStyle = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100,
};
const modalStyle = {
  background: '#fff', borderRadius: 14, width: 560, maxWidth: '95vw', maxHeight: '90vh',
  display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.18)', overflow: 'hidden',
};
const headerStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '18px 22px 14px', borderBottom: '1px solid #f3f4f6', flexShrink: 0,
};
const footerStyle = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
  padding: '12px 22px', borderTop: '1px solid #f3f4f6', flexShrink: 0,
};
const closeBtn = {
  padding: '6px 10px', borderRadius: 6, border: '1px solid #e5e7eb',
  background: '#fff', color: '#6b7280', cursor: 'pointer', fontSize: 14,
};
const primaryBtn = {
  padding: '9px 20px', borderRadius: 8, border: 'none', background: TEAL,
  color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
};
const labelStyle = {
  display: 'block', fontSize: 11, fontWeight: 600, color: '#6b7280',
  marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.3,
};
const firstTouchBox = {
  padding: '12px 14px', borderRadius: 10,
  background: '#ecfdf5', border: '1px solid #6ee7b7',
};
const errBox = {
  padding: '9px 12px', background: '#fef2f2', border: '1px solid #fecaca',
  borderRadius: 7, fontSize: 12, color: '#dc2626', marginBottom: 14,
};
const warnBox = {
  padding: '9px 12px', background: '#fffbeb', border: '1px solid #fde68a',
  borderRadius: 7, fontSize: 12, color: '#b45309', marginBottom: 12,
};
const stepRow = {
  display: 'flex', alignItems: 'center', gap: 10,
  padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff',
};
const stepNum = {
  width: 20, height: 20, borderRadius: '50%', background: TEAL, color: '#fff',
  fontSize: 11, fontWeight: 700, flexShrink: 0,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};
