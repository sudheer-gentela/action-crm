import React, { useState, useEffect, useCallback, useRef } from 'react';
import { apiService } from './apiService';
import './NotificationSettings.css';

const HOURS_OPTIONS = [
  { value: 1,   label: '1 hour' },
  { value: 4,   label: '4 hours' },
  { value: 8,   label: '8 hours' },
  { value: 12,  label: '12 hours' },
  { value: 24,  label: '24 hours (1 day)' },
  { value: 48,  label: '48 hours (2 days)' },
  { value: 72,  label: '72 hours (3 days)' },
  { value: 168, label: '1 week' },
];

const FALLBACK_MODES = [
  { value: 'reporting_manager', label: 'Reporting manager', description: 'Notify your direct manager in the org hierarchy' },
  { value: 'specific_users',   label: 'Specific people',   description: 'Always notify a fixed list of people you choose' },
  { value: 'none',             label: 'Just me',           description: 'No notification to others — only you are notified' },
];

const STAGE_LABELS = {
  discovery: 'Discovery', qualification: 'Qualification',
  proposal: 'Proposal', negotiation: 'Negotiation',
};

const DIMENSION_ICONS = {
  sales: '💼', prospecting: '🎯', implementation: '⚙️',
  support: '🛠️', customer_success: '🤝',
};

// ── Helper functions ──────────────────────────────────────────────────────────
function initials(name) {
  const parts = (name || '').split(' ').filter(Boolean);
  return parts.length >= 2
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : (parts[0]?.[0] || '?').toUpperCase();
}
function avatarGradient(name) {
  const colors = [
    'linear-gradient(135deg,#1e40af,#3b82f6)', 'linear-gradient(135deg,#065f46,#10b981)',
    'linear-gradient(135deg,#6b21a8,#a78bfa)', 'linear-gradient(135deg,#92400e,#f59e0b)',
    'linear-gradient(135deg,#7f1d1d,#f87171)', 'linear-gradient(135deg,#3730a3,#818cf8)',
  ];
  return colors[(name?.charCodeAt(0) || 0) % colors.length];
}

// ── Toggle ────────────────────────────────────────────────────────────────────
function Toggle({ checked, onChange }) {
  return (
    <label className="ns-toggle">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span className="ns-toggle-track" />
    </label>
  );
}

