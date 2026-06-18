/* Extracted from OrgAdminView.js — Phase 1 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Panel: OATeamRoster. Rendered by the OrgAdmin shell. */
import React from 'react';

export default function OATeamRoster({ dimensions, teams, members, memberships, rosterDimFilter, setRosterDimFilter, rosterTeamFilter, setRosterTeamFilter, rosterSearch, setRosterSearch, getDimColor }) {

  // Build user → dimension → team mapping
  const userTeamMap = {};
  for (const m of memberships) {
    if (!userTeamMap[m.user_id]) userTeamMap[m.user_id] = {};
    userTeamMap[m.user_id][m.dimension] = { teamId: m.team_id, teamName: m.team_name };
  }

  // Compute assignment coverage stats
  const assignedUserIds = new Set(memberships.map(m => m.user_id));
  const fullyAssigned = members.filter(m => {
    const ut = userTeamMap[m.user_id];
    return ut && dimensions.every(d => ut[d.key]);
  });
  const partiallyAssigned = members.filter(m => {
    const ut = userTeamMap[m.user_id];
    return ut && Object.keys(ut).length > 0 && !dimensions.every(d => ut[d.key]);
  });
  const unassigned = members.filter(m => !assignedUserIds.has(m.user_id));

  // Filter members
  const filteredMembers = members.filter(m => {
    // Search filter
    if (rosterSearch) {
      const q = rosterSearch.toLowerCase();
      const name = `${m.first_name} ${m.last_name}`.toLowerCase();
      const email = (m.email || '').toLowerCase();
      if (!name.includes(q) && !email.includes(q)) return false;
    }

    const ut = userTeamMap[m.user_id] || {};

    // Dimension filter
    if (rosterDimFilter === 'unassigned') {
      return Object.keys(ut).length === 0;
    }
    if (rosterDimFilter === 'partial') {
      return Object.keys(ut).length > 0 && !dimensions.every(d => ut[d.key]);
    }
    if (rosterDimFilter === 'complete') {
      return dimensions.every(d => ut[d.key]);
    }
    if (rosterDimFilter !== 'all') {
      // A specific dimension key — show users who have an assignment in that dimension
      if (!ut[rosterDimFilter]) return false;
    }

    // Team filter (only when a specific dimension is selected)
    if (rosterTeamFilter !== 'all' && rosterDimFilter !== 'all' &&
        rosterDimFilter !== 'unassigned' && rosterDimFilter !== 'partial' && rosterDimFilter !== 'complete') {
      if (ut[rosterDimFilter]?.teamId !== parseInt(rosterTeamFilter)) return false;
    }

    return true;
  });

  // Reset team filter when dimension filter changes
  const handleDimFilterChange = (val) => {
    setRosterDimFilter(val);
    setRosterTeamFilter('all');
  };

  // Teams for the selected dimension filter
  const filteredDimTeams = (rosterDimFilter !== 'all' && rosterDimFilter !== 'unassigned' &&
    rosterDimFilter !== 'partial' && rosterDimFilter !== 'complete')
    ? teams.filter(t => t.dimension === rosterDimFilter)
    : [];

  // CSV export
  const handleExport = () => {
    const header = ['Name', 'Email', ...dimensions.map(d => d.label)];
    const rows = filteredMembers.map(m => {
      const ut = userTeamMap[m.user_id] || {};
      return [
        `${m.first_name} ${m.last_name}`,
        m.email,
        ...dimensions.map(d => ut[d.key]?.teamName || ''),
      ];
    });
    const csv = [header, ...rows].map(r => r.map(c => `"${(c || '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `team-roster-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      {/* Coverage summary cards */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <button onClick={() => handleDimFilterChange('all')} style={{
          flex: '1 1 100px', padding: '12px 16px', borderRadius: 8, border: rosterDimFilter === 'all' ? '2px solid #111827' : '1px solid #e5e7eb',
          background: '#fff', cursor: 'pointer', textAlign: 'left', minWidth: 100,
        }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5 }}>All Users</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#111827' }}>{members.length}</div>
        </button>
        <button onClick={() => handleDimFilterChange('complete')} style={{
          flex: '1 1 100px', padding: '12px 16px', borderRadius: 8, border: rosterDimFilter === 'complete' ? '2px solid #059669' : '1px solid #e5e7eb',
          background: '#fff', cursor: 'pointer', textAlign: 'left', minWidth: 100,
        }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: '#059669', textTransform: 'uppercase', letterSpacing: 0.5 }}>Fully Assigned</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#059669' }}>{fullyAssigned.length}</div>
        </button>
        <button onClick={() => handleDimFilterChange('partial')} style={{
          flex: '1 1 100px', padding: '12px 16px', borderRadius: 8, border: rosterDimFilter === 'partial' ? '2px solid #d97706' : '1px solid #e5e7eb',
          background: '#fff', cursor: 'pointer', textAlign: 'left', minWidth: 100,
        }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: '#d97706', textTransform: 'uppercase', letterSpacing: 0.5 }}>Partially Assigned</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#d97706' }}>{partiallyAssigned.length}</div>
        </button>
        <button onClick={() => handleDimFilterChange('unassigned')} style={{
          flex: '1 1 100px', padding: '12px 16px', borderRadius: 8, border: rosterDimFilter === 'unassigned' ? '2px solid #dc2626' : '1px solid #e5e7eb',
          background: '#fff', cursor: 'pointer', textAlign: 'left', minWidth: 100,
        }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: '#dc2626', textTransform: 'uppercase', letterSpacing: 0.5 }}>Unassigned</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#dc2626' }}>{unassigned.length}</div>
        </button>
      </div>

      {/* Filters row */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="text"
          value={rosterSearch}
          onChange={e => setRosterSearch(e.target.value)}
          placeholder="Search by name or email…"
          style={{ padding: '7px 12px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 12, width: 220 }}
        />
        <select
          value={rosterDimFilter}
          onChange={e => handleDimFilterChange(e.target.value)}
          style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 12 }}
        >
          <option value="all">All dimensions</option>
          <optgroup label="Status">
            <option value="complete">Fully assigned</option>
            <option value="partial">Partially assigned</option>
            <option value="unassigned">Unassigned</option>
          </optgroup>
          <optgroup label="By Dimension">
            {dimensions.map(d => (
              <option key={d.key} value={d.key}>{d.label}</option>
            ))}
          </optgroup>
        </select>
        {filteredDimTeams.length > 0 && (
          <select
            value={rosterTeamFilter}
            onChange={e => setRosterTeamFilter(e.target.value)}
            style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 12 }}
          >
            <option value="all">All teams</option>
            {filteredDimTeams.map(t => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: '#6b7280' }}>{filteredMembers.length} user{filteredMembers.length !== 1 ? 's' : ''}</span>
        <button
          onClick={handleExport}
          style={{
            padding: '6px 12px', borderRadius: 6, fontSize: 11, fontWeight: 500,
            background: '#f3f4f6', border: '1px solid #d1d5db', cursor: 'pointer', color: '#374151',
          }}
        >
          Export CSV
        </button>
      </div>

      {/* Roster table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
              <th style={{ textAlign: 'left', padding: '8px 12px', fontWeight: 600, color: '#374151', minWidth: 180 }}>User</th>
              {dimensions.map(dim => (
                <th key={dim.key} style={{
                  textAlign: 'left', padding: '8px 12px', fontWeight: 600, minWidth: 120,
                  color: getDimColor(dim.key),
                }}>
                  {dim.label}
                </th>
              ))}
              <th style={{ textAlign: 'center', padding: '8px 12px', fontWeight: 600, color: '#374151', width: 80 }}>Coverage</th>
            </tr>
          </thead>
          <tbody>
            {filteredMembers.map(member => {
              const ut = userTeamMap[member.user_id] || {};
              const assignedCount = dimensions.filter(d => ut[d.key]).length;
              const coveragePct = dimensions.length > 0 ? Math.round((assignedCount / dimensions.length) * 100) : 0;
              return (
                <tr key={member.user_id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '8px 12px' }}>
                    <div style={{ fontWeight: 500, color: '#111827' }}>{member.first_name} {member.last_name}</div>
                    <div style={{ fontSize: 10, color: '#9ca3af' }}>{member.email}</div>
                  </td>
                  {dimensions.map(dim => {
                    const assignment = ut[dim.key];
                    return (
                      <td key={dim.key} style={{ padding: '6px 12px' }}>
                        {assignment ? (
                          <span style={{
                            padding: '3px 10px', borderRadius: 4, fontSize: 11, fontWeight: 500,
                            background: getDimColor(dim.key) + '10', color: getDimColor(dim.key),
                            border: `1px solid ${getDimColor(dim.key)}25`,
                          }}>
                            {assignment.teamName}
                          </span>
                        ) : (
                          <span style={{ fontSize: 11, color: '#d1d5db' }}>—</span>
                        )}
                      </td>
                    );
                  })}
                  <td style={{ textAlign: 'center', padding: '6px 12px' }}>
                    <div style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                    }}>
                      <div style={{
                        width: 40, height: 6, borderRadius: 3, background: '#e5e7eb', overflow: 'hidden',
                      }}>
                        <div style={{
                          width: `${coveragePct}%`, height: '100%', borderRadius: 3,
                          background: coveragePct === 100 ? '#059669' : coveragePct > 0 ? '#d97706' : '#dc2626',
                        }} />
                      </div>
                      <span style={{
                        fontSize: 10, fontWeight: 600, minWidth: 26,
                        color: coveragePct === 100 ? '#059669' : coveragePct > 0 ? '#d97706' : '#dc2626',
                      }}>
                        {assignedCount}/{dimensions.length}
                      </span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {filteredMembers.length === 0 && (
        <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
          No users match the current filters.
        </div>
      )}
    </div>
  );
}
