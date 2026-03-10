// ─────────────────────────────────────────────────────────────────────────────
// HandoverView.js
//
// Sales → Implementation Handover module.
//
// Two tabs:
//   "My Handovers"    — deals I closed; I can edit draft, submit, recall
//   "Assigned to Me"  — handovers where I am the assigned service owner;
//                       I can acknowledge, mark in progress, add service notes
//
// Detail panel sections are driven by the linked playbook plays:
//   • handover_section plays  → form sections
//   • handover_document plays → file attachments
//   • Gate plays show a lock icon until completed
//
// Status flow: draft → submitted → acknowledged → in_progress
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';

// ── Constants ─────────────────────────────────────────────────────────────────

const STATUS_META = {
  draft:        { label: 'Draft',        bg: '#f1f5f9', color: '#475569' },
  submitted:    { label: 'Submitted',    bg: '#fef3c7', color: '#92400e' },
  acknowledged: { label: 'Acknowledged', bg: '#dbeafe', color: '#1e40af' },
  in_progress:  { label: 'In Progress',  bg: '#dcfce7', color: '#065f46' },
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

function StatusBadge({ status }) {
  const m = STATUS_META[status] || STATUS_META.draft;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 10px', borderRadius: 12,
      fontSize: 11, fontWeight: 700, background: m.bg, color: m.color,
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
    </div>
  );
}

// ── PlaySection ───────────────────────────────────────────────────────────────

