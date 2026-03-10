// ─────────────────────────────────────────────────────────────────────────────
// AccountTeamsPanel.js
//
// Customer-side org team management — rendered as the "👥 Customer Teams"
// subtab inside OrgChartPanel (AccountsView detail panel).
//
// Teams are grouped by dimension (e.g. "Executive", "Technical", "Commercial").
// Each team shows its members with role badges. Admins can add/edit teams and
// add/remove/edit members from the account's contact list.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ROLE_LABELS = {
  lead:     { label: 'Lead',     bg: '#dbeafe', color: '#1e40af' },
  member:   { label: 'Member',   bg: '#f1f5f9', color: '#475569' },
  sponsor:  { label: 'Sponsor',  bg: '#fef3c7', color: '#92400e' },
  approver: { label: 'Approver', bg: '#dcfce7', color: '#166534' },
  other:    { label: 'Other',    bg: '#f3e8ff', color: '#6b21a8' },
};

function roleStyle(role) {
  return ROLE_LABELS[role] || ROLE_LABELS.other;
}

function getInitials(name = '') {
  return name.split(' ').map(w => w[0] || '').slice(0, 2).join('').toUpperCase();
}

function getAvatarColor(name = '') {
  const palettes = [
    ['#1e40af','#3b82f6'], ['#065f46','#10b981'], ['#6b21a8','#a78bfa'],
    ['#92400e','#f59e0b'], ['#1e3a5f','#0ea5e9'], ['#7f1d1d','#f87171'],
  ];
  return palettes[(name.charCodeAt(0) || 0) % palettes.length];
}

// ── MemberRow ─────────────────────────────────────────────────────────────────

function MemberRow({ member, canEdit, onUpdate, onRemove }) {
  const [editing, setEditing] = useState(false);
  const [role, setRole]       = useState(member.role);
  const [saving, setSaving]   = useState(false);
  const rs = roleStyle(member.role);
  const [c1, c2] = getAvatarColor(member.contactName || '');

  const handleSave = async () => {
    if (role === member.role) { setEditing(false); return; }
    setSaving(true);
    try {
      await onUpdate(member.id, { role });
      setEditing(false);
    } catch { /* keep editing open */ }
    finally { setSaving(false); }
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '8px 0', borderBottom: '1px solid #f3f4f6',
    }}>
      {/* Avatar */}
      <div style={{
        width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
        background: `linear-gradient(135deg, ${c1}, ${c2})`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 11, fontWeight: 700, color: '#fff',
      }}>
        {getInitials(member.contactName)}
      </div>

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>
          {member.contactName || '—'}
          {member.isPrimary && (
            <span style={{ marginLeft: 6, fontSize: 10, color: '#0369a1', fontWeight: 700 }}>★ Primary</span>
          )}
        </div>
        {member.contactTitle && (
          <div style={{ fontSize: 11, color: '#6b7280' }}>{member.contactTitle}</div>
        )}
      </div>

      {/* Role */}
      {editing ? (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <select value={role} onChange={e => setRole(e.target.value)}
            disabled={saving}
            style={{ fontSize: 12, padding: '2px 6px', borderRadius: 4, border: '1px solid #d1d5db' }}>
            {Object.entries(ROLE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select>
          <button onClick={handleSave} disabled={saving}
            style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4,
              background: '#0369a1', color: '#fff', border: 'none', cursor: 'pointer' }}>
            {saving ? '…' : 'Save'}
          </button>
          <button onClick={() => setEditing(false)}
            style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4,
              background: '#f1f5f9', color: '#374151', border: 'none', cursor: 'pointer' }}>
            Cancel
          </button>
        </div>
      ) : (
        <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 12,
          background: rs.bg, color: rs.color }}>
          {rs.label}
        </span>
      )}

      {canEdit && !editing && (
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={() => setEditing(true)} title="Edit role"
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: '#6b7280' }}>
            ✏️
          </button>
          <button onClick={() => onRemove(member.id)} title="Remove from team"
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: '#ef4444' }}>
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

// ── AddMemberForm ─────────────────────────────────────────────────────────────

