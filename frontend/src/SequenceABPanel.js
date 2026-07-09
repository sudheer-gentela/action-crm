/**
 * SequenceABPanel.js   (2026_47)
 *
 * DROP-IN LOCATION: frontend/src/SequenceABPanel.js
 *
 * Step-level A/B variants, scoped to an experiment. Rendered inside
 * SequenceBuilder, below the steps list.
 *
 * Deliberately self-contained: it owns its own fetches and state and touches
 * nothing SequenceBuilder owns. In particular it stays OUT of the builder's
 * `stateSnapshot` dirty-diff — variants are written straight to the API on
 * click, they are not part of the sequence's Save Changes payload. Mixing them
 * in would make "Save Changes" light up whenever you nudged a weight slider,
 * and would let an unsaved reorder silently rewrite arm content.
 *
 * Consequences the UI has to be honest about:
 *   - Variants attach to a SAVED step id. In create mode (no sequence yet) and
 *     for freshly-added unsaved steps, the panel says so and offers nothing.
 *   - AI sequences are refused server-side (422 AB_AI_SEQUENCE). We grey the
 *     panel out rather than let the user discover that by clicking.
 *   - Editing arm copy while prospects are live in the test invalidates the
 *     result. The server 409s with AB_MID_TEST_EDIT; we surface the count and
 *     make the user confirm rather than silently retrying with the override.
 *   - Concluding does NOT delete arms. Enrollments mid-cadence keep the
 *     treatment they were randomised into until they finish. The panel says how
 *     many those are, because a rep will otherwise expect the new copy to take
 *     effect immediately.
 *   - Results are scoped by experiment_id, not by a date window. A second test
 *     on the same step reuses arm names A/B; only the id tells them apart.
 *
 * Props:
 *   sequenceId   — number | null   (null in create mode)
 *   steps        — the builder's live step array (needs .id and .channel)
 *   aiEnabled    — boolean, the sequence's ai_enabled toggle
 *   apiFetch     — the builder's fetch helper (path is '/sequences/...')
 */

import React, { useState, useEffect, useCallback } from 'react';

const TEAL       = '#0F9D8E';
const TEAL_LIGHT = '#e6f7f6';
const AMBER      = '#b45309';
const AMBER_BG   = '#fffbeb';

const VARIABLE_CHANNELS = ['email', 'linkedin'];

const CHANNEL_LABEL = { email: '✉️ Email', linkedin: '🔗 LinkedIn', call: '📞 Call', task: '📋 Task' };

const box = {
  border: '1px solid #e5e7eb', borderRadius: 10, background: '#fff', padding: 14,
};
const label = { fontSize: 11, color: '#6b7280', marginBottom: 4 };
const input = {
  width: '100%', padding: '8px 10px', borderRadius: 6,
  border: '1px solid #e5e7eb', fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box',
};

function pct(n) {
  return n == null ? '—' : `${(n * 100).toFixed(1)}%`;
}