function PlaySection({ play, handoverId, canEdit, onComplete }) {
  const isCompleted = !!play.completedAt;
  const isGate      = play.isGate;

  return (
    <div style={{
      border: `1px solid ${isCompleted ? '#d1fae5' : isGate ? '#fecaca' : '#e5e7eb'}`,
      borderRadius: 8, padding: '12px 14px', marginBottom: 10,
      background: isCompleted ? '#f0fdf4' : '#fff',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: isCompleted ? 0 : 4 }}>
        <span style={{ fontSize: 16 }}>{isCompleted ? '✅' : isGate ? '🔒' : '⬜'}</span>
        <div style={{ flex: 1 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: isCompleted ? '#065f46' : '#111827' }}>
            {play.title}
          </span>
          {isGate && !isCompleted && (
            <span style={{ marginLeft: 8, fontSize: 10, color: '#dc2626', fontWeight: 700 }}>GATE</span>
          )}
        </div>
        {isCompleted && (
          <span style={{ fontSize: 11, color: '#6b7280' }}>{fmtDate(play.completedAt)}</span>
        )}
        {!isCompleted && canEdit && (
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

// ── CommitmentsSection ────────────────────────────────────────────────────────

function CommitmentsSection({ commitments, canEdit, onAdd, onRemove }) {
  const [adding,  setAdding]  = useState(false);
  const [desc,    setDesc]    = useState('');
  const [type,    setType]    = useState('promise');
  const [saving,  setSaving]  = useState(false);

  const handleAdd = async () => {
    if (!desc.trim()) return;
    setSaving(true);
    try {
      await onAdd({ description: desc.trim(), commitmentType: type });
      setDesc(''); setType('promise'); setAdding(false);
    } finally { setSaving(false); }
  };

  return (
    <div>
      {commitments.length === 0 && !adding && (
        <div style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic', marginBottom: 8 }}>
          No commitments, risks, or flags recorded.
        </div>
      )}
      {commitments.map(c => {
        const m = COMMITMENT_TYPE_META[c.commitmentType] || COMMITMENT_TYPE_META.promise;
        return (
          <div key={c.id} style={{
            display: 'flex', alignItems: 'flex-start', gap: 10, padding: '7px 0',
            borderBottom: '1px solid #f3f4f6',
          }}>
            <span style={{ fontSize: 14, marginTop: 1 }}>{m.icon}</span>
            <div style={{ flex: 1 }}>
              <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
                background: m.bg, color: m.color, marginRight: 6 }}>
                {m.label}
              </span>
              <span style={{ fontSize: 13, color: '#111827' }}>{c.description}</span>
            </div>
            {canEdit && (
              <button onClick={() => onRemove(c.id)} title="Remove" style={{
                background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: '#ef4444', flexShrink: 0,
              }}>✕</button>
            )}
          </div>
        );
      })}
      {canEdit && !adding && (
        <button onClick={() => setAdding(true)} style={{
          marginTop: 8, fontSize: 12, padding: '4px 10px', borderRadius: 4,
          background: '#f0f9ff', color: '#0369a1', border: '1px dashed #93c5fd', cursor: 'pointer',
        }}>
          + Add commitment / risk
        </button>
      )}
      {canEdit && adding && (
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
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
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

// ── HandoverDetail ────────────────────────────────────────────────────────────

function HandoverDetail({ handover: h, onRefresh, viewMode }) {
  const [detail,   setDetail]   = useState(null);
  const [canSubmit, setCanSubmit] = useState(false);
  const [loading,  setLoading]  = useState(true);
  const [actioning, setActioning] = useState(false);
  const [error,    setError]    = useState('');
  const [success,  setSuccess]  = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [detailRes, submitRes] = await Promise.all([
        apiService.handovers.getById(h.id),
        h.status === 'draft' ? apiService.handovers.canSubmit(h.id) : Promise.resolve({ data: { canSubmit: false } }),
      ]);
      setDetail(detailRes.data.handover);
      setCanSubmit(submitRes.data?.canSubmit || false);
    } catch {
      setError('Failed to load handover details');
    } finally { setLoading(false); }
  }, [h.id, h.status]);

  useEffect(() => { load(); }, [load]);

  const flash = (type, msg) => {
    if (type === 'success') { setSuccess(msg); setError(''); }
    else { setError(msg); setSuccess(''); }
    setTimeout(() => { setSuccess(''); setError(''); }, 4000);
  };

  const handleAction = async (newStatus) => {
    setActioning(true);
    try {
      await apiService.handovers.setStatus(h.id, newStatus);
      flash('success', `Handover ${newStatus === 'submitted' ? 'submitted' : newStatus === 'draft' ? 'recalled to draft' : newStatus === 'acknowledged' ? 'acknowledged' : 'marked in progress'} ✓`);
      await load();
      onRefresh();
    } catch (err) {
      flash('error', err?.response?.data?.error?.message || 'Action failed');
    } finally { setActioning(false); }
  };

  const handleCompletePlay = async (playInstanceId) => {
    try {
      await apiService.handovers.completePlay(h.id, playInstanceId);
      await load();
    } catch (err) {
      flash('error', err?.response?.data?.error?.message || 'Failed to complete play');
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
  const isSalesView   = viewMode === 'mine';
  const isServiceView = viewMode === 'assigned';
  const isDraft       = detail.status === 'draft';
  const isSubmitted   = detail.status === 'submitted';
  const isAcknowledged = detail.status === 'acknowledged';

  const salesCanEdit  = isSalesView && isDraft;
  const serviceCanEdit = isServiceView && (isAcknowledged || detail.status === 'in_progress');

  const plays       = detail.plays         || [];
  const stakeholders = detail.stakeholders || [];
  const commitments  = detail.commitments  || [];

  const gatePlays    = plays.filter(p => p.isGate);
  const gatesTotal   = gatePlays.length;
  const gatesDone    = gatePlays.filter(p => p.completedAt).length;

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
          {detail.assignedServiceOwnerName && (
            <div><span style={{ color: '#6b7280' }}>Service owner: </span><strong>{detail.assignedServiceOwnerName}</strong></div>
          )}
          {detail.submittedAt && (
            <div><span style={{ color: '#6b7280' }}>Submitted: </span><strong>{fmtDate(detail.submittedAt)}</strong></div>
          )}
          {detail.acknowledgedAt && (
            <div><span style={{ color: '#6b7280' }}>Acknowledged: </span><strong>{fmtDate(detail.acknowledgedAt)}</strong></div>
          )}
        </div>

        {/* Gate progress */}
        {gatesTotal > 0 && (
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
              {actioning ? '⏳ Submitting…' : '📤 Submit Handover'}
            </button>
          )}
          {isSalesView && isSubmitted && (
            <button onClick={() => handleAction('draft')} disabled={actioning} style={{
              fontSize: 12, padding: '6px 14px', borderRadius: 6, fontWeight: 600, border: 'none',
              background: '#fef3c7', color: '#92400e', cursor: actioning ? 'not-allowed' : 'pointer',
            }}>
              {actioning ? '⏳…' : '↩ Recall to Draft'}
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
              {actioning ? '⏳…' : '▶ Mark In Progress'}
            </button>
          )}
        </div>

        {error   && <div style={{ marginTop: 10, padding: '6px 10px', background: '#fee2e2', borderRadius: 6, fontSize: 12, color: '#991b1b' }}>{error}</div>}
        {success && <div style={{ marginTop: 10, padding: '6px 10px', background: '#dcfce7', borderRadius: 6, fontSize: 12, color: '#065f46' }}>{success}</div>}
      </div>

      {/* ── Body ───────────────────────────────────────── */}
      <div style={{ padding: '16px 20px' }}>

        {/* Handover Checklist (plays) */}
        {plays.length > 0 && (
          <section style={{ marginBottom: 24 }}>
            <h4 style={{ margin: '0 0 12px', fontSize: 14, color: '#374151' }}>📋 Handover Checklist</h4>
            {plays.map(play => (
              <PlaySection
                key={play.id}
                play={play}
                handoverId={detail.id}
                canEdit={salesCanEdit}
                onComplete={handleCompletePlay}
              />
            ))}
          </section>
        )}

        {/* Commercial terms summary */}
        {(detail.commercialTermsSummary || salesCanEdit) && (
          <section style={{ marginBottom: 24 }}>
            <h4 style={{ margin: '0 0 8px', fontSize: 14, color: '#374151' }}>💰 Commercial Terms</h4>
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
            👤 Customer Stakeholders ({stakeholders.length})
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
            📌 Commitments &amp; Risks ({commitments.length})
          </h4>
          <CommitmentsSection
            commitments={commitments}
            canEdit={salesCanEdit}
            onAdd={handleAddCommitment}
            onRemove={handleRemoveCommitment}
          />
        </section>

        {/* Service notes (service view only) */}
        {isServiceView && (serviceCanEdit || detail.serviceNotes) && (
          <section style={{ marginBottom: 24 }}>
            <h4 style={{ margin: '0 0 8px', fontSize: 14, color: '#374151' }}>📝 Service Notes</h4>
            {serviceCanEdit ? (
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
        {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save Notes'}
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

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiService.handovers.list({ view: tab });
      setHandovers(res.data.handovers || []);
    } catch {
      setHandovers([]);
    } finally { setLoading(false); }
  }, [tab]);

  useEffect(() => { loadList(); setSelected(null); }, [loadList]);

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
            onRefresh={loadList}
          />
        )}
      </div>
    </div>
  );
}
