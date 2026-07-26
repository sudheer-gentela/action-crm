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
import { apiService } from './apiService';

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
function DueChip({ dueDate, isOverdue, daysOverdue, dueAnchor, dueOffsetDays }) {
  if (!dueDate) {
    // go_live-anchored plays are unscheduled until the go-live date is entered.
    // Show their intent (relative to go-live) rather than a blank.
    if (dueAnchor === 'go_live') {
      const off = Number(dueOffsetDays) || 0;
      const label = off === 0
        ? 'Due: on go-live'
        : off < 0
          ? `Due: ${Math.abs(off)}d before go-live`
          : `Due: ${off}d after go-live`;
      return (
        <span style={{
          fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4,
          background: '#eef2ff', color: '#3730a3', whiteSpace: 'nowrap',
        }}>
          {label}
        </span>
      );
    }
    return null;
  }
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

function HandoverRow({ handover: h, selected, onClick }) {
  return (
    <div onClick={onClick} style={{
      padding: '12px 16px', cursor: 'pointer', borderBottom: '1px solid #f3f4f6',
      background: selected ? '#f0f9ff' : '#fff',
      borderLeft: selected ? '3px solid #0369a1' : '3px solid transparent',
      transition: 'background 0.1s',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {h.dealName || `Deal #${h.dealId}`}
          </div>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
            {h.accountName || '—'}
          </div>
        </div>
        <div style={{ flexShrink: 0, textAlign: 'right' }}>
          <StatusBadge status={h.status} />
          {h.goLiveDate && (
            <div style={{ fontSize: 10, color: '#6b7280', marginTop: 3 }}>
              Go-live {fmtDate(h.goLiveDate)}
            </div>
          )}
        </div>
      </div>
      {h.contractValue && (
        <div style={{ fontSize: 11, color: '#374151', marginTop: 4 }}>
          {fmtCurrency(h.contractValue)}
        </div>
      )}
      <RowChips h={h} />
    </div>
  );
}

// Compact deliverable signal for a list row — overdue count and commitment
// progress. Silent on quiet rows (nothing overdue, no commitments) and on
// terminal handovers, so the sidebar stays scannable.
function RowChips({ h }) {
  const isTerminal = h.status === 'completed' || h.status === 'cancelled';
  const overdue = (h.playsOverdue || 0) + (h.commitmentsOverdue || 0);
  const cTotal  = h.commitmentsTotal || 0;
  const cClosed = h.commitmentsClosed || 0;

  if (isTerminal || (overdue === 0 && cTotal === 0)) return null;

  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 5 }}>
      {overdue > 0 && (
        <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
          background: '#fee2e2', color: '#991b1b' }}>
          ⚠ {overdue} overdue
        </span>
      )}
      {cTotal > 0 && (
        <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4,
          background: '#eef2ff', color: '#3730a3' }}>
          {cClosed}/{cTotal} commitments
        </span>
      )}
    </div>
  );
}

// ── PlaySection ───────────────────────────────────────────────────────────────

