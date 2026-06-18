/* Extracted from OrgAdminView.js — Phase 1 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Panel: OATeams. Rendered by the OrgAdmin shell. */
import React, { useState, useEffect } from 'react';
import { apiService } from '../../apiService';
import { getDimColor } from '../helpers';
import OATeamRoster from './OATeamRoster';

export default function OATeams() {
  const [dimensions, setDimensions]   = useState([]);
  const [teams, setTeams]             = useState([]);
  const [members, setMembers]         = useState([]);
  const [memberships, setMemberships] = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState('');
  const [success, setSuccess]         = useState('');
  const [activeDim, setActiveDim]     = useState(null);
  const [showNewTeam, setShowNewTeam] = useState(false);
  const [newTeamLines, setNewTeamLines] = useState('');
  const [saving, setSaving]           = useState(false);
  const [showDimConfig, setShowDimConfig] = useState(false);
  const [dimDraft, setDimDraft]       = useState([]);
  const [assigningUser, setAssigningUser] = useState(null);
  const [subTab, setSubTab] = useState('setup'); // 'setup' | 'roster'
  const [rosterDimFilter, setRosterDimFilter] = useState('all');
  const [rosterTeamFilter, setRosterTeamFilter] = useState('all');
  const [rosterSearch, setRosterSearch] = useState('');

  const load = async () => {
    try {
      setLoading(true);
      const [dimRes, teamsRes, membersRes, membershipRes] = await Promise.all([
        apiService.orgAdmin.getTeamDimensions(),
        apiService.orgAdmin.getTeams(),
        apiService.orgAdmin.getMembers(),
        apiService.orgAdmin.getTeamMemberships(),
      ]);
      const dims = dimRes.data.dimensions || [];
      setDimensions(dims);
      setTeams(teamsRes.data.teams || []);
      setMembers(membersRes.data.members || []);
      setMemberships(membershipRes.data.memberships || []);
      // Set active dimension if none selected or current one no longer exists
      setActiveDim(prev => {
        if (!prev || !dims.find(d => d.key === prev)) {
          return dims.length > 0 ? dims[0].key : null;
        }
        return prev;
      });
    } catch (err) {
      setError('Failed to load teams data');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);

  const flash = (msg) => { setSuccess(msg); setTimeout(() => setSuccess(''), 3000); };

  // ── Team CRUD ─────────────────────────────────────────────────

  const handleCreateTeams = async () => {
    if (!activeDim) return;
    const names = newTeamLines
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0);
    if (names.length === 0) return;

    // Deduplicate input and skip names that already exist
    const uniqueNames = [...new Set(names)];
    const existingNames = new Set(activeTeams.map(t => t.name.toLowerCase()));
    const toCreate = uniqueNames.filter(n => !existingNames.has(n.toLowerCase()));

    if (toCreate.length === 0) {
      setError('All entered team names already exist in this dimension');
      return;
    }

    setSaving(true);
    setError('');
    const created = [];
    const failed = [];
    for (const name of toCreate) {
      try {
        await apiService.orgAdmin.createTeam({
          name,
          dimension: activeDim,
        });
        created.push(name);
      } catch (err) {
        const msg = err.response?.data?.error?.message || err.message;
        failed.push(`${name}: ${msg}`);
      }
    }

    if (created.length > 0) {
      flash(`Created ${created.length} team${created.length > 1 ? 's' : ''}`);
    }
    if (failed.length > 0) {
      setError(`Failed to create: ${failed.join('; ')}`);
    }

    setNewTeamLines('');
    setShowNewTeam(false);
    await load();
    setSaving(false);
  };

  const handleDeleteTeam = async (team) => {
    if (!window.confirm(`Delete "${team.name}"? All memberships will be removed.`)) return;
    try {
      await apiService.orgAdmin.deleteTeam(team.id);
      flash(`Team "${team.name}" deleted`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message);
    }
  };

  // ── Dimension config ──────────────────────────────────────────

  const openDimConfig = () => {
    setDimDraft(JSON.parse(JSON.stringify(dimensions)));
    setShowDimConfig(true);
  };

  const addDimension = () => {
    setDimDraft([...dimDraft, { key: '', label: '', required: false, description: '' }]);
  };

  const removeDimension = (idx) => {
    setDimDraft(dimDraft.filter((_, i) => i !== idx));
  };

  const updateDimDraft = (idx, field, value) => {
    const updated = [...dimDraft];
    updated[idx] = { ...updated[idx], [field]: value };
    // Always auto-generate key from label
    if (field === 'label') {
      updated[idx].key = value.toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_|_$/g, '');
    }
    setDimDraft(updated);
  };

  const saveDimConfig = async () => {
    // Filter out any dimensions with empty key or label
    const validDims = dimDraft.filter(d => d.key && d.key.trim() && d.label && d.label.trim());
    if (validDims.length === 0) {
      setError('At least one dimension with a name is required');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await apiService.orgAdmin.updateTeamDimensions(validDims);
      flash('Dimensions updated');
      setShowDimConfig(false);
      await load();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to save dimensions');
    } finally {
      setSaving(false);
    }
  };

  // ── Membership assignment ─────────────────────────────────────

  const handleAssign = async (userId, teamId) => {
    try {
      await apiService.orgAdmin.setTeamMembership(userId, teamId);
      flash('Assignment updated');
      await load();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message);
    }
  };

  const handleRemoveMembership = async (userId, teamId) => {
    try {
      await apiService.orgAdmin.removeTeamMembership(userId, teamId);
      flash('Assignment removed');
      await load();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message);
    }
  };

  // ── Derived data ──────────────────────────────────────────────

  const activeTeams = teams.filter(t => t.dimension === activeDim);
  const activeDimLabel = dimensions.find(d => d.key === activeDim)?.label || activeDim;

  // Build user → team mapping per dimension
  const userTeamMap = {};
  for (const m of memberships) {
    if (!userTeamMap[m.user_id]) userTeamMap[m.user_id] = {};
    userTeamMap[m.user_id][m.dimension] = { teamId: m.team_id, teamName: m.team_name };
  }

  const activeMembers = (members || []).filter(m => m.is_active);

  if (loading) return <div className="oa-loading">Loading teams…</div>;

  return (
    <div>
      {error && <div className="oa-error">{error} <button onClick={() => setError('')}>×</button></div>}
      {success && <div className="oa-success">{success}</div>}

      {/* Sub-tab switcher */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid #e5e7eb', paddingBottom: 0 }}>
        {[
          { id: 'setup', label: 'Setup', icon: '⚙️' },
          { id: 'roster', label: 'Team Roster', icon: '👥' },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setSubTab(t.id)}
            style={{
              padding: '8px 16px', fontSize: 12, fontWeight: subTab === t.id ? 600 : 400,
              cursor: 'pointer', border: 'none', borderBottom: subTab === t.id ? '2px solid #111827' : '2px solid transparent',
              background: 'none', color: subTab === t.id ? '#111827' : '#6b7280',
              marginBottom: -1, transition: 'all 0.15s',
            }}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {subTab === 'setup' && (<>
      {/* Header with stats */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
        <div className="oa-stat-card">
          <div className="oa-stat-card-label">Dimensions</div>
          <div className="oa-stat-card-value" style={{ color: '#7c3aed' }}>{dimensions.length}</div>
        </div>
        <div className="oa-stat-card">
          <div className="oa-stat-card-label">Total Teams</div>
          <div className="oa-stat-card-value" style={{ color: '#2563eb' }}>{teams.length}</div>
        </div>
        <div className="oa-stat-card">
          <div className="oa-stat-card-label">Assigned Users</div>
          <div className="oa-stat-card-value" style={{ color: '#059669' }}>
            {new Set(memberships.map(m => m.user_id)).size}
          </div>
        </div>
      </div>

      {/* Info bar */}
      <div style={{
        padding: '10px 16px', marginBottom: 16, borderRadius: 8,
        background: '#f8fafc', border: '1px solid #e2e8f0', fontSize: 12, color: '#64748b',
      }}>
        Teams organise users by operational dimensions (market, role, geo, etc.).
        This is separate from the reporting hierarchy — teams don't affect data visibility.
        <button onClick={openDimConfig} style={{
          marginLeft: 12, fontSize: 11, color: '#2563eb', background: 'none',
          border: 'none', cursor: 'pointer', textDecoration: 'underline',
        }}>
          Configure dimensions →
        </button>
      </div>

      {/* Dimension tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {dimensions.map(dim => {
          const count = teams.filter(t => t.dimension === dim.key).length;
          return (
            <button
              key={dim.key}
              onClick={() => setActiveDim(dim.key)}
              style={{
                padding: '7px 14px', borderRadius: 6, fontSize: 12, fontWeight: 500,
                cursor: 'pointer', border: 'none', transition: 'all 0.15s',
                background: activeDim === dim.key ? getDimColor(dim.key) + '15' : '#f3f4f6',
                color: activeDim === dim.key ? getDimColor(dim.key) : '#6b7280',
                outline: activeDim === dim.key ? `2px solid ${getDimColor(dim.key)}40` : 'none',
              }}
            >
              {dim.label} ({count})
            </button>
          );
        })}
      </div>

      {/* Active dimension teams */}
      {activeDim && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0, color: '#111827' }}>
              {activeDimLabel} Teams
            </h3>
            <button
              onClick={() => setShowNewTeam(!showNewTeam)}
              style={{
                padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                background: getDimColor(activeDim), color: '#fff', border: 'none', cursor: 'pointer',
              }}
            >
              + Add Teams
            </button>
          </div>

          {/* New team form — batch */}
          {showNewTeam && (
            <div style={{
              padding: 16, marginBottom: 12, borderRadius: 8,
              background: '#fff', border: `1px solid ${getDimColor(activeDim)}30`,
              borderLeft: `3px solid ${getDimColor(activeDim)}`,
            }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: getDimColor(activeDim), marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                Add {activeDimLabel} Teams
              </div>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 8 }}>
                Enter one team name per line. You can paste a list.
              </div>
              <textarea
                value={newTeamLines}
                onChange={e => setNewTeamLines(e.target.value)}
                placeholder={`e.g.\n${activeDim === 'market_segment' ? 'Enterprise\nMid-Market\nSMB' : activeDim === 'geo' ? 'AMER\nEMEA\nAPAC' : activeDim === 'seller_role' ? 'AE\nSDR\nSE' : 'Team Alpha\nTeam Beta\nTeam Gamma'}`}
                rows={5}
                style={{
                  width: '100%', padding: '8px 12px', borderRadius: 6,
                  border: '1px solid #d1d5db', fontSize: 13, fontFamily: 'inherit',
                  resize: 'vertical', lineHeight: 1.5,
                }}
              />
              {(() => {
                const names = newTeamLines.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                const uniqueCount = new Set(names).size;
                const existingNames = new Set(activeTeams.map(t => t.name.toLowerCase()));
                const dupeCount = names.filter(n => existingNames.has(n.toLowerCase())).length;
                return names.length > 0 ? (
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 6 }}>
                    {uniqueCount} team{uniqueCount !== 1 ? 's' : ''} to create
                    {dupeCount > 0 && <span style={{ color: '#d97706' }}> · {dupeCount} already exist (will be skipped)</span>}
                  </div>
                ) : null;
              })()}
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button
                  onClick={handleCreateTeams}
                  disabled={!newTeamLines.trim() || saving}
                  style={{
                    padding: '8px 16px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                    background: newTeamLines.trim() ? getDimColor(activeDim) : '#d1d5db',
                    color: '#fff', border: 'none', cursor: newTeamLines.trim() ? 'pointer' : 'default',
                  }}
                >
                  {saving ? 'Creating…' : 'Create Teams'}
                </button>
                <button
                  onClick={() => { setShowNewTeam(false); setNewTeamLines(''); }}
                  style={{ padding: '8px 12px', borderRadius: 6, fontSize: 12, background: '#f3f4f6', border: 'none', cursor: 'pointer', color: '#6b7280' }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Team list */}
          {activeTeams.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
              No {activeDimLabel.toLowerCase()} teams yet. Create one to start assigning users.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {activeTeams.map(team => (
                <div key={team.id} style={{
                  padding: '12px 16px', borderRadius: 8,
                  background: '#fff', border: '1px solid #e5e7eb',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                }}>
                  <div>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{team.name}</span>
                    {team.description && (
                      <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 8 }}>{team.description}</span>
                    )}
                    <span style={{
                      marginLeft: 8, fontSize: 10, padding: '2px 8px', borderRadius: 10,
                      background: getDimColor(activeDim) + '12', color: getDimColor(activeDim),
                      fontWeight: 600,
                    }}>
                      {team.member_count} member{team.member_count !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <button
                    onClick={() => handleDeleteTeam(team)}
                    style={{ fontSize: 11, color: '#dc2626', background: 'none', border: 'none', cursor: 'pointer' }}
                    title="Delete team"
                  >
                    🗑
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── User Assignment Grid ──────────────────────────────── */}
      <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: 20 }}>
        <h3 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 12px', color: '#111827' }}>
          User Assignments
        </h3>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
                <th style={{ textAlign: 'left', padding: '8px 12px', fontWeight: 600, color: '#374151', minWidth: 160 }}>User</th>
                {dimensions.map(dim => (
                  <th key={dim.key} style={{
                    textAlign: 'left', padding: '8px 12px', fontWeight: 600, minWidth: 120,
                    color: getDimColor(dim.key),
                  }}>
                    {dim.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {activeMembers.map(member => {
                const userTeams = userTeamMap[member.user_id] || {};
                return (
                  <tr key={member.user_id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '8px 12px', fontWeight: 500, color: '#111827' }}>
                      {member.first_name} {member.last_name}
                      <div style={{ fontSize: 10, color: '#9ca3af', fontWeight: 400 }}>{member.email}</div>
                    </td>
                    {dimensions.map(dim => {
                      const assignment = userTeams[dim.key];
                      const dimTeams = teams.filter(t => t.dimension === dim.key);
                      const isAssigning = assigningUser === `${member.user_id}-${dim.key}`;
                      return (
                        <td key={dim.key} style={{ padding: '6px 12px' }}>
                          {isAssigning ? (
                            <select
                              autoFocus
                              value={assignment?.teamId || ''}
                              onChange={async (e) => {
                                const val = e.target.value;
                                setAssigningUser(null);
                                if (val === '' && assignment) {
                                  await handleRemoveMembership(member.user_id, assignment.teamId);
                                } else if (val) {
                                  await handleAssign(member.user_id, parseInt(val));
                                }
                              }}
                              onBlur={() => setAssigningUser(null)}
                              style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #d1d5db', fontSize: 11, width: '100%' }}
                            >
                              <option value="">— None —</option>
                              {dimTeams.map(t => (
                                <option key={t.id} value={t.id}>{t.name}</option>
                              ))}
                            </select>
                          ) : (
                            <button
                              onClick={() => setAssigningUser(`${member.user_id}-${dim.key}`)}
                              style={{
                                padding: '3px 10px', borderRadius: 4, fontSize: 11, cursor: 'pointer',
                                border: assignment ? `1px solid ${getDimColor(dim.key)}30` : '1px dashed #d1d5db',
                                background: assignment ? getDimColor(dim.key) + '10' : 'transparent',
                                color: assignment ? getDimColor(dim.key) : '#9ca3af',
                                fontWeight: assignment ? 500 : 400,
                              }}
                            >
                              {assignment ? assignment.teamName : '+ Assign'}
                            </button>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {activeMembers.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
            No active members to assign.
          </div>
        )}
      </div>
      </>)}

      {/* ── Roster Sub-Tab ─────────────────────────────────────── */}
      {subTab === 'roster' && (
        <OATeamRoster
          dimensions={dimensions}
          teams={teams}
          members={activeMembers}
          memberships={memberships}
          rosterDimFilter={rosterDimFilter}
          setRosterDimFilter={setRosterDimFilter}
          rosterTeamFilter={rosterTeamFilter}
          setRosterTeamFilter={setRosterTeamFilter}
          rosterSearch={rosterSearch}
          setRosterSearch={setRosterSearch}
          getDimColor={getDimColor}
        />
      )}

      {/* ── Dimension Config Modal ──────────────────────────────── */}
      {showDimConfig && (
        <div className="pv-modal-overlay" onClick={() => setShowDimConfig(false)}>
          <div onClick={e => e.stopPropagation()} style={{
            background: '#fff', borderRadius: 12, width: '90%', maxWidth: 600,
            maxHeight: '80vh', overflow: 'auto', padding: 24,
            boxShadow: '0 25px 50px rgba(0,0,0,0.15)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Configure Team Dimensions</h3>
              <button onClick={() => setShowDimConfig(false)} style={{ fontSize: 20, background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}>×</button>
            </div>

            <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 16 }}>
              Dimensions define the categories of teams (e.g. Market Segment, Geo). Add, rename, or remove dimensions.
              You cannot remove a dimension that has active teams — delete those teams first.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
              {dimDraft.map((dim, idx) => (
                <div key={idx} style={{
                  display: 'flex', gap: 8, alignItems: 'center',
                  padding: '8px 12px', background: '#f9fafb', borderRadius: 6, border: '1px solid #e5e7eb',
                }}>
                  <input
                    type="text"
                    value={dim.label}
                    onChange={e => updateDimDraft(idx, 'label', e.target.value)}
                    placeholder="Label (e.g. Market Segment)"
                    style={{ flex: 1, padding: '6px 10px', borderRadius: 4, border: '1px solid #d1d5db', fontSize: 12 }}
                  />
                  <input
                    type="text"
                    value={dim.key}
                    readOnly
                    style={{ width: 130, padding: '6px 10px', borderRadius: 4, border: '1px solid #e5e7eb', fontSize: 11, fontFamily: 'monospace', color: '#9ca3af', background: '#f9fafb' }}
                    title="Auto-generated from label"
                  />
                  <button
                    onClick={() => removeDimension(idx)}
                    style={{ fontSize: 14, background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', padding: '4px 8px' }}
                    title="Remove dimension"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>

            <button onClick={addDimension} style={{
              padding: '6px 14px', borderRadius: 6, fontSize: 12,
              background: '#f3f4f6', border: '1px dashed #d1d5db', cursor: 'pointer', color: '#6b7280', marginBottom: 16,
            }}>
              + Add Dimension
            </button>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowDimConfig(false)} style={{
                padding: '8px 16px', borderRadius: 6, fontSize: 12, background: '#f3f4f6', border: 'none', cursor: 'pointer', color: '#374151',
              }}>
                Cancel
              </button>
              <button onClick={saveDimConfig} disabled={saving} style={{
                padding: '8px 16px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                background: '#111827', color: '#fff', border: 'none', cursor: 'pointer',
              }}>
                {saving ? 'Saving…' : 'Save Dimensions'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
