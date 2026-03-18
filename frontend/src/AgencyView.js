/**
 * AgencyView.js
 *
 * Internal agency dashboard for ABC Corp users.
 * Shows all managed clients with summary cards + per-client drill-down.
 *
 * Tabs per client:
 *   Overview | Pipeline | Outreach | Sequences | Prospects | Team | Portal
 */

import React, { useState, useEffect, useCallback } from 'react';

const API   = process.env.REACT_APP_API_URL || '';
const TEAL  = '#0F9D8E';

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

const STATUS_CFG = {
  active:  { bg: '#d1fae5', color: '#065f46', label: 'Active'  },
  paused:  { bg: '#fef3c7', color: '#92400e', label: 'Paused'  },
  churned: { bg: '#fee2e2', color: '#991b1b', label: 'Churned' },
};

const STAGE_ORDER = ['target','researched','contacted','engaged','qualified','converted'];

// ═════════════════════════════════════════════════════════════════════════════
// MAIN
// ═════════════════════════════════════════════════════════════════════════════
export default function AgencyView() {
  const [clients,        setClients]        = useState([]);
  const [loading,        setLoading]        = useState(true);
  const [error,          setError]          = useState('');
  const [selectedClient, setSelectedClient] = useState(null);
  const [showCreate,     setShowCreate]     = useState(false);

  const loadClients = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiFetch('/clients?status=all');
      setClients(r.clients || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadClients(); }, [loadClients]);

  if (selectedClient) {
    return (
      <ClientDetail
        clientId={selectedClient}
        onBack={() => { setSelectedClient(null); loadClients(); }}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: "'Inter', system-ui, sans-serif" }}>

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '18px 24px', borderBottom: '1px solid #e5e7eb', background: '#fff', flexShrink: 0,
      }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: TEAL, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 3 }}>
            Agency
          </div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: '#111827' }}>Managed Clients</h2>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          style={{
            padding: '9px 20px', borderRadius: 8, border: 'none',
            background: TEAL, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}
        >
          + New Client
        </button>
      </div>

      {error && (
        <div style={{ margin: '12px 24px 0', padding: '10px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, fontSize: 13, color: '#dc2626' }}>
          ⚠️ {error}
        </div>
      )}

      {/* Client grid */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>Loading clients…</div>
        ) : clients.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 80 }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>🏢</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#374151', marginBottom: 8 }}>No clients yet</div>
            <div style={{ fontSize: 13, color: '#9ca3af', marginBottom: 20 }}>
              Promote a closed-won account to a managed client to get started.
            </div>
            <button
              onClick={() => setShowCreate(true)}
              style={{
                padding: '10px 24px', borderRadius: 8, border: 'none',
                background: TEAL, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
              }}
            >
              Create First Client
            </button>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16 }}>
            {clients.map(client => (
              <ClientCard
                key={client.id}
                client={client}
                onClick={() => setSelectedClient(client.id)}
              />
            ))}
          </div>
        )}
      </div>

      {showCreate && (
        <CreateClientModal
          onSave={() => { setShowCreate(false); loadClients(); }}
          onClose={() => setShowCreate(false)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT CARD
// ─────────────────────────────────────────────────────────────────────────────
function ClientCard({ client, onClick }) {
  const sc = STATUS_CFG[client.status] || STATUS_CFG.active;
  return (
    <div
      onClick={onClick}
      style={{
        border: '1px solid #e5e7eb', borderRadius: 14, background: '#fff',
        overflow: 'hidden', cursor: 'pointer', transition: 'all 0.15s',
        boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
      }}
      onMouseEnter={e => e.currentTarget.style.boxShadow = '0 4px 16px rgba(15,157,142,0.12)'}
      onMouseLeave={e => e.currentTarget.style.boxShadow = '0 1px 4px rgba(0,0,0,0.05)'}
    >
      {/* Top bar */}
      <div style={{
        padding: '14px 16px 12px',
        borderBottom: '1px solid #f3f4f6',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8,
      }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#111827', marginBottom: 3 }}>{client.name}</div>
          {client.account_name && (
            <div style={{ fontSize: 11, color: '#9ca3af' }}>{client.account_name} · {client.account_industry || 'N/A'}</div>
          )}
        </div>
        <span style={{
          padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600,
          background: sc.bg, color: sc.color, flexShrink: 0,
        }}>
          {sc.label}
        </span>
      </div>

      {/* Stats row */}
      <div style={{ display: 'flex', padding: '10px 16px', gap: 0 }}>
        {[
          { label: 'Prospects', value: client.prospect_count || 0, color: TEAL },
          { label: 'Team',      value: client.team_size || 0,      color: '#6b7280' },
          { label: 'Portal',    value: client.portal_user_count || 0, color: '#8b5cf6' },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ flex: 1, textAlign: 'center', borderRight: '1px solid #f3f4f6', padding: '4px 0' }}>
            <div style={{ fontSize: 18, fontWeight: 700, color }}>{value}</div>
            <div style={{ fontSize: 10, color: '#9ca3af', fontWeight: 500, textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
          </div>
        ))}
        <div style={{ flex: 1, textAlign: 'center', padding: '4px 0' }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: client.portal_enabled ? '#059669' : '#9ca3af' }}>
            {client.portal_enabled ? '✓' : '—'}
          </div>
          <div style={{ fontSize: 10, color: '#9ca3af', fontWeight: 500, textTransform: 'uppercase', letterSpacing: 0.3 }}>Portal</div>
        </div>
      </div>

      {/* Footer */}
      {client.service_start_date && (
        <div style={{ padding: '8px 16px', borderTop: '1px solid #f3f4f6', fontSize: 11, color: '#9ca3af' }}>
          Service since {new Date(client.service_start_date).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT DETAIL
// ─────────────────────────────────────────────────────────────────────────────
function ClientDetail({ clientId, onBack }) {
  const [tab,       setTab]       = useState('overview');
  const [data,      setData]      = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviting,  setInviting]  = useState(false);
  const [inviteMsg, setInviteMsg] = useState('');

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const r = await apiFetch(`/clients/${clientId}/dashboard`);
      setData(r);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => { loadDashboard(); }, [loadDashboard]);

  const handleInvite = async () => {
    if (!inviteEmail.trim()) return;
    setInviting(true);
    setInviteMsg('');
    try {
      const r = await apiFetch(`/clients/${clientId}/portal-users`, {
        method: 'POST',
        body: JSON.stringify({ email: inviteEmail.trim() }),
      });
      setInviteMsg(`✅ Invite sent to ${inviteEmail}. Magic link: ${r.magicLink}`);
      setInviteEmail('');
      loadDashboard();
    } catch (err) {
      setInviteMsg(`⚠️ ${err.message}`);
    } finally {
      setInviting(false);
    }
  };

  const handleTogglePortal = async () => {
    try {
      await apiFetch(`/clients/${clientId}`, {
        method: 'PUT',
        body: JSON.stringify({ portal_enabled: !data?.client?.portal_enabled }),
      });
      loadDashboard();
    } catch (err) {
      setError(err.message);
    }
  };

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#9ca3af' }}>
      Loading client…
    </div>
  );

  if (error) return (
    <div style={{ padding: 40, color: '#dc2626' }}>⚠️ {error}</div>
  );

  const { client, pipeline, outreach, sequences, prospects, weeklyTrend, team, recentActivity } = data || {};

  const TABS = [
    { key: 'overview',   label: '📊 Overview'   },
    { key: 'pipeline',   label: '🎯 Pipeline'   },
    { key: 'outreach',   label: '✉️ Outreach'   },
    { key: 'sequences',  label: '📋 Sequences'  },
    { key: 'prospects',  label: '👥 Prospects'  },
    { key: 'team',       label: '🤝 Team'       },
    { key: 'portal',     label: '🔗 Portal'     },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: "'Inter', system-ui, sans-serif" }}>

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '14px 24px', borderBottom: '1px solid #e5e7eb', background: '#fff', flexShrink: 0,
      }}>
        <button
          onClick={onBack}
          style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', color: '#6b7280', fontSize: 12, cursor: 'pointer' }}
        >
          ← Back
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: TEAL, textTransform: 'uppercase', letterSpacing: 1 }}>Client</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: '#111827' }}>{client?.name}</div>
        </div>
        {client?.account_name && (
          <div style={{ fontSize: 12, color: '#9ca3af' }}>via {client.account_name}</div>
        )}
        <span style={{
          padding: '4px 12px', borderRadius: 20, fontSize: 11, fontWeight: 600,
          ...(STATUS_CFG[client?.status] || STATUS_CFG.active),
        }}>
          {(STATUS_CFG[client?.status] || STATUS_CFG.active).label}
        </span>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 2, padding: '8px 16px', borderBottom: '1px solid #e5e7eb', background: '#fff', flexShrink: 0, overflowX: 'auto' }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: '6px 14px', borderRadius: 7, border: 'none', whiteSpace: 'nowrap',
            background: tab === t.key ? TEAL : 'transparent',
            color: tab === t.key ? '#fff' : '#6b7280',
            fontSize: 12, fontWeight: 600, cursor: 'pointer',
          }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>

        {/* ── OVERVIEW ────────────────────────────────────────────────────── */}
        {tab === 'overview' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

            {/* KPI row */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
              {[
                { label: 'Total Prospects', value: prospects?.length || 0,     color: TEAL },
                { label: 'Emails Sent',     value: outreach?.totalSent || 0,   color: '#3b82f6' },
                { label: 'Replies',         value: outreach?.totalReplies || 0, color: '#059669' },
                { label: 'Reply Rate',      value: `${outreach?.replyRate || 0}%`, color: '#f59e0b' },
              ].map(({ label, value, color }) => (
                <div key={label} style={{
                  padding: '16px 18px', background: '#fff',
                  border: '1px solid #e5e7eb', borderRadius: 12,
                  boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
                }}>
                  <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>{label}</div>
                  <div style={{ fontSize: 26, fontWeight: 800, color }}>{value}</div>
                </div>
              ))}
            </div>

            {/* This week */}
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '16px 18px' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 12 }}>This Week</div>
              <div style={{ display: 'flex', gap: 20 }}>
                <div>
                  <span style={{ fontSize: 22, fontWeight: 700, color: '#3b82f6' }}>{outreach?.sentThisWeek || 0}</span>
                  <span style={{ fontSize: 12, color: '#9ca3af', marginLeft: 6 }}>emails sent</span>
                </div>
                <div>
                  <span style={{ fontSize: 22, fontWeight: 700, color: '#059669' }}>{outreach?.repliesThisWeek || 0}</span>
                  <span style={{ fontSize: 12, color: '#9ca3af', marginLeft: 6 }}>replies</span>
                </div>
              </div>
            </div>

            {/* Weekly trend */}
            {weeklyTrend?.length > 0 && (
              <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '16px 18px' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 14 }}>Weekly Outreach Trend</div>
                <TrendChart data={weeklyTrend} />
              </div>
            )}

            {/* Recent activity */}
            {recentActivity?.length > 0 && (
              <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '16px 18px' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 12 }}>Recent Activity</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {recentActivity.map((a, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
                      <span style={{ fontSize: 14 }}>📌</span>
                      <span style={{ flex: 1, color: '#374151' }}>{a.description}</span>
                      <span style={{ color: '#9ca3af', whiteSpace: 'nowrap' }}>
                        {new Date(a.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── PIPELINE ────────────────────────────────────────────────────── */}
        {tab === 'pipeline' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 4 }}>Prospect Pipeline</div>
            {STAGE_ORDER.map(stage => {
              const row = pipeline?.find(p => p.stage === stage);
              const count = row?.count || 0;
              const maxCount = Math.max(...(pipeline?.map(p => p.count) || [1]), 1);
              return (
                <div key={stage} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 90, fontSize: 12, fontWeight: 600, color: '#374151', textTransform: 'capitalize' }}>{stage}</div>
                  <div style={{ flex: 1, height: 24, background: '#f3f4f6', borderRadius: 6, overflow: 'hidden' }}>
                    <div style={{
                      width: `${(count / maxCount) * 100}%`,
                      height: '100%',
                      background: `linear-gradient(90deg, ${TEAL}, #0d8a7c)`,
                      borderRadius: 6, transition: 'width 0.4s ease',
                      minWidth: count > 0 ? 24 : 0,
                    }} />
                  </div>
                  <div style={{ width: 30, fontSize: 13, fontWeight: 700, color: TEAL, textAlign: 'right' }}>{count}</div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── OUTREACH ────────────────────────────────────────────────────── */}
        {tab === 'outreach' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
              {[
                { label: 'Total Sent',    value: outreach?.totalSent    || 0, color: '#3b82f6' },
                { label: 'Total Replies', value: outreach?.totalReplies || 0, color: '#059669' },
                { label: 'Reply Rate',    value: `${outreach?.replyRate || 0}%`, color: '#f59e0b' },
              ].map(({ label, value, color }) => (
                <div key={label} style={{ padding: '14px 16px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10 }}>
                  <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>{label}</div>
                  <div style={{ fontSize: 24, fontWeight: 800, color }}>{value}</div>
                </div>
              ))}
            </div>
            {weeklyTrend?.length > 0 && (
              <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '16px 18px' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 14 }}>Week-over-Week</div>
                <TrendChart data={weeklyTrend} />
              </div>
            )}
          </div>
        )}

        {/* ── SEQUENCES ───────────────────────────────────────────────────── */}
        {tab === 'sequences' && (
          <div>
            {!sequences?.length ? (
              <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>No sequences assigned to this client yet.</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
                    {['Sequence', 'Enrolled', 'Active', 'Completed', 'Replied', 'Reply Rate'].map(h => (
                      <th key={h} style={{ padding: '9px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sequences.map((s, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '10px 14px', fontWeight: 600, color: '#111827' }}>{s.name}</td>
                      <td style={{ padding: '10px 14px', color: '#374151' }}>{s.enrolled}</td>
                      <td style={{ padding: '10px 14px', color: '#3b82f6' }}>{s.active}</td>
                      <td style={{ padding: '10px 14px', color: '#6b7280' }}>{s.completed}</td>
                      <td style={{ padding: '10px 14px', color: '#059669' }}>{s.replied}</td>
                      <td style={{ padding: '10px 14px', color: '#f59e0b', fontWeight: 600 }}>
                        {s.enrolled > 0 ? `${((s.replied / s.enrolled) * 100).toFixed(1)}%` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* ── PROSPECTS ───────────────────────────────────────────────────── */}
        {tab === 'prospects' && (
          <div>
            {!prospects?.length ? (
              <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>No prospects assigned to this client yet.</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
                    {['Name', 'Title', 'Account', 'Stage', 'Touches', 'Last Outreach'].map(h => (
                      <th key={h} style={{ padding: '9px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {prospects.map((p, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '10px 14px', fontWeight: 600, color: '#111827' }}>{p.first_name} {p.last_name}</td>
                      <td style={{ padding: '10px 14px', color: '#6b7280' }}>{p.title || '—'}</td>
                      <td style={{ padding: '10px 14px', color: '#374151' }}>{p.account_name || '—'}</td>
                      <td style={{ padding: '10px 14px' }}>
                        <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: '#f0fdf4', color: '#065f46', textTransform: 'capitalize' }}>
                          {p.stage}
                        </span>
                      </td>
                      <td style={{ padding: '10px 14px', color: '#374151' }}>{p.outreach_count || 0}</td>
                      <td style={{ padding: '10px 14px', color: '#9ca3af', fontSize: 11 }}>
                        {p.last_outreach_at ? new Date(p.last_outreach_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* ── TEAM ────────────────────────────────────────────────────────── */}
        {tab === 'team' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {!team?.length ? (
              <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>No team members assigned yet.</div>
            ) : team.map((m, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '12px 16px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10,
              }}>
                <div style={{
                  width: 36, height: 36, borderRadius: '50%',
                  background: m.role === 'lead' ? TEAL : '#e5e7eb',
                  color: m.role === 'lead' ? '#fff' : '#6b7280',
                  fontSize: 13, fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {m.first_name?.[0]}{m.last_name?.[0]}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{m.first_name} {m.last_name}</div>
                  <div style={{ fontSize: 11, color: '#9ca3af' }}>{m.email}</div>
                </div>
                <div style={{ fontSize: 11, fontWeight: 600, color: m.role === 'lead' ? TEAL : '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  {m.role}
                </div>
                <div style={{ fontSize: 12, color: '#374151' }}>{m.emails_sent || 0} emails sent</div>
              </div>
            ))}
          </div>
        )}

        {/* ── PORTAL ──────────────────────────────────────────────────────── */}
        {tab === 'portal' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* Portal toggle */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '14px 16px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10,
            }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>Client Portal Access</div>
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                  {client?.portal_enabled ? 'Portal is enabled — invited users can log in' : 'Portal is disabled — invited users cannot log in yet'}
                </div>
              </div>
              <button
                onClick={handleTogglePortal}
                style={{
                  position: 'relative', width: 44, height: 24, borderRadius: 12, border: 'none',
                  background: client?.portal_enabled ? TEAL : '#d1d5db', cursor: 'pointer',
                }}
              >
                <span style={{
                  position: 'absolute', top: 4,
                  left: client?.portal_enabled ? 23 : 4,
                  width: 16, height: 16, borderRadius: '50%',
                  background: '#fff', transition: 'left 0.2s',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                }} />
              </button>
            </div>

            {/* Invite form */}
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '14px 16px' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#111827', marginBottom: 10 }}>Invite Portal User</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="email"
                  placeholder="email@client.com"
                  value={inviteEmail}
                  onChange={e => setInviteEmail(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleInvite()}
                  style={{ flex: 1, padding: '8px 11px', borderRadius: 7, border: '1px solid #e5e7eb', fontSize: 13, fontFamily: 'inherit', color: '#111' }}
                />
                <button
                  onClick={handleInvite}
                  disabled={inviting || !inviteEmail.trim()}
                  style={{
                    padding: '8px 18px', borderRadius: 7, border: 'none',
                    background: inviting ? '#9ca3af' : TEAL, color: '#fff',
                    fontSize: 13, fontWeight: 600, cursor: inviting ? 'not-allowed' : 'pointer',
                  }}
                >
                  {inviting ? 'Sending…' : 'Send Invite'}
                </button>
              </div>
              {inviteMsg && (
                <div style={{ marginTop: 10, fontSize: 12, color: inviteMsg.startsWith('✅') ? '#059669' : '#dc2626', wordBreak: 'break-all' }}>
                  {inviteMsg}
                </div>
              )}
            </div>

            {/* Portal users list */}
            {data?.portalUsers?.length > 0 && (
              <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid #f3f4f6', fontSize: 13, fontWeight: 600, color: '#374151' }}>
                  Portal Users ({data.portalUsers.length})
                </div>
                {data.portalUsers.map((u, i) => (
                  <div key={u.id} style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '11px 16px',
                    borderBottom: i < data.portalUsers.length - 1 ? '1px solid #f3f4f6' : 'none',
                  }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>
                        {u.first_name || ''} {u.last_name || ''} <span style={{ fontWeight: 400, color: '#6b7280' }}>{u.email}</span>
                      </div>
                      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                        {u.accepted_at ? `Last login: ${new Date(u.last_login_at || u.accepted_at).toLocaleDateString()}` : 'Invited — not yet accepted'}
                      </div>
                    </div>
                    <span style={{
                      fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 10,
                      background: u.accepted_at ? '#d1fae5' : '#fef3c7',
                      color: u.accepted_at ? '#065f46' : '#92400e',
                    }}>
                      {u.accepted_at ? 'Active' : 'Pending'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TREND CHART — simple SVG bar chart
// ─────────────────────────────────────────────────────────────────────────────
function TrendChart({ data }) {
  if (!data?.length) return null;
  const maxVal = Math.max(...data.map(d => Math.max(d.sent || 0, d.replies || 0)), 1);
  const W = 560, H = 120, BAR_W = 18, GAP = 8;
  const colW  = BAR_W * 2 + GAP + 12;
  const totalW = data.length * colW;

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${Math.max(totalW, W)} ${H + 36}`} style={{ width: '100%', height: H + 36 }}>
        {data.map((d, i) => {
          const x       = i * colW;
          const sentH   = ((d.sent || 0) / maxVal) * H;
          const repliesH = ((d.replies || 0) / maxVal) * H;
          const label   = new Date(d.week_start).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
          return (
            <g key={i}>
              {/* Sent bar */}
              <rect x={x} y={H - sentH} width={BAR_W} height={sentH}
                fill={TEAL} rx={3} opacity={0.85} />
              {/* Replies bar */}
              <rect x={x + BAR_W + GAP} y={H - repliesH} width={BAR_W} height={repliesH}
                fill="#059669" rx={3} opacity={0.7} />
              {/* Label */}
              <text x={x + BAR_W} y={H + 18} textAnchor="middle"
                fontSize={9} fill="#9ca3af">{label}</text>
            </g>
          );
        })}
        {/* Legend */}
        <rect x={0} y={H + 26} width={10} height={8} fill={TEAL} rx={2} />
        <text x={14} y={H + 34} fontSize={9} fill="#6b7280">Sent</text>
        <rect x={50} y={H + 26} width={10} height={8} fill="#059669" rx={2} />
        <text x={64} y={H + 34} fontSize={9} fill="#6b7280">Replies</text>
      </svg>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CREATE CLIENT MODAL
// ─────────────────────────────────────────────────────────────────────────────
function CreateClientModal({ onSave, onClose }) {
  const [name,       setName]       = useState('');
  const [accountId,  setAccountId]  = useState('');
  const [accounts,   setAccounts]   = useState([]);
  const [startDate,  setStartDate]  = useState('');
  const [notes,      setNotes]      = useState('');
  const [saving,     setSaving]     = useState(false);
  const [error,      setError]      = useState('');

  useEffect(() => {
    apiFetch('/accounts?limit=200')
      .then(r => setAccounts(r.accounts || []))
      .catch(() => {});
  }, []);

  const handleSave = async () => {
    if (!name.trim()) { setError('Client name is required'); return; }
    setSaving(true);
    setError('');
    try {
      await apiFetch('/clients', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          account_id:         accountId ? parseInt(accountId) : null,
          service_start_date: startDate || null,
          service_notes:      notes || null,
        }),
      });
      onSave();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <div style={{
        background: '#fff', borderRadius: 16, padding: '28px 32px',
        width: 480, maxWidth: '95vw', boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
      }}>
        <h3 style={{ margin: '0 0 20px', fontSize: 17, fontWeight: 700, color: '#111827' }}>New Managed Client</h3>

        {error && (
          <div style={{ padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 7, fontSize: 12, color: '#dc2626', marginBottom: 14 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={labelStyle}>Client Name *</label>
            <input value={name} onChange={e => setName(e.target.value)}
              placeholder="e.g. XYZ Ltd"
              style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Link to Account (optional)</label>
            <select value={accountId} onChange={e => setAccountId(e.target.value)} style={inputStyle}>
              <option value="">— select closed-won account —</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Service Start Date</label>
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Notes</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)}
              rows={3} placeholder="Scope of service, special instructions…"
              style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.6 }} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 22 }}>
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
          <button onClick={handleSave} disabled={saving} style={{
            padding: '9px 22px', borderRadius: 8, border: 'none',
            background: saving ? '#9ca3af' : TEAL, color: '#fff',
            fontSize: 13, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer',
          }}>
            {saving ? 'Creating…' : 'Create Client'}
          </button>
        </div>
      </div>
    </div>
  );
}

const labelStyle = {
  display: 'block', fontSize: 11, fontWeight: 600, color: '#6b7280',
  marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.3,
};
const inputStyle = {
  width: '100%', padding: '9px 12px', borderRadius: 8,
  border: '1px solid #e5e7eb', fontSize: 13, boxSizing: 'border-box',
  fontFamily: 'inherit', color: '#111', background: '#fff', outline: 'none',
};
const ghostBtn = {
  padding: '9px 18px', borderRadius: 8, border: '1px solid #e5e7eb',
  background: '#fff', color: '#374151', fontSize: 13, cursor: 'pointer',
};
