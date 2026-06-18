/* Extracted from OrgAdminView.js — Phase 1 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Panel: OAMembers. Rendered by the OrgAdmin shell. */
import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from '../../apiService';
import { DEPARTMENT_META, DEPARTMENT_OPTIONS, ROLE_META } from '../constants';
import { RoleBadge } from '../shared';

export default function OAMembers({ currentUserId }) {
  const [members, setMembers]         = useState([]);
  const [loading, setLoading]         = useState(true);
  const [search, setSearch]           = useState('');
  const [error, setError]             = useState('');
  const [success, setSuccess]         = useState('');
  const [callerRole, setCallerRole]   = useState('member');
  const [editingDept, setEditingDept] = useState(null); // userId currently editing dept

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const r = await apiService.orgAdmin.getMembers();
      setMembers(r.data.members);
      const me = r.data.members.find(m => m.user_id === currentUserId);
      if (me) setCallerRole(me.role);
    } catch { setError('Failed to load members'); }
    finally { setLoading(false); }
  }, [currentUserId]);

  useEffect(() => { load(); }, [load]);

  const handleRoleChange = async (userId, role) => {
    try {
      await apiService.orgAdmin.updateMember(userId, { role });
      setSuccess('Role updated');
      setTimeout(() => setSuccess(''), 2000);
      load();
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Failed to update role');
    }
  };

  const handleDepartmentChange = async (userId, department) => {
    try {
      await apiService.orgAdmin.updateMember(userId, { department: department || null });
      setSuccess('Department updated');
      setTimeout(() => setSuccess(''), 2000);
      setEditingDept(null);
      load();
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Failed to update department');
    }
  };

  const handleRemove = async (userId, name) => {
    if (!window.confirm(`Remove ${name} from the organisation?`)) return;
    try {
      await apiService.orgAdmin.removeMember(userId);
      setSuccess(`${name} removed`);
      setTimeout(() => setSuccess(''), 2000);
      load();
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Failed to remove member');
    }
  };

  const filtered = members.filter(m =>
    !search ||
    m.name?.toLowerCase().includes(search.toLowerCase()) ||
    m.email.toLowerCase().includes(search.toLowerCase()) ||
    m.department?.toLowerCase().includes(search.toLowerCase())
  );

  const isOwner = callerRole === 'owner';
  const canEditMembers = isOwner || callerRole === 'admin';

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>👥 Team Members</h2>
          <p className="sv-panel-desc">
            Manage who is in your organisation and what they can access.
            Set each member's <strong>department</strong> to enable team-based routing —
            members with the <strong>Legal</strong> department will receive contracts for review.
          </p>
        </div>
      </div>

      {error   && <div className="sv-error">⚠️ {error}</div>}
      {success && <div className="sv-success">{success}</div>}

      <div className="sv-panel-body">
        {/* Role legend */}
        <div className="oa-role-legend">
          {Object.entries(ROLE_META).map(([key, m]) => (
            <div key={key} className="oa-role-card">
              <div className="oa-role-card-header">
                <span className={`oa-role-badge oa-role-badge--${m.color}`}>{m.icon} {m.label}</span>
              </div>
              <p className="sv-hint">{m.desc}</p>
            </div>
          ))}
        </div>

        {/* Department info */}
        <div style={{
          background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8,
          padding: '10px 14px', marginBottom: 16, fontSize: 13, color: '#166534',
        }}>
          <strong>🏢 Departments</strong> — Members with the <strong>Legal</strong> department
          will be added to the CLM legal team queue for contract review. Click a member's
          department badge to change it.
        </div>

        {/* Search */}
        <input
          className="oa-search"
          placeholder="Search members by name, email, or department…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />

        {loading ? (
          <div className="sv-loading">Loading members…</div>
        ) : (
          <div className="oa-member-table">
            {filtered.length === 0 && <div className="sv-empty">No members found</div>}
            {filtered.map(m => {
              const isMe              = m.user_id === currentUserId;
              const canEdit           = !isMe && (isOwner || (callerRole === 'admin' && m.role !== 'owner'));
              const canChangeToOwner  = isOwner && !isMe;
              const deptMeta          = DEPARTMENT_META[m.department] || null;
              const isEditingThisDept = editingDept === m.user_id;

              return (
                <div key={m.user_id} className={`oa-member-row ${!m.is_active ? 'oa-member-row--inactive' : ''}`}>
                  <div className="oa-member-avatar">
                    {(m.name || m.email).charAt(0).toUpperCase()}
                  </div>
                  <div className="oa-member-info">
                    <div className="oa-member-name">
                      {m.name || m.email}
                      {isMe && <span className="oa-you-tag">you</span>}
                      {m.department === 'legal' && (
                        <span style={{
                          marginLeft: 6, fontSize: 11, background: '#ede9fe',
                          color: '#7c3aed', borderRadius: 4, padding: '2px 6px', fontWeight: 600,
                        }}>⚖️ Legal Team</span>
                      )}
                    </div>
                    <div className="oa-member-email">{m.email}</div>
                    <div className="oa-member-meta" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
                      <span>Joined {new Date(m.joined_at).toLocaleDateString()} · {m.action_count} actions</span>

                      {/* Department chip — click to edit */}
                      {isEditingThisDept && canEditMembers ? (
                        <select
                          style={{ fontSize: 12, padding: '2px 6px', borderRadius: 4, border: '1px solid #d1d5db' }}
                          defaultValue={m.department || ''}
                          autoFocus
                          onChange={e => handleDepartmentChange(m.user_id, e.target.value)}
                          onBlur={() => setEditingDept(null)}
                        >
                          {DEPARTMENT_OPTIONS.map(o => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      ) : (
                        <span
                          onClick={() => canEditMembers && setEditingDept(m.user_id)}
                          style={{
                            fontSize: 11, borderRadius: 4, padding: '2px 8px',
                            background: deptMeta ? `${deptMeta.color}15` : '#f1f5f9',
                            color: deptMeta ? deptMeta.color : '#64748b',
                            border: `1px solid ${deptMeta ? `${deptMeta.color}40` : '#e2e8f0'}`,
                            fontWeight: 500,
                            cursor: canEditMembers ? 'pointer' : 'default',
                          }}
                          title={canEditMembers ? 'Click to change department' : undefined}
                        >
                          {deptMeta ? `🏢 ${deptMeta.label}` : '+ Set department'}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="oa-member-role">
                    {canEdit ? (
                      <select
                        className="oa-role-select"
                        value={m.role}
                        onChange={e => handleRoleChange(m.user_id, e.target.value)}
                      >
                        {canChangeToOwner && <option value="owner">👑 Owner</option>}
                        <option value="admin">🔑 Admin</option>
                        <option value="member">👤 Member</option>
                        <option value="viewer">👁 Viewer</option>
                      </select>
                    ) : (
                      <RoleBadge role={m.role} />
                    )}
                  </div>
                  <div className="oa-member-actions">
                    {canEdit && (
                      <button
                        className="oa-btn-remove"
                        onClick={() => handleRemove(m.user_id, m.name || m.email)}
                        title="Remove from org"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