function AddMemberForm({ teamId, accountContacts, existingMemberContactIds, onAdd, onCancel }) {
  const [contactId, setContactId] = useState('');
  const [role, setRole]           = useState('member');
  const [isPrimary, setIsPrimary] = useState(false);
  const [saving, setSaving]       = useState(false);

  const available = accountContacts.filter(c => !existingMemberContactIds.has(c.id));

  const handleSubmit = async () => {
    if (!contactId) return;
    setSaving(true);
    try {
      await onAdd({ contactId: parseInt(contactId), role, isPrimary });
    } finally { setSaving(false); }
  };

  return (
    <div style={{ padding: '10px 0', borderTop: '1px dashed #e5e7eb', marginTop: 8 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div>
          <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>Contact</div>
          <select value={contactId} onChange={e => setContactId(e.target.value)} disabled={saving}
            style={{ fontSize: 12, padding: '4px 8px', borderRadius: 4, border: '1px solid #d1d5db' }}>
            <option value="">Select contact…</option>
            {available.map(c => (
              <option key={c.id} value={c.id}>
                {c.first_name} {c.last_name}{c.title ? ` — ${c.title}` : ''}
              </option>
            ))}
          </select>
        </div>
        <div>
          <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>Role</div>
          <select value={role} onChange={e => setRole(e.target.value)} disabled={saving}
            style={{ fontSize: 12, padding: '4px 8px', borderRadius: 4, border: '1px solid #d1d5db' }}>
            {Object.entries(ROLE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={isPrimary} onChange={e => setIsPrimary(e.target.checked)} disabled={saving} />
          Primary contact
        </label>
        <button onClick={handleSubmit} disabled={saving || !contactId}
          style={{ fontSize: 12, padding: '4px 12px', borderRadius: 4,
            background: '#0369a1', color: '#fff', border: 'none', cursor: saving || !contactId ? 'not-allowed' : 'pointer' }}>
          {saving ? 'Adding…' : 'Add'}
        </button>
        <button onClick={onCancel} disabled={saving}
          style={{ fontSize: 12, padding: '4px 10px', borderRadius: 4,
            background: '#f1f5f9', color: '#374151', border: 'none', cursor: 'pointer' }}>
          Cancel
        </button>
      </div>
      {available.length === 0 && (
        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>
          All account contacts are already members of this team.
        </div>
      )}
    </div>
  );
}

// ── TeamCard ──────────────────────────────────────────────────────────────────

function TeamCard({ team, dimensions, accountContacts, canEdit, onTeamUpdate, onTeamDelete, onMemberAdd, onMemberUpdate, onMemberRemove }) {
  const [expanded,     setExpanded]     = useState(true);
  const [addingMember, setAddingMember] = useState(false);
  const [editing,      setEditing]      = useState(false);
  const [editName,     setEditName]     = useState(team.name);
  const [editDesc,     setEditDesc]     = useState(team.description || '');
  const [editDim,      setEditDim]      = useState(team.dimension);
  const [saving,       setSaving]       = useState(false);

  const existingMemberContactIds = new Set(team.members.map(m => m.contactId).filter(Boolean));

  const handleSave = async () => {
    setSaving(true);
    try {
      await onTeamUpdate(team.id, { name: editName, description: editDesc, dimension: editDim });
      setEditing(false);
    } catch { /* stay open */ }
    finally { setSaving(false); }
  };

  const handleAdd = async (data) => {
    await onMemberAdd(team.id, data);
    setAddingMember(false);
  };

  return (
    <div style={{
      border: '1px solid #e5e7eb', borderRadius: 8, marginBottom: 12,
      background: '#fff', overflow: 'hidden',
    }}>
      {/* Team header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 14px', background: '#f8fafc',
        borderBottom: expanded ? '1px solid #e5e7eb' : 'none',
        cursor: 'pointer',
      }} onClick={() => !editing && setExpanded(v => !v)}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#111827', flex: 1 }}>
          {team.name}
        </span>
        <span style={{ fontSize: 11, color: '#6b7280' }}>
          {team.members.length} member{team.members.length !== 1 ? 's' : ''}
        </span>
        {canEdit && (
          <div style={{ display: 'flex', gap: 4 }} onClick={e => e.stopPropagation()}>
            <button onClick={() => setEditing(v => !v)} title="Edit team"
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: '#6b7280' }}>
              ✏️
            </button>
            <button onClick={() => onTeamDelete(team.id)} title="Delete team"
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: '#ef4444' }}>
              🗑
            </button>
          </div>
        )}
        <span style={{ fontSize: 11, color: '#9ca3af' }}>{expanded ? '▲' : '▼'}</span>
      </div>

      {/* Edit form */}
      {editing && (
        <div style={{ padding: '10px 14px', background: '#fafafa', borderBottom: '1px solid #e5e7eb' }}
          onClick={e => e.stopPropagation()}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 140 }}>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>Team name</div>
              <input value={editName} onChange={e => setEditName(e.target.value)} disabled={saving}
                style={{ width: '100%', fontSize: 12, padding: '4px 8px', borderRadius: 4, border: '1px solid #d1d5db', boxSizing: 'border-box' }} />
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>Dimension</div>
              <select value={editDim} onChange={e => setEditDim(e.target.value)} disabled={saving}
                style={{ fontSize: 12, padding: '4px 8px', borderRadius: 4, border: '1px solid #d1d5db' }}>
                {dimensions.map(d => (
                  <option key={d.key} value={d.key}>{d.name}</option>
                ))}
                <option value="custom">Custom</option>
              </select>
            </div>
          </div>
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>Description (optional)</div>
            <input value={editDesc} onChange={e => setEditDesc(e.target.value)} disabled={saving}
              placeholder="Brief description of this team's purpose"
              style={{ width: '100%', fontSize: 12, padding: '4px 8px', borderRadius: 4, border: '1px solid #d1d5db', boxSizing: 'border-box' }} />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button onClick={handleSave} disabled={saving || !editName.trim()}
              style={{ fontSize: 12, padding: '4px 12px', borderRadius: 4, background: '#0369a1', color: '#fff', border: 'none', cursor: 'pointer' }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => setEditing(false)} disabled={saving}
              style={{ fontSize: 12, padding: '4px 10px', borderRadius: 4, background: '#f1f5f9', color: '#374151', border: 'none', cursor: 'pointer' }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Member list */}
      {expanded && (
        <div style={{ padding: '6px 14px 10px' }}>
          {team.description && (
            <p style={{ fontSize: 12, color: '#6b7280', margin: '6px 0 8px', fontStyle: 'italic' }}>
              {team.description}
            </p>
          )}
          {team.members.length === 0 ? (
            <div style={{ fontSize: 12, color: '#9ca3af', padding: '8px 0', fontStyle: 'italic' }}>
              No members yet.
            </div>
          ) : (
            team.members.map(m => (
              <MemberRow
                key={m.id}
                member={m}
                canEdit={canEdit}
                onUpdate={(memberId, data) => onMemberUpdate(team.id, memberId, data)}
                onRemove={(memberId) => onMemberRemove(team.id, memberId)}
              />
            ))
          )}

          {canEdit && !addingMember && (
            <button onClick={() => setAddingMember(true)}
              style={{ marginTop: 8, fontSize: 12, padding: '4px 10px', borderRadius: 4,
                background: '#f0f9ff', color: '#0369a1', border: '1px dashed #93c5fd', cursor: 'pointer' }}>
              + Add member
            </button>
          )}
          {canEdit && addingMember && (
            <AddMemberForm
              teamId={team.id}
              accountContacts={accountContacts}
              existingMemberContactIds={existingMemberContactIds}
              onAdd={handleAdd}
              onCancel={() => setAddingMember(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ── AccountTeamsPanel ─────────────────────────────────────────────────────────

export function AccountTeamsPanel({ accountId, accountContacts = [], canEdit = false }) {
  const [teams,      setTeams]      = useState([]);
  const [dimensions, setDimensions] = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState('');
  const [showNew,    setShowNew]    = useState(false);
  const [newName,    setNewName]    = useState('');
  const [newDim,     setNewDim]     = useState('custom');
  const [creating,   setCreating]   = useState(false);

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true); setError('');
    try {
      const [teamsRes, dimsRes] = await Promise.all([
        apiService.accountTeams.listByAccount(accountId),
        apiService.teamDimensions.list(),
      ]);
      setTeams(teamsRes.data.teams || []);
      setDimensions((dimsRes.data.dimensions || []).filter(d =>
        d.appliesTo === 'customer' || d.appliesTo === 'both'
      ));
    } catch (err) {
      setError(err?.response?.data?.error?.message || 'Failed to load teams');
    } finally { setLoading(false); }
  }, [accountId]);

  useEffect(() => { load(); }, [load]);

  // ── Group teams by dimension ──────────────────────────────
  const grouped = {};
  teams.forEach(t => {
    const key = t.dimension || 'custom';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(t);
  });

  const dimLabel = (key) => {
    const d = dimensions.find(d => d.key === key);
    return d?.name || key.charAt(0).toUpperCase() + key.slice(1);
  };

  // ── Create team ───────────────────────────────────────────
  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await apiService.accountTeams.create({ accountId, name: newName.trim(), dimension: newDim });
      setNewName(''); setShowNew(false);
      await load();
    } catch (err) {
      setError(err?.response?.data?.error?.message || 'Failed to create team');
    } finally { setCreating(false); }
  };

  // ── Update team ───────────────────────────────────────────
  const handleTeamUpdate = async (teamId, data) => {
    await apiService.accountTeams.update(teamId, data);
    await load();
  };

  // ── Delete team ───────────────────────────────────────────
  const handleTeamDelete = async (teamId) => {
    const team = teams.find(t => t.id === teamId);
    if (!window.confirm(`Delete team "${team?.name}"? Members will be removed too.`)) return;
    await apiService.accountTeams.delete(teamId);
    await load();
  };

  // ── Member operations ─────────────────────────────────────
  const handleMemberAdd = async (teamId, data) => {
    await apiService.accountTeams.addMember(teamId, data);
    await load();
  };

  const handleMemberUpdate = async (teamId, memberId, data) => {
    await apiService.accountTeams.updateMember(teamId, memberId, data);
    await load();
  };

  const handleMemberRemove = async (teamId, memberId) => {
    await apiService.accountTeams.removeMember(teamId, memberId);
    await load();
  };

  // ── Render ────────────────────────────────────────────────

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 24, color: '#6b7280', fontSize: 13 }}>
      <div style={{ width: 16, height: 16, border: '2px solid #e5e7eb', borderTopColor: '#0369a1', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
      Loading teams…
    </div>
  );

  return (
    <div style={{ padding: '4px 0' }}>
      {error && (
        <div style={{ padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, color: '#991b1b', fontSize: 12, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {/* Toolbar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 12, color: '#6b7280' }}>
          {teams.length} team{teams.length !== 1 ? 's' : ''} across {Object.keys(grouped).length} dimension{Object.keys(grouped).length !== 1 ? 's' : ''}
        </div>
        {canEdit && (
          <button onClick={() => setShowNew(v => !v)}
            style={{ fontSize: 12, padding: '5px 12px', borderRadius: 6,
              background: showNew ? '#f1f5f9' : '#0369a1', color: showNew ? '#374151' : '#fff',
              border: 'none', cursor: 'pointer', fontWeight: 600 }}>
            {showNew ? 'Cancel' : '+ New Team'}
          </button>
        )}
      </div>

      {/* New team form */}
      {showNew && canEdit && (
        <div style={{ padding: 14, background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#0369a1', marginBottom: 10 }}>New Customer Team</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: 1, minWidth: 140 }}>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>Team name</div>
              <input value={newName} onChange={e => setNewName(e.target.value)} disabled={creating}
                placeholder="e.g. Executive Sponsors"
                style={{ width: '100%', fontSize: 12, padding: '5px 8px', borderRadius: 4, border: '1px solid #d1d5db', boxSizing: 'border-box' }} />
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3 }}>Dimension</div>
              <select value={newDim} onChange={e => setNewDim(e.target.value)} disabled={creating}
                style={{ fontSize: 12, padding: '5px 8px', borderRadius: 4, border: '1px solid #d1d5db' }}>
                {dimensions.map(d => (
                  <option key={d.key} value={d.key}>{d.name}</option>
                ))}
                <option value="custom">Custom</option>
              </select>
            </div>
            <button onClick={handleCreate} disabled={creating || !newName.trim()}
              style={{ fontSize: 12, padding: '5px 14px', borderRadius: 4,
                background: '#0369a1', color: '#fff', border: 'none',
                cursor: creating || !newName.trim() ? 'not-allowed' : 'pointer' }}>
              {creating ? 'Creating…' : 'Create'}
            </button>
          </div>
        </div>
      )}

      {/* Teams grouped by dimension */}
      {teams.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '32px 16px', color: '#9ca3af' }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>👥</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#475569', marginBottom: 4 }}>No customer teams yet</div>
          <div style={{ fontSize: 12 }}>
            {canEdit
              ? 'Create teams to track stakeholder groups like "Executive Sponsors" or "Technical Leads".'
              : 'No customer teams have been set up for this account.'}
          </div>
        </div>
      ) : (
        Object.entries(grouped).map(([dimKey, dimTeams]) => (
          <div key={dimKey} style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase',
              letterSpacing: '0.05em', marginBottom: 8, paddingBottom: 4, borderBottom: '1px solid #f3f4f6' }}>
              {dimLabel(dimKey)}
            </div>
            {dimTeams.map(team => (
              <TeamCard
                key={team.id}
                team={team}
                dimensions={dimensions}
                accountContacts={accountContacts}
                canEdit={canEdit}
                onTeamUpdate={handleTeamUpdate}
                onTeamDelete={handleTeamDelete}
                onMemberAdd={handleMemberAdd}
                onMemberUpdate={handleMemberUpdate}
                onMemberRemove={handleMemberRemove}
              />
            ))}
          </div>
        ))
      )}
    </div>
  );
}

export default AccountTeamsPanel;
