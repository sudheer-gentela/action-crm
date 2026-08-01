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

  const load = useCallback(() => {
    apiService.handovers.projectAccess()
      .then(r => { setCfg(r.data?.settings || null); setViewer(r.data?.viewer || null); })
      .catch(e => setErr(e?.response?.data?.error?.message || 'Could not load settings'));
  }, []);

  useEffect(() => { load(); }, [load]);

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
        title="Commercial tab follows the reporting line"
        desc="Lets anyone above the service owner see and grant the Commercial tab without a per-project grant. Turn it off if contract values should stay strictly need-to-know — org admins, the service owner, the deal owner and named viewers keep access either way."
      >
        <Switch on={cfg.commercial_follows_hierarchy} disabled={readOnly || saving}
                onChange={v => save({ commercial_follows_hierarchy: v })} />
      </Row>

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
