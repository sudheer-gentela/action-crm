/**
 * BulkEnrollCampaignModal.js
 *
 * Bulk "Enroll in campaign" for a multi-select of prospects (pipeline bulk bar).
 * Sibling of EnrollInCampaignModal — same guarantee, batched: before enrolling
 * it shows WHEN the first touches will fire (and how they spread across days),
 * so a bulk add to a campaign never silently drops prospects with no action.
 *
 * Flow:
 *   1. On open (campaign already chosen), fetch the campaign's schedule-preview
 *      for the selected count → show first-touch time + per-day breakdown.
 *   2. Confirm → POST /:id/enroll-batch → sets membership + schedules every
 *      eligible prospect. Result screen restates the first touch + any skips.
 *
 * Props:
 *   prospects  — array of selected prospect objects
 *   campaign   — { id, name, default_sequence_id, default_sequence_name }
 *   onEnrolled — callback(result) after a successful enroll
 *   onClose
 */

import React, { useState, useEffect } from 'react';
import { apiFetch } from './prospectingShared';

const TEAL = '#0F9D8E';

export default function BulkEnrollCampaignModal({ prospects, campaign, onEnrolled, onClose }) {
  const count = prospects.length;
  const hasSeq = !!campaign?.default_sequence_id;

  const [preview,        setPreview]        = useState(null);   // schedule-preview response
  const [previewLoading, setPreviewLoading] = useState(hasSeq);
  const [previewError,   setPreviewError]   = useState('');
  const [enrolling,      setEnrolling]      = useState(false);
  const [error,          setError]          = useState('');
  const [done,           setDone]           = useState(null);   // enroll-batch result

  // ── Schedule preview on open ────────────────────────────────────────────────
  useEffect(() => {
    if (!hasSeq || count < 1) { setPreviewLoading(false); return; }
    let cancelled = false;
    setPreviewLoading(true);
    apiFetch(`/prospecting-campaigns/${campaign.id}/schedule-preview?count=${count}`)
      .then(r => { if (!cancelled) setPreview(r); })
      .catch(err => { if (!cancelled) setPreviewError(err.message || 'Could not compute the schedule.'); })
      .finally(() => { if (!cancelled) setPreviewLoading(false); });
    return () => { cancelled = true; };
  }, [campaign?.id, count, hasSeq]);

  // ── Enroll ──────────────────────────────────────────────────────────────────
  const handleEnroll = async () => {
    if (!hasSeq) return;
    setEnrolling(true);
    setError('');
    try {
      const res = await apiFetch(`/prospecting-campaigns/${campaign.id}/enroll-batch`, {
        method: 'POST',
        body: JSON.stringify({ prospectIds: prospects.map(p => p.id) }),
      });
      setDone(res);
      onEnrolled && onEnrolled(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setEnrolling(false);
    }
  };

  const tz = preview?.settings?.sendWindowTimezone || done?.timezone || 'America/New_York';
  const skippedCount = Array.isArray(done?.skipped) ? done.skipped.length : 0;

  return (
    <div onClick={onClose} style={overlay}>
      <div onClick={e => e.stopPropagation()} style={modal}>
        {/* Header */}
        <div style={header}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111827' }}>
              {done ? '✅ Enrolled in Campaign' : 'Enroll in Campaign'}
            </h3>
            <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>
              {count} prospect{count === 1 ? '' : 's'} → “{campaign?.name}”
            </p>
          </div>
          <button onClick={onClose} style={closeBtn}>✕</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 22px' }}>
          {error && <div style={errBox}>⚠️ {error}</div>}

          {/* No default sequence → nothing can be scheduled. */}
          {!hasSeq && !done && (
            <div style={warnBox}>
              ⚠️ “{campaign?.name}” has no default sequence, so no outreach would be scheduled.
              Set a default sequence on the campaign first — otherwise these prospects would sit
              in the campaign with nothing firing.
            </div>
          )}

          {/* ── DONE ─────────────────────────────────────────────────────── */}
          {done ? (
            <div style={{ padding: '8px 0' }}>
              <div style={{ textAlign: 'center', marginBottom: 16 }}>
                <div style={{ fontSize: 40, marginBottom: 8 }}>🚀</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#111827' }}>
                  {done.enrolled} prospect{done.enrolled === 1 ? '' : 's'} enrolled
                  {skippedCount > 0 && (
                    <span style={{ fontWeight: 500, color: '#6b7280', fontSize: 13 }}>
                      {' '}· {skippedCount} skipped
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>
                  Sequence: <strong>{done.sequenceName || campaign?.default_sequence_name}</strong>
                </div>
              </div>

              {done.firstSendAt && (
                <div style={firstTouchBox}>
                  <div style={ftLabel}>📅 First touch goes out</div>
                  <div style={ftTime}>{fmtRelative(done.firstSendAt, tz)}</div>
                  {done.lastSendAt && done.lastSendAt !== done.firstSendAt && (
                    <div style={{ fontSize: 11, color: '#047857', marginTop: 2 }}>
                      Last of this batch: {fmtDateTime(done.lastSendAt, tz)}
                    </div>
                  )}
                </div>
              )}

              {Array.isArray(done.byDay) && done.byDay.length > 0 && (
                <ByDay byDay={done.byDay} tz={tz} />
              )}

              {skippedCount > 0 && (
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 10 }}>
                  {skippedCount} were skipped (already enrolled in this campaign’s sequence or ineligible).
                </div>
              )}

              <div style={{ textAlign: 'center', marginTop: 18 }}>
                <button onClick={onClose} style={primaryBtn}>Done</button>
              </div>
            </div>
          ) : (
            <>
              {/* ── Schedule preview ───────────────────────────────────────── */}
              {hasSeq && (
                <>
                  {previewLoading && (
                    <div style={{ textAlign: 'center', padding: 20, color: '#9ca3af', fontSize: 13 }}>
                      Calculating when the first touches will fire…
                    </div>
                  )}
                  {previewError && <div style={warnBox}>⚠️ {previewError}</div>}

                  {!previewLoading && preview?.summary && (
                    <>
                      <div style={firstTouchBox}>
                        <div style={ftLabel}>📅 First touch will go out</div>
                        <div style={ftTime}>{fmtRelative(preview.summary.firstAt, tz)}</div>
                        <div style={{ fontSize: 11, color: '#047857', marginTop: 2 }}>
                          {preview.channel ? `${preview.channel} · ` : ''}{count} prospect{count === 1 ? '' : 's'}
                          {preview.summary.days > 1 ? ` across ${preview.summary.days} days` : ''}
                          {tz ? `  ·  ${tz}` : ''}
                        </div>
                      </div>
                      <ByDay byDay={preview.byDay} tz={tz} />
                      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 10, lineHeight: 1.5 }}>
                        Prospects already enrolled in this campaign’s sequence are skipped automatically.
                        Sends are paced by the campaign’s send window and your sender capacity.
                      </div>
                    </>
                  )}

                  {!previewLoading && !preview?.summary && !previewError && (
                    <div style={warnBox}>
                      ⚠️ No send slots could be scheduled — check the campaign’s send window and that
                      you have an active sender. Enrolling now may leave prospects with nothing to fire.
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {!done && (
          <div style={footer}>
            <span style={{ fontSize: 11, color: '#9ca3af' }}>
              {hasSeq
                ? 'Sets membership and schedules the first touch for each prospect.'
                : 'This campaign can’t schedule outreach yet.'}
            </span>
            <button
              onClick={handleEnroll}
              disabled={enrolling || !hasSeq}
              style={{
                ...primaryBtn,
                background: (enrolling || !hasSeq) ? '#9ca3af' : TEAL,
                cursor: (enrolling || !hasSeq) ? 'not-allowed' : 'pointer',
              }}
            >
              {enrolling ? '⏳ Enrolling…' : `🚀 Enroll ${count} prospect${count === 1 ? '' : 's'}`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Per-day breakdown (compact) ───────────────────────────────────────────────
function ByDay({ byDay, tz }) {
  if (!Array.isArray(byDay) || byDay.length === 0) return null;
  const visible = byDay.slice(0, 6);
  const hidden  = byDay.slice(6);
  return (
    <div style={{ marginTop: 12, background: '#f9fafb', border: '1px solid #f3f4f6', borderRadius: 8, padding: '8px 12px' }}>
      {visible.map(day => (
        <div key={day.date} style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '4px 0', borderBottom: '1px solid #f3f4f6', fontSize: 12,
        }}>
          <span style={{ color: '#374151' }}>{fmtDay(day.date, tz)}</span>
          <span style={{ color: '#6b7280' }}>
            {day.count} {day.count === 1 ? 'prospect' : 'prospects'}{' '}
            <span style={{ color: '#9ca3af', fontSize: 11 }}>
              ({fmtHM(day.firstAt, tz)}{day.firstAt !== day.lastAt ? `–${fmtHM(day.lastAt, tz)}` : ''})
            </span>
          </span>
        </div>
      ))}
      {hidden.length > 0 && (
        <div style={{ fontSize: 11, color: '#9ca3af', padding: '6px 0 2px', fontStyle: 'italic' }}>
          …and {hidden.length} more day{hidden.length === 1 ? '' : 's'}, ending {fmtDay(byDay[byDay.length - 1].date, tz)}.
        </div>
      )}
    </div>
  );
}

// ── Date/time helpers ─────────────────────────────────────────────────────────
function tzAbbrev(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date());
    return parts.find(p => p.type === 'timeZoneName')?.value || tz;
  } catch (_) { return tz; }
}
function fmtHM(iso, tz) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));
  } catch (_) { return iso; }
}
function fmtDay(dayKey, tz) {
  try {
    const [y, m, d] = dayKey.split('-').map(n => parseInt(n, 10));
    const dt = new Date(Date.UTC(y, m - 1, d, 12, 0));
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(dt);
  } catch (_) { return dayKey; }
}
function fmtDateTime(iso, tz) {
  try {
    return `${new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(iso))} at ${fmtHM(iso, tz)} ${tzAbbrev(tz)}`;
  } catch (_) { return iso; }
}
function fmtRelative(iso, tz) {
  try {
    const dt = new Date(iso);
    const hrs = (dt.getTime() - Date.now()) / 3600000;
    const time = fmtHM(iso, tz);
    if (hrs < 1)  return `in ${Math.max(1, Math.round(hrs * 60))} min (${time} ${tzAbbrev(tz)})`;
    if (hrs < 24) return `today at ${time} ${tzAbbrev(tz)}`;
    if (hrs < 48) return `tomorrow at ${time} ${tzAbbrev(tz)}`;
    return fmtDateTime(iso, tz);
  } catch (_) { return iso; }
}

// ── Styles ────────────────────────────────────────────────────────────────────
const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 };
const modal   = { background: '#fff', borderRadius: 14, width: 560, maxWidth: '95vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.18)', overflow: 'hidden' };
const header  = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 22px 14px', borderBottom: '1px solid #f3f4f6', flexShrink: 0 };
const footer  = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '12px 22px', borderTop: '1px solid #f3f4f6', flexShrink: 0 };
const closeBtn = { padding: '6px 10px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', color: '#6b7280', cursor: 'pointer', fontSize: 14 };
const primaryBtn = { padding: '9px 20px', borderRadius: 8, border: 'none', background: TEAL, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' };
const firstTouchBox = { padding: '12px 14px', borderRadius: 10, background: '#ecfdf5', border: '1px solid #6ee7b7' };
const ftLabel = { fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: '#065f46', fontWeight: 700, marginBottom: 4 };
const ftTime  = { fontSize: 15, fontWeight: 700, color: '#065f46' };
const errBox  = { padding: '9px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 7, fontSize: 12, color: '#dc2626', marginBottom: 14 };
const warnBox = { padding: '10px 12px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 7, fontSize: 12, color: '#b45309', marginBottom: 12, lineHeight: 1.5 };