export default function SequenceABPanel({ sequenceId, steps, aiEnabled, apiFetch }) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');
  const [busy,    setBusy]    = useState(false);
  const [results, setResults] = useState(null);
  const [history, setHistory] = useState([]);
  const [viewExp, setViewExp] = useState('');   // '' = running / most recent
  const [concluding, setConcluding] = useState(false);
  const [winner,  setWinner]  = useState('');
  const [promote, setPromote] = useState(true);

  const load = useCallback(async () => {
    if (!sequenceId) return;
    setLoading(true); setError('');
    try {
      setData(await apiFetch(`/sequences/${sequenceId}/variants`));
    } catch (e) {
      setError(e.message || 'Could not load variants');
    } finally {
      setLoading(false);
    }
  }, [sequenceId, apiFetch]);

  const loadHistory = useCallback(async () => {
    if (!sequenceId) return;
    try {
      const r = await apiFetch(`/sequences/${sequenceId}/experiments`);
      setHistory(r.experiments || []);
    } catch { /* history is decoration; never block the panel on it */ }
  }, [sequenceId, apiFetch]);

  useEffect(() => { load(); loadHistory(); }, [load, loadHistory]);

  // ── Create ─────────────────────────────────────────────────────────────────
  // The server seeds arm A from the step's current copy and creates B, so a step
  // never sits in the half-varied state where one arm exists and base copy still
  // silently wins.
  const startTest = async (stepId) => {
    setBusy(true); setError('');
    try {
      await apiFetch(`/sequences/${sequenceId}/steps/${stepId}/variants`, {
        method: 'POST',
        body: JSON.stringify({ variant_key: 'B', weight: 50 }),
      });
      await load();
    } catch (e) {
      setError(e.message || 'Could not start test');
    } finally {
      setBusy(false);
    }
  };

  // ── Update ─────────────────────────────────────────────────────────────────
  // `confirm` is only ever sent after the user has seen the enrolled count and
  // explicitly agreed. We never pre-set it.
  const saveArm = async (variantId, patch, confirm = false) => {
    setBusy(true); setError('');
    try {
      await apiFetch(`/sequences/${sequenceId}/variants/${variantId}`, {
        method: 'PUT',
        body: JSON.stringify(confirm ? { ...patch, confirmMidTestEdit: true } : patch),
      });
      await load();
    } catch (e) {
      if (/live in this experiment/i.test(e.message)) {
        const ok = window.confirm(
          `${e.message}\n\nEdit anyway? The results for this test will mix two treatments.`
        );
        if (ok) return saveArm(variantId, patch, true);
      } else {
        setError(e.message || 'Could not save');
      }
    } finally {
      setBusy(false);
    }
  };

  const removeArm = async (variantId) => {
    if (!window.confirm('Remove this arm? If fewer than 2 arms remain, the step un-varies and live enrollments fall back to the base step copy.')) return;
    setBusy(true); setError('');
    try {
      const r = await apiFetch(`/sequences/${sequenceId}/variants/${variantId}`, { method: 'DELETE' });
      if (r.warning) setError(r.warning);
      await load();
    } catch (e) {
      setError(e.message || 'Could not remove arm');
    } finally {
      setBusy(false);
    }
  };

  const loadResults = useCallback(async (expId) => {
    setBusy(true); setError('');
    try {
      const q = expId ? `?experimentId=${encodeURIComponent(expId)}` : '';
      setResults(await apiFetch(`/sequences/${sequenceId}/experiment${q}`));
    } catch (e) {
      setError(e.message || 'Could not load results');
    } finally {
      setBusy(false);
    }
  }, [sequenceId, apiFetch]);

  // Concluding freezes the arms and stops new enrollments landing in them.
  // promoteWinner copies the winning copy into the base step so future
  // enrollments — which carry no arm — send it by default.
  const conclude = async (expId, abandon = false) => {
    if (!abandon && !winner) { setError('Pick a winning arm, or abandon the test.'); return; }
    const verb = abandon ? 'Abandon' : 'Conclude';
    if (!window.confirm(
      `${verb} this experiment?\n\nArms are kept, not deleted — prospects already mid-cadence ` +
      `keep the copy they were randomised into until they finish. ` +
      (abandon ? '' : promote ? `Arm ${winner}'s copy will be written into the step for future enrollments.` : '')
    )) return;

    setBusy(true); setError('');
    try {
      const r = await apiFetch(`/sequences/${sequenceId}/experiments/${expId}/conclude`, {
        method: 'POST',
        body: JSON.stringify(abandon
          ? { abandon: true }
          : { winningVariantKey: winner, promoteWinner: promote }),
      });
      if (r.note) setError(r.note);
      setConcluding(false); setWinner('');
      await load(); await loadHistory();
    } catch (e) {
      setError(e.message || 'Could not conclude');
    } finally {
      setBusy(false);
    }
  };

  // ── Gates ──────────────────────────────────────────────────────────────────

  if (!sequenceId) {
    return (
      <div style={{ ...box, background: '#fafafa' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 4 }}>A/B test</div>
        <div style={{ fontSize: 12, color: '#6b7280' }}>
          Save the sequence first. Arms attach to a saved step.
        </div>
      </div>
    );
  }

  if (aiEnabled) {
    return (
      <div style={{ ...box, background: AMBER_BG, borderColor: '#fcd34d' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 4 }}>A/B test</div>
        <div style={{ fontSize: 12, color: AMBER, lineHeight: 1.6 }}>
          Not available while AI personalisation is on. The AI rewrites the body from the step
          template — it would bypass the arm, and strong personalisation converges the arms so the
          effect you are trying to measure washes out. Turn AI off on this sequence to run a copy test.
        </div>
      </div>
    );
  }

  const experiment     = data?.experiment || null;
  const variantsByStep = data?.variantsByStep || {};
  const variedIds      = new Set(data?.variedStepIds || []);
  const remaining      = data?.variedStepsRemaining ?? 0;
  const testIsLive     = !!data?.testIsLive;
  const enrolled       = data?.enrolledInTest ?? 0;

  // Only saved steps on a deliverable channel can be varied. A call/task step's
  // task_note is an instruction to a rep, never sent to the prospect.
  const eligible = steps.filter(s => s.id && VARIABLE_CHANNELS.includes(s.channel));

  return (
    <div style={{ ...box }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>A/B test</div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
            {loading ? 'Loading…'
              : testIsLive
                ? `${experiment?.name || `Experiment #${experiment?.id}`} · ${variedIds.size} of ${data.maxVariedSteps} step${data.maxVariedSteps !== 1 ? 's' : ''} varied · ${enrolled} prospect${enrolled !== 1 ? 's' : ''} in test`
                : history.length
                  ? `No test running · ${history.length} past experiment${history.length !== 1 ? 's' : ''}`
                  : 'No test running'}
          </div>
        </div>
        {testIsLive && (
          <span style={{
            fontSize: 11, padding: '3px 9px', borderRadius: 6,
            background: TEAL_LIGHT, color: '#0d8a7c', fontWeight: 600,
          }}>A/B</span>
        )}
      </div>

      {error && (
        <div style={{
          padding: '8px 10px', borderRadius: 6, marginBottom: 10,
          background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', fontSize: 12,
        }}>{error}</div>
      )}

      {/* Assignment is a pure hash of (sequence_id, prospect_id). Say so — reps
          will otherwise ask why they cannot hand-pick who sees which arm. */}
      <div style={{ fontSize: 11, color: '#6b7280', lineHeight: 1.6, marginBottom: 12 }}>
        Prospects are split by a hash of their id — you set the percentage, not the people.
        Re-enrolling never moves a prospect between arms within one experiment, and each new
        experiment reshuffles the pool. Prospects already enrolled when you start a test keep the
        base copy and are excluded from it. Admins can pin one prospect to a named arm by passing
        <code>variantKeyOverride</code> to <code>POST /api/sequences/enroll</code> — a known bias,
        for inspecting copy, not for steering a test.
      </div>

      {eligible.length === 0 && (
        <div style={{ fontSize: 12, color: '#6b7280' }}>
          No eligible steps. Only saved email and LinkedIn steps can be varied.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {eligible.map((step, i) => {
          const arms      = variantsByStep[step.id] || [];
          const isVaried  = variedIds.has(step.id);
          const canStart  = !isVaried && remaining > 0;

          return (
            <div key={step.id} style={{
              border: `1px solid ${isVaried ? TEAL : '#e5e7eb'}`,
              borderRadius: 8, padding: 12,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: isVaried ? 10 : 0 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>
                  Step {i + 1} · {CHANNEL_LABEL[step.channel]}
                </span>
                <span style={{ marginLeft: 'auto' }}>
                  {isVaried ? (
                    <span style={{ fontSize: 11, color: '#0d8a7c', fontWeight: 600 }}>{arms.length} arms</span>
                  ) : canStart ? (
                    <button
                      onClick={() => startTest(step.id)}
                      disabled={busy}
                      style={{
                        fontSize: 12, padding: '5px 12px', borderRadius: 6,
                        border: 'none', background: TEAL, color: '#fff',
                        fontWeight: 600, cursor: busy ? 'wait' : 'pointer',
                      }}
                    >+ Start A/B test</button>
                  ) : (
                    <span style={{ fontSize: 11, color: '#9ca3af' }}>Cap reached</span>
                  )}
                </span>
              </div>

              {isVaried && (
                <ArmEditor
                  arms={arms}
                  busy={busy}
                  channel={step.channel}
                  onSave={saveArm}
                  onRemove={removeArm}
                />
              )}
            </div>
          );
        })}
      </div>

      {!testIsLive && remaining === 0 && eligible.length > 0 && (
        <div style={{
          marginTop: 10, padding: '8px 10px', borderRadius: 6,
          background: AMBER_BG, border: '1px solid #fde68a', color: AMBER, fontSize: 11, lineHeight: 1.6,
        }}>
          Cap reached. Arms are sequence-wide, so varying a second step would tell you which arm
          won, not which step. Raise <code>sequences.ab_max_varied_steps</code> only if that is what
          you want.
        </div>
      )}

      {/* ── Conclude ────────────────────────────────────────────────────────── */}
      {testIsLive && experiment && (
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #f3f4f6' }}>
          {!concluding ? (
            <button
              onClick={() => setConcluding(true)} disabled={busy}
              style={{
                fontSize: 12, padding: '6px 12px', borderRadius: 6,
                border: '1px solid #e5e7eb', background: '#fff', color: '#374151',
                fontWeight: 600, cursor: busy ? 'wait' : 'pointer',
              }}
            >Conclude experiment</button>
          ) : (
            <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#111827', marginBottom: 8 }}>
                Conclude “{experiment.name || `Experiment #${experiment.id}`}”
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: '#6b7280' }}>Winner</span>
                <select
                  value={winner} onChange={e => setWinner(e.target.value)}
                  style={{ ...input, width: 90, padding: '5px 8px' }}
                >
                  <option value="">—</option>
                  {arms.map(a => <option key={a.variant_key} value={a.variant_key}>Arm {a.variant_key}</option>)}
                </select>
                <label style={{ fontSize: 12, color: '#374151', display: 'flex', alignItems: 'center', gap: 5 }}>
                  <input type="checkbox" checked={promote} onChange={e => setPromote(e.target.checked)} />
                  Write winner’s copy into the step
                </label>
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                  <button
                    onClick={() => conclude(experiment.id, false)} disabled={busy}
                    style={{ fontSize: 12, padding: '6px 12px', borderRadius: 6, border: 'none', background: TEAL, color: '#fff', fontWeight: 600, cursor: 'pointer' }}
                  >Conclude</button>
                  <button
                    onClick={() => conclude(experiment.id, true)} disabled={busy}
                    style={{ fontSize: 12, padding: '6px 12px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', color: '#6b7280', cursor: 'pointer' }}
                  >Abandon</button>
                  <button
                    onClick={() => { setConcluding(false); setWinner(''); }}
                    style={{ fontSize: 12, padding: '6px 10px', borderRadius: 6, border: 'none', background: 'transparent', color: '#9ca3af', cursor: 'pointer' }}
                  >Cancel</button>
                </span>
              </div>
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 8, lineHeight: 1.6 }}>
                Arms are kept, not deleted. The {enrolled} prospect{enrolled !== 1 ? 's' : ''} still mid-cadence
                keep the copy they were randomised into — treatment is never switched under a prospect.
                New enrollments carry no arm and use the base step copy.
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Results ─────────────────────────────────────────────────────────── */}
      {(testIsLive || history.length > 0) && (
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #f3f4f6' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>Results</span>
            <select
              value={viewExp} onChange={e => setViewExp(e.target.value)}
              style={{ ...input, width: 260, padding: '5px 8px' }}
            >
              <option value="">Running / most recent</option>
              {history.map(h => (
                <option key={h.id} value={h.id}>
                  #{h.id} {h.name || '(unnamed)'} · {h.status}
                  {h.winning_variant_key ? ` · won ${h.winning_variant_key}` : ''}
                  {` · ${h.enrolled} enrolled`}
                </option>
              ))}
            </select>
            <button
              onClick={() => loadResults(viewExp)} disabled={busy}
              style={{
                fontSize: 12, padding: '6px 12px', borderRadius: 6,
                border: '1px solid #e5e7eb', background: '#fff',
                cursor: busy ? 'wait' : 'pointer', fontWeight: 600, color: '#374151',
              }}
            >Load</button>
          </div>

          {results && <Results results={results} />}
        </div>
      )}

    </div>
  );
}

// ── Arm editor ───────────────────────────────────────────────────────────────
// Weight is edited on arm A only when there are exactly 2 arms; B mirrors it.
// With 3+ arms each carries its own number input — no implicit complement.

function ArmEditor({ arms, busy, channel, onSave, onRemove }) {
  const [draft, setDraft] = useState({});
  const twoArm = arms.length === 2;

  const val = (a, f) => (draft[a.id]?.[f] ?? a[f] ?? '');
  const set = (a, f, v) => setDraft(d => ({ ...d, [a.id]: { ...(d[a.id] || {}), [f]: v } }));
  const dirty = (a) => {
    const d = draft[a.id];
    if (!d) return false;
    return Object.keys(d).some(k => (d[k] ?? '') !== (a[k] ?? ''));
  };

  const commit = async (a) => {
    const d = draft[a.id];
    if (!d) return;
    await onSave(a.id, d);
    setDraft(x => { const n = { ...x }; delete n[a.id]; return n; });
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(arms.length, 2)}, minmax(0, 1fr))`, gap: 10 }}>
      {arms.map((a, i) => (
        <div key={a.id} style={{ border: '1px solid #f3f4f6', borderRadius: 6, padding: 10, background: '#fcfcfc' }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#111827' }}>
              Arm {a.variant_key}{i === 0 ? ' · control' : ''}
            </span>
            {a.status === 'paused' && (
              <span style={{ marginLeft: 6, fontSize: 10, color: AMBER }}>paused</span>
            )}
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <button
                onClick={() => onSave(a.id, { status: a.status === 'active' ? 'paused' : 'active' })}
                disabled={busy}
                title="Pausing an arm stops new enrollments landing in it. Weight and status changes never need mid-test confirmation."
                style={{ fontSize: 11, padding: '3px 8px', borderRadius: 5, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer' }}
              >{a.status === 'active' ? 'Pause' : 'Resume'}</button>
              <button
                onClick={() => onRemove(a.id)} disabled={busy}
                style={{ fontSize: 11, padding: '3px 8px', borderRadius: 5, border: '1px solid #fecaca', background: '#fff', color: '#b91c1c', cursor: 'pointer' }}
              >Remove</button>
            </span>
          </div>

          {channel === 'email' && (
            <>
              <div style={label}>Subject</div>
              <input
                style={{ ...input, marginBottom: 8 }}
                value={val(a, 'subject_template')}
                onChange={e => set(a, 'subject_template', e.target.value)}
              />
            </>
          )}

          <div style={label}>{channel === 'linkedin' ? 'Note / message' : 'Body'}</div>
          <textarea
            rows={channel === 'linkedin' ? 3 : 5}
            style={{ ...input, resize: 'vertical', marginBottom: 8 }}
            value={val(a, 'body_template')}
            onChange={e => set(a, 'body_template', e.target.value)}
          />
          {channel === 'linkedin' && (
            <div style={{ fontSize: 10, color: '#9ca3af', marginTop: -4, marginBottom: 8 }}>
              Connection notes cap at 300 characters.
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ ...label, marginBottom: 0 }}>Weight</span>
            <input
              type="number" min={0} max={100}
              style={{ ...input, width: 70, padding: '5px 8px' }}
              value={val(a, 'weight')}
              disabled={twoArm && i === 1}
              onChange={e => {
                const w = Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0));
                set(a, 'weight', w);
                if (twoArm && i === 0) set(arms[1], 'weight', 100 - w);
              }}
            />
            <span style={{ fontSize: 11, color: '#9ca3af' }}>%</span>
            {dirty(a) && (
              <button
                onClick={() => commit(a)} disabled={busy}
                style={{
                  marginLeft: 'auto', fontSize: 11, padding: '4px 10px', borderRadius: 5,
                  border: 'none', background: TEAL, color: '#fff', fontWeight: 600,
                  cursor: busy ? 'wait' : 'pointer',
                }}
              >Save arm</button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Results ──────────────────────────────────────────────────────────────────
// Raw counts only. No significance test is computed anywhere in the stack —
// showing a "winner" off 40 sends would be worse than showing nothing.

function Results({ results }) {
  const exp   = results.experiment;
  const arms  = results.arms || [];
  const steps = results.steps || [];
  const liSteps = steps.filter(s => s.channel === 'linkedin');
  const underpowered = arms.some(a => a.enrolled < 300);

  if (!exp) return <div style={{ fontSize: 12, color: '#9ca3af' }}>No experiment on this sequence yet.</div>;

  return (
    <div>
      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6 }}>
        #{exp.id} {exp.name || '(unnamed)'} · {exp.status}
        {exp.winning_variant_key ? ` · declared winner ${exp.winning_variant_key}` : ''}
      </div>
      <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ color: '#6b7280', textAlign: 'left' }}>
            <th style={{ padding: '4px 0', fontWeight: 500 }}>Arm</th>
            <th style={{ fontWeight: 500 }}>Enrolled</th>
            <th style={{ fontWeight: 500 }}>Still active</th>
            <th style={{ fontWeight: 500 }}>Replied</th>
            <th style={{ fontWeight: 500 }}>Reply rate</th>
          </tr>
        </thead>
        <tbody>
          {arms.map(a => (
            <tr key={a.variant_key} style={{ borderTop: '1px solid #f3f4f6' }}>
              <td style={{ padding: '6px 0', fontWeight: 600 }}>{a.variant_key}</td>
              <td>{a.enrolled}</td>
              <td style={{ color: '#9ca3af' }}>{a.still_active}</td>
              <td>{a.replied}</td>
              <td style={{ fontWeight: 600 }}>{pct(a.reply_rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {liSteps.length > 0 && (
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', marginTop: 12 }}>
          <thead>
            <tr style={{ color: '#6b7280', textAlign: 'left' }}>
              <th style={{ padding: '4px 0', fontWeight: 500 }}>LinkedIn arm</th>
              <th style={{ fontWeight: 500 }}>Sent</th>
              <th style={{ fontWeight: 500 }}>Accepted</th>
              <th style={{ fontWeight: 500 }}>Accept rate</th>
            </tr>
          </thead>
          <tbody>
            {liSteps.map(s => (
              <tr key={`${s.sequence_step_id}-${s.variant_key}`} style={{ borderTop: '1px solid #f3f4f6' }}>
                <td style={{ padding: '6px 0', fontWeight: 600 }}>
                  Step {s.step_order} · {s.variant_key}
                </td>
                <td>{s.sent}</td>
                <td>{s.li_accepted}</td>
                <td style={{ fontWeight: 600 }}>{pct(s.li_accept_rate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{
        marginTop: 12, padding: '8px 10px', borderRadius: 6,
        background: '#f9fafb', border: '1px solid #f3f4f6',
        fontSize: 11, color: '#6b7280', lineHeight: 1.7,
      }}>
        {underpowered && (
          <div style={{ color: AMBER, fontWeight: 600, marginBottom: 4 }}>
            Too early to call. Detecting a 3% → 5% lift needs roughly 1,300 enrollments per arm.
          </div>
        )}
        {(results.notes || []).map((n, i) => <div key={i}>· {n}</div>)}
        <div>· Reply rate is a lower bound while enrollments are still active.</div>
        <div>· No significance test is computed. Do not stop early on a peek.</div>
      </div>
    </div>
  );
}
