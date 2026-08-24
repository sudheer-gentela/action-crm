/* Panel: OAProjectAccess — Org Admin → Projects → Access.
 *
 * Controls who can see which projects in the Projects module, and whether
 * restricted tabs follow the reporting line. Backed by
 * organizations.settings->'project_access'.
 *
 * Only an org owner or admin can save; the endpoint enforces that too. */

import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from '../../apiService';

const NAVY = '#1A3A5C';

function Row({ title, desc, children }) {
  return (
    <div className="gw-wrap-mobile" style={{
      display: 'flex', alignItems: 'flex-start', gap: 16,
      padding: '16px 0', borderBottom: '1px solid #f1f5f9',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#1a202c', marginBottom: 3 }}>{title}</div>
        <div style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.55 }}>{desc}</div>
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  );
}

function Switch({ on, onChange, disabled }) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!on)}
      disabled={disabled}
      style={{
        minHeight: 44, minWidth: 92, padding: '9px 16px', borderRadius: 8,
        border: `1px solid ${on ? '#0369a1' : '#d1d5db'}`,
        background: on ? '#0369a1' : '#fff',
        color: on ? '#fff' : '#4b5563',
        fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1,
      }}
    >
      {on ? 'Enabled' : 'Disabled'}
    </button>
  );
}

