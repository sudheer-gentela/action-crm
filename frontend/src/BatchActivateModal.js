// prospecting/BatchActivateModal.js
//
// Slice 2 — modal invoked from CampaignDetailDrawer. Activates a batch of
// research-stage prospects in the campaign's default sequence.
//
// Backend: POST /api/prospecting-campaigns/:id/bulk-activate
// Shows org cap + user target, lets rep adjust count, toggles skill personalisation.

import React, { useState, useEffect } from 'react';
import { apiFetch } from './prospectingShared';

export default function BatchActivateModal({ campaign, readyCount, onClose, onActivated }) {
  const [count,      setCount]      = useState(0);
  const [runSkill,   setRunSkill]   = useState(true);
  const [cap,        setCap]        = useState(null);   // { orgCap, userTarget, effective }
  const [loading,    setLoading]    = useState(true);
  const [activating, setActivating] = useState(false);
  const [error,      setError]      = useState('');
  const [result,     setResult]     = useState(null);

  // Load org/user caps via pacing endpoint sibling — easier path: hit a
  // throwaway bulk-activate with count=0 to read cap? No — we'll add a
  // small dedicated config-resolver fetch to outreach-limits.
  // For now, read from /prospecting-senders/org-limits (already exposed).
  useEffect(() => {
    (async () => {
      try {
        const r = await apiFetch('/prospecting-senders/org-limits');
        const orgCap = r?.linkedinDailyActivationCap || r?.limits?.linkedinDailyActivationCap || 25;
        // We don't currently expose userTarget on a public endpoint — surface orgCap only.
        // Effective = min(userTarget || orgCap, orgCap), so worst-case shown == orgCap.
        setCap({ orgCap, userTarget: null, effective: orgCap });
        setCount(Math.min(orgCap, readyCount || 0));
      } catch (err) {
        // Non-fatal: fall back to a sensible default.
        setCap({ orgCap: 25, userTarget: null, effective: 25 });
        setCount(Math.min(25, readyCount || 0));
      } finally {
        setLoading(false);
      }
    })();
  }, [readyCount]);

  const handleActivate = async () => {
    setActivating(true);
    setError('');
    try {
      const r = await apiFetch(`/prospecting-campaigns/${campaign.id}/bulk-activate`, {
        method: 'POST',
        body: JSON.stringify({ count, runSkill }),
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

              {/* Cap info */}
              <div style={{
                background: '#f8fafc', borderRadius: 6, padding: '8px 12px',
                fontSize: 12, color: '#374151', marginBottom: 14, lineHeight: 1.6,
              }}>
                <div>📊 Ready in research stage: <strong>{readyCount}</strong></div>
                <div>📋 Org daily LinkedIn cap: <strong>{cap.orgCap}</strong></div>
                <div style={{ color: '#6b7280', fontSize: 11, marginTop: 4 }}>
                  Effective cap for this batch: <strong>{cap.effective}</strong> (org ceiling). Activate in batches; pace yourself.
                </div>
              </div>

              {/* Count slider */}
              <div className="pv-form-section">
                <h4>How many?</h4>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <input
                    type="range"
                    min={1}
                    max={Math.min(cap.effective, Math.max(readyCount, 1))}
                    value={count}
                    onChange={e => setCount(parseInt(e.target.value, 10))}
                    style={{ flex: 1 }}
                    disabled={readyCount === 0}
                  />
                  <input
                    type="number"
                    min={1}
                    max={Math.min(cap.effective, Math.max(readyCount, 1))}
                    value={count}
                    onChange={e => {
                      const v = parseInt(e.target.value, 10) || 0;
                      const max = Math.min(cap.effective, Math.max(readyCount, 1));
                      setCount(Math.max(1, Math.min(max, v)));
                    }}
                    style={{
                      width: 60, fontSize: 13, padding: '4px 8px',
                      border: '1px solid #d1d5db', borderRadius: 5, textAlign: 'center',
                    }}
                    disabled={readyCount === 0}
                  />
                </div>
                {count >= cap.effective && (
                  <div style={{ fontSize: 11, color: '#92400e', marginTop: 6 }}>
                    ⚠ Hitting the daily cap. Save the rest for tomorrow.
                  </div>
                )}
              </div>

              {/* Skill toggle */}
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
                  disabled={activating || readyCount === 0 || count < 1}
                  className="pv-btn-primary"
                >
                  {activating
                    ? `Activating ${count}…${runSkill ? ' (running skill)' : ''}`
                    : `Activate ${count} ${count === 1 ? 'prospect' : 'prospects'}`}
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
  const allSkillOk    = result.enrollments.every(e => e.skillStatus === 'ok' || e.skillStatus === 'not_run');
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
