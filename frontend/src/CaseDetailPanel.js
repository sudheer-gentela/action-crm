// CaseDetailPanel.js
// Full case detail panel for the Service module.
// Props:
//   caseId     {number}   — ID of the case to load
//   onBack     {fn}       — called when user clicks ← Back
//   onUpdated  {fn}       — called after any successful patch (passes updated case)
//
// All API calls use apiService.support.*

import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';
import {
  STATUS_CONFIG,
  TRANSITIONS,
  StatusBadge,
  PriorityBadge,
  SLATimer,
  Spinner,
} from './SupportShared';

// ── Internal sub-components ───────────────────────────────────────────────────

function MetaSection({ title, children }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
        {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</div>
    </div>
  );
}

function MetaRow({ label, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
      <span style={{ fontSize: 12, color: '#9ca3af', minWidth: 100, flexShrink: 0, paddingTop: 2 }}>{label}</span>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

function PlaysPanel({ plays, caseId, onPlayUpdated }) {
  const [expanded, setExpanded] = useState(true);
  const [updating, setUpdating] = useState(null);

  const handleUpdate = async (playId, status) => {
    setUpdating(playId);
    try {
      await apiService.support.updatePlay(caseId, playId, { status });
      onPlayUpdated();
    } catch (e) {
      console.error('Play update failed:', e.message);
    } finally {
      setUpdating(null);
    }
  };

  if (!plays?.length) return null;

  const completedCount = plays.filter(p => p.status === 'completed').length;

  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 9, marginBottom: 16, overflow: 'hidden' }}>
      <div
        onClick={() => setExpanded(v => !v)}
        style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', borderBottom: expanded ? '1px solid #e5e7eb' : 'none' }}
      >
        <div style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>
          Playbook Plays
          <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 500, color: '#9ca3af' }}>
            {completedCount}/{plays.length} complete
          </span>
        </div>
        <span style={{ color: '#9ca3af', fontSize: 12 }}>{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && (
        <div style={{ padding: '8px 0' }}>
          {plays.map(p => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '9px 16px', borderBottom: '1px solid #f9fafb' }}>
              {/* Status icon */}
              <div style={{ marginTop: 2, flexShrink: 0 }}>
                {p.status === 'completed'
                  ? <span style={{ fontSize: 16, color: '#10b981' }}>✓</span>
                  : p.status === 'skipped'
                  ? <span style={{ fontSize: 16, color: '#9ca3af' }}>–</span>
                  : <div style={{ width: 16, height: 16, borderRadius: '50%', border: '2px solid #d1d5db' }} />
                }
              </div>

              {/* Play info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 13, fontWeight: 500,
                  color: p.status === 'completed' ? '#9ca3af' : '#111827',
                  textDecoration: p.status === 'completed' ? 'line-through' : 'none',
                }}>
                  {p.play.title}
                </div>
                {p.play.description && (
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{p.play.description}</div>
                )}
                <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                  {p.play.channel  && <span style={{ fontSize: 10, background: '#f3f4f6', color: '#6b7280', padding: '1px 6px', borderRadius: 4 }}>{p.play.channel}</span>}
                  {p.play.priority && <span style={{ fontSize: 10, background: '#f3f4f6', color: '#6b7280', padding: '1px 6px', borderRadius: 4 }}>{p.play.priority}</span>}
                  {p.roleName      && <span style={{ fontSize: 10, background: '#eef2ff', color: '#6366f1', padding: '1px 6px', borderRadius: 4 }}>{p.roleName}</span>}
                  {p.dueAt         && <span style={{ fontSize: 10, color: '#9ca3af' }}>Due {new Date(p.dueAt).toLocaleDateString()}</span>}
                </div>
              </div>

              {/* Actions */}
              {p.status === 'pending' && (
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button
                    onClick={() => handleUpdate(p.id, 'completed')}
                    disabled={updating === p.id}
                    style={{ padding: '3px 10px', borderRadius: 6, border: '1px solid #10b981', background: '#fff', color: '#10b981', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
                  >
                    Done
                  </button>
                  <button
                    onClick={() => handleUpdate(p.id, 'skipped')}
                    disabled={updating === p.id}
                    style={{ padding: '3px 10px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', color: '#9ca3af', fontSize: 11, cursor: 'pointer' }}
                  >
                    Skip
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ActivityLog({ notes }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 9, marginBottom: 16 }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #e5e7eb', fontSize: 13, fontWeight: 700, color: '#111827' }}>
        Activity
      </div>
      <div style={{ padding: '8px 0', maxHeight: 360, overflowY: 'auto' }}>
        {(!notes || notes.length === 0) ? (
          <div style={{ padding: 16, fontSize: 13, color: '#9ca3af' }}>No activity yet.</div>
        ) : notes.map(n => (
          <div key={n.id} style={{ padding: '10px 16px', borderBottom: '1px solid #f9fafb' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <div style={{
                width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
                background: n.noteType === 'status_change' ? '#ede9fe' : n.noteType === 'assignment' ? '#fef3c7' : '#f0fdf4',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, fontWeight: 700, color: '#6b7280',
              }}>
                {n.noteType === 'status_change' ? '↔' : n.noteType === 'assignment' ? '→' : n.author ? (n.author.firstName || '?')[0].toUpperCase() : '🤖'}
              </div>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>
                {n.author ? `${n.author.firstName} ${n.author.lastName}` : 'System'}
              </span>
              {n.isInternal && (
                <span style={{ fontSize: 10, background: '#fef3c7', color: '#92400e', padding: '1px 6px', borderRadius: 10, fontWeight: 600 }}>
                  Internal
                </span>
              )}
              <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 'auto' }}>
                {new Date(n.createdAt).toLocaleString()}
              </span>
            </div>
            <div style={{
              fontSize: 13, marginLeft: 34,
              color: n.noteType === 'comment' ? '#374151' : '#6b7280',
              fontStyle: n.noteType !== 'comment' ? 'italic' : 'normal',
            }}>
              {n.body}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AddNoteForm({ caseId, onAdded }) {
  const [body, setBody]         = useState('');
  const [internal, setInternal] = useState(false);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');

  const handleSubmit = async () => {
    if (!body.trim()) return;
    setSaving(true); setError('');
    try {
      await apiService.support.addNote(caseId, { body: body.trim(), isInternal: internal });
      setBody('');
      setInternal(false);
      onAdded();
    } catch (e) {
      setError(e.response?.data?.error?.message || e.message || 'Failed to save note');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 9, padding: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 10 }}>Add Note</div>
      {error && <div style={{ marginBottom: 8, fontSize: 12, color: '#ef4444' }}>⚠️ {error}</div>}
      <textarea
        value={body}
        onChange={e => setBody(e.target.value)}
        placeholder="Write a note or comment…"
        rows={3}
        style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, resize: 'vertical', outline: 'none', boxSizing: 'border-box' }}
      />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#6b7280', cursor: 'pointer' }}>
          <input type="checkbox" checked={internal} onChange={e => setInternal(e.target.checked)} />
          Internal note (not visible to customer)
        </label>
        <button
          onClick={handleSubmit}
          disabled={saving || !body.trim()}
          style={{
            padding: '7px 20px', borderRadius: 8, border: 'none',
            background: body.trim() ? '#6366f1' : '#e5e7eb',
            color: body.trim() ? '#fff' : '#9ca3af',
            fontSize: 13, fontWeight: 600,
            cursor: body.trim() ? 'pointer' : 'default',
          }}
        >
          {saving ? 'Saving…' : 'Add Note'}
        </button>
      </div>
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export default function CaseDetailPanel({ caseId, onBack, onUpdated }) {
  const [caseData, setCaseData]         = useState(null);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState('');
  const [saving, setSaving]             = useState(false);
  const [teams, setTeams]               = useState([]);
  const [teamMembers, setTeamMembers]   = useState([]);
  const [slaTiers, setSlaTiers]         = useState([]);

  const load = useCallback(() => {
    setLoading(true);
    apiService.support.getCase(caseId)
      .then(r => { setCaseData(r.data.case); setError(''); })
      .catch(e => setError(e.response?.data?.error?.message || e.message || 'Failed to load case'))
      .finally(() => setLoading(false));
  }, [caseId]);

  useEffect(() => {
    load();
    apiService.support.getTeams()
      .then(r => setTeams(r.data.teams || []))
      .catch(() => {});
    apiService.support.getSlaTiers()
      .then(r => setSlaTiers(r.data.tiers || []))
      .catch(() => {});
  }, [load]);

  // Reload team members when assigned team changes
  useEffect(() => {
    if (!caseData?.assignedTeamId) { setTeamMembers([]); return; }
    apiService.support.getTeamMembers(caseData.assignedTeamId)
      .then(r => setTeamMembers(r.data.members || []))
      .catch(() => setTeamMembers([]));
  }, [caseData?.assignedTeamId]);

  const patch = async (payload) => {
    setSaving(true); setError('');
    try {
      const r = await apiService.support.updateCase(caseId, payload);
      setCaseData(r.data.case);
      if (onUpdated) onUpdated(r.data.case);
      // Refresh team members if team changed
      if (payload.assignedTeamId !== undefined) {
        if (payload.assignedTeamId) {
          apiService.support.getTeamMembers(payload.assignedTeamId)
            .then(r => setTeamMembers(r.data.members || []))
            .catch(() => {});
        } else {
          setTeamMembers([]);
        }
      }
    } catch (e) {
      setError(e.response?.data?.error?.message || e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Spinner />;
  if (error && !caseData) return <div style={{ padding: 24, color: '#ef4444' }}>⚠️ {error}</div>;
  if (!caseData) return null;

  const c = caseData;
  const nextStatuses = TRANSITIONS[c.status] || [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>

      {/* ── Header ── */}
      <div style={{ padding: '14px 20px', background: '#fff', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0 }}>
        <button
          onClick={onBack}
          style={{ padding: '6px 12px', borderRadius: 7, border: '1px solid #e5e7eb', background: '#fff', fontSize: 13, cursor: 'pointer', color: '#6b7280' }}
        >
          ← Back
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#6366f1' }}>{c.caseNumber}</span>
            <PriorityBadge priority={c.priority} small />
            <StatusBadge status={c.status} small />
            {c.responseBreached   && <SLATimer dueAt={c.responseDueAt}   breached label="Response" />}
            {c.resolutionBreached && <SLATimer dueAt={c.resolutionDueAt} breached label="Resolution" />}
          </div>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#111827', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {c.subject}
          </div>
        </div>
        {saving && <span style={{ fontSize: 12, color: '#9ca3af', flexShrink: 0 }}>Saving…</span>}
      </div>

      {/* ── Body: two-column layout ── */}
      <div style={{ flex: 1, overflowY: 'auto', background: '#f8fafc' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', minHeight: '100%' }}>

          {/* ── Left: actions + activity ── */}
          <div style={{ padding: 20, borderRight: '1px solid #e5e7eb' }}>

            {error && (
              <div style={{ marginBottom: 12, padding: '8px 12px', background: '#fee2e2', borderRadius: 7, fontSize: 13, color: '#ef4444' }}>
                ⚠️ {error}
              </div>
            )}

            {/* Status transitions */}
            {nextStatuses.length > 0 && (
              <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 9, padding: '14px 16px', marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
                  Move to
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {nextStatuses.map(s => {
                    const cfg = STATUS_CONFIG[s];
                    return (
                      <button
                        key={s}
                        onClick={() => patch({ status: s })}
                        disabled={saving}
                        style={{ padding: '7px 16px', borderRadius: 7, border: `1.5px solid ${cfg.color}`, background: '#fff', color: cfg.color, fontSize: 13, fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s' }}
                        onMouseEnter={e => { e.currentTarget.style.background = cfg.bg; }}
                        onMouseLeave={e => { e.currentTarget.style.background = '#fff'; }}
                      >
                        {cfg.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <PlaysPanel plays={c.plays} caseId={caseId} onPlayUpdated={load} />
            <ActivityLog notes={c.notes} />
            <AddNoteForm caseId={caseId} onAdded={load} />
          </div>

          {/* ── Right: metadata ── */}
          <div style={{ padding: 20, background: '#fff' }}>

            {c.description && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Description</div>
                <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{c.description}</div>
              </div>
            )}

            <MetaSection title="Details">
              <MetaRow label="Priority">
                <select
                  value={c.priority}
                  onChange={e => patch({ priority: e.target.value })}
                  disabled={saving}
                  style={{ fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 6, padding: '3px 8px', color: '#374151' }}
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </select>
              </MetaRow>
              <MetaRow label="SLA Tier">
                <select
                  value={c.slaTierId || ''}
                  onChange={e => patch({ slaTierId: e.target.value || null })}
                  disabled={saving}
                  style={{ fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 6, padding: '3px 8px', color: '#374151' }}
                >
                  <option value="">None</option>
                  {slaTiers.map(t => (
                    <option key={t.id} value={t.id}>{t.name} ({t.responseTargetHours}h / {t.resolutionTargetHours}h)</option>
                  ))}
                </select>
              </MetaRow>
              <MetaRow label="Account">
                {c.accountName
                  ? <span
                      onClick={() => window.dispatchEvent(new CustomEvent('navigate', { detail: { tab: 'accounts', accountId: c.accountId } }))}
                      style={{ fontSize: 13, color: '#6366f1', cursor: 'pointer' }}
                    >
                      {c.accountName} →
                    </span>
                  : <span style={{ fontSize: 13, color: '#9ca3af' }}>Not linked</span>
                }
              </MetaRow>
              <MetaRow label="Contact">
                <span style={{ fontSize: 13, color: '#374151' }}>{c.contactName || '—'}</span>
              </MetaRow>
              <MetaRow label="Deal">
                {c.dealName
                  ? <span
                      onClick={() => window.dispatchEvent(new CustomEvent('navigate', { detail: { tab: 'deals', dealId: c.dealId } }))}
                      style={{ fontSize: 13, color: '#6366f1', cursor: 'pointer' }}
                    >
                      {c.dealName} →
                    </span>
                  : <span style={{ fontSize: 13, color: '#9ca3af' }}>Not linked</span>
                }
              </MetaRow>
              <MetaRow label="Source">
                <span style={{ fontSize: 12, background: '#f3f4f6', color: '#6b7280', padding: '2px 8px', borderRadius: 4, textTransform: 'capitalize' }}>
                  {c.source}
                </span>
              </MetaRow>
            </MetaSection>

            <MetaSection title="Assignment">
              <MetaRow label="Team">
                <select
                  value={c.assignedTeamId || ''}
                  onChange={e => patch({ assignedTeamId: e.target.value || null, assignedTo: null })}
                  disabled={saving}
                  style={{ fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 6, padding: '3px 8px', color: '#374151', maxWidth: 160 }}
                >
                  <option value="">Unassigned</option>
                  {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </MetaRow>
              <MetaRow label="Assignee">
                <select
                  value={c.assignedTo || ''}
                  onChange={e => patch({ assignedTo: e.target.value || null })}
                  disabled={saving || !c.assignedTeamId}
                  style={{ fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 6, padding: '3px 8px', color: '#374151', maxWidth: 160, opacity: c.assignedTeamId ? 1 : 0.5 }}
                >
                  <option value="">Unassigned</option>
                  {teamMembers.map(m => <option key={m.id} value={m.id}>{m.first_name} {m.last_name}</option>)}
                </select>
                {!c.assignedTeamId && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>Select a team first</div>}
              </MetaRow>
              <MetaRow label="Created by">
                <span style={{ fontSize: 13, color: '#374151' }}>{c.creatorName || '—'}</span>
              </MetaRow>
            </MetaSection>

            <MetaSection title="SLA">
              <MetaRow label="Response due">
                {c.responseDueAt
                  ? <SLATimer dueAt={c.responseDueAt} breached={c.responseBreached} label="" />
                  : <span style={{ fontSize: 13, color: '#9ca3af' }}>—</span>}
              </MetaRow>
              <MetaRow label="Resolution due">
                {c.resolutionDueAt
                  ? <SLATimer dueAt={c.resolutionDueAt} breached={c.resolutionBreached} label="" />
                  : <span style={{ fontSize: 13, color: '#9ca3af' }}>—</span>}
              </MetaRow>
              {c.firstRespondedAt && (
                <MetaRow label="First response">
                  <span style={{ fontSize: 12, color: '#10b981' }}>{new Date(c.firstRespondedAt).toLocaleString()}</span>
                </MetaRow>
              )}
              {c.resolvedAt && (
                <MetaRow label="Resolved">
                  <span style={{ fontSize: 12, color: '#10b981' }}>{new Date(c.resolvedAt).toLocaleString()}</span>
                </MetaRow>
              )}
            </MetaSection>

            <MetaSection title="Dates">
              <MetaRow label="Created">
                <span style={{ fontSize: 12, color: '#6b7280' }}>{new Date(c.createdAt).toLocaleString()}</span>
              </MetaRow>
              <MetaRow label="Updated">
                <span style={{ fontSize: 12, color: '#6b7280' }}>{new Date(c.updatedAt).toLocaleString()}</span>
              </MetaRow>
            </MetaSection>

          </div>
        </div>
      </div>
    </div>
  );
}