function PlaySection({ play, canEdit, onComplete }) {
  // Done-state mirrors the backend gate, which treats a play as satisfied when
  // its status is 'completed' OR 'skipped' — not merely when completedAt is set.
  // (A skipped play has no completedAt but still clears the gate.)
  const isDone   = ['completed', 'skipped'].includes(play.status);
  const isSkipped = play.status === 'skipped';
  const isGate   = play.isGate;

  return (
    <div style={{
      border: `1px solid ${isDone ? '#d1fae5' : isGate ? '#fecaca' : '#e5e7eb'}`,
      borderRadius: 8, padding: '12px 14px', marginBottom: 10,
      background: isDone ? '#f0fdf4' : '#fff',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 16 }}>{isSkipped ? '⊘' : isDone ? '✅' : isGate ? '🔒' : '⬜'}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: isDone ? '#065f46' : '#111827' }}>
            {play.title}
          </span>
          {isGate && !isDone && (
            <span style={{ marginLeft: 8, fontSize: 10, color: '#dc2626', fontWeight: 700 }}>GATE</span>
          )}
        </div>
        {!isDone && <DueChip dueDate={play.dueDate} isOverdue={play.isOverdue} daysOverdue={play.daysOverdue} dueAnchor={play.dueAnchor} dueOffsetDays={play.dueOffsetDays} />}
        {isDone && play.completedAt && (
          <span style={{ fontSize: 11, color: '#6b7280', whiteSpace: 'nowrap' }}>{fmtDate(play.completedAt)}</span>
        )}
        {isSkipped && <span style={{ fontSize: 11, color: '#6b7280' }}>Skipped</span>}
        {!isDone && canEdit && (
          <button onClick={() => onComplete(play.playInstanceId)} style={{
            fontSize: 11, padding: '3px 10px', borderRadius: 4,
            background: '#0369a1', color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 600,
          }}>
            Mark done
          </button>
        )}
      </div>
    </div>
  );
}

// ── StakeholderSection ────────────────────────────────────────────────────────

