/**
 * OAAIUsageLimits.js
 *
 * "Usage & limits" section of Org Admin → AI Providers (step 1.1a).
 *
 *   - Org kill switch: turn all AI off (reason required) / back on, with the
 *     recent history of who changed it and why.
 *   - Org default daily budget per person ($3 unless changed).
 *   - Per person: today's spend against their limit, a personal override,
 *     the last 7 days, and where the money went by area.
 *   - Research pipeline (step 1.1b): automatic flagging of new prospects for
 *     background research, and the cap on the agent's open work per person.
 *
 * Saves immediately per control (no sticky save bar) because each change is
 * a separate policy decision with its own audit trail, unlike the provider
 * settings above it which are edited as one form.
 *
 * Spend on a person's own API key is shown for context but never counts
 * toward their limit — the backend excludes it.
 */

import React, { useState, useEffect, useCallback } from 'react';

const API = process.env.REACT_APP_API_URL || '';

function authHeaders() {
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

async function apiFetch(path, opts = {}) {
  const r = await fetch(`${API}${path}`, {
    ...opts,
    headers: { ...authHeaders(), ...(opts.headers || {}) },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || r.statusText);
  return data;
}

const money = (n) => `$${Number(n || 0).toFixed(2)}`;

// Single hue for "how much of the limit is used"; amber and red only appear
// with a text label beside them so state is never colour alone.
const METER_HUE  = '#6366f1';
const METER_WARN = '#B45309';
const METER_OVER = '#A32D2D';
const NEAR_LIMIT = 0.8;

export default function OAAIUsageLimits({ onFlash }) {
  const [loading, setLoading] = useState(true);
  const [usage,   setUsage]   = useState(null);
  const [error,   setError]   = useState(null);
  const [busy,    setBusy]    = useState(null);     // which control is saving

  const [defaultInput, setDefaultInput] = useState('');
  const [limitInputs,  setLimitInputs]  = useState({});   // userId → string
  const [expanded,     setExpanded]     = useState({});   // userId → bool
  const [showLog,      setShowLog]      = useState(false);

  // Kill switch: turning OFF opens an inline reason box rather than a
  // window.prompt so the admin can see what they're confirming.
  const [confirmOff, setConfirmOff] = useState(false);
  const [offReason,  setOffReason]  = useState('');

  // Research pipeline settings (step 1.1b).
  const [research,  setResearch]  = useState(null);   // { research_auto_flag, agent_pending_cap, research_capture_hold_hours, capture_daily_limit }
  const [capInput,  setCapInput]  = useState('');
  // Step 1.4: LinkedIn capture queue settings.
  const [holdInput,  setHoldInput]  = useState('');
  const [limitInput, setLimitInput] = useState('');

  const flash = useCallback((kind, msg) => {
    if (onFlash) onFlash(kind, msg);
  }, [onFlash]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [u, rs] = await Promise.all([
        apiFetch('/org/admin/ai/usage?days=7'),
        // Research settings are secondary: if they fail to load, the usage
        // screen still works and the research card just doesn't render.
        apiFetch('/org/admin/ai/research-settings').catch(() => null),
      ]);
      setUsage(u);
      setResearch(rs);
      if (rs) {
        setCapInput(String(rs.agent_pending_cap));
        setHoldInput(String(rs.research_capture_hold_hours ?? 24));
        setLimitInput(String(rs.capture_daily_limit ?? 50));
      }
      setDefaultInput(String(u.default_limit_usd));
      const li = {};
      for (const p of u.users || []) li[p.user_id] = p.has_override ? String(p.limit_usd) : '';
      setLimitInputs(li);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function saveDefault() {
    setBusy('default');
    try {
      const r = await apiFetch('/org/admin/ai/limits', {
        method: 'PUT',
        body: JSON.stringify({ daily_budget_usd: defaultInput }),
      });
      flash('success', `Default daily budget set to ${money(r.daily_budget_usd)} per person ✓`);
      await load();
    } catch (e) {
      flash('error', e.message);
    } finally {
      setBusy(null);
    }
  }

  async function saveUserLimit(userId, value) {
    setBusy(`user-${userId}`);
    try {
      const r = await apiFetch(`/org/admin/ai/limits/users/${userId}`, {
        method: 'PUT',
        body: JSON.stringify({ daily_limit_usd: value === '' ? null : value }),
      });
      flash('success', r.uses_org_default
        ? 'Limit reset to the org default ✓'
        : `Limit set to ${money(r.daily_limit_usd)} ✓`);
      await load();
    } catch (e) {
      flash('error', e.message);
    } finally {
      setBusy(null);
    }
  }

  async function setAiEnabled(enabled, reason) {
    setBusy('kill');
    try {
      await apiFetch('/org/admin/ai/kill-switch', {
        method: 'PUT',
        body: JSON.stringify({ enabled, reason }),
      });
      setConfirmOff(false);
      setOffReason('');
      flash('success', enabled
        ? 'AI turned back on for the organization ✓'
        : 'AI turned off for the organization. All AI work stops within about 30 seconds.');
      await load();
    } catch (e) {
      flash('error', e.message);
    } finally {
      setBusy(null);
    }
  }

  async function saveResearch(patch, okMsg) {
    setBusy('research');
    try {
      const r = await apiFetch('/org/admin/ai/research-settings', {
        method: 'PUT',
        body: JSON.stringify(patch),
      });
      setResearch({
        research_auto_flag:          r.research_auto_flag,
        agent_pending_cap:           r.agent_pending_cap,
        research_capture_hold_hours: r.research_capture_hold_hours,
        capture_daily_limit:         r.capture_daily_limit,
      });
      setCapInput(String(r.agent_pending_cap));
      setHoldInput(String(r.research_capture_hold_hours));
      setLimitInput(String(r.capture_daily_limit));
      flash('success', okMsg);
    } catch (e) {
      flash('error', e.message);
    } finally {
      setBusy(null);
    }
  }

  function onToggleKill() {
    if (usage.ai_enabled) {
      setConfirmOff(true);
    } else if (window.confirm('Turn AI back on for everyone in the organization?')) {
      setAiEnabled(true, '');
    }
  }

  if (loading && !usage) {
    return <div style={{ padding: '12px 0', color: '#6b7280', fontSize: 13 }}>Loading usage…</div>;
  }
  if (error && !usage) {
    return (
      <div style={{ ...cardStyle, color: '#991b1b', fontSize: 13 }}>
        Couldn't load AI usage: {error}{' '}
        <button onClick={load} style={linkBtnStyle}>Try again</button>
      </div>
    );
  }

  const users = usage.users || [];
  const blockedCount = users.filter(u => u.blocked).length;

  return (
    <div>
      {/* ── Kill switch ── */}
      <div style={{
        ...cardStyle,
        borderColor: usage.ai_enabled ? '#e5e7eb' : '#fecaca',
        background:  usage.ai_enabled ? '#fff' : '#FEF2F2',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 500, fontSize: 14 }}>
              ⛔ AI for the whole organization{' '}
              {usage.ai_enabled
                ? <Tag tone="ok">On</Tag>
                : <Tag tone="danger">Off</Tag>}
            </div>
            <div style={{ fontSize: 13, color: '#6b7280', marginTop: 3, lineHeight: 1.5 }}>
              {usage.ai_enabled
                ? 'Turning this off stops every AI feature for everyone — agent work, drafting, research, deal and meeting AI, and inbound email analysis. Rule-based features (sending, stop-on-reply, bounce handling) keep working.'
                : <>Turned off{usage.ai_disabled_by_name ? <> by <strong>{usage.ai_disabled_by_name}</strong></> : null}
                    {usage.ai_disabled_at ? <> on {new Date(usage.ai_disabled_at).toLocaleString()}</> : null}.
                    {usage.ai_disabled_reason ? <> Reason: “{usage.ai_disabled_reason}”</> : null}</>}
            </div>
          </div>
          <Toggle on={usage.ai_enabled} onChange={onToggleKill} disabled={busy === 'kill' || confirmOff} />
        </div>

        {confirmOff && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #f3f4f6' }}>
            <label style={labelStyle}>Why are you turning AI off? (shown to admins and kept in the history)</label>
            <textarea
              value={offReason}
              onChange={e => setOffReason(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder="e.g. Unexpected spend while we review agent settings"
              style={{ ...inputStyle, resize: 'vertical' }}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
              <button onClick={() => { setConfirmOff(false); setOffReason(''); }} style={ghostBtnStyle} disabled={busy === 'kill'}>
                Cancel
              </button>
              <button
                onClick={() => setAiEnabled(false, offReason)}
                style={{ ...dangerSolidBtnStyle, opacity: offReason.trim() ? 1 : 0.5 }}
                disabled={busy === 'kill' || !offReason.trim()}>
                {busy === 'kill' ? 'Turning off…' : 'Turn AI off'}
              </button>
            </div>
          </div>
        )}

        {(usage.kill_switch_log || []).length > 0 && (
          <div style={{ marginTop: 10 }}>
            <button onClick={() => setShowLog(s => !s)} style={linkBtnStyle}>
              {showLog ? '▾' : '▸'} History ({usage.kill_switch_log.length})
            </button>
            {showLog && (
              <table style={{ ...tableStyle, marginTop: 6 }}>
                <tbody>
                  {usage.kill_switch_log.map((l, i) => (
                    <tr key={i}>
                      <td style={tdStyle}>{new Date(l.changed_at).toLocaleString()}</td>
                      <td style={tdStyle}>{l.enabled ? <Tag tone="ok">Turned on</Tag> : <Tag tone="danger">Turned off</Tag>}</td>
                      <td style={tdStyle}>{l.changed_by_name || '—'}</td>
                      <td style={{ ...tdStyle, color: '#6b7280' }}>{l.reason || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* ── Default daily budget ── */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <div style={{ fontWeight: 500, fontSize: 14 }}>💵 Default daily AI budget per person</div>
            <div style={{ fontSize: 13, color: '#6b7280', marginTop: 3, lineHeight: 1.5 }}>
              Covers all AI use by one person in a day, on the org's or platform's key. When someone
              reaches it, AI pauses for them until midnight ({usage.timezone}) — they and the admins get
              one notification. Spend on a person's own API key isn't counted.
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, color: '#6b7280' }}>$</span>
            <input
              type="number" min="0" max="1000" step="0.5"
              value={defaultInput}
              onChange={e => setDefaultInput(e.target.value)}
              style={{ ...inputStyle, width: 96 }}
            />
            <button
              onClick={saveDefault}
              disabled={busy === 'default' || defaultInput === '' || Number(defaultInput) === usage.default_limit_usd}
              style={primaryBtnStyle}>
              {busy === 'default' ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>

      {/* ── Research pipeline (step 1.1b) ── */}
      {research && (
        <div style={cardStyle}>
          <div style={{ fontWeight: 500, fontSize: 14 }}>🔎 Research pipeline</div>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginTop: 10 }}>
            <div style={{ flex: 1, fontSize: 13, color: '#6b7280', lineHeight: 1.5 }}>
              <strong style={{ color: '#111827', fontWeight: 500 }}>Flag new prospects for research automatically.</strong>{' '}
              Extension captures are flagged; manual, CSV and HubSpot form prospects are flagged when they pass
              the fit check. Research runs in the background on the owner's daily budget, and a person approves
              or rejects every result. Flagging by hand works either way.
            </div>
            <Toggle
              on={research.research_auto_flag}
              disabled={busy === 'research'}
              onChange={() => saveResearch(
                { research_auto_flag: !research.research_auto_flag },
                research.research_auto_flag ? 'Automatic research flagging turned off ✓' : 'Automatic research flagging turned on ✓'
              )}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, marginTop: 14, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 260, fontSize: 13, color: '#6b7280', lineHeight: 1.5 }}>
              <strong style={{ color: '#111827', fontWeight: 500 }}>Agent limit per person.</strong>{' '}
              The most prospects the agent may have waiting on one person at once (queued, researching or
              awaiting review). Raise it as the agent's results earn it.
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="number" min="0" max="500" step="1"
                value={capInput}
                onChange={e => setCapInput(e.target.value)}
                style={{ ...inputStyle, width: 80 }}
              />
              <button
                onClick={() => saveResearch({ agent_pending_cap: Number(capInput) }, `Agent limit set to ${capInput} per person ✓`)}
                disabled={busy === 'research' || capInput === '' || Number(capInput) === research.agent_pending_cap}
                style={primaryBtnStyle}>
                {busy === 'research' ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>

          {/* Step 1.4: LinkedIn capture queue */}
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, marginTop: 14, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 260, fontSize: 13, color: '#6b7280', lineHeight: 1.5 }}>
              <strong style={{ color: '#111827', fontWeight: 500 }}>Wait for a LinkedIn capture.</strong>{' '}
              A flagged prospect with a LinkedIn URL but no capture waits this many hours before research
              runs, so it can use what the extension captures. 0 = don't wait.
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="number" min="0" max="168" step="1"
                value={holdInput}
                onChange={e => setHoldInput(e.target.value)}
                style={{ ...inputStyle, width: 80 }}
                aria-label="Hours to wait for a LinkedIn capture"
              />
              <span style={{ fontSize: 13, color: '#6b7280' }}>hours</span>
              <button
                onClick={() => saveResearch({ research_capture_hold_hours: Number(holdInput) }, `Research now waits up to ${holdInput} hours for a capture ✓`)}
                disabled={busy === 'research' || holdInput === '' || Number(holdInput) === research.research_capture_hold_hours}
                style={primaryBtnStyle}>
                Save
              </button>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, marginTop: 14, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 260, fontSize: 13, color: '#6b7280', lineHeight: 1.5 }}>
              <strong style={{ color: '#111827', fontWeight: 500 }}>Daily capture limit per person.</strong>{' '}
              The most LinkedIn profiles one person can open from the capture queue in a day. The extension
              only opens a profile when they click — never automatically.
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="number" min="1" max="500" step="1"
                value={limitInput}
                onChange={e => setLimitInput(e.target.value)}
                style={{ ...inputStyle, width: 80 }}
                aria-label="Daily capture limit per person"
              />
              <span style={{ fontSize: 13, color: '#6b7280' }}>a day</span>
              <button
                onClick={() => saveResearch({ capture_daily_limit: Number(limitInput) }, `Daily capture limit set to ${limitInput} ✓`)}
                disabled={busy === 'research' || limitInput === '' || Number(limitInput) === research.capture_daily_limit}
                style={primaryBtnStyle}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Org summary ── */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <Stat label="Today, counted" value={money(usage.org_today_usd)} />
        <Stat label="Last 7 days, counted" value={money(usage.org_week_usd)} />
        <Stat label="Own keys, 7 days (not counted)" value={money(usage.org_week_byok_usd)} muted />
        <Stat label="Paused today" value={String(blockedCount)} muted={blockedCount === 0} />
      </div>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
        Day runs in {usage.timezone}; resets {usage.resets_label}.{' '}
        <button onClick={load} style={linkBtnStyle} disabled={loading}>{loading ? 'Refreshing…' : '↻ Refresh'}</button>
      </div>

      {/* ── Per person ── */}
      <div style={{ ...cardStyle, padding: 0, overflowX: 'auto' }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Person</th>
              <th style={{ ...thStyle, width: 220 }}>Today</th>
              <th style={{ ...thStyle, width: 210 }}>Daily limit</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>7 days</th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 && (
              <tr><td colSpan={4} style={{ ...tdStyle, color: '#6b7280', padding: 16 }}>No members yet.</td></tr>
            )}
            {users.map(u => {
              const input   = limitInputs[u.user_id] ?? '';
              const stored  = u.has_override ? String(u.limit_usd) : '';
              const changed = input !== stored;
              const open    = !!expanded[u.user_id];
              return (
                <React.Fragment key={u.user_id}>
                  <tr>
                    <td style={tdStyle}>
                      <button
                        onClick={() => setExpanded(x => ({ ...x, [u.user_id]: !open }))}
                        style={{ ...linkBtnStyle, color: '#111827', fontWeight: 500, fontSize: 13 }}
                        aria-expanded={open}>
                        {open ? '▾' : '▸'} {u.name}
                      </button>
                      <div style={{ fontSize: 11, color: '#9ca3af', marginLeft: 14 }}>
                        {u.role || (u.active_member ? '' : 'no longer a member')}
                        {u.today_byok_usd > 0 ? ` · own key today ${money(u.today_byok_usd)}` : ''}
                      </div>
                    </td>
                    <td style={tdStyle}><Meter spent={u.today_usd} limit={u.limit_usd} blocked={u.blocked} /></td>
                    <td style={tdStyle}>
                      {u.active_member ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontSize: 13, color: '#6b7280' }}>$</span>
                          <input
                            type="number" min="0" max="1000" step="0.5"
                            value={input}
                            placeholder={`${Number(usage.default_limit_usd).toFixed(2)} (default)`}
                            onChange={e => setLimitInputs(x => ({ ...x, [u.user_id]: e.target.value }))}
                            style={{ ...inputStyle, width: 112, padding: '5px 8px', fontSize: 13 }}
                          />
                          {changed && (
                            <button
                              onClick={() => saveUserLimit(u.user_id, input)}
                              disabled={busy === `user-${u.user_id}`}
                              style={smallBtnStyle}>
                              {busy === `user-${u.user_id}` ? '…' : 'Save'}
                            </button>
                          )}
                          {!changed && u.has_override && (
                            <button
                              onClick={() => saveUserLimit(u.user_id, '')}
                              disabled={busy === `user-${u.user_id}`}
                              title="Use the org default"
                              style={smallGhostBtnStyle}>
                              Reset
                            </button>
                          )}
                        </div>
                      ) : <span style={{ fontSize: 12, color: '#9ca3af' }}>—</span>}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {money(u.week_usd)}
                      <div style={{ fontSize: 11, color: '#9ca3af' }}>{u.week_calls} call{u.week_calls === 1 ? '' : 's'}</div>
                    </td>
                  </tr>
                  {open && (
                    <tr>
                      <td colSpan={4} style={{ ...tdStyle, background: '#F9FAFB', padding: '12px 16px' }}>
                        <PersonDetail person={u} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── Org by area ── */}
      {(usage.org_week_by_area || []).length > 0 && (
        <div style={cardStyle}>
          <div style={{ fontWeight: 500, fontSize: 14, marginBottom: 8 }}>Where the last 7 days went</div>
          <AreaTable rows={usage.org_week_by_area} />
        </div>
      )}
    </div>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function Meter({ spent, limit, blocked }) {
  const ratio = limit > 0 ? Math.min(spent / limit, 1) : (spent > 0 ? 1 : 0);
  const near  = !blocked && limit > 0 && spent / limit >= NEAR_LIMIT;
  const color = blocked ? METER_OVER : near ? METER_WARN : METER_HUE;
  return (
    <div title={`${money(spent)} of ${money(limit)} used today`}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4, fontVariantNumeric: 'tabular-nums' }}>
        <span style={{ color: '#111827' }}>{money(spent)} <span style={{ color: '#9ca3af' }}>/ {money(limit)}</span></span>
        {blocked && <Tag tone="danger">Paused</Tag>}
        {near && <Tag tone="warn">Near limit</Tag>}
      </div>
      <div style={{ height: 6, borderRadius: 3, background: '#EEF0F3', overflow: 'hidden' }}>
        <div style={{ width: `${ratio * 100}%`, height: '100%', background: color, borderRadius: 3 }} />
      </div>
    </div>
  );
}

function PersonDetail({ person }) {
  const max = Math.max(...person.daily.map(d => d.usd), 0);
  return (
    <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 260px' }}>
        <div style={detailHeadStyle}>Today by area</div>
        {person.today_by_area.length
          ? <AreaTable rows={person.today_by_area} />
          : <div style={{ fontSize: 12, color: '#9ca3af' }}>No AI use today.</div>}
      </div>
      <div style={{ flex: '1 1 260px' }}>
        <div style={detailHeadStyle}>Last 7 days by area</div>
        {person.week_by_area.length
          ? <AreaTable rows={person.week_by_area} />
          : <div style={{ fontSize: 12, color: '#9ca3af' }}>No AI use this week.</div>}
      </div>
      <div style={{ flex: '1 1 200px' }}>
        <div style={detailHeadStyle}>Counted spend per day</div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 56 }} role="img"
             aria-label={person.daily.map(d => `${d.day}: ${money(d.usd)}`).join(', ')}>
          {person.daily.map(d => (
            <div key={d.day} title={`${d.day}: ${money(d.usd)}`}
                 style={{ flex: 1, display: 'flex', alignItems: 'flex-end', height: '100%', cursor: 'default' }}>
              <div style={{
                width: '100%',
                height: max > 0 && d.usd > 0 ? `${Math.max((d.usd / max) * 100, 4)}%` : 1,
                background: d.usd > 0 ? METER_HUE : '#E5E7EB',
                borderRadius: '4px 4px 0 0',
              }} />
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#9ca3af', marginTop: 3 }}>
          <span>{person.daily[0]?.day.slice(5)}</span>
          <span>{person.daily[person.daily.length - 1]?.day.slice(5)}</span>
        </div>
      </div>
    </div>
  );
}

function AreaTable({ rows }) {
  const max = Math.max(...rows.map(r => r.usd), 0);
  return (
    <table style={{ ...tableStyle, fontSize: 12 }}>
      <tbody>
        {rows.map(r => (
          <tr key={r.area}>
            <td style={{ padding: '3px 0', width: '42%' }}>{r.label}</td>
            <td style={{ padding: '3px 8px' }}>
              <div style={{ height: 4, borderRadius: 2, background: '#EEF0F3' }}>
                <div style={{ width: max > 0 ? `${(r.usd / max) * 100}%` : 0, height: '100%', background: METER_HUE, borderRadius: 2 }} />
              </div>
            </td>
            <td style={{ padding: '3px 0', textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
              {money(r.usd)}
              <span style={{ color: '#9ca3af' }}> · {r.calls}</span>
              {r.byok_usd > 0 && <span style={{ color: '#9ca3af' }}> · own key {money(r.byok_usd)}</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Stat({ label, value, muted }) {
  return (
    <div style={{ flex: '1 1 150px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '10px 14px' }}>
      <div style={{ fontSize: 11, color: '#6b7280' }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: muted ? '#6b7280' : '#111827', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );
}

function Tag({ children, tone }) {
  const p = {
    ok:     { bg: '#E1F5EE', fg: '#0F6E56' },
    warn:   { bg: '#FAEEDA', fg: '#854F0B' },
    danger: { bg: '#FCEBEB', fg: '#A32D2D' },
  }[tone] || { bg: '#F1EFE8', fg: '#444441' };
  return (
    <span style={{ fontSize: 11, padding: '1px 7px', borderRadius: 4, fontWeight: 500, background: p.bg, color: p.fg, whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}

function Toggle({ on, onChange, disabled }) {
  return (
    <div
      role="switch" aria-checked={on}
      onClick={() => !disabled && onChange()}
      style={{
        flexShrink: 0, width: 44, height: 24, borderRadius: 12,
        background: on ? '#0F6E56' : '#d1d5db',
        position: 'relative', cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'background .2s', opacity: disabled ? 0.5 : 1,
      }}>
      <div style={{
        width: 18, height: 18, borderRadius: '50%', background: '#fff',
        position: 'absolute', top: 3, left: on ? 23 : 3,
        transition: 'left .2s', boxShadow: '0 1px 3px rgba(0,0,0,.2)',
      }} />
    </div>
  );
}

// ── Styles (match OAAIProviderSettings) ─────────────────────────────────────

const cardStyle = {
  background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10,
  padding: '14px 18px', marginBottom: 10,
};
const inputStyle = {
  width: '100%', padding: '7px 10px', fontSize: 14,
  border: '1px solid #d1d5db', borderRadius: 7, background: '#fff',
  color: '#111827', outline: 'none', boxSizing: 'border-box',
};
const labelStyle = { fontSize: 12, fontWeight: 500, color: '#6b7280', display: 'block', marginBottom: 6 };
const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: 13 };
const thStyle = {
  textAlign: 'left', fontSize: 11, fontWeight: 500, color: '#6b7280',
  padding: '10px 16px', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap',
};
const tdStyle = { padding: '10px 16px', borderBottom: '1px solid #f3f4f6', verticalAlign: 'top' };
const detailHeadStyle = { fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.3 };
const primaryBtnStyle = {
  padding: '7px 14px', fontSize: 13, fontWeight: 500,
  background: '#E8630A', color: '#fff', border: 'none', borderRadius: 7, cursor: 'pointer',
};
const ghostBtnStyle = {
  padding: '7px 14px', fontSize: 13, fontWeight: 500,
  background: '#fff', color: '#374151', border: '1px solid #d1d5db', borderRadius: 7, cursor: 'pointer',
};
const dangerSolidBtnStyle = {
  padding: '7px 14px', fontSize: 13, fontWeight: 500,
  background: '#A32D2D', color: '#fff', border: 'none', borderRadius: 7, cursor: 'pointer',
};
const smallBtnStyle = {
  padding: '4px 10px', fontSize: 12, fontWeight: 500,
  background: '#E8630A', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer',
};
const smallGhostBtnStyle = {
  padding: '4px 10px', fontSize: 12, fontWeight: 500,
  background: '#fff', color: '#374151', border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer',
};
const linkBtnStyle = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
  color: '#4F46E5', fontSize: 12,
};
