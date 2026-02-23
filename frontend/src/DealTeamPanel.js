import React, { useState, useEffect, useCallback } from 'react';
import './DealTeamPanel.css';

const API = process.env.REACT_APP_API_URL || '';

function apiFetch(path, options = {}) {
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  return fetch(`${API}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
    ...options,
  }).then(r => {
    if (!r.ok) return r.json().then(e => Promise.reject(new Error(e?.error?.message || r.statusText)));
    return r.json();
  });
}

// Role badge colours — mirrors oa-role-badge pattern from OrgAdminView
const ROLE_COLORS = {
  executive_sponsor: { bg: '#fdf4ff', color: '#7c3aed', border: '#c4b5fd' },
  deal_manager:      { bg: '#eff6ff', color: '#1d4ed8', border: '#93c5fd' },
  sales_engineer:    { bg: '#f0fdf4', color: '#15803d', border: '#86efac' },
  implementation:    { bg: '#fff7ed', color: '#c2410c', border: '#fdba74' },
  partner:           { bg: '#fefce8', color: '#a16207', border: '#fde047' },
  custom:            { bg: '#f8fafc', color: '#475569', border: '#cbd5e1' },
};

function RoleBadge({ roleName, roleKey }) {
  const colors = ROLE_COLORS[roleKey] || ROLE_COLORS.custom;
  return (
    <span
      className="dtp-role-badge"
      style={{ background: colors.bg, color: colors.color, borderColor: colors.border }}
    >
      {roleName}
    </span>
  );
}

function MemberAvatar({ name }) {
  const initials = name
    .split(' ')
    .map(n => n[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return <div className="dtp-avatar">{initials}</div>;
}

export default function DealTeamPanel({ deal }) {
  const [members,       setMembers]       = useState([]);
  const [roles,         setRoles]         = useState([]);
  const [eligibleUsers, setEligibleUsers] = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState('');
  const [showAddForm,   setShowAddForm]   = useState(false);
  const [addUserId,     setAddUserId]     = useState('');
  const [addRoleId,     setAddRoleId]     = useState('');
  const [addCustomRole, setAddCustomRole] = useState('');
  const [adding,        setAdding]        = useState(false);
  const [addError,      setAddError]      = useState('');

  const currentUser = JSON.parse(localStorage.getItem('user') || '{}');

  const fetchTeam = useCallback(async () => {
    if (!deal?.id) return;
    try {
      const [teamRes, rolesRes, eligibleRes] = await Promise.all([
        apiFetch(`/deal-team/${deal.id}/members`),
        apiFetch('/deal-roles'),
        apiFetch(`/deal-team/${deal.id}/eligible`),
      ]);
      setMembers(teamRes.members || []);
      setRoles((rolesRes.roles || []).filter(r => r.is_active));
      setEligibleUsers(eligibleRes.users || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [deal?.id]);

  useEffect(() => { fetchTeam(); }, [fetchTeam]);

  const selectedRole = roles.find(r => String(r.id) === String(addRoleId));
  const isCustomRole = selectedRole?.key === 'custom';

  async function handleAdd() {
    if (!addUserId) { setAddError('Please select a team member'); return; }
    if (!addRoleId) { setAddError('Please select a role'); return; }
    if (isCustomRole && !addCustomRole.trim()) { setAddError('Please enter a custom role name'); return; }

    setAdding(true);
    setAddError('');
    try {
      const res = await apiFetch(`/deal-team/${deal.id}/members`, {
        method: 'POST',
        body: JSON.stringify({
          userId:     parseInt(addUserId),
          roleId:     parseInt(addRoleId),
          customRole: isCustomRole ? addCustomRole.trim() : null,
        }),
      });
      setMembers(prev => [...prev, res.member]);
      // Remove added user from eligible list
      setEligibleUsers(prev => prev.filter(u => u.id !== parseInt(addUserId)));
      setAddUserId('');
      setAddRoleId('');
      setAddCustomRole('');
      setShowAddForm(false);
    } catch (err) {
      setAddError(err.message);
    } finally {
      setAdding(false);
    }
  }

  async function handleRoleChange(member, newRoleId) {
    const role = roles.find(r => String(r.id) === String(newRoleId));
    try {
      await apiFetch(`/deal-team/${deal.id}/members/${member.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          roleId:     parseInt(newRoleId),
          customRole: role?.key === 'custom' ? (member.customRole || '') : null,
        }),
      });
      setMembers(prev => prev.map(m =>
        m.id === member.id
          ? { ...m, roleId: parseInt(newRoleId), roleName: role?.key === 'custom' ? (member.customRole || 'Custom') : role?.name }
          : m
      ));
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleRemove(member) {
    if (!window.confirm(`Remove ${member.name} from this deal's team?`)) return;
    try {
      await apiFetch(`/deal-team/${deal.id}/members/${member.id}`, { method: 'DELETE' });
      setMembers(prev => prev.filter(m => m.id !== member.id));
      setEligibleUsers(prev => [...prev, { id: member.userId, name: member.name, email: member.email }]);
    } catch (err) {
      setError(err.message);
    }
  }

  if (loading) {
    return <div className="dtp-loading"><span className="dtp-spinner" /> Loading team…</div>;
  }

  return (
    <div className="dtp-root">

      {/* Header */}
      <div className="dtp-header">
        <span className="dtp-count">
          {members.length === 0
            ? 'No team members yet'
            : `${members.length} member${members.length !== 1 ? 's' : ''}`}
        </span>
        <button
          className="dtp-btn dtp-btn--add"
          onClick={() => { setShowAddForm(v => !v); setAddError(''); }}
        >
          {showAddForm ? 'Cancel' : '+ Add Member'}
        </button>
      </div>

      {error && <div className="dtp-error">⚠️ {error}</div>}

      {/* Add member form */}
      {showAddForm && (
        <div className="dtp-add-form">
          <div className="dtp-add-form__row">
            <select
              className="dtp-select"
              value={addUserId}
              onChange={e => setAddUserId(e.target.value)}
            >
              <option value="">Select team member…</option>
              {eligibleUsers.map(u => (
                <option key={u.id} value={u.id}>{u.name} — {u.email}</option>
              ))}
            </select>
            <select
              className="dtp-select"
              value={addRoleId}
              onChange={e => { setAddRoleId(e.target.value); setAddCustomRole(''); }}
            >
              <option value="">Select role…</option>
              {roles.map(r => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>
          {isCustomRole && (
            <input
              className="dtp-input"
              placeholder="Describe this person's role…"
              value={addCustomRole}
              onChange={e => setAddCustomRole(e.target.value)}
            />
          )}
          {addError && <div className="dtp-add-form__error">{addError}</div>}
          <div className="dtp-add-form__actions">
            <button
              className="dtp-btn dtp-btn--save"
              onClick={handleAdd}
              disabled={adding}
            >
              {adding ? '…' : 'Add to Team'}
            </button>
          </div>
        </div>
      )}

      {/* Member list */}
      {members.length === 0 && !showAddForm && (
        <p className="dtp-empty">Add team members to collaborate on this deal.</p>
      )}

      <div className="dtp-members">
        {members.map(member => {
          const isMe      = member.userId === currentUser.id;
          const isDealOwner = deal.user_id === member.userId;
          const canRemove = (deal.user_id === currentUser.id || currentUser.orgRole === 'admin' || currentUser.orgRole === 'owner') && !isDealOwner;

          return (
            <div key={member.id} className="dtp-member">
              <MemberAvatar name={member.name} />
              <div className="dtp-member__info">
                <div className="dtp-member__name">
                  {member.name}
                  {isMe && <span className="dtp-member__you"> (you)</span>}
                  {isDealOwner && <span className="dtp-member__owner"> 👑 Owner</span>}
                </div>
                <div className="dtp-member__email">{member.email}</div>
              </div>
              <div className="dtp-member__role">
                {isDealOwner ? (
                  <RoleBadge roleName="Deal Owner" roleKey="deal_manager" />
                ) : (
                  <select
                    className="dtp-role-select"
                    value={member.roleId || ''}
                    onChange={e => handleRoleChange(member, e.target.value)}
                    title="Change role"
                  >
                    {roles.map(r => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </select>
                )}
              </div>
              {canRemove && (
                <button
                  className="dtp-btn dtp-btn--remove"
                  onClick={() => handleRemove(member)}
                  title="Remove from team"
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
