/**
 * AgencyView.js
 *
 * Internal agency dashboard for ABC Corp users.
 *
 * Top-level tabs:
 *   Clients | All Prospects | All Sequences
 *
 * Per-client detail tabs:
 *   Overview | Pipeline | Outreach | Sequences | Prospects | Team | Portal | Senders
 */

import React, { useState, useEffect, useCallback } from 'react';

const API  = process.env.REACT_APP_API_URL || '';
const TEAL = '#0F9D8E';

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
  background: '#fff', color: '#374151', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
};
const primaryBtn = (busy) => ({
  padding: '9px 22px', borderRadius: 8, border: 'none',
  background: busy ? '#9ca3af' : TEAL, color: '#fff',
  fontSize: 13, fontWeight: 600, cursor: busy ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
});

// ═════════════════════════════════════════════════════════════════════════════
// MAIN
// ═════════════════════════════════════════════════════════════════════════════
export default function AgencyView() {
  const [topTab,         setTopTab]         = useState('clients');
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

  // Listen for OAuth redirect completing for a client sender
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('prospecting_client_sender_connected') === 'true') {
      const cid = params.get('clientId');
      // Strip query params from URL so a refresh doesn't re-trigger
      window.history.replaceState({}, '', window.location.pathname);
      if (cid) setSelectedClient(parseInt(cid));
    }
  }, []);

  if (selectedClient) {
    return (
      <ClientDetail
        clientId={selectedClient}
        onBack={() => { setSelectedClient(null); loadClients(); }}
      />
    );
  }

  const TOP_TABS = [
    { key: 'clients',      label: '🏢 Clients'      },
    { key: 'allProspects', label: '👥 All Prospects' },
    { key: 'allSequences', label: '📋 All Sequences' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: "'Inter', system-ui, sans-serif" }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px 0', background: '#fff', flexShrink: 0 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: TEAL, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 3 }}>Agency</div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: '#111827' }}>Managed Clients</h2>
        </div>
        {topTab === 'clients' && (
          <button onClick={() => setShowCreate(true)} style={primaryBtn(false)}>+ New Client</button>
        )}
      </div>

      <div style={{ display: 'flex', gap: 2, padding: '10px 20px 0', background: '#fff', borderBottom: '1px solid #e5e7eb', flexShrink: 0 }}>
        {TOP_TABS.map(t => (
          <button key={t.key} onClick={() => setTopTab(t.key)} style={{
            padding: '7px 16px', borderRadius: '8px 8px 0 0', border: 'none', cursor: 'pointer',
            background: topTab === t.key ? '#f9fafb' : 'transparent',
            color: topTab === t.key ? '#111827' : '#6b7280',
            fontSize: 13, fontWeight: topTab === t.key ? 600 : 400,
            borderBottom: topTab === t.key ? `2px solid ${TEAL}` : '2px solid transparent',
            fontFamily: 'inherit',
          }}>{t.label}</button>
        ))}
      </div>

      {error && (
        <div style={{ margin: '12px 24px 0', padding: '10px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, fontSize: 13, color: '#dc2626' }}>⚠️ {error}</div>
      )}

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {topTab === 'clients' && (
          <div style={{ padding: '20px 24px' }}>
            {loading ? (
              <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>Loading clients…</div>
            ) : clients.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 80 }}>
                <div style={{ fontSize: 48, marginBottom: 12 }}>🏢</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#374151', marginBottom: 8 }}>No clients yet</div>
                <div style={{ fontSize: 13, color: '#9ca3af', marginBottom: 20 }}>Promote a closed-won account to a managed client to get started.</div>
                <button onClick={() => setShowCreate(true)} style={primaryBtn(false)}>Create First Client</button>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16 }}>
                {clients.map(client => (
                  <ClientCard key={client.id} client={client} onClick={() => setSelectedClient(client.id)} />
                ))}
              </div>
            )}
          </div>
        )}
        {topTab === 'allProspects' && <AllProspectsTab clients={clients} />}
        {topTab === 'allSequences' && <AllSequencesTab clients={clients} />}
      </div>

      {showCreate && (
        <CreateClientModal onSave={() => { setShowCreate(false); loadClients(); }} onClose={() => setShowCreate(false)} />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ALL PROSPECTS TAB
// ─────────────────────────────────────────────────────────────────────────────
function AllProspectsTab({ clients }) {
  const [prospects,    setProspects]    = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState('');
  const [clientFilter, setClientFilter] = useState('');
  const [stageFilter,  setStageFilter]  = useState('');
  const [search,       setSearch]       = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const qs = clientFilter ? `?client_id=${clientFilter}` : '';
      const r = await apiFetch(`/clients/all/prospects${qs}`);
      setProspects(r.prospects || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [clientFilter]);

  useEffect(() => { load(); }, [load]);

  const stages = [...new Set(prospects.map(p => p.stage))].sort();
  const filtered = prospects.filter(p => {
    if (stageFilter && p.stage !== stageFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return `${p.first_name} ${p.last_name}`.toLowerCase().includes(q)
        || (p.company_name || '').toLowerCase().includes(q)
        || (p.email || '').toLowerCase().includes(q)
        || (p.client_name || '').toLowerCase().includes(q);
    }
    return true;
  });

  return (
    <div style={{ padding: '20px 24px' }}>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <input placeholder="Search name, company, email…" value={search} onChange={e => setSearch(e.target.value)} style={{ ...inputStyle, width: 240 }} />
        <select value={clientFilter} onChange={e => setClientFilter(e.target.value)} style={{ ...inputStyle, width: 180 }}>
          <option value="">All clients</option>
          {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={stageFilter} onChange={e => setStageFilter(e.target.value)} style={{ ...inputStyle, width: 150 }}>
          <option value="">All stages</option>
          {stages.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <div style={{ marginLeft: 'auto', fontSize: 12, color: '#9ca3af' }}>{filtered.length} prospect{filtered.length !== 1 ? 's' : ''}</div>
      </div>
      {error && <div style={{ color: '#dc2626', fontSize: 13, marginBottom: 12 }}>⚠️ {error}</div>}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af', fontSize: 13 }}>
          {prospects.length === 0 ? 'No prospects assigned to any client yet.' : 'No results match your filters.'}
        </div>
      ) : (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
                {['Client','Name','Title','Company','Stage','Emails Sent','Last Outreach'].map(h => (
                  <th key={h} style={{ padding: '9px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((p, i) => (
                <tr key={p.id} style={{ borderBottom: '1px solid #f3f4f6', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                  <td style={{ padding: '10px 14px' }}>
                    <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: '#ede9fe', color: '#5b21b6' }}>{p.client_name || '—'}</span>
                  </td>
                  <td style={{ padding: '10px 14px', fontWeight: 600, color: '#111827', whiteSpace: 'nowrap' }}>{p.first_name} {p.last_name}</td>
                  <td style={{ padding: '10px 14px', color: '#6b7280' }}>{p.title || '—'}</td>
                  <td style={{ padding: '10px 14px', color: '#374151' }}>{p.company_name || p.account_name || '—'}</td>
                  <td style={{ padding: '10px 14px' }}>
                    <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: '#f0fdf4', color: '#065f46', textTransform: 'capitalize' }}>{p.stage}</span>
                  </td>
                  <td style={{ padding: '10px 14px', color: '#374151', textAlign: 'center' }}>{p.outreach_count || 0}</td>
                  <td style={{ padding: '10px 14px', color: '#9ca3af', fontSize: 11 }}>
                    {p.last_outreach_at ? new Date(p.last_outreach_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ALL SEQUENCES TAB
// ─────────────────────────────────────────────────────────────────────────────
function AllSequencesTab({ clients }) {
  const [sequences,    setSequences]    = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState('');
  const [clientFilter, setClientFilter] = useState('');
  const [search,       setSearch]       = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const qs = clientFilter ? `?client_id=${clientFilter}` : '';
      const r = await apiFetch(`/clients/all/sequences${qs}`);
      setSequences(r.sequences || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [clientFilter]);

  useEffect(() => { load(); }, [load]);

  const filtered = sequences.filter(s => {
    if (!search) return true;
    const q = search.toLowerCase();
    return s.sequence_name.toLowerCase().includes(q) || (s.client_name || '').toLowerCase().includes(q);
  });

  return (
    <div style={{ padding: '20px 24px' }}>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <input placeholder="Search sequence or client…" value={search} onChange={e => setSearch(e.target.value)} style={{ ...inputStyle, width: 240 }} />
        <select value={clientFilter} onChange={e => setClientFilter(e.target.value)} style={{ ...inputStyle, width: 180 }}>
          <option value="">All clients</option>
          {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <div style={{ marginLeft: 'auto', fontSize: 12, color: '#9ca3af' }}>{filtered.length} row{filtered.length !== 1 ? 's' : ''}</div>
      </div>
      {error && <div style={{ color: '#dc2626', fontSize: 13, marginBottom: 12 }}>⚠️ {error}</div>}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af', fontSize: 13 }}>
          {sequences.length === 0 ? 'No sequences with client enrollments yet.' : 'No results match your filters.'}
        </div>
      ) : (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
                {['Client','Sequence','Steps','Enrolled','Active','Replied','Reply Rate','Completed','Stopped'].map(h => (
                  <th key={h} style={{ padding: '9px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((s, i) => {
                const replyRate = s.enrolled > 0 ? ((s.replied / s.enrolled) * 100).toFixed(1) : '0.0';
                const rateColor = parseFloat(replyRate) >= 20 ? '#059669' : parseFloat(replyRate) >= 10 ? '#d97706' : '#dc2626';
                return (
                  <tr key={`${s.sequence_id}-${s.client_id}`} style={{ borderBottom: '1px solid #f3f4f6', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                    <td style={{ padding: '10px 14px' }}>
                      <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: '#ede9fe', color: '#5b21b6' }}>{s.client_name}</span>
                    </td>
                    <td style={{ padding: '10px 14px', fontWeight: 600, color: '#111827' }}>{s.sequence_name}</td>
                    <td style={{ padding: '10px 14px', color: '#6b7280', textAlign: 'center' }}>{s.step_count}</td>
                    <td style={{ padding: '10px 14px', color: '#374151', textAlign: 'center' }}>{s.enrolled}</td>
                    <td style={{ padding: '10px 14px', color: '#3b82f6', textAlign: 'center' }}>{s.active}</td>
                    <td style={{ padding: '10px 14px', color: '#059669', textAlign: 'center' }}>{s.replied}</td>
                    <td style={{ padding: '10px 14px', fontWeight: 600, color: rateColor, textAlign: 'center' }}>{replyRate}%</td>
                    <td style={{ padding: '10px 14px', color: '#6b7280', textAlign: 'center' }}>{s.completed}</td>
                    <td style={{ padding: '10px 14px', color: s.stopped > 0 ? '#dc2626' : '#9ca3af', textAlign: 'center' }}>{s.stopped}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
    <div onClick={onClick} style={{ border: '1px solid #e5e7eb', borderRadius: 14, background: '#fff', overflow: 'hidden', cursor: 'pointer', transition: 'all 0.15s', boxShadow: '0 1px 4px rgba(0,0,0,0.05)' }}
      onMouseEnter={e => e.currentTarget.style.boxShadow = '0 4px 16px rgba(15,157,142,0.12)'}
      onMouseLeave={e => e.currentTarget.style.boxShadow = '0 1px 4px rgba(0,0,0,0.05)'}>
      <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#111827', marginBottom: 3 }}>{client.name}</div>
          {client.account_name && <div style={{ fontSize: 11, color: '#9ca3af' }}>{client.account_name} · {client.account_industry || 'N/A'}</div>}
        </div>
        <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600, background: sc.bg, color: sc.color, flexShrink: 0 }}>{sc.label}</span>
      </div>
      <div style={{ display: 'flex', padding: '10px 16px' }}>
        {[
          { label: 'Prospects', value: client.prospect_count || 0,    color: TEAL },
          { label: 'Team',      value: client.team_size || 0,         color: '#6b7280' },
          { label: 'Portal',    value: client.portal_user_count || 0, color: '#8b5cf6' },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ flex: 1, textAlign: 'center', borderRight: '1px solid #f3f4f6', padding: '4px 0' }}>
            <div style={{ fontSize: 18, fontWeight: 700, color }}>{value}</div>
            <div style={{ fontSize: 10, color: '#9ca3af', fontWeight: 500, textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
          </div>
        ))}
        <div style={{ flex: 1, textAlign: 'center', padding: '4px 0' }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: client.portal_enabled ? '#059669' : '#9ca3af' }}>{client.portal_enabled ? '✓' : '—'}</div>
          <div style={{ fontSize: 10, color: '#9ca3af', fontWeight: 500, textTransform: 'uppercase', letterSpacing: 0.3 }}>Portal</div>
        </div>
      </div>
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
  const [tab,         setTab]         = useState('overview');
  const [data,        setData]        = useState(null);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviting,    setInviting]    = useState(false);
  const [inviteMsg,   setInviteMsg]   = useState('');

  const loadDashboard = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const r = await apiFetch(`/clients/${clientId}/dashboard`);
      setData(r);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, [clientId]);

  useEffect(() => { loadDashboard(); }, [loadDashboard]);

  const handleInvite = async () => {
    if (!inviteEmail.trim()) return;
    setInviting(true); setInviteMsg('');
    try {
      const r = await apiFetch(`/clients/${clientId}/portal-users`, { method: 'POST', body: JSON.stringify({ email: inviteEmail.trim() }) });
      setInviteMsg(`✅ Invite sent to ${inviteEmail}. Magic link: ${r.magicLink}`);
      setInviteEmail(''); loadDashboard();
    } catch (err) { setInviteMsg(`⚠️ ${err.message}`); }
    finally { setInviting(false); }
  };

  const handleTogglePortal = async () => {
    try {
      await apiFetch(`/clients/${clientId}`, { method: 'PUT', body: JSON.stringify({ portal_enabled: !data?.client?.portal_enabled }) });
      loadDashboard();
    } catch (err) { setError(err.message); }
  };

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#9ca3af' }}>Loading client…</div>;
  if (error)   return <div style={{ padding: 40, color: '#dc2626' }}>⚠️ {error}</div>;

  const { client, pipeline, outreach, sequences, prospects, weeklyTrend, team, portalUsers, recentActivity } = data || {};

  const TABS = [
    { key: 'overview',  label: '📊 Overview'  },
    { key: 'pipeline',  label: '🎯 Pipeline'  },
    { key: 'outreach',  label: '✉️ Outreach'  },
    { key: 'sequences', label: '📋 Sequences' },
    { key: 'prospects', label: '👥 Prospects' },
    { key: 'team',      label: '🤝 Team'      },
    { key: 'portal',    label: '🔗 Portal'    },
    { key: 'senders',   label: '📧 Senders'   },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: "'Inter', system-ui, sans-serif" }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 24px', borderBottom: '1px solid #e5e7eb', background: '#fff', flexShrink: 0 }}>
        <button onClick={onBack} style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', color: '#6b7280', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>← Back</button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: TEAL, textTransform: 'uppercase', letterSpacing: 1 }}>Client</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: '#111827' }}>{client?.name}</div>
        </div>
        {client?.account_name && <div style={{ fontSize: 12, color: '#9ca3af' }}>via {client.account_name}</div>}
        <span style={{ padding: '4px 12px', borderRadius: 20, fontSize: 11, fontWeight: 600, ...(STATUS_CFG[client?.status] || STATUS_CFG.active) }}>
          {(STATUS_CFG[client?.status] || STATUS_CFG.active).label}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 2, padding: '8px 16px', borderBottom: '1px solid #e5e7eb', background: '#fff', flexShrink: 0, overflowX: 'auto' }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{ padding: '6px 14px', borderRadius: 7, border: 'none', whiteSpace: 'nowrap', background: tab === t.key ? TEAL : 'transparent', color: tab === t.key ? '#fff' : '#6b7280', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>

        {tab === 'overview' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
              {[
                { label: 'Total Prospects', value: prospects?.length || 0,       color: TEAL },
                { label: 'Emails Sent',     value: outreach?.totalSent || 0,     color: '#3b82f6' },
                { label: 'Replies',         value: outreach?.totalReplies || 0,  color: '#059669' },
                { label: 'Reply Rate',      value: `${outreach?.replyRate || 0}%`, color: '#f59e0b' },
              ].map(({ label, value, color }) => (
                <div key={label} style={{ padding: '16px 18px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12 }}>
                  <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>{label}</div>
                  <div style={{ fontSize: 26, fontWeight: 800, color }}>{value}</div>
                </div>
              ))}
            </div>
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '16px 18px' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 12 }}>This Week</div>
              <div style={{ display: 'flex', gap: 20 }}>
                <div><span style={{ fontSize: 22, fontWeight: 700, color: '#3b82f6' }}>{outreach?.sentThisWeek || 0}</span><span style={{ fontSize: 12, color: '#9ca3af', marginLeft: 6 }}>emails sent</span></div>
                <div><span style={{ fontSize: 22, fontWeight: 700, color: '#059669' }}>{outreach?.repliesThisWeek || 0}</span><span style={{ fontSize: 12, color: '#9ca3af', marginLeft: 6 }}>replies</span></div>
              </div>
            </div>
            {weeklyTrend?.length > 0 && (
              <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '16px 18px' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 14 }}>Weekly Outreach Trend</div>
                <TrendChart data={weeklyTrend} />
              </div>
            )}
            {recentActivity?.length > 0 && (
              <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '16px 18px' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 12 }}>Recent Activity</div>
                {recentActivity.map((a, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, marginBottom: 8 }}>
                    <span style={{ fontSize: 14 }}>📌</span>
                    <span style={{ flex: 1, color: '#374151' }}>{a.description}</span>
                    <span style={{ color: '#9ca3af', whiteSpace: 'nowrap' }}>{new Date(a.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

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
                    <div style={{ width: `${(count / maxCount) * 100}%`, height: '100%', background: `linear-gradient(90deg, ${TEAL}, #0d8a7c)`, borderRadius: 6, minWidth: count > 0 ? 24 : 0 }} />
                  </div>
                  <div style={{ width: 30, fontSize: 13, fontWeight: 700, color: TEAL, textAlign: 'right' }}>{count}</div>
                </div>
              );
            })}
          </div>
        )}

        {tab === 'outreach' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
              {[
                { label: 'Total Sent',    value: outreach?.totalSent    || 0,       color: '#3b82f6' },
                { label: 'Total Replies', value: outreach?.totalReplies || 0,       color: '#059669' },
                { label: 'Reply Rate',    value: `${outreach?.replyRate || 0}%`,    color: '#f59e0b' },
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

        {tab === 'sequences' && (
          <SequencesTab clientId={clientId} sequences={sequences} prospects={prospects || []} onRefresh={loadDashboard} />
        )}

        {tab === 'prospects' && (
          <ProspectsTab clientId={clientId} prospects={prospects || []} onRefresh={loadDashboard} />
        )}

        {tab === 'team' && (
          <TeamTab clientId={clientId} team={team || []} onRefresh={loadDashboard} />
        )}

        {tab === 'portal' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>Client Portal Access</div>
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{client?.portal_enabled ? 'Portal is enabled — invited users can log in' : 'Portal is disabled — invited users cannot log in yet'}</div>
              </div>
              <button onClick={handleTogglePortal} style={{ position: 'relative', width: 44, height: 24, borderRadius: 12, border: 'none', background: client?.portal_enabled ? TEAL : '#d1d5db', cursor: 'pointer' }}>
                <span style={{ position: 'absolute', top: 4, left: client?.portal_enabled ? 23 : 4, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }} />
              </button>
            </div>
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '14px 16px' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#111827', marginBottom: 10 }}>Invite Portal User</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="email" placeholder="email@client.com" value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleInvite()} style={{ flex: 1, padding: '8px 11px', borderRadius: 7, border: '1px solid #e5e7eb', fontSize: 13, fontFamily: 'inherit', color: '#111' }} />
                <button onClick={handleInvite} disabled={inviting || !inviteEmail.trim()} style={primaryBtn(inviting || !inviteEmail.trim())}>{inviting ? 'Sending…' : 'Send Invite'}</button>
              </div>
              {inviteMsg && <div style={{ marginTop: 10, fontSize: 12, color: inviteMsg.startsWith('✅') ? '#059669' : '#dc2626', wordBreak: 'break-all' }}>{inviteMsg}</div>}
            </div>
            {(portalUsers || []).length > 0 && (
              <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid #f3f4f6', fontSize: 13, fontWeight: 600, color: '#374151' }}>Portal Users ({portalUsers.length})</div>
                {portalUsers.map((u, i) => (
                  <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', borderBottom: i < portalUsers.length - 1 ? '1px solid #f3f4f6' : 'none' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{u.first_name || ''} {u.last_name || ''} <span style={{ fontWeight: 400, color: '#6b7280' }}>{u.email}</span></div>
                      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{u.accepted_at ? `Last login: ${new Date(u.last_login_at || u.accepted_at).toLocaleDateString()}` : 'Invited — not yet accepted'}</div>
                    </div>
                    <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: u.accepted_at ? '#d1fae5' : '#fef3c7', color: u.accepted_at ? '#065f46' : '#92400e' }}>
                      {u.accepted_at ? 'Active' : 'Pending'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'senders' && (
          <SendersTab clientId={clientId} />
        )}

      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SENDERS TAB (per-client)
//
// Lazy-loads directly from GET /clients/:id/senders — not from the dashboard
// payload, keeping the dashboard query lean.
// ─────────────────────────────────────────────────────────────────────────────
function SendersTab({ clientId }) {
  const [senders,       setSenders]       = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState('');
  const [connecting,    setConnecting]    = useState(''); // 'gmail' | 'outlook' | ''
  const [editingId,     setEditingId]     = useState(null);
  const [removingId,    setRemovingId]    = useState(null);

  const loadSenders = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const r = await apiFetch(`/clients/${clientId}/senders`);
      setSenders(r.senders || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => { loadSenders(); }, [loadSenders]);

  const handleConnect = async (provider) => {
    setConnecting(provider); setError('');
    try {
      const r = await apiFetch(`/clients/${clientId}/senders/connect-url?provider=${provider}`);
      // Open OAuth in a new tab so the user returns to the same client view
      window.open(r.authUrl, '_blank', 'noopener,noreferrer');
      // The redirect lands on /?prospecting_client_sender_connected=true&clientId=...
      // AgencyView's useEffect catches that and re-opens ClientDetail on the Senders tab
    } catch (err) {
      setError(err.message);
    } finally {
      setConnecting('');
    }
  };

  const handleToggleActive = async (sender) => {
    try {
      const r = await apiFetch(`/clients/${clientId}/senders/${sender.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !sender.isActive }),
      });
      setSenders(prev => prev.map(s => s.id === sender.id ? r.sender : s));
    } catch (err) {
      setError(err.message);
    }
  };

  const handleRemove = async (sender) => {
    if (!window.confirm(`Remove ${sender.email} from this client's sender accounts?`)) return;
    setRemovingId(sender.id); setError('');
    try {
      await apiFetch(`/clients/${clientId}/senders/${sender.id}`, { method: 'DELETE' });
      setSenders(prev => prev.filter(s => s.id !== sender.id));
    } catch (err) {
      setError(err.message);
    } finally {
      setRemovingId(null);
    }
  };

  const PROVIDER_CFG = {
    gmail:   { label: 'Gmail',   icon: '🔵', color: '#4285F4' },
    outlook: { label: 'Outlook', icon: '🟠', color: '#0078D4' },
  };

  return (
    <div>
      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>Client Sender Accounts</div>
          <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
            Outreach emails to this client's prospects will be sent from these mailboxes.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => handleConnect('gmail')}
            disabled={!!connecting}
            style={{ ...ghostBtn, fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}
          >
            🔵 {connecting === 'gmail' ? 'Opening…' : 'Connect Gmail'}
          </button>
          <button
            onClick={() => handleConnect('outlook')}
            disabled={!!connecting}
            style={{ ...ghostBtn, fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}
          >
            🟠 {connecting === 'outlook' ? 'Opening…' : 'Connect Outlook'}
          </button>
        </div>
      </div>

      {error && <ErrorBox msg={error} />}

      {/* ── Empty state ── */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Loading…</div>
      ) : senders.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 48, background: '#f9fafb', borderRadius: 12, border: '1px dashed #e5e7eb' }}>
          <div style={{ fontSize: 32, marginBottom: 10 }}>📧</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#374151', marginBottom: 6 }}>No sender accounts connected</div>
          <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 18, maxWidth: 340, margin: '0 auto 18px' }}>
            Connect a Gmail or Outlook mailbox branded for this client.
            Sequence emails will be sent from here instead of the rep's personal account.
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            <button onClick={() => handleConnect('gmail')}   disabled={!!connecting} style={primaryBtn(false)}>🔵 Connect Gmail</button>
            <button onClick={() => handleConnect('outlook')} disabled={!!connecting} style={{ ...primaryBtn(false), background: '#0078D4' }}>🟠 Connect Outlook</button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {senders.map(sender => (
            <SenderCard
              key={sender.id}
              sender={sender}
              clientId={clientId}
              providerCfg={PROVIDER_CFG[sender.provider] || {}}
              isEditing={editingId === sender.id}
              isRemoving={removingId === sender.id}
              onEdit={() => setEditingId(editingId === sender.id ? null : sender.id)}
              onToggleActive={() => handleToggleActive(sender)}
              onRemove={() => handleRemove(sender)}
              onSaved={(updated) => {
                setSenders(prev => prev.map(s => s.id === updated.id ? updated : s));
                setEditingId(null);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SENDER CARD — individual sender row with inline edit
// ─────────────────────────────────────────────────────────────────────────────
function SenderCard({ sender, clientId, providerCfg, isEditing, isRemoving, onEdit, onToggleActive, onRemove, onSaved }) {
  const [label,       setLabel]       = useState(sender.label || '');
  const [displayName, setDisplayName] = useState(sender.displayName || '');
  const [signature,   setSignature]   = useState(sender.signature || '');
  const [dailyLimit,  setDailyLimit]  = useState(sender.dailyLimit ?? '');
  const [saving,      setSaving]      = useState(false);
  const [saveErr,     setSaveErr]     = useState('');

  // Sync fields if parent updates sender (e.g. after toggle)
  useEffect(() => {
    setLabel(sender.label || '');
    setDisplayName(sender.displayName || '');
    setSignature(sender.signature || '');
    setDailyLimit(sender.dailyLimit ?? '');
  }, [sender]);

  const handleSave = async () => {
    setSaving(true); setSaveErr('');
    try {
      const r = await apiFetch(`/clients/${clientId}/senders/${sender.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          label:       label       || null,
          displayName: displayName || null,
          signature:   signature   || null,
          dailyLimit:  dailyLimit !== '' ? parseInt(dailyLimit) : null,
        }),
      });
      onSaved(r.sender);
    } catch (err) {
      setSaveErr(err.message);
      setSaving(false);
    }
  };

  const todayCount = sender.emailsSentToday || 0;
  const limitLabel = sender.dailyLimit ? `${todayCount} / ${sender.dailyLimit} today` : `${todayCount} sent today`;

  return (
    <div style={{ background: '#fff', border: `1px solid ${isEditing ? TEAL : '#e5e7eb'}`, borderRadius: 12, overflow: 'hidden', transition: 'border-color 0.15s' }}>
      {/* ── Row ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px' }}>
        {/* Provider badge */}
        <div style={{ width: 36, height: 36, borderRadius: 8, background: '#f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0 }}>
          {providerCfg.icon || '📧'}
        </div>

        {/* Email + meta */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {sender.label ? `${sender.label} — ` : ''}{sender.email}
          </div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
            {providerCfg.label} · {limitLabel}
            {sender.lastSentAt && ` · Last sent ${new Date(sender.lastSentAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`}
          </div>
        </div>

        {/* Active toggle */}
        <button
          onClick={onToggleActive}
          title={sender.isActive ? 'Deactivate' : 'Activate'}
          style={{ position: 'relative', width: 38, height: 22, borderRadius: 11, border: 'none', background: sender.isActive ? TEAL : '#d1d5db', cursor: 'pointer', flexShrink: 0 }}
        >
          <span style={{ position: 'absolute', top: 3, left: sender.isActive ? 19 : 3, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }} />
        </button>

        {/* Edit / Remove */}
        <button onClick={onEdit} style={{ ...ghostBtn, padding: '5px 12px', fontSize: 12 }}>
          {isEditing ? 'Cancel' : 'Edit'}
        </button>
        <button
          onClick={onRemove}
          disabled={isRemoving}
          style={{ padding: '5px 12px', borderRadius: 7, border: '1px solid #fecaca', background: '#fff', color: '#dc2626', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}
        >
          {isRemoving ? '…' : 'Remove'}
        </button>
      </div>

      {/* ── Inline edit panel ── */}
      {isEditing && (
        <div style={{ padding: '0 16px 16px', borderTop: '1px solid #f3f4f6', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {saveErr && <ErrorBox msg={saveErr} />}
          <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Label (internal)</label>
              <input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Client outreach" style={inputStyle} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Display Name (From:)</label>
              <input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="e.g. Acme Sales Team" style={inputStyle} />
            </div>
            <div style={{ width: 130 }}>
              <label style={labelStyle}>Daily Limit</label>
              <input type="number" min="1" value={dailyLimit} onChange={e => setDailyLimit(e.target.value)} placeholder="—" style={inputStyle} />
            </div>
          </div>
          <div>
            <label style={labelStyle}>Email Signature</label>
            <textarea
              value={signature}
              onChange={e => setSignature(e.target.value)}
              rows={4}
              placeholder="Signature appended to all outreach emails from this account…"
              style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.6 }}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button onClick={onEdit} style={ghostBtn}>Cancel</button>
            <button onClick={handleSave} disabled={saving} style={primaryBtn(saving)}>
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PROSPECTS TAB (per-client)
// ─────────────────────────────────────────────────────────────────────────────
function ProspectsTab({ clientId, prospects, onRefresh }) {
  const [showAdd, setShowAdd] = useState(false);
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <button onClick={() => setShowAdd(true)} style={primaryBtn(false)}>+ Add Prospect</button>
      </div>
      {!prospects.length ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>No prospects assigned to this client yet.</div>
      ) : (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
                {['Name','Title','Account','Stage','Touches','Last Outreach'].map(h => (
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
                    <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: '#f0fdf4', color: '#065f46', textTransform: 'capitalize' }}>{p.stage}</span>
                  </td>
                  <td style={{ padding: '10px 14px', color: '#374151' }}>{p.outreach_count || 0}</td>
                  <td style={{ padding: '10px 14px', color: '#9ca3af', fontSize: 11 }}>
                    {p.last_outreach_at ? new Date(p.last_outreach_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {showAdd && <AddProspectModal clientId={clientId} onSave={() => { setShowAdd(false); onRefresh(); }} onClose={() => setShowAdd(false)} />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SEQUENCES TAB (per-client)
// ─────────────────────────────────────────────────────────────────────────────
function SequencesTab({ clientId, sequences, prospects, onRefresh }) {
  const [showEnroll, setShowEnroll] = useState(false);
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <button onClick={() => setShowEnroll(true)} style={primaryBtn(!prospects.length)} disabled={!prospects.length}>
          + Enroll in Sequence
        </button>
      </div>
      {!sequences?.length ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>
          No sequences with enrolled prospects yet.{!prospects.length && ' Add prospects first.'}
        </div>
      ) : (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
                {['Sequence','Enrolled','Active','Completed','Replied','Stopped','Reply Rate'].map(h => (
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
                  <td style={{ padding: '10px 14px', color: s.stopped > 0 ? '#dc2626' : '#9ca3af' }}>{s.stopped || 0}</td>
                  <td style={{ padding: '10px 14px', color: '#f59e0b', fontWeight: 600 }}>
                    {s.enrolled > 0 ? `${((s.replied / s.enrolled) * 100).toFixed(1)}%` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {showEnroll && <EnrollSequenceModal clientId={clientId} prospects={prospects} onSave={() => { setShowEnroll(false); onRefresh(); }} onClose={() => setShowEnroll(false)} />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TEAM TAB (per-client)
// ─────────────────────────────────────────────────────────────────────────────
function TeamTab({ clientId, team, onRefresh }) {
  const [showAdd,  setShowAdd]  = useState(false);
  const [removing, setRemoving] = useState(null);
  const [error,    setError]    = useState('');

  const handleRemove = async (userId, name) => {
    if (!window.confirm(`Remove ${name} from this client's team?`)) return;
    setRemoving(userId); setError('');
    try {
      await apiFetch(`/clients/${clientId}/team/${userId}`, { method: 'DELETE' });
      onRefresh();
    } catch (err) { setError(err.message); }
    finally { setRemoving(null); }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 13, color: '#6b7280' }}>{team.length} member{team.length !== 1 ? 's' : ''} assigned</div>
        <button onClick={() => setShowAdd(true)} style={primaryBtn(false)}>+ Add Member</button>
      </div>
      {error && <div style={{ color: '#dc2626', fontSize: 12, marginBottom: 10 }}>⚠️ {error}</div>}
      {!team.length ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>No team members assigned yet.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {team.map((m, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10 }}>
              <div style={{ width: 36, height: 36, borderRadius: '50%', background: m.role === 'lead' ? TEAL : '#e5e7eb', color: m.role === 'lead' ? '#fff' : '#6b7280', fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {m.first_name?.[0]}{m.last_name?.[0]}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{m.first_name} {m.last_name}</div>
                <div style={{ fontSize: 11, color: '#9ca3af' }}>{m.email}</div>
              </div>
              <div style={{ fontSize: 11, fontWeight: 600, color: m.role === 'lead' ? TEAL : '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5 }}>{m.role}</div>
              <div style={{ fontSize: 12, color: '#374151' }}>{m.emails_sent || 0} emails sent</div>
              <button onClick={() => handleRemove(m.user_id || m.id, `${m.first_name} ${m.last_name}`)} disabled={removing === (m.user_id || m.id)} style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid #fecaca', background: '#fff', color: '#dc2626', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit' }}>
                {removing === (m.user_id || m.id) ? '…' : 'Remove'}
              </button>
            </div>
          ))}
        </div>
      )}
      {showAdd && <AddMemberModal clientId={clientId} onSave={() => { setShowAdd(false); onRefresh(); }} onClose={() => setShowAdd(false)} />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ADD PROSPECT MODAL
// ─────────────────────────────────────────────────────────────────────────────
function AddProspectModal({ clientId, onSave, onClose }) {
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', title: '', companyName: '', stage: 'target', source: 'agency' });
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState('');
  const set = (k, v) => setForm(prev => ({ ...prev, [k]: v }));

  const handleSave = async () => {
    if (!form.firstName.trim() || !form.lastName.trim()) { setError('First and last name are required'); return; }
    setSaving(true); setError('');
    try {
      await apiFetch('/prospects', {
        method: 'POST',
        body: JSON.stringify({
          firstName:   form.firstName.trim(),
          lastName:    form.lastName.trim(),
          email:       form.email.trim() || undefined,
          title:       form.title.trim() || undefined,
          companyName: form.companyName.trim() || undefined,
          stage:       form.stage,
          source:      form.source,
          client_id:   parseInt(clientId),
        }),
      });
      onSave();
    } catch (err) { setError(err.message); setSaving(false); }
  };

  return (
    <Modal title="Add Prospect" onClose={onClose}>
      {error && <ErrorBox msg={error} />}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1 }}><label style={labelStyle}>First Name *</label><input value={form.firstName} onChange={e => set('firstName', e.target.value)} style={inputStyle} placeholder="First name" /></div>
          <div style={{ flex: 1 }}><label style={labelStyle}>Last Name *</label><input value={form.lastName} onChange={e => set('lastName', e.target.value)} style={inputStyle} placeholder="Last name" /></div>
        </div>
        <div><label style={labelStyle}>Email</label><input type="email" value={form.email} onChange={e => set('email', e.target.value)} style={inputStyle} placeholder="email@company.com" /></div>
        <div><label style={labelStyle}>Job Title</label><input value={form.title} onChange={e => set('title', e.target.value)} style={inputStyle} placeholder="e.g. VP Sales" /></div>
        <div><label style={labelStyle}>Company</label><input value={form.companyName} onChange={e => set('companyName', e.target.value)} style={inputStyle} placeholder="Company name" /></div>
        <div>
          <label style={labelStyle}>Stage</label>
          <select value={form.stage} onChange={e => set('stage', e.target.value)} style={inputStyle}>
            {STAGE_ORDER.map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
          </select>
        </div>
      </div>
      <ModalFooter onClose={onClose} onSave={handleSave} saving={saving} saveLabel="Add Prospect" />
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ENROLL SEQUENCE MODAL
// ─────────────────────────────────────────────────────────────────────────────
function EnrollSequenceModal({ clientId, prospects, onSave, onClose }) {
  const [sequences,         setSequences]         = useState([]);
  const [selectedSeq,       setSelectedSeq]       = useState('');
  const [selectedProspects, setSelectedProspects] = useState([]);
  const [enrolledIds,       setEnrolledIds]       = useState(new Set());
  const [saving,            setSaving]            = useState(false);
  const [error,             setError]             = useState('');

  useEffect(() => {
    apiFetch('/sequences').then(r => setSequences((r.sequences || []).filter(s => s.status === 'active'))).catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedSeq) { setEnrolledIds(new Set()); return; }
    apiFetch(`/sequences/enrollments?sequenceId=${selectedSeq}&status=active`)
      .then(r => setEnrolledIds(new Set((r.enrollments || []).map(e => e.prospect_id))))
      .catch(() => setEnrolledIds(new Set()));
  }, [selectedSeq]);

  const toggleProspect = (id) => {
    if (enrolledIds.has(id)) return;
    setSelectedProspects(prev => prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]);
  };

  const handleSave = async () => {
    if (!selectedSeq)              { setError('Select a sequence'); return; }
    if (!selectedProspects.length) { setError('Select at least one prospect'); return; }
    setSaving(true); setError('');
    try {
      await apiFetch('/sequences/enroll', { method: 'POST', body: JSON.stringify({ sequenceId: parseInt(selectedSeq), prospectIds: selectedProspects }) });
      onSave();
    } catch (err) { setError(err.message); setSaving(false); }
  };

  const availableProspects = prospects.filter(p => !enrolledIds.has(p.id));

  return (
    <Modal title="Enroll Prospects in Sequence" onClose={onClose} wide>
      {error && <ErrorBox msg={error} />}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label style={labelStyle}>Sequence *</label>
          <select value={selectedSeq} onChange={e => { setSelectedSeq(e.target.value); setSelectedProspects([]); }} style={inputStyle}>
            <option value="">— select sequence —</option>
            {sequences.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label style={labelStyle}>
            Prospects *&nbsp;
            <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: '#9ca3af' }}>
              ({selectedProspects.length} selected · {enrolledIds.size} already enrolled)
            </span>
          </label>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, maxHeight: 220, overflowY: 'auto' }}>
            {prospects.length === 0 ? (
              <div style={{ padding: 16, color: '#9ca3af', fontSize: 12 }}>No prospects for this client.</div>
            ) : prospects.map((p, i) => {
              const alreadyEnrolled = enrolledIds.has(p.id);
              const selected = selectedProspects.includes(p.id);
              return (
                <div key={p.id} onClick={() => toggleProspect(p.id)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', borderBottom: i < prospects.length - 1 ? '1px solid #f3f4f6' : 'none', background: selected ? '#f0fdf4' : '#fff', cursor: alreadyEnrolled ? 'default' : 'pointer', opacity: alreadyEnrolled ? 0.5 : 1 }}>
                  <div style={{ width: 16, height: 16, borderRadius: 4, border: `2px solid ${selected ? TEAL : '#d1d5db'}`, background: selected ? TEAL : '#fff', flexShrink: 0 }} />
                  <div style={{ flex: 1, fontSize: 13, color: '#111827' }}>{p.first_name} {p.last_name}</div>
                  <div style={{ fontSize: 11, color: '#9ca3af' }}>{p.title || ''}</div>
                  {alreadyEnrolled && <span style={{ fontSize: 10, color: '#9ca3af', fontWeight: 600 }}>ENROLLED</span>}
                </div>
              );
            })}
          </div>
          {availableProspects.length > 0 && (
            <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
              <button onClick={() => setSelectedProspects(availableProspects.map(p => p.id))} style={{ ...ghostBtn, fontSize: 11, padding: '4px 10px' }}>Select all available</button>
              {selectedProspects.length > 0 && <button onClick={() => setSelectedProspects([])} style={{ ...ghostBtn, fontSize: 11, padding: '4px 10px' }}>Clear</button>}
            </div>
          )}
        </div>
      </div>
      <ModalFooter onClose={onClose} onSave={handleSave} saving={saving} saveLabel={`Enroll ${selectedProspects.length || ''} Prospect${selectedProspects.length !== 1 ? 's' : ''}`} />
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ADD MEMBER MODAL
// ─────────────────────────────────────────────────────────────────────────────
function AddMemberModal({ clientId, onSave, onClose }) {
  const [members, setMembers] = useState([]);
  const [userId,  setUserId]  = useState('');
  const [role,    setRole]    = useState('member');
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState('');

  useEffect(() => {
    apiFetch(`/clients/${clientId}/available-members`).then(r => setMembers(r.members || [])).catch(() => {});
  }, [clientId]);

  const handleSave = async () => {
    if (!userId) { setError('Select a team member'); return; }
    setSaving(true); setError('');
    try {
      await apiFetch(`/clients/${clientId}/team`, { method: 'POST', body: JSON.stringify({ user_id: parseInt(userId), role }) });
      onSave();
    } catch (err) { setError(err.message); setSaving(false); }
  };

  return (
    <Modal title="Add Team Member" onClose={onClose}>
      {error && <ErrorBox msg={error} />}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label style={labelStyle}>Team Member *</label>
          <select value={userId} onChange={e => setUserId(e.target.value)} style={inputStyle}>
            <option value="">— select member —</option>
            {members.map(m => <option key={m.id} value={m.id}>{m.first_name} {m.last_name} ({m.email})</option>)}
          </select>
          {members.length === 0 && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>All org members are already on this client's team.</div>}
        </div>
        <div>
          <label style={labelStyle}>Role</label>
          <select value={role} onChange={e => setRole(e.target.value)} style={inputStyle}>
            <option value="member">Member</option>
            <option value="lead">Lead</option>
          </select>
        </div>
      </div>
      <ModalFooter onClose={onClose} onSave={handleSave} saving={saving} saveLabel="Add to Team" />
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CREATE CLIENT MODAL
// ─────────────────────────────────────────────────────────────────────────────
function CreateClientModal({ onSave, onClose }) {
  const [name,      setName]      = useState('');
  const [accountId, setAccountId] = useState('');
  const [accounts,  setAccounts]  = useState([]);
  const [startDate, setStartDate] = useState('');
  const [notes,     setNotes]     = useState('');
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState('');

  useEffect(() => { apiFetch('/accounts?limit=200').then(r => setAccounts(r.accounts || [])).catch(() => {}); }, []);

  const handleSave = async () => {
    if (!name.trim()) { setError('Client name is required'); return; }
    setSaving(true); setError('');
    try {
      await apiFetch('/clients', { method: 'POST', body: JSON.stringify({ name: name.trim(), account_id: accountId ? parseInt(accountId) : null, service_start_date: startDate || null, service_notes: notes || null }) });
      onSave();
    } catch (err) { setError(err.message); setSaving(false); }
  };

  return (
    <Modal title="New Managed Client" onClose={onClose}>
      {error && <ErrorBox msg={error} />}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div><label style={labelStyle}>Client Name *</label><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. XYZ Ltd" style={inputStyle} /></div>
        <div>
          <label style={labelStyle}>Link to Account (optional)</label>
          <select value={accountId} onChange={e => setAccountId(e.target.value)} style={inputStyle}>
            <option value="">— select closed-won account —</option>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <div><label style={labelStyle}>Service Start Date</label><input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={inputStyle} /></div>
        <div><label style={labelStyle}>Notes</label><textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} placeholder="Scope of service, special instructions…" style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.6 }} /></div>
      </div>
      <ModalFooter onClose={onClose} onSave={handleSave} saving={saving} saveLabel="Create Client" />
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────
function Modal({ title, children, onClose, wide = false }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: '28px 32px', width: wide ? 580 : 480, maxWidth: '95vw', boxShadow: '0 20px 60px rgba(0,0,0,0.15)', maxHeight: '90vh', overflowY: 'auto' }}>
        <h3 style={{ margin: '0 0 20px', fontSize: 17, fontWeight: 700, color: '#111827' }}>{title}</h3>
        {children}
      </div>
    </div>
  );
}

function ModalFooter({ onClose, onSave, saving, saveLabel = 'Save' }) {
  return (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 22 }}>
      <button onClick={onClose} style={ghostBtn}>Cancel</button>
      <button onClick={onSave} disabled={saving} style={primaryBtn(saving)}>{saving ? 'Saving…' : saveLabel}</button>
    </div>
  );
}

function ErrorBox({ msg }) {
  return <div style={{ padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 7, fontSize: 12, color: '#dc2626', marginBottom: 14 }}>{msg}</div>;
}

// ─────────────────────────────────────────────────────────────────────────────
// TREND CHART
// ─────────────────────────────────────────────────────────────────────────────
function TrendChart({ data }) {
  if (!data?.length) return null;
  const maxVal = Math.max(...data.map(d => Math.max(d.sent || 0, d.replies || 0)), 1);
  const H = 120, BAR_W = 18, GAP = 8;
  const colW   = BAR_W * 2 + GAP + 12;
  const totalW = data.length * colW;
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${Math.max(totalW, 560)} ${H + 36}`} style={{ width: '100%', height: H + 36 }}>
        {data.map((d, i) => {
          const x        = i * colW;
          const sentH    = ((d.sent || 0) / maxVal) * H;
          const repliesH = ((d.replies || 0) / maxVal) * H;
          const label    = new Date(d.week_start).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
          return (
            <g key={i}>
              <rect x={x} y={H - sentH} width={BAR_W} height={sentH} fill={TEAL} rx={3} opacity={0.85} />
              <rect x={x + BAR_W + GAP} y={H - repliesH} width={BAR_W} height={repliesH} fill="#059669" rx={3} opacity={0.7} />
              <text x={x + BAR_W} y={H + 18} textAnchor="middle" fontSize={9} fill="#9ca3af">{label}</text>
            </g>
          );
        })}
        <rect x={0} y={H + 26} width={10} height={8} fill={TEAL} rx={2} />
        <text x={14} y={H + 34} fontSize={9} fill="#6b7280">Sent</text>
        <rect x={50} y={H + 26} width={10} height={8} fill="#059669" rx={2} />
        <text x={64} y={H + 34} fontSize={9} fill="#6b7280">Replies</text>
      </svg>
    </div>
  );
}
