// ─────────────────────────────────────────────────────────────────────────────
// HandoverView.js
//
// Sales → Implementation Handover module.
//
// Two tabs:
//   "My Handovers"    — deals I closed; I can edit draft, submit, recall
//   "Assigned to Me"  — handovers where I am the assigned service owner;
//                       I can acknowledge, mark in progress, complete
//
// Detail panel sections are driven by the linked playbook plays:
//   • handover_section plays  → form sections
//   • handover_document plays → file attachments
//   • Gate plays show a lock icon until completed
//
// Status flow: draft → submitted → acknowledged → in_progress → completed
//              (cancelled is reachable from any non-terminal state)
//
// Deliverable tracking (2026_64) surfaced here:
//   • plays and commitments carry due dates and overdue state
//   • commitments have a lifecycle: open → in_progress → met | waived | breached
//     (waived / breached require a closure note — mirrored from the backend)
//   • completion is gated by /can-close: every gate play AND every commitment
//     must be terminal. The rollup drives the gate and the summary line.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useCallback } from 'react';
import DesktopOnlyNotice from './DesktopOnlyNotice';
import { apiService } from './apiService';
import VendorsView from './VendorsView';
import PortfolioHealthReport from './PortfolioHealthReport';
import { hashParts, hashSegment, writeHash } from './hashNav';
import ProjectFilesPanel from './ProjectFilesPanel';
import ProjectPeoplePanel from './ProjectPeoplePanel';
import ProjectPlanVsActual from './ProjectPlanVsActual';
import { PlayDateModal, PlayEvidenceModal } from './ProjectPlayModals';
import { PlayReviewModal } from './PlayReviewModal';   // 2026_130
import ProjectBoQ from './ProjectBoQ';
import ProjectEmailThreads from './ProjectEmailThreads';
import ProjectAttachments from './ProjectAttachments';

// ── Deep-link parsing ─────────────────────────────────────────────────────────
// #/handovers                         → My Handovers list
// #/handovers/assigned                → Assigned-to-Me list
// #/handovers/initiatives             → Standing initiatives (2026_133)
// #/handovers/dashboard               → Dashboard tab
// #/handovers/vendors                 → Vendors and partners tab
// #/handovers/<id>[/<subtab>]         → open handover <id> (mine), subtab
// #/handovers/assigned/<id>[/<subtab>]→ open handover <id> (assigned), subtab
// subtab ∈ summary | details | files | communications  (summary omitted from the URL)
function parseHandoverHash() {
  const parts = hashParts();
  if (parts[0] !== 'handovers') return { scope: 'mine', id: null, sub: 'summary' };
  let i = 1, scope = 'mine';
  // 'team' and 'org' were briefly tabs; they are scopes now. Map old links onto
  // My Work rather than leaving `tab` on a value that renders no button.
  if (['assigned', 'team', 'org', 'dashboard', 'vendors', 'initiatives'].includes(parts[i])) {
    scope = (parts[i] === 'team' || parts[i] === 'org') ? 'assigned' : parts[i];
    i += 1;
  }
  let id = null;
  const n = parseInt(parts[i], 10);
  if (Number.isInteger(n) && n > 0 && String(n) === parts[i]) { id = n; i += 1; }
  // Every key the rail renders must be listed here, or a deep link to it
  // silently falls back to Summary. commercial/files/variance were already
  // missing before boq was added.
  const sub = ['summary', 'details', 'commercial', 'files', 'communications',
               'variance', 'boq', 'dailywork'].includes(parts[i]) ? parts[i] : 'summary';
  return { scope, id, sub };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STATUS_META = {
  draft:        { label: 'Draft',        bg: '#f1f5f9', color: '#475569' },
  submitted:    { label: 'Submitted',    bg: '#fef3c7', color: '#92400e' },
  acknowledged: { label: 'Acknowledged', bg: '#dbeafe', color: '#1e40af' },
  in_progress:  { label: 'In Progress',  bg: '#dcfce7', color: '#065f46' },
  completed:    { label: 'Completed',    bg: '#dcfce7', color: '#065f46' },
  cancelled:    { label: 'Cancelled',    bg: '#f1f5f9', color: '#6b7280' },
};

// HANDOVER_ROLE_LABELS was a hard-coded map of the six roles that used to live in
// the project_contacts_role_chk constraint. Roles are configurable per org now
// (contact_roles), so labels come from the API with the row — see
// stakeholder.handoverRoleLabel.

const COMMITMENT_TYPE_META = {
  promise:   { label: 'Promise',   bg: '#dcfce7', color: '#065f46', icon: '✅' },
  risk:      { label: 'Risk',      bg: '#fef3c7', color: '#92400e', icon: '⚠️' },
  red_flag:  { label: 'Red Flag',  bg: '#fee2e2', color: '#991b1b', icon: '🚩' },
};

// Commitment lifecycle — mirrors sales_handover_commitments_status_check.
// Terminal set = met | waived | breached; waived/breached require a note.
const COMMITMENT_STATUS_META = {
  open:        { label: 'Open',        bg: '#f1f5f9', color: '#475569', terminal: false },
  in_progress: { label: 'In progress', bg: '#dbeafe', color: '#1e40af', terminal: false },
  met:         { label: 'Met',         bg: '#dcfce7', color: '#065f46', terminal: true  },
  waived:      { label: 'Waived',      bg: '#fef3c7', color: '#92400e', terminal: true  },
  breached:    { label: 'Breached',    bg: '#fee2e2', color: '#991b1b', terminal: true  },
};
const COMMITMENT_STATUS_ORDER = ['open', 'in_progress', 'met', 'waived', 'breached'];
const NOTE_REQUIRED_STATUSES  = ['waived', 'breached'];

function StatusBadge({ status }) {
  const m = STATUS_META[status] || STATUS_META.draft;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 10px', borderRadius: 12,
      fontSize: 11, fontWeight: 700, background: m.bg, color: m.color,
    }}>{m.label}</span>
  );
}

