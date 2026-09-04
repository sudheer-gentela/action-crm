import React, { useState, useEffect, useCallback, useRef } from 'react';
import { apiService, slackAPI } from './apiService';
import './NotificationSettings.css';
import PushNotificationToggle from './PushNotificationToggle';

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
  const [slackConnected, setSlackConnected] = useState(false);
  const [slackTest, setSlackTest] = useState({ status: 'idle', message: '' });
  const [slackEmail, setSlackEmail] = useState('');
  const [slackEmailSaved, setSlackEmailSaved] = useState(false);
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
      setSlackEmail(prefsRes.data.slack_email || '');
      // Non-fatal: whether the org has Slack connected (gates the Slack section)
      slackAPI.getStatus()
        .then(r => setSlackConnected(!!r?.data?.connected))
        .catch(() => setSlackConnected(false));
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
    setError('');
    try {
      const res = await apiService.teamNotifications.getMyTeams();
      setTeamsData(res.data);
      setTeamsOpen(true);
    } catch (err) {
      // Previously this only wrote to the console, so the button silently did
      // nothing and the missing apiService binding went unnoticed. Surface it.
      console.error('Failed to load teams:', err);
      setError(err?.response?.data?.error?.message || 'Could not load your teams.');
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

  // Nested setters for the channels prefs (master switch + per-category map).
  const setSlackEnabled = (val) => setPrefs(p => ({
    ...p,
    channels: { ...(p.channels || {}), slack_enabled: val },
  }));
  // Email channel setters. Same setPrefs shape as the Slack pair above, so they
  // share the existing save/dirty handling untouched.
  const setEmailEnabled = (val) => setPrefs(p => ({
    ...p,
    channels: { ...(p.channels || {}), email_enabled: val },
  }));
  const setEmailCategory = (cat, val) => setPrefs(p => ({
    ...p,
    channels: {
      ...(p.channels || {}),
      email_categories: { ...((p.channels || {}).email_categories || {}), [cat]: val },
    },
  }));
  const setReviewEmailMode = (val) => setPrefs(p => ({
    ...p,
    channels: { ...(p.channels || {}), review_email_mode: val },
  }));
  // 2026_138. WHICH review events reach email, as opposed to how they are
  // paced. Separate from setReviewEmailMode because the two questions are
  // independent — someone can want completions only, hourly.
  const setReviewEmailScope = (val) => setPrefs(p => ({
    ...p,
    channels: { ...(p.channels || {}), review_email_scope: val },
  }));

  const setSlackCategory = (cat, val) => setPrefs(p => ({
    ...p,
    channels: {
      ...(p.channels || {}),
      slack_categories: { ...((p.channels || {}).slack_categories || {}), [cat]: val },
    },
  }));

  const saveSlackEmail = async () => {
    try {
      await apiService.teamNotifications.setSlackEmail(slackEmail.trim());
      setSlackEmailSaved(true);
      setSlackTest({ status: 'idle', message: '' }); // clear any prior test result
      setTimeout(() => setSlackEmailSaved(false), 2500);
    } catch (e) {
      setSlackTest({ status: 'err', message: e?.response?.data?.error || 'Could not save Slack email.' });
    }
  };

  // Send a one-off test DM and translate the delivery result into a message.
  const handleSlackTest = async () => {
    setSlackTest({ status: 'sending', message: '' });
    try {
      const res = await apiService.teamNotifications.testSlack();
      const r = res.data?.result || {};
      if (r.delivered >= 1) {
        setSlackTest({ status: 'ok', message: '✅ Sent — check your GoWarmCRM DMs in Slack.' });
      } else if (r.reason === 'not_connected') {
        setSlackTest({ status: 'err', message: 'Slack isn’t connected for your org yet. An admin connects it under Org Admin → Integrations → Slack Notifications.' });
      } else if (r.reason === 'no_targets') {
        setSlackTest({ status: 'err', message: 'Couldn’t find you on Slack. Your GoWarmCRM email likely differs from your Slack email — they must match.' });
      } else if (r.results?.[0]?.error) {
        setSlackTest({ status: 'err', message: `Slack error: ${r.results[0].error}` });
      } else {
        setSlackTest({ status: 'err', message: `Not delivered${r.reason ? ` (${r.reason})` : ''}.` });
      }
    } catch (e) {
      setSlackTest({ status: 'err', message: e?.response?.data?.error || 'Test failed.' });
    }
  };

  const toggleSpecificUser = userId => setPrefs(prev => {
    const ids  = prev.specific_user_ids || [];
    const next = ids.includes(userId) ? ids.filter(id => id !== userId) : [...ids, userId];
    return { ...prev, specific_user_ids: next };
  });

  if (loading) return (
    <div className="ns-loading"><div className="ns-spinner" /><span>Loading…</span></div>
  );
  if (!prefs) return <div className="ns-error">{error || 'Failed to load settings'}</div>;

  const anyAlert = prefs.immediate_alert || prefs.daily_digest
                || prefs.prospecting_immediate_alert !== false
                || prefs.prospecting_daily_digest    !== false;

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

      {/* ── Prospecting actions: separate toggles ───────────────────────────
          Prospecting has its own alert + digest cadence so reps can quiet
          one without affecting the other. The org-level policy (timezone,
          escalation tiers) is managed under Org Admin. */}
      <div className="ns-section-label" style={{ marginTop: 24 }}>Prospecting actions</div>

      <div className="ns-card">
        <div className="ns-toggle-row">
          <div>
            <div className="ns-card-title">Prospecting immediate alert</div>
            <div className="ns-card-desc">Notify when a prospecting action (sequence step, follow-up, call task) is overdue. Uses the org's threshold.</div>
          </div>
          <Toggle
            checked={prefs.prospecting_immediate_alert !== false}
            onChange={v => set('prospecting_immediate_alert', v)}
          />
        </div>
      </div>

      <div className="ns-card">
        <div className="ns-toggle-row">
          <div>
            <div className="ns-card-title">Prospecting daily digest</div>
            <div className="ns-card-desc">A daily summary of your overdue prospecting actions. Time of day is set by your org (default 8:30 AM IST).</div>
          </div>
          <Toggle
            checked={prefs.prospecting_daily_digest !== false}
            onChange={v => set('prospecting_daily_digest', v)}
          />
        </div>
      </div>

      {/* ── Slack delivery (only when the org has Slack connected) ────────── */}
      {/* ── Email delivery ────────────────────────────────────────────────
          Mirrors the Slack section below: master switch off by default, then
          per-category routing once it is turned on.

          OFF by default, deliberately. In-app is the only channel enabled for
          everyone — email is the one channel that reaches someone who is not
          in the app, so it is opted into rather than out of. A product that
          mails every user every notification by default teaches them to filter
          it, and then the one alert that mattered gets filtered too.

          Not gated on a connection the way Slack is: email needs no setup on
          the user's side. */}
      {(() => {
        const ch   = prefs.channels || {};
        const on   = ch.email_enabled === true;      // === true, not !== false:
        const cat  = ch.email_categories || {};      // an older prefs row has no
        const mode = ch.review_email_mode || 'immediate';   // key, and that is off
        // 2026_138. Defaults to 'completions' to match the server default in
        // notificationService.DEFAULT_PREFS. Both sides must agree or the
        // screen shows one thing and the mailer does another.
        const scope = ch.review_email_scope || 'completions';
        const CATEGORIES = [
          ['digest',     'Daily overdue summary', 'One email a day listing what is overdue.'],
          ['review',     'Task reviews',          'Sent for review, approved, or sent back.'],
          // Listed directly under reviews because that is where someone will
          // look for it, and worded to say what it is FOR rather than what
          // triggers it — "a task you can start" is the thing the reader cares
          // about; "a prerequisite reached a terminal status" is not.
          ['unblocked',  'Ready to start',        'When a task of yours stops being blocked.'],
          ['immediate',  'Immediate alerts',      'Time-sensitive updates as they happen.'],
          ['escalation', 'Escalations',           'When something has been ignored too long.'],
          ['revisit',    'Revisit reminders',     'When a prospect or account is due a look.'],
        ];
        return (
          <>
            <div className="ns-section-label" style={{ marginTop: 24 }}>Email</div>
            <div className="ns-card">
              <div className="ns-toggle-row">
                <div>
                  <div className="ns-card-title">Send notifications by email</div>
                  <div className="ns-card-desc">
                    Off unless you turn it on. Everything still appears in the in-app
                    bell either way — this only adds email on top.
                  </div>
                </div>
                <Toggle checked={on} onChange={setEmailEnabled} />
              </div>

              {on && (
                <div className="ns-subsettings">
                  <div className="ns-card-desc" style={{ marginBottom: 8 }}>What to email</div>
                  {CATEGORIES.map(([key, label, desc]) => (
                    <label key={key} style={{
                      display: 'flex', alignItems: 'flex-start', gap: 10,
                      padding: '6px 0', cursor: 'pointer',
                    }}>
                      <input
                        type="checkbox"
                        checked={cat[key] !== false}
                        onChange={e => setEmailCategory(key, e.target.checked)}
                        style={{ marginTop: 3 }}
                      />
                      <span>
                        <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>{label}</span>
                        <span style={{ display: 'block', fontSize: 11.5, color: '#6b7280' }}>{desc}</span>
                      </span>
                    </label>
                  ))}

                  {cat.review !== false && (
                    <>
                      {/* 2026_138. WHICH events, then HOW OFTEN — in that
                          order, because the first narrows what the second is
                          pacing. Two separate pickers rather than one list of
                          four combinations: the questions are independent, and
                          a four-way control would have to name combinations
                          nobody thinks in ("all, hourly"). */}
                      <div className="ns-card-desc" style={{ margin: '14px 0 8px' }}>
                        Which review emails
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {[
                          ['completions', 'Only when a task finishes',
                           'Approved, skipped or cancelled. Not submissions or rework.'],
                          ['all',         'Everything in the review loop',
                           'Also sent-for-review and sent-back. A lot on a large plan.'],
                        ].map(([key, label, desc]) => (
                          <button
                            key={key}
                            type="button"
                            onClick={() => setReviewEmailScope(key)}
                            title={desc}
                            style={{
                              flex: '1 1 200px', textAlign: 'left', padding: '10px 12px',
                              borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
                              border: `1px solid ${scope === key ? '#0369a1' : '#d1d5db'}`,
                              background: scope === key ? '#e0f2fe' : '#fff',
                            }}>
                            <div style={{ fontSize: 13, fontWeight: 600,
                                          color: scope === key ? '#0369a1' : '#374151' }}>{label}</div>
                            <div style={{ fontSize: 11.5, color: '#6b7280', marginTop: 2 }}>{desc}</div>
                          </button>
                        ))}
                      </div>

                      <div className="ns-card-desc" style={{ margin: '14px 0 8px' }}>
                        How often for task reviews
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {[
                          ['immediate', 'As they happen', 'One email per event. Nothing waits.'],
                          ['digest',    'Hourly summary', 'One email an hour, only if something happened.'],
                        ].map(([key, label, desc]) => (
                          <button
                            key={key}
                            type="button"
                            onClick={() => setReviewEmailMode(key)}
                            title={desc}
                            style={{
                              flex: '1 1 200px', textAlign: 'left', padding: '10px 12px',
                              borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
                              border: `1px solid ${mode === key ? '#0369a1' : '#d1d5db'}`,
                              background: mode === key ? '#e0f2fe' : '#fff',
                            }}>
                            <div style={{ fontSize: 13, fontWeight: 600,
                                          color: mode === key ? '#0369a1' : '#374151' }}>{label}</div>
                            <div style={{ fontSize: 11.5, color: '#6b7280', marginTop: 2 }}>{desc}</div>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </>
        );
      })()}

      {slackConnected && (() => {
        const ch  = prefs.channels || {};
        const cat = ch.slack_categories || {};
        return (
          <>
            <div className="ns-section-label" style={{ marginTop: 24 }}>Slack</div>
            <div className="ns-card">
              <div className="ns-toggle-row">
                <div>
                  <div className="ns-card-title">Send notifications to Slack</div>
                  <div className="ns-card-desc">Get your notifications as Slack direct messages, in addition to the in-app bell. Pick which kinds below.</div>
                </div>
                <Toggle checked={!!ch.slack_enabled} onChange={setSlackEnabled} />
              </div>

              {ch.slack_enabled && (
                <div className="ns-subsettings">
                  <div className="ns-toggle-row">
                    <div className="ns-card-desc">Overdue action alerts</div>
                    <Toggle checked={cat.immediate !== false} onChange={v => setSlackCategory('immediate', v)} />
                  </div>
                  <div className="ns-toggle-row">
                    <div className="ns-card-desc">Escalations (to managers / skip-level)</div>
                    <Toggle checked={cat.escalation !== false} onChange={v => setSlackCategory('escalation', v)} />
                  </div>
                  <div className="ns-toggle-row">
                    <div className="ns-card-desc">Revisit reminders</div>
                    <Toggle checked={cat.revisit !== false} onChange={v => setSlackCategory('revisit', v)} />
                  </div>
                  {/* 2026_138. These two rows are NEW, and the first is a
                      correction rather than an addition.

                      There was no 'review' key in slack_categories and
                      deliverSlack reads an absent key as allowed — so review
                      alerts have been arriving as Slack DMs for everyone with
                      Slack connected, with nothing on this screen to turn them
                      off. Anyone who wanted them stopped had to disable Slack
                      entirely.

                      Both use `!!cat.x` rather than the `!== false` the rows
                      above use, because both now have explicit defaults in
                      DEFAULT_PREFS and the stored value is the answer. The
                      `!== false` idiom means "on unless told otherwise", which
                      is the thing that made review inescapable. */}
                  <div className="ns-toggle-row">
                    <div className="ns-card-desc">Task reviews</div>
                    <Toggle checked={!!cat.review} onChange={v => setSlackCategory('review', v)} />
                  </div>
                  <div className="ns-toggle-row">
                    <div className="ns-card-desc">Ready to start (a task of yours is unblocked)</div>
                    <Toggle checked={cat.unblocked !== false} onChange={v => setSlackCategory('unblocked', v)} />
                  </div>
                  <div className="ns-toggle-row">
                    <div className="ns-card-desc">Daily digests</div>
                    <Toggle checked={!!cat.digest} onChange={v => setSlackCategory('digest', v)} />
                  </div>

                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #f3f4f6' }}>
                    <div className="ns-card-desc" style={{ marginBottom: 6 }}>
                      Slack email <span style={{ color: '#9ca3af' }}>— set this if your Slack email differs from your login email</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <input
                        type="email"
                        value={slackEmail}
                        onChange={e => setSlackEmail(e.target.value)}
                        placeholder="you@yourcompany.com"
                        style={{ flex: '1 1 240px', minWidth: 200, padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14 }}
                      />
                      <button className="ns-view-link" onClick={saveSlackEmail}>Save email</button>
                      {slackEmailSaved && <span style={{ fontSize: 13, color: '#059669' }}>Saved ✓</span>}
                    </div>
                  </div>

                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: 12 }}>
                    <button
                      className="ns-view-link"
                      onClick={handleSlackTest}
                      disabled={slackTest.status === 'sending'}
                    >
                      {slackTest.status === 'sending' ? '⏳ Sending…' : '📨 Send test message'}
                    </button>
                    {slackTest.message && (
                      <span style={{ fontSize: 13, color: slackTest.status === 'ok' ? '#059669' : '#b91c1c' }}>
                        {slackTest.message}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </>
        );
      })()}

      {/* On-device push. Independent of the alert toggles above: those
          decide WHEN GoWarm notifies you, this decides whether it also
          reaches your phone's lock screen. */}
      <div className="ns-section-label" style={{ marginTop: 24 }}>On this device</div>
      <PushNotificationToggle />

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