function StakeholderSection({ stakeholders, canEdit, onAdd, onRemove }) {
  const [adding,  setAdding]  = useState(false);
  const [name,    setName]    = useState('');
  const [role,    setRole]    = useState('implementation_lead');
  const [notes,   setNotes]   = useState('');
  const [saving,  setSaving]  = useState(false);

  const handleAdd = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onAdd({ name: name.trim(), handoverRole: role, relationshipNotes: notes });
      setName(''); setRole('implementation_lead'); setNotes('');
      setAdding(false);
    } finally { setSaving(false); }
  };

  return (
    <div>
      {stakeholders.length === 0 && !adding && (
        <div style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic', marginBottom: 8 }}>
          No stakeholders added yet.
        </div>
      )}
      {stakeholders.map(s => (
        <div key={s.id} style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0',
          borderBottom: '1px solid #f3f4f6',
        }}>
          <div style={{ flex: 1 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{s.name}</span>
            {s.isPrimaryContact && <span style={{ marginLeft: 6, fontSize: 10, color: '#0369a1', fontWeight: 700 }}>★ Primary</span>}
            <span style={{ marginLeft: 8, fontSize: 11, color: '#6b7280' }}>
              {HANDOVER_ROLE_LABELS[s.handoverRole] || s.handoverRole}
            </span>
            {s.relationshipNotes && (
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{s.relationshipNotes}</div>
            )}
          </div>
          {canEdit && (
            <button onClick={() => onRemove(s.id)} title="Remove stakeholder" style={{
              background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: '#ef4444',
            }}>✕</button>
          )}
        </div>
      ))}
      {canEdit && !adding && (
        <button onClick={() => setAdding(true)} style={{
          marginTop: 8, fontSize: 12, padding: '4px 10px', borderRadius: 4,
          background: '#f0f9ff', color: '#0369a1', border: '1px dashed #93c5fd', cursor: 'pointer',
        }}>
          + Add stakeholder
        </button>
      )}
      {canEdit && adding && (
        <div style={{ marginTop: 10, padding: 12, background: '#f8fafc', borderRadius: 8, border: '1px solid #e5e7eb' }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <div style={{ flex: 1, minWidth: 130 }}>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>Name</div>
              <input value={name} onChange={e => setName(e.target.value)} disabled={saving}
                placeholder="Contact name" style={{ width: '100%', fontSize: 12, padding: '4px 8px', borderRadius: 4, border: '1px solid #d1d5db', boxSizing: 'border-box' }} />
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>Role</div>
              <select value={role} onChange={e => setRole(e.target.value)} disabled={saving}
                style={{ fontSize: 12, padding: '4px 8px', borderRadius: 4, border: '1px solid #d1d5db' }}>
                {Object.entries(HANDOVER_ROLE_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>
          </div>
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>Notes (optional)</div>
            <input value={notes} onChange={e => setNotes(e.target.value)} disabled={saving}
              placeholder="Relationship context, preferred contact method, etc."
              style={{ width: '100%', fontSize: 12, padding: '4px 8px', borderRadius: 4, border: '1px solid #d1d5db', boxSizing: 'border-box' }} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleAdd} disabled={saving || !name.trim()} style={{
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

function HandoverDetail({ handover: h, onRefresh, viewMode, users }) {
  const [detail,    setDetail]    = useState(null);
  const [canSubmit, setCanSubmit] = useState(false);
  const [closeInfo, setCloseInfo] = useState(null); // { canClose, blockers, rollup }
  const [loading,   setLoading]   = useState(true);
  const [actioning, setActioning] = useState(false);
  const [error,     setError]     = useState('');
  const [success,   setSuccess]   = useState('');
  const [closureFor, setClosureFor] = useState(null); // 'completed' | 'cancelled' | null
  const [closureText, setClosureText] = useState('');

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
      setError('Could not load this handover. Try selecting it again.');
    } finally { setLoading(false); }
  }, [h.id]);

  useEffect(() => { load(); }, [load]);

  const flash = (type, msg) => {
    if (type === 'success') { setSuccess(msg); setError(''); }
    else { setError(msg); setSuccess(''); }
    setTimeout(() => { setSuccess(''); setError(''); }, 4000);
  };

  const SUCCESS_MSG = {
    submitted:    'Handover submitted',
    draft:        'Handover recalled to draft',
    acknowledged: 'Handover acknowledged',
    in_progress:  'Handover marked in progress',
    completed:    'Handover completed',
    cancelled:    'Handover cancelled',
  };

  const handleAction = async (newStatus, closureSummary = null) => {
    setActioning(true);
    try {
      await apiService.handovers.setStatus(h.id, newStatus, closureSummary);
      flash('success', `${SUCCESS_MSG[newStatus] || 'Handover updated'} ✓`);
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

  const handleCompletePlay = async (playInstanceId) => {
    try {
      await apiService.handovers.completePlay(h.id, playInstanceId);
      await load();
    } catch (err) {
      flash('error', err?.response?.data?.error?.message || 'Could not mark that play done');
    }
  };

  const handleAddStakeholder = async (data) => {
    await apiService.handovers.addStakeholder(h.id, data);
    await load();
  };

  const handleRemoveStakeholder = async (stakeholderId) => {
    await apiService.handovers.removeStakeholder(h.id, stakeholderId);
    await load();
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

  if (!detail) return <div style={{ padding: 24, color: '#9ca3af', fontSize: 13 }}>Could not load handover.</div>;

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
  const stakeholders = detail.stakeholders || [];
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div>
            <h3 style={{ margin: '0 0 4px', fontSize: 16, color: '#111827' }}>
              {detail.dealName || `Deal #${detail.dealId}`}
            </h3>
            <div style={{ fontSize: 13, color: '#6b7280' }}>{detail.accountName}</div>
          </div>
          <StatusBadge status={detail.status} />
        </div>

        {/* Meta row */}
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 12, fontSize: 12 }}>
          {detail.goLiveDate && (
            <div><span style={{ color: '#6b7280' }}>Go-live: </span><strong>{fmtDate(detail.goLiveDate)}</strong></div>
          )}
          {detail.contractValue && (
            <div><span style={{ color: '#6b7280' }}>Value: </span><strong>{fmtCurrency(detail.contractValue)}</strong></div>
          )}
          {detail.serviceOwnerName && (
            <div><span style={{ color: '#6b7280' }}>Service owner: </span><strong>{detail.serviceOwnerName}</strong></div>
          )}
          {detail.submittedAt && (
            <div><span style={{ color: '#6b7280' }}>Submitted: </span><strong>{fmtDate(detail.submittedAt)}</strong></div>
          )}
          {detail.acknowledgedAt && (
            <div><span style={{ color: '#6b7280' }}>Acknowledged: </span><strong>{fmtDate(detail.acknowledgedAt)}</strong></div>
          )}
          {detail.completedAt && (
            <div><span style={{ color: '#6b7280' }}>Completed: </span><strong>{fmtDate(detail.completedAt)}</strong></div>
          )}
          {detail.cancelledAt && (
            <div><span style={{ color: '#6b7280' }}>Cancelled: </span><strong>{fmtDate(detail.cancelledAt)}</strong></div>
          )}
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
              {actioning ? '⏳ Submitting…' : '📤 Submit handover'}
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
              ✅ Complete handover
            </button>
          )}
          {/* Cancel is available to either side from any non-terminal state */}
          {!isTerminal && (
            <button onClick={() => { setClosureFor('cancelled'); setClosureText(''); }} disabled={actioning} style={{
              fontSize: 12, padding: '6px 14px', borderRadius: 6, fontWeight: 600, border: '1px solid #fecaca',
              background: '#fff', color: '#b91c1c', cursor: actioning ? 'not-allowed' : 'pointer',
            }}>
              ✕ Cancel handover
            </button>
          )}
        </div>

        {/* Blockers explaining a disabled Complete button */}
        {completeBlocked && closeInfo?.blockers?.length > 0 && (
          <div style={{ marginTop: 10, padding: '8px 12px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, fontSize: 12, color: '#92400e' }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>Before this handover can be completed:</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {closeInfo.blockers.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
          </div>
        )}

        {/* Inline closure prompt (complete = optional note, cancel = required) */}
        {closureFor && (
          <div style={{ marginTop: 12, padding: 12, background: '#f8fafc', borderRadius: 8, border: '1px solid #e5e7eb' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6 }}>
              {closureFor === 'cancelled' ? 'Cancel this handover' : 'Complete this handover'}
            </div>
            <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6 }}>
              {closureFor === 'cancelled'
                ? 'Cancelling ends the delivery commitment. A reason is required and stays on the record.'
                : 'Add an optional closing note for the record.'}
            </div>
            <textarea value={closureText} onChange={e => setClosureText(e.target.value)} rows={2}
              placeholder={closureFor === 'cancelled' ? 'Why is this handover being cancelled?' : 'Closing note (optional)'}
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

      {/* ── Body ───────────────────────────────────────── */}
      <div style={{ padding: '16px 20px' }}>

        {/* Handover Checklist (plays) */}
        {plays.length > 0 && (
          <section style={{ marginBottom: 24 }}>
            <h4 style={{ margin: '0 0 12px', fontSize: 14, color: '#374151' }}>📋 Handover checklist</h4>
            {plays.map(play => (
              <PlaySection
                key={play.id}
                play={play}
                canEdit={salesCanEdit}
                onComplete={handleCompletePlay}
              />
            ))}
          </section>
        )}

        {/* Commercial terms summary */}
        {(detail.commercialTermsSummary || salesCanEdit) && (
          <section style={{ marginBottom: 24 }}>
            <h4 style={{ margin: '0 0 8px', fontSize: 14, color: '#374151' }}>💰 Commercial terms</h4>
            {detail.commercialTermsSummary ? (
              <p style={{ fontSize: 13, color: '#374151', lineHeight: 1.6, margin: 0,
                padding: '10px 12px', background: '#f8fafc', borderRadius: 6, border: '1px solid #e5e7eb' }}>
                {detail.commercialTermsSummary}
              </p>
            ) : (
              <div style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>
                No commercial terms summary added.
              </div>
            )}
          </section>
        )}

        {/* Stakeholders */}
        <section style={{ marginBottom: 24 }}>
          <h4 style={{ margin: '0 0 8px', fontSize: 14, color: '#374151' }}>
            👤 Customer stakeholders ({stakeholders.length})
          </h4>
          <StakeholderSection
            stakeholders={stakeholders}
            canEdit={salesCanEdit}
            onAdd={handleAddStakeholder}
            onRemove={handleRemoveStakeholder}
          />
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
  const [tab,         setTab]         = useState('mine');
  const [handovers,   setHandovers]   = useState([]);
  const [selected,    setSelected]    = useState(null);
  const [loading,     setLoading]     = useState(true);
  const [searchTerm,  setSearchTerm]  = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [users,       setUsers]       = useState([]); // org members for owner pickers

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiService.handovers.list(tab);
      setHandovers(res.data.handovers || []);
    } catch {
      setHandovers([]);
    } finally { setLoading(false); }
  }, [tab]);

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
      if (found) { setSelected(found); onHandoverOpened?.(); }
    }
  }, [openHandoverId, handovers, onHandoverOpened]);

  const filtered = handovers.filter(h => {
    const matchSearch = !searchTerm ||
      (h.dealName || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (h.accountName || '').toLowerCase().includes(searchTerm.toLowerCase());
    const matchStatus = !statusFilter || h.status === statusFilter;
    return matchSearch && matchStatus;
  });

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden', background: '#f9fafb' }}>

      {/* ── Left sidebar ─────────────────────────────── */}
      <div style={{ width: 300, flexShrink: 0, borderRight: '1px solid #e5e7eb',
        background: '#fff', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '2px solid #e5e7eb' }}>
          {[
            { key: 'mine',     label: '📤 My Handovers' },
            { key: 'assigned', label: '📥 Assigned to Me' },
          ].map(t => (
            <button key={t.key} onClick={() => setTab(t.key)} style={{
              flex: 1, padding: '10px 6px', background: 'none', border: 'none',
              borderBottom: `3px solid ${tab === t.key ? '#0369a1' : 'transparent'}`,
              color: tab === t.key ? '#0369a1' : '#6b7280',
              fontWeight: tab === t.key ? 700 : 400,
              fontSize: 12, cursor: 'pointer', transition: 'all 0.15s',
            }}>{t.label}</button>
          ))}
        </div>

        {/* Filters */}
        <div style={{ padding: '10px 12px', borderBottom: '1px solid #f3f4f6', display: 'flex', gap: 6 }}>
          <input value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
            placeholder="Search deals or accounts…"
            style={{ flex: 1, fontSize: 12, padding: '5px 8px', borderRadius: 4, border: '1px solid #d1d5db' }} />
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
            style={{ fontSize: 12, padding: '5px 6px', borderRadius: 4, border: '1px solid #d1d5db' }}>
            <option value="">All</option>
            {Object.entries(STATUS_META).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select>
        </div>

        {/* List */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading ? (
            <div style={{ padding: 20, color: '#9ca3af', fontSize: 13, textAlign: 'center' }}>
              Loading…
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>🤝</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 4 }}>
                {tab === 'mine' ? 'No handovers yet' : 'None assigned to you'}
              </div>
              <div style={{ fontSize: 12 }}>
                {tab === 'mine'
                  ? 'Handovers are created automatically when a deal is marked Closed Won.'
                  : 'Handovers assigned to you as service owner will appear here.'}
              </div>
            </div>
          ) : (
            filtered.map(h => (
              <HandoverRow
                key={h.id}
                handover={h}
                selected={selected?.id === h.id}
                onClick={() => setSelected(h)}
              />
            ))
          )}
        </div>
      </div>

      {/* ── Detail panel ─────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {!selected ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', height: '100%', color: '#9ca3af', gap: 10 }}>
            <div style={{ fontSize: 48 }}>🤝</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#475569' }}>Select a handover to view details</div>
            <div style={{ fontSize: 12 }}>Handovers track everything service needs to know after a deal closes.</div>
          </div>
        ) : (
          <HandoverDetail
            key={selected.id}
            handover={selected}
            viewMode={tab}
            users={users}
            onRefresh={loadList}
          />
        )}
      </div>
    </div>
  );
}