// ── TeamsModal ────────────────────────────────────────────────────────────────
function TeamsModal({ orgTeams, dealTeams, onClose }) {
  const overlayRef = useRef(null);
  const hasOrg   = orgTeams.length > 0;
  const hasDeals = dealTeams.length > 0;
  const [tab, setTab] = useState(hasOrg ? 'org' : 'deals');

  useEffect(() => {
    const handler = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleOverlayClick = e => { if (e.target === overlayRef.current) onClose(); };

  return (
    <div className="ns-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="ns-modal">

        <div className="ns-modal-header">
          <span className="ns-modal-title">My Teams</span>
          <button className="ns-modal-close" onClick={onClose}>✕</button>
        </div>

        {!hasOrg && !hasDeals ? (
          <div className="ns-modal-empty">
            <div style={{ fontSize: 36 }}>👥</div>
            <p>You are not a member of any teams yet.</p>
            <p className="ns-modal-empty-hint">Ask your org admin to add you to a team.</p>
          </div>
        ) : (
          <>
            {hasOrg && hasDeals && (
              <div className="ns-modal-tabs">
                <button className={`ns-modal-tab ${tab === 'org'   ? 'active' : ''}`} onClick={() => setTab('org')}>
                  Org teams <span className="ns-tab-pill">{orgTeams.length}</span>
                </button>
                <button className={`ns-modal-tab ${tab === 'deals' ? 'active' : ''}`} onClick={() => setTab('deals')}>
                  Deal teams <span className="ns-tab-pill">{dealTeams.length}</span>
                </button>
              </div>
            )}

            <div className="ns-modal-body">

              {/* Org teams */}
              {(tab === 'org' || !hasDeals) && orgTeams.map(team => (
                <div key={team.id} className="ns-team-card">
                  <div className="ns-team-card-row">
                    <span className="ns-team-icon">{DIMENSION_ICONS[team.dimension] || '👥'}</span>
                    <div className="ns-team-card-info">
                      <div className="ns-team-name">
                        {team.name}
                        {team.isPrimary && <span className="ns-badge ns-badge--amber">Primary</span>}
                      </div>
                      {team.dimension && <div className="ns-team-dim">{team.dimension}</div>}
                    </div>
                    <span className="ns-role-pill">{team.myRole}</span>
                  </div>
                  {team.description && <div className="ns-team-desc">{team.description}</div>}
                  <div className="ns-team-foot">👥 {team.memberCount} member{team.memberCount !== 1 ? 's' : ''}</div>
                </div>
              ))}

              {/* Deal teams */}
              {(tab === 'deals' || !hasOrg) && dealTeams.map(deal => (
                <div key={deal.dealId} className="ns-team-card">
                  <div className="ns-team-card-row">
                    <span className="ns-team-icon">💼</span>
                    <div className="ns-team-card-info">
                      <div className="ns-team-name">{deal.dealName}</div>
                      <div className="ns-team-dim">
                        {deal.accountName && `${deal.accountName} · `}
                        {STAGE_LABELS[deal.stage] || deal.stage}
                      </div>
                    </div>
                    <span className="ns-role-pill">{deal.myRole}</span>
                  </div>

                  {deal.members.length > 0 && (
                    <div className="ns-member-list">
                      {deal.members.map((m, i) => (
                        <div key={i} className={`ns-member-row ${m.is_me ? 'ns-member-row--me' : ''}`}>
                          <div className="ns-member-avatar" style={{ background: avatarGradient(m.name) }}>
                            {initials(m.name)}
                          </div>
                          <div className="ns-member-text">
                            <span className="ns-member-name">
                              {m.name}
                              {m.is_me && <span className="ns-you">you</span>}
                            </span>
                            <span className="ns-member-role">{m.role}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}

            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function NotificationSettings() {
  const [prefs,        setPrefs]        = useState(null);
  const [members,      setMembers]      = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [saving,       setSaving]       = useState(false);
  const [saved,        setSaved]        = useState(false);
  const [error,        setError]        = useState('');
  // Teams popup
  const [teamsData,    setTeamsData]    = useState(null);   // cached after first load
  const [teamsOpen,    setTeamsOpen]    = useState(false);
  const [teamsLoading, setTeamsLoading] = useState(false);

  // Load prefs + member list
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [prefsRes, membersRes] = await Promise.all([
        apiService.teamNotifications.getPreferences(),
        apiService.teamNotifications.getOrgMembers(),
      ]);
      setPrefs(prefsRes.data.preferences);
      setMembers(membersRes.data.members || []);
    } catch (err) {
      setError('Failed to load notification settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Lazy-load teams (cache after first fetch)
  const openTeamsModal = useCallback(async () => {
    if (teamsData) { setTeamsOpen(true); return; }
    setTeamsLoading(true);
    try {
      const res = await apiService.teamNotifications.getMyTeams();
      setTeamsData(res.data);
      setTeamsOpen(true);
    } catch (err) {
      console.error('Failed to load teams:', err);
    } finally {
      setTeamsLoading(false);
    }
  }, [teamsData]);

  const handleSave = async () => {
    setSaving(true); setSaved(false); setError('');
    try {
      const res = await apiService.teamNotifications.updatePreferences(prefs);
      setPrefs(res.data.preferences);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch { setError('Failed to save preferences'); }
    finally { setSaving(false); }
  };

  const set = (key, val) => setPrefs(p => ({ ...p, [key]: val }));

  const toggleSpecificUser = userId => setPrefs(prev => {
    const ids  = prev.specific_user_ids || [];
    const next = ids.includes(userId) ? ids.filter(id => id !== userId) : [...ids, userId];
    return { ...prev, specific_user_ids: next };
  });

  if (loading) return (
    <div className="ns-loading"><div className="ns-spinner" /><span>Loading…</span></div>
  );
  if (!prefs) return <div className="ns-error">{error || 'Failed to load settings'}</div>;

  const anyAlert = prefs.immediate_alert || prefs.daily_digest;

  return (
    <div className="ns-panel">

      {/* Header */}
      <div className="ns-header">
        <div className="ns-header-icon">🔔</div>
        <div>
          <h3 className="ns-title">Team Notifications</h3>
          <p className="ns-subtitle">Stay in sync. When actions are overdue, the right people are notified automatically.</p>
        </div>
      </div>

      {error && <div className="ns-error-banner">{error}</div>}

      {/* ── When to notify ───────────────────────────────────────────────── */}
      <div className="ns-section-label">When to notify</div>

      <div className="ns-card">
        <div className="ns-toggle-row">
          <div>
            <div className="ns-card-title">Immediate alert</div>
            <div className="ns-card-desc">Notify once when an action has been overdue for a set amount of time.</div>
          </div>
          <Toggle checked={prefs.immediate_alert} onChange={v => set('immediate_alert', v)} />
        </div>
        {prefs.immediate_alert && (
          <div className="ns-sub-field">
            <span className="ns-sub-label">Alert after:</span>
            <select className="ns-select" value={prefs.immediate_hours} onChange={e => set('immediate_hours', parseInt(e.target.value))}>
              {HOURS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        )}
      </div>

      <div className="ns-card">
        <div className="ns-toggle-row">
          <div>
            <div className="ns-card-title">Daily digest</div>
            <div className="ns-card-desc">A daily summary of all overdue actions, sent at 9:00 AM UTC.</div>
          </div>
          <Toggle checked={prefs.daily_digest} onChange={v => set('daily_digest', v)} />
        </div>
      </div>

      {/* ── Who gets notified (only when an alert is on) ──────────────────── */}
      {anyAlert && (<>
        <div className="ns-section-label" style={{ marginTop: 24 }}>Who gets notified</div>

        {/* Deal team */}
        <div className="ns-card">
          <div className="ns-toggle-row">
            <div>
              <div className="ns-card-title">Deal team <span className="ns-tag ns-tag--blue">Deal actions</span></div>
              <div className="ns-card-desc">When an action is tied to a deal, notify everyone on that deal's team. If the deal has no team yet, the fallback below applies.</div>
            </div>
            <Toggle checked={prefs.notify_deal_team} onChange={v => set('notify_deal_team', v)} />
          </div>
          <button className="ns-view-link" onClick={openTeamsModal} disabled={teamsLoading}>
            {teamsLoading ? '⏳ Loading…' : '↗ View deals I am on'}
          </button>
        </div>

        {/* My teams */}
        <div className="ns-card">
          <div className="ns-toggle-row">
            <div>
              <div className="ns-card-title">My teams <span className="ns-tag ns-tag--purple">All actions</span></div>
              <div className="ns-card-desc">Notify all members of every team you belong to — prospecting, implementation, support, or any other team in your org.</div>
            </div>
            <Toggle checked={prefs.notify_my_teams} onChange={v => set('notify_my_teams', v)} />
          </div>
          {prefs.notify_my_teams && (
            <div className="ns-info-row">ℹ️ All active members of each team you belong to will be notified.</div>
          )}
          <button className="ns-view-link" onClick={openTeamsModal} disabled={teamsLoading}>
            {teamsLoading ? '⏳ Loading…' : '↗ View my org teams'}
          </button>
        </div>

        {/* Fallback */}
        <div className="ns-card">
          <div className="ns-card-title" style={{ marginBottom: 4 }}>
            Fallback <span className="ns-tag ns-tag--grey">When no deal or teams apply</span>
          </div>
          <div className="ns-card-desc" style={{ marginBottom: 14 }}>Used when an action has no deal, or both toggles above are off.</div>

          <div className="ns-radio-group">
            {FALLBACK_MODES.map(mode => (
              <label key={mode.value} className="ns-radio-item">
                <input type="radio" name="fallback_mode" value={mode.value}
                  checked={prefs.fallback_mode === mode.value}
                  onChange={() => set('fallback_mode', mode.value)} />
                <div className="ns-radio-content">
                  <span className="ns-radio-label">{mode.label}</span>
                  <span className="ns-radio-desc">{mode.description}</span>
                </div>
              </label>
            ))}
          </div>

          {prefs.fallback_mode === 'specific_users' && (
            <div className="ns-specific-users">
              <div className="ns-specific-label">Select people to notify:</div>
              {members.length === 0
                ? <div className="ns-no-members">No other members in your org.</div>
                : (
                  <div className="ns-members-list">
                    {members.map(m => {
                      const selected = (prefs.specific_user_ids || []).includes(m.id);
                      return (
                        <label key={m.id} className={`ns-member-item ${selected ? 'ns-member-item--on' : ''}`}>
                          <input type="checkbox" checked={selected} onChange={() => toggleSpecificUser(m.id)} />
                          <div className="ns-avatar" style={{ background: avatarGradient(m.name) }}>{initials(m.name)}</div>
                          <div className="ns-member-info">
                            <span className="ns-member-name">{m.name}</span>
                            <span className="ns-member-email">{m.email}</span>
                          </div>
                          {selected && <span className="ns-check">✓</span>}
                        </label>
                      );
                    })}
                  </div>
                )
              }
            </div>
          )}
        </div>
      </>)}

      {/* Save */}
      <div className="ns-footer">
        <button className="ns-save-btn" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save preferences'}
        </button>
        {saved && <span className="ns-saved-msg">Preferences saved</span>}
      </div>

      {/* Teams popup */}
      {teamsOpen && teamsData && (
        <TeamsModal
          orgTeams={teamsData.orgTeams}
          dealTeams={teamsData.dealTeams}
          onClose={() => setTeamsOpen(false)}
        />
      )}

    </div>
  );
}
