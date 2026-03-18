/**
 * ClientPortalView.js
 *
 * Read-only dashboard for client portal users (XYZ Ltd).
 * Accessed via /portal/auth?token=... → stores portal JWT → renders this.
 *
 * Routes handled here:
 *   /portal/auth?token=...   — magic link landing, exchanges token → session
 *   /portal                  — main dashboard (requires portal session)
 */

import React, { useState, useEffect, useCallback } from 'react';

const API  = process.env.REACT_APP_API_URL || '';
const TEAL = '#0F9D8E';

function portalFetch(path, options = {}) {
  const token = localStorage.getItem('portalToken');
  return fetch(`${API}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
    ...options,
  }).then(r => {
    if (!r.ok) return r.json().then(e => Promise.reject(new Error(e?.error?.message || r.statusText)));
    return r.json();
  });
}

const STAGE_ORDER   = ['target','researched','contacted','engaged','qualified','converted'];
const STAGE_COLORS  = {
  target:     '#6b7280',
  researched: '#8b5cf6',
  contacted:  '#3b82f6',
  engaged:    TEAL,
  qualified:  '#10b981',
  converted:  '#059669',
};

// ═════════════════════════════════════════════════════════════════════════════
// MAGIC LINK HANDLER — /portal/auth?token=...
// ═════════════════════════════════════════════════════════════════════════════
export function PortalAuthPage() {
  const [status, setStatus] = useState('loading'); // loading | success | error
  const [message, setMessage] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token  = params.get('token');

    if (!token) {
      setStatus('error');
      setMessage('No authentication token found in this link. Please request a new invite.');
      return;
    }

    portalFetch('/portal/auth/magic-link', {
      method: 'POST',
      body: JSON.stringify({ token }),
    })
      .then(r => {
        localStorage.setItem('portalToken', r.token);
        localStorage.setItem('portalUser',  JSON.stringify(r.portalUser));
        setStatus('success');
        // Redirect to portal dashboard
        setTimeout(() => { window.location.href = '/portal'; }, 800);
      })
      .catch(err => {
        setStatus('error');
        setMessage(err.message);
      });
  }, []);

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(135deg, #f0fdf4 0%, #e6f7f6 100%)',
      fontFamily: "'Inter', system-ui, sans-serif",
    }}>
      <div style={{
        background: '#fff', borderRadius: 16, padding: '40px 48px',
        maxWidth: 420, width: '90vw', textAlign: 'center',
        boxShadow: '0 8px 32px rgba(0,0,0,0.08)',
      }}>
        <div style={{ fontSize: 36, marginBottom: 16 }}>
          {status === 'loading' ? '⏳' : status === 'success' ? '✅' : '❌'}
        </div>
        <h2 style={{ margin: '0 0 10px', fontSize: 18, fontWeight: 700, color: '#111827' }}>
          {status === 'loading' ? 'Signing you in…'
            : status === 'success' ? 'Welcome!'
            : 'Link expired'}
        </h2>
        <p style={{ margin: 0, fontSize: 13, color: '#6b7280', lineHeight: 1.6 }}>
          {status === 'loading' ? 'Verifying your magic link…'
            : status === 'success' ? 'Redirecting to your dashboard…'
            : message}
        </p>
        {status === 'error' && (
          <div style={{ marginTop: 20, padding: '10px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, fontSize: 12, color: '#dc2626' }}>
            Please contact your account manager to get a new link.
          </div>
        )}
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN PORTAL DASHBOARD
// ═════════════════════════════════════════════════════════════════════════════
export default function ClientPortalView() {
  const [tab,      setTab]      = useState('overview');
  const [data,     setData]     = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState('');
  const [user,     setUser]     = useState(() => {
    try { return JSON.parse(localStorage.getItem('portalUser') || '{}'); } catch { return {}; }
  });

  // Case creation
  const [showCase,    setShowCase]    = useState(false);
  const [caseTitle,   setCaseTitle]   = useState('');
  const [caseDesc,    setCaseDesc]    = useState('');
  const [casePriority,setCasePriority] = useState('medium');
  const [submitting,  setSubmitting]  = useState(false);
  const [caseMsg,     setCaseMsg]     = useState('');

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const r = await portalFetch('/portal/dashboard');
      setData(r);
    } catch (err) {
      if (err.message.includes('expired') || err.message.includes('authentication')) {
        localStorage.removeItem('portalToken');
        localStorage.removeItem('portalUser');
        window.location.href = '/portal/expired';
      } else {
        setError(err.message);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadDashboard(); }, [loadDashboard]);

  const handleSubmitCase = async () => {
    if (!caseTitle.trim()) return;
    setSubmitting(true);
    setCaseMsg('');
    try {
      await portalFetch('/portal/cases', {
        method: 'POST',
        body: JSON.stringify({ title: caseTitle, description: caseDesc, priority: casePriority }),
      });
      setCaseMsg('✅ Case submitted — your account manager will be in touch.');
      setCaseTitle(''); setCaseDesc(''); setCasePriority('medium');
      setShowCase(false);
      loadDashboard();
    } catch (err) {
      setCaseMsg(`⚠️ ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#f9fafb', fontFamily: "'Inter', system-ui, sans-serif",
    }}>
      <div style={{ textAlign: 'center', color: '#9ca3af' }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
        Loading your dashboard…
      </div>
    </div>
  );

  if (error) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'Inter', system-ui, sans-serif" }}>
      <div style={{ textAlign: 'center', color: '#dc2626' }}>⚠️ {error}</div>
    </div>
  );

  const { client, pipeline, outreach, sequences, prospects, weeklyTrend, openCases } = data || {};

  const TABS = [
    { key: 'overview',  label: '📊 Overview'  },
    { key: 'pipeline',  label: '🎯 Pipeline'  },
    { key: 'outreach',  label: '✉️ Activity'  },
    { key: 'sequences', label: '📋 Sequences' },
    { key: 'prospects', label: '👥 Prospects' },
    { key: 'support',   label: `🎫 Support${openCases?.length ? ` (${openCases.length})` : ''}` },
  ];

  return (
    <div style={{
      minHeight: '100vh', background: '#f9fafb',
      fontFamily: "'Inter', system-ui, sans-serif",
    }}>

      {/* Top nav */}
      <div style={{
        background: '#fff', borderBottom: '1px solid #e5e7eb',
        padding: '0 24px', display: 'flex', alignItems: 'center',
        height: 56, gap: 16, position: 'sticky', top: 0, zIndex: 100,
        boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
      }}>
        {client?.logo_url ? (
          <img src={client.logo_url} alt={client.name} style={{ height: 28, objectFit: 'contain' }} />
        ) : (
          <div style={{ fontSize: 20, fontWeight: 800, color: TEAL }}>{client?.name}</div>
        )}
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 12, color: '#9ca3af' }}>
          Welcome, {user.firstName || user.email}
        </div>
        <button
          onClick={() => { localStorage.removeItem('portalToken'); localStorage.removeItem('portalUser'); window.location.href = '/'; }}
          style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', color: '#6b7280', fontSize: 12, cursor: 'pointer' }}
        >
          Sign out
        </button>
      </div>

      {/* Hero banner */}
      <div style={{
        background: `linear-gradient(135deg, ${TEAL} 0%, #0d8a7c 100%)`,
        padding: '28px 32px', color: '#fff',
      }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.5, opacity: 0.8, marginBottom: 6 }}>
          Prospecting Dashboard
        </div>
        <div style={{ fontSize: 24, fontWeight: 800, marginBottom: 4 }}>{client?.name}</div>
        {client?.service_start_date && (
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            Service since {new Date(client.service_start_date).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
          </div>
        )}

        {/* KPIs in hero */}
        <div style={{ display: 'flex', gap: 24, marginTop: 20, flexWrap: 'wrap' }}>
          {[
            { label: 'Prospects',  value: prospects?.length || 0 },
            { label: 'Emails Sent', value: outreach?.totalSent || 0 },
            { label: 'Replies',    value: outreach?.totalReplies || 0 },
            { label: 'Reply Rate', value: `${outreach?.replyRate || 0}%` },
          ].map(({ label, value }) => (
            <div key={label}>
              <div style={{ fontSize: 26, fontWeight: 800 }}>{value}</div>
              <div style={{ fontSize: 11, opacity: 0.75, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Tab bar */}
      <div style={{
        background: '#fff', borderBottom: '1px solid #e5e7eb',
        padding: '0 24px', display: 'flex', gap: 0, overflowX: 'auto',
      }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: '14px 16px', border: 'none', borderBottom: `2px solid ${tab === t.key ? TEAL : 'transparent'}`,
            background: 'none', color: tab === t.key ? TEAL : '#6b7280',
            fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
          }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '28px 24px' }}>

        {/* ── OVERVIEW ──────────────────────────────────────────────────── */}
        {tab === 'overview' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 16 }}>

              {/* Pipeline snapshot */}
              <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: '18px 20px' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 14 }}>Pipeline</div>
                {STAGE_ORDER.map(stage => {
                  const row   = pipeline?.find(p => p.stage === stage);
                  const count = row?.count || 0;
                  const max   = Math.max(...(pipeline?.map(p => p.count) || [1]), 1);
                  return (
                    <div key={stage} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                      <div style={{ width: 80, fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'capitalize' }}>{stage}</div>
                      <div style={{ flex: 1, height: 18, background: '#f3f4f6', borderRadius: 4, overflow: 'hidden' }}>
                        <div style={{
                          width: `${(count / max) * 100}%`, height: '100%',
                          background: STAGE_COLORS[stage] || TEAL, borderRadius: 4,
                          minWidth: count > 0 ? 20 : 0,
                          transition: 'width 0.4s ease',
                        }} />
                      </div>
                      <div style={{ width: 24, fontSize: 12, fontWeight: 700, color: '#374151', textAlign: 'right' }}>{count}</div>
                    </div>
                  );
                })}
              </div>

              {/* Weekly trend */}
              <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: '18px 20px' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 14 }}>Weekly Activity</div>
                {weeklyTrend?.length ? <PortalTrendChart data={weeklyTrend} /> : (
                  <div style={{ color: '#9ca3af', fontSize: 12, textAlign: 'center', padding: 20 }}>No trend data yet</div>
                )}
              </div>
            </div>

            {/* This week highlight */}
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: '18px 20px' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 12 }}>This Week</div>
              <div style={{ display: 'flex', gap: 32 }}>
                <div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: '#3b82f6' }}>{outreach?.sentThisWeek || 0}</div>
                  <div style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.4 }}>Emails Sent</div>
                </div>
                <div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: '#059669' }}>{outreach?.repliesThisWeek || 0}</div>
                  <div style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.4 }}>Replies Received</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── PIPELINE ──────────────────────────────────────────────────── */}
        {tab === 'pipeline' && (
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: '18px 20px' }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#374151', marginBottom: 16 }}>Prospect Pipeline by Stage</div>
            {STAGE_ORDER.map(stage => {
              const row   = pipeline?.find(p => p.stage === stage);
              const count = row?.count || 0;
              const max   = Math.max(...(pipeline?.map(p => p.count) || [1]), 1);
              return (
                <div key={stage} style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 12 }}>
                  <div style={{ width: 100, fontSize: 12, fontWeight: 600, color: '#374151', textTransform: 'capitalize' }}>{stage}</div>
                  <div style={{ flex: 1, height: 28, background: '#f3f4f6', borderRadius: 6, overflow: 'hidden' }}>
                    <div style={{
                      width: `${(count / max) * 100}%`, height: '100%',
                      background: STAGE_COLORS[stage] || TEAL,
                      borderRadius: 6, transition: 'width 0.5s ease',
                      minWidth: count > 0 ? 28 : 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 8,
                    }}>
                      {count > 0 && <span style={{ fontSize: 11, fontWeight: 700, color: '#fff' }}>{count}</span>}
                    </div>
                  </div>
                  {count === 0 && <div style={{ width: 28, fontSize: 12, color: '#d1d5db' }}>0</div>}
                </div>
              );
            })}
          </div>
        )}

        {/* ── ACTIVITY / OUTREACH ───────────────────────────────────────── */}
        {tab === 'outreach' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
              {[
                { label: 'Total Emails Sent', value: outreach?.totalSent || 0,    color: '#3b82f6' },
                { label: 'Replies Received',  value: outreach?.totalReplies || 0, color: '#059669' },
                { label: 'Reply Rate',        value: `${outreach?.replyRate || 0}%`, color: TEAL },
              ].map(({ label, value, color }) => (
                <div key={label} style={{ padding: '16px 18px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12 }}>
                  <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>{label}</div>
                  <div style={{ fontSize: 28, fontWeight: 800, color }}>{value}</div>
                </div>
              ))}
            </div>
            {weeklyTrend?.length > 0 && (
              <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '18px 20px' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 14 }}>Week-over-Week Trend</div>
                <PortalTrendChart data={weeklyTrend} />
              </div>
            )}
          </div>
        )}

        {/* ── SEQUENCES ─────────────────────────────────────────────────── */}
        {tab === 'sequences' && (
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, overflow: 'hidden' }}>
            {!sequences?.length ? (
              <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No sequences running yet.</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
                    {['Sequence', 'Enrolled', 'Active', 'Completed', 'Replied', 'Reply Rate'].map(h => (
                      <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sequences.map((s, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '12px 16px', fontWeight: 600, color: '#111827' }}>{s.name}</td>
                      <td style={{ padding: '12px 16px', color: '#374151' }}>{s.enrolled}</td>
                      <td style={{ padding: '12px 16px', color: '#3b82f6', fontWeight: 600 }}>{s.active}</td>
                      <td style={{ padding: '12px 16px', color: '#6b7280' }}>{s.completed}</td>
                      <td style={{ padding: '12px 16px', color: '#059669', fontWeight: 600 }}>{s.replied}</td>
                      <td style={{ padding: '12px 16px', color: TEAL, fontWeight: 700 }}>
                        {s.enrolled > 0 ? `${((s.replied / s.enrolled) * 100).toFixed(1)}%` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* ── PROSPECTS ─────────────────────────────────────────────────── */}
        {tab === 'prospects' && (
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, overflow: 'hidden' }}>
            {!prospects?.length ? (
              <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No prospects yet.</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
                    {['Name', 'Title', 'Company', 'Stage', 'Touches', 'Last Contact'].map(h => (
                      <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {prospects.map((p, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '11px 16px', fontWeight: 600, color: '#111827' }}>{p.first_name} {p.last_name}</td>
                      <td style={{ padding: '11px 16px', color: '#6b7280' }}>{p.title || '—'}</td>
                      <td style={{ padding: '11px 16px', color: '#374151' }}>{p.account_name || '—'}</td>
                      <td style={{ padding: '11px 16px' }}>
                        <span style={{
                          padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                          background: `${STAGE_COLORS[p.stage] || '#6b7280'}18`,
                          color: STAGE_COLORS[p.stage] || '#6b7280',
                          textTransform: 'capitalize',
                        }}>
                          {p.stage}
                        </span>
                      </td>
                      <td style={{ padding: '11px 16px', color: '#374151', textAlign: 'center' }}>{p.outreach_count || 0}</td>
                      <td style={{ padding: '11px 16px', color: '#9ca3af', fontSize: 11 }}>
                        {p.last_outreach_at ? new Date(p.last_outreach_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* ── SUPPORT ───────────────────────────────────────────────────── */}
        {tab === 'support' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {caseMsg && (
              <div style={{ padding: '10px 14px', background: caseMsg.startsWith('✅') ? '#f0fdf4' : '#fef2f2', borderRadius: 8, fontSize: 13, color: caseMsg.startsWith('✅') ? '#065f46' : '#dc2626' }}>
                {caseMsg}
              </div>
            )}

            <button
              onClick={() => setShowCase(v => !v)}
              style={{
                padding: '10px 20px', borderRadius: 8, border: 'none',
                background: TEAL, color: '#fff', fontSize: 13, fontWeight: 600,
                cursor: 'pointer', alignSelf: 'flex-start',
              }}
            >
              + Raise a Support Case
            </button>

            {showCase && (
              <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '18px 20px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div>
                    <label style={portalLabelStyle}>Title *</label>
                    <input value={caseTitle} onChange={e => setCaseTitle(e.target.value)}
                      placeholder="Brief description of the issue"
                      style={portalInputStyle} />
                  </div>
                  <div>
                    <label style={portalLabelStyle}>Description</label>
                    <textarea value={caseDesc} onChange={e => setCaseDesc(e.target.value)}
                      placeholder="More detail…" rows={4}
                      style={{ ...portalInputStyle, resize: 'vertical', lineHeight: 1.6 }} />
                  </div>
                  <div>
                    <label style={portalLabelStyle}>Priority</label>
                    <select value={casePriority} onChange={e => setCasePriority(e.target.value)} style={portalInputStyle}>
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                    </select>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => setShowCase(false)} style={{ padding: '8px 16px', borderRadius: 7, border: '1px solid #e5e7eb', background: '#fff', color: '#374151', fontSize: 13, cursor: 'pointer' }}>
                      Cancel
                    </button>
                    <button onClick={handleSubmitCase} disabled={submitting || !caseTitle.trim()} style={{
                      padding: '8px 20px', borderRadius: 7, border: 'none',
                      background: submitting ? '#9ca3af' : TEAL, color: '#fff',
                      fontSize: 13, fontWeight: 600, cursor: submitting ? 'not-allowed' : 'pointer',
                    }}>
                      {submitting ? 'Submitting…' : 'Submit Case'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {openCases?.length > 0 && (
              <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid #f3f4f6', fontSize: 13, fontWeight: 600, color: '#374151' }}>
                  Open Cases ({openCases.length})
                </div>
                {openCases.map((c, i) => (
                  <div key={c.id} style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '12px 16px',
                    borderBottom: i < openCases.length - 1 ? '1px solid #f3f4f6' : 'none',
                  }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{c.title}</div>
                      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                        {new Date(c.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                      </div>
                    </div>
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10, textTransform: 'uppercase',
                      background: c.priority === 'high' ? '#fee2e2' : c.priority === 'medium' ? '#fef3c7' : '#f3f4f6',
                      color: c.priority === 'high' ? '#dc2626' : c.priority === 'medium' ? '#92400e' : '#6b7280',
                    }}>
                      {c.priority}
                    </span>
                    <span style={{
                      fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 10,
                      background: '#eff6ff', color: '#3b82f6',
                    }}>
                      {c.status}
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
// PORTAL TREND CHART
// ─────────────────────────────────────────────────────────────────────────────
function PortalTrendChart({ data }) {
  if (!data?.length) return null;
  const maxVal = Math.max(...data.map(d => Math.max(d.sent || 0, d.replies || 0)), 1);
  const H = 100, BAR_W = 16, GAP = 6;
  const colW = BAR_W * 2 + GAP + 10;

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${data.length * colW + 20} ${H + 30}`} style={{ width: '100%', height: H + 30 }}>
        {data.map((d, i) => {
          const x  = i * colW;
          const sH = ((d.sent || 0) / maxVal) * H;
          const rH = ((d.replies || 0) / maxVal) * H;
          const label = new Date(d.week_start).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
          return (
            <g key={i}>
              <rect x={x} y={H - sH} width={BAR_W} height={sH} fill="#3b82f6" rx={3} opacity={0.8} />
              <rect x={x + BAR_W + GAP} y={H - rH} width={BAR_W} height={rH} fill="#059669" rx={3} opacity={0.8} />
              <text x={x + BAR_W} y={H + 16} textAnchor="middle" fontSize={8} fill="#9ca3af">{label}</text>
            </g>
          );
        })}
        <rect x={0} y={H + 22} width={8} height={6} fill="#3b82f6" rx={1} />
        <text x={12} y={H + 28} fontSize={8} fill="#6b7280">Sent</text>
        <rect x={42} y={H + 22} width={8} height={6} fill="#059669" rx={1} />
        <text x={54} y={H + 28} fontSize={8} fill="#6b7280">Replies</text>
      </svg>
    </div>
  );
}

const portalLabelStyle = {
  display: 'block', fontSize: 11, fontWeight: 600, color: '#6b7280',
  marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.3,
};
const portalInputStyle = {
  width: '100%', padding: '9px 12px', borderRadius: 8,
  border: '1px solid #e5e7eb', fontSize: 13, boxSizing: 'border-box',
  fontFamily: 'inherit', color: '#111', background: '#fff', outline: 'none',
};