function CommitmentStatusPill({ status }) {
  const m = COMMITMENT_STATUS_META[status] || COMMITMENT_STATUS_META.open;
  return (
    <span style={{
      display: 'inline-block', padding: '1px 7px', borderRadius: 4,
      fontSize: 10, fontWeight: 700, background: m.bg, color: m.color,
    }}>{m.label}</span>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Turn a date value from the API into a Date positioned on the right CALENDAR
 * DAY in the viewer's timezone.
 *
 * The trap, both halves of it:
 *
 *   • A DATE column read as an object and serialised reports the previous day
 *     east of UTC — node-postgres parses DATE at local midnight, so 2026-12-01
 *     from IST goes over the wire as 2026-11-30T18:30:00Z.
 *   • `new Date('2026-12-01')` is UTC MIDNIGHT, so it renders as 30 Nov west
 *     of UTC. Fixing the server to send a bare date and leaving this alone
 *     just moves the bug to the other hemisphere.
 *
 * So a bare 'YYYY-MM-DD' is built in LOCAL time, component by component, and
 * anything carrying a time is parsed normally. Both forms are accepted on
 * purpose: goLiveDate is fixed at the source now, but other DATE columns in
 * this module still arrive as timestamps, and this keeps working for them
 * either way.
 */
function parseLocalDate(d) {
  if (!d) return null;
  if (d instanceof Date) return d;
  const s = String(d);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(s);
}

/** 'YYYY-MM-DD' for a date input, from whichever form the API sent. */
function toInputDate(d) {
  const dt = parseLocalDate(d);
  if (!dt || Number.isNaN(dt.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

function fmtDate(d) {
  if (!d) return '—';
  return parseLocalDate(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtCurrency(v) {
  if (!v && v !== 0) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v);
}

// A due-date chip shared by plays and commitments. Overdue → red; otherwise a
// muted "Due <date>". Renders nothing when there is no due date.
function DueChip({ dueDate, isOverdue, daysOverdue }) {
  if (!dueDate) return null;
  if (isOverdue) {
    // The date is shown as well as the overdue count. "33d overdue" alone
    // tells you the size of the problem but not the deadline it missed, so
    // there was no way to see the actual date anywhere in the checklist.
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
          background: '#fee2e2', color: '#991b1b',
        }}>
          ⚠ {daysOverdue}d overdue
        </span>
        <span style={{ fontSize: 10, color: '#9ca3af' }}>{fmtDate(dueDate)}</span>
      </span>
    );
  }
  return (
    <span style={{ fontSize: 10, color: '#6b7280', whiteSpace: 'nowrap' }}>
      Due {fmtDate(dueDate)}
    </span>
  );
}

// ── HandoverRow ───────────────────────────────────────────────────────────────

// ── Awaiting my review, across every project (2026_130) ──────────────────────
//
// The per-project banner answers "what is waiting on this project", which is
// the right question once you have opened one and the wrong one when you run
// six: the person who has to clear these does not know which project to open,
// and that is exactly why reviews sit.
//
// Fetched here rather than derived from `projects`, unlike the per-project
// banner — the portfolio list carries counts, not the tasks themselves, so
// there is nothing local to derive from.
function MyReviewQueue({ projects, onOpen }) {
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    callApi(apiService.handovers?.myReviewQueue)
      .then(r => { if (alive) setRows(r?.data || []); })
      .catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
  }, []);

  if (!rows || rows.length === 0) return null;

  // ProjectsBoard's onOpen takes the project ROW, not an id — it does
  // setSelected(h). So the id from the queue has to be resolved back to the row
  // the board is holding. A project the viewer cannot see in this list (a scope
  // they are not on) simply renders as plain text rather than a dead link.
  const rowFor = (hid) => (projects || []).find(
    x => Number(x.id ?? x.handoverId) === Number(hid));

  // Grouped by project: "4 tasks on Riverside" is actionable in a way that
  // four separate lines addressed to nobody in particular are not.
  const byProject = rows.reduce((acc, r) => {
    (acc[r.handoverId] = acc[r.handoverId] || { name: r.projectName, items: [] }).items.push(r);
    return acc;
  }, {});

  return (
    <div style={{ margin: '0 0 14px' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          fontSize: 13, fontWeight: 600, padding: '7px 14px', borderRadius: 999,
          border: '1px solid #fde68a', background: '#fffbeb', color: '#92400e',
          cursor: 'pointer', fontFamily: 'inherit',
        }}>
        <span>🔔 {rows.length} awaiting your review</span>
        <span style={{ fontSize: 10, opacity: 0.8 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{
          marginTop: 8, border: '1px solid #fde68a', borderRadius: 8,
          background: '#fffbeb', padding: '8px 4px', maxWidth: 760,
        }}>
          {Object.entries(byProject).map(([hid, g]) => {
            const row = rowFor(hid);
            return (
            <div key={hid} style={{ padding: '4px 10px 8px' }}>
              {row ? (
                <button
                  onClick={() => onOpen?.(row)}
                  style={{
                    border: 'none', background: 'none', padding: 0, cursor: 'pointer',
                    fontSize: 12, fontWeight: 700, color: '#78350f',
                    fontFamily: 'inherit', textDecoration: 'underline',
                  }}>
                  {g.name}
                </button>
              ) : (
                <span style={{ fontSize: 12, fontWeight: 700, color: '#78350f' }}>{g.name}</span>
              )}
              {g.items.map(it => (
                <div key={it.playInstanceId} style={{
                  fontSize: 12, color: '#92400e', padding: '3px 0 0 12px',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {it.title}
                  <span style={{ opacity: 0.75 }}>
                    {' — '}{it.submittedByName || it.ownerName || 'someone'}
                    {' asked to mark it '}{TARGET_WORD[it.targetStatus] || 'done'}
                  </span>
                </div>
              ))}
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── InitiativesBoard: standing initiatives (2026_133) ─────────────────────────
//
// A SEPARATE BOARD RATHER THAN A FLAG ON ProjectsBoard.
//
// Almost every column there is about finishing: go-live, overdue, value,
// commitments closed out of total, status through a lifecycle that ends. On a
// standing initiative each of those is either empty or meaningless, and a table
// of em-dashes teaches people the screen is broken. What matters instead is
// whether anything is happening on it, which is a different question and wants
// different columns.
//
// The shared parts — the row click, the detail panel, the create modal — are
// still shared. Only the table differs.
function InitiativesBoard({ initiatives, searchTerm, setSearchTerm, showRetired, setShowRetired,
                            onOpen, onRetire, onUnretire, busyId, canManage = false }) {
  const rows = initiatives
    .filter(h => showRetired || !h.isRetired)
    .filter(h => !searchTerm ||
      (h.projectName || h.name || '').toLowerCase().includes(searchTerm.toLowerCase()))
    .sort((a, b) => (a.projectName || a.name || '').localeCompare(b.projectName || b.name || ''));

  const live    = initiatives.filter(h => !h.isRetired).length;
  const retired = initiatives.filter(h => h.isRetired).length;

  const metric = (label, value, color) => (
    <div style={{ flex: 1, minWidth: 130, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '12px 14px' }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || '#111827' }}>{value}</div>
      <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
    </div>
  );
  const inp = { fontSize: 13, padding: '7px 10px', borderRadius: 8, border: '1px solid #d1d5db' };
  const th  = { textAlign: 'left', fontSize: 11, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.3, padding: '0 12px 8px' };
  const td  = { fontSize: 13, padding: '10px 12px', borderTop: '1px solid #f3f4f6' };

  return (
    <div style={{ padding: 20, maxWidth: 1400, margin: '0 auto' }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
        {metric('Initiatives', live, '#7c3aed')}
        {retired > 0 && metric('Retired', retired)}
      </div>

      {/* No status filter and no overdue toggle: a standing initiative has one
          meaningful state — live or retired — and nothing to be late for. */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <input value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
          placeholder="Search initiatives…" style={{ ...inp, minWidth: 240 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#374151' }}>
          <input type="checkbox" checked={showRetired} onChange={e => setShowRetired(e.target.checked)} />
          Show retired
        </label>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9ca3af' }}>{rows.length} shown</span>
      </div>

      {rows.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af', background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🌱</div>
          {initiatives.length === 0
            ? 'No standing initiatives yet. These are ongoing areas of work — AI Learning, Skill Development, a retainer — that daily work can be logged against but never complete.'
            : 'No initiatives match.'}
        </div>
      ) : (
        <div className="gw-table-scroll" style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden', overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={th}>Initiative</th>
              <th style={th}>Kind</th>
              <th style={th}>Who is on it</th>
              <th style={th}>Started</th>
              <th style={{ ...th, textAlign: 'right' }}></th>
            </tr></thead>
            <tbody>
              {rows.map(h => (
                <tr key={h.id} onClick={() => onOpen(h)} style={{ cursor: 'pointer', opacity: h.isRetired ? 0.55 : 1 }}
                  onMouseEnter={e => { e.currentTarget.style.background = '#f9fafb'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                  <td style={td}>
                    <div style={{ fontWeight: 600, color: '#111827' }}>
                      {h.projectName || h.name || `Initiative #${h.id}`}
                      {h.isRetired && (
                        <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, padding: '2px 6px',
                                       borderRadius: 999, background: '#f1f5f9', color: '#475569',
                                       textTransform: 'uppercase', letterSpacing: 0.3 }}>Retired</span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: '#6b7280' }}>
                      {h.projectKind === 'internal' ? 'Internal' : (h.accountName || 'Customer')}
                    </div>
                  </td>
                  <td style={{ ...td, color: '#6b7280' }}>
                    {h.projectKind === 'internal' ? 'Internal' : 'Retainer'}
                  </td>
                  {/* An initiative has no owner by design — list() explicitly
                      stops counting one as unassigned for that reason — so the
                      member list is the only answer to "whose is this". Nobody
                      on it is a real state worth seeing from the board, not an
                      empty cell: it means work can be logged against something
                      no one is attached to. */}
                  <td style={td}>
                    {(h.memberCount || 0) === 0 ? (
                      <span style={{ fontSize: 12, color: '#b45309' }}>Nobody yet</span>
                    ) : (
                      <div style={{ fontSize: 12, color: '#6b7280' }}
                           title={(h.memberNames || []).join(', ')}>
                        {(h.memberNames || []).slice(0, 2).join(', ')}
                        {h.memberCount > 2 && ` +${h.memberCount - 2}`}
                      </div>
                    )}
                  </td>
                  <td style={{ ...td, color: '#6b7280' }}>{h.createdAt ? fmtDate(h.createdAt) : '—'}</td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    {/* Retire, never delete. Deleting the container would leave
                        every daily work item anchored to it pointing at an id
                        that resolves to nothing — there is no foreign key, so
                        nothing stops it and nothing reports it.

                        Hidden rather than disabled for a non-manager: the server
                        403s either way, and a permanently greyed control on
                        every row is a worse answer than no control. Same source
                        as the create button (viewer.canCreateStanding), so the
                        button and the 403 cannot disagree. */}
                    {canManage && (
                    <button
                      disabled={busyId === h.id}
                      onClick={e => { e.stopPropagation(); h.isRetired ? onUnretire(h) : onRetire(h); }}
                      style={{ fontSize: 12, padding: '5px 12px', borderRadius: 7,
                               border: '1px solid #d1d5db', background: '#fff',
                               color: h.isRetired ? '#0369a1' : '#6b7280',
                               cursor: busyId === h.id ? 'wait' : 'pointer' }}>
                      {busyId === h.id ? '…' : (h.isRetired ? 'Un-retire' : 'Retire')}
                    </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ProjectsBoard({ projects, searchTerm, setSearchTerm, statusFilter, setStatusFilter, statusMeta, onOpen, showOwner = false, managerLabel = 'Project Manager' }) {
  const [sortBy, setSortBy] = useState('value');
  const [overdueOnly, setOverdueOnly] = useState(false);

  const overdueOf = (h) => (h.playsOverdue || 0) + (h.commitmentsOverdue || 0);
  const isTerminal = (h) => h.status === 'completed' || h.status === 'cancelled';

  let rows = overdueOnly ? projects.filter(h => overdueOf(h) > 0) : projects;
  rows = [...rows].sort((a, b) => {
    if (sortBy === 'value')  return (Number(b.contractValue) || 0) - (Number(a.contractValue) || 0);
    if (sortBy === 'golive') return parseLocalDate(a.goLiveDate || '2999-01-01') - parseLocalDate(b.goLiveDate || '2999-01-01');
    if (sortBy === 'overdue') return overdueOf(b) - overdueOf(a);
    return (a.projectName || a.dealName || '').localeCompare(b.projectName || b.dealName || '');
  });

  // contract_value is numeric(15,2). node-postgres returns numeric as a STRING
  // to avoid float precision loss, so `s + h.contractValue` concatenates rather
  // than adds and the formatted total comes out as $NaN. Per-row display is
  // unaffected because Intl.format coerces a numeric string on its own.
  // Number() is safe here: numeric(15,2) tops out well inside float64's exact
  // integer range.
  const totalValue   = projects.reduce((s, h) => s + (Number(h.contractValue) || 0), 0);
  // Revenue is money in, budget is money out. Adding them produces a number
  // that looks plausible and means nothing, so they stay as separate cards and
  // each only appears when the list actually contains that kind of project.
  const totalBudget  = projects.reduce((s, h) => s + (Number(h.budget) || 0), 0);
  const hasCustomer  = projects.some(h => (h.projectKind || 'customer') === 'customer');
  const hasInternal  = projects.some(h => h.projectKind === 'internal');
  const active       = projects.filter(h => !isTerminal(h)).length;
  const overdueCount = projects.filter(h => overdueOf(h) > 0).length;
  const completed    = projects.filter(h => h.status === 'completed').length;
  const unassigned   = projects.filter(h => h.isUnassigned).length;

  const metric = (label, value, color) => (
    <div style={{ flex: 1, minWidth: 130, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '12px 14px' }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || '#111827' }}>{value}</div>
      <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
    </div>
  );
  const inp = { fontSize: 13, padding: '7px 10px', borderRadius: 8, border: '1px solid #d1d5db' };
  const th = { textAlign: 'left', fontSize: 11, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.3, padding: '0 12px 8px' };
  const td = { fontSize: 13, padding: '10px 12px', borderTop: '1px solid #f3f4f6' };

  return (
    <div style={{ padding: 20, maxWidth: 1400, margin: '0 auto' }}>
      {/* 2026_130. Above the metrics on purpose: this is the one thing on this
          page that is blocking somebody else's work, and it renders nothing at
          all when the queue is empty — which is most of the time. */}
      <MyReviewQueue projects={projects} onOpen={onOpen} />

      {/* Metrics */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
        {metric('Projects', projects.length)}
        {hasCustomer && metric('Revenue', fmtCurrency(totalValue))}
        {hasInternal && metric('Budget', fmtCurrency(totalBudget), '#7c3aed')}
        {metric('Active', active, '#0369a1')}
        {metric('With overdue', overdueCount, overdueCount ? '#dc2626' : '#111827')}
        {metric('Completed', completed, '#16a34a')}
        {showOwner && metric('Unassigned', unassigned, unassigned ? '#d97706' : '#111827')}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <input value={searchTerm} onChange={e => setSearchTerm(e.target.value)} placeholder="Search deals or accounts…" style={{ ...inp, minWidth: 240 }} />
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={inp}>
          <option value="">All statuses</option>
          {Object.entries(statusMeta).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={inp}>
          <option value="value">Sort: Value</option>
          <option value="golive">Sort: Go-live</option>
          <option value="overdue">Sort: Overdue</option>
          <option value="name">Sort: Name</option>
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#374151' }}>
          <input type="checkbox" checked={overdueOnly} onChange={e => setOverdueOnly(e.target.checked)} /> Overdue only
        </label>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9ca3af' }}>{rows.length} of {projects.length}</span>
      </div>

      {/* Table */}
      {rows.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af', background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🤝</div>No projects match.
        </div>
      ) : (
        <div className="gw-table-scroll" style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden', overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={th}>Project</th>
              {showOwner && <th style={th}>{managerLabel}</th>}
              <th style={th}>Status</th><th style={{ ...th, textAlign: 'right' }}>Value</th>
              <th style={th}>Go-live</th><th style={{ ...th, textAlign: 'center' }}>Overdue</th><th style={th}>Commitments</th>
            </tr></thead>
            <tbody>
              {rows.map(h => {
                const od = overdueOf(h);
                const cTotal = h.commitmentsTotal || 0, cClosed = h.commitmentsClosed || 0;
                return (
                  <tr key={h.id} onClick={() => onOpen(h)} style={{ cursor: 'pointer' }}
                    onMouseEnter={e => { e.currentTarget.style.background = '#f9fafb'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                    <td style={td}>
                      <div style={{ fontWeight: 600, color: '#111827' }}>
                        {h.projectName || h.dealName || h.name || `Project #${h.id}`}
                        {h.projectKind === 'internal' && (
                          <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, padding: '2px 6px',
                                         borderRadius: 999, background: '#ede9fe', color: '#5b21b6',
                                         textTransform: 'uppercase', letterSpacing: 0.3 }}>Internal</span>
                        )}
                      </div>
                      <div style={{ fontSize: 12, color: '#6b7280' }}>
                        {h.projectKind === 'internal' ? 'Internal project' : (h.accountName || '—')}
                      </div>
                    </td>
                    {showOwner && (
                      <td style={td}>
                        {h.isUnassigned
                          ? <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                                           background: '#fef3c7', color: '#92400e', whiteSpace: 'nowrap' }}>Unassigned</span>
                          : <span style={{ color: '#374151' }}>{h.serviceOwnerName || '—'}</span>}
                      </td>
                    )}
                    <td style={td}><StatusBadge status={h.status} /></td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 500 }}>{h.contractValue ? fmtCurrency(h.contractValue) : '—'}</td>
                    <td style={{ ...td, color: '#6b7280' }}>{h.goLiveDate ? fmtDate(h.goLiveDate) : '—'}</td>
                    <td style={{ ...td, textAlign: 'center' }}>
                      {od > 0 ? <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#fee2e2', color: '#991b1b' }}>{od}</span> : <span style={{ color: '#d1d5db' }}>—</span>}
                    </td>
                    <td style={{ ...td, color: '#6b7280' }}>{cTotal ? `${cClosed}/${cTotal}` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Checklist layouts ─────────────────────────────────────────────────────────
const CHECKLIST_LAYOUTS = [
  ['compact',  'Compact'],
  ['table',    'Table'],
  ['detailed', 'Detailed'],
];

// Review-dates step shown before Start / Submit.  (2026_118)
//
// Leaving draft freezes the plan: today's dates become baseline_source
// 'original', and every later change is a tracked rebaseline needing a reason.
// This is the last chance to fix them cheaply, which matters because
// 'created'-anchored tasks carry dates computed when the row was inserted —
// often weeks before the project actually starts.
function StartReviewModal({ preview, loading, onConfirm, onCancel, actionLabel }) {
  const [startDate, setStartDate] = useState(
    preview?.startDate || new Date().toISOString().slice(0, 10));

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 1000,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: '#fff', borderRadius: 12, width: 'min(860px, 100%)',
                    maxHeight: '86vh', display: 'flex', flexDirection: 'column',
                    boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #e5e7eb' }}>
          <h3 style={{ margin: 0, fontSize: 15, color: '#111827' }}>Review dates before starting</h3>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: '#6b7280' }}>
            These become the baseline. After this, changing a date is a tracked rebaseline
            and needs a reason.
          </p>
        </div>

        <div style={{ padding: '12px 20px', borderBottom: '1px solid #f3f4f6',
                      display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12, color: '#374151' }}>
            Start date
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
              style={{ marginLeft: 6, fontSize: 12, padding: '4px 6px',
                       borderRadius: 4, border: '1px solid #d1d5db' }} />
          </label>
          {preview && (
            <span style={{ fontSize: 11, color: '#6b7280' }}>
              {preview.counts.total} tasks · {preview.counts.changing} will change
              {preview.counts.stale > 0 && (
                <span style={{ color: '#b45309', fontWeight: 600 }}>
                  {' '}· {preview.counts.stale} dated before the start
                </span>
              )}
              {preview.counts.undated > 0 && <span> · {preview.counts.undated} undated</span>}
            </span>
          )}
        </div>

        <div style={{ overflowY: 'auto', flex: 1, padding: '0 20px' }}>
          {loading && <div style={{ padding: 20, fontSize: 12, color: '#6b7280' }}>Loading…</div>}
          {!loading && preview && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: '#f8fafc' }}>
                  {['Task', 'Stage', 'Current due', 'Becomes'].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '7px 8px', fontSize: 10,
                                         fontWeight: 700, color: '#94a3b8', letterSpacing: 0.4,
                                         textTransform: 'uppercase', position: 'sticky', top: 0,
                                         background: '#f8fafc' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.tasks.map(t => (
                  <tr key={t.playInstanceId} style={{ borderTop: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '7px 8px', color: '#111827' }}>
                      {t.title}
                      {t.isGate && <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700,
                        padding: '1px 5px', borderRadius: 4, background: '#eff6ff', color: '#1d4ed8' }}>GATE</span>}
                    </td>
                    <td style={{ padding: '7px 8px', color: '#6b7280' }}>{t.stageName || '—'}</td>
                    <td style={{ padding: '7px 8px',
                                 color: t.staleDate ? '#b45309' : '#6b7280',
                                 fontWeight: t.staleDate ? 600 : 400 }}>
                      {t.currentDueDate ? fmtDate(t.currentDueDate) : '—'}
                      {t.staleDate && <span title="Earlier than the start date"> ⚠</span>}
                    </td>
                    <td style={{ padding: '7px 8px',
                                 color: t.changes ? '#0369a1' : '#9ca3af',
                                 fontWeight: t.changes ? 600 : 400 }}>
                      {t.computedDueDate ? fmtDate(t.computedDueDate) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div style={{ padding: '14px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', gap: 8 }}>
          <button onClick={() => onConfirm(startDate)} disabled={loading}
            style={{ fontSize: 12, padding: '7px 16px', borderRadius: 6, fontWeight: 600,
                     border: 'none', background: loading ? '#9ca3af' : '#0369a1', color: '#fff',
                     cursor: loading ? 'default' : 'pointer' }}>
            {actionLabel}
          </button>
          <button onClick={onCancel}
            style={{ fontSize: 12, padding: '7px 14px', borderRadius: 6,
                     border: '1px solid #d1d5db', background: '#fff', color: '#374151',
                     cursor: 'pointer' }}>
            Cancel
          </button>
          <span style={{ fontSize: 11, color: '#9ca3af', alignSelf: 'center' }}>
            Dates can still be edited on the checklist before you confirm.
          </span>
        </div>
      </div>
    </div>
  );
}

// Stage manager — rename, reorder and remove a project's stages.
//
// Collapsed to a single link so it does not compete with the checklist for
// attention. Stages are per-project (project_stages is authoritative), so
// renaming one here cannot affect any other project.
function StageManager({ stages, onSave, onAdd, onRemove, onClose }) {
  const [rows, setRows]   = useState(() => (stages || []).map(s => ({ ...s })));
  const [fresh, setFresh] = useState('');
  const [busy, setBusy]   = useState(false);
  const [err, setErr]     = useState('');

  const move = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    // Renumber on the same sparse 10-step scale the backend uses so a later
    // insert can sit between two stages without a full renumber.
    setRows(next.map((r, k) => ({ ...r, sortOrder: (k + 1) * 10 })));
  };

  const save = async () => {
    setBusy(true); setErr('');
    try { await onSave(rows.map(r => ({
      key: r.key, name: r.name, sortOrder: r.sortOrder, gating: r.gating || 'none',
    }))); }
    catch (e) { setErr(e?.response?.data?.error?.message || 'Could not save stages'); }
    finally { setBusy(false); }
  };

  const add = async () => {
    if (!fresh.trim()) return;
    setBusy(true); setErr('');
    try { await onAdd(fresh.trim()); setFresh(''); }
    catch (e) { setErr(e?.response?.data?.error?.message || 'Could not add that stage'); }
    finally { setBusy(false); }
  };

  const remove = async (key) => {
    setBusy(true); setErr('');
    try { await onRemove(key); }
    catch (e) { setErr(e?.response?.data?.error?.message || 'Could not remove that stage'); }
    finally { setBusy(false); }
  };

  // 'custom' is hard-pinned last by groupPlaysByStage regardless of its
  // sort_order, so offering to rename or reposition it would be a lie.
  const editable = rows.filter(r => r.key !== 'custom');

  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, background: '#f8fafc', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#374151', flex: 1 }}>Stages</span>
        <button onClick={onClose} style={{ fontSize: 11, padding: '3px 9px', borderRadius: 4,
          background: '#f1f5f9', color: '#374151', border: 'none', cursor: 'pointer' }}>Close</button>
      </div>

      {editable.length === 0 && (
        <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 10 }}>
          No stages yet — every task sits in the ad-hoc bucket. Add one below.
        </div>
      )}

      {editable.map((r, i) => (
        <div key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <input value={r.name}
            onChange={e => setRows(rows.map(x => (x.key === r.key ? { ...x, name: e.target.value } : x)))}
            style={{ flex: 1, fontSize: 12, padding: '5px 8px', borderRadius: 4, border: '1px solid #d1d5db' }} />
          <select
            value={r.gating || 'none'}
            onChange={e => setRows(rows.map(x => (x.key === r.key ? { ...x, gating: e.target.value } : x)))}
            title={i === 0
              ? 'The first stage has nothing before it, so gating has no effect here.'
              : 'What locks this stage until earlier stages are done'}
            disabled={i === 0}
            style={{ fontSize: 11, padding: '4px 6px', borderRadius: 4,
                     border: '1px solid #d1d5db', background: i === 0 ? '#f8fafc' : '#fff',
                     color: i === 0 ? '#9ca3af' : '#374151' }}>
            <option value="none">Open</option>
            <option value="gates">Locked by gates</option>
            <option value="strict">Locked by all tasks</option>
          </select>
          <span style={{ fontSize: 10, color: '#9ca3af', width: 62, textAlign: 'right' }}>
            {r.inUse} task{r.inUse === 1 ? '' : 's'}
          </span>
          <button onClick={() => move(i, -1)} disabled={i === 0} title="Move up"
            style={{ fontSize: 11, padding: '3px 7px', borderRadius: 4, border: '1px solid #d1d5db',
                     background: '#fff', cursor: i === 0 ? 'default' : 'pointer', opacity: i === 0 ? 0.4 : 1 }}>↑</button>
          <button onClick={() => move(i, 1)} disabled={i === editable.length - 1} title="Move down"
            style={{ fontSize: 11, padding: '3px 7px', borderRadius: 4, border: '1px solid #d1d5db',
                     background: '#fff', cursor: i === editable.length - 1 ? 'default' : 'pointer',
                     opacity: i === editable.length - 1 ? 0.4 : 1 }}>↓</button>
          <button onClick={() => remove(r.key)} disabled={busy || r.inUse > 0}
            title={r.inUse > 0 ? 'Move its tasks out first' : 'Remove stage'}
            style={{ fontSize: 11, padding: '3px 7px', borderRadius: 4, border: '1px solid #fecaca',
                     background: '#fff', color: '#991b1b',
                     cursor: (busy || r.inUse > 0) ? 'default' : 'pointer', opacity: r.inUse > 0 ? 0.4 : 1 }}>×</button>
        </div>
      ))}

      {editable.length > 1 && (
        <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 6, lineHeight: 1.5 }}>
          <strong>Locked by gates</strong> — tasks here can't start until every gate task in an
          earlier stage is done. <strong>Locked by all tasks</strong> — until every earlier task
          is done. <strong>Open</strong> — never locked.
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 10 }}>
        <input value={fresh} onChange={e => setFresh(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') add(); }}
          placeholder="Add a stage (e.g. Discovery)"
          style={{ flex: 1, fontSize: 12, padding: '5px 8px', borderRadius: 4, border: '1px solid #d1d5db' }} />
        <button onClick={add} disabled={busy || !fresh.trim()}
          style={{ fontSize: 11, padding: '5px 12px', borderRadius: 4, fontWeight: 600, border: 'none', color: '#fff',
                   background: (busy || !fresh.trim()) ? '#9ca3af' : '#0369a1',
                   cursor: (busy || !fresh.trim()) ? 'default' : 'pointer' }}>Add</button>
      </div>

      {err && <div style={{ fontSize: 11, color: '#991b1b', marginTop: 8 }}>{err}</div>}

      <div style={{ marginTop: 12 }}>
        <button onClick={save} disabled={busy}
          style={{ fontSize: 12, padding: '6px 14px', borderRadius: 4, fontWeight: 600, border: 'none', color: '#fff',
                   background: busy ? '#9ca3af' : '#0369a1', cursor: busy ? 'default' : 'pointer' }}>
          {busy ? 'Saving…' : 'Save names & order'}
        </button>
      </div>
    </div>
  );
}

// Click-to-edit cell for the Table view.  (2026_118 item 7)
//
// Commits on blur or Enter, abandons on Escape. Deliberately NOT a controlled
// value bound to the row: the row re-renders on every checklist reload, and a
// bound value would discard keystrokes mid-edit.
function InlineCell({ value, display, type = 'text', options, canEdit, onSave, placeholder }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');

  useEffect(() => { if (!editing) setDraft(value ?? ''); }, [value, editing]);

  if (!canEdit) return <span>{display}</span>;

  const commit = () => {
    setEditing(false);
    const next = draft === '' ? null : draft;
    if (String(next ?? '') !== String(value ?? '')) onSave(next);
  };

  if (!editing) {
    return (
      <span
        onClick={(e) => { e.stopPropagation(); setEditing(true); }}
        title="Click to edit"
        style={{ cursor: 'text', borderBottom: '1px dashed transparent', display: 'inline-block',
                 maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis',
                 whiteSpace: 'nowrap', verticalAlign: 'middle' }}
        onMouseEnter={e => { e.currentTarget.style.borderBottomColor = '#cbd5e1'; }}
        onMouseLeave={e => { e.currentTarget.style.borderBottomColor = 'transparent'; }}
      >
        {display || <span style={{ color: '#d1d5db' }}>{placeholder || '—'}</span>}
      </span>
    );
  }

  const common = {
    autoFocus: true,
    onClick: e => e.stopPropagation(),
    onBlur: commit,
    onKeyDown: e => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { setDraft(value ?? ''); setEditing(false); }
    },
    style: { width: '100%', fontSize: 12, padding: '3px 6px', borderRadius: 4,
             border: '1px solid #0369a1', boxSizing: 'border-box' },
  };

  if (type === 'select') {
    return (
      <select {...common} value={draft ?? ''} onChange={e => setDraft(e.target.value)}>
        <option value="">Unassigned</option>
        {(options || []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }
  return (
    <input {...common} type={type} value={draft ?? ''}
      onChange={e => setDraft(e.target.value)} />
  );
}

// Stage banner + progress bar, shared by all three checklist views so a change
// to stage presentation does not have to be made in three places.
function StageHeader({ group }) {
  const pct = group.items.length ? Math.round((group.done / group.items.length) * 100) : 0;
  // Every task in a locked stage carries the same stageBlockedBy, so the first
  // one is representative.
  const lockedBy = group.items[0]?.stageBlockedBy || [];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
      <span style={{ fontSize: 9, fontWeight: 700, color: '#94a3b8', background: '#f1f5f9',
                     padding: '1px 5px', borderRadius: 4, letterSpacing: 0.3 }}>STAGE</span>
      <span style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase',
                     letterSpacing: 0.4, whiteSpace: 'nowrap',
                     // nowrap came from the Detailed header, which sits in a
                     // full-width row. The Compact card is a ~340px grid cell
                     // and previously allowed wrapping, so a long stage name
                     // would overflow it without these two.
                     overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{group.label}</span>
      <span style={{ fontSize: 11, color: '#6b7280', whiteSpace: 'nowrap' }}>
        {group.done}/{group.items.length} done
      </span>
      {lockedBy.length > 0 && (
        <span title={`Locked until ${lockedBy.join(', ')} clears its gates`}
          style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 4,
                   background: '#f1f5f9', color: '#6b7280', border: '1px solid #e5e7eb',
                   whiteSpace: 'nowrap' }}>
          🔒 Locked · {lockedBy.join(', ')}
        </span>
      )}
      <div style={{ flex: 1, height: 4, background: '#f1f5f9', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%',
                      background: pct === 100 ? '#10b981' : '#0369a1', transition: 'width 0.2s' }} />
      </div>
    </div>
  );
}

// Stage <select> shared by the add-item and edit-item forms.
//
// "__new__" lets a stage be created inline rather than forcing a trip to the
// stage manager first — the backend's _ensureStageExists materialises whatever
// key is sent, so a typed name is enough.
function StagePicker({ value, onChange, stages, label = 'Stage' }) {
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState('');

  if (creating) {
    return (
      <label style={{ fontSize: 11, color: '#6b7280' }}>{label}
        <input autoFocus value={fresh} placeholder="New stage name"
          onChange={e => { setFresh(e.target.value); onChange(e.target.value); }}
          style={{ marginLeft: 6, fontSize: 12, padding: '4px 6px', borderRadius: 4, border: '1px solid #d1d5db', width: 150 }} />
        <button type="button" onClick={() => { setCreating(false); setFresh(''); onChange(''); }}
          style={{ marginLeft: 4, fontSize: 11, padding: '3px 7px', borderRadius: 4,
                   background: '#f1f5f9', color: '#374151', border: 'none', cursor: 'pointer' }}>×</button>
      </label>
    );
  }
  return (
    <label style={{ fontSize: 11, color: '#6b7280' }}>{label}
      <select value={value || ''}
        onChange={e => { if (e.target.value === '__new__') { setCreating(true); onChange(''); } else onChange(e.target.value); }}
        style={{ marginLeft: 6, fontSize: 12, padding: '4px 6px', borderRadius: 4, border: '1px solid #d1d5db' }}>
        <option value="">Added on this project</option>
        {(stages || []).filter(st => st.key !== 'custom')
          .map(st => <option key={st.key} value={st.key}>{st.name}</option>)}
        <option value="__new__">+ New stage…</option>
      </select>
    </label>
  );
}

// ── Play status pill ──────────────────────────────────────────────────────────
//
// Hoisted out of PlaySection: the Table view is a sibling renderer, not a child,
// so it could not reach a map declared inside PlaySection's body. Keeping one
// copy also means a status added later shows up in every view at once.
const PLAY_STATUS = {
  completed:   { label: 'Done',        color: '#065f46', bg: '#ecfdf5', bd: '#a7f3d0' },
  skipped:     { label: 'Skipped',     color: '#6b7280', bg: '#f3f4f6', bd: '#e5e7eb' },
  // 2026_130. Amber, and visually unlike both In progress and Done: the whole
  // point of making review a status rather than a flag is that these are
  // countable and scannable apart from the work still in flight.
  in_review:   { label: 'In review',   color: '#92400e', bg: '#fffbeb', bd: '#fde68a' },
  cancelled:   { label: 'Cancelled',   color: '#6b7280', bg: '#f3f4f6', bd: '#e5e7eb' },
  in_progress: { label: 'In progress', color: '#1d4ed8', bg: '#eff6ff', bd: '#bfdbfe' },
  blocked:     { label: 'Blocked',     color: '#991b1b', bg: '#fef2f2', bd: '#fecaca' },
  not_started: { label: 'Not started', color: '#6b7280', bg: '#f8fafc', bd: '#e5e7eb' },
};

// Terminal statuses. Kept as one list so a status added later does not have to
// be found in six separate inline arrays.
const PLAY_DONE_STATUSES = ['completed', 'skipped', 'cancelled'];
const isPlayDone = st => PLAY_DONE_STATUSES.includes(st);

// How a submission's requested end state reads inside a sentence.
// PLAY_STATUS labels are noun-ish pills ('Done'); these are the verb form.
const TARGET_WORD = { completed: 'done', skipped: 'skipped', cancelled: 'cancelled' };

// Call an apiService method that may not exist yet.
//
// The review loop spans nineteen files across two deploys. If HandoverView.js
// ships ahead of apiService.js, `apiService.handovers.myReviewQueue(...)`
// throws a TypeError SYNCHRONOUSLY — before a promise exists — so the trailing
// .catch() never runs and the error escapes the effect and unmounts the whole
// projects board. A brand-new optional panel must never be able to do that:
// the worst it should do on a stale bundle is not render.
//
// This is not defensive-programming-in-general. It is scoped to the endpoints
// added in 2026_130, and only at the mount-time call sites — the user-initiated
// ones already sit inside try/catch in an async function, where a synchronous
// throw rejects the promise and is caught normally.
function callApi(fn, ...args) {
  if (typeof fn !== 'function') {
    return Promise.reject(new Error('endpoint_unavailable'));
  }
  try {
    return Promise.resolve(fn(...args));
  } catch (err) {
    return Promise.reject(err);
  }
}

function PlayStatusPill({ status }) {
  const s = PLAY_STATUS[status] || PLAY_STATUS.not_started;
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, color: s.color, background: s.bg,
      border: `1px solid ${s.bd}`, borderRadius: 10, padding: '1px 8px',
      whiteSpace: 'nowrap',
    }}>{s.label}</span>
  );
}

// Start / pause control. Completion is deliberately NOT here — it goes through
// the complete endpoint, which enforces gates and captures evidence.
//
// 'in_progress' was a valid status in the schema and was already read by
// PlaybookPlayService, but nothing in the product ever SET it: a task could
// only be "Not started" or done. This is the missing transition.
// canEdit vs canAct, and why they are two props:
//
//   canEdit — may this person reshape the PLAN? It is `isDraft && …`, so it is
//             false for every project that is actually running.
//   canAct  — may this person work THIS task? assignee, project manager,
//             creator or org admin — and true throughout delivery, which is
//             the entire period the review loop operates in.
//
// Gating the review controls on canEdit would have hidden them on every live
// project, which is the only kind of project that has anything to review.
function StatusAction({ play, canAct, onSetStatus, onReview, isManager = false, compact = false }) {
  const btn = (label, title, onClick, tone) => (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={title}
      style={{
        fontSize: compact ? 10 : 11, padding: compact ? '2px 7px' : '3px 10px',
        borderRadius: 5, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
        border: `1px solid ${tone.bd}`, background: tone.bg, color: tone.fg,
      }}>
      {label}
    </button>
  );
  const TONE = {
    amber: { bg: '#fffbeb', fg: '#92400e', bd: '#fde68a' },
    blue:  { bg: '#eff6ff', fg: '#1d4ed8', bd: '#bfdbfe' },
    grey:  { bg: '#fff',    fg: '#6b7280', bd: '#e5e7eb' },
  };

  // 2026_130. A task under review shows the review control to whoever can act
  // on it, and a plain waiting badge to everyone else. Rendered before the
  // canEdit gate below because the assignee CANNOT edit a task in review — but
  // they should still see that it is sitting with someone, not that it has
  // vanished from their control for no visible reason.
  if (play.status === 'in_review') {
    if (isManager && onReview) {
      return btn('Review', 'Approve this, or send it back', () => onReview(play, 'approve'), TONE.amber);
    }
    return (
      <span title={play.reviewSubmittedByName
                    ? `Submitted by ${play.reviewSubmittedByName}`
                    : 'Waiting on the project manager'}
        style={{
          fontSize: compact ? 10 : 11, padding: compact ? '2px 7px' : '3px 10px',
          borderRadius: 5, fontWeight: 600, whiteSpace: 'nowrap',
          border: `1px solid ${TONE.amber.bd}`, background: TONE.amber.bg, color: TONE.amber.fg,
        }}>
        Awaiting review
      </span>
    );
  }

  if (!canAct) return null;

  // A closed task can be reopened by the manager — that is the fifth step of
  // the loop, and without a control here it would only be reachable from the
  // review modal, which a closed task never opens.
  if (isPlayDone(play.status)) {
    if (isManager && onReview) {
      return btn('Send back', 'Reopen this task and tell the assignee why',
                 () => onReview(play, 'reject'), TONE.grey);
    }
    return null;
  }

  const next  = play.status === 'in_progress' ? 'not_started' : 'in_progress';
  const label = play.status === 'in_progress' ? 'Pause' : 'Start';

  // 2026_117: prerequisites block starting, not warning. Pausing an already
  // started task stays available — a task started before a dependency was
  // added must still be resettable.
  // 2026_118: a stage lock blocks just like a task prerequisite, but says so
  // differently — "waiting on Core Model Pipeline" reads very differently from
  // "waiting on task X", and conflating them hides which one to go fix.
  const stageLocked = (play.stageBlockedBy || []).length > 0 && play.status !== 'in_progress';
  const blocked = ((play.blockedBy || []).length > 0 || stageLocked) && play.status !== 'in_progress';
  if (blocked) {
    const names = stageLocked
      ? `stage ${play.stageBlockedBy.join(', ')}`
      : play.blockedBy.map(b => b.title).join(', ');
    return (
      <span
        title={`Blocked by: ${names}. Complete those first, or remove the dependency.`}
        style={{
          fontSize: compact ? 10 : 11, padding: compact ? '2px 7px' : '3px 10px',
          borderRadius: 5, fontWeight: 600, whiteSpace: 'nowrap',
          border: '1px solid #e5e7eb', background: '#f8fafc', color: '#9ca3af',
          cursor: 'not-allowed',
        }}>
        🔒 Blocked
      </span>
    );
  }

  return (
    <button
      onClick={(e) => { e.stopPropagation(); onSetStatus(play.playInstanceId, next); }}
      title={play.status === 'in_progress' ? 'Move back to Not started' : 'Mark as started'}
      style={{
        fontSize: compact ? 10 : 11, padding: compact ? '2px 7px' : '3px 10px',
        borderRadius: 5, fontWeight: 600, cursor: 'pointer',
        border: '1px solid ' + (play.status === 'in_progress' ? '#e5e7eb' : '#bfdbfe'),
        background: play.status === 'in_progress' ? '#fff' : '#eff6ff',
        color: play.status === 'in_progress' ? '#6b7280' : '#1d4ed8',
        whiteSpace: 'nowrap',
      }}>
      {label}
    </button>
  );
}

// ── Status history for one task (2026_130) ───────────────────────────────────
//
// A status that can move backwards needs this. Without it, a task that went
// in_progress → in_review → in_progress → in_review reads in the database as
// though it never left in_progress, and the reason the manager gave the first
// time is nowhere.
//
// Fetched on mount rather than with the checklist: most tasks have no history
// worth reading, and shipping a transitions array on every row of every
// project to serve the few that do is the wrong default.
function PlayTransitionHistory({ handoverId, play }) {
  const [rows, setRows] = useState(null);

  useEffect(() => {
    let alive = true;
    callApi(apiService.handovers?.playTransitions, handoverId, play.playInstanceId)
      .then(r => { if (alive) setRows(r?.data || []); })
      .catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
  }, [handoverId, play.playInstanceId]);

  if (!rows || rows.length === 0) return null;

  const label = (t) => {
    if (t.to === 'in_review') {
      return `sent for review, asking to mark it ${TARGET_WORD[t.targetStatus] || 'done'}`;
    }
    if (t.to === 'in_progress' && ['in_review', ...PLAY_DONE_STATUSES].includes(t.from)) {
      return 'sent back for rework';
    }
    if (t.from === 'in_review') return `approved as ${TARGET_WORD[t.to] || t.to}`;
    return `marked ${TARGET_WORD[t.to] || t.to}`;
  };

  return (
    <div style={{ marginTop: 8, borderTop: '1px dashed #e5e7eb', paddingTop: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', marginBottom: 6 }}>
        Review history
      </div>
      {rows.map(t => (
        <div key={t.id} style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: 11.5 }}>
          <span style={{ color: '#9ca3af', whiteSpace: 'nowrap', flexShrink: 0 }}>
            {fmtDate(t.at)}
          </span>
          <span style={{ color: '#374151', minWidth: 0 }}>
            <strong style={{ fontWeight: 600 }}>{t.actorName || 'Someone'}</strong>
            {' '}{label(t)}
            {t.reason && (
              <span style={{ display: 'block', color: '#92400e', marginTop: 2 }}>
                “{t.reason}”
              </span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Awaiting review banner (2026_130) ────────────────────────────────────────
//
// The reason 'in_review' was made a status rather than a flag on top of
// in_progress: this count is a filter over one column, and the tasks are
// scannable apart from the work still in flight.
function ReviewQueueBanner({ plays, isManager, onOpen }) {
  const [open, setOpen] = useState(false);
  const queue = (plays || []).filter(p => p.status === 'in_review');
  if (!queue.length) return null;

  return (
    <div style={{ marginTop: 10 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 7,
          fontSize: 12, fontWeight: 600, padding: '5px 11px', borderRadius: 999,
          border: '1px solid #fde68a', background: '#fffbeb', color: '#92400e',
          cursor: 'pointer', fontFamily: 'inherit',
        }}>
        <span>{queue.length} awaiting review</span>
        <span style={{ fontSize: 10, opacity: 0.8 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{
          marginTop: 8, border: '1px solid #fde68a', borderRadius: 8,
          background: '#fffbeb', padding: '6px 4px', maxWidth: 680,
        }}>
          {queue.map(p => (
            <div key={p.playInstanceId} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '6px 10px', fontSize: 12, color: '#78350f',
            }}>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden',
                             textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.title}
                <span style={{ opacity: 0.75 }}>
                  {' — '}{p.reviewSubmittedByName || p.ownerName || 'someone'}
                  {' asked to mark it '}{TARGET_WORD[p.reviewTargetStatus] || 'done'}
                </span>
              </span>
              {isManager && onOpen && (
                <button onClick={() => onOpen(p)} style={{
                  fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 5,
                  border: '1px solid #fcd34d', background: '#fff', color: '#92400e',
                  cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: 'inherit',
                }}>Review</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Owner avatar + name, shared by the Table and Compact views.
function OwnerChip({ name, compact = false }) {
  const dot = (
    <span style={{
      width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
      background: name ? '#e0f2fe' : '#f1f5f9',
      color: name ? '#0369a1' : '#9ca3af',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 9, fontWeight: 700,
    }}>{name ? initials(name) : '—'}</span>
  );
  if (compact) return <span title={name || 'Unassigned'}>{dot}</span>;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
                   fontSize: 12, color: name ? '#374151' : '#9ca3af',
                   minWidth: 0 }}>
      {dot}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {name || 'Unassigned'}
      </span>
    </span>
  );
}

// ── Notes on one task (2026_120) ──────────────────────────────────────────────
//
// Deliberately NOT gated on canEdit. canEdit is `isDraft && …`, which is false
// for every project that is actually running — i.e. false during the entire
// period when there is anything worth writing down. Notes are gated on
// canAddNotes, which the server computes from project membership.
//
// Nor is it gated on the task being open. A manager reviewing a finished
// project annotating what happened is the case this was built for.

const NOTE_KIND = {
  comment:  { label: 'Note',     color: '#374151', bg: '#f3f4f6', bd: '#e5e7eb' },
  blocker:  { label: 'Blocker',  color: '#991b1b', bg: '#fef2f2', bd: '#fecaca' },
  decision: { label: 'Decision', color: '#3730a3', bg: '#eef2ff', bd: '#c7d2fe' },
  system:   { label: 'System',   color: '#6b7280', bg: '#f9fafb', bd: '#e5e7eb' },
};

function fmtDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function TaskNotes({ handoverId, play, canAddNotes, canMarkInternal, onCountChange }) {
  const [notes,   setNotes]   = useState(null);   // null = not loaded yet
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');
  const [draft,   setDraft]   = useState('');
  const [kind,    setKind]    = useState('comment');
  const [internal, setInternal] = useState(false);
  const [saving,  setSaving]  = useState(false);
  // 2026_124. Attaching is a second step after the note exists: a multipart
  // upload can fail on the network long after the sentence was typed, and
  // losing the note because the photo failed would be the wrong trade.
  const [uploadingFor, setUploadingFor] = useState(null);  // note id being attached to
  const fileInputRef = React.useRef(null);
  const pendingNoteRef = React.useRef(null);
  // The server has the final say on both of these; these mirror what it
  // returned for this task so the composer matches what will be accepted.
  const [srvCanAdd, setSrvCanAdd] = useState(canAddNotes);
  const [srvCanInternal, setSrvCanInternal] = useState(canMarkInternal);

  const instanceId = play.playInstanceId;

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const r = await apiService.handovers.playNotes(handoverId, instanceId);
      const list = r.data?.notes || [];
      setNotes(list);
      if (r.data?.canAdd !== undefined) setSrvCanAdd(r.data.canAdd);
      if (r.data?.canMarkInternal !== undefined) setSrvCanInternal(r.data.canMarkInternal);
      onCountChange?.(instanceId, list.length);
    } catch (err) {
      setError(err?.response?.data?.error?.message || 'Could not load notes');
    } finally { setLoading(false); }
  }, [handoverId, instanceId, onCountChange]);

  useEffect(() => { load(); }, [load]);

  const add = async () => {
    const body = draft.trim();
    if (!body || saving) return;
    setSaving(true); setError('');
    try {
      await apiService.handovers.addPlayNote(handoverId, instanceId, {
        body, noteType: kind, isInternal: internal,
      });
      setDraft(''); setKind('comment'); setInternal(false);
      await load();
    } catch (err) {
      setError(err?.response?.data?.error?.message || 'Could not add that note');
    } finally { setSaving(false); }
  };

  const remove = async (noteId) => {
    setError('');
    try {
      await apiService.handovers.deletePlayNote(handoverId, noteId);
      await load();
    } catch (err) {
      setError(err?.response?.data?.error?.message || 'Could not remove that note');
    }
  };

  const pickFileFor = (noteId) => {
    pendingNoteRef.current = noteId;
    fileInputRef.current?.click();
  };

  const onFilePicked = async (ev) => {
    const picked = ev.target.files?.[0];
    const noteId = pendingNoteRef.current;
    ev.target.value = '';                 // so the same file can be picked again
    if (!picked || !noteId) return;
    setUploadingFor(noteId); setError('');
    try {
      await apiService.handovers.addPlayNoteAttachment(handoverId, noteId, picked);
      await load();
    } catch (err) {
      setError(err?.response?.data?.error?.message || 'Could not attach that file');
    } finally {
      setUploadingFor(null);
      pendingNoteRef.current = null;
    }
  };

  // Ctrl/Cmd+Enter posts. Plain Enter inserts a newline — these are sentences,
  // not chat messages, and losing a half-written paragraph to a stray Enter is
  // the kind of thing that stops people writing notes at all.
  const onKeyDown = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); add(); }
  };

  return (
    <div style={{ marginTop: 8, padding: '9px 11px', background: '#fff',
                  border: '1px solid #e5e7eb', borderRadius: 6 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', letterSpacing: 0.3,
                    textTransform: 'uppercase', marginBottom: 7 }}>
        Notes
      </div>

      {/* One input for the whole thread; pendingNoteRef says which note the
          pick belongs to. One per note would mount a DOM node per row for a
          control used once in a while. */}
      <input ref={fileInputRef} type="file" onChange={onFilePicked} style={{ display: 'none' }} />

      {error && (
        <div style={{ fontSize: 11, color: '#991b1b', background: '#fef2f2',
                      border: '1px solid #fecaca', borderRadius: 4,
                      padding: '4px 8px', marginBottom: 7 }}>{error}</div>
      )}

      {loading && notes === null && (
        <div style={{ fontSize: 12, color: '#9ca3af' }}>Loading notes…</div>
      )}

      {notes !== null && notes.length === 0 && (
        <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: srvCanAdd ? 8 : 0 }}>
          No notes on this task yet.
        </div>
      )}

      {(notes || []).map(n => {
        const k = NOTE_KIND[n.noteType] || NOTE_KIND.comment;
        return (
          <div key={n.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start',
                                   padding: '7px 0', borderTop: '1px solid #f3f4f6' }}>
            <span style={{ width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                           background: '#e0f2fe', color: '#0369a1', display: 'inline-flex',
                           alignItems: 'center', justifyContent: 'center',
                           fontSize: 9, fontWeight: 700 }}>
              {initials(n.authorName || '?')}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#111827' }}>
                  {n.authorName || 'Removed user'}
                </span>
                <span style={{ fontSize: 10, color: '#9ca3af' }}>{fmtDateTime(n.createdAt)}</span>
                {n.noteType !== 'comment' && (
                  <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
                                 color: k.color, background: k.bg, border: `1px solid ${k.bd}` }}>
                    {k.label.toUpperCase()}
                  </span>
                )}
                {n.isInternal && (
                  <span title="Not shown to the person signing this project off"
                    style={{ fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
                             color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a' }}>
                    INTERNAL
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, color: '#374151', marginTop: 2, lineHeight: 1.5,
                            whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {n.body}
              </div>
              {/* Attachments (2026_124). Images thumbnail; anything else is a
                  link. A dead link is shown rather than hidden — "this was
                  attached and has since gone" is what an auditor needs. */}
              {(n.attachments || []).length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                  {n.attachments.map(a => (
                    a.isImage && a.webUrl && a.fileLive ? (
                      <a key={a.id} href={a.webUrl} target="_blank" rel="noopener noreferrer"
                         title={a.fileName}>
                        <img src={a.webUrl} alt={a.fileName}
                             onError={e => { e.currentTarget.style.display = 'none'; }}
                             style={{ width: 78, height: 78, objectFit: 'cover', borderRadius: 6,
                                      border: '1px solid #e5e7eb', display: 'block' }} />
                      </a>
                    ) : (
                      <a key={a.id}
                         href={a.fileLive && a.webUrl ? a.webUrl : undefined}
                         target="_blank" rel="noopener noreferrer"
                         style={{ fontSize: 11, padding: '3px 8px', borderRadius: 4,
                                  border: '1px solid #e5e7eb', background: '#f9fafb',
                                  color: a.fileLive ? '#0369a1' : '#9ca3af',
                                  textDecoration: 'none',
                                  cursor: a.fileLive ? 'pointer' : 'default' }}>
                        📎 {a.fileName}{a.fileLive ? '' : ' · unavailable'}
                      </a>
                    )
                  ))}
                </div>
              )}
              {srvCanAdd && (
                <button onClick={() => pickFileFor(n.id)} disabled={uploadingFor === n.id}
                  style={{ marginTop: 5, fontSize: 10, padding: '2px 7px', borderRadius: 4,
                           background: 'none', border: '1px solid #e5e7eb', color: '#6b7280',
                           cursor: uploadingFor === n.id ? 'default' : 'pointer' }}>
                  {uploadingFor === n.id ? 'Uploading…' : '📎 Attach a file'}
                </button>
              )}
            </div>
            {n.canDelete && (
              <button onClick={() => remove(n.id)} title="Remove this note"
                style={{ fontSize: 14, lineHeight: 1, padding: '1px 5px', borderRadius: 4,
                         background: 'none', color: '#9ca3af', border: 'none',
                         cursor: 'pointer', flexShrink: 0 }}>×</button>
            )}
          </div>
        );
      })}

      {srvCanAdd && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #f3f4f6' }}>
          <textarea value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={onKeyDown}
            rows={2} placeholder="Add a note — what happened, what's holding this up, what was agreed"
            style={{ width: '100%', fontSize: 12, padding: '6px 8px', borderRadius: 4,
                     border: '1px solid #d1d5db', boxSizing: 'border-box', resize: 'vertical' }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <select value={kind} onChange={e => setKind(e.target.value)}
              style={{ fontSize: 11, padding: '4px 6px', borderRadius: 4, border: '1px solid #d1d5db' }}>
              <option value="comment">Note</option>
              <option value="blocker">Blocker</option>
              <option value="decision">Decision</option>
            </select>
            {srvCanInternal && (
              <label title="Hidden from the person who signs this project off"
                style={{ fontSize: 11, color: '#6b7280', display: 'inline-flex',
                         alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={internal}
                  onChange={e => setInternal(e.target.checked)} /> Internal only
              </label>
            )}
            <button onClick={add} disabled={!draft.trim() || saving}
              style={{ fontSize: 12, padding: '5px 14px', borderRadius: 4, fontWeight: 600,
                       background: (!draft.trim() || saving) ? '#e5e7eb' : '#0369a1',
                       color: (!draft.trim() || saving) ? '#9ca3af' : '#fff', border: 'none',
                       cursor: (!draft.trim() || saving) ? 'not-allowed' : 'pointer' }}>
              {saving ? 'Adding…' : 'Add note'}
            </button>
            <span style={{ fontSize: 10, color: '#9ca3af' }}>
              Notes can't be edited — post a correction instead.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Small count badge, shared by the compact and table checklist rows. */
function NoteCountBadge({ count }) {
  if (!count) return null;
  return (
    <span title={`${count} note${count === 1 ? '' : 's'}`}
      style={{ fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
               background: '#f5f3ff', color: '#6d28d9', border: '1px solid #ddd6fe',
               whiteSpace: 'nowrap' }}>
      🗒 {count}
    </span>
  );
}

// ── PlaySection ───────────────────────────────────────────────────────────────

function PlaySection({ play, canEdit, onComplete, onRemove, onEdit, onSetStatus, onSetDeps, siblings, users, stages, evidencePolicy,
                       handoverId, canAddNotes, canMarkNotesInternal, onNoteCountChange,
                       onReview, isManager = false, canAct = false }) {
  // Done-state mirrors the backend gate, which treats a play as satisfied when
  // its status is 'completed' OR 'skipped' — not merely when completedAt is set.
  // (A skipped play has no completedAt but still clears the gate.)
  const isDone   = isPlayDone(play.status);
  const isSkipped = play.status === 'skipped';
  const isGate   = play.isGate;

  const [capturing, setCapturing] = useState(false);
  const [note,   setNote]   = useState('');
  const [evType, setEvType] = useState('whatsapp');
  const [snippet, setSnippet] = useState('');
  const [showEv, setShowEv] = useState(false);
  // Notes open on demand rather than eagerly: expanding a task should not fire
  // a request per task on a 200-task project. The count badge does the
  // discovery job, so nothing is hidden — only deferred.
  const [showNotes, setShowNotes] = useState(false);
  // Local echo of the count so the button updates the moment a note is added,
  // without refetching the whole project.
  const [localNoteCount, setLocalNoteCount] = useState(null);
  const noteCount = localNoteCount != null ? localNoteCount : (play.noteCount || 0);

  // Inline edit — fields are seeded from the play when the editor opens (in
  // openEdit), not via useState initialisers, so they stay fresh across reloads.
  const [editing, setEditing] = useState(false);
  const [eTitle, setETitle] = useState('');
  const [eDesc,  setEDesc]  = useState('');
  const [eOwner, setEOwner] = useState('');
  const [eDue,   setEDue]   = useState('');
  const [eGate,  setEGate]  = useState(false);
  const [eStage, setEStage] = useState('');
  const [eDeps,  setEDeps]  = useState([]);
  const [eSaving, setESaving] = useState(false);

  const openEdit = () => {
    setETitle(play.title || '');
    setEDesc(play.description || '');
    setEOwner(play.ownerUserId != null ? String(play.ownerUserId) : '');
    setEDue(play.dueDate ? String(play.dueDate).slice(0, 10) : '');
    setEGate(!!play.isGate);
    // 'custom' maps to the empty option — the picker labels it
    // "Added on this project" rather than exposing the raw key.
    setEStage(play.stageKey && play.stageKey !== 'custom' ? play.stageKey : '');
    setEDeps(play.dependsOn || []);
    setEditing(true);
  };
  const saveEdit = async () => {
    if (!eTitle.trim()) return;
    setESaving(true);
    try {
      await onEdit(play.playInstanceId, {
        title: eTitle.trim(),
        description: eDesc.trim() || null,
        ownerUserId: eOwner || null,
        dueDate: eDue || null,
        isGate: eGate,
        // Blank means the ad-hoc bucket. Sent explicitly (not undefined) so a
        // task can be moved back OUT of a named stage, which an omitted field
        // could not express.
        stageKey: eStage.trim() || 'custom',
        stageName: (eStage.trim() && !(stages || []).some(st => st.key === eStage.trim()))
          ? eStage.trim() : undefined,
      });
      // Dependencies go through their own endpoint: cycle detection and the
      // same-project check live there, and a rejected dependency must not
      // silently roll back the title/owner/date edits above.
      if (onSetDeps) {
        const before = [...(play.dependsOn || [])].sort().join(',');
        const after  = [...eDeps].sort().join(',');
        if (before !== after) await onSetDeps(play.playInstanceId, eDeps);
      }
      setEditing(false);
    } finally { setESaving(false); }
  };

  const ev = play.completionEvidence;
  // completion_evidence is a free-form jsonb column with no CHECK constraint,
  // so this list can grow without a migration. (The formal play_evidence table
  // is separate and DOES constrain channel — don't confuse the two.)
  const EV_LABEL = {
    whatsapp: 'WhatsApp', email: 'Email', note: 'Note', document: 'Document',
    in_person: 'In person', meeting: 'Meeting',
  };
  const CH_LABEL = { whatsapp: 'WhatsApp', email: 'Email', internal_task: 'Internal', call: 'Call', linkedin: 'LinkedIn' };

  // Status pill — makes in_progress distinct from not_started (both looked the
  // same before), and names the state in words rather than only an icon.
  // The map itself now lives at module scope (PLAY_STATUS) so the Table view
  // can share it.
  const st = PLAY_STATUS[play.status] || PLAY_STATUS.not_started;

  // 2026_118: whether THIS task needs evidence. The note deliberately does not
  // satisfy it — a note is free text, whereas the evidence field points at the
  // artefact that closed the task. Mirrors the server-side check in
  // completePlay, which is the actual enforcement.
  const evidenceNeeded = Boolean(
    evidencePolicy && (evidencePolicy.required || (evidencePolicy.requiredForGates && play.isGate)));

  const confirm = () => {
    if (evidenceNeeded && !snippet.trim()) return;
    const data = {};
    if (note.trim()) data.completionNote = note.trim();
    if (snippet.trim()) data.completionEvidence = { type: evType, snippet: snippet.trim() };
    onComplete(play.playInstanceId, data);
    setCapturing(false);
  };

  const icon = isSkipped ? '⊘' : isDone ? '✅' : isGate ? '🔒' : play.status === 'in_progress' ? '🔄' : '⬜';

  return (
    <div style={{
      border: `1px solid ${isDone ? '#d1fae5' : isGate ? '#fecaca' : '#e5e7eb'}`,
      borderRadius: 8, padding: '12px 14px', marginBottom: 10,
      background: isDone ? '#f0fdf4' : '#fff',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <span style={{ fontSize: 16, lineHeight: '20px' }}>{icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: isDone ? '#065f46' : '#111827' }}>
              {play.title}
            </span>
            {isGate && !isDone && (
              <span style={{ fontSize: 10, color: '#dc2626', fontWeight: 700 }}>GATE</span>
            )}
            {play.isCustom && (
              <span style={{ fontSize: 10, color: '#7c3aed', fontWeight: 700, background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: 4, padding: '0 5px' }}>added here</span>
            )}
          </div>
          {play.description && (
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 3, lineHeight: 1.4 }}>{play.description}</div>
          )}
          {isDone && play.completedAt && (
            <div style={{ fontSize: 11, color: '#059669', marginTop: 4 }}>
              ✓ {isSkipped ? 'Skipped' : 'Completed'} {fmtDate(play.completedAt)}{play.completedByName ? ` · ${play.completedByName}` : ''}
            </div>
          )}
          {/* Meta row: status · owner · channel */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10, fontWeight: 600, color: st.color, background: st.bg, border: `1px solid ${st.bd}`, borderRadius: 10, padding: '1px 8px' }}>
              {st.label}
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: play.ownerName ? '#374151' : '#9ca3af' }}>
              {play.ownerName ? (
                <>
                  <span style={{ width: 18, height: 18, borderRadius: '50%', background: '#e0f2fe', color: '#0369a1',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700 }}>{initials(play.ownerName)}</span>
                  {play.ownerName}
                </>
              ) : 'Unassigned'}
            </span>
            {play.channel && CH_LABEL[play.channel] && (
              <span style={{ fontSize: 10, color: '#9ca3af' }}>· {CH_LABEL[play.channel]}</span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {!isDone && <DueChip dueDate={play.dueDate} isOverdue={play.isOverdue} daysOverdue={play.daysOverdue} />}
          {isDone && play.completedAt && (
            <span style={{ fontSize: 11, color: '#6b7280', whiteSpace: 'nowrap' }}>{fmtDate(play.completedAt)}</span>
          )}
          {isDone && (ev || play.completionNote) && (
            <button onClick={() => setShowEv(v => !v)} style={{
              fontSize: 11, padding: '3px 8px', borderRadius: 4, background: '#ecfdf5',
              color: '#065f46', border: '1px solid #a7f3d0', cursor: 'pointer' }}>
              {showEv ? 'Hide evidence' : 'Evidence'}
            </button>
          )}
          {/* Offered on completed and skipped tasks too — annotating a finished
              task is the reviewing case, and it is the one that matters most.
              Shown even with no notes and no write access, so a read-only
              viewer can still open the thread. */}
          {handoverId != null && (
            <button onClick={() => setShowNotes(v => !v)}
              title={isDone ? 'Notes — you can still annotate a closed task' : 'Notes on this task'}
              style={{
                fontSize: 11, padding: '3px 8px', borderRadius: 4,
                background: noteCount ? '#f5f3ff' : '#fff',
                color: noteCount ? '#6d28d9' : '#374151',
                border: `1px solid ${noteCount ? '#ddd6fe' : '#d1d5db'}`,
                cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }}>
              {showNotes ? 'Hide notes' : `Notes${noteCount ? ` (${noteCount})` : ''}`}
            </button>
          )}
          {/* 2026_130: no longer gated on !isDone. StatusAction decides for
              itself what a closed or in-review task should offer — a manager
              needs "Send back" on a task that is already done, which is
              exactly the case the old !isDone gate removed. */}
          {!capturing && (onSetStatus || onReview) && (
            <StatusAction play={play} canAct={canAct} onSetStatus={onSetStatus}
              onReview={onReview} isManager={isManager} />
          )}
          {/* 2026_130: submission replaces "Mark done" for everyone who is not
              a manager. A manager keeps the direct close — they are the person
              who would have approved it anyway, and routing them through a
              review addressed to themselves is ceremony.

              But a manager must still be ABLE to submit. Three cases make the
              direct-close-only version wrong:
                • a manager doing work on a task assigned to them, who wants a
                  second pair of eyes on it
                • a project with two managers, where one reviews the other
                • an org that wants every closure evidenced through review,
                  regardless of who is closing it
              So a manager gets both: Mark done as the primary action, Send for
              review alongside it. Everyone else gets submission only. */}
          {!isDone && play.status !== 'in_review' && canAct && !capturing
            && (play.blockedBy || []).length === 0 && (
            <>
              {isManager && (
                <button
                  onClick={() => onReview?.(play, 'submit')}
                  title="Record evidence and put this in the review queue instead of closing it"
                  style={{
                    fontSize: 11, padding: '3px 10px', borderRadius: 4,
                    background: '#fffbeb', color: '#92400e',
                    border: '1px solid #fde68a', cursor: 'pointer', fontWeight: 600,
                  }}>
                  Send for review
                </button>
              )}
              <button
                onClick={() => (isManager ? setCapturing(true) : onReview?.(play, 'submit'))}
                title={isManager
                  ? 'Close this task'
                  : 'Send this to the project manager with evidence'}
                style={{
                  fontSize: 11, padding: '3px 10px', borderRadius: 4,
                  background: '#0369a1', color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 600,
                }}>
                {isManager ? 'Mark done' : 'Send for review'}
              </button>
            </>
          )}
          {canEdit && onEdit && !editing && !capturing && (
            <button onClick={openEdit} title="Edit this item" style={{
              fontSize: 11, padding: '3px 10px', borderRadius: 4,
              background: '#fff', color: '#374151', border: '1px solid #d1d5db', cursor: 'pointer', fontWeight: 600,
            }}>
              Edit
            </button>
          )}
          {play.isCustom && canEdit && onRemove && (
            <button onClick={() => onRemove(play.playInstanceId)} title="Remove this item" style={{
              fontSize: 15, lineHeight: 1, padding: '2px 6px', borderRadius: 4,
              background: 'none', color: '#9ca3af', border: 'none', cursor: 'pointer' }}>×</button>
          )}
        </div>
      </div>

      {/* Evidence of how this item was closed */}
      {isDone && showEv && (ev || play.completionNote) && (
        <div style={{ marginTop: 8, padding: '8px 10px', background: '#fff', border: '1px solid #d1fae5', borderRadius: 6, fontSize: 12 }}>
          {ev && (
            <div style={{ marginBottom: play.completionNote ? 4 : 0 }}>
              <span style={{ fontWeight: 700, color: '#059669' }}>{EV_LABEL[ev.type] || ev.type}: </span>
              <span style={{ color: '#374151' }}>{ev.snippet}</span>
            </div>
          )}
          {play.completionNote && <div style={{ color: '#6b7280' }}>{play.completionNote}</div>}
        </div>
      )}

      {/* Notes — available whatever the task's status */}
      {showNotes && handoverId != null && (
        <TaskNotes
          handoverId={handoverId}
          play={play}
          canAddNotes={canAddNotes}
          canMarkInternal={canMarkNotesInternal}
          onCountChange={(id, n) => {
            setLocalNoteCount(n);
            onNoteCountChange?.(id, n);
          }}
        />
      )}

      {/* 2026_130. Rides the same disclosure as the notes: someone opening the
          thread to work out what happened wants both, and a second toggle for
          a list that is empty on most tasks would be one control too many. */}
      {showNotes && handoverId != null && (
        <PlayTransitionHistory handoverId={handoverId} play={play} />
      )}

      {/* Manual completion capture: note + how it was closed */}
      {(play.blockedBy || []).length > 0 && (
        <div style={{ marginTop: 6, fontSize: 11, color: '#92400e', background: '#fffbeb',
                      border: '1px solid #fde68a', borderRadius: 6, padding: '5px 9px' }}>
          🔒 Waiting on: {play.blockedBy.map(b => b.title).join(', ')}
        </div>
      )}
      {capturing && (
        <div style={{ marginTop: 8, padding: 10, background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 6 }}>
          <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6 }}>How was this closed out?</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <select value={evType} onChange={e => setEvType(e.target.value)}
              style={{ fontSize: 12, padding: '5px 6px', borderRadius: 4, border: '1px solid #d1d5db' }}>
              <option value="whatsapp">WhatsApp</option>
              <option value="email">Email</option>
              <option value="meeting">Meeting</option>
              <option value="in_person">In person</option>
              <option value="note">Note</option>
              <option value="document">Document</option>
            </select>
            <input value={snippet} onChange={e => setSnippet(e.target.value)}
              placeholder={evidenceNeeded
                ? 'Evidence required — paste the message / reference'
                : 'Evidence (e.g. paste the message / reference)'}
              style={{ flex: 1, fontSize: 12, padding: '5px 8px', borderRadius: 4,
                       border: `1px solid ${evidenceNeeded && !snippet.trim() ? '#fca5a5' : '#d1d5db'}` }} />
          </div>
          <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} placeholder="Optional note"
            style={{ width: '100%', fontSize: 12, padding: '5px 8px', borderRadius: 4, border: '1px solid #d1d5db', boxSizing: 'border-box', resize: 'vertical' }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <button onClick={confirm} disabled={evidenceNeeded && !snippet.trim()}
              title={evidenceNeeded && !snippet.trim()
                ? (isGate ? 'This is a gate task — evidence is required.'
                          : 'Evidence is required to close tasks on this project.')
                : ''}
              style={{ fontSize: 12, padding: '5px 14px', borderRadius: 4,
                       background: (evidenceNeeded && !snippet.trim()) ? '#e5e7eb' : '#059669',
                       color: (evidenceNeeded && !snippet.trim()) ? '#9ca3af' : '#fff',
                       border: 'none', fontWeight: 600,
                       cursor: (evidenceNeeded && !snippet.trim()) ? 'not-allowed' : 'pointer' }}>
              Confirm done
            </button>
            <button onClick={() => setCapturing(false)} style={{ fontSize: 12, padding: '5px 10px', borderRadius: 4, background: '#f1f5f9', color: '#374151', border: 'none', cursor: 'pointer' }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Inline edit — per-handover fields; never changes the playbook template */}
      {editing && (
        <div style={{ marginTop: 8, padding: 10, background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 6 }}>
          <input value={eTitle} onChange={e => setETitle(e.target.value)} placeholder="Title"
            style={{ width: '100%', fontSize: 13, padding: '6px 8px', borderRadius: 4, border: '1px solid #d1d5db', boxSizing: 'border-box', marginBottom: 6 }} />
          <textarea value={eDesc} onChange={e => setEDesc(e.target.value)} rows={2} placeholder="Description (optional)"
            style={{ width: '100%', fontSize: 12, padding: '6px 8px', borderRadius: 4, border: '1px solid #d1d5db', boxSizing: 'border-box', resize: 'vertical', marginBottom: 6 }} />
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
            <label style={{ fontSize: 11, color: '#6b7280' }}>Owner
              <select value={eOwner} onChange={e => setEOwner(e.target.value)}
                style={{ marginLeft: 6, fontSize: 12, padding: '4px 6px', borderRadius: 4, border: '1px solid #d1d5db' }}>
                <option value="">Unassigned</option>
                {(users || []).map(u => <option key={u.id} value={String(u.id)}>{u.name}</option>)}
              </select>
            </label>
            <label style={{ fontSize: 11, color: '#6b7280' }}>Due
              <input type="date" value={eDue} onChange={e => setEDue(e.target.value)}
                style={{ marginLeft: 6, fontSize: 12, padding: '4px 6px', borderRadius: 4, border: '1px solid #d1d5db' }} />
            </label>
            <StagePicker value={eStage} onChange={setEStage} stages={stages} label="Stage" />
            <label style={{ fontSize: 11, color: '#6b7280', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={eGate} onChange={e => setEGate(e.target.checked)} /> Gate (blocks go-live)
            </label>
          </div>

          {onSetDeps && (siblings || []).length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>
                Depends on <span style={{ color: '#9ca3af' }}>· this task can't start until these are done</span>
              </div>
              <div style={{ maxHeight: 130, overflowY: 'auto', border: '1px solid #d1d5db',
                            borderRadius: 4, padding: '6px 8px', background: '#fff' }}>
                {siblings.map(sib => (
                  <label key={sib.playInstanceId}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12,
                             padding: '2px 0', color: '#374151' }}>
                    <input
                      type="checkbox"
                      checked={eDeps.includes(sib.playInstanceId)}
                      onChange={() => setEDeps(d => d.includes(sib.playInstanceId)
                        ? d.filter(x => x !== sib.playInstanceId)
                        : [...d, sib.playInstanceId])}
                    />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {sib.title}
                    </span>
                    {isPlayDone(sib.status) && (
                      <span style={{ fontSize: 10, color: '#059669' }}>✓</span>
                    )}
                  </label>
                ))}
              </div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={saveEdit} disabled={eSaving || !eTitle.trim()} style={{ fontSize: 12, padding: '5px 14px', borderRadius: 4,
              background: (eSaving || !eTitle.trim()) ? '#9ca3af' : '#0369a1', color: '#fff', border: 'none', fontWeight: 600,
              cursor: (eSaving || !eTitle.trim()) ? 'default' : 'pointer' }}>
              {eSaving ? 'Saving…' : 'Save changes'}
            </button>
            <button onClick={() => setEditing(false)} style={{ fontSize: 12, padding: '5px 10px', borderRadius: 4, background: '#f1f5f9', color: '#374151', border: 'none', cursor: 'pointer' }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Stage grouping for the handover checklist ─────────────────────────────────
const STAGE_LABELS = {
  mobilize: 'Mobilization', groundwork: 'Groundwork', installation: 'Installation',
  finishing: 'Finishing', signoff: 'Sign-off', custom: 'Added on this project',
};
function stageLabel(key) {
  if (!key) return 'Other';
  return STAGE_LABELS[key] || key.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
// Group plays by stage, in the order the server resolved; ad-hoc ('custom')
// always last.
//
// 2026_115: ordering now comes from play.stageSortOrder, which the backend
// derives from COALESCE(playbook_stages, project_stages). It used to be
// minSort — the smallest sortOrder among a group's plays — which looked
// reasonable but never worked: addPlay numbers sort_order per stage starting
// at 10, so the first play in EVERY stage was 10, all groups tied, and the
// stable sort just handed back SQL order (alphabetical by stage_key). Stages
// silently ran in the wrong sequence.
//
// minSort is kept as the tiebreak for pre-migration rows that have no
// stageSortOrder yet.
function groupPlaysByStage(plays) {
  const map = new Map();
  for (const p of plays) {
    const key = p.stageKey || 'other';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(p);
  }
  const groups = [...map.entries()].map(([key, items]) => ({
    key,
    // Server-supplied name first: it is the only one that knows this project's
    // own vocabulary. stageLabel() remains the fallback for older payloads.
    label: items.find(i => i.stageName)?.stageName || stageLabel(key),
    items,
    stageSort: items.find(i => i.stageSortOrder != null)?.stageSortOrder ?? null,
    minSort: Math.min(...items.map(i => i.sortOrder ?? 9999)),
    done: items.filter(i => isPlayDone(i.status)).length,
  }));
  groups.sort((a, b) => {
    if (a.key === 'custom') return 1;
    if (b.key === 'custom') return -1;
    const as = a.stageSort, bs = b.stageSort;
    if (as != null && bs != null && as !== bs) return as - bs;
    if (as != null && bs == null) return -1;   // defined stages before undefined
    if (as == null && bs != null) return 1;
    return a.minSort - b.minSort;
  });
  return groups;
}

// ── AddPlayForm: add an ad-hoc checklist item directly on a handover ───────────
function AddPlayForm({ users, onAdd, stages }) {
  const [open,   setOpen]   = useState(false);
  const [title,  setTitle]  = useState('');
  const [desc,   setDesc]   = useState('');
  const [due,    setDue]    = useState('');
  const [owner,  setOwner]  = useState('');
  const [gate,   setGate]   = useState(false);
  const [stage,  setStage]  = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      await onAdd({
        title: title.trim(),
        description: desc.trim() || undefined,
        dueDate: due || undefined,
        ownerUserId: owner || undefined,
        isGate: gate,
        // Omitted rather than sent blank: addPlay falls back to 'custom',
        // which is the ad-hoc bucket the empty option represents.
        stageKey: stage.trim() || undefined,
        // For a stage typed fresh in the picker, send the name verbatim too.
        // Without it the backend derives the label from the normalised key and
        // punctuation is lost — "Go-Live Prep" came back as "Go Live Prep".
        stageName: (stage.trim() && !(stages || []).some(st => st.key === stage.trim()))
          ? stage.trim() : undefined,
      });
      setTitle(''); setDesc(''); setDue(''); setOwner(''); setGate(false); setStage(''); setOpen(false);
    } finally { setSaving(false); }
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={{ fontSize: 12, padding: '6px 12px', borderRadius: 6,
        background: '#fff', color: '#0369a1', border: '1px dashed #93c5fd', cursor: 'pointer', fontWeight: 600 }}>
        + Add checklist item
      </button>
    );
  }
  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, background: '#f8fafc' }}>
      <input value={title} onChange={e => setTitle(e.target.value)} placeholder="What needs to happen?"
        style={{ width: '100%', fontSize: 13, padding: '7px 9px', borderRadius: 4, border: '1px solid #d1d5db', boxSizing: 'border-box', marginBottom: 8 }} />
      <textarea value={desc} onChange={e => setDesc(e.target.value)} rows={2} placeholder="Description (optional)"
        style={{ width: '100%', fontSize: 12, padding: '7px 9px', borderRadius: 4, border: '1px solid #d1d5db', boxSizing: 'border-box', resize: 'vertical', marginBottom: 8 }} />
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <label style={{ fontSize: 11, color: '#6b7280' }}>Owner
          <select value={owner} onChange={e => setOwner(e.target.value)}
            style={{ marginLeft: 6, fontSize: 12, padding: '4px 6px', borderRadius: 4, border: '1px solid #d1d5db' }}>
            <option value="">Unassigned</option>
            {(users || []).map(u => <option key={u.id} value={String(u.id)}>{u.name}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 11, color: '#6b7280' }}>Due
          <input type="date" value={due} onChange={e => setDue(e.target.value)}
            style={{ marginLeft: 6, fontSize: 12, padding: '4px 6px', borderRadius: 4, border: '1px solid #d1d5db' }} />
        </label>
        <StagePicker value={stage} onChange={setStage} stages={stages} />
        <label style={{ fontSize: 11, color: '#6b7280', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={gate} onChange={e => setGate(e.target.checked)} /> Gate (blocks go-live)
        </label>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={submit} disabled={saving || !title.trim()} style={{ fontSize: 12, padding: '6px 14px', borderRadius: 4,
          background: (saving || !title.trim()) ? '#9ca3af' : '#0369a1', color: '#fff', border: 'none', fontWeight: 600,
          cursor: (saving || !title.trim()) ? 'default' : 'pointer' }}>
          {saving ? 'Adding…' : 'Add item'}
        </button>
        <button onClick={() => setOpen(false)} style={{ fontSize: 12, padding: '6px 10px', borderRadius: 4,
          background: '#f1f5f9', color: '#374151', border: 'none', cursor: 'pointer' }}>Cancel</button>
      </div>
    </div>
  );
}

// ── StakeholderSection ────────────────────────────────────────────────────────

function ProjectMembersSection({ handoverId, members, isAdmin, canRequest, onRefresh, onOpenMember,
                                serviceOwnerId = null, managerLabel = 'Project Manager' }) {
  // The stored custom_role for the accountable person is the literal string
  // 'Project owner'. That string is an internal marker — the demote query keys
  // on it, so renaming it would break ownership handling — but it must not leak
  // into the UI, or the same person reads as "Project Manager" in the header and
  // "Project owner" in this list.
  //
  // Derived from serviceOwnerId rather than by string-matching the stored role,
  // so the two can never disagree.
  const displayRole = (m) => (
    serviceOwnerId && m.userId === serviceOwnerId
      ? managerLabel
      : (m.roleName || m.customRole || '—')
  );

  const [adding, setAdding]   = useState(false);
  const [users, setUsers]     = useState([]);
  const [roles, setRoles]     = useState([]);
  const [userId, setUserId]   = useState('');
  const [byEmail, setByEmail] = useState(false);
  const [email, setEmail]     = useState('');
  const [roleId, setRoleId]   = useState('');
  const [err, setErr]         = useState('');
  const [msg, setMsg]         = useState('');
  const [rejecting, setRejecting] = useState({});

  useEffect(() => {
    // Roles are needed for editing an existing member too, not just for adding,
    // so this no longer waits on `adding`.
    apiService.handovers.orgRoles().then(r => setRoles(r.data.roles || r.data || [])).catch(() => setRoles([]));
    if (!adding) return;
    apiService.handovers.assignableUsers().then(r => setUsers(r.data.users || [])).catch(() => setUsers([]));
  }, [adding]);

  const [editing, setEditing] = useState(null);

  const refresh = async () => { if (onRefresh) await onRefresh(); };

  // Change an existing member's role. The PATCH endpoint is new — before it
  // there was no way to do this at all, which also left "restore a prior role
  // after a Project Manager demotion" with no mechanism behind it.
  // Saved on blur so a half-typed number is never submitted. An empty value
  // clears the field rather than erroring.
  const saveContact = async (mid, patch) => {
    setErr('');
    try {
      await apiService.handovers.updateMemberContact(handoverId, mid, patch);
      await refresh();
    } catch (e) {
      setErr(e?.response?.data?.error?.message || 'Could not save that number.');
    }
  };

  const saveRole = async (mid, roleId) => {
    setErr('');
    try {
      await apiService.handovers.updateMember(handoverId, mid, { roleId: roleId || null });
      setEditing(null);
      await refresh();
    } catch (e) { setErr(e?.response?.data?.error?.message || 'Could not change the role.'); }
  };

  const request = async () => {
    setErr(''); setMsg('');
    try {
      if (byEmail) {
        if (!email.trim()) { setErr('Enter an email.'); return; }
        await apiService.handovers.requestMember(handoverId, { email: email.trim(), roleId: roleId || null });
        setMsg('Invitation requested — an admin will approve, then an email goes out to set up their account.');
      } else {
        if (!userId) { setErr('Pick a user.'); return; }
        const r = await apiService.handovers.requestMember(handoverId, { userId, roleId: roleId || null });
        setMsg(r.data.autoApproved ? 'Added — same-domain user with a seat available, auto-approved.' : 'Request sent to an admin for approval.');
      }
      setUserId(''); setEmail(''); setRoleId(''); setByEmail(false); setAdding(false); await refresh();
    } catch (e) { setErr(e?.response?.data?.error?.message || 'Could not request.'); }
  };
  const review = async (mid, action) => {
    setErr('');
    const reason = (rejecting[mid] || '').trim();
    if (action === 'reject' && !reason) { setErr('Enter a rejection reason.'); return; }
    try { await apiService.handovers.reviewMember(handoverId, mid, { action, reason }); setRejecting(x => ({ ...x, [mid]: undefined })); await refresh(); }
    catch (e) { setErr(e?.response?.data?.error?.message || 'Could not update.'); }
  };
  const remove = async (mid) => { try { await apiService.handovers.removeMember(handoverId, mid); await refresh(); } catch (e) { setErr(e?.response?.data?.error?.message || 'Could not remove.'); } };

  const inp = { fontSize: 12, padding: '5px 8px', borderRadius: 6, border: '1px solid #d1d5db' };
  const badge = (t, bg, fg) => <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 999, background: bg, color: fg, textTransform: 'uppercase', letterSpacing: 0.3 }}>{t}</span>;

  return (
    <div style={{ marginTop: 12, borderTop: '1px solid #f3f4f6', paddingTop: 10 }}>
      {members.map(m => (
        <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0',
          opacity: m.status === 'approved' ? 1 : 0.7 }}>
          <div style={{ flex: 1, fontSize: 13 }}>
            {/* Opens the same person drawer as the avatar grid above, so both
                team lists behave alike. */}
            <button onClick={() => onOpenMember && m.userId && onOpenMember(m)}
              style={{ fontWeight: 600, background: 'none', border: 'none', padding: 0,
                       cursor: onOpenMember && m.userId ? 'pointer' : 'default',
                       color: '#111827', fontSize: 13 }}>{m.name}</button>
            {isAdmin ? (
              <button
                onClick={() => setEditing(x => (x === m.id ? null : m.id))}
                title="Change this person's role"
                style={{ marginLeft: 8, fontSize: 11, color: '#0369a1', background: 'none',
                         border: 'none', borderBottom: '1px dashed #93c5fd', padding: 0, cursor: 'pointer' }}>
                {displayRole(m)}
              </button>
            ) : (
              <span style={{ marginLeft: 8, fontSize: 11, color: '#6b7280' }}>{displayRole(m)}</span>
            )}
            {m.side === 'internal_customer' && (
              <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, padding: '1px 7px',
                             borderRadius: 999, background: '#f5f3ff', color: '#6d28d9',
                             textTransform: 'uppercase', letterSpacing: 0.3 }}>internal customer</span>
            )}
            {editing === m.id && (
              <div style={{ marginTop: 6, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <select defaultValue={m.roleId || ''} onChange={e => saveRole(m.id, e.target.value)} style={inp}>
                  <option value="">No role</option>
                  {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>

                {/* On an internal project the team IS users, and a user could
                    only ever edit their own phone — so a member with no number
                    could not be reached and nobody could fix it. Email stays
                    read-only: it is the login identity, not a contact detail. */}
                <input
                  defaultValue={m.phone || ''}
                  onBlur={e => saveContact(m.id, { phone: e.target.value })}
                  placeholder="+91 7207583441"
                  title="Phone — include the country code"
                  style={{ ...inp, width: 150 }} />
                <input
                  defaultValue={m.whatsappPhone || ''}
                  onBlur={e => saveContact(m.id, { whatsappPhone: e.target.value })}
                  placeholder="WhatsApp (if different)"
                  style={{ ...inp, width: 170 }} />
                <span style={{ fontSize: 11, color: '#9ca3af' }}>
                  {m.email} · email is changed in account settings
                </span>

                <button onClick={() => setEditing(null)} style={{ fontSize: 11, padding: '3px 9px',
                  borderRadius: 4, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer' }}>Done</button>
              </div>
            )}
            {m.status === 'pending'  && <span style={{ marginLeft: 8 }}>{badge('pending', '#fef3c7', '#92400e')}</span>}
            {m.status === 'rejected' && <span style={{ marginLeft: 8 }}>{badge('rejected', '#fee2e2', '#991b1b')}</span>}
            {m.status === 'rejected' && m.reviewReason && <div style={{ fontSize: 11, color: '#991b1b' }}>Reason: {m.reviewReason}</div>}
          </div>
          {isAdmin && m.status === 'pending' && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <button onClick={() => review(m.id, 'approve')} style={{ fontSize: 11, padding: '3px 10px', borderRadius: 5, border: 'none', background: '#059669', color: '#fff', cursor: 'pointer' }}>Approve</button>
              <input value={rejecting[m.id] || ''} onChange={e => setRejecting(x => ({ ...x, [m.id]: e.target.value }))} placeholder="reason" style={{ ...inp, width: 120 }} />
              <button onClick={() => review(m.id, 'reject')} style={{ fontSize: 11, padding: '3px 10px', borderRadius: 5, border: '1px solid #fca5a5', background: '#fff', color: '#991b1b', cursor: 'pointer' }}>Reject</button>
            </div>
          )}
          {isAdmin && m.status !== 'pending' && (
            <button onClick={() => remove(m.id)} title="Remove" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', fontSize: 12 }}>✕</button>
          )}
        </div>
      ))}

      {canRequest && !adding && (
        <button onClick={() => { setAdding(true); setMsg(''); setErr(''); }} style={{ marginTop: 6, fontSize: 12, padding: '4px 10px', borderRadius: 4, background: '#eff6ff', color: '#1d4ed8', border: '1px dashed #93c5fd', cursor: 'pointer' }}>+ Add team member</button>
      )}
      {adding && (
        <div style={{ marginTop: 8, padding: 10, background: '#f8fafc', borderRadius: 8, border: '1px solid #e5e7eb', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ display: 'inline-flex', border: '1px solid #d1d5db', borderRadius: 6, overflow: 'hidden' }}>
            {[['existing', 'Existing user'], ['new', 'New by email']].map(([k, label]) => (
              <button key={k} onClick={() => { setByEmail(k === 'new'); setErr(''); }} style={{ padding: '4px 10px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer', background: (byEmail === (k === 'new')) ? '#1d4ed8' : '#fff', color: (byEmail === (k === 'new')) ? '#fff' : '#374151' }}>{label}</button>
            ))}
          </div>
          {byEmail ? (
            <input value={email} onChange={e => setEmail(e.target.value)} placeholder="colleague@company.com" style={{ ...inp, minWidth: 200 }} />
          ) : (
            <select value={userId} onChange={e => setUserId(e.target.value)} style={inp}>
              <option value="">Select user…</option>
              {users.map(u => <option key={u.id} value={u.id}>{u.name || `${u.first_name} ${u.last_name}`}{u.email ? ` · ${u.email}` : ''}</option>)}
            </select>
          )}
          <select value={roleId} onChange={e => setRoleId(e.target.value)} style={inp}>
            <option value="">Role (optional)…</option>
            {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <button onClick={request} style={{ fontSize: 12, padding: '5px 12px', borderRadius: 6, border: 'none', background: '#1d4ed8', color: '#fff', cursor: 'pointer' }}>Request</button>
          <button onClick={() => { setAdding(false); setErr(''); }} style={{ fontSize: 12, padding: '5px 10px', borderRadius: 6, border: 'none', background: '#f1f5f9', color: '#374151', cursor: 'pointer' }}>Cancel</button>
          {byEmail && <div style={{ fontSize: 11, color: '#6b7280', width: '100%' }}>New users are invited by email after an admin approves; they'll get access to this project's module.</div>}
        </div>
      )}
      {msg && <div style={{ fontSize: 11, color: '#059669', marginTop: 6 }}>{msg}</div>}
      {err && <div style={{ fontSize: 11, color: '#991b1b', marginTop: 6 }}>{err}</div>}
    </div>
  );
}

// StakeholderSection was replaced by ProjectPeoplePanel, which renders the same
// card grouped by side (customer / vendor / partner) and adds the internal
// customer from project_members. Removed rather than left in place: CRA treats
// an unused binding as a warning, and Vercel builds with CI=true turn warnings
// into errors.

function CommitmentRow({ commitment: c, canManage, users, onUpdate, onRemove }) {
  const [editing, setEditing] = useState(false);
  const [dueDate, setDueDate] = useState(c.dueDate ? c.dueDate.slice(0, 10) : '');
  const [status,  setStatus]  = useState(c.status || 'open');
  const [owner,   setOwner]   = useState(c.ownerUserId != null ? String(c.ownerUserId) : '');
  const [note,    setNote]    = useState(c.closureNote || '');
  const [saving,  setSaving]  = useState(false);
  const [rowErr,  setRowErr]  = useState('');

  const typeMeta = COMMITMENT_TYPE_META[c.commitmentType] || COMMITMENT_TYPE_META.promise;
  const noteRequired = NOTE_REQUIRED_STATUSES.includes(status);
  const noteMissing  = noteRequired && !note.trim();

  const resetForm = () => {
    setDueDate(c.dueDate ? c.dueDate.slice(0, 10) : '');
    setStatus(c.status || 'open');
    setOwner(c.ownerUserId != null ? String(c.ownerUserId) : '');
    setNote(c.closureNote || '');
    setRowErr('');
  };

  const handleSave = async () => {
    if (noteMissing) { setRowErr('A note is required when a commitment is waived or breached.'); return; }
    setSaving(true);
    setRowErr('');
    try {
      // Send the fields this row owns. status is always included so the backend
      // stamps closure correctly; closureNote is sent whenever present so the
      // note-required check has it to read.
      const data = {
        dueDate: dueDate || null,
        ownerUserId: owner ? parseInt(owner, 10) : null,
        status,
        ...(note.trim() ? { closureNote: note.trim() } : {}),
      };
      await onUpdate(c.id, data);
      setEditing(false);
    } catch (err) {
      setRowErr(err?.response?.data?.error?.message || 'Could not save changes.');
    } finally { setSaving(false); }
  };

  return (
    <div style={{ padding: '8px 0', borderBottom: '1px solid #f3f4f6' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span style={{ fontSize: 14, marginTop: 1 }}>{typeMeta.icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
              background: typeMeta.bg, color: typeMeta.color }}>
              {typeMeta.label}
            </span>
            <CommitmentStatusPill status={c.status} />
            <DueChip dueDate={c.dueDate} isOverdue={c.isOverdue} daysOverdue={c.daysOverdue} />
          </div>
          <div style={{ fontSize: 13, color: '#111827', marginTop: 4 }}>{c.description}</div>
          {(c.ownerName || c.closureNote) && (
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 3 }}>
              {c.ownerName && <span>Owner: {c.ownerName}</span>}
              {c.ownerName && c.closureNote && <span> · </span>}
              {c.closureNote && <span>Note: {c.closureNote}</span>}
            </div>
          )}
        </div>
        {canManage && !editing && (
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <button onClick={() => { resetForm(); setEditing(true); }} style={{
              background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: '#0369a1', fontWeight: 600,
            }}>Edit</button>
            <button onClick={() => onRemove(c.id)} title="Remove" style={{
              background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: '#ef4444',
            }}>✕</button>
          </div>
        )}
      </div>

      {canManage && editing && (
        <div style={{ marginTop: 8, marginLeft: 24, padding: 10, background: '#f8fafc', borderRadius: 8, border: '1px solid #e5e7eb' }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
            <div>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>Due date</div>
              <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} disabled={saving}
                style={{ fontSize: 12, padding: '4px 8px', borderRadius: 4, border: '1px solid #d1d5db' }} />
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>Status</div>
              <select value={status} onChange={e => setStatus(e.target.value)} disabled={saving}
                style={{ fontSize: 12, padding: '4px 8px', borderRadius: 4, border: '1px solid #d1d5db' }}>
                {COMMITMENT_STATUS_ORDER.map(k => (
                  <option key={k} value={k}>{COMMITMENT_STATUS_META[k].label}</option>
                ))}
              </select>
            </div>
            <div style={{ minWidth: 150 }}>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>Owner</div>
              <select value={owner} onChange={e => setOwner(e.target.value)} disabled={saving}
                style={{ fontSize: 12, padding: '4px 8px', borderRadius: 4, border: '1px solid #d1d5db', maxWidth: 200 }}>
                <option value="">Unassigned</option>
                {(users || []).map(u => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </select>
            </div>
          </div>
          {noteRequired && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>
                Closure note <span style={{ color: '#dc2626' }}>(required for {COMMITMENT_STATUS_META[status].label.toLowerCase()})</span>
              </div>
              <textarea value={note} onChange={e => setNote(e.target.value)} disabled={saving} rows={2}
                placeholder="Explain why this commitment was waived or breached…"
                style={{ width: '100%', fontSize: 12, padding: '6px 8px', borderRadius: 4, border: '1px solid #d1d5db', resize: 'vertical', boxSizing: 'border-box' }} />
            </div>
          )}
          {rowErr && (
            <div style={{ marginBottom: 8, padding: '5px 8px', background: '#fee2e2', borderRadius: 4, fontSize: 11, color: '#991b1b' }}>{rowErr}</div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleSave} disabled={saving || noteMissing} style={{
              fontSize: 12, padding: '4px 12px', borderRadius: 4, border: 'none',
              background: noteMissing ? '#e5e7eb' : '#0369a1', color: noteMissing ? '#9ca3af' : '#fff',
              cursor: saving || noteMissing ? 'not-allowed' : 'pointer',
            }}>{saving ? 'Saving…' : 'Save'}</button>
            <button onClick={() => { setEditing(false); resetForm(); }} disabled={saving} style={{
              fontSize: 12, padding: '4px 10px', borderRadius: 4, background: '#f1f5f9', color: '#374151', border: 'none', cursor: 'pointer',
            }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── CommitmentsSection ────────────────────────────────────────────────────────

function CommitmentsSection({ commitments, canManage, users, onAdd, onUpdate, onRemove }) {
  const [adding,  setAdding]  = useState(false);
  const [desc,    setDesc]    = useState('');
  const [type,    setType]    = useState('promise');
  const [dueDate, setDueDate] = useState('');
  const [owner,   setOwner]   = useState('');
  const [saving,  setSaving]  = useState(false);

  const handleAdd = async () => {
    if (!desc.trim()) return;
    setSaving(true);
    try {
      await onAdd({
        description: desc.trim(),
        commitmentType: type,
        dueDate: dueDate || null,
        ownerUserId: owner ? parseInt(owner, 10) : null,
      });
      setDesc(''); setType('promise'); setDueDate(''); setOwner(''); setAdding(false);
    } finally { setSaving(false); }
  };

  return (
    <div>
      {commitments.length === 0 && !adding && (
        <div style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic', marginBottom: 8 }}>
          No commitments, risks, or flags recorded.
        </div>
      )}
      {commitments.map(c => (
        <CommitmentRow
          key={c.id}
          commitment={c}
          canManage={canManage}
          users={users}
          onUpdate={onUpdate}
          onRemove={onRemove}
        />
      ))}
      {canManage && !adding && (
        <button onClick={() => setAdding(true)} style={{
          marginTop: 8, fontSize: 12, padding: '4px 10px', borderRadius: 4,
          background: '#f0f9ff', color: '#0369a1', border: '1px dashed #93c5fd', cursor: 'pointer',
        }}>
          + Add commitment / risk
        </button>
      )}
      {canManage && adding && (
        <div style={{ marginTop: 10, padding: 12, background: '#f8fafc', borderRadius: 8, border: '1px solid #e5e7eb' }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            {Object.entries(COMMITMENT_TYPE_META).map(([k, v]) => (
              <button key={k} onClick={() => setType(k)} style={{
                fontSize: 11, padding: '3px 10px', borderRadius: 4, border: '1px solid',
                borderColor: type === k ? v.color : '#d1d5db',
                background: type === k ? v.bg : '#fff',
                color: type === k ? v.color : '#374151',
                cursor: 'pointer', fontWeight: type === k ? 700 : 400,
              }}>{v.icon} {v.label}</button>
            ))}
          </div>
          <textarea value={desc} onChange={e => setDesc(e.target.value)} disabled={saving}
            placeholder="Describe the commitment, risk, or flag…" rows={2}
            style={{ width: '100%', fontSize: 12, padding: '6px 8px', borderRadius: 4, border: '1px solid #d1d5db', resize: 'vertical', boxSizing: 'border-box' }} />
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginTop: 8, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>Due date (optional)</div>
              <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} disabled={saving}
                style={{ fontSize: 12, padding: '4px 8px', borderRadius: 4, border: '1px solid #d1d5db' }} />
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>Owner (optional)</div>
              <select value={owner} onChange={e => setOwner(e.target.value)} disabled={saving}
                style={{ fontSize: 12, padding: '4px 8px', borderRadius: 4, border: '1px solid #d1d5db', maxWidth: 200 }}>
                <option value="">Unassigned</option>
                {(users || []).map(u => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </select>
            </div>
            <button onClick={handleAdd} disabled={saving || !desc.trim()} style={{
              fontSize: 12, padding: '4px 12px', borderRadius: 4, background: '#0369a1', color: '#fff', border: 'none', cursor: 'pointer',
            }}>{saving ? 'Adding…' : 'Add'}</button>
            <button onClick={() => setAdding(false)} disabled={saving} style={{
              fontSize: 12, padding: '4px 10px', borderRadius: 4, background: '#f1f5f9', color: '#374151', border: 'none', cursor: 'pointer',
            }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── DeliverableRollup ─────────────────────────────────────────────────────────
// Compact summary line fed by /can-close's rollup. Present whenever we have a
// rollup (i.e. the handover is past draft and not terminal).

function DeliverableRollup({ rollup, isStanding = false }) {
  if (!rollup) return null;
  const n = (v) => Number(v || 0);
  const playsDone   = n(rollup.plays_done);
  const playsTotal  = n(rollup.plays_total);
  const playsOver   = n(rollup.plays_overdue);
  const gatesOpen   = n(rollup.gates_open);
  const cClosed     = n(rollup.commitments_closed);
  const cTotal      = n(rollup.commitments_total);
  const cOver       = n(rollup.commitments_overdue);
  const days        = rollup.days_to_go_live;

  const chip = (text, danger) => (
    <span style={{
      fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
      background: danger ? '#fee2e2' : '#eef2ff', color: danger ? '#991b1b' : '#3730a3',
    }}>{text}</span>
  );

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
      {chip(`${playsDone}/${playsTotal} sections done`)}
      {gatesOpen > 0 && chip(`${gatesOpen} gate${gatesOpen === 1 ? '' : 's'} open`, true)}
      {chip(`${cClosed}/${cTotal} commitments closed`)}
      {(playsOver + cOver) > 0 && chip(`${playsOver + cOver} overdue`, true)}
      {/* Never for a standing initiative: there is no date to count toward, so
          the chip would either be absent (fine) or, if a stale one survived a
          conversion, actively wrong. */}
      {days != null && !isStanding && chip(
        days >= 0 ? `Go-live in ${days}d` : `Go-live ${Math.abs(days)}d ago`,
        days < 0,
      )}
    </div>
  );
}

// ── HandoverDetail ────────────────────────────────────────────────────────────

/* ── EditableCoreFields ──────────────────────────────────────────────────────
 *
 * The project header's stat strip, with go-live date, contract value and
 * commercial terms editable in place.
 *
 * WHY THIS EXISTS. handoverService.update() has always accepted goLiveDate,
 * contractValue and commercialTermsSummary, and no screen ever sent them — the
 * frontend called that endpoint with assignedServiceOwnerId and serviceNotes
 * only. So all three were write-once at project creation, and changing a
 * go-live date meant a hand-written SQL UPDATE. The service's own comment says
 * that is not the intent: editing was deliberately opened up past draft because
 * "a project is a live thing — dates move, owners change, budgets get revised".
 *
 * WHY INLINE RATHER THAN A MODAL. Three fields. A modal for three fields costs
 * a click to open, a click to close, and a mental context switch, to edit
 * numbers the user is already looking at. Clicking the value itself is fewer
 * moving parts and needs no new screen.
 *
 * GATED ON TERMINAL ONLY, matching the backend exactly. update() refuses on
 * completed and cancelled and allows everything else, so the UI does the same
 * rather than inventing a stricter rule the server would not enforce — a button
 * that is hidden when the API would have accepted the call is its own kind of
 * bug.
 */
function EditableCoreFields({ detail, isTerminal, onSaved, fmtDate, fmtCurrency,
                              gatesDone, gatesTotal, ownerLabel }) {
  const [editing, setEditing] = useState(null);   // 'goLive' | 'value' | 'terms' | null
  const [draft,   setDraft]   = useState('');
  const [busy,    setBusy]    = useState(false);
  const [err,     setErr]     = useState('');
  // What moving the go-live just did to the checklist. Shown once, after the
  // save that caused it — a date change now has a consequence somewhere the
  // person is not looking, and silently doing that is how a checklist starts
  // disagreeing with what someone remembers doing.
  const [resched, setResched] = useState(null);

  const dtg = detail.goLiveDate
    // Both sides floored to local midnight: comparing a calendar date against
    // `new Date()` mid-afternoon rounds a same-day go-live up to 1 day away.
    ? Math.ceil((parseLocalDate(detail.goLiveDate) - new Date(new Date().setHours(0, 0, 0, 0))) / 86400000) : null;
  const goLiveText  = dtg == null ? '—' : dtg < 0 ? `${Math.abs(dtg)}d overdue`
                    : dtg === 0 ? 'Today' : `${dtg} days`;
  const goLiveColor = dtg == null ? '#111827' : dtg < 0 ? '#dc2626'
                    : dtg <= 14 ? '#d97706' : '#111827';

  const open = (field, current) => {
    setErr('');
    setDraft(current == null ? '' : String(current));
    setEditing(field);
  };

  const save = async (field) => {
    setBusy(true); setErr('');
    try {
      const body = {};
      if (field === 'goLive') {
        // An empty date is a deliberate clear, but update() uses COALESCE on
        // every column — passing null means "leave unchanged", not "clear".
        // Rather than silently do nothing, say so.
        if (!draft) {
          setErr('Pick a date. Clearing the go-live date is not supported here.');
          setBusy(false); return;
        }
        body.goLiveDate = draft;
      } else if (field === 'value') {
        const n = parseFloat(String(draft).replace(/[^0-9.-]/g, ''));
        if (!Number.isFinite(n) || n < 0) {
          setErr('Enter a number.'); setBusy(false); return;
        }
        body.contractValue = n;
      } else {
        body.commercialTermsSummary = draft.trim() || null;
      }
      const res = await apiService.handovers.update(detail.id, body);
      setEditing(null);
      // Only present when a go-live actually moved; absent on every other save.
      setResched(res?.data?.handover?.reschedule || null);
      await onSaved();
    } catch (e) {
      setErr(e?.response?.data?.error?.message || e.message || 'Could not save.');
    } finally { setBusy(false); }
  };

  const CARD = { flex: 1, minWidth: 120, background: '#fff', border: '1px solid #e5e7eb',
                 borderRadius: 10, padding: '10px 12px' };
  const LABEL = { fontSize: 10, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.3 };
  const INPUT = { fontSize: 14, padding: '4px 6px', border: '1px solid #93c5fd',
                  borderRadius: 5, width: '100%', boxSizing: 'border-box' };

  const statCard = (value, label, color) => (
    <div style={CARD}>
      <div style={{ fontSize: 16, fontWeight: 700, color: color || '#111827' }}>{value}</div>
      <div style={LABEL}>{label}</div>
    </div>
  );

  // An editable card looks identical to a static one until hovered, so the
  // strip does not turn into a wall of pencils. The title attribute carries the
  // affordance for anyone who does not think to click a number.
  const editableCard = (field, value, label, color, inputType) => (
    <div style={{ ...CARD, cursor: isTerminal ? 'default' : 'pointer' }}
         title={isTerminal ? 'A completed or cancelled project cannot be edited' : `Click to edit ${label}`}
         onClick={() => { if (!isTerminal && editing !== field) open(field, draftValueFor(field)); }}>
      {editing === field ? (
        <div onClick={e => e.stopPropagation()}>
          <input
            type={inputType} value={draft} autoFocus disabled={busy}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') save(field);
              if (e.key === 'Escape') { setEditing(null); setErr(''); }
            }}
            style={INPUT}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button onClick={() => save(field)} disabled={busy}
              style={{ fontSize: 11, padding: '3px 10px', borderRadius: 5, border: 'none',
                       background: '#E8630A', color: '#fff', cursor: 'pointer' }}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => { setEditing(null); setErr(''); }} disabled={busy}
              style={{ fontSize: 11, padding: '3px 10px', borderRadius: 5,
                       border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer' }}>
              Cancel
            </button>
          </div>
          {err && <div style={{ fontSize: 11, color: '#dc2626', marginTop: 4 }}>{err}</div>}
        </div>
      ) : (
        <>
          <div style={{ fontSize: 16, fontWeight: 700, color: color || '#111827' }}>{value}</div>
          <div style={LABEL}>
            {label}
            {!isTerminal && <span style={{ marginLeft: 5, color: '#93c5fd', textTransform: 'none' }}>edit</span>}
          </div>
        </>
      )}
    </div>
  );

  // The value the input should start from — the RAW value, not the formatted
  // one. Seeding a currency field with "₹12,00,000" would make the first
  // keystroke produce nonsense.
  function draftValueFor(field) {
    if (field === 'goLive') {
      // NOT new Date(x).toISOString().slice(0,10): that converts to UTC first,
      // so west of UTC the input opened on the previous day and saving it moved
      // the go-live back by one, silently.
      return toInputDate(detail.goLiveDate);
    }
    if (field === 'value') return detail.contractValue ?? '';
    return detail.commercialTermsSummary ?? '';
  }

  return (
    <>
      {/* What the last go-live change did to the checklist. Three outcomes, and
          the middle one is the important one: on a frozen plan nothing moved,
          and if that is not said here the person walks away believing their
          checklist followed the date. */}
      {resched && (resched.rescheduled > 0 || resched.scheduled > 0 || resched.skippedFrozen > 0) && (
        <div style={{
          marginTop: 12, padding: '10px 12px', borderRadius: 8, fontSize: 12, lineHeight: 1.6,
          background: resched.skippedFrozen > 0 ? '#fffbeb' : '#f0f9ff',
          border: `1px solid ${resched.skippedFrozen > 0 ? '#fde68a' : '#bae6fd'}`,
          color: resched.skippedFrozen > 0 ? '#92400e' : '#075985',
          display: 'flex', alignItems: 'flex-start', gap: 8,
        }}>
          <div style={{ flex: 1 }}>
            {resched.scheduled > 0 && (
              <div>
                {resched.scheduled} task{resched.scheduled === 1 ? '' : 's'} scheduled from the new go-live date.
              </div>
            )}
            {resched.rescheduled > 0 && (
              <div>
                {resched.rescheduled} task{resched.rescheduled === 1 ? '' : 's'} moved with it.
                Each change is recorded on the task.
              </div>
            )}
            {resched.skippedFrozen > 0 && (
              <div>
                <strong>{resched.skippedFrozen} task{resched.skippedFrozen === 1 ? '' : 's'} did not move.</strong>{' '}
                This project's plan is frozen, so its dates are a commitment and changing them
                is a rebaseline. Move them individually on the Checklist, with a reason.
              </div>
            )}
          </div>
          <button onClick={() => setResched(null)} aria-label="Dismiss"
            style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'inherit',
                     fontSize: 15, lineHeight: 1, padding: 0 }}>×</button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
        {/* 2026_133. A standing initiative has no go-live, and update() refuses
            to give it one — so an editable date card here would be a control
            whose only outcome is a 400. Replaced by a card that says what this
            thing IS, since that is the question someone landing here has. */}
        {detail.isStanding
          ? statCard('Standing', 'Never completes')
          : editableCard('goLive', goLiveText,
              detail.goLiveDate ? `Go-live · ${fmtDate(detail.goLiveDate)}` : 'Go-live',
              goLiveColor, 'date')}
        {editableCard('value',
          detail.contractValue ? fmtCurrency(detail.contractValue) : '—',
          'Contract value', '#111827', 'number')}
        {detail.serviceOwnerName ? statCard(detail.serviceOwnerName, ownerLabel) : null}
        {gatesTotal > 0 ? statCard(`${gatesDone} / ${gatesTotal}`, 'Gate plays') : null}
      </div>

      {/* Commercial terms is prose, so it gets a row rather than a card. */}
      <div style={{ marginTop: 8 }}>
        {editing === 'terms' ? (
          <div style={{ background: '#fff', border: '1px solid #93c5fd', borderRadius: 8, padding: 10 }}>
            <div style={{ ...LABEL, marginBottom: 4 }}>Commercial terms</div>
            <textarea value={draft} autoFocus disabled={busy} rows={3}
              onChange={e => setDraft(e.target.value)}
              style={{ ...INPUT, fontSize: 13, resize: 'vertical' }} />
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button onClick={() => save('terms')} disabled={busy}
                style={{ fontSize: 11, padding: '3px 10px', borderRadius: 5, border: 'none',
                         background: '#E8630A', color: '#fff', cursor: 'pointer' }}>
                {busy ? 'Saving…' : 'Save'}
              </button>
              <button onClick={() => { setEditing(null); setErr(''); }} disabled={busy}
                style={{ fontSize: 11, padding: '3px 10px', borderRadius: 5,
                         border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer' }}>
                Cancel
              </button>
            </div>
            {err && <div style={{ fontSize: 11, color: '#dc2626', marginTop: 4 }}>{err}</div>}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: '#6b7280', display: 'flex', gap: 6, alignItems: 'baseline' }}>
            <span style={{ fontWeight: 600 }}>Commercial terms:</span>
            <span style={{ color: detail.commercialTermsSummary ? '#374151' : '#9ca3af' }}>
              {detail.commercialTermsSummary || 'Not recorded'}
            </span>
            {!isTerminal && (
              <button onClick={() => open('terms', draftValueFor('terms'))}
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                         color: '#2563eb', fontSize: 12 }}>edit</button>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/**
 * One-shot handoff for "open this project AND focus this task".
 *
 * Module-level rather than a prop or React state, because of an ordering
 * problem neither can solve. The deep-link event arrives at HandoverView,
 * which then has to FETCH the project before HandoverDetail is mounted at
 * all — so at the moment the id is known there is no component to hand it to
 * and no prop to put it on. Parking it here lets whichever side gets there
 * second pick it up.
 *
 * Keyed by handoverId so a stale focus cannot leak onto a different project:
 * click a task, change your mind, open something else, and the claim finds a
 * mismatched key and leaves the value alone rather than expanding a random row.
 *
 * TAKEN, not read. One deep link focuses one task once — leaving it set would
 * re-expand the same row every time the detail remounts, hours later.
 */
let pendingPlayFocus = null;   // { handoverId, playInstanceId } | null

function setPendingPlayFocus(handoverId, playInstanceId) {
  pendingPlayFocus = (handoverId && playInstanceId)
    ? { handoverId, playInstanceId } : null;
  window.dispatchEvent(new CustomEvent('handover-focus-play'));
}

function takePendingPlayFocus(handoverId) {
  if (!pendingPlayFocus || !handoverId) return null;
  if (pendingPlayFocus.handoverId !== handoverId) return null;
  const { playInstanceId } = pendingPlayFocus;
  pendingPlayFocus = null;
  return playInstanceId;
}

function HandoverDetail({ handover: h, onRefresh, viewMode, users, onOpenProject, initialTab, onTabChange, managerLabel = 'Project Manager'}) {
  const [detail,    setDetail]    = useState(null);
  const [canSubmit, setCanSubmit] = useState(false);
  const [closeInfo, setCloseInfo] = useState(null); // { canClose, blockers, rollup }
  const [loading,   setLoading]   = useState(true);
  const [actioning, setActioning] = useState(false);
  const [error,     setError]     = useState('');
  const [success,   setSuccess]   = useState('');
  const [closureFor, setClosureFor] = useState(null); // 'completed' | 'cancelled' | null
  const [menuOpen, setMenuOpen] = useState(false);    // header "⋯" overflow menu
  const [showConvert, setShowConvert] = useState(false);  // tracking mode (2026_133)
  // Checklist layout. Three views now:
  //   compact  — title only, densest (this was 'grid')
  //   table    — task / owner / due / status, the default working view
  //   detailed — full PlaySection with Mark done, evidence, edit, drag-reorder
  //
  // The stored value is validated rather than trusted: a browser holding the
  // old 'grid' string (or anything else) must not render an empty checklist.
  const [checklistLayout, setChecklistLayout] = useState(() => {
    try {
      const v = localStorage.getItem('gw_project_checklist_layout');
      if (v === 'grid') return 'compact';                       // legacy key
      return CHECKLIST_LAYOUTS.some(([k]) => k === v) ? v : 'table';
    } catch { return 'table'; }
  });
  const [expandedPlays, setExpandedPlays] = useState({});

  // The task a deep link asked for. Read from a module-level handoff rather
  // than a prop: HandoverDetail is mounted by HandoverView only AFTER the
  // project resolves, so the event that carried the id fired before this
  // component existed and there was no prop to put it on.
  const [focusPlayId, setFocusPlayId] = useState(null);

  useEffect(() => {
    const claim = () => {
      const id = takePendingPlayFocus(h?.id);
      if (id) setFocusPlayId(id);
    };
    claim();                                   // arrived before we mounted
    window.addEventListener('handover-focus-play', claim);  // or after
    return () => window.removeEventListener('handover-focus-play', claim);
  }, [h?.id]);

  // Open it and bring it into view, once the checklist has actually painted.
  //
  // Waits for the row to EXIST rather than firing on load: the checklist
  // renders after its own fetch, and a scroll issued before that finds
  // nothing and silently does nothing. Retries a few frames, then gives up —
  // the task may sit in a stage group that is collapsed, or have been closed
  // by someone else between the click and the arrival, and neither is worth
  // spinning over.
  useEffect(() => {
    if (!focusPlayId) return;
    setExpandedPlays(prev => ({ ...prev, [focusPlayId]: true }));

    let tries = 0;
    let raf;
    const find = () => {
      const el = document.getElementById(`play-row-${focusPlayId}`);
      if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
      if (++tries < 40) raf = requestAnimationFrame(find);
    };
    raf = requestAnimationFrame(find);
    return () => cancelAnimationFrame(raf);
  }, [focusPlayId]);
  // Project stages, loaded alongside the checklist. Drives the stage picker on
  // both item forms and the stage manager.
  const [stages, setStages] = useState([]);
  const [showStageMgr, setShowStageMgr] = useState(false);
  const [evidencePolicy, setEvidencePolicy] = useState(null);
  const [startReview, setStartReview] = useState(null);   // { preview, loading, target }
  const setLayout = (v) => { setChecklistLayout(v); try { localStorage.setItem('gw_project_checklist_layout', v); } catch { /* ignore */ } };
  const togglePlay = (id) => setExpandedPlays(x => ({ ...x, [id]: !x[id] }));
  const [closureText, setClosureText] = useState('');
  const [detailTab, setDetailTab] = useState(initialTab || 'summary'); // 'summary' | 'details' | 'communications'
  // Keep the parent (and thus the URL hash) in step with the open sub-tab.
  useEffect(() => { onTabChange?.(detailTab); }, [detailTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const detailRes = await apiService.handovers.getById(h.id);
      const d = detailRes.data.handover;
      setDetail(d);

      const isTerminal = d.status === 'completed' || d.status === 'cancelled';

      const [submitRes, closeRes] = await Promise.all([
        d.status === 'draft'
          ? apiService.handovers.canSubmit(h.id)
          : Promise.resolve({ data: { canSubmit: false } }),
        !isTerminal
          ? apiService.handovers.canClose(h.id).catch(() => ({ data: null }))
          : Promise.resolve({ data: null }),
      ]);
      setCanSubmit(submitRes.data?.canSubmit || false);
      setCloseInfo(closeRes.data || null);
    } catch {
      setError('Could not load this project. Try selecting it again.');
    } finally { setLoading(false); }
  }, [h.id]);

  // ── Project stages ────────────────────────────────────────────────────────
  // Declared before the play handlers that call it, and memoised so it can be
  // an effect dependency without re-firing every render.
  const loadStages = useCallback(async () => {
    if (!h?.id) return;
    try {
      const res = await apiService.handovers.listStages(h.id);
      setStages(res.data.stages || []);
    } catch {
      // Non-fatal: the checklist still renders; the picker just offers the
      // ad-hoc bucket alone.
      setStages([]);
    }
  }, [h?.id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadStages(); }, [loadStages]);
  useEffect(() => {
    if (!h?.id) return;
    apiService.handovers.evidencePolicy(h.id)
      .then(r => setEvidencePolicy(r.data))
      // Non-fatal: without a policy the form stays permissive and the server
      // remains the real enforcement point.
      .catch(() => setEvidencePolicy(null));
  }, [h?.id]);

  const flash = (type, msg) => {
    if (type === 'success') { setSuccess(msg); setError(''); }
    else { setError(msg); setSuccess(''); }
    setTimeout(() => { setSuccess(''); setError(''); }, 4000);
  };

  const SUCCESS_MSG = {
    submitted:    'Project submitted',
    draft:        'Project recalled to draft',
    acknowledged: 'Project acknowledged',
    in_progress:  'Project marked in progress',
    completed:    'Project completed',
    cancelled:    'Project cancelled',
  };

  // Leaving draft freezes the plan, so it gets a review step first. Other
  // transitions go straight through — there is nothing to review.
  const requestAction = async (newStatus) => {
    if (!isDraft || newStatus === 'draft') return handleAction(newStatus);
    setStartReview({ preview: null, loading: true, target: newStatus });
    try {
      const r = await apiService.handovers.startPreview(h.id, null);
      setStartReview({ preview: r.data, loading: false, target: newStatus });
    } catch {
      // If the preview cannot be built, do not trap the user — fall back to
      // the direct transition rather than blocking a legitimate action.
      setStartReview(null);
      return handleAction(newStatus);
    }
  };

  const refreshPreview = async (startDate) => {
    setStartReview(st => st && { ...st, loading: true });
    try {
      const r = await apiService.handovers.startPreview(h.id, startDate);
      setStartReview(st => st && { ...st, preview: r.data, loading: false });
    } catch { setStartReview(st => st && { ...st, loading: false }); }
  };

  const handleAction = async (newStatus, closureSummary = null) => {
    setActioning(true);
    try {
      await apiService.handovers.setStatus(h.id, newStatus, closureSummary);
      flash('success', `${SUCCESS_MSG[newStatus] || 'Project updated'} ✓`);
      setClosureFor(null);
      setClosureText('');
      await load();
      onRefresh();
    } catch (err) {
      flash('error', err?.response?.data?.error?.message || 'Action failed');
    } finally { setActioning(false); }
  };

  const submitClosure = () => {
    const target = closureFor;
    if (target === 'cancelled' && !closureText.trim()) return; // required; button is disabled anyway
    handleAction(target, closureText.trim() || null);
  };

  const handleCompletePlay = async (playInstanceId, data) => {
    try {
      await apiService.handovers.completePlay(h.id, playInstanceId, data);
      await load();
    } catch (err) {
      flash('error', err?.response?.data?.error?.message || 'Could not mark that play done');
    }
  };

  const handleAddPlay = async (data) => {
    try {
      await apiService.handovers.addPlay(h.id, data);
      await load();
      // A new stage may have been created inline via the picker.
      await loadStages();
    } catch (err) {
      flash('error', err?.response?.data?.error?.message || 'Could not add that item');
    }
  };

  const handleRemovePlay = async (playInstanceId) => {
    try {
      await apiService.handovers.removePlay(h.id, playInstanceId);
      await load();
    } catch (err) {
      flash('error', err?.response?.data?.error?.message || 'Could not remove that item');
    }
  };

  // Drag-to-reorder state. Held here rather than in PlaySection because a drop
  // is only meaningful relative to its siblings, which only this level knows.
  const [dragPlay,  setDragPlay]  = useState(null);   // { id, stageKey }
  const [dragOver,  setDragOver]  = useState(null);   // instance id being hovered

  // Live note counts, keyed by playInstanceId (2026_120). The counts arriving
  // with the project are correct at load; this overlays them when a note is
  // added or removed, so the row badge stays in step with the open panel
  // without refetching the whole project for a one-line note.
  const [noteCounts, setNoteCounts] = useState({});
  const noteCountChanged = useCallback((instanceId, count) => {
    setNoteCounts(m => (m[instanceId] === count ? m : { ...m, [instanceId]: count }));
  }, []);
  const [dateModal, setDateModal] = useState(null);   // play object
  const [evidModal, setEvidModal] = useState(null);   // play object

  /**
   * Commit a reorder. The server takes the WHOLE stage in its new order and
   * renumbers on a sparse scale, so the list is rebuilt locally first and sent
   * as one array — sending a single moved id would leave the rest interleaved.
   *
   * Reordering across stages is not allowed here: that is a change of phase,
   * which is an explicit edit rather than something a drag should do silently.
   */
  const handleDropPlay = async (targetPlay, stageItems) => {
    const src = dragPlay;
    setDragPlay(null); setDragOver(null);
    if (!src || src.id === targetPlay.id) return;
    if (src.stageKey !== targetPlay.stageKey) {
      flash('error', 'Drag within a stage. To move a play to another stage, edit it.');
      return;
    }

    const ids = stageItems.map(p => p.id);
    const from = ids.indexOf(src.id);
    const to   = ids.indexOf(targetPlay.id);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);

    try {
      await apiService.handovers.reorderPlays(h.id, src.stageKey, ids);
      await load();
    } catch (err) {
      flash('error', err?.response?.data?.error?.message || 'Could not reorder the checklist');
    }
  };

  const handleSaveStages = async (rows) => {
    await apiService.handovers.updateStages(h.id, rows);
    await loadStages();
    await load();          // stage names are denormalised onto each play
  };

  const handleAddStage = async (name) => {
    await apiService.handovers.addStage(h.id, { name });
    await loadStages();
  };

  const handleRemoveStage = async (key) => {
    await apiService.handovers.removeStage(h.id, key);
    await loadStages();
    await load();
  };

  // Start / pause. Separate from handleUpdatePlay so a status flip does not
  // reload the stage list — nothing about stages changes.
  // 2026_118 item 7: duplicate a row. Copies the plan-shaped fields (stage,
  // owner, gate, offset) but deliberately NOT status, completion or
  // dependencies — a copy is a new piece of work, not a clone of progress,
  // and inheriting depends_on would silently make the copy blocked.
  const handleDuplicatePlay = async (play) => {
    try {
      await apiService.handovers.addPlay(h.id, {
        title: `${play.title} (copy)`,
        description: play.description || undefined,
        dueDate: play.dueDate || undefined,
        ownerUserId: play.ownerUserId || undefined,
        isGate: play.isGate === true,
        stageKey: play.stageKey || undefined,
      });
      await load();
      await loadStages();
    } catch (err) {
      flash('error', err?.response?.data?.error?.message || 'Could not duplicate that task');
    }
  };

  const handleDeletePlay = async (play) => {
    // eslint-disable-next-line no-restricted-globals
    if (!window.confirm(`Delete "${play.title}"? This cannot be undone.`)) return;
    try {
      await apiService.handovers.removePlay(h.id, play.playInstanceId);
      await load();
      await loadStages();
    } catch (err) {
      flash('error', err?.response?.data?.error?.message || 'Could not delete that task');
    }
  };

  // Inline edit from the Table view. Sends only the changed field, so a
  // title edit cannot accidentally clear a due date.
  const handleInlineSave = async (playInstanceId, field, value) => {
    try {
      await apiService.handovers.updatePlay(h.id, playInstanceId, { [field]: value });
      await load();
    } catch (err) {
      flash('error', err?.response?.data?.error?.message || 'Could not save that change');
    }
  };

  const handleSetPlayDeps = async (playInstanceId, dependsOn) => {
    try {
      await apiService.handovers.setPlayDependencies(h.id, playInstanceId, dependsOn);
      await load();
    } catch (err) {
      flash('error', err?.response?.data?.error?.message || 'Could not save dependencies');
      throw err;   // let saveEdit know not to close the form on failure
    }
  };

  const handleSetPlayStatus = async (playInstanceId, status) => {
    try {
      await apiService.handovers.updatePlay(h.id, playInstanceId, { status });
      await load();
    } catch (err) {
      flash('error', err?.response?.data?.error?.message || 'Could not update that task');
    }
  };

  // ── Review loop (2026_130) ────────────────────────────────────────────────
  // One piece of state for all three modes. The modal decides what to render;
  // this only decides which task and which mode.
  const [reviewModal, setReviewModal] = useState(null);   // { play, mode }

  const openReview = (play, mode) => setReviewModal({ play, mode });

  // The Approve view offers "Send back", which is a different mode on the same
  // task. Swapping mode in place keeps the task selected rather than closing
  // and asking the manager to find the row again.
  const handleReviewDone = (next) => {
    if (next === 'reject') {
      setReviewModal(m => (m ? { ...m, mode: 'reject' } : null));
      return;
    }
    setReviewModal(null);
    load();
  };

  const handleUpdatePlay = async (playInstanceId, data) => {
    try {
      await apiService.handovers.updatePlay(h.id, playInstanceId, data);
      await load();
      await loadStages();   // moving a task changes each stage's in-use count
    } catch (err) {
      flash('error', err?.response?.data?.error?.message || 'Could not save your changes');
    }
  };

  const handleAddCommitment = async (data) => {
    await apiService.handovers.addCommitment(h.id, data);
    await load();
  };

  const handleUpdateCommitment = async (commitmentId, data) => {
    // Let errors propagate so CommitmentRow can surface the backend message
    // (e.g. "closureNote is required…") inline rather than swallowing it.
    await apiService.handovers.updateCommitment(h.id, commitmentId, data);
    await load();
  };

  const handleRemoveCommitment = async (commitmentId) => {
    await apiService.handovers.removeCommitment(h.id, commitmentId);
    await load();
  };

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 24, color: '#6b7280', fontSize: 13 }}>
      <div style={{ width: 16, height: 16, border: '2px solid #e5e7eb', borderTopColor: '#0369a1', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
      Loading…
    </div>
  );

  if (!detail) return <div style={{ padding: 24, color: '#9ca3af', fontSize: 13 }}>Could not load project.</div>;

  // Derived
  // "Sales-side" actions — submit a project, pull it back to draft — used to
  // mean "you are on the 'mine' tab". With that tab hidden by default those
  // buttons became unreachable, which would have stranded every draft project
  // in draft forever. Any working view now qualifies; the dashboard is
  // read-only and does not.
  // A project may override what its accountable person is called; otherwise the
  // org default applies.
  const ownerLabel = detail.managerLabel || managerLabel;

  // 2026_130 — may the viewer work a given task? Mirrors
  // playReview.resolveActorRole on the server, which is the actual enforcement;
  // this only decides whether to render a control or a read-only row. An
  // unassigned task (ownerUserId null) is manager-only, so the null check is
  // load-bearing — without it every unassigned task would look actionable to
  // everyone.
  //
  // MUST stay below the `if (!detail)` guard above. `detail` is useState(null)
  // and only fills in after load(), so reading detail.canReviewPlays any
  // earlier throws on the very first render — which is exactly what it did.
  // The useState and the two handlers stay above the guard because hooks
  // cannot sit behind a conditional return; these three are plain derivations
  // and belong here with ownerLabel and the status flags.
  const canReviewPlays = detail.canReviewPlays === true;
  const viewerUserId   = detail.viewerUserId ?? readCurrentUserId();
  const canActOnPlay   = (play) =>
    canReviewPlays
    || (play?.ownerUserId != null && Number(play.ownerUserId) === Number(viewerUserId));

  const isSalesView    = viewMode !== 'dashboard';
  const isServiceView  = viewMode === 'assigned';
  // Internal projects have no counterparty, so they skip submitted/acknowledged
  // and go straight from draft to in_progress. See INTERNAL_TRANSITIONS.
  const isInternal     = detail.projectKind === 'internal';
  const isDraft        = detail.status === 'draft';
  const isSubmitted    = detail.status === 'submitted';
  const isAcknowledged = detail.status === 'acknowledged';
  const isInProgress   = detail.status === 'in_progress';
  const isTerminal     = detail.status === 'completed' || detail.status === 'cancelled';

  // Editing a draft used to require being on the 'mine' tab (From My Deals).
  // That tab is hidden by default, so hiding it removed the only route to
  // editing any project — navigation was doing the job of permission.
  //
  // The backend has never gated update() on ownership; it allows any org member
  // while the project is a draft. So the real rule is simply "draft, and you
  // are in a working view rather than the read-only dashboard".
  const salesCanEdit   = isDraft && viewMode !== 'dashboard';
  // Commitments are tracked THROUGH implementation, so they stay editable by
  // either side until the handover is terminal. (The backend permits any org
  // member; the two tabs represent the two legitimate actors.)
  const canManageCommitments = !isTerminal;

  const plays        = (detail.plays || []).map(p => (
    noteCounts[p.playInstanceId] != null
      ? { ...p, noteCount: noteCounts[p.playInstanceId] }
      : p));
  const commitments  = detail.commitments  || [];

  const gatePlays  = plays.filter(p => p.isGate);
  const gatesTotal = gatePlays.length;
  const gatesDone  = gatePlays.filter(p => isPlayDone(p.status)).length;

  const canComplete   = isServiceView && isInProgress && !!closeInfo?.canClose;
  const completeBlocked = isServiceView && isInProgress && !closeInfo?.canClose;

  return (
    <div style={{ padding: '0 0 40px' }}>

      {/* ── Header ─────────────────────────────────────── */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid #e5e7eb', background: '#fafafa' }}>
        <div className="gw-wrap-mobile" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: '0 0 4px', fontSize: 16, color: '#111827', overflowWrap: 'anywhere' }}>
              {detail.projectName || detail.dealName || detail.name || `Project #${detail.id}`}
              {detail.isStanding && (
                <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, padding: '2px 6px',
                               borderRadius: 999, background: '#ede9fe', color: '#5b21b6',
                               textTransform: 'uppercase', letterSpacing: 0.3 }}>Standing</span>
              )}
              {detail.isRetired && (
                <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, padding: '2px 6px',
                               borderRadius: 999, background: '#f1f5f9', color: '#475569',
                               textTransform: 'uppercase', letterSpacing: 0.3 }}>Retired</span>
              )}
            </h3>
            <div style={{ fontSize: 13, color: '#6b7280' }}>{detail.accountName}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, position: 'relative' }}>
            <span style={{ fontSize: 10, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 700 }}>Status</span>
            <StatusBadge status={detail.status} />
            {!isTerminal && (
              <>
                <button onClick={() => setMenuOpen(o => !o)} title="More"
                  style={{ fontSize: 18, lineHeight: 1, padding: '2px 8px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', color: '#6b7280', cursor: 'pointer' }}>⋯</button>
                {menuOpen && (
                  <div style={{ position: 'absolute', top: '110%', right: 0, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, boxShadow: '0 6px 20px rgba(0,0,0,0.12)', zIndex: 20, minWidth: 160, overflow: 'hidden' }}>
                    {/* Conversion, not cancellation: this changes how the work
                        is TRACKED and destroys nothing. Above the destructive
                        item so the two are not adjacent by accident. */}
                    <button onClick={() => { setMenuOpen(false); setShowConvert(true); }}
                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 14px', fontSize: 13, border: 'none', background: '#fff', color: '#5b21b6', cursor: 'pointer' }}
                      onMouseEnter={e => { e.currentTarget.style.background = '#f5f3ff'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = '#fff'; }}>
                      {detail.isStanding ? '→ Make it a project' : '→ Make it standing'}
                    </button>
                    <button onClick={() => { setMenuOpen(false); setClosureFor('cancelled'); setClosureText(''); }}
                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 14px', fontSize: 13, border: 'none', background: '#fff', color: '#b91c1c', cursor: 'pointer' }}
                      onMouseEnter={e => { e.currentTarget.style.background = '#fef2f2'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = '#fff'; }}>
                      {detail.isStanding ? '✕ Cancel initiative' : '✕ Cancel project'}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {showConvert && (
          <ConvertTrackingModeModal
            detail={detail}
            users={users}
            managerLabel={managerLabel}
            onClose={() => setShowConvert(false)}
            onConverted={async () => { setShowConvert(false); await load(); onRefresh(); }}
          />
        )}

        {/* Stat strip — go-live, contract value and commercial terms are
            EDITABLE here.

            These three have always been accepted by handoverService.update()
            and were unreachable from the UI: the frontend only ever called that
            endpoint with assignedServiceOwnerId and serviceNotes. So a go-live
            date could be set at creation and never changed, which is exactly
            what update()'s own comment says the design intends to allow —
            "a project is a live thing — dates move".
            
            Inline on the cards rather than a separate form, because these are
            three fields and a modal for three fields is a worse trade than
            clicking the number you are already looking at. */}
        <EditableCoreFields
          detail={detail}
          isTerminal={isTerminal}
          onSaved={async () => { await load(); onRefresh(); }}
          fmtDate={fmtDate}
          fmtCurrency={fmtCurrency}
          gatesDone={gatesDone}
          gatesTotal={gatesTotal}
          ownerLabel={ownerLabel}
        />

        {/* Status dates (secondary) */}
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 10, fontSize: 11, color: '#6b7280' }}>
          {detail.submittedAt    && <span>Submitted {fmtDate(detail.submittedAt)}</span>}
          {detail.acknowledgedAt && <span>Acknowledged {fmtDate(detail.acknowledgedAt)}</span>}
          {detail.completedAt    && <span>Completed {fmtDate(detail.completedAt)}</span>}
          {detail.cancelledAt    && <span>Cancelled {fmtDate(detail.cancelledAt)}</span>}
        </div>

        {/* ── Awaiting review (2026_130) ─────────────────────────────────
            Derived from `plays`, which the page already holds, rather than
            calling GET /review-queue. The endpoint exists for callers that do
            not have the checklist loaded; here a second fetch would only
            introduce a way for the banner and the checklist to disagree.

            Shown to everyone, actionable only for a manager. A site engineer
            seeing "3 awaiting review" knows their submission is queued behind
            others, which is worth more than hiding it from them. */}
        <ReviewQueueBanner
          plays={plays}
          isManager={canReviewPlays}
          onOpen={(play) => openReview(play, 'approve')}
        />

        {/* Closure summary (esp. cancellation reason, which is required) */}
        {isTerminal && detail.closureSummary && (
          <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 6, fontSize: 12,
            background: detail.status === 'cancelled' ? '#fef2f2' : '#f0fdf4',
            border: `1px solid ${detail.status === 'cancelled' ? '#fecaca' : '#d1fae5'}`,
            color: '#374151' }}>
            <span style={{ color: '#6b7280', fontWeight: 600 }}>
              {detail.status === 'cancelled' ? 'Cancellation reason: ' : 'Closing note: '}
            </span>
            {detail.closureSummary}
          </div>
        )}

        {/* Deliverable rollup (past draft, not terminal) */}
        {!isDraft && !isTerminal && <DeliverableRollup rollup={closeInfo?.rollup} isStanding={detail?.isStanding === true} />}

        {/* Gate progress */}
        {gatesTotal > 0 && !isTerminal && (
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#6b7280', marginBottom: 4 }}>
              <span>Gate plays</span>
              <span>{gatesDone}/{gatesTotal} complete</span>
            </div>
            <div style={{ height: 6, background: '#e5e7eb', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{
                height: '100%', borderRadius: 3, transition: 'width 0.3s',
                background: gatesDone === gatesTotal ? '#059669' : '#0369a1',
                width: `${gatesTotal > 0 ? (gatesDone / gatesTotal) * 100 : 0}%`,
              }} />
            </div>
          </div>
        )}

        {startReview && (
          <StartReviewModal
            preview={startReview.preview}
            loading={startReview.loading}
            actionLabel={isInternal ? '▶️ Start project' : '📤 Submit project'}
            onCancel={() => setStartReview(null)}
            onConfirm={async (startDate) => {
              // Never commit without a preview on screen. The button is disabled
              // while loading, but that is a UI guard only — this is the rule.
              // Committing blind would freeze the baseline the review exists to
              // let the user check.
              if (!startReview.preview) return;
              // Re-preview if the date moved, so the user confirms what they saw.
              if (startDate !== startReview.preview.startDate) {
                await refreshPreview(startDate);
                return;
              }
              const target = startReview.target;
              setStartReview(null);
              await handleAction(target);
            }}
          />
        )}

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
          {isSalesView && isDraft && (
            <button onClick={() => requestAction(isInternal ? 'in_progress' : 'submitted')}
              disabled={actioning || !canSubmit}
              title={!canSubmit ? `Complete all gate plays before ${isInternal ? 'starting' : 'submitting'}` : ''}
              style={{
                fontSize: 12, padding: '6px 14px', borderRadius: 6, fontWeight: 600, border: 'none',
                background: canSubmit ? '#0369a1' : '#e5e7eb',
                color: canSubmit ? '#fff' : '#9ca3af',
                cursor: actioning || !canSubmit ? 'not-allowed' : 'pointer',
              }}>
              {actioning
                ? (isInternal ? '⏳ Starting…' : '⏳ Submitting…')
                : (isInternal ? '▶️ Start project' : '📤 Submit project')}
            </button>
          )}
          {isSalesView && isSubmitted && (
            <button onClick={() => handleAction('draft')} disabled={actioning} style={{
              fontSize: 12, padding: '6px 14px', borderRadius: 6, fontWeight: 600, border: 'none',
              background: '#fef3c7', color: '#92400e', cursor: actioning ? 'not-allowed' : 'pointer',
            }}>
              {actioning ? '⏳…' : '↩ Recall to draft'}
            </button>
          )}
          {isServiceView && isSubmitted && (
            <button onClick={() => handleAction('acknowledged')} disabled={actioning} style={{
              fontSize: 12, padding: '6px 14px', borderRadius: 6, fontWeight: 600, border: 'none',
              background: '#0369a1', color: '#fff', cursor: actioning ? 'not-allowed' : 'pointer',
            }}>
              {actioning ? '⏳…' : '👁 Acknowledge'}
            </button>
          )}
          {isServiceView && isAcknowledged && (
            <button onClick={() => handleAction('in_progress')} disabled={actioning} style={{
              fontSize: 12, padding: '6px 14px', borderRadius: 6, fontWeight: 600, border: 'none',
              background: '#059669', color: '#fff', cursor: actioning ? 'not-allowed' : 'pointer',
            }}>
              {actioning ? '⏳…' : '▶ Mark in progress'}
            </button>
          )}
          {isServiceView && isInProgress && (
            <button onClick={() => { setClosureFor('completed'); setClosureText(''); }}
              disabled={actioning || !canComplete}
              title={completeBlocked ? 'Resolve the blockers below before completing' : ''}
              style={{
                fontSize: 12, padding: '6px 14px', borderRadius: 6, fontWeight: 600, border: 'none',
                background: canComplete ? '#059669' : '#e5e7eb',
                color: canComplete ? '#fff' : '#9ca3af',
                cursor: actioning || !canComplete ? 'not-allowed' : 'pointer',
              }}>
              ✅ Complete project
            </button>
          )}
          {/* Cancel moved to the "⋯" overflow menu in the header */}
        </div>

        {/* Blockers explaining a disabled Complete button */}
        {completeBlocked && closeInfo?.blockers?.length > 0 && (
          <div style={{ marginTop: 10, padding: '8px 12px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, fontSize: 12, color: '#92400e' }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>Before this project can be completed:</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {closeInfo.blockers.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
          </div>
        )}

        {/* Inline closure prompt (complete = optional note, cancel = required) */}
        {closureFor && (
          <div style={{ marginTop: 12, padding: 12, background: '#f8fafc', borderRadius: 8, border: '1px solid #e5e7eb' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6 }}>
              {closureFor === 'cancelled' ? 'Cancel this project' : 'Complete this project'}
            </div>
            <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6 }}>
              {closureFor === 'cancelled'
                ? 'Cancelling ends the delivery commitment. A reason is required and stays on the record.'
                : 'Add an optional closing note for the record.'}
            </div>
            <textarea value={closureText} onChange={e => setClosureText(e.target.value)} rows={2}
              placeholder={closureFor === 'cancelled' ? 'Why is this project being cancelled?' : 'Closing note (optional)'}
              style={{ width: '100%', fontSize: 12, padding: '6px 8px', borderRadius: 4, border: '1px solid #d1d5db', resize: 'vertical', boxSizing: 'border-box' }} />
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button onClick={submitClosure}
                disabled={actioning || (closureFor === 'cancelled' && !closureText.trim())}
                style={{
                  fontSize: 12, padding: '5px 14px', borderRadius: 4, border: 'none', fontWeight: 600,
                  background: closureFor === 'cancelled'
                    ? (closureText.trim() ? '#b91c1c' : '#e5e7eb')
                    : '#059669',
                  color: closureFor === 'cancelled' && !closureText.trim() ? '#9ca3af' : '#fff',
                  cursor: actioning || (closureFor === 'cancelled' && !closureText.trim()) ? 'not-allowed' : 'pointer',
                }}>
                {actioning ? '⏳…' : closureFor === 'cancelled' ? 'Confirm cancel' : 'Confirm complete'}
              </button>
              <button onClick={() => { setClosureFor(null); setClosureText(''); }} disabled={actioning} style={{
                fontSize: 12, padding: '5px 10px', borderRadius: 4, background: '#f1f5f9', color: '#374151', border: 'none', cursor: 'pointer',
              }}>Back</button>
            </div>
          </div>
        )}

        {error   && <div style={{ marginTop: 10, padding: '6px 10px', background: '#fee2e2', borderRadius: 6, fontSize: 12, color: '#991b1b' }}>{error}</div>}
        {success && <div style={{ marginTop: 10, padding: '6px 10px', background: '#dcfce7', borderRadius: 6, fontSize: 12, color: '#065f46' }}>{success}</div>}
      </div>

      {/* ── Left rail ─────────────────────────────────────
          Replaces the horizontal strip, which had reached six entries and was
          about to gain BoQ, Progress and Variations. A rail holds a dozen
          comfortably and gives each area a stable position, so people navigate
          by memory instead of reading the row each time.

          Grouped with headings rather than one flat list: the strip's real
          problem was not its length but that Summary, Files and Commercial sat
          at equal weight with no indication of what belonged together.       */}
      <div style={{ display: 'flex', alignItems: 'flex-start', background: '#fff' }}>
        <nav aria-label="Project sections"
             style={{ width: 152, flexShrink: 0, padding: '14px 0 24px 20px',
                      borderRight: '1px solid #e5e7eb', minHeight: 380 }}>
          {[
            { group: null,          items: [{ key: 'summary', label: 'Overview' }] },
            { group: 'Plan',        items: [
                { key: 'details',  label: 'Checklist' },
                { key: 'variance', label: 'Plan vs actual' }] },
            { group: 'Commercial',  items: [
                ...(detail.canSeeCommercial ? [{ key: 'commercial', label: 'Budget' }] : []),
                { key: 'boq', label: 'Bill of quantities' }] },
            { group: 'Records',     items: [
                { key: 'files',          label: 'Files' },
                { key: 'communications', label: 'Communications' },
                // 2026_133. A view over an endpoint that already existed —
                // getLog has taken an anchor filter since the daily work build.
                { key: 'dailywork',      label: 'Daily work' }] },
          ].map((sec, si) => (
            <div key={si} style={{ marginBottom: 12 }}>
              {sec.group && (
                <div style={{ fontSize: 10, color: '#9ca3af', letterSpacing: '0.05em',
                              textTransform: 'uppercase', margin: '0 0 3px' }}>{sec.group}</div>
              )}
              {sec.items.map(t => (
                <button key={t.key} onClick={() => setDetailTab(t.key)} style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '5px 10px 5px 8px', marginLeft: -8, background: 'none', border: 'none',
                  borderLeft: `2px solid ${detailTab === t.key ? '#0369a1' : 'transparent'}`,
                  color: detailTab === t.key ? '#0369a1' : '#4b5563',
                  fontWeight: detailTab === t.key ? 600 : 400, fontSize: 13, cursor: 'pointer',
                }}>{t.label}</button>
              ))}
            </div>
          ))}
        </nav>

        {/* minWidth 0 is load-bearing: without it a wide table inside a flex
            child refuses to shrink and pushes the rail off-screen. */}
        <div style={{ flex: 1, minWidth: 0 }}>

      {/* ── Daily work (2026_133) ───────────────────────── */}
      {detailTab === 'dailywork' && (
        <div style={{ padding: '16px 20px' }}>
          <ProjectDailyWork handoverId={detail.id} />
        </div>
      )}

      {/* ── Summary ─────────────────────────────────────── */}
      {detailTab === 'summary' && (
        <div style={{ padding: '16px 20px' }}>
          <HandoverSummary detail={detail} users={users} canEdit={isServiceView || salesCanEdit} managerLabel={ownerLabel} onRefresh={load} onOpenProject={onOpenProject} onGoToDetails={() => setDetailTab('details')} />
        </div>
      )}

      {/* ── Details (body) ──────────────────────────────── */}
      {detailTab === 'details' && (
      <div style={{ padding: '16px 20px' }}>

        <GoLiveDriftBanner handoverId={detail.id} goLiveDate={detail.goLiveDate} />

        {/* Handover Checklist (plays) — grouped by stage */}
        <section style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '0 0 12px' }}>
            <h4 style={{ margin: 0, fontSize: 14, color: '#374151' }}>📋 Project checklist <span style={{ fontSize: 11, fontWeight: 400, color: '#9ca3af' }}>· steps grouped by stage</span></h4>
            {salesCanEdit && (
              <button onClick={() => setShowStageMgr(v => !v)}
                style={{ marginLeft: 'auto', fontSize: 11, padding: '4px 10px', borderRadius: 6, fontWeight: 600,
                         border: '1px solid #d1d5db', background: showStageMgr ? '#eff6ff' : '#fff',
                         color: '#0369a1', cursor: 'pointer' }}>
                ⚙ Manage stages
              </button>
            )}
            <div style={{ marginLeft: salesCanEdit ? 8 : 'auto', display: 'inline-flex', border: '1px solid #d1d5db', borderRadius: 6, overflow: 'hidden' }}>
              {CHECKLIST_LAYOUTS.map(([k, label]) => (
                <button key={k} onClick={() => setLayout(k)} style={{ padding: '4px 12px', fontSize: 11, fontWeight: 600, border: 'none', cursor: 'pointer',
                  background: checklistLayout === k ? '#0369a1' : '#fff', color: checklistLayout === k ? '#fff' : '#374151' }}>{label}</button>
              ))}
            </div>
          </div>

          {salesCanEdit && showStageMgr && (
            <StageManager
              stages={stages}
              onSave={handleSaveStages}
              onAdd={handleAddStage}
              onRemove={handleRemoveStage}
              onClose={() => setShowStageMgr(false)}
            />
          )}

          {plays.length === 0 && (
            <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 12 }}>No checklist items yet.</div>
          )}

          {checklistLayout === 'compact' ? (
            /* ── Compact: one card per stage, title-only rows that expand ── */
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 14, alignItems: 'start' }}>
              {groupPlaysByStage(plays).map(group => {
                return (
                  <div key={group.key} style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 14, background: '#fff' }}>
                    <StageHeader group={group} />
                    {group.items.map(play => {
                      const done = isPlayDone(play.status);
                      const icon = play.status === 'skipped' ? '⊘' : done ? '✅' : play.isGate ? '🔒' : play.status === 'in_progress' ? '🔄' : '⬜';
                      const isOpen = !!expandedPlays[play.id];
                      return (
                        <div key={play.id} style={{ borderTop: '1px solid #f3f4f6' }}>
                          <div onClick={() => togglePlay(play.id)} title="Click for detail"
                            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 2px', cursor: 'pointer', fontSize: 13 }}>
                            <span>{icon}</span>
                            <span style={{ flex: 1, minWidth: 0, color: done ? '#6b7280' : '#111827', textDecoration: done ? 'line-through' : 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{play.title}</span>
                            {play.isGate && !done && <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 4, background: '#eff6ff', color: '#1d4ed8' }}>GATE</span>}
                            <NoteCountBadge count={play.noteCount} />
                            {done && play.completedAt && <span style={{ fontSize: 10, color: '#9ca3af' }}>{fmtDate(play.completedAt)}</span>}
                            <span style={{ fontSize: 10, color: '#9ca3af' }}>{isOpen ? '▾' : '▸'}</span>
                          </div>
                          {isOpen && (
                            <div style={{ paddingBottom: 8 }}>
                              <PlaySection play={play} canEdit={salesCanEdit} onComplete={handleCompletePlay} onRemove={handleRemovePlay} onEdit={handleUpdatePlay} onSetStatus={handleSetPlayStatus} onSetDeps={handleSetPlayDeps} evidencePolicy={evidencePolicy}
                                siblings={plays.filter(x => x.playInstanceId !== play.playInstanceId)}
                                users={users} stages={stages}
                                handoverId={h.id} canAddNotes={detail.canAddNotes}
                                canMarkNotesInternal={detail.canMarkNotesInternal}
                                onReview={openReview} isManager={canReviewPlays}
                                canAct={canActOnPlay(play)}
                                onNoteCountChange={noteCountChanged} />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          ) : checklistLayout === 'table' ? (
            /* ── Table: task · owner · due · status, one table per stage ──
               Rows stay expandable so "Mark done" is one click away without
               having to switch views. */
            groupPlaysByStage(plays).map(group => (
              <div key={group.key} style={{ marginBottom: 18 }}>
                <StageHeader group={group} />
                <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                    {/* Widths sized for the widest real content, not the header
                        text: DUE holds "⚠ 33d overdue  17 Jul 2026" and STATUS
                        holds a pill plus the Start/Pause button. At the old
                        130/110 both clipped — the date rendered as "17 Jul 202"
                        and the button spilled past the column edge. */}
                    <colgroup>
                      <col />
                      <col style={{ width: 150 }} />
                      <col style={{ width: 190 }} />
                      <col style={{ width: 170 }} />
                      <col style={{ width: 74 }} />
                      <col style={{ width: 28 }} />
                    </colgroup>
                    <thead>
                      <tr style={{ background: '#f8fafc' }}>
                        {['Task', 'Owner', 'Due', 'Status', '', ''].map((h, i) => (
                          <th key={i} style={{
                            textAlign: 'left', fontSize: 10, fontWeight: 700, color: '#94a3b8',
                            letterSpacing: 0.4, textTransform: 'uppercase',
                            padding: '7px 10px', borderBottom: '1px solid #e5e7eb',
                          }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {group.items.map(play => {
                        const done = isPlayDone(play.status);
                        const isOpen = !!expandedPlays[play.id];
                        // whiteSpace: nowrap on the metadata cells — with
                        // tableLayout: 'fixed' a too-narrow cell silently clips
                        // rather than growing, so the content must be allowed to
                        // stay on one line and the widths must fit it.
                        const td = { padding: '8px 10px', borderTop: '1px solid #f3f4f6',
                                     verticalAlign: 'middle', whiteSpace: 'nowrap' };
                        return (
                          <React.Fragment key={play.id}>
                            {/* id, not a ref. The row that a deep link wants
                                may be inside a collapsed stage group that has
                                not rendered yet, so a ref captured at mount
                                would be null exactly when it is needed; a
                                getElementById after paint finds it whenever it
                                exists and harmlessly returns null when it does
                                not. */}
                            <tr id={`play-row-${play.id}`}
                                onClick={() => togglePlay(play.id)} title="Click for detail"
                                style={{ cursor: 'pointer',
                                         background: focusPlayId === play.id ? '#eff6ff'
                                                   : isOpen ? '#f8fafc' : '#fff' }}>
                              <td style={{ ...td, fontSize: 13,
                                           color: done ? '#6b7280' : '#111827',
                                           textDecoration: done ? 'line-through' : 'none' }}>
                                <InlineCell
                                  value={play.title} display={play.title}
                                  canEdit={salesCanEdit && !done}
                                  onSave={v => v && handleInlineSave(play.playInstanceId, 'title', v)}
                                />
                                {play.isGate && !done && (
                                  <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, padding: '1px 6px',
                                                 borderRadius: 4, background: '#eff6ff', color: '#1d4ed8' }}>GATE</span>
                                )}
                                {play.noteCount > 0 && (
                                  <span style={{ marginLeft: 6 }}><NoteCountBadge count={play.noteCount} /></span>
                                )}
                              </td>
                              <td style={td}>
                                <InlineCell
                                  type="select"
                                  value={play.ownerUserId ? String(play.ownerUserId) : ''}
                                  display={<OwnerChip name={play.ownerName} />}
                                  options={(users || []).map(u => ({
                                    value: String(u.id),
                                    // Same precedence as the other user pickers
                                    // in this file (line ~1395).
                                    label: u.name || `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email,
                                  }))}
                                  canEdit={salesCanEdit && !done}
                                  onSave={v => handleInlineSave(play.playInstanceId, 'ownerUserId', v)}
                                />
                              </td>
                              <td style={td}>
                                {done && play.completedAt
                                  ? <span style={{ fontSize: 11, color: '#059669', whiteSpace: 'nowrap' }}>✓ {fmtDate(play.completedAt)}</span>
                                  : <InlineCell
                                      type="date"
                                      value={play.dueDate ? String(play.dueDate).slice(0, 10) : ''}
                                      display={play.dueDate
                                        ? <DueChip dueDate={play.dueDate} isOverdue={play.isOverdue} daysOverdue={play.daysOverdue} />
                                        : null}
                                      canEdit={salesCanEdit}
                                      onSave={v => handleInlineSave(play.playInstanceId, 'dueDate', v)}
                                    />}
                              </td>
                              <td style={td}>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                  <PlayStatusPill status={play.status} />
                                  <StatusAction play={play} canAct={canActOnPlay(play)}
                                    onSetStatus={handleSetPlayStatus}
                                    onReview={openReview}
                                    isManager={detail.canReviewPlays === true}
                                    compact />
                                </span>
                              </td>
                              <td style={td}>
                                {salesCanEdit && (
                                  <span style={{ display: 'inline-flex', gap: 4 }}>
                                    <button title="Duplicate this task"
                                      onClick={e => { e.stopPropagation(); handleDuplicatePlay(play); }}
                                      style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4,
                                               border: '1px solid #e5e7eb', background: '#fff',
                                               color: '#6b7280', cursor: 'pointer', lineHeight: 1.4 }}>⧉</button>
                                    <button title="Delete this task"
                                      onClick={e => { e.stopPropagation(); handleDeletePlay(play); }}
                                      style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4,
                                               border: '1px solid #fecaca', background: '#fff',
                                               color: '#991b1b', cursor: 'pointer', lineHeight: 1.4 }}>🗑</button>
                                  </span>
                                )}
                              </td>
                              <td style={{ ...td, color: '#9ca3af', fontSize: 10 }}>{isOpen ? '▾' : '▸'}</td>
                            </tr>
                            {isOpen && (
                              <tr>
                                <td colSpan={6} style={{ padding: '0 10px 8px', background: '#f8fafc', borderTop: 'none' }}>
                                  <PlaySection play={play} canEdit={salesCanEdit} onComplete={handleCompletePlay}
                                    onRemove={handleRemovePlay} onEdit={handleUpdatePlay} onSetStatus={handleSetPlayStatus} onSetDeps={handleSetPlayDeps} evidencePolicy={evidencePolicy}
                                siblings={plays.filter(x => x.playInstanceId !== play.playInstanceId)}
                                users={users} stages={stages}
                                handoverId={h.id} canAddNotes={detail.canAddNotes}
                                canMarkNotesInternal={detail.canMarkNotesInternal}
                                onReview={openReview} isManager={canReviewPlays}
                                canAct={canActOnPlay(play)}
                                onNoteCountChange={noteCountChanged} />
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ))
          ) : (
            /* ── Detailed: full grouped list ── */
            groupPlaysByStage(plays).map(group => {
              return (
                <div key={group.key} style={{ marginBottom: 18 }}>
                  <StageHeader group={group} />
                  {group.items.map(play => (
                    // Wrapper carries the drag affordance so PlaySection itself
                    // stays unchanged — its internal inputs must remain
                    // selectable, which is why draggable sits on the handle
                    // rather than the whole row.
                    <div
                      key={play.id}
                      onDragOver={e => { if (dragPlay) { e.preventDefault(); setDragOver(play.id); } }}
                      onDragLeave={() => setDragOver(o => (o === play.id ? null : o))}
                      onDrop={e => { e.preventDefault(); handleDropPlay(play, group.items); }}
                      style={{
                        position: 'relative',
                        borderTop: dragOver === play.id && dragPlay && dragPlay.id !== play.id
                          ? '2px solid #0369a1' : '2px solid transparent',
                        opacity: dragPlay && dragPlay.id === play.id ? 0.45 : 1,
                      }}
                    >
                      {salesCanEdit && (
                        <span
                          draggable
                          onDragStart={() => setDragPlay({ id: play.id, stageKey: group.key })}
                          onDragEnd={() => { setDragPlay(null); setDragOver(null); }}
                          title="Drag to reorder within this stage"
                          style={{ position: 'absolute', left: -14, top: 12, cursor: 'grab',
                                   color: '#cbd5e1', fontSize: 13, userSelect: 'none' }}
                        >⠿</span>
                      )}
                      <PlaySection
                        play={play}
                        canEdit={salesCanEdit}
                        onComplete={handleCompletePlay}
                        onRemove={handleRemovePlay}
                        onEdit={handleUpdatePlay}
                        onSetStatus={handleSetPlayStatus}
                        onSetDeps={handleSetPlayDeps}
                        evidencePolicy={evidencePolicy}
                        siblings={plays.filter(x => x.playInstanceId !== play.playInstanceId)}
                        users={users}
                        stages={stages}
                        handoverId={h.id}
                        canAddNotes={detail.canAddNotes}
                        canMarkNotesInternal={detail.canMarkNotesInternal}
                        onNoteCountChange={noteCountChanged}
                        onReview={openReview}
                        isManager={canReviewPlays}
                        canAct={canActOnPlay(play)}
                      />
                      {salesCanEdit && (
                        <div style={{ display: 'flex', gap: 10, margin: '-4px 0 10px 2px' }}>
                          <button onClick={() => setDateModal(play)}
                            style={{ fontSize: 11, padding: '2px 8px', borderRadius: 5,
                                     border: '1px solid #e5e7eb', background: '#fff',
                                     color: '#374151', cursor: 'pointer' }}>
                            Change date
                          </button>
                          <button onClick={() => setEvidModal(play)}
                            style={{ fontSize: 11, padding: '2px 8px', borderRadius: 5,
                                     border: '1px solid #e5e7eb', background: '#fff',
                                     color: '#374151', cursor: 'pointer' }}>
                            Evidence
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              );
            })
          )}
          {salesCanEdit && (
            <div style={{ marginTop: 4 }}>
              <AddPlayForm users={users} onAdd={handleAddPlay} stages={stages} />
            </div>
          )}
        </section>

        {/* Commitments / Risks */}
        <section style={{ marginBottom: 24 }}>
          <h4 style={{ margin: '0 0 8px', fontSize: 14, color: '#374151' }}>
            📌 Commitments &amp; risks ({commitments.length})
          </h4>
          <CommitmentsSection
            commitments={commitments}
            canManage={canManageCommitments}
            users={users}
            onAdd={handleAddCommitment}
            onUpdate={handleUpdateCommitment}
            onRemove={handleRemoveCommitment}
          />
        </section>

        {/* Service notes (service view only) */}
        {isServiceView && (isInProgress || isAcknowledged || detail.serviceNotes) && (
          <section style={{ marginBottom: 24 }}>
            <h4 style={{ margin: '0 0 8px', fontSize: 14, color: '#374151' }}>📝 Service notes</h4>
            {(isAcknowledged || isInProgress) ? (
              <ServiceNotes handoverId={detail.id} initialNotes={detail.serviceNotes} onSaved={load} />
            ) : (
              <p style={{ fontSize: 13, color: '#374151', lineHeight: 1.6, margin: 0,
                padding: '10px 12px', background: '#f0fdf4', borderRadius: 6, border: '1px solid #d1fae5' }}>
                {detail.serviceNotes || '—'}
              </p>
            )}
          </section>
        )}
      </div>
      )}

      {/* ── Communications (email + WhatsApp) ───────────── */}
      {detailTab === 'files' && (
        <div style={{ padding: '16px 20px' }}>
          <ProjectFilesPanel handoverId={detail.id} />
        </div>
      )}

      {dateModal && (
        <PlayDateModal
          handoverId={detail.id}
          play={dateModal}
          onClose={() => setDateModal(null)}
          onSaved={load}
        />
      )}
      {evidModal && (
        <PlayEvidenceModal
          handoverId={detail.id}
          play={evidModal}
          onClose={() => setEvidModal(null)}
          onSaved={load}
        />
      )}

      {/* 2026_130 review loop. Mounted alongside the other play modals so all
          three write paths on a task live in one place.

          play is re-read from `plays` on every render rather than held in the
          modal's own state: approving reloads the project, and a modal holding
          a stale copy would still show the evidence of a submission that has
          already been actioned. */}
      {reviewModal && (
        <PlayReviewModal
          handoverId={detail.id}
          play={plays.find(p => p.playInstanceId === reviewModal.play.playInstanceId)
                || reviewModal.play}
          mode={reviewModal.mode}
          onClose={() => setReviewModal(null)}
          onDone={handleReviewDone}
        />
      )}

      {detailTab === 'boq' && (
        <ProjectBoQ handoverId={detail.id} />
      )}

      {detailTab === 'variance' && (
        <ProjectPlanVsActual handoverId={detail.id} />
      )}

      {detailTab === 'communications' && (
        <div style={{ padding: '16px 20px' }}>
          <CommunicationsPanel handoverId={detail.id} accountId={detail.accountId} />
        </div>
      )}

      {detailTab === 'commercial' && detail.canSeeCommercial && (
        <div style={{ padding: '16px 20px' }}>
          <CommercialTab detail={detail} users={users} onRefresh={load} />
        </div>
      )}
        </div>{/* content column */}
      </div>{/* rail + content row */}
    </div>
  );
}

// ── NextStepsSection: project-level actions (next steps) with an owner ────────
function NextStepsSection({ handoverId, users, card, h4 }) {
  const [actions, setActions] = useState(null);
  const [adding, setAdding]   = useState(false);
  const [title, setTitle]     = useState('');
  const [owner, setOwner]     = useState('');
  const [due, setDue]         = useState('');
  const [busy, setBusy]       = useState(false);
  const [err, setErr]         = useState('');

  const load = useCallback(() => apiService.handovers.projectActions(handoverId)
    .then(r => setActions(r.data.actions || []))
    .catch(() => setActions([])), [handoverId]);
  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    if (!title.trim()) { setErr('Add a title.'); return; }
    setBusy(true); setErr('');
    try {
      await apiService.handovers.addProjectAction(handoverId, { title: title.trim(), ownerUserId: owner || null, dueDate: due || null });
      setTitle(''); setOwner(''); setDue(''); setAdding(false);
      await load();
    } catch (e) { setErr(e?.response?.data?.error?.message || 'Could not add.'); }
    finally { setBusy(false); }
  };
  const complete = async (id) => { await apiService.handovers.completeProjectAction(handoverId, id).catch(() => {}); await load(); };

  const open = (actions || []).filter(a => a.status !== 'completed');
  const done = (actions || []).filter(a => a.status === 'completed');
  const inp = { fontSize: 12, padding: '6px 8px', borderRadius: 6, border: '1px solid #d1d5db', boxSizing: 'border-box' };

  return (
    <div style={card}>
      <h4 style={h4}>🎯 Next steps ({open.length})</h4>
      {actions === null ? <div style={{ fontSize: 12, color: '#9ca3af' }}>Loading…</div> : (
        <>
          {open.length === 0 && !adding && <div style={{ fontSize: 12, color: '#9ca3af' }}>No open next steps.</div>}
          {open.map(a => (
            <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '1px solid #f3f4f6', fontSize: 13 }}>
              <button onClick={() => complete(a.id)} title="Mark done"
                style={{ width: 16, height: 16, flexShrink: 0, borderRadius: 4, border: '1.5px solid #cbd5e1', background: '#fff', cursor: 'pointer' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: '#111827' }}>{a.title}</div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>{a.ownerName}{a.dueDate ? ` · due ${fmtDate(a.dueDate)}` : ''}</div>
              </div>
            </div>
          ))}
          {done.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {done.slice(0, 5).map(a => (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 12, color: '#9ca3af' }}>
                  <span style={{ color: '#16a34a' }}>✓</span>
                  <span style={{ flex: 1, textDecoration: 'line-through' }}>{a.title}</span>
                  <span>{a.ownerName}</span>
                </div>
              ))}
            </div>
          )}

          {adding ? (
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <input value={title} onChange={e => setTitle(e.target.value)} placeholder="What needs doing?" style={inp} />
              <div style={{ display: 'flex', gap: 6 }}>
                <select value={owner} onChange={e => setOwner(e.target.value)} style={{ ...inp, flex: 1 }}>
                  <option value="">Owner…</option>
                  {(users || []).map(u => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
                </select>
                <input type="date" value={due} onChange={e => setDue(e.target.value)} style={inp} />
              </div>
              {err && <div style={{ fontSize: 11, color: '#991b1b' }}>{err}</div>}
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={submit} disabled={busy} style={{ fontSize: 12, padding: '5px 12px', borderRadius: 5, border: 'none', background: busy ? '#9ca3af' : '#059669', color: '#fff', cursor: 'pointer' }}>Add</button>
                <button onClick={() => { setAdding(false); setErr(''); }} style={{ fontSize: 12, padding: '5px 10px', borderRadius: 5, border: 'none', background: '#f1f5f9', color: '#374151', cursor: 'pointer' }}>Cancel</button>
              </div>
            </div>
          ) : (
            <button onClick={() => { setAdding(true); setErr(''); }} style={{ marginTop: 8, fontSize: 12, padding: '4px 10px', borderRadius: 5, background: '#eff6ff', color: '#1d4ed8', border: '1px dashed #93c5fd', cursor: 'pointer' }}>+ Add next step</button>
          )}
        </>
      )}
    </div>
  );
}

// ── CommercialTab: commercial terms + who-can-see-this-tab access ─────────────
function CommercialTab({ detail, users, onRefresh }) {
  const [managing, setManaging] = useState(false);
  const [sel, setSel]           = useState((detail.commercialViewers || []).map(v => v.userId));
  const [saving, setSaving]     = useState(false);
  const [msg, setMsg]           = useState('');
  const viewers = detail.commercialViewers || [];

  const toggle = (id) => setSel(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  const save = async () => {
    setSaving(true); setMsg('');
    try { await apiService.handovers.setTabViewers(detail.id, 'commercial', sel); setMsg('Saved.'); setManaging(false); if (onRefresh) await onRefresh(); }
    catch (e) { setMsg(e?.response?.data?.error?.message || 'Could not save.'); }
    finally { setSaving(false); }
  };

  const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 16, marginBottom: 16 };
  return (
    <div style={{ maxWidth: 720 }}>
      <div style={card}>
        <h4 style={{ margin: '0 0 10px', fontSize: 14, color: '#374151' }}>💰 Commercial terms</h4>
        {detail.commercialTermsSummary ? (
          <p style={{ fontSize: 13, color: '#374151', lineHeight: 1.6, margin: 0, padding: '10px 12px', background: '#f8fafc', borderRadius: 6, border: '1px solid #e5e7eb' }}>
            {detail.commercialTermsSummary}
          </p>
        ) : (
          <div style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>No commercial terms summary added.</div>
        )}
      </div>

      {detail.canManageTabAccess && (
        <DesktopOnlyNotice
          title="Tab access is easier to manage on a wider screen"
          detail="Granting access means picking people from your org roster. The list is long and the checkboxes are small on a phone — the commercial terms above stay readable either way."
        >
          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <h4 style={{ margin: 0, fontSize: 14, color: '#374151' }}>🔒 Who can see this tab</h4>
              {!managing && <button onClick={() => { setManaging(true); setMsg(''); }} style={{ marginLeft: 'auto', fontSize: 12, color: '#0369a1', background: 'none', border: 'none', cursor: 'pointer' }}>Edit</button>}
            </div>
            <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 10px' }}>
              The project owner, deal owner, and org admins can always see the Commercial tab. Add specific people below to grant them access too.
            </p>
            {!managing ? (
              viewers.length === 0
                ? <div style={{ fontSize: 12, color: '#9ca3af' }}>No named people added — only owners and admins can see it.</div>
                : <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{viewers.map(v => (
                    <span key={v.userId} style={{ fontSize: 12, padding: '3px 10px', borderRadius: 999, background: '#eff6ff', color: '#1d4ed8' }}>{v.name}</span>
                  ))}</div>
            ) : (
              <div>
                <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: 8, padding: 8 }}>
                  {(users || []).map(u => (
                    <label key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '3px 0', cursor: 'pointer' }}>
                      <input type="checkbox" checked={sel.includes(u.id)} onChange={() => toggle(u.id)} />
                      {u.name || u.email}
                    </label>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button onClick={save} disabled={saving} style={{ fontSize: 12, padding: '5px 14px', borderRadius: 6, border: 'none', background: saving ? '#9ca3af' : '#059669', color: '#fff', cursor: 'pointer' }}>{saving ? 'Saving…' : 'Save'}</button>
                  <button onClick={() => { setManaging(false); setSel(viewers.map(v => v.userId)); }} style={{ fontSize: 12, padding: '5px 12px', borderRadius: 6, border: 'none', background: '#f1f5f9', color: '#374151', cursor: 'pointer' }}>Cancel</button>
                </div>
              </div>
            )}
            {msg && <div style={{ fontSize: 11, color: msg === 'Saved.' ? '#059669' : '#991b1b', marginTop: 8 }}>{msg}</div>}
          </div>
        </DesktopOnlyNotice>
      )}
    </div>
  );
}

// ── HandoverSummary: overview screen (team, playbook, ownership, open items) ──

function initials(name) {
  return (name || '?').trim().split(/\s+/).map(x => x[0]).slice(0, 2).join('').toUpperCase();
}

const STAKE_ROLE = {
  go_live_approver:    'Go-live approver',
  day_to_day_admin:    'Day-to-day contact',
  implementation_lead: 'Implementation lead',
  technical_lead:      'Technical lead',
  exec_sponsor:        'Exec sponsor',
  other:               'Other',
};

// Days a completed commitment finished past its due date (0 if on time / undated).
function lateDays(c) {
  if (!c.closedAt || !c.dueDate) return 0;
  const d = Math.floor((new Date(c.closedAt) - new Date(c.dueDate + 'T23:59:59')) / 86400000);
  return d > 0 ? d : 0;
}

function Modal({ title, onClose, children }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 10,
        width: 'min(560px, 92vw)', maxHeight: '80vh', overflow: 'auto', boxShadow: '0 10px 40px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid #e5e7eb' }}>
          <h3 style={{ margin: 0, fontSize: 15, color: '#111827' }}>{title}</h3>
          <button onClick={onClose} style={{ border: 'none', background: 'none', fontSize: 20, color: '#9ca3af', cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>
        <div style={{ padding: '16px 18px' }}>{children}</div>
      </div>
    </div>
  );
}

function PersonPanel({ member, onClose, onOpenProject, handoverId, canManage }) {
  const [data, setData] = useState(null);
  const [panelTab, setPanelTab] = useState('projects'); // 'projects' | 'tasks' | 'comms'
  const [commFilter, setCommFilter] = useState('all');  // account name filter for the comms tab
  const [openComm, setOpenComm] = useState(null);       // clicked communication → detail overlay
  const [openContact, setOpenContact] = useState(null); // "see all from this contact" → customer panel
  // Phone lives on the USER, so editing it here serves both team lists — the
  // deal team (avatar grid) and project members (rows below it). Email is the
  // login identity and stays read-only.
  const [phone, setPhone]           = useState(member.phone || '');
  const [waPhone, setWaPhone]       = useState(member.whatsappPhone || '');
  const [contactMsg, setContactMsg] = useState('');

  const saveContact = async (patch) => {
    setContactMsg('');
    try {
      await apiService.handovers.updateUserContact(handoverId, member.userId, patch);
      setContactMsg('Saved.');
    } catch (e) {
      setContactMsg(e?.response?.data?.error?.message || 'Could not save that number.');
    }
  };
  useEffect(() => {
    apiService.handovers.personDashboard(member.userId)
      .then(res => setData(res.data))
      .catch(() => setData({ person: { name: member.name }, projects: [], deliverables: [], communications: [] }));
  }, [member.userId, member.name]);

  const projects = data?.projects || [];
  const comms    = data?.communications || [];
  const pending  = (data?.deliverables || []).filter(d => d.pending);
  const CH = CHANNEL_META;   // shared, so Teams gets a real badge here too
  const first = (member.name || '').split(' ')[0];

  // Distinct projects present in this person's comms, for the project filter.
  const commAccounts = Array.from(new Set(comms.map(m => m.account).filter(Boolean))).sort();
  const visibleComms = commFilter === 'all' ? comms : comms.filter(m => m.account === commFilter);

  const TABS = [
    { key: 'projects', label: 'Projects',       count: data ? projects.length : null },
    { key: 'tasks',    label: 'Open tasks',     count: data ? pending.length  : null },
    { key: 'comms',    label: 'Communications', count: data ? comms.length    : null },
  ];

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 1000 }} />
      <div style={{ position: 'fixed', top: 0, right: 0, height: '100%', width: 'min(460px, 94vw)', background: '#fff',
        zIndex: 1001, boxShadow: '-6px 0 24px rgba(0,0,0,0.15)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid #e5e7eb' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 36, height: 36, borderRadius: '50%', background: '#e0f2fe', color: '#0369a1',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>{initials(member.name)}</div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, color: '#111827' }}>{member.name}</div>
              <div style={{ fontSize: 12, color: '#6b7280' }}>{member.role}{data?.person?.email ? ` · ${data.person.email}` : ''}</div>

              {/* Contact details. Editable by an org admin or the Project
                  Manager; everyone else sees them read-only. Email is the login
                  identity — changed in account settings, never here. */}
              {canManage ? (
                <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <input value={phone} onChange={e => setPhone(e.target.value)}
                    onBlur={() => { if (phone !== (member.phone || '')) saveContact({ phone }); }}
                    placeholder="+91 7207583441"
                    title="Phone — include the country code, or WhatsApp cannot match it"
                    style={{ fontSize: 12, padding: '4px 7px', borderRadius: 5, border: '1px solid #d1d5db', width: 150 }} />
                  <input value={waPhone} onChange={e => setWaPhone(e.target.value)}
                    onBlur={() => { if (waPhone !== (member.whatsappPhone || '')) saveContact({ whatsappPhone: waPhone }); }}
                    placeholder="WhatsApp (if different)"
                    style={{ fontSize: 12, padding: '4px 7px', borderRadius: 5, border: '1px solid #d1d5db', width: 165 }} />
                  {contactMsg && <span style={{ fontSize: 11, color: /Saved/.test(contactMsg) ? '#065f46' : '#991b1b' }}>{contactMsg}</span>}
                </div>
              ) : (
                (member.phone || member.whatsappPhone) && (
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
                    {member.phone}{member.whatsappPhone && member.whatsappPhone !== member.phone ? ` · WhatsApp ${member.whatsappPhone}` : ''}
                  </div>
                )
              )}
            </div>
          </div>
          <button onClick={onClose} style={{ border: 'none', background: 'none', fontSize: 22, color: '#9ca3af', cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>

        {/* ── Projects / Open tasks / Communications tabs ── */}
        <div style={{ display: 'flex', padding: '0 12px', borderBottom: '1px solid #e5e7eb', background: '#fff' }}>
          {TABS.map(t => (
            <button key={t.key} onClick={() => setPanelTab(t.key)} style={{
              flex: 1, padding: '10px 6px', background: 'none', border: 'none', textAlign: 'center',
              borderBottom: `2px solid ${panelTab === t.key ? '#0369a1' : 'transparent'}`,
              color: panelTab === t.key ? '#0369a1' : '#6b7280',
              fontWeight: panelTab === t.key ? 700 : 400, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }}>
              {t.label}{t.count !== null ? ` (${t.count})` : ''}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
          {data === null ? <div style={{ color: '#9ca3af', fontSize: 13 }}>Loading…</div> : (
            <>
              {/* Projects */}
              {panelTab === 'projects' && (
                projects.length === 0
                  ? <div style={{ fontSize: 12, color: '#9ca3af' }}>{first} is not on any projects.</div>
                  : projects.map((p, i) => (
                    <div key={i} onClick={() => { if (p.handoverId) { onOpenProject?.(p.handoverId); onClose(); } }}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0',
                        borderTop: i === 0 ? 'none' : '1px solid #f3f4f6',
                        cursor: p.handoverId ? 'pointer' : 'default' }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{p.account}</div>
                        <div style={{ fontSize: 11, color: '#6b7280' }}>{p.role}</div>
                      </div>
                      {p.status && <span style={{ fontSize: 11, color: '#6b7280' }}>{p.status.replace(/_/g, ' ')}</span>}
                    </div>
                  ))
              )}

              {/* Open tasks */}
              {panelTab === 'tasks' && (
                pending.length === 0
                  ? <div style={{ fontSize: 12, color: '#9ca3af' }}>Nothing pending on {first}.</div>
                  : pending.map((d, i) => (
                    <div key={d.id} style={{ padding: '7px 0', borderTop: i === 0 ? 'none' : '1px solid #f3f4f6', fontSize: 13 }}>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <span style={{ flex: 1 }}>{d.description}</span>
                        {d.commitmentType && d.commitmentType !== 'promise' && (
                          <span style={{ fontSize: 10, fontWeight: 600, color: d.commitmentType === 'red_flag' ? '#dc2626' : '#d97706' }}>
                            {d.commitmentType === 'red_flag' ? 'red flag' : 'risk'}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{d.account}{d.dueDate ? ` · due ${fmtDate(d.dueDate)}` : ''}</div>
                    </div>
                  ))
              )}

              {/* Communications */}
              {panelTab === 'comms' && (
                comms.length === 0
                  ? <div style={{ fontSize: 12, color: '#9ca3af' }}>No recent communications.</div>
                  : (
                    <>
                      {commAccounts.length > 1 && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                          <span style={{ fontSize: 11, color: '#6b7280' }}>Project</span>
                          <select value={commFilter} onChange={e => setCommFilter(e.target.value)}
                            style={{ flex: 1, fontSize: 12, padding: '4px 8px', borderRadius: 4, border: '1px solid #d1d5db', color: '#374151' }}>
                            <option value="all">All projects ({comms.length})</option>
                            {commAccounts.map(a => (
                              <option key={a} value={a}>{a} ({comms.filter(m => m.account === a).length})</option>
                            ))}
                          </select>
                        </div>
                      )}
                      {visibleComms.length === 0 ? (
                        <div style={{ fontSize: 12, color: '#9ca3af' }}>No communications for this project.</div>
                      ) : visibleComms.map((m, i) => {
                        const ch = CH[m.channel] || { label: m.channel, color: '#6b7280' };
                        return (
                          <div key={m.id} onClick={() => setOpenComm(m)} title="Open message"
                            style={{ padding: '7px 0', borderTop: i === 0 ? 'none' : '1px solid #f3f4f6', fontSize: 12, cursor: 'pointer' }}>
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 2 }}>
                              <span style={{ fontSize: 10, fontWeight: 700, color: ch.color }}>{ch.label}</span>
                              <span style={{ color: '#9ca3af' }}>{m.account} · {m.direction === 'outbound' ? 'sent' : 'received'}</span>
                              <span style={{ marginLeft: 'auto', color: '#9ca3af', fontSize: 10 }}>{m.at ? new Date(m.at).toLocaleDateString() : ''}</span>
                            </div>
                            <div style={{ color: '#374151' }}>{m.subject ? <strong>{m.subject}: </strong> : null}{(m.body || '').slice(0, 120)}{(m.body || '').length > 120 ? '…' : ''}</div>
                          </div>
                        );
                      })}
                    </>
                  )
              )}
            </>
          )}
        </div>
      </div>
      {openComm && <CommMessageModal message={openComm} onClose={() => setOpenComm(null)}
        onOpenContact={(c) => { setOpenComm(null); setOpenContact(c); }} />}
      {openContact && <CustomerContactPanel stakeholder={openContact} onClose={() => setOpenContact(null)} />}
    </>
  );
}

// ── CommMessageModal: full detail of one communication (person-panel drill-down)
// Renders above the person side-panel (higher z-index). All fields come from the
// person-dashboard payload, so no extra fetch is needed.

// ── MoveMessageControl: put a misfiled WhatsApp message on the right project ──
//
// One person has ONE WhatsApp conversation, but can be on several projects, so
// which project a given message belongs to is partly inferred. WHY_FILED spells
// out which rule fired, because "this is on the wrong project" is only
// actionable if you can see what put it there.
//
// The target list comes from the server and is short by design: the projects
// this conversation actually touches, filtered to ones the user can file on.

const WHY_FILED = {
  send:            'Sent from this project.',
  reply_context:   'Filed here because the customer replied to a message on this project.',
  recent_outbound: 'Filed here because this project messaged them within the previous 24 hours.',
  manual_recent:   'Filed here following a manual correction on this conversation.',
  thread:          'Filed here because this project owns the conversation.',
  manual:          'Moved here by hand.',
};

function MoveMessageControl({ message, onMoved }) {
  const [open,    setOpen]    = useState(false);
  const [targets, setTargets] = useState(null);   // null = not loaded yet
  const [dest,    setDest]    = useState('');
  const [scope,   setScope]   = useState('message');
  const [busy,    setBusy]    = useState(false);
  const [err,     setErr]     = useState('');
  const [done,    setDone]    = useState('');

  useEffect(() => {
    if (!open || targets !== null) return;
    let cancelled = false;
    apiService.whatsapp.moveTargets(message.waMessageId)
      .then((res) => {
        if (cancelled) return;
        const list = res.data.targets || [];
        setTargets(list);
        const first = list.find(t => !t.isCurrent);
        setDest(first ? String(first.handoverId) : '');
      })
      .catch((e) => {
        if (cancelled) return;
        setTargets([]);
        setErr(e?.response?.data?.error?.message || 'Could not load projects.');
      });
    return () => { cancelled = true; };
  }, [open, targets, message.waMessageId]);

  const submit = async () => {
    if (!dest) return;
    setBusy(true); setErr(''); setDone('');
    try {
      const res = await apiService.whatsapp.moveMessage(message.waMessageId,
        { handoverId: parseInt(dest, 10), scope });
      const n = res.data.moved || 0;
      setDone(scope === 'thread'
        ? `Moved ${n} message${n === 1 ? '' : 's'} and the conversation.`
        : 'Moved.');
      if (onMoved) onMoved();
    } catch (e) {
      setErr(e?.response?.data?.error?.message || 'Could not move this message.');
    } finally { setBusy(false); }
  };

  const why = WHY_FILED[message.handoverSource] || null;
  const options = (targets || []).filter(t => !t.isCurrent);

  return (
    <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #f1f5f9' }}>
      {why && <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 6 }}>{why}</div>}

      {!open ? (
        <button onClick={() => setOpen(true)}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            color: '#0369a1', fontSize: 12, fontWeight: 600 }}>
          Wrong project? Move this message →
        </button>
      ) : (
        <div style={{ background: '#f8fafc', border: '1px solid #eef2f7', borderRadius: 6, padding: '10px 12px' }}>
          {targets === null ? (
            <div style={{ fontSize: 12, color: '#6b7280' }}>Loading projects…</div>
          ) : options.length === 0 ? (
            <div style={{ fontSize: 12, color: '#6b7280' }}>
              No other project this conversation touches — and nowhere else you can file it.
            </div>
          ) : (
            <>
              <label style={{ display: 'block', fontSize: 11, color: '#6b7280', marginBottom: 4 }}>Move to</label>
              <select value={dest} onChange={e => setDest(e.target.value)}
                style={{ width: '100%', padding: '6px 8px', fontSize: 13, borderRadius: 5,
                  border: '1px solid #d1d5db', marginBottom: 10 }}>
                {options.map(t => (
                  <option key={t.handoverId} value={t.handoverId}>
                    {t.name}{t.account ? ` — ${t.account}` : ''}{t.ownsConversation ? ' (owns this conversation)' : ''}
                  </option>
                ))}
              </select>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
                {[
                  { v: 'message', label: 'Just this message' },
                  { v: 'thread',  label: 'This whole conversation' },
                ].map(o => (
                  <label key={o.v} style={{ fontSize: 12, color: '#374151', cursor: 'pointer' }}>
                    <input type="radio" name={`wa-move-scope-${message.waMessageId}`} value={o.v}
                      checked={scope === o.v} onChange={() => setScope(o.v)}
                      style={{ marginRight: 6 }} />
                    {o.label}
                  </label>
                ))}
              </div>

              <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 10, lineHeight: 1.5 }}>
                {scope === 'thread'
                  ? 'Moves every message filed alongside this one, and the conversation itself. Replies that follow land on the new project.'
                  : message.direction === 'outbound'
                    ? 'Replies to this message will follow it to the new project.'
                    : 'Replies that follow will land on the new project too, until this project or another one sends again.'}
              </div>

              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button onClick={submit} disabled={busy || !dest}
                  style={{ background: '#E8630A', color: '#fff', border: 'none', borderRadius: 5,
                    padding: '6px 12px', fontSize: 12, fontWeight: 600,
                    cursor: busy || !dest ? 'default' : 'pointer', opacity: busy || !dest ? 0.6 : 1 }}>
                  {busy ? 'Moving…' : 'Move'}
                </button>
                <button onClick={() => { setOpen(false); setErr(''); setDone(''); }}
                  style={{ background: 'none', border: 'none', color: '#6b7280', fontSize: 12, cursor: 'pointer' }}>
                  Cancel
                </button>
              </div>
            </>
          )}
          {done && <div style={{ marginTop: 8, fontSize: 12, color: '#059669' }}>{done}</div>}
          {err  && <div style={{ marginTop: 8, fontSize: 12, color: '#991b1b' }}>{err}</div>}
        </div>
      )}
    </div>
  );
}

/* ── Channels ────────────────────────────────────────────────────────────────
 *
 * CHAT groups Microsoft Teams with Google Chat rather than giving each its own
 * tab. They are the same KIND of communication from a project's point of view —
 * short, threaded, many-participant — and the question anyone actually asks is
 * "what was said in chat", not "what was said in Teams specifically". Two tabs
 * that each show a handful of messages are worse than one that shows the
 * conversation. The per-message badge still names the actual channel, so
 * nothing is lost.
 *
 * gchat has no backend yet; listing it here costs nothing and means the tab
 * does not have to be rebuilt when it arrives.
 */
const CHANNEL_META = {
  email:    { label: 'Email',    color: '#7c3aed', bg: '#f5f3ff' },
  whatsapp: { label: 'WhatsApp', color: '#059669', bg: '#ecfdf5' },
  teams:    { label: 'Teams',    color: '#4f46e5', bg: '#eef2ff' },
  gchat:    { label: 'Chat',     color: '#0f766e', bg: '#f0fdfa' },
};

const CHAT_CHANNELS = ['teams', 'gchat'];

/** Which tab does a message belong under? */
function channelGroup(channel) {
  return CHAT_CHANNELS.includes(channel) ? 'chat' : channel;
}

/**
 * Render a message body with @mentions highlighted.
 *
 * The backend sends `body` already flattened to text — mention inner text kept,
 * markup gone — so the naive render is correct but loses the fact that somebody
 * was ADDRESSED. In a multi-project channel a mention is often the only signal
 * of who a message is actually for, so it is worth surfacing.
 *
 * Matching is by the mention's own display text against the flattened body,
 * NOT by re-parsing HTML. The normalizer already resolved which names are real
 * mentions; guessing again here from raw text would highlight anyone whose name
 * merely appeared. Longest-first so "Srujana Dogga" wins over "Srujana".
 */
function MessageBody({ text, mentions }) {
  const names = React.useMemo(() => {
    const list = (mentions || [])
      .map(m => m.mentionText || m.displayName)
      .filter(n => typeof n === 'string' && n.trim().length > 1);
    return [...new Set(list)].sort((a, b) => b.length - a.length);
  }, [mentions]);

  if (!text) return <span style={{ color: '#9ca3af' }}>(No message body.)</span>;
  if (!names.length) return <>{text}</>;

  const escaped = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const parts = text.split(new RegExp(`(${escaped.join('|')})`, 'g'));

  return (
    <>
      {parts.map((part, i) =>
        names.includes(part)
          ? <span key={i} style={{ color: '#4f46e5', fontWeight: 600, background: '#eef2ff',
                                   borderRadius: 3, padding: '0 3px' }}>@{part}</span>
          : <React.Fragment key={i}>{part}</React.Fragment>
      )}
    </>
  );
}

function CommMessageModal({ message, onClose, onOpenContact, onMoved }) {
  const CH = CHANNEL_META;
  const ch  = CH[message.channel] || { label: message.channel, color: '#6b7280', bg: '#f3f4f6' };
  const out = message.direction === 'outbound';
  const meta = [message.account, message.from ? `from ${message.from}` : null].filter(Boolean).join(' · ');

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1100,
      display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 10,
        width: 'min(520px, 92vw)', maxHeight: '80vh', overflow: 'auto', boxShadow: '0 10px 40px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid #e5e7eb' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: ch.color, background: ch.bg, padding: '2px 7px', borderRadius: 5 }}>{ch.label}</span>
            <span style={{ fontSize: 13, color: '#6b7280' }}>{out ? 'Sent' : 'Received'}</span>
          </div>
          <button onClick={onClose} style={{ border: 'none', background: 'none', fontSize: 20, color: '#9ca3af', cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>
        <div style={{ padding: '16px 18px' }}>
          {meta && <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>{meta}</div>}
          <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 12 }}>{message.at ? new Date(message.at).toLocaleString() : ''}</div>

          {/* Recipients — email To/Cc, or the WhatsApp group's members */}
          {message.channel === 'email' && (message.to || (message.cc && message.cc.length > 0)) && (
            <div style={{ fontSize: 12, color: '#374151', marginBottom: 14, padding: '8px 10px', background: '#f8fafc', borderRadius: 6, border: '1px solid #eef2f7' }}>
              {message.to && <div><span style={{ color: '#9ca3af' }}>To </span>{message.to}</div>}
              {message.cc && message.cc.length > 0 && (
                <div style={{ marginTop: 2 }}><span style={{ color: '#9ca3af' }}>Cc </span>{message.cc.join(', ')}</div>
              )}
            </div>
          )}
          {message.channel === 'whatsapp' && (message.groupSubject || (message.participants && message.participants.length > 0)) && (
            <div style={{ fontSize: 12, marginBottom: 14, padding: '8px 10px', background: '#f8fafc', borderRadius: 6, border: '1px solid #eef2f7' }}>
              {message.groupSubject && (
                <div style={{ color: '#374151', marginBottom: (message.participants && message.participants.length) ? 6 : 0 }}>
                  <span style={{ color: '#9ca3af' }}>Group </span>{message.groupSubject}
                </div>
              )}
              {message.participants && message.participants.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                  {message.participants.map((p, i) => (
                    <span key={i} style={{ fontSize: 11, padding: '1px 7px', borderRadius: 10,
                      background: p.side === 'internal' ? '#e0f2fe' : '#fef3c7',
                      color: p.side === 'internal' ? '#0369a1' : '#92400e' }}>{p.name}</span>
                  ))}
                </div>
              )}
            </div>
          )}

          {CHAT_CHANNELS.includes(message.channel) && (message.groupSubject || (message.participants && message.participants.length > 0)) && (
            <div style={{ fontSize: 12, marginBottom: 14, padding: '8px 10px', background: '#f8fafc', borderRadius: 6, border: '1px solid #eef2f7' }}>
              {message.groupSubject && (
                <div style={{ color: '#374151', marginBottom: (message.participants && message.participants.length) ? 6 : 0 }}>
                  <span style={{ color: '#9ca3af' }}>
                    {message.conversationKind === 'channel' ? 'Channel ' : 'Chat '}
                  </span>
                  {message.teamName ? `${message.teamName} › ` : ''}{message.groupSubject}
                </div>
              )}
              {message.participants && message.participants.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                  {message.participants.map((p, i) => (
                    <span key={i} style={{ fontSize: 11, padding: '1px 7px', borderRadius: 10,
                      background: p.external ? '#fef3c7' : '#e0f2fe',
                      color: p.external ? '#92400e' : '#0369a1' }}>{p.name}</span>
                  ))}
                </div>
              )}
            </div>
          )}

          {message.subject && <div style={{ fontSize: 15, fontWeight: 600, color: '#111827', marginBottom: 10 }}>{message.subject}</div>}
          <div style={{ fontSize: 13, lineHeight: 1.6, color: '#374151', whiteSpace: 'pre-wrap' }}>
            <MessageBody text={message.body} mentions={message.mentions} />
          </div>
          {message.editedAt && (
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>
              Edited {new Date(message.editedAt).toLocaleString()} — shown as it reads now.
              Evidence attached to this message keeps the original wording.
            </div>
          )}
          {message.attachments && message.attachments.length > 0 && (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {message.attachments.map((a, i) => (
                <a key={i} href={a.url || '#'} target="_blank" rel="noopener noreferrer"
                   style={{ fontSize: 12, color: a.status === 'unreachable' ? '#9ca3af' : '#2563eb',
                            textDecoration: 'none' }}>
                  📎 {a.name || 'Attachment'}
                  {a.status === 'unreachable' && ' (no longer reachable)'}
                </a>
              ))}
            </div>
          )}

          {onOpenContact && message.contactId && (
            <button onClick={() => onOpenContact({ contactId: message.contactId, name: message.contactName })}
              style={{ marginTop: 16, background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                color: '#0369a1', fontSize: 12, fontWeight: 600 }}>
              See all messages from {message.contactName || 'this contact'} →
            </button>
          )}

          {/* Only WhatsApp, and only where the caller can refresh afterwards —
              a move the list does not reflect looks like it failed. */}
          {onMoved && message.channel === 'whatsapp' && message.waMessageId && (
            <MoveMessageControl message={message} onMoved={onMoved} />
          )}
        </div>
      </div>
    </div>
  );
}

// ── CustomerContactPanel: one customer contact's conversation with the team ───
// Opened by clicking a Customer-team member in the Summary. Lists that contact's
// communications (each row opens the full detail with recipients).

function CustomerContactPanel({ stakeholder, onClose }) {
  const [data, setData] = useState(null);
  const [openComm, setOpenComm] = useState(null);
  const [editing, setEditing] = useState(false);
  const [phone, setPhone] = useState(stakeholder.contactPhone || '');
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  const loadComms = useCallback(() => apiService.handovers.contactCommunications(stakeholder.contactId)
    .then(res => setData(res.data))
    .catch(() => setData({ contact: { name: stakeholder.name }, communications: [] })),
    [stakeholder.contactId, stakeholder.name]);

  useEffect(() => { loadComms(); }, [loadComms]);

  // Seed editable fields once the contact record loads.
  useEffect(() => {
    if (data?.contact) {
      setPhone(p => p || data.contact.phone || stakeholder.contactPhone || '');
      setEmail(e => e || data.contact.email || '');
    }
  }, [data, stakeholder.contactPhone]);

  const saveContact = async () => {
    setSaving(true); setSaveMsg('');
    try {
      await apiService.contacts.update(stakeholder.contactId, { phone: phone.trim() || null, email: email.trim() || null });
      await loadComms();
      setEditing(false); setSaveMsg('Saved.');
    } catch (e) { setSaveMsg(e?.response?.data?.error?.message || 'Could not save.'); }
    finally { setSaving(false); }
  };

  const CH = CHANNEL_META;   // shared, so Teams gets a real badge here too
  const comms = data?.communications || [];
  const first = (stakeholder.name || '').split(' ')[0];
  const roleLabel = STAKE_ROLE[stakeholder.handoverRole] || stakeholder.handoverRole || 'Customer contact';

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 1000 }} />
      <div style={{ position: 'fixed', top: 0, right: 0, height: '100%', width: 'min(460px, 94vw)', background: '#fff',
        zIndex: 1001, boxShadow: '-6px 0 24px rgba(0,0,0,0.15)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid #e5e7eb' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 36, height: 36, borderRadius: '50%', background: '#fef3c7', color: '#92400e',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>{initials(stakeholder.name)}</div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, color: '#111827' }}>{stakeholder.name}</div>
              <div style={{ fontSize: 12, color: '#6b7280' }}>
                {roleLabel}{stakeholder.isPrimaryContact ? ' · primary' : ''}{data?.contact?.account ? ` · ${data.contact.account}` : ''}
              </div>
            </div>
          </div>
          <button onClick={onClose} style={{ border: 'none', background: 'none', fontSize: 22, color: '#9ca3af', cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
          {/* Contact details (inline edit for missing data) */}
          <div style={{ marginBottom: 16, padding: 12, background: '#f8fafc', borderRadius: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.4 }}>Contact details</span>
              {!editing && stakeholder.contactId && (
                <button onClick={() => { setEditing(true); setSaveMsg(''); }} style={{ fontSize: 11, color: '#0369a1', background: 'none', border: 'none', cursor: 'pointer' }}>Edit</button>
              )}
            </div>
            {!editing ? (
              <div style={{ fontSize: 13 }}>
                <div style={{ marginBottom: 4 }} onClick={() => !phone && stakeholder.contactId && setEditing(true)}>
                  📞 {phone || <span style={{ color: '#b45309', cursor: 'pointer' }}>Add phone</span>}
                </div>
                <div onClick={() => !email && stakeholder.contactId && setEditing(true)}>
                  ✉️ {email || <span style={{ color: '#b45309', cursor: 'pointer' }}>Add email</span>}
                </div>
              </div>
            ) : (
              <div>
                <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="Phone (with country code)"
                  style={{ width: '100%', fontSize: 13, padding: '6px 8px', borderRadius: 6, border: '1px solid #d1d5db', boxSizing: 'border-box' }} />
                <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Email"
                  style={{ width: '100%', fontSize: 13, padding: '6px 8px', borderRadius: 6, border: '1px solid #d1d5db', boxSizing: 'border-box', marginTop: 6 }} />
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <button onClick={saveContact} disabled={saving}
                    style={{ fontSize: 12, padding: '5px 14px', borderRadius: 6, border: 'none', background: saving ? '#9ca3af' : '#059669', color: '#fff', fontWeight: 600, cursor: saving ? 'default' : 'pointer' }}>
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                  <button onClick={() => setEditing(false)} style={{ fontSize: 12, padding: '5px 12px', borderRadius: 6, border: 'none', background: '#f1f5f9', color: '#374151', cursor: 'pointer' }}>Cancel</button>
                </div>
              </div>
            )}
            {saveMsg && <div style={{ fontSize: 11, color: saveMsg === 'Saved.' ? '#059669' : '#991b1b', marginTop: 6 }}>{saveMsg}</div>}
          </div>

          <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>
            Communications with the team{data ? ` (${comms.length})` : ''}
          </div>
          {data === null ? <div style={{ color: '#9ca3af', fontSize: 13 }}>Loading…</div>
            : comms.length === 0 ? <div style={{ fontSize: 12, color: '#9ca3af' }}>No direct communications from {first} yet.</div>
            : comms.map((m, i) => {
              const ch = CH[m.channel] || { label: m.channel, color: '#6b7280' };
              return (
                <div key={m.id} onClick={() => setOpenComm(m)} title="Open message"
                  style={{ padding: '7px 0', borderTop: i === 0 ? 'none' : '1px solid #f3f4f6', fontSize: 12, cursor: 'pointer' }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 2 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: ch.color }}>{ch.label}</span>
                    <span style={{ color: '#9ca3af' }}>{m.direction === 'outbound' ? `to ${first}` : `from ${first}`}</span>
                    <span style={{ marginLeft: 'auto', color: '#9ca3af', fontSize: 10 }}>{m.at ? new Date(m.at).toLocaleDateString() : ''}</span>
                  </div>
                  <div style={{ color: '#374151' }}>{m.subject ? <strong>{m.subject}: </strong> : null}{(m.body || '').slice(0, 120)}{(m.body || '').length > 120 ? '…' : ''}</div>
                </div>
              );
            })}
        </div>
      </div>
      {openComm && <CommMessageModal message={openComm} onClose={() => setOpenComm(null)} />}
    </>
  );
}

function DeliverableModal({ commitmentId, onClose }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    apiService.handovers.commitmentActivity(commitmentId)
      .then(res => setData(res.data))
      .catch(() => setData({ commitment: null, events: [] }));
  }, [commitmentId]);

  const EV = { created: 'Logged', status_change: 'Status changed', owner_change: 'Owner changed',
    due_change: 'Due date changed', closed: 'Closed', note: 'Note' };
  const c = data?.commitment || {};

  return (
    <Modal title="Deliverable" onClose={onClose}>
      {data === null ? <div style={{ color: '#9ca3af', fontSize: 13 }}>Loading…</div> : (
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#111827', marginBottom: 6 }}>{c.description}</div>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 16 }}>
            Status: <strong>{(c.status || '').replace(/_/g, ' ')}</strong>
            {c.dueDate && <> · Due {fmtDate(c.dueDate)}</>}
            {c.closedAt && <> · Completed {fmtDate(c.closedAt)}</>}
            {c.ownerName && <> · Owner {c.ownerName}</>}
          </div>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 10 }}>What happened</div>
          {(data.events || []).length === 0 ? <div style={{ color: '#9ca3af', fontSize: 12 }}>No activity recorded.</div>
            : (data.events || []).map((e, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, paddingBottom: 12 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#0369a1', marginTop: 4, flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#111827' }}>
                    {EV[e.event_type] || e.event_type}
                    {e.from_status && e.to_status && (
                      <span style={{ fontWeight: 400, color: '#6b7280' }}> · {e.from_status.replace(/_/g, ' ')} → {e.to_status.replace(/_/g, ' ')}</span>
                    )}
                  </div>
                  {e.detail && <div style={{ fontSize: 12, color: '#374151' }}>{e.detail}</div>}
                  <div style={{ fontSize: 10, color: '#9ca3af' }}>
                    {e.created_at ? new Date(e.created_at).toLocaleString() : ''}{e.actor ? ` · ${e.actor}` : ''}
                  </div>
                </div>
              </div>
            ))}
        </div>
      )}
    </Modal>
  );
}

const SUMMARY_CARD_KEYS = ['team', 'next_steps', 'commitments', 'customer', 'playbook', 'open_deliverables', 'where_we_stand', 'completed'];

// The sign-off button must only appear for a NAMED acceptor. The backend
// enforces the same rule, so this is presentation only — but showing a button
// that always 403s would be worse than hiding it.
function readCurrentUserId() {
  try {
    const raw = localStorage.getItem('user');
    if (raw) {
      const u = JSON.parse(raw);
      if (u && (u.id || u.userId)) return Number(u.id || u.userId);
    }
    const token = localStorage.getItem('token');
    if (!token) return null;
    const payload = JSON.parse(atob(token.split('.')[1]));
    return Number(payload.userId || payload.id || payload.sub) || null;
  } catch { return null; }
}

function HandoverSummary({ detail, users, canEdit, onRefresh, onOpenProject, onGoToDetails, managerLabel = 'Project Manager'}) {
  const currentUserId = readCurrentUserId();
  const team      = detail.dealTeam || [];
  const pb        = detail.playbook;
  const allCommits = detail.commitments || [];
  const openItems  = allCommits.filter(c => ['open', 'in_progress'].includes(c.status));
  const doneItems  = allCommits.filter(c => ['met', 'waived', 'breached'].includes(c.status));
  const onTimeCount = doneItems.filter(c => c.closedAt && lateDays(c) === 0).length;
  const gatePlays = (detail.plays || []).filter(p => p.isGate);
  const gatesDone = gatePlays.filter(p => isPlayDone(p.status)).length;

  const [openMember, setOpenMember] = useState(null);
  const [openCommitment, setOpenCommitment] = useState(null);
  const [openContact, setOpenContact] = useState(null);

  // Card order (drag-to-reorder, persisted cross-device via user prefs)
  const [order, setOrder]           = useState(SUMMARY_CARD_KEYS);
  const [dragKey, setDragKey]       = useState(null);
  const [dragOverKey, setDragOverKey] = useState(null);
  useEffect(() => {
    apiService.userPreferences.get().then(r => {
      const saved = r.data?.project_summary_order;
      if (Array.isArray(saved) && saved.length) {
        setOrder([...saved.filter(k => SUMMARY_CARD_KEYS.includes(k)), ...SUMMARY_CARD_KEYS.filter(k => !saved.includes(k))]);
      }
    }).catch(() => {});
  }, []);
  const onDropCard = (targetKey) => {
    setDragOverKey(null);
    const from = dragKey; setDragKey(null);
    if (!from || from === targetKey) return;
    setOrder(prev => {
      const next = prev.filter(k => k !== from);
      const idx = next.indexOf(targetKey);
      next.splice(idx < 0 ? next.length : idx, 0, from);
      apiService.userPreferences.update({ project_summary_order: next }).catch(() => {});
      return next;
    });
  };


  const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: '14px 16px', marginBottom: 0 };
  const h4   = { margin: '0 0 10px', fontSize: 14, color: '#374151' };

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14, alignItems: 'start' }}>
      {(() => {
        const cardNodes = {
          team: (
            <div style={card}>
              <h4 style={h4}>👥 Project team &amp; roles</h4>
              {team.length === 0 ? (
                <div style={{ fontSize: 12, color: '#9ca3af' }}>No project team assigned yet.</div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 10 }}>
                  {team.map(m => (
                    <div key={m.userId} onClick={() => m.userId && setOpenMember(m)}
                      style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13, cursor: m.userId ? 'pointer' : 'default' }}>
                      <div style={{ width: 30, height: 30, flexShrink: 0, borderRadius: '50%', background: '#e0f2fe',
                        color: '#0369a1', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700 }}>
                        {initials(m.name)}
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</div>
                        <div style={{ fontSize: 11, color: '#6b7280' }}>{m.role}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <ProjectMembersSection
                handoverId={detail.id}
                members={detail.projectMembers || []}
                onOpenMember={setOpenMember}
                isAdmin={detail.isProjectAdmin}
                canRequest={detail.canRequestMember}
                onRefresh={onRefresh}
                serviceOwnerId={detail.assignedServiceOwnerId}
                managerLabel={managerLabel}
              />
            </div>
          ),
          next_steps: (
            <NextStepsSection handoverId={detail.id} users={users} card={card} h4={h4} />
          ),
          commitments: (
            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <h4 style={{ ...h4, margin: 0 }}>📌 Commitments &amp; risks ({allCommits.length})</h4>
                {onGoToDetails && (
                  <button onClick={onGoToDetails} style={{ marginLeft: 'auto', marginRight: 18, fontSize: 11, color: '#0369a1', background: 'none', border: 'none', cursor: 'pointer' }}>Manage in Details →</button>
                )}
              </div>
              {allCommits.length === 0 ? (
                <div style={{ fontSize: 12, color: '#9ca3af' }}>None logged.</div>
              ) : allCommits.slice(0, 10).map(c => {
                const DOT = { open: '#d97706', in_progress: '#d97706', met: '#16a34a', waived: '#9ca3af', breached: '#dc2626' };
                return (
                  <div key={c.id} onClick={onGoToDetails} title="Manage in Details"
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '1px solid #f3f4f6', fontSize: 13, cursor: onGoToDetails ? 'pointer' : 'default' }}>
                    <span style={{ width: 9, height: 9, flexShrink: 0, borderRadius: '50%', background: DOT[c.status] || '#9ca3af' }} />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.description}</span>
                    {c.commitmentType && c.commitmentType !== 'promise' && (
                      <span style={{ fontSize: 10, fontWeight: 700, color: c.commitmentType === 'red_flag' ? '#dc2626' : '#d97706' }}>
                        {c.commitmentType === 'red_flag' ? 'RED FLAG' : 'RISK'}
                      </span>
                    )}
                    {c.ownerName && <span style={{ fontSize: 11, color: '#6b7280' }}>{c.ownerName}</span>}
                  </div>
                );
              })}
            </div>
          ),
          customer: (
            <div style={card}>
              <h4 style={h4}>🏛️ Customer team</h4>
              {/* One card, two tables: contacts live in project_contacts, the
                  internal customer is a USER in project_members. Grouped by
                  side rather than one flat list. */}
              <ProjectPeoplePanel
                detail={detail}
                onRefresh={onRefresh}
                onOpenContact={(contactId) => setOpenContact(
                  (detail.stakeholders || []).find(x => x.contactId === contactId) || null)}
                currentUserId={currentUserId}
                managerLabel={managerLabel}
              />
            </div>
          ),
          playbook: (
            <div style={card}>
              <h4 style={h4}>📋 Playbook &amp; ownership</h4>
              <div style={{ fontSize: 13, color: '#374151', marginBottom: 10 }}>
                {pb ? (
                  <span>
                    Following <strong>{pb.name}</strong>
                    <span style={{ marginLeft: 8, fontSize: 11, padding: '1px 7px', borderRadius: 5,
                      background: pb.gateEnforcement === 'strict' ? '#fee2e2' : '#f3f4f6',
                      color: pb.gateEnforcement === 'strict' ? '#991b1b' : '#6b7280' }}>
                      {pb.gateEnforcement === 'strict' ? 'strict gating' : 'advisory gating'}
                    </span>
                    {gatePlays.length > 0 && (
                      <span style={{ marginLeft: 8, color: '#6b7280', fontSize: 12 }}>
                        · {gatesDone}/{gatePlays.length} gates complete
                      </span>
                    )}
                  </span>
                ) : <PlaybookPicker detail={detail} canEdit={canEdit} onRefresh={onRefresh} />}
              </div>
              <ServiceOwnerPicker detail={detail} users={users} canEdit={canEdit} onRefresh={onRefresh} managerLabel={detail.managerLabel || managerLabel} />
            </div>
          ),
          open_deliverables: (
            <div style={card}>
              <h4 style={h4}>🎯 Open deliverables ({openItems.length})</h4>
              {openItems.length === 0 ? (
                <div style={{ fontSize: 12, color: '#9ca3af' }}>Nothing outstanding.</div>
              ) : openItems.map(c => (
                <div key={c.id} onClick={() => setOpenCommitment(c.id)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '6px 0', borderTop: '1px solid #f3f4f6', cursor: 'pointer' }}>
                  <span style={{ flex: 1 }}>{c.description}</span>
                  {c.commitmentType && c.commitmentType !== 'promise' && (
                    <span style={{ fontSize: 10, fontWeight: 600, color: c.commitmentType === 'red_flag' ? '#dc2626' : '#d97706' }}>
                      {c.commitmentType === 'red_flag' ? 'red flag' : 'risk'}
                    </span>
                  )}
                  {c.ownerName && <span style={{ fontSize: 11, color: '#6b7280' }}>{c.ownerName}</span>}
                </div>
              ))}
            </div>
          ),
          where_we_stand: (
            <div style={card}>
              <h4 style={h4}>📊 Where we stand</h4>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <div style={{ flex: 1, height: 8, background: '#f3f4f6', borderRadius: 4 }}>
                  <div style={{ width: `${allCommits.length ? Math.round((doneItems.length / allCommits.length) * 100) : 0}%`,
                    height: '100%', background: '#16a34a', borderRadius: 4 }} />
                </div>
                <span style={{ fontSize: 12, color: '#6b7280' }}>{doneItems.length}/{allCommits.length} done</span>
              </div>
              <div style={{ fontSize: 12, color: '#6b7280' }}>
                {onTimeCount} on time · {Math.max(doneItems.length - onTimeCount, 0)} late · {openItems.length} open
              </div>
            </div>
          ),
          completed: doneItems.length > 0 ? (
            <div style={card}>
              <h4 style={h4}>✅ Completed deliverables ({doneItems.length})</h4>
              {doneItems.map(c => {
                const late = lateDays(c);
                return (
                  <div key={c.id} onClick={() => setOpenCommitment(c.id)}
                    style={{ padding: '7px 0', borderTop: '1px solid #f3f4f6', fontSize: 13, cursor: 'pointer' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ flex: 1 }}>{c.description}</span>
                      {late > 0
                        ? <span style={{ fontSize: 10, fontWeight: 600, color: '#dc2626' }}>{late}d late</span>
                        : <span style={{ fontSize: 10, fontWeight: 600, color: '#16a34a' }}>on time</span>}
                    </div>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                      Due {c.dueDate ? fmtDate(c.dueDate) : '—'} · Completed {c.closedAt ? fmtDate(c.closedAt) : '—'}
                      {c.closedByName ? ` · by ${c.closedByName}` : ''}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null,
        };
        return order.map(k => cardNodes[k] ? (
          <div key={k}
            onDragOver={e => { e.preventDefault(); setDragOverKey(k); }}
            onDragLeave={() => setDragOverKey(d => (d === k ? null : d))}
            onDrop={e => { e.preventDefault(); onDropCard(k); }}
            style={{ position: 'relative', outline: dragOverKey === k ? '2px dashed #93c5fd' : 'none', outlineOffset: 2, borderRadius: 8 }}>
            <div draggable onDragStart={() => setDragKey(k)} onDragEnd={() => { setDragKey(null); setDragOverKey(null); }}
              title="Drag to reorder" style={{ position: 'absolute', top: 8, right: 10, zIndex: 3, cursor: 'grab', color: '#cbd5e1', fontSize: 13, userSelect: 'none', lineHeight: 1 }}>⠿</div>
            {cardNodes[k]}
          </div>
        ) : null);
      })()}

      </div>

      {openMember && <PersonPanel member={openMember} onClose={() => setOpenMember(null)}
        onOpenProject={onOpenProject} handoverId={detail.id} canManage={!!detail.isProjectAdmin} />}
      {openCommitment && <DeliverableModal commitmentId={openCommitment} onClose={() => setOpenCommitment(null)} />}
      {openContact && <CustomerContactPanel stakeholder={openContact} onClose={() => setOpenContact(null)} />}
    </>
  );
}

// ── ServiceOwnerPicker: reassign the assigned service owner in-app ────────────

function ServiceOwnerPicker({ detail, users, canEdit, onRefresh, managerLabel = 'Project Manager'}) {
  const [val,    setVal]    = useState(detail.assignedServiceOwnerId != null ? String(detail.assignedServiceOwnerId) : '');
  const [saving, setSaving] = useState(false);
  const [msg,    setMsg]    = useState('');

  const save = async (next) => {
    setVal(next); setSaving(true); setMsg('');
    try {
      await apiService.handovers.update(detail.id, { assignedServiceOwnerId: next ? parseInt(next, 10) : null });
      setMsg(`${managerLabel} updated.`);
      onRefresh?.();
    } catch {
      setMsg('Could not update.');
    } finally {
      setSaving(false);
      setTimeout(() => setMsg(''), 3000);
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, flexWrap: 'wrap' }}>
      <span style={{ color: '#6b7280' }}>{managerLabel}:</span>
      {canEdit ? (
        <select value={val} onChange={e => save(e.target.value)} disabled={saving}
          style={{ fontSize: 12, padding: '4px 8px', borderRadius: 4, border: '1px solid #d1d5db', maxWidth: 220 }}>
          <option value="">Unassigned</option>
          {(users || []).map(u => <option key={u.id} value={String(u.id)}>{u.name}</option>)}
        </select>
      ) : (
        <strong>{detail.serviceOwnerName || 'Unassigned'}</strong>
      )}
      {msg && <span style={{ fontSize: 11, color: msg.startsWith('Could') ? '#991b1b' : '#059669' }}>{msg}</span>}
    </div>
  );
}

// ── CommunicationsPanel: unified customer comms (email + WhatsApp) ────────────

// WhatsApp templates the composer can send. Each `name` MUST exactly match a
// template that has been APPROVED in Meta's WhatsApp Manager for this WABA, and
// each entry in `variables` maps positionally to the body placeholders
// {{1}}, {{2}}, … in order. `hello_world` is Meta's pre-approved, zero-variable
// template and is always available (useful for smoke-testing). Add your own
// approved templates here — they only work once Meta marks them Approved.
const WA_TEMPLATES = [
  {
    name: 'hello_world',
    language: 'en_US',
    label: 'Hello World (test)',
    description: "Meta's pre-approved test template. No variables — good for a first send.",
    variables: [],
  },
  {
    name: 'handover_intro',
    language: 'en_US',
    label: 'Project intro',
    description: 'Introduce the implementation owner and open the conversation. Requires Meta approval.',
    variables: [
      { label: 'Customer first name', placeholder: 'e.g. Priya' },
      { label: 'Your name',           placeholder: 'e.g. Sudheer' },
      { label: 'Company name',        placeholder: 'e.g. GoWarmCRM' },
    ],
  },
];

function CommunicationsPanel({ handoverId, accountId }) {
  const [items,   setItems]   = useState(null);
  const [people,  setPeople]  = useState([]);
  const [personFilter, setPersonFilter] = useState('');
  const [addMsg,  setAddMsg]  = useState('');
  const [channelFilter, setChannelFilter] = useState('all'); // all | email | whatsapp
  const [text,    setText]    = useState('');
  const [sending, setSending] = useState(false);
  const [err,     setErr]     = useState('');
  const [ok,      setOk]      = useState('');
  const [openComm,    setOpenComm]    = useState(null); // clicked bubble → detail
  const [openContact, setOpenContact] = useState(null); // "see all from" → customer panel

  // Recipient picker. Each target carries its own 24-hour window state, so the
  // window banner and text/template gating are computed per selected recipient.
  const [targets, setTargets] = useState([]);
  const [selKey,  setSelKey]  = useState('');
  const selected = targets.find(t => t.key === selKey) || targets[0] || null;
  const windowOpen      = selected ? selected.windowOpen : null;
  const windowExpiresAt = selected ? selected.windowExpiresAt : null;
  const recipientBlocked = !selected || (selected.type === 'individual' && selected.phoneValid === false);

  // Group creation (Groups API). Creating a project group returns an invite
  // link the members must tap to join — there is no silent add, and the group
  // is capped at 8 participants.
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [groupName,       setGroupName]       = useState('');
  const [creatingGroup,   setCreatingGroup]   = useState(false);
  const [inviteLink,      setInviteLink]      = useState('');
  const [linkCopied,      setLinkCopied]      = useState(false);

  // Composer mode + template selection. Templates come live from the org's
  // approved WhatsApp templates (Meta), so the picker can only offer sendable
  // ones. WA_TEMPLATES is kept only as a friendly-label lookup + offline fallback.
  const [apiTemplates, setApiTemplates] = useState(null);   // null = not loaded yet
  const templateList = (apiTemplates && apiTemplates.length)
    ? apiTemplates.map(t => {
        const friendly = WA_TEMPLATES.find(w => w.name === t.name);
        return {
          name: t.name,
          language: t.language,
          label: (friendly && friendly.label) || t.name,
          description: (friendly && friendly.description) || (t.category ? `${t.category} template` : ''),
          // Prefer friendly labels when the variable counts line up; else generic.
          variables: (friendly && friendly.variables && friendly.variables.length === t.variables.length)
            ? friendly.variables
            : t.variables,
        };
      })
    : WA_TEMPLATES;

  const [mode,    setMode]    = useState('text');               // 'text' | 'template'
  const [tplName, setTplName] = useState(templateList[0] ? templateList[0].name : '');
  const [tplArgs, setTplArgs] = useState({});                    // { [varIndex]: value }
  const tpl = templateList.find(t => t.name === tplName) || templateList[0] || WA_TEMPLATES[0];

  const load = useCallback(async () => {
    try { const res = await apiService.handovers.communications(handoverId); setItems(res.data.items || []); setPeople(res.data.people || []); }
    catch { setItems([]); setPeople([]); }
    // Selectable recipients (group + individuals), each with its own window.
    try {
      const res2 = await apiService.whatsapp.sendTargets(handoverId);
      const ts = res2.data.targets || [];
      setTargets(ts);
      // Default to the first deliverable individual, else the first target.
      setSelKey(prev => (prev && ts.some(t => t.key === prev))
        ? prev
        : (ts.find(t => t.type === 'individual' && t.phoneValid !== false)?.key
           || ts.find(t => t.type === 'individual')?.key || ts[0]?.key || ''));
    } catch { setTargets([]); }
    // Approved templates for the org, live from Meta.
    try {
      const res3 = await apiService.whatsapp.templates();
      setApiTemplates(res3.data.templates || []);
    } catch { setApiTemplates([]); }
  }, [handoverId]);
  useEffect(() => { load(); }, [load]);

  // Keep the selected template valid once the live list loads.
  useEffect(() => {
    if (!templateList.some(t => t.name === tplName) && templateList[0]) setTplName(templateList[0].name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiTemplates]);

  // Default the composer to the only mode that can send for THIS recipient:
  // free-form text when their window is open, templates when it is closed.
  useEffect(() => {
    if (windowOpen === false) setMode('template');
    else if (windowOpen === true) setMode('text');
  }, [windowOpen, selKey]);

  const recipientBody = () =>
    !selected ? {}
      : selected.type === 'group' ? { threadId: selected.threadId }
      : { toPhone: selected.phone };

  const mapErr = (e) => {
    const er = e?.response?.data?.error || {};
    const c = String(er.code);
    if (er.code === 'NOT_CONNECTED')       return 'WhatsApp is not connected for this org yet.';
    if (er.code === 'OBA_REQUIRED')        return 'Groups need an Official Business Account (OBA) on this WABA. Once Meta approves the OBA, group creation will work.';
    if (er.code === 'GROUP_UNSUPPORTED')   return er.message || 'That message type is not supported in groups. Interactive templates only work in 1:1 threads.';
    if (er.code === 'THREAD_NOT_FOUND')    return 'That conversation is no longer available on this project.';
    if (er.code === 'WINDOW_CLOSED')       return 'The 24-hour window is closed for this recipient — send an approved template to re-open it.';
    if (er.code === 'OPTED_OUT')           return 'This recipient has opted out of WhatsApp messages.';
    if (er.code === 'MISSING_COUNTRY_CODE') return er.message || 'Add a country code (e.g. +91) to this contact — it looks like a local number.';
    if (er.code === 'INVALID_PHONE')       return er.message || 'This contact’s phone number is not a valid international number.';
    if (er.code === 'MISSING_PHONE')       return 'This contact has no phone number. Add one in Contacts.';
    if (c === '132001' || c === '132000')  return 'That template is not approved for this account (or the name/language does not match). Check WhatsApp Manager.';
    if (c === '131047')                    return 'Re-engagement required — the window is closed. Send a template instead.';
    if (c === '131026')                    return 'Message undeliverable — the number may not be on WhatsApp, or it isn’t in a valid international format.';
    if (c === '131030')                    return 'This recipient isn’t in the allowed list (test numbers can only message pre-approved recipients).';
    if (c === '131005' || c === '131009')  return 'Access denied by Meta — the connected token is missing WhatsApp permissions, or the number isn’t under this WABA.';
    if (c === '100')                       return 'Meta rejected the request (invalid parameter) — usually a bad recipient number or malformed template.';
    return er.message || 'Could not send.';
  };

  const send = async () => {
    const body = text.trim(); if (!body) return;
    setSending(true); setErr(''); setOk('');
    try {
      await apiService.whatsapp.sendToHandover(handoverId, { text: body, ...recipientBody() });
      setText(''); setOk(`Message sent to ${selected ? selected.name : 'customer'}.`); await load();
    } catch (e) { setErr(mapErr(e)); }
    finally { setSending(false); }
  };

  // Create an API-managed WhatsApp group for THIS handover, then refresh the
  // recipient list so it appears under "Groups" and select it. The returned
  // invite link is what you send to the members — joining is opt-in only.
  const createGroup = async () => {
    const subject = groupName.trim();
    if (!subject) { setErr('Give the group a name first.'); return; }
    setCreatingGroup(true); setErr(''); setOk(''); setInviteLink(''); setLinkCopied(false);
    try {
      const res = await apiService.whatsapp.createGroup({ subject, handoverId });
      const cap = res.data.maxParticipants || 8;
      setInviteLink(res.data.inviteLink || '');
      setOk(`Group “${subject}” created. Share the invite link below with the members (up to ${cap}).`);
      setGroupName('');
      await load();                                   // group now shows under "Groups"
      if (res.data.threadId) setSelKey(`thread:${res.data.threadId}`);
    } catch (e) { setErr(mapErr(e)); }
    finally { setCreatingGroup(false); }
  };

  const copyInvite = async () => {
    try { await navigator.clipboard.writeText(inviteLink); setLinkCopied(true); setTimeout(() => setLinkCopied(false), 2000); }
    catch { /* clipboard unavailable — the link is still selectable in the field */ }
  };

  const sendTemplate = async () => {
    const templateVars = tpl.variables.map((_, i) => (tplArgs[i] || '').trim());
    if (templateVars.some(v => !v)) { setErr('Fill in every template field before sending.'); return; }
    setSending(true); setErr(''); setOk('');
    try {
      await apiService.whatsapp.sendToHandover(handoverId, {
        templateName: tpl.name,
        templateLanguage: tpl.language,
        templateVars,
        ...recipientBody(),
      });
      setTplArgs({}); setOk(`Template “${tpl.label}” sent to ${selected ? selected.name : 'customer'}.`); await load();
    } catch (e) { setErr(mapErr(e)); }
    finally { setSending(false); }
  };

  if (items === null) return <div style={{ color: '#9ca3af', fontSize: 13 }}>Loading communications…</div>;

  const CH = CHANNEL_META;

  const addParticipant = async (p, as) => {
    setAddMsg('');
    try {
      if (as === 'team' && p.matchedUserId) {
        await apiService.handovers.requestMember(handoverId, { userId: p.matchedUserId });
        setAddMsg(`${p.name} added to the project team.`);
      } else {
        const data = p.contactId ? { contactId: p.contactId, handoverRole: 'other' } : { name: p.name, email: p.email || null, handoverRole: 'other' };
        await apiService.handovers.addStakeholder(handoverId, data);
        setAddMsg(`${p.name} added as a contact.`);
      }
      await load();
    } catch (e) { setAddMsg(e?.response?.data?.error?.message || 'Could not add.'); }
  };

  const unknownPeople = people.filter(p => !p.onProject);
  const filterItems = (list) => (list || [])
    // channelGroup(), not a bare equality: the Chat tab covers teams AND gchat,
    // so filtering on m.channel would show nothing under it.
    .filter(m => channelFilter === 'all' || channelGroup(m.channel) === channelFilter)
    .filter(m => !personFilter || (m.participantKeys || []).includes(personFilter));

  return (
    <div>
      {/* Which conversations belong to this project. The timeline below renders
          the messages; this decides what is on it. Filing is thread-level, so
          every colleague's mailbox copy and every future reply come with it. */}
      <ProjectEmailThreads handoverId={handoverId} accountId={accountId} onChanged={load} />

      {/* Files shared in this project's WhatsApp groups, and what happened to
          them. Renders nothing when there are none, and by default shows only
          what needs a person — a saved file is not news. */}
      <ProjectAttachments handoverId={handoverId} />

      {/* Channel filter — All / Email / WhatsApp / Chat.
          Chat groups Teams and Google Chat: see channelGroup(). */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        {[['all', 'All'], ['email', 'Email'], ['whatsapp', 'WhatsApp'], ['chat', 'Chat']].map(([k, label]) => {
          const on = channelFilter === k;
          const count = k === 'all'
            ? (items || []).length
            : (items || []).filter(m => channelGroup(m.channel) === k).length;
          // Hide an empty Chat tab rather than showing a permanent zero. Every
          // other tab corresponds to a channel the org has configured; Chat only
          // exists once something is actually captured from Teams.
          if (k === 'chat' && count === 0) return null;
          return (
            <button key={k} onClick={() => setChannelFilter(k)} style={{ padding: '5px 12px', fontSize: 12, fontWeight: on ? 600 : 400, borderRadius: 6,
              border: `1px solid ${on ? '#0369a1' : '#e5e7eb'}`, background: on ? '#eff6ff' : '#fff', color: on ? '#0369a1' : '#374151', cursor: 'pointer' }}>
              {label} <span style={{ color: '#9ca3af' }}>{count}</span>
            </button>
          );
        })}
        {people.length > 0 && (
          <select value={personFilter} onChange={e => setPersonFilter(e.target.value)}
            style={{ marginLeft: 'auto', fontSize: 12, padding: '5px 8px', borderRadius: 6, border: '1px solid #d1d5db', maxWidth: 220 }}>
            <option value="">All people</option>
            {people.map(p => (
              <option key={p.key} value={p.key}>{p.name}{p.type === 'user' || p.type === 'offteam_user' ? ' (team)' : ''}{!p.onProject ? ' — not on project' : ''}</option>
            ))}
          </select>
        )}
      </div>

      {/* #7 — participants not on the project */}
      {unknownPeople.length > 0 && (
        <div style={{ border: '1px solid #fde68a', background: '#fffbeb', borderRadius: 8, padding: '10px 12px', marginBottom: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#92400e', marginBottom: 6 }}>
            {unknownPeople.length} {unknownPeople.length === 1 ? 'person is' : 'people are'} in these conversations but not on the project
          </div>
          {unknownPeople.map(p => (
            <div key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 13 }}>
              <span style={{ flex: 1, minWidth: 0 }}>{p.name}{p.email ? <span style={{ color: '#9ca3af' }}> · {p.email}</span> : null}</span>
              {p.matchedUserId && (
                <button onClick={() => addParticipant(p, 'team')} style={{ fontSize: 11, padding: '3px 10px', borderRadius: 5, border: '1px solid #93c5fd', background: '#eff6ff', color: '#1d4ed8', cursor: 'pointer' }}>+ Add to team</button>
              )}
              <button onClick={() => addParticipant(p, 'contact')} style={{ fontSize: 11, padding: '3px 10px', borderRadius: 5, border: 'none', background: '#059669', color: '#fff', cursor: 'pointer' }}>+ Add as contact</button>
            </div>
          ))}
          {addMsg && <div style={{ fontSize: 11, color: addMsg.includes('added') ? '#059669' : '#991b1b', marginTop: 6 }}>{addMsg}</div>}
        </div>
      )}

      <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, background: '#f9fafb', padding: 14,
        display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 440, overflowY: 'auto' }}>
        {filterItems(items).length === 0 ? (
          <div style={{ color: '#9ca3af', fontSize: 13 }}>No communications match.</div>
        ) : filterItems(items).map(m => {
          const out = m.direction === 'outbound';
          const ch  = CH[m.channel] || { label: m.channel, color: '#6b7280', bg: '#f3f4f6' };
          return (
            <div key={m.id} onClick={() => setOpenComm(m)} title="Open message"
              style={{ alignSelf: out ? 'flex-end' : 'flex-start', maxWidth: '80%', cursor: 'pointer' }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 2, justifyContent: out ? 'flex-end' : 'flex-start' }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: ch.color, background: ch.bg, padding: '1px 6px', borderRadius: 5 }}>{ch.label}</span>
                {m.isAutomated && <span style={{ fontSize: 10, color: '#6b7280' }}>automated</span>}
                <span style={{ fontSize: 11, color: '#9ca3af' }}>{m.from}</span>
              </div>
              <div style={{ padding: '8px 11px', borderRadius: 10, fontSize: 13, lineHeight: 1.45,
                background: out ? '#dcf8c6' : '#fff', border: `1px solid ${out ? '#c5eeae' : '#e5e7eb'}`, color: '#111827' }}>
                {m.subject && <div style={{ fontWeight: 600, marginBottom: 2 }}>{m.subject}</div>}
                <MessageBody text={m.body} mentions={m.mentions} />
              </div>
              <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2, textAlign: out ? 'right' : 'left' }}>
                {m.at ? new Date(m.at).toLocaleString() : ''}
              </div>
            </div>
          );
        })}
      </div>
      {/* Composer: pick a recipient, then Message vs Template gated by the window */}
      <div style={{ marginTop: 10 }}>
        {/* Recipient picker — a specific person, or a group */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: '#6b7280' }}>To:</span>
          {targets.length === 0 ? (
            <span style={{ fontSize: 12, color: '#9ca3af' }}>No reachable recipients yet.</span>
          ) : (
            <select value={selKey} onChange={e => { setSelKey(e.target.value); setErr(''); setOk(''); }}
              style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13, maxWidth: 320 }}>
              {targets.some(t => t.type === 'individual') && (
                <optgroup label="People">
                  {targets.filter(t => t.type === 'individual').map(t => (
                    <option key={t.key} value={t.key}>
                      {t.name}
                      {/* Vendors and partners stay selectable — messaging one
                          deliberately is legitimate. They are labelled so the
                          sender can see they are not writing to the customer.
                          Only the IMPLICIT default recipient is customer-only. */}
                      {t.side && t.side !== 'customer' ? ` · ${t.side}` : ''}
                      {t.phone ? ` · +${t.phone}` : ''}
                      {t.phoneValid === false ? ' · ⚠ needs country code' : ''}
                      {t.optedOut ? ' · opted out' : ''}
                    </option>
                  ))}
                </optgroup>
              )}
              {targets.some(t => t.type === 'group') && (
                <optgroup label="Groups">
                  {targets.filter(t => t.type === 'group').map(t => (
                    <option key={t.key} value={t.key}>{t.name} (group)</option>
                  ))}
                </optgroup>
              )}
            </select>
          )}
          <button onClick={() => { setShowCreateGroup(v => !v); setErr(''); setOk(''); setInviteLink(''); }}
            style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff',
              color: '#059669', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
            {showCreateGroup ? 'Cancel' : '+ New group'}
          </button>
        </div>

        {/* Create-group form: name it, create it, then share the invite link. */}
        {showCreateGroup && (
          <div style={{ border: '1px solid #d1fae5', background: '#f0fdf4', borderRadius: 8, padding: 10, marginBottom: 8 }}>
            <div style={{ fontSize: 11, color: '#065f46', marginBottom: 6 }}>
              Creates a WhatsApp group owned by this org's business number. Members join by tapping the invite link (opt-in only — up to 8 participants). Messages then flow into this timeline.
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input value={groupName} onChange={e => setGroupName(e.target.value)} placeholder="Group name (e.g. Acme rollout — project room)"
                onKeyDown={e => { if (e.key === 'Enter') createGroup(); }}
                style={{ flex: 1, minWidth: 220, padding: '7px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13 }} />
              <button onClick={createGroup} disabled={creatingGroup || !groupName.trim()}
                style={{ padding: '7px 14px', borderRadius: 6, border: 'none',
                  background: (creatingGroup || !groupName.trim()) ? '#9ca3af' : '#059669', color: '#fff',
                  fontSize: 13, fontWeight: 600, cursor: (creatingGroup || !groupName.trim()) ? 'default' : 'pointer' }}>
                {creatingGroup ? 'Creating…' : 'Create group'}
              </button>
            </div>
          </div>
        )}

        {/* Invite link to distribute to members. */}
        {inviteLink && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: '#6b7280' }}>Invite link:</span>
            <input readOnly value={inviteLink} onFocus={e => e.target.select()}
              style={{ flex: 1, minWidth: 220, padding: '6px 9px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 12, color: '#374151' }} />
            <button onClick={copyInvite}
              style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
              {linkCopied ? 'Copied' : 'Copy'}
            </button>
          </div>
        )}

        {selected && selected.type === 'individual' && selected.phoneValid === false && (
          <div style={{ fontSize: 11, color: '#b45309', marginBottom: 8 }}>
            ⚠︎ {selected.phoneIssue || 'This number is missing a country code.'} Fix it on the contact in Contacts before sending.
          </div>
        )}
        {selected && selected.type === 'group' && (
          <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 8 }}>
            {selected.note || 'Posts to everyone in the group.'} Each delivered copy is billed per recipient; free-form needs an open window, otherwise send an approved template.
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
          <div style={{ display: 'inline-flex', border: '1px solid #d1d5db', borderRadius: 6, overflow: 'hidden' }}>
            {['text', 'template'].map(m => (
              <button key={m} onClick={() => { setMode(m); setErr(''); setOk(''); }}
                style={{ padding: '5px 12px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
                  background: mode === m ? '#059669' : '#fff', color: mode === m ? '#fff' : '#374151' }}>
                {m === 'text' ? 'Message' : 'Template'}
              </button>
            ))}
          </div>
          {windowOpen === true && (
            <span style={{ fontSize: 11, color: '#059669' }}>
              ● Window open{windowExpiresAt ? ` · free-form until ${new Date(windowExpiresAt).toLocaleString()}` : ''}
            </span>
          )}
          {windowOpen === false && (
            <span style={{ fontSize: 11, color: '#b45309' }}>
              ● Window closed · only an approved template can be sent until the customer replies
            </span>
          )}
        </div>

        {mode === 'text' ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={text} onChange={e => setText(e.target.value)} placeholder="Send a WhatsApp message to the customer…"
              onKeyDown={e => { if (e.key === 'Enter') send(); }}
              style={{ flex: 1, padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13 }} />
            <button onClick={send} disabled={sending || !text.trim() || recipientBlocked} style={{
              padding: '8px 16px', borderRadius: 6, border: 'none',
              background: (sending || !text.trim() || recipientBlocked) ? '#9ca3af' : '#059669', color: '#fff',
              fontSize: 13, fontWeight: 600, cursor: (sending || !text.trim() || recipientBlocked) ? 'default' : 'pointer' }}>
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        ) : (
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, background: '#fff' }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.3, display: 'block', marginBottom: 4 }}>Template</label>
            <select value={tplName} onChange={e => { setTplName(e.target.value); setTplArgs({}); setErr(''); setOk(''); }}
              style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13, marginBottom: 6, boxSizing: 'border-box' }}>
              {templateList.map(t => <option key={t.name} value={t.name}>{t.label} — {t.language}</option>)}
            </select>
            {tpl.description && <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 10 }}>{tpl.description}</div>}

            {tpl.variables.map((v, i) => (
              <div key={i} style={{ marginBottom: 8 }}>
                <label style={{ fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 3 }}>{`{{${i + 1}}} · ${v.label}`}</label>
                <input value={tplArgs[i] || ''} onChange={e => setTplArgs(a => ({ ...a, [i]: e.target.value }))}
                  placeholder={v.placeholder || ''}
                  style={{ width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box' }} />
              </div>
            ))}

            <button onClick={sendTemplate} disabled={sending || recipientBlocked} style={{
              marginTop: 4, padding: '8px 16px', borderRadius: 6, border: 'none',
              background: (sending || recipientBlocked) ? '#9ca3af' : '#059669', color: '#fff',
              fontSize: 13, fontWeight: 600, cursor: (sending || recipientBlocked) ? 'default' : 'pointer' }}>
              {sending ? 'Sending…' : 'Send template'}
            </button>
          </div>
        )}
      </div>
      {ok  && <div style={{ marginTop: 6, fontSize: 12, color: '#059669' }}>{ok}</div>}
      {err && <div style={{ marginTop: 6, fontSize: 12, color: '#991b1b' }}>{err}</div>}
      {openComm && <CommMessageModal message={openComm} onClose={() => setOpenComm(null)}
        onOpenContact={(c) => { setOpenComm(null); setOpenContact(c); }}
        onMoved={() => { setOpenComm(null); load(); }} />}
      {openContact && <CustomerContactPanel stakeholder={openContact} onClose={() => setOpenContact(null)} />}
    </div>
  );
}

// ── ServiceNotes inline editor ────────────────────────────────────────────────

function ServiceNotes({ handoverId, initialNotes, onSaved }) {
  const [notes,  setNotes]  = useState(initialNotes || '');
  const [saving, setSaving] = useState(false);
  const [saved,  setSaved]  = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await apiService.handovers.update(handoverId, { serviceNotes: notes });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onSaved();
    } finally { setSaving(false); }
  };

  return (
    <div>
      <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={4}
        placeholder="Add implementation notes, next steps, or team assignments…"
        style={{ width: '100%', fontSize: 12, padding: '8px', borderRadius: 6, border: '1px solid #d1d5db', resize: 'vertical', boxSizing: 'border-box' }} />
      <button onClick={handleSave} disabled={saving} style={{
        marginTop: 6, fontSize: 12, padding: '5px 14px', borderRadius: 4,
        background: saved ? '#059669' : '#0369a1', color: '#fff', border: 'none', cursor: 'pointer',
      }}>
        {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save notes'}
      </button>
    </div>
  );
}

// ── PlaybookPicker ────────────────────────────────────────────────────────────
// Shown on the Summary tab when a project has no playbook. Until now that state
// was a dead end: playbook_id was only ever written when a deal closed, so any
// project created another way kept an empty checklist with no way to fill it.
function PlaybookPicker({ detail, canEdit, onRefresh }) {
  const [options, setOptions] = useState(null);
  const [choice, setChoice]   = useState('');
  const [busy, setBusy]       = useState(false);
  const [msg, setMsg]         = useState('');
  // Swapping cancels work already in flight, so it needs a deliberate second
  // press rather than happening as a side effect of a mis-click.
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  const load = () => {
    if (options) return;
    apiService.handovers.availablePlaybooks()
      .then(r => setOptions(r.data?.playbooks || []))
      .catch(() => setOptions([]));
  };

  const apply = async () => {
    if (!choice) return;
    setBusy(true); setMsg('');
    try {
      const r = await apiService.handovers.setPlaybook(detail.id, choice, null, replaceConfirmed);
      const w = r.data?.warnings || [];
      // Linking always succeeds; activation may not. Say which happened rather
      // than reporting a flat success and leaving an empty checklist unexplained.
      setMsg(r.data?.activated
        ? `${r.data.playbookName} linked — ${r.data.activated} plays added.`
        : (w[0] || `${r.data?.playbookName || 'Playbook'} linked, but no plays were activated.`));
      onRefresh?.();
    } catch (e) {
      const err = e?.response?.data?.error;
      if (e?.response?.status === 409) {
        // The server refused because a playbook is already linked. Explain the
        // cost, then let a second press go through.
        setConfirmText(err?.message || 'A playbook is already linked.');
        setReplaceConfirmed(true);
      } else {
        setMsg(err?.message || 'Could not link the playbook.');
      }
    } finally {
      setBusy(false);
    }
  };

  if (!canEdit) return <span style={{ color: '#6b7280' }}>No playbook linked.</span>;

  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      <span style={{ color: '#6b7280' }}>No playbook linked.</span>
      <select
        value={choice}
        onFocus={load}
        onMouseDown={load}
        onChange={e => setChoice(e.target.value)}
        style={{ fontSize: 13, padding: '6px 8px', borderRadius: 6, border: '1px solid #d1d5db', minHeight: 36 }}
      >
        <option value="">{options === null ? 'Choose a playbook…' : (options.length ? 'Choose a playbook…' : 'No playbooks available')}</option>
        {(options || []).map(p => (
          <option key={p.id} value={p.id}>{p.name}{p.is_default ? ' (default)' : ''}</option>
        ))}
      </select>
      <button
        type="button"
        onClick={apply}
        disabled={!choice || busy}
        style={{
          fontSize: 13, padding: '6px 12px', borderRadius: 6, minHeight: 36,
          border: '1px solid #0369a1', background: choice && !busy ? '#0369a1' : '#e5e7eb',
          color: choice && !busy ? '#fff' : '#9ca3af', fontWeight: 600,
          cursor: choice && !busy ? 'pointer' : 'not-allowed',
        }}
      >{busy ? 'Linking…' : (replaceConfirmed ? 'Replace anyway' : 'Link')}</button>
      {confirmText && (
        <span style={{ fontSize: 12, color: '#92400e', background: '#fef3c7',
                       border: '1px solid #fde68a', borderRadius: 6, padding: '6px 9px', lineHeight: 1.5 }}>
          {confirmText}
        </span>
      )}
      {msg && <span style={{ fontSize: 12, color: '#374151' }}>{msg}</span>}
    </span>
  );
}

// ── CreateProjectModal ────────────────────────────────────────────────────────
// Projects that don't come from a won deal. Internal ones carry no account —
// putting your own company in Accounts to satisfy a foreign key would pollute
// pipeline, prospecting and every account-grouped report.
// ── ConvertTrackingModeModal (2026_133) ───────────────────────────────────────
//
// Conversion is a real operation, not a migration: standing → time-boxed means
// naming an owner and a date, and the reverse means dropping them. Work already
// logged is unaffected either way, because every daily work entry snapshots its
// own anchor rather than joining back to the project.
//
// The 409 path is the reason this is a modal and not a menu item. Clearing the
// go-live date leaves any task scheduled from it holding a date with nothing
// behind it, and nothing recomputes those. The server refuses once and returns
// the affected tasks; this shows them and lets the person go ahead knowingly.
// ── GoLiveDriftBanner ─────────────────────────────────────────────────────────
//
// The visible half of the frozen-project rule.
//
// When a go-live moves on a project whose plan is FROZEN, the backend
// deliberately moves nothing: those dates are a commitment, and changing them
// is a rebaseline that needs a person, a permission and a reason. That is the
// right call, and it leaves a checklist quietly disagreeing with the project's
// own go-live date. Unsaid, that is just a wrong screen.
//
// So it is said, here, on the tab where the affected dates actually are —
// not on Overview where the date was changed. Someone acting on this has to
// open each task anyway.
//
// Always empty for an unfrozen project: there the dates have already moved, so
// any remaining difference is a deliberate manual adjustment and flagging it
// would be telling someone their own edit was a mistake.
function GoLiveDriftBanner({ handoverId, goLiveDate }) {
  const [drift, setDrift] = useState(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let alive = true;
    setDismissed(false);
    if (!goLiveDate) { setDrift(null); return; }
    apiService.handovers.goLiveDrift(handoverId)
      .then(r => { if (alive) setDrift(r.data); })
      .catch(() => { if (alive) setDrift(null); });   // never block the checklist
    return () => { alive = false; };
  }, [handoverId, goLiveDate]);

  const plays = drift?.plays || [];
  if (dismissed || plays.length === 0) return null;

  return (
    <div style={{ marginBottom: 16, padding: '12px 14px', borderRadius: 8,
                  background: '#fffbeb', border: '1px solid #fde68a',
                  fontSize: 12, color: '#92400e', lineHeight: 1.6 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <strong>
            {plays.length} task{plays.length === 1 ? '' : 's'} still scheduled from an older go-live date.
          </strong>
          <div>
            This project's plan is frozen, so moving the go-live did not move these.
            Changing them is a rebaseline — open each one and set the date with a reason.
          </div>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            {plays.slice(0, 6).map(p => (
              <li key={p.id} style={{ marginBottom: 2 }}>
                {p.title} · due {fmtDate(p.dueDate)}
                <span style={{ color: '#b45309' }}>
                  {' '}({p.driftDays > 0 ? `${p.driftDays}d later` : `${Math.abs(p.driftDays)}d earlier`} if
                  {' '}re-anchored to {fmtDate(drift.goLiveDate)})
                </span>
              </li>
            ))}
            {plays.length > 6 && (
              <li style={{ color: '#b45309' }}>…and {plays.length - 6} more</li>
            )}
          </ul>
        </div>
        <button onClick={() => setDismissed(true)} aria-label="Dismiss"
          style={{ border: 'none', background: 'none', cursor: 'pointer',
                   color: 'inherit', fontSize: 15, lineHeight: 1, padding: 0 }}>×</button>
      </div>
    </div>
  );
}

// ── ProjectDailyWork (2026_133) ───────────────────────────────────────────────
//
// The daily work logged against this project, inside the Projects module.
//
// A VIEW OVER AN ENDPOINT THAT ALREADY EXISTS. getLog has accepted an anchor
// filter since the daily work build; nothing new was added on the server for
// this. That matters, because the alternative — merging the two modules — was
// rejected for a good reason: most daily work has no project at all, so a
// project-shaped home makes the common case homeless.
//
// TWO THINGS THIS SCREEN IS HONEST ABOUT.
//
// 1. SCOPE. /daily-work/team/log bounds every read by the viewer's manager
//    chain, because a description is something a person wrote and is not
//    org-readable. So this shows work logged by you and your reports, not all
//    work on the project. Saying so beats quietly showing a partial list —
//    someone who assumes it is complete will conclude a colleague logged
//    nothing.
//
// 2. AVAILABILITY. requireModule returns 404 when Daily Work is off for the
//    org. Rendered as "not enabled" rather than an error, because that is what
//    it is.
function ProjectDailyWork({ handoverId }) {
  const [days, setDays] = useState(90);
  const [state, setState] = useState({ loading: true, rows: [], unavailable: false, error: '' });

  useEffect(() => {
    let alive = true;
    setState(s => ({ ...s, loading: true }));

    // Local dates, formatted by hand. new Date().toISOString().slice(0,10) is
    // the UTC day, which east of UTC is tomorrow for part of the evening — the
    // same trap the go-live date had.
    const pad = n => String(n).padStart(2, '0');
    const asStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const to = new Date();
    const from = new Date(); from.setDate(from.getDate() - days);

    apiService.dailyWork.teamLog({
      from: asStr(from), to: asStr(to),
      anchorKind: 'handover', anchorId: handoverId,
    })
      .then(r => { if (alive) setState({ loading: false, rows: r.data?.rows || [], unavailable: false, error: '' }); })
      .catch(e => {
        if (!alive) return;
        if (e?.response?.status === 404) {
          setState({ loading: false, rows: [], unavailable: true, error: '' });
        } else {
          setState({ loading: false, rows: [], unavailable: false,
                     error: e?.response?.data?.error || 'Could not load daily work.' });
        }
      });
    return () => { alive = false; };
  }, [handoverId, days]);

  if (state.unavailable) {
    return (
      <div style={{ padding: 30, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
        Daily Work is not enabled for this organisation.
      </div>
    );
  }

  const byPerson = new Map();
  for (const r of state.rows) {
    const name = `${r.first_name || ''} ${r.last_name || ''}`.trim() || 'Unknown';
    // Keyed and rendered by user_id, not by name: two people can share a name,
    // and a duplicate React key silently drops a row.
    if (!byPerson.has(r.user_id)) byPerson.set(r.user_id, { id: r.user_id, name, days: [], items: 0 });
    const p = byPerson.get(r.user_id);
    p.days.push(r);
    p.items += Number(r.item_count) || 0;
  }
  const people = [...byPerson.values()].sort((a, b) => b.items - a.items);

  const th = { textAlign: 'left', fontSize: 11, color: '#9ca3af', fontWeight: 600,
               textTransform: 'uppercase', letterSpacing: 0.3, padding: '0 12px 8px' };
  const td = { fontSize: 13, padding: '10px 12px', borderTop: '1px solid #f3f4f6', verticalAlign: 'top' };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <h4 style={{ margin: 0, fontSize: 14, color: '#374151' }}>
          📋 Daily work on this project
        </h4>
        <select value={days} onChange={e => setDays(Number(e.target.value))}
          style={{ fontSize: 13, padding: '5px 8px', borderRadius: 7, border: '1px solid #d1d5db' }}>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={365}>Last year</option>
        </select>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#9ca3af' }}>
          Logged by you and the people you manage
        </span>
      </div>

      {state.error && (
        <div style={{ fontSize: 12, color: '#991b1b', marginBottom: 10 }}>{state.error}</div>
      )}

      {state.loading ? (
        <div style={{ padding: 30, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>Loading…</div>
      ) : people.length === 0 ? (
        <div style={{ padding: 30, textAlign: 'center', color: '#9ca3af', fontSize: 13, lineHeight: 1.6 }}>
          No daily work logged against this project in the period.
          <div style={{ fontSize: 12, marginTop: 6 }}>
            Work is logged in the Daily Work module and anchored to a project there.
          </div>
        </div>
      ) : (
        <div className="gw-table-scroll" style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden', overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={th}>Person</th>
              <th style={th}>Days logged</th>
              <th style={th}>Most recent</th>
            </tr></thead>
            <tbody>
              {people.map(p => {
                const latest = p.days[0];
                return (
                  <tr key={p.id}>
                    <td style={{ ...td, fontWeight: 600, color: '#111827', whiteSpace: 'nowrap' }}>{p.name}</td>
                    <td style={{ ...td, color: '#6b7280', whiteSpace: 'nowrap' }}>
                      {p.days.length} · {p.items} {p.items === 1 ? 'item' : 'items'}
                    </td>
                    <td style={td}>
                      {latest ? (
                        <>
                          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 2 }}>
                            {fmtDate(latest.entry_date)}
                          </div>
                          <div style={{ color: '#374151' }}>{latest.work_done}</div>
                        </>
                      ) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ConvertTrackingModeModal({ detail, users = [], managerLabel = 'Project Manager',
                                    onClose, onConverted }) {
  const toStanding = !detail.isStanding;
  const [ownerId, setOwnerId] = useState(detail.assignedServiceOwnerId ? String(detail.assignedServiceOwnerId) : '');
  const [goLive,  setGoLive]  = useState(toInputDate(detail.goLiveDate));
  const [saving,  setSaving]  = useState(false);
  const [err,     setErr]     = useState('');
  const [stalePlays, setStalePlays] = useState(null);   // non-null = 409 shown

  const submit = async (acknowledge = false) => {
    setErr('');
    if (!toStanding && !ownerId) return setErr(`Name ${managerLabel.toLowerCase()}.`);
    if (!toStanding && !goLive)  return setErr('Give it an end date.');
    setSaving(true);
    try {
      await apiService.handovers.convertTrackingMode(detail.id, {
        trackingMode: toStanding ? 'standing' : 'timeboxed',
        ...(toStanding ? {} : { assignedServiceOwnerId: ownerId, goLiveDate: goLive }),
        ...(acknowledge ? { acknowledgeAnchoredPlays: true } : {}),
      });
      onConverted();
    } catch (e) {
      const body = e?.response?.data?.error;
      if (body?.code === 'GO_LIVE_ANCHORED_PLAYS') {
        setStalePlays(body.details?.plays || []);
        setErr('');
      } else {
        setErr(body?.message || 'Could not convert this.');
      }
    } finally { setSaving(false); }
  };

  const label = { fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 };
  const input = { width: '100%', fontSize: 14, padding: '9px 10px', borderRadius: 8,
                  border: '1px solid #d1d5db', minHeight: 44, boxSizing: 'border-box' };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: 12, width: 'min(520px, 94vw)',
                    maxHeight: '90vh', overflowY: 'auto', padding: 22 }}>
        <h3 style={{ margin: '0 0 4px', fontSize: 17, color: '#111827' }}>
          {toStanding ? 'Convert to a standing initiative' : 'Convert to a time-boxed project'}
        </h3>
        <p style={{ margin: '0 0 18px', fontSize: 12, color: '#6b7280', lineHeight: 1.55 }}>
          {toStanding
            ? 'It will stop counting toward the project statistics, lose its end date, and never be overdue. It can be retired later, but not completed.'
            : 'It will count as an active project, get an end date to be measured against, and complete once.'}
          {' '}Work already logged against it is unaffected either way.
        </p>

        {stalePlays ? (
          <div style={{ marginBottom: 16 }}>
            <div style={{ padding: 12, borderRadius: 8, background: '#fffbeb',
                          border: '1px solid #fde68a', fontSize: 12, color: '#92400e', lineHeight: 1.6 }}>
              <strong>{stalePlays.length} open task{stalePlays.length === 1 ? '' : 's'}</strong> on this
              project are scheduled from the go-live date. Removing that date does not recalculate
              them — they will keep the dates they have now.
            </div>
            <ul style={{ margin: '10px 0 0', paddingLeft: 18, fontSize: 12, color: '#374151' }}>
              {stalePlays.slice(0, 8).map(p => (
                <li key={p.id} style={{ marginBottom: 3 }}>
                  {p.title} <span style={{ color: '#9ca3af' }}>· {fmtDate(p.due_date)}</span>
                </li>
              ))}
              {stalePlays.length > 8 && (
                <li style={{ color: '#9ca3af' }}>…and {stalePlays.length - 8} more</li>
              )}
            </ul>
          </div>
        ) : !toStanding && (
          <>
            <div style={{ marginBottom: 14 }}>
              <label style={label}>{managerLabel}</label>
              <select style={input} value={ownerId} onChange={e => setOwnerId(e.target.value)}>
                <option value="">Select…</option>
                {users.map(u => (
                  <option key={u.id} value={u.id}>{u.firstName ? `${u.firstName} ${u.lastName || ''}`.trim() : u.email}</option>
                ))}
              </select>
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={label}>End date</label>
              <input type="date" style={input} value={goLive} onChange={e => setGoLive(e.target.value)} />
            </div>
          </>
        )}

        {err && <div style={{ fontSize: 12, color: '#991b1b', marginBottom: 12 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} disabled={saving} style={{
            minHeight: 40, padding: '8px 16px', borderRadius: 8, fontSize: 13,
            border: '1px solid #d1d5db', background: '#fff', color: '#4b5563', cursor: 'pointer',
          }}>Cancel</button>
          <button type="button" disabled={saving} onClick={() => submit(stalePlays != null)} style={{
            minHeight: 40, padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600,
            border: '1px solid #7c3aed', background: '#7c3aed', color: '#fff',
            cursor: saving ? 'wait' : 'pointer',
          }}>
            {saving ? 'Converting…' : stalePlays ? 'Convert anyway' : 'Convert'}
          </button>
        </div>
      </div>
    </div>
  );
}

function CreateProjectModal({ users = [], managerLabel = 'Project Manager',
                             viewerRole = null, canCreateStanding = false,
                             initialTrackingMode = 'timeboxed', onClose, onCreated }) {
  const [kind, setKind]       = useState('internal');
  // 2026_133. The second axis, independent of kind: a retainer is customer +
  // standing and a migration is internal + time-boxed. Seeded from which screen
  // the person pressed the button on, because that is what they already meant.
  const [trackingMode, setTrackingMode] = useState(
    canCreateStanding ? initialTrackingMode : 'timeboxed');
  const [name, setName]       = useState('');
  const [budget, setBudget]   = useState('');
  const [goLive, setGoLive]   = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [accounts, setAccounts]   = useState([]);
  const [saving, setSaving]   = useState(false);
  const [err, setErr]         = useState('');

  // ── Creating the missing thing without losing this form ────────────────────
  //
  // Both dead ends here — no account, no one to assign — used to mean cancel,
  // go elsewhere, come back and retype. Everything typed so far is lost, and
  // the second attempt is the one people abandon. So both are handled inline:
  // the half-filled form stays on screen throughout.
  const [showNewAccount, setShowNewAccount] = useState(false);
  const [newAccName, setNewAccName]         = useState('');
  const [newAccDomain, setNewAccDomain]     = useState('');
  const [accBusy, setAccBusy]               = useState(false);
  const [accErr, setAccErr]                 = useState('');

  const [showInvite, setShowInvite]   = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteBusy, setInviteBusy]   = useState(false);
  const [inviteErr, setInviteErr]     = useState('');
  const [inviteOk, setInviteOk]       = useState('');

  // Only an owner or admin can invite directly. Everyone else raises a request
  // an admin approves — the same on-behalf-of flow used elsewhere. Showing an
  // admin-only link to a member would be sending them to a locked door.
  const canInviteDirectly = ['owner', 'admin'].includes(viewerRole);

  useEffect(() => {
    if (kind !== 'customer') return undefined;
    let alive = true;
    apiService.accounts.getAll('org')
      .then(r => { if (alive) setAccounts(r.data?.accounts || []); })
      .catch(() => { if (alive) setAccounts([]); });
    return () => { alive = false; };
  }, [kind]);

  /**
   * Create the account and select it, without leaving the form.
   *
   * The API rejects a duplicate name or domain with 409 and returns the id of
   * the account that already exists. That is not an error worth showing as
   * one — it is the account they were looking for. Select it and say so.
   */
  const createAccount = async () => {
    const n = newAccName.trim();
    if (!n) { setAccErr('Give the account a name.'); return; }
    setAccBusy(true); setAccErr('');
    try {
      const r = await apiService.accounts.create({
        name: n, ...(newAccDomain.trim() ? { domain: newAccDomain.trim() } : {}),
      });
      const created = r.data?.account || r.data;
      if (created?.id) {
        setAccounts(list => [...list, created].sort((a, b) => (a.name || '').localeCompare(b.name || '')));
        setAccountId(String(created.id));
      }
      setShowNewAccount(false);
      setNewAccName(''); setNewAccDomain('');
    } catch (e) {
      const body = e?.response?.data?.error;
      if (body?.existingAccountId) {
        setAccountId(String(body.existingAccountId));
        setShowNewAccount(false);
        setAccErr('');
        setErr('');
        // Pull the list again so the picker shows its real name rather than a
        // selected id with no matching option.
        apiService.accounts.getAll('org')
          .then(res => setAccounts(res.data?.accounts || []))
          .catch(() => {});
        return;
      }
      setAccErr(body?.message || 'Could not create that account.');
    } finally {
      setAccBusy(false);
    }
  };

  /**
   * Get a new person into the org so they can be assigned.
   *
   * An admin is sent to the invitation screen. Anyone else raises a request an
   * admin approves — nobody gets to add users to an org by typing an address
   * into a project form.
   *
   * Either way the new person cannot be assigned to THIS project: they do not
   * exist yet. Said plainly below rather than left to be discovered.
   */
  const requestUser = async () => {
    const email = inviteEmail.trim().toLowerCase();
    if (!email || !email.includes('@')) { setInviteErr('Enter a valid email address.'); return; }
    setInviteBusy(true); setInviteErr(''); setInviteOk('');
    try {
      await apiService.handovers.requestNewUserModule(email, 'handovers');
      setInviteOk(`Requested. An admin approves it, and ${email} is emailed an invitation. `
                + 'They can be assigned once they have joined.');
      setInviteEmail('');
    } catch (e) {
      setInviteErr(e?.response?.data?.error?.message || 'Could not send that request.');
    } finally {
      setInviteBusy(false);
    }
  };

  const standing = trackingMode === 'standing';

  const submit = async () => {
    setErr('');
    if (!name.trim())                        return setErr('Give the project a name.');
    if (kind === 'customer' && !accountId)   return setErr('A customer project needs an account.');
    // Checked here as well as on the server, so the person is told before they
    // wait on a round trip. The server is still the authority — this is a
    // convenience, not the gate.
    if (!standing && !ownerId)  return setErr(`A time-boxed project needs ${managerLabel.toLowerCase()}.`);
    if (!standing && !goLive)   return setErr('A time-boxed project needs an end date. If this work has no end, make it a standing initiative.');
    setSaving(true);
    try {
      await apiService.handovers.createProject({
        kind,
        name: name.trim(),
        trackingMode,
        ...(kind === 'customer' ? { accountId } : {}),
        ...(kind === 'internal' && budget ? { budget } : {}),
        // Never sent for a standing initiative: the server refuses it rather
        // than dropping it, which is right — a date on something that never
        // finishes means the person misunderstood, and silence would let them
        // keep believing it.
        ...(!standing && goLive  ? { goLiveDate: goLive } : {}),
        ...(!standing && ownerId ? { assignedServiceOwnerId: ownerId } : {}),
      });
      onCreated();
    } catch (e) {
      setErr(e?.response?.data?.error?.message || 'Could not create the project.');
    } finally {
      setSaving(false);
    }
  };

  const label = { fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 };
  const input = { width: '100%', fontSize: 14, padding: '9px 10px', borderRadius: 8,
                  border: '1px solid #d1d5db', minHeight: 44, boxSizing: 'border-box' };
  // A text button, not an anchor: this opens a panel in place rather than
  // navigating, and an <a> would promise a page change that does not happen.
  const linkBtn = { marginTop: 6, background: 'none', border: 'none', padding: 0,
                    fontSize: 12, color: '#0369a1', cursor: 'pointer', fontWeight: 500 };
  const inlinePanel = { marginTop: 8, padding: 12, borderRadius: 8,
                        background: '#f9fafb', border: '1px solid #e5e7eb' };
  const smallPrimary = { minHeight: 36, padding: '7px 14px', borderRadius: 7, fontSize: 12,
                         fontWeight: 600, border: '1px solid #0369a1', background: '#0369a1',
                         color: '#fff', cursor: 'pointer' };
  const smallGhost = { minHeight: 36, padding: '7px 14px', borderRadius: 7, fontSize: 12,
                       border: '1px solid #d1d5db', background: '#fff', color: '#4b5563',
                       cursor: 'pointer' };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: 12, width: 'min(520px, 94vw)',
                    maxHeight: '90vh', overflowY: 'auto', padding: 22 }}>
        <h3 style={{ margin: '0 0 4px', fontSize: 17, color: '#111827' }}>
          {standing ? 'New standing initiative' : 'New project'}
        </h3>
        <p style={{ margin: '0 0 18px', fontSize: 12, color: '#6b7280', lineHeight: 1.55 }}>
          {standing
            ? 'An ongoing area of work with no end date. Daily work can be logged against it, and it never completes — it can only be retired.'
            : "For work that didn't come from a won deal. Projects created when a deal closes appear here automatically."}
        </p>

        {/* Tracking mode, above Type on purpose: it changes which of the fields
            below are asked for at all, so asking it second would mean showing a
            date field and then taking it away. Hidden entirely for people who
            cannot create a standing initiative — a disabled control they can
            never use is just a question they cannot answer. */}
        {canCreateStanding && (
          <div style={{ marginBottom: 14 }}>
            <span style={label}>How is this tracked?</span>
            <div style={{ display: 'flex', gap: 8 }}>
              {[['timeboxed', 'Time-boxed project'], ['standing', 'Standing initiative']].map(([k, l]) => (
                <button key={k} type="button" onClick={() => setTrackingMode(k)} style={{
                  flex: 1, minHeight: 44, borderRadius: 8, fontSize: 13, cursor: 'pointer',
                  border: `1px solid ${trackingMode === k ? '#7c3aed' : '#d1d5db'}`,
                  background: trackingMode === k ? '#ede9fe' : '#fff',
                  color: trackingMode === k ? '#5b21b6' : '#4b5563',
                  fontWeight: trackingMode === k ? 600 : 400,
                }}>{l}</button>
              ))}
            </div>
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6, lineHeight: 1.5 }}>
              {standing
                ? 'Never completes and is never overdue. No owner or end date — it is measured by whether work is happening on it.'
                : 'Has an owner and an end date, completes once, and counts in the project statistics.'}
            </div>
          </div>
        )}

        <div style={{ marginBottom: 14 }}>
          <span style={label}>Type</span>
          <div style={{ display: 'flex', gap: 8 }}>
            {[['internal', 'Internal'], ['customer', 'Customer']].map(([k, l]) => (
              <button key={k} type="button" onClick={() => setKind(k)} style={{
                flex: 1, minHeight: 44, borderRadius: 8, fontSize: 13, cursor: 'pointer',
                border: `1px solid ${kind === k ? '#0369a1' : '#d1d5db'}`,
                background: kind === k ? '#e0f2fe' : '#fff',
                color: kind === k ? '#0369a1' : '#4b5563',
                fontWeight: kind === k ? 600 : 400,
              }}>{l}</button>
            ))}
          </div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6, lineHeight: 1.5 }}>
            {kind === 'internal'
              ? 'Run inside your own organisation — no customer, no account.'
              : 'Delivery for an account that never went through the pipeline.'}
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={label}>{standing ? 'Initiative name' : 'Project name'}</label>
          <input style={input} value={name} onChange={e => setName(e.target.value)}
                 placeholder={standing
                   ? (kind === 'internal' ? 'e.g. Skill Development' : 'e.g. Acme managed service')
                   : (kind === 'internal' ? 'e.g. ISO 27001 certification' : 'e.g. Goodwill remediation')} />
        </div>

        {kind === 'customer' && (
          <div style={{ marginBottom: 14 }}>
            <label style={label}>Account</label>
            <select style={input} value={accountId} onChange={e => setAccountId(e.target.value)}>
              <option value="">Select an account…</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>

            {!showNewAccount ? (
              <button type="button" onClick={() => { setShowNewAccount(true); setAccErr(''); }}
                style={linkBtn}>
                + Not there? Create an account
              </button>
            ) : (
              <div style={inlinePanel}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 8 }}>
                  New account
                </div>
                <input style={{ ...input, marginBottom: 8 }} value={newAccName}
                       onChange={e => setNewAccName(e.target.value)}
                       placeholder="Account name" autoFocus />
                <input style={{ ...input, marginBottom: 8 }} value={newAccDomain}
                       onChange={e => setNewAccDomain(e.target.value)}
                       placeholder="Website domain (optional)" />
                <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 8, lineHeight: 1.5 }}>
                  Adding the domain is what lets duplicate detection work later. You can fill in
                  the rest from the account itself.
                </div>
                {accErr && <div style={{ fontSize: 12, color: '#991b1b', marginBottom: 8 }}>{accErr}</div>}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={createAccount} disabled={accBusy} style={smallPrimary}>
                    {accBusy ? 'Creating…' : 'Create and select'}
                  </button>
                  <button type="button" onClick={() => { setShowNewAccount(false); setAccErr(''); }}
                          disabled={accBusy} style={smallGhost}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        )}

        {kind === 'internal' && (
          <div style={{ marginBottom: 14 }}>
            <label style={label}>Budget <span style={{ fontWeight: 400, color: '#9ca3af' }}>(optional)</span></label>
            <input style={input} type="number" min="0" value={budget}
                   onChange={e => setBudget(e.target.value)} placeholder="0" />
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12, marginBottom: 14 }}>
          <div>
            <label style={label}>Target date <span style={{ fontWeight: 400, color: '#9ca3af' }}>(optional)</span></label>
            <input style={input} type="date" value={goLive} onChange={e => setGoLive(e.target.value)} />
          </div>
          <div>
            {/* The label follows the org's own vocabulary — set once in
                Settings and already used by the project list and detail header.
                This form was the last screen still saying "Service owner"
                regardless, which is the inconsistency 2026_90 set out to fix. */}
            <label style={label}>{managerLabel} <span style={{ fontWeight: 400, color: '#9ca3af' }}>(optional)</span></label>
            <select style={input} value={ownerId} onChange={e => setOwnerId(e.target.value)}>
              <option value="">Unassigned</option>
              {users.map(u => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
            </select>

            {!showInvite ? (
              <button type="button" onClick={() => { setShowInvite(true); setInviteErr(''); setInviteOk(''); }}
                style={linkBtn}>
                + Not listed? Add someone
              </button>
            ) : (
              <div style={inlinePanel}>
                {canInviteDirectly ? (
                  <>
                    <div style={{ fontSize: 12, color: '#374151', lineHeight: 1.55, marginBottom: 10 }}>
                      Invitations are managed in <strong>Settings → Invitations</strong>, where you
                      can set the role and module access at the same time.
                    </div>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 10, lineHeight: 1.5 }}>
                      Create the project first — leaving now loses what you have typed. The
                      {' '}{managerLabel.toLowerCase()} can be assigned from the project once they
                      have joined.
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button type="button" style={smallGhost}
                        onClick={() => { window.location.hash = '#/org-admin'; }}>
                        Go to Settings
                      </button>
                      <button type="button" style={smallGhost} onClick={() => setShowInvite(false)}>
                        Close
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
                      Ask an admin to add them
                    </div>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 8, lineHeight: 1.5 }}>
                      Adding people to the organisation needs an admin. This sends the request;
                      once they approve it, the invitation email goes out.
                    </div>
                    <input style={{ ...input, marginBottom: 8 }} type="email" value={inviteEmail}
                           onChange={e => setInviteEmail(e.target.value)}
                           placeholder="their@email.com" autoFocus />
                    {inviteErr && <div style={{ fontSize: 12, color: '#991b1b', marginBottom: 8 }}>{inviteErr}</div>}
                    {inviteOk  && <div style={{ fontSize: 12, color: '#065f46', marginBottom: 8, lineHeight: 1.5 }}>{inviteOk}</div>}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button type="button" onClick={requestUser} disabled={inviteBusy} style={smallPrimary}>
                        {inviteBusy ? 'Sending…' : 'Send request'}
                      </button>
                      <button type="button" onClick={() => setShowInvite(false)}
                              disabled={inviteBusy} style={smallGhost}>Close</button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {err && <div style={{ fontSize: 12, color: '#991b1b', marginBottom: 12 }}>{err}</div>}

        <div className="gw-wrap-mobile" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} disabled={saving} style={{
            minHeight: 44, padding: '9px 18px', borderRadius: 8, fontSize: 13,
            border: '1px solid #d1d5db', background: '#fff', color: '#4b5563', cursor: 'pointer',
          }}>Cancel</button>
          <button onClick={submit} disabled={saving} style={{
            minHeight: 44, padding: '9px 18px', borderRadius: 8, fontSize: 13, fontWeight: 600,
            border: '1px solid #0369a1', background: '#0369a1', color: '#fff',
            cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1,
          }}>{saving ? 'Creating…' : 'Create project'}</button>
        </div>
      </div>
    </div>
  );
}

// ── HandoverView ──────────────────────────────────────────────────────────────

export default function HandoverView({ openHandoverId, onHandoverOpened }) {
  const [tab,         setTab]         = useState(() => parseHandoverHash().scope || 'mine');
  const [handovers,   setHandovers]   = useState([]);
  const [selected,    setSelected]    = useState(null);
  const [loading,     setLoading]     = useState(true);
  const [searchTerm,  setSearchTerm]  = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [users,       setUsers]       = useState([]); // org members for owner pickers
  const [pendingOpenId, setPendingOpenId] = useState(null); // dashboard → open a project
  // Which scope tabs this viewer may use. Server-resolved: team needs direct or
  // indirect reports, org needs a role the org has whitelisted. Defaults to
  // neither, so a failed call degrades to the original two tabs rather than
  // showing a control that will 403.
  const [access, setAccess] = useState({ canUseTeam: false, canUseOrg: false });
  // What this org calls the person accountable for a project. Resolved on the
  // server from org config; a project may override it.
  const [managerLabel, setManagerLabel] = useState('Project Manager');
  // Which people's projects to show within My Work. Independent of `tab`,
  // which selects the view.
  const [scope, setScope] = useState('mine');
  // '' = both kinds. Independent of scope: kind is what a project IS, scope is
  // whose it is.
  const [kindFilter, setKindFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  // Initiatives screen (2026_133). Retired ones are hidden by default: retire
  // is the standing equivalent of completion, and a completed thing does not
  // belong in the working list.
  const [showRetired, setShowRetired] = useState(false);
  const [retireBusyId, setRetireBusyId] = useState(null);
  // Off by default: for most people "the deals I closed" is not a useful lens,
  // and they stay attached to those projects through project_members instead.
  const [showFromMyDeals, setShowFromMyDeals] = useState(false);
  // null = follow the org default. An array is an explicit per-user choice and
  // wins over it. 'assigned' and 'dashboard' are always present, so a user
  // cannot leave themselves with no tabs at all.
  const [tabPref, setTabPref] = useState(null);
  // Deep-link (refresh-survival): the handover id + sub-tab from the URL hash.
  const [pendingHashId,  setPendingHashId]  = useState(() => parseHandoverHash().id);
  const [detailSubTab,   setDetailSubTab]   = useState(() => parseHandoverHash().sub);

  const loadList = useCallback(async () => {
    // The dashboard renders from /portfolio and the vendors tab from
    // /account-relationships. Neither is a scope the list endpoint accepts —
    // calling it would 400.
    if (tab === 'dashboard' || tab === 'vendors') { setHandovers([]); setLoading(false); return; }
    setLoading(true);
    try {
      // 'mine' on the From My Deals tab means created_by; 'mine' inside My Work
      // means "projects I have a role on", which the API calls 'assigned'.
      // The Initiatives screen is org-wide: a standing initiative belongs to
      // nobody in particular, so scoping it to "projects I have a role on"
      // would hide the very things everyone logs work against.
      const apiScope = tab === 'initiatives'
        ? 'org'
        : (tab === 'mine' ? 'mine' : (scope === 'mine' ? 'assigned' : scope));
      const res = await apiService.handovers.list(
        apiScope, undefined,
        tab === 'initiatives' ? undefined : (kindFilter || undefined),
        // Omitted would default to 'timeboxed' on the server, which is right
        // for every other tab and wrong for exactly this one.
        tab === 'initiatives' ? 'standing' : undefined);
      setHandovers(res.data.handovers || []);
    } catch (e) {
      // 'org' scope 403s when the org has not whitelisted the viewer's role.
      // Falling back keeps the screen usable rather than showing it empty and
      // letting someone conclude there are no initiatives.
      if (tab === 'initiatives' && e?.response?.status === 403) {
        try {
          const res = await apiService.handovers.list('assigned', undefined, undefined, 'standing');
          setHandovers(res.data.handovers || []);
        } catch { setHandovers([]); }
      } else setHandovers([]);
    } finally { setLoading(false); }
  }, [tab, scope, kindFilter]);

  const doRetire = useCallback(async (h) => {
    setRetireBusyId(h.id);
    try { await apiService.handovers.retire(h.id); await loadList(); }
    catch (e) { window.alert(e?.response?.data?.error?.message || 'Could not retire that initiative.'); }
    finally { setRetireBusyId(null); }
  }, [loadList]);

  const doUnretire = useCallback(async (h) => {
    setRetireBusyId(h.id);
    try { await apiService.handovers.unretire(h.id); await loadList(); }
    catch (e) { window.alert(e?.response?.data?.error?.message || 'Could not un-retire that initiative.'); }
    finally { setRetireBusyId(null); }
  }, [loadList]);

  useEffect(() => { loadList(); setSelected(null); }, [loadList]);

  // Org members for the commitment owner picker — fetched once, shared across
  // the detail panel. Failure is non-fatal: the picker just shows "Unassigned".
  useEffect(() => {
    let alive = true;
    apiService.handovers.assignableUsers()
      .then(res => { if (alive) setUsers(res.data?.users || []); })
      .catch(() => { if (alive) setUsers([]); });
    return () => { alive = false; };
  }, []);

  // Deep-link: open specific handover if passed in
  useEffect(() => {
    if (openHandoverId && handovers.length > 0) {
      const found = handovers.find(h => h.id === openHandoverId);
      if (found) { setSelected(found); setDetailSubTab('summary'); onHandoverOpened?.(); }
    }
  }, [openHandoverId, handovers, onHandoverOpened]);

  // Dashboard drill-down: open the clicked project once the list is loaded.
  useEffect(() => {
    if (pendingOpenId && handovers.length > 0) {
      const found = handovers.find(h => h.id === pendingOpenId);
      if (found) { setSelected(found); setDetailSubTab('summary'); setPendingOpenId(null); }
    }
  }, [pendingOpenId, handovers]);

  // ── Daily Work deep link ────────────────────────────────────────────────
  //
  // Every other open-by-id path here searches `handovers` and gives up if the
  // project is not there. That works for the dashboard and the hash, which
  // only ever name projects already on the viewer's board — but a manager
  // following a task from someone's timeline is usually NOT a member of that
  // project, so the list will not contain it and the search would silently do
  // nothing.
  //
  // So this path fetches the project by id instead. That is not a widening:
  // GET /sales/:id is org-scoped with no membership check, so this fetches
  // exactly what the viewer could already have fetched. The board's scope
  // filtering is untouched — the project does not join their list, it is just
  // open in front of them, and it disappears again when they leave.
  //
  // The daily-work side has already confirmed the link is still honest before
  // dispatching, so a failure here is a genuine fault rather than a lapsed
  // basis, and says so.
  useEffect(() => {
    const onDeepLink = async (e) => {
      const { handoverId, playInstanceId, scope, sub } = e.detail || {};
      if (!handoverId) return;
      // Parked before the project is opened, so it is already waiting whether
      // the detail mounts fresh or is re-used for a project already on screen.
      setPendingPlayFocus(handoverId, playInstanceId);
      if (scope) setTab(scope);
      setDetailSubTab(sub || 'details');
      setDeepLinkError(null);
      const known = handovers.find(h => h.id === handoverId);
      if (known) { setSelected(known); return; }
      try {
        const { data } = await apiService.handovers.getById(handoverId);
        const project = data?.handover || data;
        if (project?.id) setSelected(project);
        else setDeepLinkError('That project could not be opened. It may have been deleted.');
      } catch {
        setDeepLinkError('That project could not be opened. It may have been deleted.');
      }
    };
    window.addEventListener('handover-deeplink', onDeepLink);
    return () => window.removeEventListener('handover-deeplink', onDeepLink);
  }, [handovers]);

  // The way back. Read once on mount and held in state — NOT read from
  // sessionStorage on every render, or dismissing it would have nothing to
  // dismiss. Cleared from storage on use so it does not resurface days later
  // on an unrelated visit to a project.
  // A deep link that could not be opened. Its own state rather than a shared
  // 'error': everything else in this component reports failure by leaving the
  // list empty, and this is the one case where the user asked for a specific
  // thing and needs telling that it is not there.
  const [deepLinkError, setDeepLinkError] = useState(null);

  const [returnCrumb, setReturnCrumb] = useState(() => {
    try {
      const raw = sessionStorage.getItem('gwc_dailywork_return');
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  });

  const dismissCrumb = useCallback(() => {
    try { sessionStorage.removeItem('gwc_dailywork_return'); } catch { /* ignore */ }
    setReturnCrumb(null);
  }, []);

  const followCrumb = useCallback(() => {
    const c = returnCrumb;
    dismissCrumb();
    if (!c) return;
    window.dispatchEvent(new CustomEvent('return-to-dailywork', { detail: c }));
  }, [returnCrumb, dismissCrumb]);

  // Refresh-survival: once the (scope-matched) list is loaded, open the handover
  // named in the URL hash. The sub-tab was restored into detailSubTab already.
  useEffect(() => {
    if (!pendingHashId || handovers.length === 0) return;
    const target = handovers.find(h => h.id === pendingHashId);
    if (target) setSelected(target);
    setPendingHashId(null);
  }, [pendingHashId, handovers]);

  // Mirror the current screen into the hash so a refresh lands back here.
  // Only while Handovers is the active tab; held until any hash-restore resolves.
  useEffect(() => {
    if (hashSegment(0) !== 'handovers') return;
    if (pendingHashId) return;
    let parts;
    if (tab === 'dashboard' || tab === 'vendors' || (tab === 'initiatives' && !selected)) {
      parts = ['handovers', tab];
    } else if (selected) {
      const sub = (detailSubTab && detailSubTab !== 'summary') ? detailSubTab : null;
      parts = tab === 'mine'
        ? ['handovers', selected.id, sub]
        : ['handovers', tab, selected.id, sub];
    } else {
      parts = tab === 'mine' ? ['handovers'] : ['handovers', tab];
    }
    // `scope` is intentionally not in the hash: it is a per-viewer lens, not
    // part of what a shared link should mean. A colleague opening the link
    // must resolve it against their own rights, not the sender's.
    writeHash(parts);
  }, [tab, selected, detailSubTab, pendingHashId]);

  useEffect(() => {
    let alive = true;
    apiService.handovers.projectAccess()
      .then(r => {
        if (!alive) return;
        if (r.data?.viewer)   setAccess(r.data.viewer);
        if (r.data?.settings) setShowFromMyDeals(Boolean(r.data.settings.show_from_my_deals_tab));
        if (r.data?.managerLabel) setManagerLabel(r.data.managerLabel);
      })
      .catch(() => {});   // stay on the default two tabs
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    apiService.userPreferences.get()
      .then(r => {
        const p = r.data?.preferences?.project_tabs;
        if (alive && Array.isArray(p)) setTabPref(p);
      })
      .catch(() => {});   // fall back to the org default
    return () => { alive = false; };
  }, []);

  // Explicit user choice wins; otherwise the org setting decides.
  const fromMyDealsVisible = tabPref ? tabPref.includes('mine') : showFromMyDeals;

  // If the tab currently in view has just been switched off — by the org
  // setting or by this user's own preference — move to My Work rather than
  // leaving them on a view with no button to return to.
  useEffect(() => {
    if (tab === 'mine' && !fromMyDealsVisible) setTab('assigned');
  }, [tab, fromMyDealsVisible]);

  const handleOpenProject = (id) => { setTab('mine'); setPendingOpenId(id); };

  // From the vendors panel the viewer is there because they hold a role on the
  // project, so My Work is the tab that will actually contain it. 'mine' is
  // created_by and is hidden for most people.
  const handleOpenVendorProject = (id) => { setTab('assigned'); setScope('mine'); setPendingOpenId(id); };

  const filtered = handovers.filter(h => {
    const matchSearch = !searchTerm ||
      (h.projectName || h.dealName || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (h.accountName || '').toLowerCase().includes(searchTerm.toLowerCase());
    const matchStatus = !statusFilter || h.status === statusFilter;
    return matchSearch && matchStatus;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: '#f9fafb' }}>

      {/* ── Top tabs (full width) ─────────────────────── */}
      <div className="gw-scroll-x" style={{ display: 'flex', borderBottom: '2px solid #e5e7eb', background: '#fff', flexShrink: 0 }}>
        {[
          // 'mine' is created_by — the deals this person closed. Off by default
          // (org/user config); they stay attached through project_members.
          ...(fromMyDealsVisible ? [{ key: 'mine', label: '📤 From My Deals' }] : []),
          { key: 'assigned',  label: '🧭 My Work' },
          // Its own screen, not a filter on the projects list. Standing
          // initiatives answer a different question and the projects table's
          // columns — go-live, overdue, commitments closed — are all about
          // finishing, which they never do.
          { key: 'initiatives', label: '🌱 Initiatives' },
          { key: 'dashboard', label: '📊 Dashboard' },
          // Org-wide registry of who we buy from and build with. Lives here
          // rather than beside Accounts so it is gated by the Projects module,
          // which is its only consumer.
          { key: 'vendors',   label: '🤝 Vendors and partners' },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: '12px 22px', background: 'none', border: 'none',
            borderBottom: `3px solid ${tab === t.key ? '#0369a1' : 'transparent'}`,
            color: tab === t.key ? '#0369a1' : '#6b7280',
            fontWeight: tab === t.key ? 700 : 400,
            fontSize: 13, cursor: 'pointer', transition: 'all 0.15s',
          }}>{t.label}</button>
        ))}
      </div>

      {/* Shown on the list, not in the detail pane: a deep link that failed
          left nothing selected, so there is no detail pane to put it in. This
          is the case the Daily Work side cannot pre-empt — it checks the link
          is still honest before navigating, so reaching here means the project
          went missing between that check and this fetch. */}
      {deepLinkError && (
        <div style={{ margin: '10px 20px 0', padding: '8px 12px', borderRadius: 8,
                      background: '#fef2f2', border: '1px solid #fecaca',
                      color: '#b91c1c', fontSize: 13, display: 'flex',
                      alignItems: 'center', gap: 10 }}>
          <span>{deepLinkError}</span>
          <button onClick={() => setDeepLinkError(null)}
                  style={{ marginLeft: 'auto', border: 'none', background: 'none',
                           color: '#b91c1c', cursor: 'pointer', fontSize: 13 }}>
            Dismiss
          </button>
        </div>
      )}

      {/* Scope applies to My Work only: which people's projects, as opposed to
          which view. Hidden entirely when the viewer has neither team nor org
          rights, so a solo contributor sees no dead control. */}
      {tab === 'assigned' && (access.canUseTeam || access.canUseOrg) && (
        <div className="gw-scroll-x" style={{
          display: 'flex', gap: 6, padding: '10px 20px 0', background: '#fff',
          flexShrink: 0,
        }}>
          {[
            { key: 'mine', label: 'Mine' },
            ...(access.canUseTeam ? [{ key: 'team', label: 'My Team' }] : []),
            ...(access.canUseOrg  ? [{ key: 'org',  label: 'All Org' }] : []),
          ].map(sc => (
            <button key={sc.key} onClick={() => setScope(sc.key)} style={{
              padding: '6px 14px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
              border: `1px solid ${scope === sc.key ? '#0369a1' : '#e2e4ea'}`,
              background: scope === sc.key ? '#0369a1' : '#fff',
              color: scope === sc.key ? '#fff' : '#4b5563',
              fontWeight: scope === sc.key ? 600 : 400,
            }}>{sc.label}</button>
          ))}
        </div>
      )}

      {/* Project-kind filter and New project belong to the project LIST. The
          dashboard and the vendors registry are not lists of projects, so the
          controls would act on nothing. */}
      {tab !== 'dashboard' && tab !== 'vendors' && (
        <div className="gw-scroll-x" style={{
          display: 'flex', gap: 6, alignItems: 'center',
          padding: '10px 20px 0', background: '#fff', flexShrink: 0,
        }}>
          {(tab === 'initiatives' ? [] : [
            { key: '',         label: 'All projects' },
            { key: 'customer', label: 'Customer' },
            { key: 'internal', label: 'Internal' },
          ]).map(k => (
            <button key={k.key} onClick={() => setKindFilter(k.key)} style={{
              padding: '6px 14px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
              border: `1px solid ${kindFilter === k.key ? '#7c3aed' : '#e2e4ea'}`,
              background: kindFilter === k.key ? '#ede9fe' : '#fff',
              color: kindFilter === k.key ? '#5b21b6' : '#4b5563',
              fontWeight: kindFilter === k.key ? 600 : 400,
            }}>{k.label}</button>
          ))}
          <button onClick={() => setShowCreate(true)} style={{
            marginLeft: 'auto', padding: '6px 14px', borderRadius: 8, fontSize: 13,
            border: '1px solid #0369a1', background: '#0369a1', color: '#fff',
            fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
          }}>{tab === 'initiatives' ? '+ New initiative' : '+ New project'}</button>
        </div>
      )}

      {showCreate && (
        <CreateProjectModal
          users={users}
          managerLabel={managerLabel}
          viewerRole={access?.role || null}
          // Sent by the server from the same helper the POST is gated on, so
          // the control and the 403 cannot disagree.
          canCreateStanding={access?.canCreateStanding === true}
          initialTrackingMode={tab === 'initiatives' ? 'standing' : 'timeboxed'}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); loadList(); }}
        />
      )}

      {tab === 'vendors' ? (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <VendorsView onOpenProject={handleOpenVendorProject} />
        </div>
      ) : tab === 'dashboard' ? (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <PortfolioDashboard onOpenProject={handleOpenProject} />
        </div>
      ) : selected ? (
        /* ── Full-width detail ─────────────────────────── */
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {returnCrumb && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                          padding: '8px 16px', background: '#eff6ff',
                          borderBottom: '1px solid #dbeafe' }}>
              <button onClick={followCrumb}
                style={{ fontSize: 13, padding: '4px 10px', borderRadius: 6,
                         border: '1px solid #bfdbfe', background: '#fff', color: '#1e40af',
                         cursor: 'pointer' }}>
                ← Back to {returnCrumb.name || 'Daily Work'}
                {returnCrumb.period ? ` · ${returnCrumb.period}` : ''}
              </button>
              <button onClick={dismissCrumb} aria-label="Dismiss"
                style={{ marginLeft: 'auto', fontSize: 13, padding: '4px 8px',
                         border: 'none', background: 'none', color: '#1e40af',
                         cursor: 'pointer' }}>
                ✕
              </button>
            </div>
          )}
          <div style={{ padding: '10px 16px 0' }}>
            <button onClick={() => { setSelected(null); setDetailSubTab('summary'); }}
              style={{ fontSize: 13, padding: '5px 12px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', color: '#374151', cursor: 'pointer' }}>
              ← All projects
            </button>
          </div>
          <HandoverDetail
            key={selected.id}
            handover={selected}
            viewMode={tab}
            managerLabel={managerLabel}
            users={users}
            onRefresh={loadList}
            onOpenProject={handleOpenProject}
            initialTab={detailSubTab}
            onTabChange={setDetailSubTab}
          />
        </div>
      ) : tab === 'initiatives' ? (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading
            ? <div style={{ padding: 40, color: '#9ca3af', fontSize: 13, textAlign: 'center' }}>Loading…</div>
            : <InitiativesBoard
                initiatives={handovers}
                searchTerm={searchTerm} setSearchTerm={setSearchTerm}
                showRetired={showRetired} setShowRetired={setShowRetired}
                onOpen={(h) => { setSelected(h); setDetailSubTab('summary'); }}
                onRetire={doRetire} onUnretire={doUnretire}
                busyId={retireBusyId}
                canManage={access?.canCreateStanding === true}
              />}
        </div>
      ) : (
        /* ── Full-width projects board ──────────────────── */
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading ? (
            <div style={{ padding: 40, color: '#9ca3af', fontSize: 13, textAlign: 'center' }}>Loading…</div>
          ) : handovers.length === 0 ? (
            <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af' }}>
              <div style={{ fontSize: 40, marginBottom: 10 }}>🤝</div>
              <div style={{ fontSize: 15, fontWeight: 600, color: '#475569', marginBottom: 4 }}>
                {tab === 'mine' ? 'No projects yet' : 'None assigned to you'}
              </div>
              <div style={{ fontSize: 13 }}>
                {tab === 'mine'
                  ? 'Projects are created automatically when a deal is marked Closed Won.'
                  : `Projects assigned to you as ${managerLabel.toLowerCase()} will appear here.`}
              </div>
            </div>
          ) : (
            <ProjectsBoard
              projects={filtered}
              searchTerm={searchTerm} setSearchTerm={setSearchTerm}
              statusFilter={statusFilter} setStatusFilter={setStatusFilter}
              statusMeta={STATUS_META}
              onOpen={(h) => { setSelected(h); setDetailSubTab('summary'); }}
              /* Who is delivering each project only matters once you are looking
                 past your own — on 'mine' and 'assigned' the answer is always you. */
              showOwner={tab === 'assigned' && scope !== 'mine'}
              managerLabel={managerLabel}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ── PortfolioDashboard: Handovers → Dashboard tab ─────────────────────────────

const DASH = {
  status: {
    on_track:       { label: 'On track',      color: '#16a34a' },
    in_progress:    { label: 'In progress',   color: '#d97706' },
    ready_to_start: { label: 'Ready to start', color: '#0369a1' },
    yet_to_start:   { label: 'Yet to start',  color: '#6b7280' },
    completed:      { label: 'Completed',     color: '#0d9488' },
  },
  typeColors: ['#0369a1', '#16a34a', '#d97706', '#7c3aed', '#0d9488', '#db2777', '#6b7280'],
};

function DashCard({ title, children }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 12 }}>{title}</div>
      {children}
    </div>
  );
}

function BarRow({ label, value, total, color }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 7 }}>
      <span style={{ width: 92, color: '#6b7280' }}>{label}</span>
      <div style={{ flex: 1, height: 8, background: '#f3f4f6', borderRadius: 4 }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 4 }} />
      </div>
      <span style={{ width: 20, textAlign: 'right', fontWeight: 600 }}>{value}</span>
    </div>
  );
}

function PortfolioDashboard({ onOpenProject }) {
  const [data, setData] = useState(null);
  const [err, setErr]   = useState('');

  useEffect(() => {
    let live = true;
    apiService.handovers.portfolio()
      .then(res => { if (live) setData(res.data); })
      .catch(() => { if (live) setErr('Could not load the dashboard.'); });
    return () => { live = false; };
  }, []);

  if (err)   return <div style={{ padding: 32, color: '#991b1b', fontSize: 13 }}>{err}</div>;
  if (!data) return <div style={{ padding: 32, color: '#9ca3af', fontSize: 13 }}>Loading dashboard…</div>;

  const { kpis, statusDistribution, typeDistribution, rainImpact, riskMatrix, projects } = data;
  const total = kpis.total || 0;

  const kpiTiles = [
    { k: 'total',          label: 'Total',          color: '#111827' },
    { k: 'on_track',       label: 'On track',       color: '#16a34a' },
    { k: 'in_progress',    label: 'In progress',    color: '#d97706' },
    { k: 'ready_to_start', label: 'Ready to start', color: '#0369a1' },
    { k: 'yet_to_start',   label: 'Yet to start',   color: '#6b7280' },
    { k: 'completed',      label: 'Completed',      color: '#0d9488' },
    { k: 'rain_affected',  label: 'Rain affected',  color: '#dc2626' },
  ];

  const typeEntries = Object.entries(typeDistribution);

  return (
    <div style={{ padding: 20, maxWidth: 1100, margin: '0 auto' }}>
      {/* Portfolio health (R/Y/G by lens) */}
      <div style={{ marginBottom: 18 }}>
        <PortfolioHealthReport onOpenProject={onOpenProject} />
      </div>

      {/* KPI tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 10, marginBottom: 18 }}>
        {kpiTiles.map(t => (
          <div key={t.k} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '12px 14px' }}>
            <div style={{ fontSize: 12, color: '#6b7280' }}>{t.label}</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: t.color }}>{kpis[t.k] || 0}</div>
          </div>
        ))}
      </div>

      {/* Distributions */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12, marginBottom: 18 }}>
        <DashCard title="Status distribution">
          {Object.keys(DASH.status).map(k => (
            <BarRow key={k} label={DASH.status[k].label} value={statusDistribution[k] || 0} total={total} color={DASH.status[k].color} />
          ))}
        </DashCard>
        <DashCard title="Project type">
          {typeEntries.map(([t, n], i) => (
            <BarRow key={t} label={t} value={n} total={total} color={DASH.typeColors[i % DASH.typeColors.length]} />
          ))}
        </DashCard>
      </div>

      {/* Projects table */}
      <DashCard title="Projects overview">
        <div className="gw-table-scroll">
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: '#6b7280', textAlign: 'left' }}>
                <th style={{ padding: '6px 4px', fontWeight: 500 }}>Project</th>
                <th style={{ padding: '6px 4px', fontWeight: 500 }}>Type</th>
                <th style={{ padding: '6px 4px', fontWeight: 500 }}>Status</th>
                <th style={{ padding: '6px 4px', fontWeight: 500, width: '22%' }}>Progress</th>
                <th style={{ padding: '6px 4px', fontWeight: 500 }}>Next action</th>
              </tr>
            </thead>
            <tbody>
              {projects.map(p => {
                const s = DASH.status[p.status] || { label: p.status, color: '#6b7280' };
                return (
                  <tr key={p.handoverId} onClick={() => onOpenProject?.(p.handoverId)}
                    style={{ borderTop: '1px solid #f3f4f6', cursor: 'pointer' }}
                    onMouseEnter={e => { e.currentTarget.style.background = '#f9fafb'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                    <td style={{ padding: '8px 4px' }}>
                      {p.account}
                      {p.rain !== 'none' && (
                        <span style={{ color: p.rain === 'high' ? '#dc2626' : '#d97706', fontSize: 11, marginLeft: 5 }}>
                          ● {p.rain} rain
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '8px 4px', color: '#6b7280' }}>{p.projectType}</td>
                    <td style={{ padding: '8px 4px' }}>
                      <span style={{ background: s.color + '1a', color: s.color, padding: '2px 7px', borderRadius: 6, fontSize: 11 }}>{s.label}</span>
                    </td>
                    <td style={{ padding: '8px 4px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{ flex: 1, height: 6, background: '#f3f4f6', borderRadius: 3 }}>
                          <div style={{ width: `${p.progress}%`, height: '100%', background: s.color, borderRadius: 3 }} />
                        </div>
                        <span style={{ color: '#6b7280', width: 30, textAlign: 'right' }}>{p.progress}%</span>
                      </div>
                    </td>
                    <td style={{ padding: '8px 4px', color: '#6b7280', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.nextAction || '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </DashCard>

      {/* Rain + risk */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12, marginTop: 18 }}>
        <DashCard title="Rain impact">
          <BarRow label="High"   value={rainImpact.high}   total={total} color="#dc2626" />
          <BarRow label="Medium" value={rainImpact.medium} total={total} color="#d97706" />
          <BarRow label="None"   value={rainImpact.none}   total={total} color="#6b7280" />
        </DashCard>
        <DashCard title="Risk level">
          <BarRow label="High"   value={riskMatrix.high}   total={total} color="#dc2626" />
          <BarRow label="Medium" value={riskMatrix.medium} total={total} color="#d97706" />
          <BarRow label="Low"    value={riskMatrix.low}    total={total} color="#16a34a" />
        </DashCard>
      </div>
    </div>
  );
}
