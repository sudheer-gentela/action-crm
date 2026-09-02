// ─────────────────────────────────────────────────────────────────────────────
// ProjectPlanVsActual.js — plan vs actual for one project (2026_111)
//
// Reads GET /handovers/sales/:id/variance. Three numbers that are easy to
// conflate are kept visually distinct:
//
//   vs BASELINE     total slip against what was originally committed
//   vs CURRENT DUE  forecast accuracy against the most recent promise
//   REVISIONS       how many times the date moved at all
//
// The last one matters because a play moved once by 30 days and a play moved
// six times by 5 days have identical baseline variance and are completely
// different situations.
//
// Deliberate display choices:
//   • Open plays show a live variance measured against today, not a blank.
//     Only counting completed work hides the slippage a PM needs to act on.
//   • Ad-hoc plays show "—" for baseline. They were never in the plan, and
//     scoring them against it would make every project look worse than it was.
//   • A re-baselined play is badged. If a reset silently moved the number the
//     report would launder bad news.
//   • When any baseline is 'inferred' the header says so. Those were
//     back-filled from the then-current due date, so the slip shown is a
//     floor, not the real figure.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';

const C = {
  late:    '#b91c1c',
  early:   '#047857',
  neutral: '#6b7280',
  warn:    '#b45309',
  warnBg:  '#fef3c7',
  line:    '#e5e7eb',
  head:    '#374151',
};

function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: '2-digit' });
}

// 2026_136. Matches UNTOUCHED_DAYS in planVariance.service.js, which computes
// the summary count from the same rule. Two numbers that disagree would put a
// task in the "untouched" headline while its own row read as fresh.
const UNTOUCHED_DAYS = 7;

/**
 * Has this task gone quiet?
 *
 * lastLoggedDate is an entry_date — the owner's local calendar date, already a
 * plain YYYY-MM-DD string. Parsed as UTC on purpose: `new Date('2026-06-15')`
 * is midnight UTC but `new Date('2026-06-15T00:00:00')` is midnight local, and
 * mixing the two is how a task logged this morning reads as logged yesterday
 * for everyone east of Greenwich.
 */
function isStale(lastLoggedDate) {
  if (!lastLoggedDate) return true;
  const at = Date.parse(`${lastLoggedDate}T00:00:00Z`);
  if (Number.isNaN(at)) return false;
  return at < Date.now() - UNTOUCHED_DAYS * 86400000;
}

// Variance is rendered as a signed day count. Zero is "on time", not "no data"
// — the distinction is why null and 0 are handled separately everywhere here.
function Variance({ days, open }) {
  if (days === null || days === undefined) {
    return <span style={{ color: C.neutral }}>—</span>;
  }
  const colour = days > 0 ? C.late : (days < 0 ? C.early : C.neutral);
  const sign   = days > 0 ? '+' : '';
  return (
    <span style={{ color: colour, fontWeight: days === 0 ? 400 : 600, whiteSpace: 'nowrap' }}>
      {sign}{days}d{open && days > 0 ? ' ↑' : ''}
    </span>
  );
}

function Metric({ label, value, suffix, tone }) {
  return (
    <div style={{ background: '#f9fafb', borderRadius: 8, padding: '12px 14px', minWidth: 132, flex: '1 1 132px' }}>
      <div style={{ fontSize: 11, color: C.neutral, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color: tone || '#111827' }}>
        {value === null || value === undefined ? '—' : value}
        {value !== null && value !== undefined && suffix
          ? <span style={{ fontSize: 13, fontWeight: 400, color: C.neutral }}>{suffix}</span>
          : null}
      </div>
    </div>
  );
}

