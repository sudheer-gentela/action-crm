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
import PortfolioHealthReport from './PortfolioHealthReport';
import { hashParts, hashSegment, writeHash } from './hashNav';

// ── Deep-link parsing ─────────────────────────────────────────────────────────
// #/handovers                         → My Handovers list
// #/handovers/assigned                → Assigned-to-Me list
// #/handovers/dashboard               → Dashboard tab
// #/handovers/<id>[/<subtab>]         → open handover <id> (mine), subtab
// #/handovers/assigned/<id>[/<subtab>]→ open handover <id> (assigned), subtab
// subtab ∈ summary | details | communications  (summary omitted from the URL)
function parseHandoverHash() {
  const parts = hashParts();
  if (parts[0] !== 'handovers') return { scope: 'mine', id: null, sub: 'summary' };
  let i = 1, scope = 'mine';
  // 'team' and 'org' were briefly tabs; they are scopes now. Map old links onto
  // My Work rather than leaving `tab` on a value that renders no button.
  if (['assigned', 'team', 'org', 'dashboard'].includes(parts[i])) {
    scope = (parts[i] === 'team' || parts[i] === 'org') ? 'assigned' : parts[i];
    i += 1;
  }
  let id = null;
  const n = parseInt(parts[i], 10);
  if (Number.isInteger(n) && n > 0 && String(n) === parts[i]) { id = n; i += 1; }
  const sub = ['summary', 'details', 'communications'].includes(parts[i]) ? parts[i] : 'summary';
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

const HANDOVER_ROLE_LABELS = {
  implementation_lead: 'Implementation Lead',
  day_to_day_admin:    'Day-to-Day Admin',
  go_live_approver:    'Go-Live Approver',
  exec_sponsor:        'Exec Sponsor',
  technical_lead:      'Technical Lead',
  other:               'Other',
};

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

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
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
    return (
      <span style={{
        fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
        background: '#fee2e2', color: '#991b1b', whiteSpace: 'nowrap',
      }}>
        ⚠ {daysOverdue}d overdue
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

function ProjectsBoard({ projects, searchTerm, setSearchTerm, statusFilter, setStatusFilter, statusMeta, onOpen, showOwner = false }) {
  const [sortBy, setSortBy] = useState('value');
  const [overdueOnly, setOverdueOnly] = useState(false);

  const overdueOf = (h) => (h.playsOverdue || 0) + (h.commitmentsOverdue || 0);
  const isTerminal = (h) => h.status === 'completed' || h.status === 'cancelled';

  let rows = overdueOnly ? projects.filter(h => overdueOf(h) > 0) : projects;
  rows = [...rows].sort((a, b) => {
    if (sortBy === 'value')  return (Number(b.contractValue) || 0) - (Number(a.contractValue) || 0);
    if (sortBy === 'golive') return new Date(a.goLiveDate || '2999-01-01') - new Date(b.goLiveDate || '2999-01-01');
    if (sortBy === 'overdue') return overdueOf(b) - overdueOf(a);
    return (a.dealName || '').localeCompare(b.dealName || '');
  });

  // contract_value is numeric(15,2). node-postgres returns numeric as a STRING
  // to avoid float precision loss, so `s + h.contractValue` concatenates rather
  // than adds and the formatted total comes out as $NaN. Per-row display is
  // unaffected because Intl.format coerces a numeric string on its own.
  // Number() is safe here: numeric(15,2) tops out well inside float64's exact
  // integer range.
  const totalValue   = projects.reduce((s, h) => s + (Number(h.contractValue) || 0), 0);
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
      {/* Metrics */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
        {metric('Projects', projects.length)}
        {metric('Total value', fmtCurrency(totalValue))}
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
              {showOwner && <th style={th}>Service owner</th>}
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
                      <div style={{ fontWeight: 600, color: '#111827' }}>{h.dealName || `Deal #${h.dealId}`}</div>
                      <div style={{ fontSize: 12, color: '#6b7280' }}>{h.accountName || '—'}</div>
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

// ── PlaySection ───────────────────────────────────────────────────────────────

function PlaySection({ play, canEdit, onComplete, onRemove, onEdit, users }) {
  // Done-state mirrors the backend gate, which treats a play as satisfied when
  // its status is 'completed' OR 'skipped' — not merely when completedAt is set.
  // (A skipped play has no completedAt but still clears the gate.)
  const isDone   = ['completed', 'skipped'].includes(play.status);
  const isSkipped = play.status === 'skipped';
  const isGate   = play.isGate;

  const [capturing, setCapturing] = useState(false);
  const [note,   setNote]   = useState('');
  const [evType, setEvType] = useState('whatsapp');
  const [snippet, setSnippet] = useState('');
  const [showEv, setShowEv] = useState(false);

  // Inline edit — fields are seeded from the play when the editor opens (in
  // openEdit), not via useState initialisers, so they stay fresh across reloads.
  const [editing, setEditing] = useState(false);
  const [eTitle, setETitle] = useState('');
  const [eDesc,  setEDesc]  = useState('');
  const [eOwner, setEOwner] = useState('');
  const [eDue,   setEDue]   = useState('');
  const [eGate,  setEGate]  = useState(false);
  const [eSaving, setESaving] = useState(false);

  const openEdit = () => {
    setETitle(play.title || '');
    setEDesc(play.description || '');
    setEOwner(play.ownerUserId != null ? String(play.ownerUserId) : '');
    setEDue(play.dueDate ? String(play.dueDate).slice(0, 10) : '');
    setEGate(!!play.isGate);
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
      });
      setEditing(false);
    } finally { setESaving(false); }
  };

  const ev = play.completionEvidence;
  const EV_LABEL = { whatsapp: 'WhatsApp', email: 'Email', note: 'Note', document: 'Document' };
  const CH_LABEL = { whatsapp: 'WhatsApp', email: 'Email', internal_task: 'Internal', call: 'Call', linkedin: 'LinkedIn' };

  // Status pill — makes in_progress distinct from not_started (both looked the
  // same before), and names the state in words rather than only an icon.
  const STATUS = {
    completed:   { label: 'Done',        color: '#065f46', bg: '#ecfdf5', bd: '#a7f3d0' },
    skipped:     { label: 'Skipped',     color: '#6b7280', bg: '#f3f4f6', bd: '#e5e7eb' },
    in_progress: { label: 'In progress', color: '#1d4ed8', bg: '#eff6ff', bd: '#bfdbfe' },
    blocked:     { label: 'Blocked',     color: '#991b1b', bg: '#fef2f2', bd: '#fecaca' },
    not_started: { label: 'Not started', color: '#6b7280', bg: '#f8fafc', bd: '#e5e7eb' },
  };
  const st = STATUS[play.status] || STATUS.not_started;

  const confirm = () => {
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
          {!isDone && canEdit && !capturing && (
            <button onClick={() => setCapturing(true)} style={{
              fontSize: 11, padding: '3px 10px', borderRadius: 4,
              background: '#0369a1', color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 600,
            }}>
              Mark done
            </button>
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

      {/* Manual completion capture: note + how it was closed */}
      {capturing && (
        <div style={{ marginTop: 8, padding: 10, background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 6 }}>
          <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6 }}>How was this closed out?</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <select value={evType} onChange={e => setEvType(e.target.value)}
              style={{ fontSize: 12, padding: '5px 6px', borderRadius: 4, border: '1px solid #d1d5db' }}>
              <option value="whatsapp">WhatsApp</option>
              <option value="email">Email</option>
              <option value="note">Note</option>
              <option value="document">Document</option>
            </select>
            <input value={snippet} onChange={e => setSnippet(e.target.value)} placeholder="Evidence (e.g. paste the message / reference)"
              style={{ flex: 1, fontSize: 12, padding: '5px 8px', borderRadius: 4, border: '1px solid #d1d5db' }} />
          </div>
          <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} placeholder="Optional note"
            style={{ width: '100%', fontSize: 12, padding: '5px 8px', borderRadius: 4, border: '1px solid #d1d5db', boxSizing: 'border-box', resize: 'vertical' }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <button onClick={confirm} style={{ fontSize: 12, padding: '5px 14px', borderRadius: 4, background: '#059669', color: '#fff', border: 'none', fontWeight: 600, cursor: 'pointer' }}>
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
            <label style={{ fontSize: 11, color: '#6b7280', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={eGate} onChange={e => setEGate(e.target.checked)} /> Gate (blocks go-live)
            </label>
          </div>
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
// Group plays by stage, ordered by each group's earliest sort order; ad-hoc
// ('custom') always last.
function groupPlaysByStage(plays) {
  const map = new Map();
  for (const p of plays) {
    const key = p.stageKey || 'other';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(p);
  }
  const groups = [...map.entries()].map(([key, items]) => ({
    key,
    label: stageLabel(key),
    items,
    minSort: Math.min(...items.map(i => i.sortOrder ?? 9999)),
    done: items.filter(i => ['completed', 'skipped'].includes(i.status)).length,
  }));
  groups.sort((a, b) => {
    if (a.key === 'custom') return 1;
    if (b.key === 'custom') return -1;
    return a.minSort - b.minSort;
  });
  return groups;
}

// ── AddPlayForm: add an ad-hoc checklist item directly on a handover ───────────
function AddPlayForm({ users, onAdd }) {
  const [open,   setOpen]   = useState(false);
  const [title,  setTitle]  = useState('');
  const [desc,   setDesc]   = useState('');
  const [due,    setDue]    = useState('');
  const [owner,  setOwner]  = useState('');
  const [gate,   setGate]   = useState(false);
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
      });
      setTitle(''); setDesc(''); setDue(''); setOwner(''); setGate(false); setOpen(false);
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

function ProjectMembersSection({ handoverId, members, isAdmin, canRequest, onRefresh }) {
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
    if (!adding) return;
    apiService.handovers.assignableUsers().then(r => setUsers(r.data.users || [])).catch(() => setUsers([]));
    apiService.handovers.orgRoles().then(r => setRoles(r.data.roles || r.data || [])).catch(() => setRoles([]));
  }, [adding]);

  const refresh = async () => { if (onRefresh) await onRefresh(); };

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
            <span style={{ fontWeight: 600 }}>{m.name}</span>
            <span style={{ marginLeft: 8, fontSize: 11, color: '#6b7280' }}>{m.roleName || m.customRole || '—'}</span>
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

function StakeholderSection({ stakeholders, canEdit, onAdd, onRemove, accountId, handoverId, canEditPolicy, onOpenContact }) {
  const [adding,    setAdding]    = useState(false);
  const [mode,      setMode]      = useState('existing');   // 'existing' | 'new'
  const [contactId, setContactId] = useState('');
  const [name,      setName]      = useState('');
  const [cc,        setCc]        = useState('+91');
  const [phone,     setPhone]     = useState('');
  const [role,      setRole]      = useState('implementation_lead');
  const [notes,     setNotes]     = useState('');
  const [saving,    setSaving]    = useState(false);
  const [err,       setErr]       = useState('');
  const [accountContacts, setAccountContacts] = useState([]);

  const [policyOpen, setPolicyOpen] = useState(false);
  const [policy,     setPolicy]     = useState(null);
  const [orgUsers,   setOrgUsers]   = useState([]);
  const [policyMsg,  setPolicyMsg]  = useState('');

  useEffect(() => {
    if (!adding || mode !== 'existing' || !accountId) return;
    apiService.contacts.getByAccount(accountId)
      .then(r => setAccountContacts(r.data.contacts || r.data || []))
      .catch(() => setAccountContacts([]));
  }, [adding, mode, accountId]);

  const openPolicy = async () => {
    setPolicyOpen(true); setPolicyMsg('');
    try {
      const [p, u] = await Promise.all([
        apiService.handovers.getContactPolicy(handoverId),
        apiService.handovers.assignableUsers(),
      ]);
      setPolicy(p.data.policy); setOrgUsers(u.data.users || []);
    } catch { setPolicyMsg('Could not load policy.'); }
  };
  const savePolicy = async () => {
    try { await apiService.handovers.setContactPolicy(handoverId, policy); setPolicyMsg('Saved.'); }
    catch (e) { setPolicyMsg(e?.response?.data?.error?.message || 'Could not save.'); }
  };
  const toggleNamed = (uid) => setPolicy(p => {
    const set = new Set((p.named_users || []).map(Number));
    if (set.has(uid)) set.delete(uid); else set.add(uid);
    return { ...p, named_users: [...set] };
  });

  const handleAdd = async () => {
    setErr('');
    if (mode === 'existing' && !contactId) { setErr('Pick a contact.'); return; }
    if (mode === 'new' && !name.trim())    { setErr('Enter a name.'); return; }
    if (mode === 'new' && !phone.trim())   { setErr('Enter a phone number.'); return; }
    setSaving(true);
    try {
      const payload = mode === 'existing'
        ? { contactId, handoverRole: role, relationshipNotes: notes }
        : { name: name.trim(), phone: `${cc}${phone.replace(/[^0-9]/g, '')}`, handoverRole: role, relationshipNotes: notes };
      await onAdd(payload);
      setContactId(''); setName(''); setPhone(''); setNotes(''); setRole('implementation_lead'); setAdding(false);
    } catch (e) { setErr(e?.response?.data?.error?.message || 'Could not add.'); }
    finally { setSaving(false); }
  };

  const inp = { width: '100%', fontSize: 12, padding: '4px 8px', borderRadius: 4, border: '1px solid #d1d5db', boxSizing: 'border-box' };

  return (
    <div>
      {stakeholders.length === 0 && !adding && (
        <div style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic', marginBottom: 8 }}>No contacts added yet.</div>
      )}
      {stakeholders.map(s => (
        <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid #f3f4f6' }}>
          <div style={{ flex: 1, cursor: s.contactId && onOpenContact ? 'pointer' : 'default' }}
            onClick={() => { if (s.contactId && onOpenContact) onOpenContact(s); }}
            title={s.contactId && onOpenContact ? 'View interactions & details' : ''}>
            <span style={{ fontSize: 13, fontWeight: 600, color: s.contactId && onOpenContact ? '#0369a1' : '#111827' }}>{s.name}</span>
            {s.isPrimaryContact && <span style={{ marginLeft: 6, fontSize: 10, color: '#0369a1', fontWeight: 700 }}>★ Primary</span>}
            <span style={{ marginLeft: 8, fontSize: 11, color: '#6b7280' }}>{HANDOVER_ROLE_LABELS[s.handoverRole] || s.handoverRole}</span>
            {s.contactPhone
              ? <span style={{ marginLeft: 8, fontSize: 11, color: '#9ca3af' }}>{s.contactPhone}</span>
              : <span style={{ marginLeft: 8, fontSize: 11, color: '#b45309' }}>no phone</span>}
            {s.relationshipNotes && <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{s.relationshipNotes}</div>}
          </div>
          {canEdit && <button onClick={() => onRemove(s.id)} title="Remove" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: '#ef4444' }}>✕</button>}
        </div>
      ))}

      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        {canEdit && !adding && (
          <button onClick={() => setAdding(true)} style={{ fontSize: 12, padding: '4px 10px', borderRadius: 4, background: '#f0f9ff', color: '#0369a1', border: '1px dashed #93c5fd', cursor: 'pointer' }}>+ Add contact</button>
        )}
        {canEditPolicy && !policyOpen && (
          <button onClick={openPolicy} style={{ fontSize: 12, padding: '4px 10px', borderRadius: 4, background: '#fff', color: '#6b7280', border: '1px solid #e5e7eb', cursor: 'pointer' }}>Who can add contacts…</button>
        )}
      </div>

      {canEdit && adding && (
        <div style={{ marginTop: 10, padding: 12, background: '#f8fafc', borderRadius: 8, border: '1px solid #e5e7eb' }}>
          <div style={{ display: 'inline-flex', border: '1px solid #d1d5db', borderRadius: 6, overflow: 'hidden', marginBottom: 8 }}>
            {['existing', 'new'].map(m => (
              <button key={m} onClick={() => { setMode(m); setErr(''); }} style={{ padding: '4px 12px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer', background: mode === m ? '#0369a1' : '#fff', color: mode === m ? '#fff' : '#374151' }}>
                {m === 'existing' ? 'Existing contact' : 'New contact'}
              </button>
            ))}
          </div>
          {mode === 'existing' ? (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>Contact</div>
              <select value={contactId} onChange={e => setContactId(e.target.value)} style={inp}>
                <option value="">Select a contact…</option>
                {accountContacts.map(c => (
                  <option key={c.id} value={c.id}>
                    {(c.name || `${c.first_name || ''} ${c.last_name || ''}`).trim()}{c.phone ? ` · ${c.phone}` : ' · no phone'}
                  </option>
                ))}
              </select>
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>Contacts on this account. Not listed? Switch to “New contact”.</div>
            </div>
          ) : (
            <>
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>Name</div>
                <input value={name} onChange={e => setName(e.target.value)} placeholder="Full name" style={inp} />
              </div>
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>WhatsApp phone (with country code)</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input value={cc} onChange={e => setCc(e.target.value)} style={{ ...inp, width: 64 }} />
                  <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="national number" style={{ ...inp, flex: 1 }} />
                </div>
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>e.g. +91 and 7207583441 — the country code is required for WhatsApp.</div>
              </div>
            </>
          )}
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>Role</div>
            <select value={role} onChange={e => setRole(e.target.value)} style={{ fontSize: 12, padding: '4px 8px', borderRadius: 4, border: '1px solid #d1d5db' }}>
              {Object.entries(HANDOVER_ROLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>Notes (optional)</div>
            <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Relationship context…" style={inp} />
          </div>
          {err && <div style={{ fontSize: 11, color: '#991b1b', marginBottom: 6 }}>{err}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleAdd} disabled={saving} style={{ fontSize: 12, padding: '4px 12px', borderRadius: 4, background: '#0369a1', color: '#fff', border: 'none', cursor: 'pointer' }}>{saving ? 'Adding…' : 'Add'}</button>
            <button onClick={() => { setAdding(false); setErr(''); }} disabled={saving} style={{ fontSize: 12, padding: '4px 10px', borderRadius: 4, background: '#f1f5f9', color: '#374151', border: 'none', cursor: 'pointer' }}>Cancel</button>
          </div>
        </div>
      )}

      {canEditPolicy && policyOpen && policy && (
        <div style={{ marginTop: 10, padding: 12, background: '#fffdf5', borderRadius: 8, border: '1px solid #fde68a' }}>
          <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 8 }}>Who can add contacts to this project</div>
          {[['deal_owner', 'Deal owner'], ['service_owner', 'Project/service owner'], ['admins', 'Org admins']].map(([k, label]) => (
            <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 4 }}>
              <input type="checkbox" checked={!!policy[k]} onChange={e => setPolicy({ ...policy, [k]: e.target.checked })} />{label}
            </label>
          ))}
          <div style={{ fontSize: 11, color: '#6b7280', margin: '8px 0 4px' }}>Named users (explicit access)</div>
          <div style={{ maxHeight: 120, overflow: 'auto', border: '1px solid #f3f4f6', borderRadius: 6, padding: 6 }}>
            {orgUsers.length === 0 ? <div style={{ fontSize: 11, color: '#9ca3af' }}>No users.</div> : orgUsers.map(u => (
              <label key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '2px 0' }}>
                <input type="checkbox" checked={(policy.named_users || []).map(Number).includes(u.id)} onChange={() => toggleNamed(u.id)} />
                {(u.name || `${u.first_name || ''} ${u.last_name || ''}`).trim() || u.email}
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
            <button onClick={savePolicy} style={{ fontSize: 12, padding: '4px 12px', borderRadius: 4, background: '#059669', color: '#fff', border: 'none', cursor: 'pointer' }}>Save policy</button>
            <button onClick={() => setPolicyOpen(false)} style={{ fontSize: 12, padding: '4px 10px', borderRadius: 4, background: '#f1f5f9', color: '#374151', border: 'none', cursor: 'pointer' }}>Close</button>
            {policyMsg && <span style={{ fontSize: 11, color: '#059669' }}>{policyMsg}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

// ── CommitmentRow ─────────────────────────────────────────────────────────────
// One commitment. Read-only unless canManage, in which case it expands to edit
// due date + status (and, for waived/breached, the required closure note).

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

function DeliverableRollup({ rollup }) {
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
      {days != null && chip(
        days >= 0 ? `Go-live in ${days}d` : `Go-live ${Math.abs(days)}d ago`,
        days < 0,
      )}
    </div>
  );
}

// ── HandoverDetail ────────────────────────────────────────────────────────────

function HandoverDetail({ handover: h, onRefresh, viewMode, users, onOpenProject, initialTab, onTabChange }) {
  const [detail,    setDetail]    = useState(null);
  const [canSubmit, setCanSubmit] = useState(false);
  const [closeInfo, setCloseInfo] = useState(null); // { canClose, blockers, rollup }
  const [loading,   setLoading]   = useState(true);
  const [actioning, setActioning] = useState(false);
  const [error,     setError]     = useState('');
  const [success,   setSuccess]   = useState('');
  const [closureFor, setClosureFor] = useState(null); // 'completed' | 'cancelled' | null
  const [menuOpen, setMenuOpen] = useState(false);    // header "⋯" overflow menu
  const [checklistLayout, setChecklistLayout] = useState(() => {
    try { return localStorage.getItem('gw_project_checklist_layout') || 'grid'; } catch { return 'grid'; }
  });
  const [expandedPlays, setExpandedPlays] = useState({});
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

  useEffect(() => { load(); }, [load]);

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

  const handleUpdatePlay = async (playInstanceId, data) => {
    try {
      await apiService.handovers.updatePlay(h.id, playInstanceId, data);
      await load();
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
  const isSalesView    = viewMode === 'mine';
  const isServiceView  = viewMode === 'assigned';
  const isDraft        = detail.status === 'draft';
  const isSubmitted    = detail.status === 'submitted';
  const isAcknowledged = detail.status === 'acknowledged';
  const isInProgress   = detail.status === 'in_progress';
  const isTerminal     = detail.status === 'completed' || detail.status === 'cancelled';

  const salesCanEdit   = isSalesView && isDraft;
  // Commitments are tracked THROUGH implementation, so they stay editable by
  // either side until the handover is terminal. (The backend permits any org
  // member; the two tabs represent the two legitimate actors.)
  const canManageCommitments = !isTerminal;

  const plays        = detail.plays        || [];
  const commitments  = detail.commitments  || [];

  const gatePlays  = plays.filter(p => p.isGate);
  const gatesTotal = gatePlays.length;
  const gatesDone  = gatePlays.filter(p => ['completed', 'skipped'].includes(p.status)).length;

  const canComplete   = isServiceView && isInProgress && !!closeInfo?.canClose;
  const completeBlocked = isServiceView && isInProgress && !closeInfo?.canClose;

  return (
    <div style={{ padding: '0 0 40px' }}>

      {/* ── Header ─────────────────────────────────────── */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid #e5e7eb', background: '#fafafa' }}>
        <div className="gw-wrap-mobile" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: '0 0 4px', fontSize: 16, color: '#111827', overflowWrap: 'anywhere' }}>
              {detail.dealName || `Deal #${detail.dealId}`}
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
                    <button onClick={() => { setMenuOpen(false); setClosureFor('cancelled'); setClosureText(''); }}
                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 14px', fontSize: 13, border: 'none', background: '#fff', color: '#b91c1c', cursor: 'pointer' }}
                      onMouseEnter={e => { e.currentTarget.style.background = '#fef2f2'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = '#fff'; }}>
                      ✕ Cancel project
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Stat strip */}
        {(() => {
          const dtg = detail.goLiveDate ? Math.ceil((new Date(detail.goLiveDate) - new Date()) / 86400000) : null;
          const goLiveText = dtg == null ? '—' : dtg < 0 ? `${Math.abs(dtg)}d overdue` : dtg === 0 ? 'Today' : `${dtg} days`;
          const goLiveColor = dtg == null ? '#111827' : dtg < 0 ? '#dc2626' : dtg <= 14 ? '#d97706' : '#111827';
          const statCard = (value, label, color) => (
            <div style={{ flex: 1, minWidth: 120, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '10px 12px' }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: color || '#111827' }}>{value}</div>
              <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
            </div>
          );
          return (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
              {statCard(goLiveText, detail.goLiveDate ? `Go-live · ${fmtDate(detail.goLiveDate)}` : 'Go-live', goLiveColor)}
              {detail.contractValue ? statCard(fmtCurrency(detail.contractValue), 'Contract value') : null}
              {detail.serviceOwnerName ? statCard(detail.serviceOwnerName, 'Project owner') : null}
              {gatesTotal > 0 ? statCard(`${gatesDone} / ${gatesTotal}`, 'Gate plays') : null}
            </div>
          );
        })()}

        {/* Status dates (secondary) */}
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 10, fontSize: 11, color: '#6b7280' }}>
          {detail.submittedAt    && <span>Submitted {fmtDate(detail.submittedAt)}</span>}
          {detail.acknowledgedAt && <span>Acknowledged {fmtDate(detail.acknowledgedAt)}</span>}
          {detail.completedAt    && <span>Completed {fmtDate(detail.completedAt)}</span>}
          {detail.cancelledAt    && <span>Cancelled {fmtDate(detail.cancelledAt)}</span>}
        </div>

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
        {!isDraft && !isTerminal && <DeliverableRollup rollup={closeInfo?.rollup} />}

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

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
          {isSalesView && isDraft && (
            <button onClick={() => handleAction('submitted')}
              disabled={actioning || !canSubmit}
              title={!canSubmit ? 'Complete all gate plays before submitting' : ''}
              style={{
                fontSize: 12, padding: '6px 14px', borderRadius: 6, fontWeight: 600, border: 'none',
                background: canSubmit ? '#0369a1' : '#e5e7eb',
                color: canSubmit ? '#fff' : '#9ca3af',
                cursor: actioning || !canSubmit ? 'not-allowed' : 'pointer',
              }}>
              {actioning ? '⏳ Submitting…' : '📤 Submit project'}
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

      {/* ── Summary / Details sub-tabs ──────────────────── */}
      <div className="gw-scroll-x" style={{ display: 'flex', gap: 4, padding: '0 20px', borderBottom: '1px solid #e5e7eb', background: '#fff' }}>
        {[{ key: 'summary', label: 'Summary' }, { key: 'details', label: 'Details' },
          ...(detail.canSeeCommercial ? [{ key: 'commercial', label: '💰 Commercial' }] : []),
          { key: 'communications', label: 'Communications' }].map(t => (
          <button key={t.key} onClick={() => setDetailTab(t.key)} style={{
            padding: '10px 16px', background: 'none', border: 'none',
            borderBottom: `2px solid ${detailTab === t.key ? '#0369a1' : 'transparent'}`,
            color: detailTab === t.key ? '#0369a1' : '#6b7280',
            fontWeight: detailTab === t.key ? 700 : 400, fontSize: 13, cursor: 'pointer',
          }}>{t.label}</button>
        ))}
      </div>

      {/* ── Summary ─────────────────────────────────────── */}
      {detailTab === 'summary' && (
        <div style={{ padding: '16px 20px' }}>
          <HandoverSummary detail={detail} users={users} canEdit={isServiceView || salesCanEdit} onRefresh={load} onOpenProject={onOpenProject} onGoToDetails={() => setDetailTab('details')} />
        </div>
      )}

      {/* ── Details (body) ──────────────────────────────── */}
      {detailTab === 'details' && (
      <div style={{ padding: '16px 20px' }}>

        {/* Handover Checklist (plays) — grouped by stage */}
        <section style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '0 0 12px' }}>
            <h4 style={{ margin: 0, fontSize: 14, color: '#374151' }}>📋 Project checklist <span style={{ fontSize: 11, fontWeight: 400, color: '#9ca3af' }}>· steps grouped by stage</span></h4>
            <div style={{ marginLeft: 'auto', display: 'inline-flex', border: '1px solid #d1d5db', borderRadius: 6, overflow: 'hidden' }}>
              {[['grid', 'Grid'], ['detailed', 'Detailed']].map(([k, label]) => (
                <button key={k} onClick={() => setLayout(k)} style={{ padding: '4px 12px', fontSize: 11, fontWeight: 600, border: 'none', cursor: 'pointer',
                  background: checklistLayout === k ? '#0369a1' : '#fff', color: checklistLayout === k ? '#fff' : '#374151' }}>{label}</button>
              ))}
            </div>
          </div>
          {plays.length === 0 && (
            <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 12 }}>No checklist items yet.</div>
          )}

          {checklistLayout === 'grid' ? (
            /* ── Boxed grid: one card per stage, compact rows that expand ── */
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 14, alignItems: 'start' }}>
              {groupPlaysByStage(plays).map(group => {
                const pct = group.items.length ? Math.round((group.done / group.items.length) * 100) : 0;
                return (
                  <div key={group.key} style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 14, background: '#fff' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <span style={{ fontSize: 9, fontWeight: 700, color: '#94a3b8', background: '#f1f5f9', padding: '1px 5px', borderRadius: 4, letterSpacing: 0.3 }}>STAGE</span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4 }}>{group.label}</span>
                      <span style={{ fontSize: 11, color: '#6b7280' }}>{group.done}/{group.items.length}</span>
                      <div style={{ flex: 1, height: 4, background: '#f1f5f9', borderRadius: 2, overflow: 'hidden' }}>
                        <div style={{ width: `${pct}%`, height: '100%', background: pct === 100 ? '#10b981' : '#0369a1' }} />
                      </div>
                    </div>
                    {group.items.map(play => {
                      const done = ['completed', 'skipped'].includes(play.status);
                      const icon = play.status === 'skipped' ? '⊘' : done ? '✅' : play.isGate ? '🔒' : play.status === 'in_progress' ? '🔄' : '⬜';
                      const isOpen = !!expandedPlays[play.id];
                      return (
                        <div key={play.id} style={{ borderTop: '1px solid #f3f4f6' }}>
                          <div onClick={() => togglePlay(play.id)} title="Click for detail"
                            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 2px', cursor: 'pointer', fontSize: 13 }}>
                            <span>{icon}</span>
                            <span style={{ flex: 1, minWidth: 0, color: done ? '#6b7280' : '#111827', textDecoration: done ? 'line-through' : 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{play.title}</span>
                            {play.isGate && !done && <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 4, background: '#eff6ff', color: '#1d4ed8' }}>GATE</span>}
                            {done && play.completedAt && <span style={{ fontSize: 10, color: '#9ca3af' }}>{fmtDate(play.completedAt)}</span>}
                            <span style={{ fontSize: 10, color: '#9ca3af' }}>{isOpen ? '▾' : '▸'}</span>
                          </div>
                          {isOpen && (
                            <div style={{ paddingBottom: 8 }}>
                              <PlaySection play={play} canEdit={salesCanEdit} onComplete={handleCompletePlay} onRemove={handleRemovePlay} onEdit={handleUpdatePlay} users={users} />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          ) : (
            /* ── Detailed: full grouped list ── */
            groupPlaysByStage(plays).map(group => {
              const pct = group.items.length ? Math.round((group.done / group.items.length) * 100) : 0;
              return (
                <div key={group.key} style={{ marginBottom: 18 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <span style={{ fontSize: 9, fontWeight: 700, color: '#94a3b8', background: '#f1f5f9', padding: '1px 5px', borderRadius: 4, letterSpacing: 0.3 }}>STAGE</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4, whiteSpace: 'nowrap' }}>
                      {group.label}
                    </span>
                    <span style={{ fontSize: 11, color: '#6b7280', whiteSpace: 'nowrap' }}>{group.done}/{group.items.length} done</span>
                    <div style={{ flex: 1, height: 4, background: '#f1f5f9', borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: pct === 100 ? '#10b981' : '#0369a1', transition: 'width 0.2s' }} />
                    </div>
                  </div>
                  {group.items.map(play => (
                    <PlaySection
                      key={play.id}
                      play={play}
                      canEdit={salesCanEdit}
                      onComplete={handleCompletePlay}
                      onRemove={handleRemovePlay}
                      onEdit={handleUpdatePlay}
                      users={users}
                    />
                  ))}
                </div>
              );
            })
          )}
          {salesCanEdit && (
            <div style={{ marginTop: 4 }}>
              <AddPlayForm users={users} onAdd={handleAddPlay} />
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
      {detailTab === 'communications' && (
        <div style={{ padding: '16px 20px' }}>
          <CommunicationsPanel handoverId={detail.id} />
        </div>
      )}

      {detailTab === 'commercial' && detail.canSeeCommercial && (
        <div style={{ padding: '16px 20px' }}>
          <CommercialTab detail={detail} users={users} onRefresh={load} />
        </div>
      )}
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

function PersonPanel({ member, onClose, onOpenProject }) {
  const [data, setData] = useState(null);
  const [panelTab, setPanelTab] = useState('projects'); // 'projects' | 'tasks' | 'comms'
  const [commFilter, setCommFilter] = useState('all');  // account name filter for the comms tab
  const [openComm, setOpenComm] = useState(null);       // clicked communication → detail overlay
  const [openContact, setOpenContact] = useState(null); // "see all from this contact" → customer panel
  useEffect(() => {
    apiService.handovers.personDashboard(member.userId)
      .then(res => setData(res.data))
      .catch(() => setData({ person: { name: member.name }, projects: [], deliverables: [], communications: [] }));
  }, [member.userId, member.name]);

  const projects = data?.projects || [];
  const comms    = data?.communications || [];
  const pending  = (data?.deliverables || []).filter(d => d.pending);
  const CH = { email: { label: 'Email', color: '#7c3aed' }, whatsapp: { label: 'WhatsApp', color: '#059669' } };
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

function CommMessageModal({ message, onClose, onOpenContact }) {
  const CH = {
    email:    { label: 'Email',    color: '#7c3aed', bg: '#f5f3ff' },
    whatsapp: { label: 'WhatsApp', color: '#059669', bg: '#ecfdf5' },
  };
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

          {message.subject && <div style={{ fontSize: 15, fontWeight: 600, color: '#111827', marginBottom: 10 }}>{message.subject}</div>}
          <div style={{ fontSize: 13, lineHeight: 1.6, color: '#374151', whiteSpace: 'pre-wrap' }}>{message.body || '(No message body.)'}</div>

          {onOpenContact && message.contactId && (
            <button onClick={() => onOpenContact({ contactId: message.contactId, name: message.contactName })}
              style={{ marginTop: 16, background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                color: '#0369a1', fontSize: 12, fontWeight: 600 }}>
              See all messages from {message.contactName || 'this contact'} →
            </button>
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

  const CH = { email: { label: 'Email', color: '#7c3aed' }, whatsapp: { label: 'WhatsApp', color: '#059669' } };
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

function HandoverSummary({ detail, users, canEdit, onRefresh, onOpenProject, onGoToDetails }) {
  const team      = detail.dealTeam || [];
  const pb        = detail.playbook;
  const allCommits = detail.commitments || [];
  const openItems  = allCommits.filter(c => ['open', 'in_progress'].includes(c.status));
  const doneItems  = allCommits.filter(c => ['met', 'waived', 'breached'].includes(c.status));
  const onTimeCount = doneItems.filter(c => c.closedAt && lateDays(c) === 0).length;
  const gatePlays = (detail.plays || []).filter(p => p.isGate);
  const gatesDone = gatePlays.filter(p => ['completed', 'skipped'].includes(p.status)).length;

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

  const handleSummaryAdd = async (data) => {
    await apiService.handovers.addStakeholder(detail.id, data);
    if (onRefresh) await onRefresh();
  };
  const handleSummaryRemove = async (sid) => {
    await apiService.handovers.removeStakeholder(detail.id, sid);
    if (onRefresh) await onRefresh();
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
                isAdmin={detail.isProjectAdmin}
                canRequest={detail.canRequestMember}
                onRefresh={onRefresh}
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
              <StakeholderSection
                stakeholders={detail.stakeholders || []}
                canEdit={detail.canAddContacts}
                canEditPolicy={detail.canEditContactPolicy}
                accountId={detail.accountId}
                handoverId={detail.id}
                onAdd={handleSummaryAdd}
                onRemove={handleSummaryRemove}
                onOpenContact={setOpenContact}
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
                ) : 'No playbook linked.'}
              </div>
              <ServiceOwnerPicker detail={detail} users={users} canEdit={canEdit} onRefresh={onRefresh} />
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

      {openMember && <PersonPanel member={openMember} onClose={() => setOpenMember(null)} onOpenProject={onOpenProject} />}
      {openCommitment && <DeliverableModal commitmentId={openCommitment} onClose={() => setOpenCommitment(null)} />}
      {openContact && <CustomerContactPanel stakeholder={openContact} onClose={() => setOpenContact(null)} />}
    </>
  );
}

// ── ServiceOwnerPicker: reassign the assigned service owner in-app ────────────

function ServiceOwnerPicker({ detail, users, canEdit, onRefresh }) {
  const [val,    setVal]    = useState(detail.assignedServiceOwnerId != null ? String(detail.assignedServiceOwnerId) : '');
  const [saving, setSaving] = useState(false);
  const [msg,    setMsg]    = useState('');

  const save = async (next) => {
    setVal(next); setSaving(true); setMsg('');
    try {
      await apiService.handovers.update(detail.id, { assignedServiceOwnerId: next ? parseInt(next, 10) : null });
      setMsg('Project owner updated.');
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
      <span style={{ color: '#6b7280' }}>Project owner:</span>
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

function CommunicationsPanel({ handoverId }) {
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

  const CH = {
    email:    { label: 'Email',    color: '#7c3aed', bg: '#f5f3ff' },
    whatsapp: { label: 'WhatsApp', color: '#059669', bg: '#ecfdf5' },
  };

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
    .filter(m => channelFilter === 'all' || m.channel === channelFilter)
    .filter(m => !personFilter || (m.participantKeys || []).includes(personFilter));

  return (
    <div>
      {/* Channel filter — All / Email / WhatsApp (Phone later) */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        {[['all', 'All'], ['email', 'Email'], ['whatsapp', 'WhatsApp']].map(([k, label]) => {
          const on = channelFilter === k;
          const count = k === 'all' ? (items || []).length : (items || []).filter(m => m.channel === k).length;
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
                {m.body}
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
                    <option key={t.key} value={t.key}>{t.name}{t.phone ? ` · +${t.phone}` : ''}{t.phoneValid === false ? ' · ⚠ needs country code' : ''}{t.optedOut ? ' · opted out' : ''}</option>
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
        onOpenContact={(c) => { setOpenComm(null); setOpenContact(c); }} />}
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
  // Which people's projects to show within My Work. Independent of `tab`,
  // which selects the view.
  const [scope, setScope] = useState('mine');
  // Off by default: for most people "the deals I closed" is not a useful lens,
  // and they stay attached to those projects through project_members instead.
  const [showFromMyDeals, setShowFromMyDeals] = useState(false);
  // Deep-link (refresh-survival): the handover id + sub-tab from the URL hash.
  const [pendingHashId,  setPendingHashId]  = useState(() => parseHandoverHash().id);
  const [detailSubTab,   setDetailSubTab]   = useState(() => parseHandoverHash().sub);

  const loadList = useCallback(async () => {
    // The dashboard renders from /portfolio and 'dashboard' is not a scope the
    // list endpoint accepts — calling it would 400.
    if (tab === 'dashboard') { setHandovers([]); setLoading(false); return; }
    setLoading(true);
    try {
      // 'mine' on the From My Deals tab means created_by; 'mine' inside My Work
      // means "projects I have a role on", which the API calls 'assigned'.
      const apiScope = tab === 'mine' ? 'mine' : (scope === 'mine' ? 'assigned' : scope);
      const res = await apiService.handovers.list(apiScope);
      setHandovers(res.data.handovers || []);
    } catch {
      setHandovers([]);
    } finally { setLoading(false); }
  }, [tab, scope]);

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
    if (tab === 'dashboard') {
      parts = ['handovers', 'dashboard'];
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
      })
      .catch(() => {});   // stay on the default two tabs
    return () => { alive = false; };
  }, []);

  const handleOpenProject = (id) => { setTab('mine'); setPendingOpenId(id); };

  const filtered = handovers.filter(h => {
    const matchSearch = !searchTerm ||
      (h.dealName || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
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
          ...(showFromMyDeals ? [{ key: 'mine', label: '📤 From My Deals' }] : []),
          { key: 'assigned',  label: '🧭 My Work' },
          { key: 'dashboard', label: '📊 Dashboard' },
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

      {tab === 'dashboard' ? (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <PortfolioDashboard onOpenProject={handleOpenProject} />
        </div>
      ) : selected ? (
        /* ── Full-width detail ─────────────────────────── */
        <div style={{ flex: 1, overflowY: 'auto' }}>
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
            users={users}
            onRefresh={loadList}
            onOpenProject={handleOpenProject}
            initialTab={detailSubTab}
            onTabChange={setDetailSubTab}
          />
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
                  : 'Projects assigned to you as service owner will appear here.'}
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