export default function OAProjectAccess() {
  const [cfg, setCfg]         = useState(null);
  const [viewer, setViewer]   = useState(null);
  const [saving, setSaving]   = useState(false);
  const [msg, setMsg]         = useState('');
  const [err, setErr]         = useState('');
  const [domainsOk, setDomainsOk] = useState(null);   // null = still loading
  const [orgUsers, setOrgUsers]   = useState([]);     // 2026_130 watcher picker

  const load = useCallback(() => {
    apiService.handovers.projectAccess()
      .then(r => { setCfg(r.data?.settings || null); setViewer(r.data?.viewer || null); })
      .catch(e => setErr(e?.response?.data?.error?.message || 'Could not load settings'));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Nothing populates org_email_domains automatically. With it empty, every
  // project-member add lands in 'pending' and needs an org admin to clear —
  // which reads as the feature being broken rather than as a missing
  // prerequisite. Surface it here, where an admin can act on it.
  useEffect(() => {
    apiService.handovers.orgDomains()
      .then(r => setDomainsOk((r.data?.domains || []).length > 0))
      .catch(() => setDomainsOk(null));
  }, []);

  // 2026_130: the default review-watcher picker needs names, not ids.
  useEffect(() => {
    apiService.handovers.assignableUsers()
      .then(r => setOrgUsers(r.data?.users || []))
      .catch(() => setOrgUsers([]));
  }, []);

  const save = async (patch) => {
    setSaving(true); setMsg(''); setErr('');
    const previous = cfg;
    setCfg(c => ({ ...c, ...patch }));           // optimistic
    try {
      const r = await apiService.handovers.setProjectAccess(patch);
      setCfg(r.data.settings);
      setMsg('Saved');
      setTimeout(() => setMsg(''), 2500);
    } catch (e) {
      setCfg(previous);                           // roll back on failure
      setErr(e?.response?.data?.error?.message || 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  if (err && !cfg) return <div style={{ fontSize: 13, color: '#991b1b', padding: 16 }}>{err}</div>;
  if (!cfg)        return <div style={{ fontSize: 13, color: '#6b7280', padding: 16 }}>Loading…</div>;

  const readOnly = viewer && !['owner', 'admin'].includes(viewer.role);
  const roleOpts = ['owner', 'admin', 'member', 'viewer'];

  return (
    <div>
      {domainsOk === false && (
        <div style={{ fontSize: 12, color: '#92400e', background: '#fef3c7',
                      border: '1px solid #fde68a', borderRadius: 6,
                      padding: '10px 12px', marginBottom: 16, lineHeight: 1.6 }}>
          <strong>No org email domains configured.</strong> Until at least one is
          added, every project member added from outside a project's own
          leadership goes to the approval queue instead of being approved
          straight away. Add your domains under Org Admin → Email Domains.
          <div style={{ marginTop: 4, color: '#a16207' }}>
            Project creators and service owners can still staff their own projects
            without approval — this only affects everyone else.
          </div>
        </div>
      )}

      {readOnly && (
        <div style={{ fontSize: 12, color: '#92400e', background: '#fef3c7', border: '1px solid #fde68a',
                      borderRadius: 6, padding: '9px 12px', marginBottom: 16 }}>
          Only an org owner or admin can change these. You can see the current values.
        </div>
      )}

      <Row
        title="Rollup basis"
        desc="How 'My Team' is worked out. People uses the org reporting lines, matching Deals, Actions, Accounts, Contacts and Prospecting. Team hierarchy (teams → parent team) is not built yet — selecting it would leave Projects unable to resolve a team, so it stays locked until that lands."
      >
        <select
          value={cfg.rollup_basis}
          onChange={e => save({ rollup_basis: e.target.value })}
          disabled
          style={{ fontSize: 14, padding: '10px 12px', borderRadius: 8, border: '1px solid #d1d5db', minHeight: 44 }}
        >
          <option value="people">People hierarchy</option>
          <option value="team">Team hierarchy (coming)</option>
        </select>
      </Row>

      <Row
        title="What you call the person running a project"
        desc="Shown wherever a project's accountable person appears. The underlying field does not change — this is only what your team sees. A single project can override it."
      >
        <input
          type="text"
          defaultValue={cfg.manager_label}
          onBlur={e => {
            const v = e.target.value.trim();
            if (v && v !== cfg.manager_label) save({ manager_label: v });
            else e.target.value = cfg.manager_label;
          }}
          disabled={readOnly || saving}
          maxLength={40}
          style={{ fontSize: 14, padding: '10px 12px', borderRadius: 8,
                   border: '1px solid #d1d5db', minHeight: 44, width: 200 }}
        />
      </Row>

      <Row
        title="Project owner"
        desc="Which person a project counts as belonging to when rolling up to a manager. Service owner is the person delivering it; creator is whoever the handover record came from."
      >
        <select
          value={cfg.owner_field}
          onChange={e => save({ owner_field: e.target.value })}
          disabled={readOnly || saving}
          style={{ fontSize: 14, padding: '10px 12px', borderRadius: 8, border: '1px solid #d1d5db', minHeight: 44 }}
        >
          <option value="service_owner">Service owner</option>
          <option value="created_by">Created by</option>
        </select>
      </Row>

      <Row
        title="Managers can see their team's projects"
        desc="Adds a 'My Team' tab for anyone with direct or indirect reports. Turning this off removes the tab for everyone."
      >
        <Switch on={cfg.team_scope_enabled} disabled={readOnly || saving}
                onChange={v => save({ team_scope_enabled: v })} />
      </Row>

      <Row
        title="Show unassigned projects to managers"
        desc="A project with no service owner belongs to nobody and would otherwise be visible only to whoever created it. With this on it appears in 'My Team' flagged as Unassigned, so it gets picked up rather than sitting idle."
      >
        <Switch on={cfg.show_unassigned_in_team_scope} disabled={readOnly || saving}
                onChange={v => save({ show_unassigned_in_team_scope: v })} />
      </Row>

      <Row
        title="Show the 'From my deals' tab"
        desc="Lists projects by who closed the originating deal. Off by default — it answers 'which deals did I hand over', not 'what am I working on'. Whoever closes a deal is added to the project team automatically, so they keep access to it either way."
      >
        <Switch on={cfg.show_from_my_deals_tab} disabled={readOnly || saving}
                onChange={v => save({ show_from_my_deals_tab: v })} />
      </Row>

      <Row
        title="Commercial tab follows the reporting line"
        desc="Lets anyone above the service owner see and grant the Commercial tab without a per-project grant. Turn it off if contract values should stay strictly need-to-know — org admins, the service owner, the deal owner and named viewers keep access either way."
      >
        <Switch on={cfg.commercial_follows_hierarchy} disabled={readOnly || saving}
                onChange={v => save({ commercial_follows_hierarchy: v })} />
      </Row>

      <Row
        title="Task owners can move their own due dates"
        desc="A task's assignee changing the date it is measured against is the single act that decides whether Plan vs Actual means anything. Off by default: the project manager, the creator and org admins can always move a date, and every move is recorded with who made it either way. Turn it on if your teams are trusted to manage their own dates."
      >
        <Switch on={cfg.allow_assignee_due_date_change === true} disabled={readOnly || saving}
                onChange={v => save({ allow_assignee_due_date_change: v })} />
      </Row>

      <div style={{ padding: '16px 0', borderBottom: '1px solid #f1f5f9' }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#1a202c', marginBottom: 3 }}>
          Default review watchers on a new project
        </div>
        <div style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.55, marginBottom: 10 }}>
          Copied onto each project as it is created, then owned by that project — editing
          this list never changes a project already running. The project manager and the
          creator are always alerted and do not need to be listed. Leave empty if alerts
          should be set per project.
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
          {(cfg.review_watcher_user_ids || []).length === 0 && (
            <span style={{ fontSize: 12, color: '#9ca3af' }}>Nobody set.</span>
          )}
          {(cfg.review_watcher_user_ids || []).map(id => {
            const u = orgUsers.find(x => x.id === id);
            return (
              <span key={id} style={{
                display: 'inline-flex', alignItems: 'center', gap: 8,
                minHeight: 36, padding: '6px 8px 6px 14px', borderRadius: 999,
                border: '1px solid #bae6fd', background: '#e0f2fe',
                color: '#0369a1', fontSize: 13,
              }}>
                {u ? (u.name || `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email)
                   : `User #${id}`}
                {!readOnly && (
                  <button type="button" disabled={saving}
                    onClick={() => save({
                      review_watcher_user_ids:
                        (cfg.review_watcher_user_ids || []).filter(x => x !== id),
                    })}
                    aria-label="Remove"
                    style={{ border: 'none', background: 'none', color: '#0369a1',
                             fontSize: 16, lineHeight: 1, cursor: 'pointer', padding: '0 4px' }}>
                    ×
                  </button>
                )}
              </span>
            );
          })}
        </div>
        {!readOnly && (
          <select
            value=""
            disabled={saving}
            onChange={e => {
              const id = parseInt(e.target.value, 10);
              if (!Number.isInteger(id)) return;
              save({
                review_watcher_user_ids:
                  [...new Set([...(cfg.review_watcher_user_ids || []), id])],
              });
              e.target.value = '';
            }}
            style={{ fontSize: 14, padding: '10px 12px', borderRadius: 8,
                     border: '1px solid #d1d5db', minHeight: 44, minWidth: 220 }}>
            <option value="">Add someone…</option>
            {orgUsers
              .filter(u => !(cfg.review_watcher_user_ids || []).includes(u.id))
              .map(u => (
                <option key={u.id} value={u.id}>
                  {u.name || `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email}
                </option>
              ))}
          </select>
        )}
      </div>

      <div style={{ padding: '16px 0' }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#1a202c', marginBottom: 3 }}>
          Roles that can see all organisation projects
        </div>
        <div style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.55, marginBottom: 10 }}>
          Adds an 'All Projects' tab showing every project in the org, regardless of owner.
          Owner is always included and cannot be removed.
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {roleOpts.map(r => {
            const on   = cfg.org_scope_roles.includes(r);
            const lock = r === 'owner';
            return (
              <button
                key={r}
                type="button"
                disabled={readOnly || saving || lock}
                onClick={() => save({
                  org_scope_roles: on
                    ? cfg.org_scope_roles.filter(x => x !== r)
                    : [...cfg.org_scope_roles, r],
                })}
                style={{
                  minHeight: 44, padding: '9px 16px', borderRadius: 999,
                  border: `1px solid ${on ? '#0369a1' : '#d1d5db'}`,
                  background: on ? '#e0f2fe' : '#fff',
                  color: on ? '#0369a1' : '#6b7280',
                  fontSize: 13, fontWeight: on ? 600 : 400, fontFamily: 'inherit',
                  cursor: (readOnly || lock) ? 'not-allowed' : 'pointer',
                  textTransform: 'capitalize',
                }}
              >
                {r}{lock ? ' (always)' : ''}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ minHeight: 22, marginTop: 8 }}>
        {msg && <span style={{ fontSize: 12, color: '#15803d', fontWeight: 600 }}>{msg} ✓</span>}
        {err && <span style={{ fontSize: 12, color: '#991b1b' }}>{err}</span>}
      </div>

      <div style={{ marginTop: 20, padding: '12px 14px', background: '#f8fafc',
                    border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 12,
                    color: '#475569', lineHeight: 1.6 }}>
        <strong style={{ color: NAVY }}>Note</strong> — these settings decide who can
        <em> list</em> projects. Opening a project has always been org-wide: anyone who can
        reach a project in a list sees its full operational detail. Restricted tabs are the
        exception, and the Commercial switch above is what governs them.
      </div>
    </div>
  );
}