export default function ProjectPlanVsActual({ handoverId }) {
  const [state,   setState]   = useState({ loading: true, error: null, data: null });
  const [openRow, setOpenRow] = useState(null);
  const [detail,  setDetail]  = useState({});   // instanceId -> { revisions, evidence, loading }

  const load = useCallback(async () => {
    setState(s => ({ ...s, loading: true, error: null }));
    try {
      // apiService is raw axios with NO response interceptor, so the payload
      // is at r.data — every other caller in this codebase does the same.
      const r = await apiService.handovers.variance(handoverId);
      setState({ loading: false, error: null, data: r.data });
    } catch (err) {
      setState({ loading: false, error: err.message || 'Could not load plan vs actual', data: null });
    }
  }, [handoverId]);

  useEffect(() => { load(); }, [load]);

  // Row detail is fetched on expand rather than up front: two extra queries per
  // play across a 200-play project is not worth paying for rows nobody opens.
  const expand = async (playId) => {
    if (openRow === playId) { setOpenRow(null); return; }
    setOpenRow(playId);
    if (detail[playId]) return;

    setDetail(d => ({ ...d, [playId]: { loading: true } }));
    try {
      const [rev, ev, notes] = await Promise.all([
        apiService.handovers.playRevisions(handoverId, playId),
        apiService.handovers.playEvidence(handoverId, playId),
        // 2026_120. Non-fatal on its own: a project whose notes fail to load
        // should still show its date history rather than an error screen.
        apiService.handovers.playNotes(handoverId, playId).catch(() => ({ data: { notes: [] } })),
      ]);
      setDetail(d => ({
        ...d,
        [playId]: { loading: false,
                    revisions: rev.data?.revisions || [],
                    evidence:  ev.data?.evidence  || [],
                    notes:     notes.data?.notes  || [] },
      }));
    } catch (err) {
      setDetail(d => ({ ...d, [playId]: { loading: false, error: err.message } }));
    }
  };

  if (state.loading) {
    return <div style={{ padding: 20, fontSize: 13, color: C.neutral }}>Loading plan vs actual…</div>;
  }
  if (state.error) {
    return (
      <div style={{ padding: 20 }}>
        <div style={{ background: '#fee2e2', color: '#991b1b', padding: '8px 12px', borderRadius: 6, fontSize: 13 }}>
          {state.error}
        </div>
        <button onClick={load} style={{ marginTop: 10, fontSize: 12, padding: '5px 10px', cursor: 'pointer' }}>Retry</button>
      </div>
    );
  }

  // Defaults are applied per KEY, not with a single fallback object. The old
  // `state.data || {...}` only helped when data was null — a 200 response whose
  // shape differed still yielded plays === undefined and crashed the render on
  // .length. A screen should degrade to an empty state, never white-screen.
  const summary = (state.data && state.data.summary) || {};
  const plays   = Array.isArray(state.data && state.data.plays) ? state.data.plays : [];

  if (!plays.length) {
    return (
      <div style={{ padding: 20, fontSize: 13, color: C.neutral }}>
        This project has no plays yet, so there is nothing to compare against a plan.
        Attach a playbook to generate its checklist.
      </div>
    );
  }

  return (
    <div style={{ padding: '16px 20px 28px' }}>

      {/* Headline numbers */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <Metric label="On time vs baseline" value={summary.onTimePct} suffix="%" />
        <Metric label="Average slip"
                value={summary.avgSlipDays ? `+${summary.avgSlipDays}` : (summary.lateCount ? summary.avgSlipDays : 0)}
                suffix="d"
                tone={summary.avgSlipDays > 0 ? C.late : undefined} />
        <Metric label="Open and overdue" value={summary.openOverdue}
                tone={summary.openOverdue > 0 ? C.late : undefined} />
        {/* 2026_136. The subset of those that nobody has logged work against
            in the last week. Shown only when it is non-zero: on a project
            where everything overdue is actively being worked, a permanent
            zero here is a tile that never says anything. */}
        {summary.openOverdueUntouched > 0 && (
          <Metric label={`Overdue, untouched ${UNTOUCHED_DAYS}d`}
                  value={summary.openOverdueUntouched} tone={C.late} />
        )}
        <Metric label="Date revisions" value={summary.totalRevisions} />
        <Metric label="Re-baselined" value={summary.rebaselined}
                tone={summary.rebaselined > 0 ? C.warn : undefined} />
        {/* 2026_120. Shown only once something has actually slipped —
            "0/0 explained" on a project running to plan is a number that
            invites worry about nothing. The gap between the two figures is
            the agenda for the next project review. */}
        {summary.lateCount > 0 && (
          <Metric label="Slips explained"
                  value={`${summary.lateWithNotes ?? 0}/${summary.lateCount}`}
                  tone={(summary.lateWithNotes ?? 0) < summary.lateCount ? C.warn : C.early} />
        )}
      </div>

      {/* Data-quality caveat. Carried from the API rather than assumed, and shown
          only when it applies — a permanent banner gets ignored. */}
      {summary.inferredBaselines > 0 && (
        <div style={{ background: C.warnBg, color: '#78350f', borderRadius: 6,
                      padding: '8px 12px', fontSize: 12, marginBottom: 14, lineHeight: 1.5 }}>
          {summary.inferredBaselines} of {summary.measurable} baselines were reconstructed from the
          due date at migration time, not from the original commitment. Slip shown against those is a
          minimum — the real figure is likely higher.
        </div>
      )}

      {summary.completed === 0 && (
        <div style={{ fontSize: 12, color: C.neutral, marginBottom: 12 }}>
          Nothing has completed yet, so on-time percentage and average slip have no value to report.
          The open-and-overdue count is still live.
        </div>
      )}

      {/* Per-play table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: C.neutral, fontSize: 11 }}>
              <th style={{ padding: '0 8px 8px', fontWeight: 600, width: '32%' }}>Play</th>
              <th style={{ padding: '0 8px 8px', fontWeight: 600 }}>Baseline</th>
              <th style={{ padding: '0 8px 8px', fontWeight: 600 }}>Current due</th>
              <th style={{ padding: '0 8px 8px', fontWeight: 600 }}>Completed</th>
              <th style={{ padding: '0 8px 8px', fontWeight: 600 }}>vs base</th>
              <th style={{ padding: '0 8px 8px', fontWeight: 600 }}>vs due</th>
              <th style={{ padding: '0 8px 8px', fontWeight: 600 }}>Rev</th>
              {/* 2026_136. Two facts, not two more variances. The columns to
                  the left say whether the dates were met; these say whether
                  anyone has been working on it, which the dates cannot. */}
              <th style={{ padding: '0 8px 8px', fontWeight: 600 }}>Logged</th>
              <th style={{ padding: '0 8px 8px', fontWeight: 600 }}>Last update</th>
              <th style={{ padding: '0 8px 8px', fontWeight: 600 }}>Proof</th>
              <th style={{ padding: '0 8px 8px', fontWeight: 600 }}>Notes</th>
            </tr>
          </thead>
          <tbody>
            {plays.map(p => {
              const isOpen = openRow === p.id;
              const d = detail[p.id];
              return (
                <React.Fragment key={p.id}>
                  <tr onClick={() => expand(p.id)}
                      style={{ borderTop: `1px solid ${C.line}`, cursor: 'pointer',
                               background: isOpen ? '#f9fafb' : 'transparent' }}>
                    <td style={{ padding: '9px 8px' }}>
                      <span style={{ color: C.neutral, marginRight: 5 }}>{isOpen ? '▾' : '▸'}</span>
                      {p.title}
                      {p.isAdHoc && (
                        <span style={{ marginLeft: 6, fontSize: 10, padding: '1px 5px', borderRadius: 4,
                                       background: '#f3f4f6', color: C.neutral }}>ad hoc</span>
                      )}
                      {p.rebaselineCount > 0 && (
                        <span style={{ marginLeft: 6, fontSize: 10, padding: '1px 5px', borderRadius: 4,
                                       background: C.warnBg, color: C.warn }}>re-baselined</span>
                      )}
                      <div style={{ fontSize: 11, color: C.neutral, marginTop: 2 }}>
                        {p.stageName}{p.ownerName ? ` · ${p.ownerName}` : ''}
                      </div>
                    </td>
                    <td style={{ padding: '9px 8px', color: p.baselineDueDate ? '#111827' : C.neutral }}>
                      {fmtDate(p.baselineDueDate)}
                    </td>
                    <td style={{ padding: '9px 8px' }}>{fmtDate(p.dueDate)}</td>
                    <td style={{ padding: '9px 8px' }}>
                      {p.completed ? fmtDate(p.completedAt)
                                   : <span style={{ color: C.neutral }}>{p.status.replace(/_/g, ' ')}</span>}
                    </td>
                    <td style={{ padding: '9px 8px' }}>
                      <Variance days={p.baselineVariance} open={!p.completed} />
                    </td>
                    <td style={{ padding: '9px 8px' }}>
                      <Variance days={p.currentVariance} open={!p.completed} />
                    </td>
                    <td style={{ padding: '9px 8px', color: p.revisionCount ? '#111827' : C.neutral }}>
                      {p.revisionCount || '—'}
                    </td>
                    {/* Distinct DAYS with an entry, across everyone who logged
                        against this task — not hours. There is no hours field
                        in the schema and none is being added: days fall
                        straight out of the entries and cannot be fabricated. */}
                    <td style={{ padding: '9px 8px', color: p.daysLogged ? '#111827' : C.neutral }}>
                      {p.daysLogged || '—'}
                    </td>
                    {/* Read with the slip column: eight days late and untouched
                        for six is the row a review stops on. Stale is flagged
                        only on work that is still OPEN — a finished task whose
                        last entry is a month old is just a task that finished a
                        month ago. */}
                    <td style={{ padding: '9px 8px' }}>
                      {p.lastLoggedDate ? (
                        <>
                          <span style={{ color: !p.completed && isStale(p.lastLoggedDate)
                            ? C.warn : '#111827' }}>
                            {fmtDate(p.lastLoggedDate)}
                          </span>
                          {p.lastLoggedBy && (
                            <div style={{ fontSize: 11, color: C.neutral, marginTop: 2 }}>
                              {p.lastLoggedBy}
                            </div>
                          )}
                        </>
                      ) : <span style={{ color: C.neutral }}>—</span>}
                    </td>
                    <td style={{ padding: '9px 8px', color: p.evidenceCount ? C.early : C.neutral }}>
                      {p.evidenceCount ? `${p.evidenceCount} ✓` : '—'}
                    </td>
                    {/* 2026_120. The columns to the left say how much time was
                        lost; this one says whether anyone wrote down why. An
                        unexplained slip is the row a project review has to
                        stop on. */}
                    <td style={{ padding: '9px 8px', color: p.noteCount ? '#6d28d9' : C.neutral }}>
                      {p.noteCount ? `🗒 ${p.noteCount}` : '—'}
                    </td>
                  </tr>

                  {isOpen && (
                    <tr style={{ background: '#f9fafb' }}>
                      {/* 11 columns since 2026_136 added Logged and Last
                          update. A colSpan short of the header count leaves a
                          phantom cell at the end of every expanded row. */}
                      <td colSpan={11} style={{ padding: '0 8px 14px 26px' }}>
                        {d?.loading && <div style={{ fontSize: 12, color: C.neutral }}>Loading history…</div>}
                        {d?.error   && <div style={{ fontSize: 12, color: C.late }}>{d.error}</div>}

                        {d && !d.loading && !d.error && (
                          <>
                            <div style={{ fontSize: 11, color: C.neutral, margin: '4px 0 6px' }}>Date history</div>
                            {d.revisions.length === 0 ? (
                              <div style={{ fontSize: 12, color: C.neutral }}>
                                The date has never been changed.
                              </div>
                            ) : (
                              <div style={{ borderLeft: `2px solid ${C.line}`, paddingLeft: 12 }}>
                                {d.revisions.map(r => (
                                  <div key={r.id} style={{ fontSize: 12, marginBottom: 8, lineHeight: 1.6 }}>
                                    <span style={{ color: C.head }}>
                                      {fmtDate(r.fromDueDate)} → {fmtDate(r.toDueDate)}
                                    </span>
                                    <span style={{ color: r.isRebaseline ? C.warn : C.neutral, marginLeft: 8 }}>
                                      {r.isRebaseline ? 're-baseline' : 'slip'}
                                    </span>
                                    <span style={{ color: C.neutral, marginLeft: 8 }}>
                                      {r.revisedBy || 'unknown'} · {fmtDate(r.revisedAt)}
                                    </span>
                                    {r.isRebaseline && r.previousBaseline && (
                                      <div style={{ color: C.neutral, fontSize: 11 }}>
                                        original baseline was {fmtDate(r.previousBaseline)}
                                      </div>
                                    )}
                                    {r.reason && (
                                      <div style={{ color: C.neutral, fontSize: 11 }}>{r.reason}</div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}

                            {/* Notes first: on a row that slipped, "why" is the
                                thing being looked for, and it reads before the
                                proof-of-completion trail. Read-only here — the
                                composer lives on the checklist, where the task
                                itself is. */}
                            <div style={{ fontSize: 11, color: C.neutral, margin: '12px 0 6px' }}>Notes</div>
                            {(d.notes || []).length === 0 ? (
                              <div style={{ fontSize: 12, color: C.neutral }}>
                                No notes on this task.
                              </div>
                            ) : d.notes.map(n => (
                              <div key={n.id} style={{
                                background: '#fff', border: `1px solid ${C.line}`, borderRadius: 6,
                                padding: '8px 10px', marginBottom: 6,
                              }}>
                                <div style={{ fontSize: 11, color: C.neutral, marginBottom: 3 }}>
                                  {n.authorName || 'Removed user'} · {fmtDate(n.createdAt)}
                                  {n.noteType && n.noteType !== 'comment' && (
                                    <span style={{ color: n.noteType === 'blocker' ? C.late : C.head,
                                                   marginLeft: 8, textTransform: 'uppercase',
                                                   fontSize: 10, fontWeight: 700 }}>
                                      {n.noteType}
                                    </span>
                                  )}
                                  {n.isInternal && (
                                    <span style={{ color: C.warn, marginLeft: 8, fontSize: 10, fontWeight: 700 }}>
                                      INTERNAL
                                    </span>
                                  )}
                                </div>
                                <div style={{ fontSize: 12, color: '#111827', whiteSpace: 'pre-wrap' }}>
                                  {n.body}
                                </div>
                              </div>
                            ))}

                            <div style={{ fontSize: 11, color: C.neutral, margin: '12px 0 6px' }}>Evidence</div>
                            {d.evidence.length === 0 ? (
                              <div style={{ fontSize: 12, color: C.neutral }}>
                                No evidence attached.
                              </div>
                            ) : d.evidence.map(e => (
                              <div key={e.id} style={{
                                background: '#fff', border: `1px solid ${C.line}`, borderRadius: 6,
                                padding: '8px 10px', marginBottom: 6,
                                opacity: e.revokedAt ? 0.6 : 1,
                              }}>
                                <div style={{ fontSize: 11, color: C.neutral, marginBottom: 3 }}>
                                  {e.sender || 'unknown sender'} · {fmtDate(e.sentAt)}
                                  {e.revokedAt && (
                                    <span style={{ color: C.late, marginLeft: 8 }}>withdrawn</span>
                                  )}
                                </div>
                                <div style={{ fontSize: 12, color: '#111827', whiteSpace: 'pre-wrap' }}>
                                  {e.body || <span style={{ color: C.neutral }}>(no message text)</span>}
                                </div>
                                <div style={{ fontSize: 11, color: C.neutral, marginTop: 4 }}>
                                  Accepted by {e.acceptedBy || 'unknown'} · snapshot locked
                                  {/* The message may since have been re-filed to another project.
                                      The snapshot above still shows what was approved, but the
                                      discrepancy is worth surfacing rather than hiding. */}
                                  {e.messageMoved && (
                                    <span style={{ color: C.warn }}>
                                      {' '}· this message is now filed against a different project
                                    </span>
                                  )}
                                </div>
                                {e.revokedAt && e.revokeReason && (
                                  <div style={{ fontSize: 11, color: C.late, marginTop: 4 }}>
                                    Withdrawn by {e.revokedBy || 'unknown'}: {e.revokeReason}
                                  </div>
                                )}
                              </div>
                            ))}
                          </>
                        )}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ fontSize: 11, color: C.neutral, marginTop: 14, lineHeight: 1.6 }}>
        Variance is measured in days. Open plays are measured against today, so their figure grows
        until the work is done. Skipped and cancelled plays are excluded — work that was
        consciously dropped is not late.
      </div>
    </div>
  );
}
