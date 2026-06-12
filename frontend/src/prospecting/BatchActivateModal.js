// prospecting/BatchActivateModal.js
//
// Slice 2 — modal invoked from CampaignDetailDrawer. Activates a batch of
// research-stage prospects in the campaign's default sequence.
//
// Sending-schedule Slice 2 additions:
//   - 'Enroll all eligible' checkbox (default ON). When on, the count input
//     maxes out at readyCount (not daily cap); the scheduler spreads them
//     across days. When off, capped at dailyActivationCap (legacy behavior).
//   - Schedule preview block — calls GET /:id/schedule-preview to render
//     "First N go out tomorrow 9am ET, rest split across 4 weekdays" so the
//     user knows what they're about to commit to before clicking Activate.
//
// Backend: POST /api/prospecting-campaigns/:id/bulk-activate
//          GET  /api/prospecting-campaigns/:id/schedule-preview?count=N

import React, { useState, useEffect } from 'react';
import { apiFetch } from './prospectingShared';

export default function BatchActivateModal({ campaign, readyCount, aiEnabled = true, onClose, onActivated }) {
  const [count,      setCount]      = useState(0);
  // runSkill defaults to the sequence's AI setting. When the sequence has AI
  // off there's nothing to run, so the toggle is forced off and hidden.
  const [runSkill,   setRunSkill]   = useState(aiEnabled !== false);
  // Default to enrolling everything — that's the workflow you said you want.
  // The slider in 'enrollAll' mode is read-only (showing readyCount) since
  // the count is implied by the toggle.
  // Mode: 'all' (enroll everything), 'today' (capped batch), 'pick' (choose
  // specific prospects). 'pick' fetches the eligible research-stage list and
  // sends an explicit prospectIds array to bulk-activate.
  const [mode, setMode] = useState('all');
  const [pickList,    setPickList]    = useState(null);   // null = not yet loaded
  const [pickLoading, setPickLoading] = useState(false);
  const [pickError,   setPickError]   = useState('');
  const [pickedIds,   setPickedIds]   = useState(() => new Set());
  const [cap,        setCap]        = useState(null);   // { orgCap, userTarget, effective }
  const [loading,    setLoading]    = useState(true);
  const [activating, setActivating] = useState(false);
  const [error,      setError]      = useState('');
  const [result,     setResult]     = useState(null);
  // Schedule preview: { count, summary, byDay, settings, channel }
  const [preview,        setPreview]        = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Load org/user caps via outreach-limits (also gives us the schedule defaults).
  useEffect(() => {
    (async () => {
      try {
        const r = await apiFetch('/prospecting-senders/org-limits');
        const orgCap = r?.linkedinReleaseCap || r?.limits?.linkedinReleaseCap
                    || r?.linkedinDailyActivationCap || r?.limits?.linkedinDailyActivationCap || 25;
        setCap({ orgCap, userTarget: null, effective: orgCap });
        // Initial count: if enrollAll, all ready prospects; else min(cap, ready).
        setCount(mode === 'all' ? (readyCount || 0) : Math.min(orgCap, readyCount || 0));
      } catch (err) {
        setCap({ orgCap: 25, userTarget: null, effective: 25 });
        setCount(mode === 'all' ? (readyCount || 0) : Math.min(25, readyCount || 0));
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyCount]);

  // When switching modes, reset count appropriately.
  useEffect(() => {
    if (!cap) return;
    if (mode === 'all') setCount(readyCount || 0);
    else if (mode === 'today') setCount(Math.min(cap.effective, readyCount || 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Fetch the eligible (research-stage) prospects the first time pick mode is
  // entered. Default selection = all of them; the rep deselects what they don't
  // want. Already-enrolled prospects, if any slip in, are skipped server-side.
  useEffect(() => {
    if (mode !== 'pick' || pickList !== null) return;
    setPickLoading(true);
    setPickError('');
    (async () => {
      try {
        const r = await apiFetch(`/prospects?campaignId=${campaign.id}&stage=research`);
        const list = r.prospects || [];
        setPickList(list);
        setPickedIds(new Set(list.map(p => p.id)));
      } catch (err) {
        setPickError(err.message || 'Failed to load prospects');
        setPickList([]);
      } finally {
        setPickLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // The count that actually drives the preview + activate button, per mode.
  const effectiveCount =
    mode === 'all'  ? (readyCount || 0) :
    mode === 'pick' ? pickedIds.size :
                      count;

  const togglePick = (id) => {
    setPickedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Debounced schedule preview fetch — runs when count changes. We use a
  // 250ms debounce so dragging the slider doesn't fire a request per pixel.
  useEffect(() => {
    if (loading || effectiveCount < 1) { setPreview(null); return; }
    setPreviewLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await apiFetch(`/prospecting-campaigns/${campaign.id}/schedule-preview?count=${effectiveCount}`);
        setPreview(r);
      } catch (err) {
        // Preview failure is non-fatal — the user can still activate.
        setPreview(null);
      } finally {
        setPreviewLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [effectiveCount, loading, campaign.id]);

  // Today's room for the first step's channel, from the live preview. Drives
  // the "Today's batch only" sizing. Falls back to the org cap pre-preview.
  const liveCap = preview?.capacity || null;
  const todayRoom = liveCap
    ? (liveCap.kind === 'email'
        ? (Number.isFinite(liveCap.todayRemaining) ? Math.max(0, liveCap.todayRemaining) : (readyCount || 0))
        : (liveCap.kind === 'linkedin' ? (liveCap.perDayFull || 0) : (readyCount || 0)))
    : (cap?.orgCap || 25);
  const todayMax = Math.max(1, Math.min(todayRoom || (readyCount || 1), Math.max(readyCount, 1)));

  const handleActivate = async () => {
    setActivating(true);
    setError('');
    try {
      const body =
        mode === 'pick' ? { prospectIds: [...pickedIds], runSkill }
      : mode === 'all'  ? { enrollAll: true, runSkill }
      :                   { count, runSkill };
      const r = await apiFetch(`/prospecting-campaigns/${campaign.id}/bulk-activate`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setResult(r);
    } catch (err) {
      setError(err.message || 'Activation failed');
    } finally {
      setActivating(false);
    }
  };

  return (
    <div className="pv-modal-overlay" onClick={onClose}>
      <div className="pv-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <div className="pv-modal-header">
          <h3>Activate batch</h3>
          <button className="pv-modal-close" onClick={onClose}>×</button>
        </div>

        <div className="pv-form" style={{ padding: 20 }}>
          {result ? (
            <ResultView result={result} onDone={() => { onActivated?.(result); onClose(); }} />
          ) : loading ? (
            <div className="pv-loading">Loading limits…</div>
          ) : (
            <>
              <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 14px' }}>
                Activate research-stage prospects in <strong>{campaign.name}</strong>. They will be enrolled in the
                campaign's default sequence (<em>{campaign.default_sequence_name || '— none —'}</em>) and Step 1 will
                land in the rep's inbox as a draft.
              </p>

              {/* Capacity info — derived from the live schedule preview. Email
                  capacity = Σ active sender daily limits; LinkedIn = soft
                  release cap; call/task = uncapped. */}
              {(() => {
                const capInfo = preview?.capacity || null;
                const ch = preview?.channel || 'email';
                return (
                  <div style={{
                    background: '#f8fafc', borderRadius: 6, padding: '8px 12px',
                    fontSize: 12, color: '#374151', marginBottom: 14, lineHeight: 1.6,
                  }}>
                    <div>📊 Ready in research stage: <strong>{readyCount}</strong></div>
                    {capInfo && capInfo.excluded && (
                      <div style={{ color: '#b45309' }}>
                        ⚠ No share % assigned — this campaign won't release in weighted mode.
                        Set its share in the campaign's sending schedule.
                      </div>
                    )}
                    {capInfo && capInfo.weighted && !capInfo.excluded && (
                      <div>⚖️ Weighted allocation: <strong>{capInfo.label}</strong>
                        {Number.isFinite(capInfo.todayRemaining) && <> · {capInfo.todayRemaining} left today</>}
                      </div>
                    )}
                    {capInfo && !capInfo.weighted && capInfo.kind === 'email' && (
                      <div>✉️ Email capacity: <strong>{capInfo.label}</strong>
                        {Number.isFinite(capInfo.todayRemaining) && capInfo.activeSenders > 0 &&
                          <> · {capInfo.todayRemaining} left today</>}
                      </div>
                    )}
                    {capInfo && !capInfo.weighted && capInfo.kind === 'linkedin' && (
                      <div>🔗 LinkedIn release cap: <strong>{capInfo.perDayFull}/day</strong> (sent manually)</div>
                    )}
                    {capInfo && !capInfo.weighted && capInfo.kind === 'uncapped' && (
                      <div>📅 No daily cap for {ch} — limited only by the active days/window</div>
                    )}
                    <div style={{ color: '#6b7280', fontSize: 11, marginTop: 4 }}>
                      {mode === 'all'
                        ? `Enrolling everything: ${readyCount} prospects pre-scheduled across days, respecting capacity.`
                        : mode === 'pick'
                          ? `Choosing specific prospects — ${pickedIds.size} selected.`
                          : `Today's batch only — the rest stay in research for later.`}
                    </div>
                  </div>
                );
              })()}

              {/* Mode toggle: enroll all · today's batch · choose prospects */}
              <div className="pv-form-section">
                <h4 style={{ marginBottom: 6 }}>Mode</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                    <input
                      type="radio"
                      checked={mode === 'all'}
                      onChange={() => setMode('all')}
                    />
                    <span>
                      <strong>Enroll all eligible</strong> ({readyCount} prospects)
                      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                        Pre-schedules everything. Daily cap controls how many fire each day.
                      </div>
                    </span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                    <input
                      type="radio"
                      checked={mode === 'today'}
                      onChange={() => setMode('today')}
                    />
                    <span>
                      <strong>Today's batch only</strong> (up to {todayMax})
                      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                        Manual control — you'll come back tomorrow to activate the next batch.
                      </div>
                    </span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                    <input
                      type="radio"
                      checked={mode === 'pick'}
                      onChange={() => setMode('pick')}
                    />
                    <span>
                      <strong>Choose prospects</strong>
                      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                        Pick exactly which research-ready prospects to activate.
                      </div>
                    </span>
                  </label>
                </div>
              </div>

              {/* Count input — only shown in 'Today's batch only' mode.
                  In enroll-all the count is implicit; in pick it's the tally. */}
              {mode === 'today' && (
                <div className="pv-form-section">
                  <h4>How many?</h4>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <input
                      type="range"
                      min={1}
                      max={todayMax}
                      value={count}
                      onChange={e => setCount(parseInt(e.target.value, 10))}
                      style={{ flex: 1 }}
                      disabled={readyCount === 0}
                    />
                    <input
                      type="number"
                      min={1}
                      max={todayMax}
                      value={count}
                      onChange={e => {
                        const v = parseInt(e.target.value, 10) || 0;
                        const max = todayMax;
                        setCount(Math.max(1, Math.min(max, v)));
                      }}
                      style={{
                        width: 60, fontSize: 13, padding: '4px 8px',
                        border: '1px solid #d1d5db', borderRadius: 5, textAlign: 'center',
                      }}
                      disabled={readyCount === 0}
                    />
                  </div>
                  {/* Only warn when today's *capacity* is the binding constraint
                      AND prospects genuinely spill to tomorrow. Maxing the slider
                      because the ready pool is smaller than capacity is not a cap
                      hit — readyCount(12) under todayRoom(100) must stay silent. */}
                  {todayRoom < readyCount && count >= todayRoom && (
                    <div style={{ fontSize: 11, color: '#92400e', marginTop: 6 }}>
                      ⚠ Hitting today's sending cap ({todayRoom}). The remaining {Math.max(0, readyCount - count)} will stay in research for tomorrow.
                    </div>
                  )}
                </div>
              )}

              {/* Prospect picker — choose exactly which to activate. */}
              {mode === 'pick' && (
                <div className="pv-form-section">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                    <h4 style={{ margin: 0 }}>Prospects</h4>
                    {pickList && pickList.length > 0 && (
                      <div style={{ display: 'flex', gap: 10, fontSize: 11 }}>
                        <button
                          type="button"
                          onClick={() => setPickedIds(new Set(pickList.map(p => p.id)))}
                          style={{ background: 'none', border: 'none', color: '#0F766E', cursor: 'pointer', fontWeight: 600 }}
                        >Select all</button>
                        <button
                          type="button"
                          onClick={() => setPickedIds(new Set())}
                          style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer' }}
                        >None</button>
                      </div>
                    )}
                  </div>

                  {pickLoading ? (
                    <div style={{ fontSize: 13, color: '#6b7280', padding: '10px 0' }}>Loading prospects…</div>
                  ) : pickError ? (
                    <div style={{ fontSize: 13, color: '#991b1b', padding: '8px 12px', background: '#fef2f2', borderRadius: 6 }}>
                      {pickError}
                    </div>
                  ) : (pickList && pickList.length === 0) ? (
                    <div style={{ fontSize: 13, color: '#9ca3af', padding: '10px 0' }}>
                      No research-stage prospects to activate.
                    </div>
                  ) : (
                    <div style={{
                      maxHeight: 220, overflowY: 'auto',
                      border: '1px solid #e5e7eb', borderRadius: 6,
                    }}>
                      {(pickList || []).map((p, i) => {
                        const checked = pickedIds.has(p.id);
                        return (
                          <label
                            key={p.id}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 10,
                              padding: '8px 10px', cursor: 'pointer',
                              borderBottom: i === pickList.length - 1 ? 'none' : '1px solid #f1f5f9',
                              background: checked ? '#f0fdfa' : 'transparent',
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => togglePick(p.id)}
                              style={{ cursor: 'pointer', flexShrink: 0 }}
                            />
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: 13, fontWeight: 600, color: '#1f2937' }}>
                                {p.first_name} {p.last_name}
                              </div>
                              <div style={{ fontSize: 11, color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {[p.title, p.company_name].filter(Boolean).join(' · ') || '—'}
                              </div>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 6 }}>
                    {pickedIds.size} of {pickList ? pickList.length : 0} selected
                  </div>
                </div>
              )}

              {/* Schedule preview — shows what's about to happen, per day. */}
              <SchedulePreview preview={preview} loading={previewLoading} count={effectiveCount} />

              {/* Skill toggle — only relevant when the sequence uses AI */}
              {aiEnabled && (
              <div className="pv-form-section">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={runSkill}
                    onChange={e => setRunSkill(e.target.checked)}
                  />
                  <span>
                    Run AI personalisation (outreach-personalization skill) per prospect
                  </span>
                </label>
                <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4, marginLeft: 22 }}>
                  Generates first email + LinkedIn note from each prospect's signal. Adds ~5s per prospect.
                </div>
              </div>
              )}

              {error && (
                <div style={{
                  color: '#991b1b', fontSize: 13, padding: '8px 12px',
                  background: '#fef2f2', borderRadius: 6, marginBottom: 12,
                }}>{error}</div>
              )}

              {/* Action bar */}
              <div className="pv-form-actions" style={{ marginTop: 16 }}>
                <button onClick={onClose} disabled={activating} className="pv-btn-secondary">Cancel</button>
                <button
                  onClick={handleActivate}
                  disabled={activating || readyCount === 0 || effectiveCount < 1}
                  className="pv-btn-primary"
                >
                  {activating
                    ? `Activating ${effectiveCount}…${runSkill ? ' (running skill)' : ''}`
                    : `Activate ${effectiveCount} ${effectiveCount === 1 ? 'prospect' : 'prospects'}`}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ResultView({ result, onDone }) {
  const skillProblems = result.enrollments.filter(e => !['ok', 'not_run'].includes(e.skillStatus));

  return (
    <div>
      <div style={{
        background: '#ecfdf5', border: '1px solid #a7f3d0', color: '#065f46',
        padding: '12px 14px', borderRadius: 8, fontSize: 14, marginBottom: 12,
      }}>
        ✓ Activated {result.activated} prospect{result.activated === 1 ? '' : 's'}
        <div style={{ fontSize: 12, marginTop: 4, color: '#047857' }}>
          Step 1 drafts will appear in the inbox within the next 15 minutes.
        </div>
      </div>

      {result.warning && (
        <div style={{
          background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e',
          padding: '10px 14px', borderRadius: 6, fontSize: 13, marginBottom: 12,
        }}>
          ⚠ {result.warning.message}
        </div>
      )}

      {result.skipped.length > 0 && (
        <div style={{
          background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e',
          padding: '10px 14px', borderRadius: 6, fontSize: 13, marginBottom: 12,
        }}>
          {result.skipped.length} prospect{result.skipped.length === 1 ? '' : 's'} skipped:
          <ul style={{ margin: '6px 0 0 18px', fontSize: 12 }}>
            {result.skipped.slice(0, 5).map((s, i) => (
              <li key={i}>Prospect {s.prospectId}: {s.reason}</li>
            ))}
            {result.skipped.length > 5 && <li>… and {result.skipped.length - 5} more</li>}
          </ul>
        </div>
      )}

      {skillProblems.length > 0 && (
        <div style={{
          background: '#fff7ed', border: '1px solid #fed7aa', color: '#9a3412',
          padding: '10px 14px', borderRadius: 6, fontSize: 12, marginBottom: 12,
        }}>
          {skillProblems.length} prospect{skillProblems.length === 1 ? '' : 's'} enrolled but skill personalisation failed —
          steps will fall back to sequence templates.
        </div>
      )}

      <div className="pv-form-actions" style={{ marginTop: 12 }}>
        <button className="pv-btn-primary" onClick={onDone}>Done</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SchedulePreview — renders the per-day breakdown from /:id/schedule-preview.
// Shows the user what they're about to commit to before clicking Activate.
// ─────────────────────────────────────────────────────────────────────────────
function SchedulePreview({ preview, loading, count }) {
  if (count < 1) return null;

  if (loading && !preview) {
    return (
      <div className="pv-form-section">
        <h4 style={{ marginBottom: 4 }}>Schedule preview</h4>
        <div style={{ fontSize: 12, color: '#9ca3af', padding: '8px 0' }}>
          Calculating…
        </div>
      </div>
    );
  }
  if (!preview || !preview.summary) return null;

  const { byDay, summary, channel, settings } = preview;
  const tz = settings?.sendWindowTimezone || 'America/New_York';
  // Show at most 6 days; collapse the rest into a "+N more" footer row.
  const visible = byDay.slice(0, 6);
  const hidden  = byDay.slice(6);

  return (
    <div className="pv-form-section">
      <h4 style={{ marginBottom: 4 }}>Schedule preview</h4>
      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 8 }}>
        {channel === 'email'
          ? (settings?.pacingMode === 'spread'
              ? `Emails spread across ${formatHour(settings.sendWindowStartHour)}–${formatHour(settings.sendWindowEndHour)} ${tzAbbrev(tz)}.`
              : `Emails sent every ${settings?.cadenceMinutes || 5} min from ${formatHour(settings.sendWindowStartHour)} ${tzAbbrev(tz)}.`)
          : (channel === 'linkedin'
              ? `LinkedIn tasks released from ${formatHour(settings.sendWindowStartHour)} ${tzAbbrev(tz)}; you send the requests manually.`
              : `${channel} tasks released from ${formatHour(settings.sendWindowStartHour)} ${tzAbbrev(tz)}; work them through the day.`)}
        {' '}First fires {fmtRelativeDateTime(summary.firstAt, tz)}; last fires {fmtRelativeDateTime(summary.lastAt, tz)}.
      </div>
      <div style={{
        background: '#f9fafb', border: '1px solid #f3f4f6', borderRadius: 6,
        padding: '8px 12px',
      }}>
        {visible.map(day => (
          <div
            key={day.date}
            style={{
              display: 'flex', justifyContent: 'space-between',
              alignItems: 'center', padding: '4px 0',
              borderBottom: '1px solid #f3f4f6', fontSize: 12,
            }}
          >
            <span style={{ color: '#374151' }}>{fmtDate(day.date, tz)}</span>
            <span style={{ color: '#6b7280' }}>
              {day.count} {day.count === 1 ? 'prospect' : 'prospects'}
              {' '}
              <span style={{ color: '#9ca3af', fontSize: 11 }}>
                ({fmtHM(day.firstAt, tz)}{day.firstAt !== day.lastAt ? `–${fmtHM(day.lastAt, tz)}` : ''})
              </span>
            </span>
          </div>
        ))}
        {hidden.length > 0 && (
          <div style={{
            fontSize: 11, color: '#9ca3af', padding: '6px 0 2px',
            fontStyle: 'italic',
          }}>
            …and {hidden.length} more day{hidden.length === 1 ? '' : 's'},
            ending {fmtDate(byDay[byDay.length - 1].date, tz)}.
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Date/time formatting helpers ─────────────────────────────────────────────
function formatHour(h) {
  if (h == null) return '—';
  if (h === 0)        return '12 AM';
  if (h < 12)         return `${h} AM`;
  if (h === 12)       return '12 PM';
  if (h === 24)       return '12 AM';
  return `${h - 12} PM`;
}
function tzAbbrev(tz) {
  // Best-effort abbreviation. Browser Intl gives us "EDT"/"EST"/"IST" etc.
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, timeZoneName: 'short',
    }).formatToParts(new Date());
    const tzPart = parts.find(p => p.type === 'timeZoneName');
    return tzPart?.value || tz;
  } catch (_) { return tz; }
}
function fmtDate(dayKey, tz) {
  // dayKey is 'YYYY-MM-DD' in the resolved tz. Format as "Mon, May 27".
  try {
    const [y, m, d] = dayKey.split('-').map(n => parseInt(n, 10));
    const dt = new Date(Date.UTC(y, m - 1, d, 12, 0));
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
    }).format(dt);
  } catch (_) { return dayKey; }
}
function fmtHM(iso, tz) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date(iso));
  } catch (_) { return iso; }
}
function fmtRelativeDateTime(iso, tz) {
  try {
    const dt   = new Date(iso);
    const now  = new Date();
    const diff = dt.getTime() - now.getTime();
    const hrs  = diff / (1000 * 60 * 60);
    const time = fmtHM(iso, tz);
    if (hrs < 1)  return `in ${Math.max(1, Math.round(hrs * 60))} min (${time} ${tzAbbrev(tz)})`;
    if (hrs < 24) return `today ${time} ${tzAbbrev(tz)}`;
    if (hrs < 48) return `tomorrow ${time} ${tzAbbrev(tz)}`;
    return `${fmtDate(iso.slice(0, 10), tz)} at ${time} ${tzAbbrev(tz)}`;
  } catch (_) { return iso; }
}
