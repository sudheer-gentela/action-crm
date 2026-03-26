import { apiService } from './apiService';
// ============================================================
// ActionCRM Playbook Builder — C9: AccessManagement
// File: frontend/src/AccessManagement.js
// Used inside PlaybookDetail's Routing & Roles tab (admin only).
// ============================================================

import React, { useState, useEffect, useCallback } from 'react';
import './AccessManagement.css';

export default function AccessManagement({ playbook_id, isAdmin }) {
  const [teams, setTeams] = useState([]);
  const [overrides, setOverrides] = useState([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);

  // Add-team form
  const [newTeamId, setNewTeamId] = useState('');
  const [newTeamLevel, setNewTeamLevel] = useState('reader');

  // Add-override form
  const [newOverrideUserId, setNewOverrideUserId] = useState('');
  const [newOverrideLevel, setNewOverrideLevel] = useState('reader');
  const [newOverrideReason, setNewOverrideReason] = useState('');
  const [newOverrideExpiry, setNewOverrideExpiry] = useState('');

  // Memoised so useEffect dependency is stable
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tRes, oRes] = await Promise.all([
        apiService.playbookBuilder.getTeamGrants(playbook_id),
        apiService.playbookBuilder.getUserOverrides(playbook_id),
      ]);
      setTeams(tRes.teams || []);
      setOverrides(oRes.overrides || []);
    } catch (err) {
      console.error('Failed to load access data', err);
    } finally {
      setLoading(false);
    }
  }, [playbook_id]);

  useEffect(() => {
    load();
  }, [load]);

  const handleAddTeam = async () => {
    if (!newTeamId) return;
    setWorking(true);
    try {
      await apiService.playbookBuilder.addTeamGrant(playbook_id, {
        team_id: parseInt(newTeamId, 10),
        access_level: newTeamLevel,
      });
      setNewTeamId('');
      await load();
    } catch (err) {
      alert(err.message);
    } finally {
      setWorking(false);
    }
  };

  const handleRemoveTeam = async (team_id) => {
    if (!window.confirm('Remove this team grant?')) return;
    setWorking(true);
    try {
      await apiService.playbookBuilder.removeTeamGrant(playbook_id, team_id);
      await load();
    } catch (err) {
      alert(err.message);
    } finally {
      setWorking(false);
    }
  };

  const handleAddOverride = async () => {
    if (!newOverrideUserId) return;
    setWorking(true);
    try {
      await apiService.playbookBuilder.setUserOverride(playbook_id, {
        user_id: parseInt(newOverrideUserId, 10),
        access_level: newOverrideLevel,
        reason: newOverrideReason || null,
        expires_at: newOverrideExpiry || null,
      });
      setNewOverrideUserId('');
      setNewOverrideReason('');
      setNewOverrideExpiry('');
      await load();
    } catch (err) {
      alert(err.message);
    } finally {
      setWorking(false);
    }
  };

  const handleRemoveOverride = async (user_id) => {
    if (!window.confirm('Remove this user override?')) return;
    setWorking(true);
    try {
      await apiService.playbookBuilder.removeUserOverride(playbook_id, user_id);
      await load();
    } catch (err) {
      alert(err.message);
    } finally {
      setWorking(false);
    }
  };

  // Only org admins see this component; guard here as a safety net
  if (!isAdmin) return null;

  if (loading) return <div className="pb-loading">Loading access…</div>;

  return (
    <div className="access-management">
      <h4>Access Management</h4>
      <p className="access-hint">
        Resolution order: <strong>User override</strong> →{' '}
        <strong>Team grant</strong> → <strong>Org default</strong>. A{' '}
        <em>none</em> override explicitly blocks access regardless of team
        grants.
      </p>

      {/* ── Team grants ── */}
      <section className="access-section">
        <h5>Team Grants</h5>
        <table className="access-table">
          <thead>
            <tr>
              <th>Team</th>
              <th>Access</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {teams.length === 0 ? (
              <tr>
                <td colSpan={3} className="table-empty">
                  No team grants yet.
                </td>
              </tr>
            ) : (
              teams.map((t) => (
                <tr key={t.team_id}>
                  <td>{t.team_name}</td>
                  <td>
                    <span
                      className={`pb-badge ${
                        t.access_level === 'owner'
                          ? 'badge-owner'
                          : 'badge-reader'
                      }`}
                    >
                      {t.access_level}
                    </span>
                  </td>
                  <td>
                    <button
                      className="btn-icon btn-icon--danger"
                      onClick={() => handleRemoveTeam(t.team_id)}
                      disabled={working}
                      title="Remove grant"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        <div className="access-add-row">
          <input
            type="number"
            placeholder="Team ID"
            value={newTeamId}
            onChange={(e) => setNewTeamId(e.target.value)}
            min="1"
          />
          <select
            value={newTeamLevel}
            onChange={(e) => setNewTeamLevel(e.target.value)}
          >
            <option value="reader">reader</option>
            <option value="owner">owner</option>
          </select>
          <button
            className="btn-secondary btn-sm"
            onClick={handleAddTeam}
            disabled={working || !newTeamId}
          >
            Add Team
          </button>
        </div>
      </section>

      {/* ── User overrides ── */}
      <section className="access-section">
        <h5>User Overrides</h5>
        <table className="access-table">
          <thead>
            <tr>
              <th>User</th>
              <th>Access</th>
              <th>Reason</th>
              <th>Expires</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {overrides.length === 0 ? (
              <tr>
                <td colSpan={5} className="table-empty">
                  No user overrides yet.
                </td>
              </tr>
            ) : (
              overrides.map((o) => (
                <tr key={o.user_id}>
                  <td>
                    {o.user_name}{' '}
                    <span className="user-email">({o.user_email})</span>
                  </td>
                  <td>
                    <span
                      className={`pb-badge ${
                        o.access_level === 'owner'
                          ? 'badge-owner'
                          : o.access_level === 'none'
                          ? 'badge-blocked'
                          : 'badge-reader'
                      }`}
                    >
                      {o.access_level}
                    </span>
                  </td>
                  <td>{o.reason || '—'}</td>
                  <td>
                    {o.expires_at
                      ? new Date(o.expires_at).toLocaleDateString()
                      : 'Never'}
                  </td>
                  <td>
                    <button
                      className="btn-icon btn-icon--danger"
                      onClick={() => handleRemoveOverride(o.user_id)}
                      disabled={working}
                      title="Remove override"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        <div className="access-add-row">
          <input
            type="number"
            placeholder="User ID"
            value={newOverrideUserId}
            onChange={(e) => setNewOverrideUserId(e.target.value)}
            min="1"
          />
          <select
            value={newOverrideLevel}
            onChange={(e) => setNewOverrideLevel(e.target.value)}
          >
            <option value="reader">reader</option>
            <option value="owner">owner</option>
            <option value="none">none (block)</option>
          </select>
          <input
            type="text"
            placeholder="Reason (optional)"
            value={newOverrideReason}
            onChange={(e) => setNewOverrideReason(e.target.value)}
          />
          <input
            type="date"
            value={newOverrideExpiry}
            onChange={(e) => setNewOverrideExpiry(e.target.value)}
            title="Expiry date (optional)"
          />
          <button
            className="btn-secondary btn-sm"
            onClick={handleAddOverride}
            disabled={working || !newOverrideUserId}
          >
            Add Override
          </button>
        </div>
      </section>
    </div>
  );
}
