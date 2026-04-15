// ProspectingView v1.2 — Sequences feature added
import React, { useState, useEffect, useCallback, createContext, useContext } from 'react';

import OutreachComposer from './OutreachComposer';
import CoverageScorecard from './CoverageScorecard';
import StrapPanel from './StrapPanel';
import CSVImportModal from './CSVImportModal';
import SequenceBuilder from './SequenceBuilder';
import SequenceEnrollModal from './SequenceEnrollModal';
import './ProspectingView.css';
import './OutreachComposer.css';

// ── Constants ────────────────────────────────────────────────────────────────

// Fallback stages used while loading or if API fails
const DEFAULT_PROSPECT_STAGES = [
  { key: 'target',        label: 'Target',               icon: '🎯', color: '#6b7280' },
  { key: 'research',      label: 'Research',             icon: '🔍', color: '#8b5cf6' },
  { key: 'outreach',      label: 'Outreach',             icon: '📤', color: '#3b82f6' },
  { key: 'engaged',       label: 'Engaged',              icon: '💬', color: '#0F9D8E' },
  { key: 'discovery_call',label: 'Sales Discovery Call', icon: '📞', color: '#f59e0b' },
  { key: 'qualified_sal', label: 'Sales Accepted Lead (SAL)', icon: '✅', color: '#10b981' },
];

const DEFAULT_TERMINAL_STAGES = [
  { key: 'converted',    label: 'Converted',    icon: '🎉', color: '#059669' },
  { key: 'disqualified', label: 'Disqualified', icon: '❌', color: '#ef4444' },
  { key: 'nurture',      label: 'Nurture',      icon: '🌱', color: '#f59e0b' },
];

const STAGE_ICONS = {
  targeting: '🎯', research: '🔍', outreach: '📤', engagement: '💬',
  qualification: '✅', converted: '🎉', disqualified: '❌', nurture: '🌱', custom: '⚙️',
};

// ── Stages Context — avoids prop-drilling stages through every child ────────
const StagesContext = createContext({
  prospectStages: DEFAULT_PROSPECT_STAGES,
  terminalStages: DEFAULT_TERMINAL_STAGES,
  allStages: [...DEFAULT_PROSPECT_STAGES, ...DEFAULT_TERMINAL_STAGES],
});
const useStages = () => useContext(StagesContext);

const CHANNEL_ICONS = {
  email:    '✉️',
  linkedin: '🔗',
  phone:    '📞',
  sms:      '💬',
  whatsapp: '📱',
};

const TEAL = '#0F9D8E';

// ── LinkedIn constants ───────────────────────────────────────────────────────

const LI_EVENTS = [
  { key: 'request_sent', label: 'Request Sent',   color: '#2563eb', bg: '#eff6ff', dot: '#2563eb' },
  { key: 'connected',    label: 'Connected',      color: '#059669', bg: '#ecfdf5', dot: '#059669' },
  { key: 'message_sent', label: 'Message Sent',   color: '#d97706', bg: '#fffbeb', dot: '#d97706' },
  { key: 'replied',      label: 'Reply Received', color: '#0F9D8E', bg: '#f0fdfa', dot: '#0F9D8E' },
];

const LI_STATUS_LABELS = {
  request_sent: 'Request sent',
  connected:    'Connected',
  message_sent: 'Messaged',
  replied:      'Replied',
};

function getLiStatus(prospect) {
  return prospect?.channel_data?.linkedin?.connection_status || null;
}

function getLiDotColor(status) {
  const ev = LI_EVENTS.find(e => e.key === status);
  return ev ? ev.dot : '#d1d5db';
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const API = process.env.REACT_APP_API_URL || '';


let _refreshPromise = null;

async function _refreshToken() {
  if (_refreshPromise) return _refreshPromise;
  _refreshPromise = fetch(`${API}/auth/refresh`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('token') || localStorage.getItem('authToken')}`,
    },
  }).then(async r => {
    if (!r.ok) throw new Error('refresh_failed');
    const { token } = await r.json();
    localStorage.setItem('token', token);
    return token;
  }).finally(() => { _refreshPromise = null; });
  return _refreshPromise;
}

function apiFetch(path, options = {}, _isRetry = false) {
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  return fetch(`${API}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  }).then(async r => {
    if (r.ok) return r.json();
    let errBody = {};
    try { errBody = await r.json(); } catch (_) {}
    const errMsg = errBody?.error?.message || r.statusText;
    if (r.status === 403 && errMsg === 'Invalid or expired token' && !_isRetry) {
      try {
        await _refreshToken();
        return apiFetch(path, options, true);
      } catch {
        localStorage.removeItem('token');
        localStorage.removeItem('authToken');
        localStorage.removeItem('user');
        window.location.href = '/login';
        return new Promise(() => {});
      }
    }
    return Promise.reject(new Error(errMsg));
  });
}

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function timeAgo(d) {
  if (!d) return '';
  const diff = Date.now() - new Date(d).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function stripHtml(str) {
  if (!str) return '';
  return str.replace(/(<([^>]+)>)/gi, '');
}

// ── ProspectingView ──────────────────────────────────────────────────────────

export default function ProspectingView() {
  const [prospects, setProspects] = useState([]);
  const [pipelineSummary, setPipelineSummary] = useState({ pipeline: [], metrics: {} });
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState('mine');
  const [viewMode, setViewMode] = useState('pipeline'); // pipeline | list | account
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedProspect, setSelectedProspect] = useState(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);

  const handleImportProspects = async (rows) => {
    const res = await apiFetch('/prospects/bulk', {
      method: 'POST',
      body: JSON.stringify({ prospects: rows, source: 'csv_import' }),
    });
    fetchProspects();
    return res; // { imported, skipped, errors }
  };

  // Dynamic stages from API
  const [PROSPECT_STAGES, setProspectStages] = useState(DEFAULT_PROSPECT_STAGES);
  const [TERMINAL_STAGES, setTerminalStages] = useState(DEFAULT_TERMINAL_STAGES);
  const ALL_STAGES = [...PROSPECT_STAGES, ...TERMINAL_STAGES];

  // Fetch org-customised prospect stages
  useEffect(() => {
    apiFetch('/pipeline-stages/prospecting')
      .then(data => {
        const stages = (data.stages || []).sort((a, b) => a.sort_order - b.sort_order);
        if (stages.length > 0) {
          const active    = stages.filter(s => s.is_active && !s.is_terminal);
          const terminal  = stages.filter(s => s.is_active && s.is_terminal);
          setProspectStages(active.map(s => ({
            key: s.key, label: s.name,
            icon: STAGE_ICONS[s.stage_type] || '⚙️',
            color: s.color || '#6b7280',
          })));
          setTerminalStages(terminal.map(s => ({
            key: s.key, label: s.name,
            icon: STAGE_ICONS[s.stage_type] || '⚙️',
            color: s.color || '#6b7280',
          })));
        }
      })
      .catch(() => { /* fallback to defaults */ });
  }, []);

  // Check if user has team
  const user = JSON.parse(localStorage.getItem('user') || '{}');
  const hasTeam = user.subordinateIds?.length > 0 || user.role === 'manager' || user.role === 'admin';

  // ── Data fetching ──────────────────────────────────────────────────────────

  const fetchProspects = useCallback(async () => {
    try {
      setLoading(true);
      const params = {};
      if (searchQuery) params.search = searchQuery;

      const [prospectsRes, summaryRes] = await Promise.all([
        apiFetch(`/prospects?scope=${scope}${searchQuery ? `&search=${encodeURIComponent(searchQuery)}` : ''}`),
        apiFetch(`/prospects/pipeline/summary?scope=${scope}`),
      ]);

      setProspects(prospectsRes.prospects || []);
      setPipelineSummary(summaryRes);
    } catch (err) {
      console.error('Failed to fetch prospects:', err);
    } finally {
      setLoading(false);
    }
  }, [scope, searchQuery]);

  useEffect(() => { fetchProspects(); }, [fetchProspects]);

  // ── Stage change handler ───────────────────────────────────────────────────

  const handleStageChange = async (prospectId, newStage, reason) => {
    try {
      await apiFetch(`/prospects/${prospectId}/stage`, {
        method: 'POST',
        body: JSON.stringify({ stage: newStage, reason }),
      });
      fetchProspects();
    } catch (err) {
      alert(err.message);
    }
  };

  // ── Create prospect ────────────────────────────────────────────────────────

  const handleCreateProspect = async (data) => {
    try {
      await apiFetch('/prospects', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      setShowCreateForm(false);
      fetchProspects();
    } catch (err) {
      alert(err.message);
    }
  };

  // ── Group by stage for pipeline ────────────────────────────────────────────

  const groupedByStage = {};
  PROSPECT_STAGES.forEach(s => {
    groupedByStage[s.key] = prospects.filter(p => p.stage === s.key);
  });

  // Terminal counts
  const convertedCount = prospects.filter(p => p.stage === 'converted').length;
  const disqualifiedCount = prospects.filter(p => p.stage === 'disqualified').length;
  const nurtureCount = prospects.filter(p => p.stage === 'nurture').length;

  // ── Group by account for account view ──────────────────────────────────────

  const groupedByAccount = {};
  prospects.forEach(p => {
    const key = p.account_id || p.company_name || 'Unlinked';
    if (!groupedByAccount[key]) {
      groupedByAccount[key] = {
        accountId: p.account_id,
        accountName: p.account?.name || p.company_name || 'Unlinked',
        domain: p.account?.domain || p.company_domain,
        prospects: [],
      };
    }
    groupedByAccount[key].prospects.push(p);
  });

  // ── Metrics bar ────────────────────────────────────────────────────────────

  const totalActive = prospects.filter(p => !['converted', 'disqualified'].includes(p.stage)).length;

  // LinkedIn funnel metrics (computed from channel_data on loaded prospects)
  const liMetrics = React.useMemo(() => {
    const sent      = prospects.filter(p => p.channel_data?.linkedin?.connection_status).length;
    const connected = prospects.filter(p => ['connected','message_sent','replied'].includes(p.channel_data?.linkedin?.connection_status)).length;
    const messaged  = prospects.filter(p => ['message_sent','replied'].includes(p.channel_data?.linkedin?.connection_status)).length;
    const replied   = prospects.filter(p => p.channel_data?.linkedin?.connection_status === 'replied').length;
    const acceptRate = sent > 0 ? Math.round((connected / sent) * 100) : null;
    const replyRate  = messaged > 0 ? Math.round((replied / messaged) * 100) : null;
    return { sent, connected, messaged, replied, acceptRate, replyRate };
  }, [prospects]);

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────────

  const stagesCtx = { prospectStages: PROSPECT_STAGES, terminalStages: TERMINAL_STAGES, allStages: ALL_STAGES };

  return (
    <StagesContext.Provider value={stagesCtx}>
    <div className="pv-container">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="pv-header">
        <div className="pv-header-left">
          <h2 className="pv-title">
            <span style={{ color: TEAL }}>🎯</span> Prospecting
          </h2>

          {hasTeam && (
            <div className="pv-scope-toggle">
              {['mine', 'team', 'org'].map(s => (
                <button
                  key={s}
                  onClick={() => setScope(s)}
                  className={`pv-scope-btn ${scope === s ? 'active' : ''}`}
                >
                  {s === 'mine' ? 'My Prospects' : s === 'team' ? 'My Team' : 'All Org'}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="pv-header-right">
          <div className="pv-search">
            <input
              type="text"
              placeholder="Search prospects..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="pv-search-input"
            />
          </div>

          <div className="pv-view-toggle">
            {[
              { key: 'pipeline',  icon: '▦',  label: 'Pipeline' },
              { key: 'list',      icon: '≡',  label: 'List' },
              { key: 'account',   icon: '🏢', label: 'Accounts' },
              { key: 'inbox',     icon: '📥', label: 'Inbox' },
              { key: 'sequences', icon: '📨', label: 'Sequences' },
            ].map(v => (
              <button
                key={v.key}
                onClick={() => setViewMode(v.key)}
                className={`pv-view-btn ${viewMode === v.key ? 'active' : ''}`}
                title={v.label}
              >
                {v.icon}
              </button>
            ))}
          </div>

          <button className="pv-btn-secondary" onClick={() => {
            window.dispatchEvent(new CustomEvent('navigate', { detail: { tab: 'playbooks', playbookFilter: 'prospecting' } }));
          }}>
            📋 Playbooks
          </button>

          <button className="pv-btn-secondary" onClick={() => setShowImportModal(true)}>
            ⬆ Import CSV
          </button>

          <button className="pv-add-btn" onClick={() => setShowCreateForm(true)}>
            + Add Prospect
          </button>
        </div>
      </div>

      {/* ── Metrics Bar ────────────────────────────────────────────────────── */}
      <div className="pv-metrics-bar">
        <div className="pv-metric">
          <span className="pv-metric-value">{totalActive}</span>
          <span className="pv-metric-label">Active</span>
        </div>
        {PROSPECT_STAGES.map(s => {
          const count = (groupedByStage[s.key] || []).length;
          return (
            <div className="pv-metric" key={s.key}>
              <span className="pv-metric-value" style={{ color: s.color }}>{count}</span>
              <span className="pv-metric-label">{s.label}</span>
            </div>
          );
        })}
        <div className="pv-metric-separator" />
        <div className="pv-metric">
          <span className="pv-metric-value" style={{ color: '#059669' }}>{convertedCount}</span>
          <span className="pv-metric-label">Converted</span>
        </div>
        <div className="pv-metric">
          <span className="pv-metric-value" style={{ color: '#f59e0b' }}>
            {pipelineSummary.metrics?.outreachThisWeek || 0}
          </span>
          <span className="pv-metric-label">Outreach / wk</span>
        </div>
        <div className="pv-metric">
          <span className="pv-metric-value" style={{ color: TEAL }}>
            {pipelineSummary.metrics?.responsesThisWeek || 0}
          </span>
          <span className="pv-metric-label">Responses / wk</span>
        </div>
      </div>

      {/* ── LinkedIn Funnel Strip ───────────────────────────────────────────── */}
      {liMetrics.sent > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 0,
          background: '#f8fafc', border: '1px solid #e2e8f0',
          borderRadius: 8, padding: '8px 16px', marginBottom: 12, flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#0077B5', marginRight: 12, display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ background: '#0077B5', color: '#fff', borderRadius: 3, padding: '1px 5px', fontSize: 10, fontWeight: 700 }}>in</span>
            LinkedIn Funnel
          </span>
          {[
            { label: 'Requests',  value: liMetrics.sent,      rate: null },
            { label: 'Connected', value: liMetrics.connected, rate: liMetrics.acceptRate != null ? `${liMetrics.acceptRate}% accepted` : null },
            { label: 'Messaged',  value: liMetrics.messaged,  rate: null },
            { label: 'Replied',   value: liMetrics.replied,   rate: liMetrics.replyRate != null ? `${liMetrics.replyRate}% reply rate` : null },
          ].map((step, i) => (
            <React.Fragment key={step.label}>
              {i > 0 && <span style={{ color: '#cbd5e1', fontSize: 16, margin: '0 8px' }}>›</span>}
              <div style={{ textAlign: 'center' }}>
                <span style={{ fontSize: 16, fontWeight: 700, color: '#1e293b' }}>{step.value}</span>
                <span style={{ fontSize: 11, color: '#64748b', marginLeft: 4 }}>{step.label}</span>
                {step.rate && (
                  <span style={{ fontSize: 10, color: '#059669', marginLeft: 6, fontWeight: 600 }}>{step.rate}</span>
                )}
              </div>
            </React.Fragment>
          ))}
        </div>
      )}

      {/* ── Content Area ───────────────────────────────────────────────────── */}
      {loading ? (
        <div className="pv-loading">Loading prospects...</div>
      ) : viewMode === 'pipeline' ? (
        <PipelineBoard
          stages={PROSPECT_STAGES}
          groupedByStage={groupedByStage}
          onSelect={setSelectedProspect}
          onStageChange={handleStageChange}
          terminalCounts={{ converted: convertedCount, disqualified: disqualifiedCount, nurture: nurtureCount }}
        />
      ) : viewMode === 'list' ? (
        <ListView
          prospects={prospects}
          onSelect={setSelectedProspect}
        />
      ) : viewMode === 'account' ? (
        <AccountView
          groups={Object.values(groupedByAccount)}
          onSelect={setSelectedProspect}
        />
      ) : viewMode === 'sequences' ? (
        <SequencesView prospects={prospects} />
      ) : (
        <ProspectingInbox scope={scope} />
      )}

      {/* ── Create Form Modal ──────────────────────────────────────────────── */}
      {showCreateForm && (
        <ProspectCreateModal
          onSave={handleCreateProspect}
          onClose={() => setShowCreateForm(false)}
        />
      )}

      {/* ── CSV Import Modal ───────────────────────────────────────────────── */}
      {showImportModal && (
        <CSVImportModal
          entity="prospects"
          onImport={handleImportProspects}
          onClose={() => setShowImportModal(false)}
        />
      )}

      {/* ── Detail Panel ───────────────────────────────────────────────────── */}
      {selectedProspect && (
        <ProspectDetailPanel
          prospectId={selectedProspect.id || selectedProspect}
          onClose={() => setSelectedProspect(null)}
          onUpdate={fetchProspects}
        />
      )}

    </div>
    </StagesContext.Provider>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// PIPELINE BOARD
// ═════════════════════════════════════════════════════════════════════════════

function PipelineBoard({ stages, groupedByStage, onSelect, onStageChange, terminalCounts }) {
  const { terminalStages } = useStages();
  return (
    <div className="pv-pipeline">
      <div className="pv-pipeline-columns">
        {stages.map(stage => (
          <div key={stage.key} className="pv-pipeline-col">
            <div className="pv-col-header">
              <span className="pv-col-icon">{stage.icon}</span>
              <span className="pv-col-label">{stage.label}</span>
              <span className="pv-col-count">{(groupedByStage[stage.key] || []).length}</span>
            </div>
            <div className="pv-col-body">
              {(groupedByStage[stage.key] || []).map(p => (
                <ProspectCard key={p.id} prospect={p} onClick={() => onSelect(p)} />
              ))}
              {(groupedByStage[stage.key] || []).length === 0 && (
                <div className="pv-col-empty">No prospects</div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Terminal stage footer */}
      <div className="pv-pipeline-footer">
        {terminalStages.map(s => (
          <span key={s.key} className="pv-terminal-badge" style={{ color: s.color }}>
            {s.icon} {s.label}: {terminalCounts[s.key] || 0}
          </span>
        ))}
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// PROSPECT CARD (used in pipeline)
// ═════════════════════════════════════════════════════════════════════════════

function ProspectCard({ prospect: p, onClick }) {
  return (
    <div className="pv-card" onClick={onClick}>
      <div className="pv-card-top">
        <span className="pv-card-name">{p.first_name} {p.last_name}</span>
        {p.icp_score != null && (
          <span className="pv-card-icp" title="ICP Score">
            {p.icp_score}
          </span>
        )}
      </div>

      {p.title && <div className="pv-card-title">{p.title}</div>}
      {(p.company_name || p.account?.name) && (
        <div className="pv-card-company">{p.account?.name || p.company_name}</div>
      )}

      <div className="pv-card-bottom">
        {p.preferred_channel && (
          <span className="pv-card-channel" title={p.preferred_channel}>
            {CHANNEL_ICONS[p.preferred_channel] || '📨'}
          </span>
        )}
        {p.outreach_count > 0 && (
          <span className="pv-card-touches" title="Outreach touches">
            {p.outreach_count} touch{p.outreach_count !== 1 ? 'es' : ''}
          </span>
        )}
        {p.last_outreach_at && (
          <span className="pv-card-last" title="Last outreach">
            {timeAgo(p.last_outreach_at)}
          </span>
        )}
        {getLiStatus(p) && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: getLiDotColor(getLiStatus(p)) }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: getLiDotColor(getLiStatus(p)), flexShrink: 0 }} />
            {LI_STATUS_LABELS[getLiStatus(p)]}
          </span>
        )}
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// LIST VIEW
// ═════════════════════════════════════════════════════════════════════════════

function ListView({ prospects, onSelect }) {
  const { allStages } = useStages();
  return (
    <div className="pv-list">
      <table className="pv-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Company</th>
            <th>Title</th>
            <th>Stage</th>
            <th>Channel</th>
            <th>LinkedIn</th>
            <th>Outreach</th>
            <th>Last Touch</th>
            <th>ICP</th>
          </tr>
        </thead>
        <tbody>
          {prospects.map(p => {
            const stageCfg = allStages.find(s => s.key === p.stage);
            return (
              <tr key={p.id} onClick={() => onSelect(p)} className="pv-table-row">
                <td className="pv-table-name">
                  {p.first_name} {p.last_name}
                  {p.email && <span className="pv-table-email">{p.email}</span>}
                </td>
                <td>{p.account?.name || p.company_name || '—'}</td>
                <td>{p.title || '—'}</td>
                <td>
                  <span className="pv-stage-badge" style={{ background: stageCfg?.color + '20', color: stageCfg?.color }}>
                    {stageCfg?.icon} {stageCfg?.label}
                  </span>
                </td>
                <td>{CHANNEL_ICONS[p.preferred_channel] || '—'}</td>
                <td>
                  {getLiStatus(p) ? (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: getLiDotColor(getLiStatus(p)) }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: getLiDotColor(getLiStatus(p)), flexShrink: 0 }} />
                      {LI_STATUS_LABELS[getLiStatus(p)]}
                    </span>
                  ) : '—'}
                </td>
                <td>{p.outreach_count || 0}</td>
                <td>{p.last_outreach_at ? timeAgo(p.last_outreach_at) : '—'}</td>
                <td>{p.icp_score != null ? p.icp_score : '—'}</td>
              </tr>
            );
          })}
          {prospects.length === 0 && (
            <tr><td colSpan="9" className="pv-table-empty">No prospects found</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// ACCOUNT VIEW
// ═════════════════════════════════════════════════════════════════════════════

function AccountView({ groups, onSelect }) {
  const { allStages } = useStages();
  return (
    <div className="pv-account-view">
      {groups.sort((a, b) => b.prospects.length - a.prospects.length).map((group, idx) => (
        <div key={idx} className="pv-account-group">
          <div className="pv-account-header">
            <span className="pv-account-name">
              🏢 {group.accountName}
              {group.domain && <span className="pv-account-domain">{group.domain}</span>}
            </span>
            <span className="pv-account-count">{group.prospects.length} prospect{group.prospects.length !== 1 ? 's' : ''}</span>
          </div>
          {/* Coverage scorecard for linked accounts */}
          {group.accountId && (
            <div style={{ padding: '0 12px 8px' }}>
              <CoverageScorecard accountId={group.accountId} />
            </div>
          )}
          <div className="pv-account-prospects">
            {group.prospects.map(p => {
              const stageCfg = allStages.find(s => s.key === p.stage);
              return (
                <div key={p.id} className="pv-account-prospect-row" onClick={() => onSelect(p)}>
                  <span className="pv-apr-name">{p.first_name} {p.last_name}</span>
                  <span className="pv-apr-title">{p.title || ''}</span>
                  <span className="pv-stage-badge" style={{ background: stageCfg?.color + '20', color: stageCfg?.color }}>
                    {stageCfg?.icon} {stageCfg?.label}
                  </span>
                  <span className="pv-apr-touches">{p.outreach_count || 0} touches</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {groups.length === 0 && (
        <div className="pv-empty-state">
          <p>No prospects found. Add a prospect to get started!</p>
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// PROSPECT CREATE MODAL
// ═════════════════════════════════════════════════════════════════════════════

function ProspectCreateModal({ onSave, onClose }) {
  const [form, setForm] = useState({
    firstName: '', lastName: '', email: '', phone: '', linkedinUrl: '',
    title: '', location: '', companyName: '', companyDomain: '',
    companySize: '', companyIndustry: '', source: 'manual', tags: [],
    playbookId: '',
  });
  const [playbooks, setPlaybooks]         = useState([]);
  const [defaultPlaybook, setDefaultPlaybook] = useState(null);
  const [showMakeDefault, setShowMakeDefault] = useState(false);
  const [sfLockedFields, setSfLockedFields]   = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const r = await apiFetch('/playbooks?type=prospecting');
        const all = r.playbooks || [];
        setPlaybooks(all);
        setDefaultPlaybook(all.find(pb => pb.is_default) || null);
      } catch {
        setPlaybooks([]);
      }
      // Load SF locked fields for prospects (sf_primary mode)
      try {
        const sfr = await apiFetch('/salesforce/locked-fields/prospect');
        setSfLockedFields(sfr.data || []);
      } catch {
        // Not connected or not in sf_primary — no locks
      }
    })();
  }, []);

  const set = (field, val) => setForm(prev => ({ ...prev, [field]: val }));

  const handlePlaybookChange = (e) => {
    const id = e.target.value;
    set('playbookId', id);
    // Show "make default" prompt only if user picks a non-default playbook
    const picked = playbooks.find(pb => String(pb.id) === String(id));
    setShowMakeDefault(!!picked && !picked.is_default);
  };

  const handleMakeDefault = async (playbookId) => {
    try {
      await apiFetch(`/playbooks/${playbookId}/set-default`, { method: 'POST' });
      setPlaybooks(prev => prev.map(pb => ({ ...pb, is_default: pb.id === parseInt(playbookId) })));
      setDefaultPlaybook(playbooks.find(pb => pb.id === parseInt(playbookId)) || null);
      setShowMakeDefault(false);
    } catch (err) {
      alert('Could not update default playbook: ' + err.message);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.firstName.trim() || !form.lastName.trim()) {
      alert('First and last name are required');
      return;
    }
    onSave(form);
  };

  return (
    <div className="pv-modal-overlay" onClick={onClose}>
      <div className="pv-modal" onClick={e => e.stopPropagation()}>
        <div className="pv-modal-header">
          <h3>Add New Prospect</h3>
          <button className="pv-modal-close" onClick={onClose}>×</button>
        </div>
        <form onSubmit={handleSubmit} className="pv-form">
          <div className="pv-form-section">
            <h4>
              Person
              {sfLockedFields.length > 0 && <span style={{ fontSize: 11, color: '#0369a1', fontWeight: 400, marginLeft: 8 }}>🔒 Some fields managed by Salesforce</span>}
            </h4>
            <div className="pv-form-row">
              <input placeholder="First name *" value={form.firstName} onChange={e => set('firstName', e.target.value)} required
                disabled={sfLockedFields.includes('first_name')} title={sfLockedFields.includes('first_name') ? 'Managed by Salesforce' : undefined} />
              <input placeholder="Last name *" value={form.lastName} onChange={e => set('lastName', e.target.value)} required
                disabled={sfLockedFields.includes('last_name')} title={sfLockedFields.includes('last_name') ? 'Managed by Salesforce' : undefined} />
            </div>
            <input placeholder="Email" value={form.email} onChange={e => set('email', e.target.value)} type="email"
              disabled={sfLockedFields.includes('email')} title={sfLockedFields.includes('email') ? 'Managed by Salesforce' : undefined} />
            <input placeholder="Job title" value={form.title} onChange={e => set('title', e.target.value)}
              disabled={sfLockedFields.includes('title')} title={sfLockedFields.includes('title') ? 'Managed by Salesforce' : undefined} />
            <div className="pv-form-row">
              <input placeholder="Phone" value={form.phone} onChange={e => set('phone', e.target.value)}
                disabled={sfLockedFields.includes('phone')} title={sfLockedFields.includes('phone') ? 'Managed by Salesforce' : undefined} />
              <input placeholder="LinkedIn URL" value={form.linkedinUrl} onChange={e => set('linkedinUrl', e.target.value)} />
            </div>
            <input placeholder="Location" value={form.location} onChange={e => set('location', e.target.value)} />
          </div>

          <div className="pv-form-section">
            <h4>Company</h4>
            <div className="pv-form-row">
              <input placeholder="Company name" value={form.companyName} onChange={e => set('companyName', e.target.value)}
                disabled={sfLockedFields.includes('company_name')} title={sfLockedFields.includes('company_name') ? 'Managed by Salesforce' : undefined} />
              <input placeholder="Domain (e.g. acme.com)" value={form.companyDomain} onChange={e => set('companyDomain', e.target.value)}
                disabled={sfLockedFields.includes('company_domain')} title={sfLockedFields.includes('company_domain') ? 'Managed by Salesforce' : undefined} />
            </div>
            <div className="pv-form-row">
              <select value={form.companySize} onChange={e => set('companySize', e.target.value)}
                disabled={sfLockedFields.includes('company_size')}>
                <option value="">Company size</option>
                <option value="1-10">1–10</option>
                <option value="11-50">11–50</option>
                <option value="51-200">51–200</option>
                <option value="201-500">201–500</option>
                <option value="501-1000">501–1,000</option>
                <option value="1001-5000">1,001–5,000</option>
                <option value="5001+">5,001+</option>
              </select>
              <input placeholder="Industry" value={form.companyIndustry} onChange={e => set('companyIndustry', e.target.value)}
                disabled={sfLockedFields.includes('company_industry')} title={sfLockedFields.includes('company_industry') ? 'Managed by Salesforce' : undefined} />
            </div>
          </div>

          <div className="pv-form-section">
            <h4>Source</h4>
            <select value={form.source} onChange={e => set('source', e.target.value)}>
              <option value="manual">Manual</option>
              <option value="linkedin">LinkedIn</option>
              <option value="referral">Referral</option>
              <option value="event">Event</option>
              <option value="inbound">Inbound</option>
              <option value="import">Import</option>
            </select>
          </div>

          <div className="pv-form-section">
            <h4>Playbook</h4>
            <select value={form.playbookId} onChange={handlePlaybookChange}>
              <option value="">
                {defaultPlaybook ? `✓ Default: ${defaultPlaybook.name}` : 'Use org default playbook'}
              </option>
              {playbooks.map(pb => (
                <option key={pb.id} value={pb.id}>
                  {pb.is_default ? '★ ' : ''}{pb.name}
                </option>
              ))}
            </select>
            {showMakeDefault && (
              <div style={{ marginTop: 8, padding: '8px 10px', background: '#fff8f0', border: '1px solid #FBCF9D', borderRadius: 6, fontSize: 12 }}>
                <span style={{ color: '#92400e' }}>Make <strong>{playbooks.find(pb => String(pb.id) === String(form.playbookId))?.name}</strong> the default for all new prospects?</span>
                <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
                  <button type="button" onClick={() => handleMakeDefault(form.playbookId)}
                    style={{ padding: '3px 10px', background: '#E8630A', color: '#fff', border: 'none', borderRadius: 4, fontSize: 11, cursor: 'pointer', fontWeight: 600 }}>
                    Yes, make default
                  </button>
                  <button type="button" onClick={() => setShowMakeDefault(false)}
                    style={{ padding: '3px 10px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}>
                    No, just this prospect
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="pv-form-actions">
            <button type="button" onClick={onClose} className="pv-btn-secondary">Cancel</button>
            <button type="submit" className="pv-btn-primary">Create Prospect</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// PROSPECT DETAIL PANEL (slide-out)
// ═════════════════════════════════════════════════════════════════════════════

function ProspectDetailPanel({ prospectId, onClose, onUpdate }) {
  const { allStages, prospectStages } = useStages();
  const [prospect, setProspect] = useState(null);
  const [actions, setActions] = useState([]);
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');
  const [editMode, setEditMode]   = useState(false);
  const [editForm, setEditForm]   = useState({});
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError]   = useState(null);
  const [showStageMenu, setShowStageMenu] = useState(false);
  const [showOutreach, setShowOutreach] = useState(false);
  const [outreachChannel, setOutreachChannel] = useState(null);
  const [outreachAction, setOutreachAction] = useState(null);
  const [showEnrollModal, setShowEnrollModal] = useState(false);
  const [activeEnrollment, setActiveEnrollment] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [contextData, setContextData] = useState(null);
  const [contextLoading, setContextLoading] = useState(false);

  // Drafts for this prospect (pinned in Activity tab)
  const [prospectDrafts,        setProspectDrafts]        = useState([]);
  const [prospectDraftEdits,    setProspectDraftEdits]    = useState({});
  const [loadingProspectDrafts, setLoadingProspectDrafts] = useState(false);

  const loadProspectDrafts = useCallback(async () => {
    setLoadingProspectDrafts(true);
    try {
      const r = await apiFetch(`/sequences/drafts?prospectId=${prospectId}`);
      setProspectDrafts(r.drafts || []);
    } catch (err) {
      console.error('Failed to load prospect drafts:', err);
    } finally {
      setLoadingProspectDrafts(false);
    }
  }, [prospectId]);

  const handleConvertAndSendProspectDraft = async (draft) => {
    const edit = prospectDraftEdits[draft.id] || {};
    const subject = edit.subject !== undefined ? edit.subject : draft.subject;
    if (!subject) {
      setProspectDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], error: 'Please enter a subject line before sending.' } }));
      return;
    }
    setProspectDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], sending: true, error: null } }));
    try {
      await apiFetch(`/sequences/drafts/${draft.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ channel: 'email', subject }),
      });
      await apiFetch(`/sequences/drafts/${draft.id}/send`, { method: 'POST', body: JSON.stringify({}) });
      setProspectDrafts(prev => prev.filter(d => d.id !== draft.id));
      setProspectDraftEdits(prev => { const n = { ...prev }; delete n[draft.id]; return n; });
      try {
        const res = await apiFetch(`/prospects/${prospectId}`);
        setActivities(res.activities || []);
      } catch (_) {}
    } catch (err) {
      setProspectDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], sending: false, error: err.message } }));
    }
  };

  const handleSendProspectDraft = async (draft) => {
    if (draft.channel && draft.channel !== 'email') { console.error(`handleSendProspectDraft called on ${draft.channel} draft — blocked`); return; }
    const edit = prospectDraftEdits[draft.id] || {};
    setProspectDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], sending: true, error: null } }));
    try {
      if (edit.subject !== undefined || edit.body !== undefined) {
        await apiFetch(`/sequences/drafts/${draft.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            subject: edit.subject !== undefined ? edit.subject : draft.subject,
            body:    edit.body    !== undefined ? edit.body    : draft.body,
          }),
        });
      }
      const sendRes = await apiFetch(`/sequences/drafts/${draft.id}/send`, { method: 'POST', body: JSON.stringify({}) });
      if (sendRes && sendRes.emailSent === false && sendRes.sendError) {
        setProspectDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], sending: false, error: sendRes.sendError } }));
        return;
      }
      setProspectDrafts(prev => prev.filter(d => d.id !== draft.id));
      setProspectDraftEdits(prev => { const n = { ...prev }; delete n[draft.id]; return n; });
      // Refresh activity feed to show the sent step
      try {
        const res = await apiFetch(`/prospects/${prospectId}`);
        setActivities(res.activities || []);
      } catch (_) {}
    } catch (err) {
      setProspectDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], sending: false, error: err.message } }));
    }
  };

  const handleDiscardProspectDraft = async (draftId) => {
    if (!window.confirm('Discard this draft? The step will be skipped and the sequence will advance.')) return;
    try {
      await apiFetch(`/sequences/drafts/${draftId}`, { method: 'DELETE' });
      setProspectDrafts(prev => prev.filter(d => d.id !== draftId));
      setProspectDraftEdits(prev => { const n = { ...prev }; delete n[draftId]; return n; });
      // Refresh activities to show skipped step
      try {
        const res = await apiFetch(`/prospects/${prospectId}`);
        setActivities(res.activities || []);
      } catch (_) {}
    } catch (err) {
      console.error('Failed to discard draft:', err);
    }
  };

  const handleMarkDoneProspectDraft = async (draftId) => {
    setProspectDraftEdits(prev => ({ ...prev, [draftId]: { ...prev[draftId], sending: true, error: null } }));
    try {
      await apiFetch(`/sequences/drafts/${draftId}/complete`, { method: 'POST', body: JSON.stringify({}) });
      setProspectDrafts(prev => prev.filter(d => d.id !== draftId));
      setProspectDraftEdits(prev => { const n = { ...prev }; delete n[draftId]; return n; });
      try {
        const res = await apiFetch(`/prospects/${prospectId}`);
        setActivities(res.activities || []);
      } catch (_) {}
    } catch (err) {
      setProspectDraftEdits(prev => ({ ...prev, [draftId]: { ...prev[draftId], sending: false, error: err.message } }));
    }
  };

  useEffect(() => {
    const fetchDetail = async () => {
      try {
        setLoading(true);
        const res = await apiFetch(`/prospects/${prospectId}`);
        setProspect(res.prospect);
        setActions(res.actions || []);
        setActivities(res.activities || []);
        // Check for active enrollment so button can be disabled
        try {
          const er = await apiFetch(`/sequences/enrollments?prospectId=${prospectId}&status=active`);
          setActiveEnrollment((er.enrollments || [])[0] || null);
        } catch (_) {}
        // Load drafts upfront so they show immediately on Activity tab
        try {
          const dr = await apiFetch(`/sequences/drafts?prospectId=${prospectId}`);
          setProspectDrafts(dr.drafts || []);
        } catch (_) {}
      } catch (err) {
        console.error('Failed to load prospect:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchDetail();
  }, [prospectId]);

  const fetchContext = useCallback(async () => {
    if (contextData || contextLoading) return;
    setContextLoading(true);
    try {
      const res = await apiFetch(`/prospect-context/${prospectId}`);
      setContextData(res);
    } catch (err) {
      console.error('Failed to load prospect context:', err);
    } finally {
      setContextLoading(false);
    }
  }, [prospectId, contextData, contextLoading]);

  const handleTabChange = (t) => {
    setActiveTab(t);
    if (t === 'intel')    fetchContext();
    if (t === 'activity') loadProspectDrafts();
  };

  const handleEditSave = async () => {
    setEditSaving(true);
    setEditError(null);
    try {
      await apiFetch(`/prospects/${prospectId}`, {
        method: 'PATCH',
        body: JSON.stringify(editForm),
      });
      const res = await apiFetch(`/prospects/${prospectId}`);
      setProspect(res.prospect);
      setEditMode(false);
      setEditForm({});
      onUpdate();
    } catch (err) {
      setEditError(err.message);
    } finally {
      setEditSaving(false);
    }
  };

  const handleStageChange = async (newStage) => {
    try {
      let reason = null;
      if (newStage === 'disqualified') {
        reason = prompt('Reason for disqualification:');
        if (reason === null) return;
      }
      await apiFetch(`/prospects/${prospectId}/stage`, {
        method: 'POST',
        body: JSON.stringify({ stage: newStage, reason }),
      });
      // Refresh
      const res = await apiFetch(`/prospects/${prospectId}`);
      setProspect(res.prospect);
      setActivities(res.activities || []);
      setShowStageMenu(false);
      onUpdate();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleConvert = async () => {
    const dealName = prompt('Deal name (leave empty for default):');
    if (dealName === null) return;
    try {
      const res = await apiFetch(`/prospects/${prospectId}/convert`, {
        method: 'POST',
        body: JSON.stringify({ dealName: dealName || undefined, createDeal: true }),
      });
      alert(`Converted! Contact #${res.contactId}${res.dealId ? `, Deal #${res.dealId}` : ''}`);
      onClose();
      onUpdate();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleCompleteAction = async (actionId, outcome) => {
    try {
      await apiFetch(`/prospecting-actions/${actionId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'completed', outcome }),
      });
      const res = await apiFetch(`/prospects/${prospectId}`);
      setProspect(res.prospect);
      setActions(res.actions || []);
      setActivities(res.activities || []);
      onUpdate();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleGenerateActions = async () => {
    if (!prospect?.playbook_id) {
      alert('Assign a playbook to this prospect first (in the Overview tab).');
      return;
    }
    setGenerating(true);
    try {
      const res = await apiFetch('/prospecting-actions/generate', {
        method: 'POST',
        body: JSON.stringify({ prospectId }),
      });
      const msg = res.message || `Created ${res.created} action(s), skipped ${res.skipped} duplicate(s).`;
      if (res.created === 0 && res.skipped === 0 && res.message) {
        alert(msg);
      }
      // Refresh detail
      const detail = await apiFetch(`/prospects/${prospectId}`);
      setProspect(detail.prospect);
      setActions(detail.actions || []);
      setActivities(detail.activities || []);
      onUpdate();
    } catch (err) {
      alert(err.message);
    } finally {
      setGenerating(false);
    }
  };

  // ── Research state ────────────────────────────────────────────────────────
  const [researching,    setResearching]    = useState(false);
  const [researchResult, setResearchResult] = useState(null);
  const [researchError,  setResearchError]  = useState('');

  const handleResearch = async () => {
    setResearching(true);
    setResearchError('');
    try {
      const res = await apiFetch(`/prospects/${prospectId}/research`, {
        method: 'POST',
        body:   JSON.stringify({}),
      });
      setResearchResult(res);
      // Refresh prospect so research_notes updates in overview tab
      const detail = await apiFetch(`/prospects/${prospectId}`);
      setProspect(detail.prospect);
      onUpdate();
    } catch (err) {
      setResearchError(err.message || 'Research failed');
    } finally {
      setResearching(false);
    }
  };

  const openOutreach = (channel, action) => {
    setOutreachChannel(channel || null);
    setOutreachAction(action || null);
    setShowOutreach(true);
  };

  const handleOutreachComplete = async () => {
    setShowOutreach(false);
    setOutreachAction(null);
    // Refresh data
    try {
      const res = await apiFetch(`/prospects/${prospectId}`);
      setProspect(res.prospect);
      setActions(res.actions || []);
      setActivities(res.activities || []);
      onUpdate();
    } catch (err) {
      console.error('Refresh after outreach:', err);
    }
  };

  if (loading) {
    return (
      <div className="pv-detail-overlay" onClick={onClose}>
        <div className="pv-detail-panel" onClick={e => e.stopPropagation()}>
          <div className="pv-loading">Loading...</div>
        </div>
      </div>
    );
  }

  if (!prospect) return null;

  const stageCfg = allStages.find(s => s.key === prospect.stage);
  const currentStageIdx = prospectStages.findIndex(s => s.key === prospect.stage);

  return (
    <div className="pv-detail-overlay" onClick={onClose}>
      <div className="pv-detail-panel" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="pv-detail-header">
          <div className="pv-detail-header-left">
            <h3>{prospect.first_name} {prospect.last_name}</h3>
            {prospect.title && <span className="pv-detail-title">{prospect.title}</span>}
            {(prospect.company_name || prospect.account?.name) && (
              <span className="pv-detail-company">at {prospect.account?.name || prospect.company_name}</span>
            )}
          </div>
          <button className="pv-detail-close" onClick={onClose}>×</button>
        </div>

        {/* Stage indicator + actions */}
        <div className="pv-detail-stage-row">
          <div className="pv-detail-stage-pill" style={{ background: stageCfg?.color + '20', color: stageCfg?.color }}>
            {stageCfg?.icon} {stageCfg?.label}
          </div>

          <div className="pv-detail-stage-actions">
            <button className="pv-btn-primary" style={{ fontSize: '12px', padding: '5px 12px' }} onClick={() => openOutreach()}>
              📤 New Outreach
            </button>
            <button
              style={{
                fontSize: '12px', padding: '5px 12px',
                background: activeEnrollment ? '#f3f4f6' : '#f0fdf4',
                border: `1px solid ${activeEnrollment ? '#e5e7eb' : '#bbf7d0'}`,
                color: activeEnrollment ? '#9ca3af' : '#065f46',
                borderRadius: 6,
                cursor: activeEnrollment ? 'not-allowed' : 'pointer',
                fontWeight: 600,
              }}
              onClick={() => !activeEnrollment && setShowEnrollModal(true)}
              disabled={!!activeEnrollment}
              title={activeEnrollment ? `Active in: ${activeEnrollment.sequence_name}` : 'Enroll in Sequence'}
            >
              📨 {activeEnrollment ? `In Sequence: ${activeEnrollment.sequence_name}` : 'Enroll in Sequence'}
            </button>
            {prospect.stage === 'qualified_sal' && (
              <button className="pv-btn-convert" onClick={handleConvert}>🎉 Convert</button>
            )}
            <div className="pv-stage-menu-wrap" style={{ position: 'relative' }}>
              <button className="pv-btn-secondary" onClick={() => setShowStageMenu(!showStageMenu)}>
                Move Stage ▾
              </button>
              {showStageMenu && (
                <div className="pv-stage-dropdown">
                  {allStages.filter(s => s.key !== prospect.stage).map(s => (
                    <button key={s.key} onClick={() => handleStageChange(s.key)} className="pv-stage-option">
                      {s.icon} {s.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Stage progress bar */}
        {currentStageIdx >= 0 && (
          <div className="pv-stage-progress">
            {prospectStages.map((s, idx) => (
              <div
                key={s.key}
                className={`pv-stage-step ${idx <= currentStageIdx ? 'active' : ''}`}
                style={{ '--stage-color': s.color }}
              >
                <span className="pv-stage-step-dot" />
                <span className="pv-stage-step-label">{s.label}</span>
              </div>
            ))}
          </div>
        )}

        {/* Tabs */}
        <div className="pv-detail-tabs">
          {['overview', 'linkedin', 'intel', 'actions', 'activity'].map(t => (
            <button
              key={t}
              className={`pv-detail-tab ${activeTab === t ? 'active' : ''}`}
              onClick={() => handleTabChange(t)}
            >
              {t === 'overview' ? 'Overview'
                : t === 'linkedin' ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ background: '#0077B5', color: '#fff', borderRadius: 2, padding: '0px 4px', fontSize: 9, fontWeight: 700 }}>in</span>
                    LinkedIn
                    {getLiStatus(prospect) && (
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: getLiDotColor(getLiStatus(prospect)), marginLeft: 2 }} />
                    )}
                  </span>
                )
                : t === 'intel' ? '🎯 Intel'
                : t === 'actions' ? `Actions (${actions.filter(a => a.status === 'pending').length})`
                : 'Activity'}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="pv-detail-content">
          {activeTab === 'overview' && (
            <div className="pv-overview-tab">

              {/* Edit / Save toolbar */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8, gap: 6 }}>
                {editMode ? (
                  <>
                    <button onClick={() => { setEditMode(false); setEditForm({}); setEditError(null); }}
                      style={{ fontSize: 11, padding: '3px 10px', borderRadius: 5, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer', color: '#6b7280' }}>
                      Cancel
                    </button>
                    <button onClick={handleEditSave} disabled={editSaving}
                      style={{ fontSize: 11, padding: '3px 10px', borderRadius: 5, border: 'none', background: '#0F9D8E', color: '#fff', cursor: 'pointer', fontWeight: 600 }}>
                      {editSaving ? 'Saving…' : 'Save'}
                    </button>
                  </>
                ) : (
                  <button onClick={() => { setEditMode(true); setEditForm({
                    email: prospect.email || '', phone: prospect.phone || '',
                    linkedin_url: prospect.linkedin_url || '', location: prospect.location || '',
                    company_name: prospect.company_name || '', company_domain: prospect.company_domain || '',
                    company_size: prospect.company_size || '', company_industry: prospect.company_industry || '',
                  }); }}
                    style={{ fontSize: 11, padding: '3px 10px', borderRadius: 5, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer', color: '#374151' }}>
                    ✏️ Edit
                  </button>
                )}
              </div>
              {editError && <div style={{ fontSize: 11, color: '#dc2626', marginBottom: 8 }}>{editError}</div>}

              <div className="pv-info-grid">
                <InfoRow label="Email"    value={prospect.email}    editMode={editMode} editValue={editForm.email}    onEdit={v => setEditForm(f => ({...f, email: v}))} />
                <InfoRow label="Phone"    value={prospect.phone}    editMode={editMode} editValue={editForm.phone}    onEdit={v => setEditForm(f => ({...f, phone: v}))} />
                <InfoRow label="LinkedIn" value={prospect.linkedin_url ? <a href={prospect.linkedin_url} target="_blank" rel="noreferrer">Profile ↗</a> : null}
                                          editMode={editMode} editValue={editForm.linkedin_url} onEdit={v => setEditForm(f => ({...f, linkedin_url: v}))} />
                <InfoRow label="Location" value={prospect.location}  editMode={editMode} editValue={editForm.location} onEdit={v => setEditForm(f => ({...f, location: v}))} />
                <InfoRow label="Source"           value={prospect.source} />
                <InfoRow label="Outreach Count"   value={prospect.outreach_count} />
                <InfoRow label="Response Count"   value={prospect.response_count} />
                <InfoRow label="Last Outreach"    value={prospect.last_outreach_at ? formatDate(prospect.last_outreach_at) : null} />
                <InfoRow label="Last Response"    value={prospect.last_response_at ? formatDate(prospect.last_response_at) : null} />
                <InfoRow label="Preferred Channel" value={prospect.preferred_channel} optional />
                <InfoRow label="ICP Score"        value={prospect.icp_score} optional />
              </div>

              {prospect.research_notes && (
                <div className="pv-research-notes">
                  <h4>🔍 Research Notes</h4>
                  {prospect.research_notes.split('\n').map((line, i) => (
                    line.trim() ? (
                      <p key={i} style={{
                        margin: '4px 0',
                        paddingLeft: line.startsWith('•') ? 0 : 8,
                        fontWeight: line.startsWith('💡') || line.startsWith('✉️') || line.startsWith('📧') ? 600 : 400,
                        borderTop: line.startsWith('💡') ? '1px solid #e5e7eb' : 'none',
                        paddingTop: line.startsWith('💡') ? 8 : 0,
                        marginTop:  line.startsWith('💡') ? 8 : 4,
                      }}>{line}</p>
                    ) : <br key={i} />
                  ))}
                  {prospect.research_meta && (
                    <div style={{ marginTop: 10, fontSize: 11, color: '#9ca3af', borderTop: '1px solid #f3f4f6', paddingTop: 6 }}>
                      Generated with {prospect.research_meta.model || prospect.research_meta.provider || 'AI'}
                      {prospect.research_meta.generated_at ? ` · ${new Date(prospect.research_meta.generated_at).toLocaleDateString()}` : ''}
                      {prospect.research_meta.stage2_prompt_source ? ` · ${prospect.research_meta.stage2_prompt_source} prompt` : ''}
                    </div>
                  )}
                </div>
              )}

              <div className="pv-info-grid" style={{ marginTop: 16 }}>
                <InfoRow label="Company"  value={prospect.company_name}     editMode={editMode} editValue={editForm.company_name}     onEdit={v => setEditForm(f => ({...f, company_name: v}))} />
                <InfoRow label="Domain"   value={prospect.company_domain}   editMode={editMode} editValue={editForm.company_domain}   onEdit={v => setEditForm(f => ({...f, company_domain: v}))} />
                <InfoRow label="Size"     value={prospect.company_size}     editMode={editMode} editValue={editForm.company_size}     onEdit={v => setEditForm(f => ({...f, company_size: v}))} optional />
                <InfoRow label="Industry" value={prospect.company_industry} editMode={editMode} editValue={editForm.company_industry} onEdit={v => setEditForm(f => ({...f, company_industry: v}))} optional />
              </div>

              {prospect.account && (
                <div className="pv-linked-entity">
                  🏢 Linked Account: <strong>{prospect.account.name}</strong>
                </div>
              )}
              {prospect.linkedContact && (
                <div className="pv-linked-entity">
                  👤 Linked Contact: <strong>{prospect.linkedContact.first_name} {prospect.linkedContact.last_name}</strong>
                </div>
              )}

              {/* STRAP — Strategy & Action Plan */}
              <div style={{ marginTop: 16 }}>
                <StrapPanel entityType="prospect" entityId={prospect.id} />
              </div>
            </div>
          )}

          {activeTab === 'linkedin' && (
            <LinkedInPanel
              prospect={prospect}
              onEventLogged={async () => {
                try {
                  const res = await apiFetch(`/prospects/${prospectId}`);
                  setProspect(res.prospect);
                  setActivities(res.activities || []);
                  onUpdate();
                } catch (_) {}
              }}
            />
          )}

          {activeTab === 'intel' && (
            <div>
              <div style={{ marginBottom: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                  <button
                    onClick={handleResearch}
                    disabled={researching}
                    style={{
                      padding: '8px 18px', background: researching ? '#e5e7eb' : '#0F9D8E',
                      color: researching ? '#6b7280' : '#fff', border: 'none', borderRadius: 7,
                      fontSize: 13, fontWeight: 600, cursor: researching ? 'wait' : 'pointer',
                    }}
                  >
                    {researching ? '⏳ Researching…' : prospect.research_notes ? '🔄 Re-research' : '🔍 Research Prospect'}
                  </button>
                  {prospect.research_meta?.generated_at && (
                    <span style={{ fontSize: 11, color: '#9ca3af' }}>
                      Last run {new Date(prospect.research_meta.generated_at).toLocaleDateString()}
                      {' · '}{prospect.research_meta.model || prospect.research_meta.provider || 'AI'}
                      {prospect.research_meta.account_research_cached ? ' · account cached ✓' : ''}
                    </span>
                  )}
                </div>

                {researchError && (
                  <div style={{ padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, fontSize: 13, color: '#dc2626', marginBottom: 12 }}>
                    ⚠️ {researchError}
                  </div>
                )}

                {/* Structured research result (current run) */}
                {researchResult && (
                  <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: 16, marginBottom: 16 }}>
                    <div style={{ fontWeight: 700, fontSize: 13, color: '#065f46', marginBottom: 10 }}>✅ Research complete</div>

                    {researchResult.researchBullets?.length > 0 && (
                      <div style={{ marginBottom: 12 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>KEY INSIGHTS</div>
                        {researchResult.researchBullets.map((b, i) => (
                          <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 5, fontSize: 13 }}>
                            <span style={{ color: '#0F9D8E', flexShrink: 0 }}>•</span>
                            <span style={{ color: '#374151' }}>{b}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {researchResult.pitchAngle && (
                      <div style={{ marginBottom: 12, padding: '10px 12px', background: '#fff', borderRadius: 7, border: '1px solid #d1fae5' }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: '#065f46', marginBottom: 4 }}>💡 PITCH ANGLE</div>
                        <div style={{ fontSize: 13, color: '#1a202c' }}>{researchResult.pitchAngle}</div>
                      </div>
                    )}

                    {researchResult.crispPitch && (
                      <div style={{ marginBottom: 12, padding: '10px 12px', background: '#fff', borderRadius: 7, border: '1px solid #d1fae5' }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: '#065f46', marginBottom: 4 }}>✉️ CRISP PITCH</div>
                        <div style={{ fontSize: 13, color: '#1a202c', lineHeight: 1.6 }}>{researchResult.crispPitch}</div>
                      </div>
                    )}

                    {researchResult.suggestedSubject && (
                      <div style={{ padding: '8px 12px', background: '#fff', borderRadius: 7, border: '1px solid #d1fae5' }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: '#065f46', marginBottom: 4 }}>📧 SUGGESTED SUBJECT</div>
                        <div style={{ fontSize: 13, color: '#1a202c', fontStyle: 'italic' }}>{researchResult.suggestedSubject}</div>
                      </div>
                    )}

                    <div style={{ marginTop: 10, fontSize: 11, color: '#9ca3af' }}>
                      {researchResult.meta?.provider} · {researchResult.meta?.model}
                      {researchResult.accountResearchCached ? ' · account research from cache' : ' · fresh account research'}
                      {researchResult.confidence ? ` · ${Math.round(researchResult.confidence * 100)}% confidence` : ''}
                    </div>
                  </div>
                )}

                {/* Persisted research notes (from previous runs) */}
                {!researchResult && prospect.research_notes && (
                  <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: 16, marginBottom: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 8 }}>SAVED RESEARCH NOTES</div>
                    {prospect.research_notes.split('\n').map((line, i) => (
                      line.trim() ? (
                        <div key={i} style={{
                          display: 'flex', gap: 8, marginBottom: 4, fontSize: 13,
                          fontWeight: line.startsWith('💡') || line.startsWith('✉️') || line.startsWith('📧') ? 600 : 400,
                          borderTop: line.startsWith('💡') ? '1px solid #e5e7eb' : 'none',
                          paddingTop: line.startsWith('💡') ? 8 : 0,
                          marginTop:  line.startsWith('💡') ? 8 : 0,
                        }}>
                          {line.startsWith('•') && <span style={{ color: '#0F9D8E', flexShrink: 0 }}></span>}
                          <span style={{ color: '#374151' }}>{line}</span>
                        </div>
                      ) : <br key={i} />
                    ))}
                    {prospect.research_meta && (
                      <div style={{ marginTop: 8, fontSize: 11, color: '#9ca3af', borderTop: '1px solid #e5e7eb', paddingTop: 6 }}>
                        {prospect.research_meta.model || prospect.research_meta.provider || 'AI'}
                        {prospect.research_meta.generated_at ? ` · ${new Date(prospect.research_meta.generated_at).toLocaleDateString()}` : ''}
                        {' · '}{prospect.research_meta.stage2_prompt_source || 'system'} prompt
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Existing intel card below */}
              <ProspectIntelCard
                contextData={contextData}
                loading={contextLoading}
                prospect={prospect}
                onOpenOutreach={(channel) => openOutreach(channel)}
              />
            </div>
          )}

          {activeTab === 'actions' && (
            <div className="pv-actions-tab">
              <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                <button
                  className="pv-btn-secondary"
                  style={{ fontSize: '11px', padding: '5px 10px' }}
                  onClick={handleGenerateActions}
                  disabled={generating}
                >
                  {generating ? '⏳ Generating...' : '🤖 Generate from Playbook'}
                </button>
              </div>
              {actions.length === 0 ? (
                <div className="pv-empty-state">No actions yet. {prospect?.playbook_id ? 'Click "Generate from Playbook" to create actions.' : 'Assign a playbook to auto-generate actions.'}</div>
              ) : (
                actions.map(a => (
                  <div key={a.id} className={`pv-action-card ${a.status}`}>
                    <div className="pv-action-top">
                      <span className="pv-action-type">
                        {a.channel ? CHANNEL_ICONS[a.channel] : '📋'} {a.title}
                      </span>
                      <span className={`pv-action-status ${a.status}`}>
                        {a.status === 'pending' ? '○' : a.status === 'completed' ? '●' : '◑'} {a.status}
                      </span>
                    </div>
                    {a.description && <p className="pv-action-desc">{a.description}</p>}
                    {a.source === 'playbook' && (
                      <span style={{ fontSize: '10px', color: '#0F9D8E', fontWeight: 600 }}>📋 Playbook</span>
                    )}
                    {a.due_date && (
                      <span style={{ fontSize: '10px', color: '#9ca3af', marginLeft: 8 }}>Due: {formatDate(a.due_date)}</span>
                    )}
                    {a.status === 'pending' && (
                      <div className="pv-action-buttons">
                        {a.channel && (
                          <button
                            className="pv-btn-sm"
                            style={{ background: '#0F9D8E', color: '#fff', border: 'none' }}
                            onClick={() => openOutreach(a.channel, a)}
                          >
                            📤 Start Outreach
                          </button>
                        )}
                        <button
                          className="pv-btn-sm"
                          onClick={() => handleCompleteAction(a.id, 'completed')}
                        >
                          ✓ Complete
                        </button>
                        {a.channel && (
                          <button
                            className="pv-btn-sm"
                            onClick={() => {
                              const outcome = prompt('Outcome? (replied, no_response, bounced, call_connected, voicemail, meeting_booked)');
                              if (outcome) handleCompleteAction(a.id, outcome);
                            }}
                          >
                            Log Outcome
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}

          {activeTab === 'activity' && (
            <div className="pv-activity-tab">

              {/* ── Pending drafts pinned at top ─────────────────────────── */}
              {loadingProspectDrafts && (
                <div style={{ padding: '10px 0', fontSize: 12, color: '#9ca3af', textAlign: 'center' }}>
                  Loading drafts…
                </div>
              )}
              {!loadingProspectDrafts && (
                <div style={{ marginBottom: prospectDrafts.length > 0 ? 16 : 8 }}>
                  <div style={{
                    fontSize: 11, fontWeight: 700, color: '#374151',
                    textTransform: 'uppercase', letterSpacing: 0.5,
                    marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6,
                  }}>
                    <span>📋 Pending Drafts</span>
                    <span style={{
                      background: prospectDrafts.length > 0 ? '#fef3c7' : '#f3f4f6',
                      color: prospectDrafts.length > 0 ? '#92400e' : '#9ca3af',
                      fontSize: 10, fontWeight: 700,
                      padding: '1px 7px', borderRadius: 10,
                      border: `1px solid ${prospectDrafts.length > 0 ? '#fde68a' : '#e5e7eb'}`,
                    }}>
                      {prospectDrafts.length}
                    </span>
                  </div>
                  {prospectDrafts.length === 0 ? (
                    <div style={{ fontSize: 12, color: '#9ca3af', padding: '6px 0 4px', fontStyle: 'italic' }}>
                      No pending drafts — sequence emails will appear here for review before sending.
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {prospectDrafts.map(draft => {
                        const edit    = prospectDraftEdits[draft.id] || {};
                        const subject = edit.subject !== undefined ? edit.subject : draft.subject;
                        const body    = edit.body    !== undefined ? edit.body    : draft.body;
                        const isOpen  = !!edit.open;
                        return (
                          <DraftCard
                            key={draft.id}
                            draft={draft}
                            subject={subject}
                            body={body}
                            isOpen={isOpen}
                            compact={true}
                            sending={!!edit.sending}
                            sendError={edit.error || null}
                            onToggle={() => setProspectDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], open: !isOpen } }))}
                            onSubjectChange={v => setProspectDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], subject: v } }))}
                            onBodyChange={v => setProspectDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], body: v } }))}
                            onSend={() => handleSendProspectDraft(draft)}
                            onComplete={() => handleMarkDoneProspectDraft(draft.id)}
                            onDiscard={() => handleDiscardProspectDraft(draft.id)}
                            onConvertAndSend={() => handleConvertAndSendProspectDraft(draft)}
                          />
                        );
                      })}
                    </div>
                  )}
                  <div style={{ borderTop: '1px solid #f0f0f0', margin: '12px 0 10px' }} />
                </div>
              )}

              {/* ── Activity feed ────────────────────────────────────────── */}
              {activities.length === 0 && prospectDrafts.length === 0 ? (
                <div className="pv-empty-state">No activity yet</div>
              ) : activities.length > 0 ? (
                activities.map(a => (
                  <div key={a.id} className="pv-activity-item">
                    <span className="pv-activity-type">{a.activity_type}</span>
                    <span className="pv-activity-desc">{a.description}</span>
                    <span className="pv-activity-time">{formatDate(a.created_at)}</span>
                  </div>
                ))
              ) : null}
            </div>
          )}
        </div>

        {/* SequenceEnrollModal */}
        {showEnrollModal && prospect && (
          <SequenceEnrollModal
            prospects={[prospect]}
            onEnrolled={async () => {
              setShowEnrollModal(false);
              // Fix 1: refresh prospect so Intel tab shows updated research_notes
              // Fix 2: refresh activities so Activity tab shows sequence_enrolled entry
              // Fix 3: refresh activeEnrollment so button becomes disabled
              try {
                const res = await apiFetch(`/prospects/${prospectId}`);
                setProspect(res.prospect);
                setActivities(res.activities || []);
              } catch (err) {
                console.error('Refresh after enrollment:', err);
              }
              try {
                const er = await apiFetch(`/sequences/enrollments?prospectId=${prospectId}&status=active`);
                setActiveEnrollment((er.enrollments || [])[0] || null);
              } catch (_) {}
            }}
            onClose={() => setShowEnrollModal(false)}
          />
        )}

        {/* OutreachComposer slide-out */}
        {showOutreach && prospect && (
          <OutreachComposer
            prospect={prospect}
            initialChannel={outreachChannel}
            actionToExecute={outreachAction}
            onComplete={handleOutreachComplete}
            onClose={() => { setShowOutreach(false); setOutreachAction(null); }}
          />
        )}
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// LINKEDIN PANEL
// ═════════════════════════════════════════════════════════════════════════════

function LinkedInPanel({ prospect, onEventLogged }) {
  const li = prospect?.channel_data?.linkedin || {};
  const currentStatus = li.connection_status || null;

  const [saving, setSaving] = useState(null);   // key of event being saved
  const [note, setNote] = useState('');
  const [showNote, setShowNote] = useState(false);
  const [error, setError] = useState(null);

  const TIMELINE_STEPS = [
    { key: 'request_sent', label: 'Connection request sent',    tsField: 'request_sent_at' },
    { key: 'connected',    label: 'Connection accepted',        tsField: 'connected_at',     extra: () => {
      if (li.request_sent_at && li.connected_at) {
        const days = Math.round((new Date(li.connected_at) - new Date(li.request_sent_at)) / 86400000);
        return days === 0 ? 'same day' : `${days}d to accept`;
      }
      return null;
    }},
    { key: 'message_sent', label: 'Follow-up message sent',     tsField: 'last_message_at',  extra: () => li.message_count > 1 ? `${li.message_count} messages sent` : null },
    { key: 'replied',      label: 'Reply received',             tsField: 'last_reply_at' },
  ];

  // Which steps are done — a step is done if status is at or past it
  const ORDER = ['request_sent', 'connected', 'message_sent', 'replied'];
  const currentIdx = ORDER.indexOf(currentStatus);
  const isDone = (key) => currentIdx >= ORDER.indexOf(key);

  const handleEvent = async (eventKey) => {
    setSaving(eventKey);
    setError(null);
    try {
      await apiFetch(`/prospects/${prospect.id}/linkedin-event`, {
        method: 'POST',
        body: JSON.stringify({ event: eventKey, note: note.trim() || undefined }),
      });
      setNote('');
      setShowNote(false);
      await onEventLogged();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(null);
    }
  };

  // Next logical action — the step immediately after current status
  const nextIdx = currentIdx + 1;
  const nextEvent = nextIdx < ORDER.length ? ORDER[nextIdx] : null;
  // If nothing logged yet, next is request_sent
  const promptedEvent = currentStatus ? nextEvent : 'request_sent';


  return (
    <div style={{ padding: '4px 0' }}>

      {/* Profile link row */}
      {prospect.linkedin_url && (
        <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ background: '#0077B5', color: '#fff', borderRadius: 3, padding: '1px 6px', fontSize: 10, fontWeight: 700 }}>in</span>
          <a
            href={prospect.linkedin_url}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: 13, color: '#0077B5', textDecoration: 'none', fontWeight: 500 }}
          >
            Open LinkedIn profile ↗
          </a>
        </div>
      )}

      {/* Timeline */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>
          Outreach timeline
        </div>
        {TIMELINE_STEPS.map((step, idx) => {
          const done = isDone(step.key);
          const ts   = li[step.tsField];
          const extraText = step.extra ? step.extra() : null;
          const isLast = idx === TIMELINE_STEPS.length - 1;
          return (
            <div key={step.key} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              {/* Dot + connector line */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0, paddingTop: 2 }}>
                <div style={{
                  width: 10, height: 10, borderRadius: '50%',
                  background: done ? getLiDotColor(step.key) : 'transparent',
                  border: done ? `2px solid ${getLiDotColor(step.key)}` : '2px solid #d1d5db',
                  flexShrink: 0,
                }} />
                {!isLast && (
                  <div style={{ width: 1, height: 22, background: done ? getLiDotColor(step.key) : '#e5e7eb', marginTop: 2, opacity: done ? 0.4 : 1 }} />
                )}
              </div>
              {/* Label */}
              <div style={{ paddingBottom: isLast ? 0 : 10, flex: 1 }}>
                <div style={{ fontSize: 13, color: done ? '#1a202c' : '#9ca3af', fontWeight: done ? 500 : 400 }}>
                  {step.label}
                </div>
                {done && (ts || extraText) && (
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 1, display: 'flex', gap: 8 }}>
                    {ts && <span>{formatDate(ts)}</span>}
                    {extraText && <span style={{ color: getLiDotColor(step.key), fontWeight: 500 }}>· {extraText}</span>}
                  </div>
                )}
                {!done && step.key === promptedEvent && (
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1, fontStyle: 'italic' }}>pending</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Record an event section */}
      <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
          Record an event
        </div>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          {LI_EVENTS.map(ev => {
            const alreadyDone = isDone(ev.key);
            const isNext = ev.key === promptedEvent;
            return (
              <button
                key={ev.key}
                onClick={() => handleEvent(ev.key)}
                disabled={!!saving}
                style={{
                  fontSize: 12, padding: '5px 12px',
                  borderRadius: 6,
                  border: `1px solid ${alreadyDone ? ev.color : '#e5e7eb'}`,
                  background: alreadyDone ? ev.bg : isNext ? '#f9fafb' : '#fff',
                  color: alreadyDone ? ev.color : isNext ? '#374151' : '#6b7280',
                  cursor: saving ? 'not-allowed' : 'pointer',
                  fontWeight: alreadyDone ? 600 : 400,
                  opacity: saving && saving !== ev.key ? 0.5 : 1,
                  display: 'flex', alignItems: 'center', gap: 5,
                }}
              >
                {saving === ev.key ? '⏳' : (
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: alreadyDone ? ev.color : '#d1d5db', flexShrink: 0 }} />
                )}
                {alreadyDone ? `✓ ${ev.label}` : ev.label}
              </button>
            );
          })}
        </div>

        {/* Optional note toggle */}
        <button
          onClick={() => setShowNote(v => !v)}
          style={{
            fontSize: 11, color: '#6b7280', background: 'none', border: 'none',
            padding: 0, cursor: 'pointer', marginBottom: showNote ? 8 : 0,
          }}
        >
          {showNote ? '▾ Hide note' : '▸ Add a note (optional)'}
        </button>

        {showNote && (
          <textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="e.g. 'Sent intro message referencing their recent Series B' or paste the reply summary..."
            rows={3}
            style={{
              width: '100%', fontSize: 12, padding: '8px 10px',
              border: '1px solid #e5e7eb', borderRadius: 6,
              resize: 'vertical', color: '#374151', lineHeight: 1.5,
              boxSizing: 'border-box',
            }}
          />
        )}

        {error && (
          <div style={{ marginTop: 8, fontSize: 12, color: '#dc2626', padding: '6px 10px', background: '#fef2f2', borderRadius: 6 }}>
            ⚠️ {error}
          </div>
        )}
      </div>

      {/* Stats summary if anything logged */}
      {currentStatus && (
        <div style={{ marginTop: 16, background: '#f8fafc', borderRadius: 8, padding: '10px 14px', border: '1px solid #e2e8f0' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
            LinkedIn stats
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {li.message_count > 0 && (
              <div>
                <div style={{ fontSize: 18, fontWeight: 600, color: '#1a202c' }}>{li.message_count}</div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>Messages sent</div>
              </div>
            )}
            {li.connected_at && li.request_sent_at && (
              <div>
                <div style={{ fontSize: 18, fontWeight: 600, color: '#1a202c' }}>
                  {Math.max(0, Math.round((new Date(li.connected_at) - new Date(li.request_sent_at)) / 86400000))}d
                </div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>Days to accept</div>
              </div>
            )}
            {li.last_reply_at && li.connected_at && (
              <div>
                <div style={{ fontSize: 18, fontWeight: 600, color: '#059669' }}>Replied</div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>{formatDate(li.last_reply_at)}</div>
              </div>
            )}
            {!li.last_reply_at && li.last_message_at && (
              <div>
                <div style={{ fontSize: 18, fontWeight: 600, color: '#d97706' }}>{timeAgo(li.last_message_at)}</div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>Since last message</div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ProspectIntelCard({ contextData, loading, prospect, onOpenOutreach }) {
  const [expanded, setExpanded] = useState({});
  const toggle = (k) => setExpanded(prev => ({ ...prev, [k]: !prev[k] }));

  if (loading) {
    return <div className="pv-empty-state" style={{ textAlign: 'center', padding: 32 }}>⏳ Loading intelligence...</div>;
  }
  if (!contextData) {
    return <div className="pv-empty-state">No context data available. Try refreshing.</div>;
  }

  const { derived, icpBreakdown, stageGuidance, account, teamEngagement } = contextData;
  const d = derived || {};
  const icp = icpBreakdown || {};

  // Build situation lines
  const situationLines = [];
  if (d.isExistingCustomer) situationLines.push({ text: `Existing customer — $${((d.totalAccountRevenue || 0) / 1000).toFixed(0)}K lifetime`, type: 'positive' });
  if (d.hasOpenDeal && d.openDeals?.length > 0) situationLines.push({ text: `Open deal: ${d.openDeals[0].name} ($${(parseFloat(d.openDeals[0].value || 0) / 1000).toFixed(0)}K at ${d.openDeals[0].stage})`, type: 'info' });
  if (d.isLostAccount) situationLines.push({ text: `Previously lost account`, type: 'warning' });
  if (d.isGhosting) situationLines.push({ text: `Ghosting — ${prospect.outreach_count || 0} touches with no response`, type: 'warning' });
  if (d.isHotLead) situationLines.push({ text: `Hot lead — responded ${d.daysSinceLastResponse}d ago`, type: 'positive' });
  if (d.isStale) situationLines.push({ text: `Going stale — last outreach ${d.daysSinceLastOutreach}d ago`, type: 'warning' });
  if (d.engagedSiblings?.length > 0) situationLines.push({ text: `${d.engagedSiblings.length} other contact(s) engaged at this company`, type: 'info' });
  if (d.hasReplied && !d.isHotLead) situationLines.push({ text: `Has replied (${Math.round((d.responseRate || 0) * 100)}% response rate)`, type: 'positive' });
  if (d.unansweredCount > 0) situationLines.push({ text: `${d.unansweredCount} unanswered outreach`, type: 'neutral' });
  if (d.overdueActions?.length > 0) situationLines.push({ text: `${d.overdueActions.length} overdue action(s)`, type: 'warning' });

  const lineColors = { positive: '#059669', warning: '#d97706', info: '#2563eb', neutral: '#6b7280' };
  const lineBgs = { positive: '#ecfdf5', warning: '#fffbeb', info: '#eff6ff', neutral: '#f9fafb' };
  const scoreColor = (s) => s >= 70 ? '#059669' : s >= 40 ? '#d97706' : '#dc2626';

  const icpCategories = [
    { key: 'firmographic', label: 'Firm' },
    { key: 'persona', label: 'Persona' },
    { key: 'engagement', label: 'Engage' },
    { key: 'timing', label: 'Timing' },
  ];

  return (
    <div className="pv-intel-card">
      {/* Situation summary */}
      {situationLines.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div className="pv-intel-section-label">Situation</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {situationLines.map((line, i) => (
              <div key={i} style={{
                fontSize: 12, padding: '6px 10px', borderRadius: 6,
                background: lineBgs[line.type], color: lineColors[line.type],
                fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: lineColors[line.type], flexShrink: 0 }} />
                {line.text}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Playbook guidance */}
      {stageGuidance && (
        <div style={{
          padding: '12px 16px', background: '#f0fdfa', borderRadius: 8,
          border: '1px solid #ccfbf1', marginBottom: 16,
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#0F9D8E', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Next Move — {prospect.stage}
          </div>
          <div style={{ fontSize: 13, color: '#065f46', fontWeight: 500, marginBottom: 6 }}>
            {stageGuidance.goal}
          </div>
          {stageGuidance.timeline && (
            <div style={{ fontSize: 11, color: '#0F9D8E', marginBottom: 8 }}>
              ⏱ {stageGuidance.timeline}
            </div>
          )}
          {(stageGuidance.key_actions || []).slice(0, 3).map((a, i) => (
            <div key={i} style={{
              fontSize: 12, color: '#115e59', padding: '4px 0 4px 14px',
              position: 'relative', lineHeight: 1.5,
            }}>
              <span style={{ position: 'absolute', left: 0, top: 4, fontSize: 8, color: '#0F9D8E' }}>▸</span>
              {a}
            </div>
          ))}
        </div>
      )}

      {/* ICP Score breakdown */}
      {icp.score != null && (
        <div style={{ marginBottom: 16 }}>
          <button onClick={() => toggle('icp')} style={{
            width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '8px 0', background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.8,
          }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              ICP Score
              <span style={{
                fontSize: 14, fontWeight: 700, color: scoreColor(icp.score),
                padding: '2px 8px', borderRadius: 12,
                background: scoreColor(icp.score) + '12', border: `1px solid ${scoreColor(icp.score)}30`,
              }}>
                {icp.score}
              </span>
            </span>
            <span style={{ fontSize: 9, transition: 'transform 0.2s', transform: expanded.icp ? 'rotate(180deg)' : 'none' }}>▼</span>
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            {icpCategories.map(c => {
              const cat = icp[c.key];
              if (!cat) return null;
              return (
                <div key={c.key} style={{ flex: 1, textAlign: 'center' }}>
                  <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 4 }}>{c.label}</div>
                  <div style={{ height: 4, background: '#f3f4f6', borderRadius: 2, overflow: 'hidden', marginBottom: 2 }}>
                    <div style={{ width: `${cat.score}%`, height: '100%', background: scoreColor(cat.score), borderRadius: 2, transition: 'width 0.5s ease' }} />
                  </div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: scoreColor(cat.score) }}>{cat.score}</div>
                </div>
              );
            })}
          </div>
          {expanded.icp && (
            <div style={{ padding: '8px 0', marginTop: 4 }}>
              {icpCategories.map(c => {
                const cat = icp[c.key];
                if (!cat?.signals?.length) return null;
                return (
                  <div key={c.key} style={{ marginBottom: 6 }}>
                    {cat.signals.map((s, i) => (
                      <div key={i} style={{
                        fontSize: 11, color: '#6b7280', paddingLeft: 10, lineHeight: 1.7,
                        display: 'flex', alignItems: 'center', gap: 5,
                      }}>
                        <span style={{
                          fontSize: 11,
                          color: s.match === true ? '#22c55e' : s.match === 'partial' ? '#eab308' : '#64748b',
                        }}>
                          {s.match === true ? '●' : s.match === 'partial' ? '◐' : '○'}
                        </span>
                        {s.detail}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Account & Relationships */}
      <div style={{ borderTop: '1px solid #f3f4f6', paddingTop: 12, marginBottom: 16 }}>
        <button onClick={() => toggle('account')} style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '4px 0 8px', background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.8,
        }}>
          <span>Account & Relationships</span>
          <span style={{ fontSize: 9, transition: 'transform 0.2s', transform: expanded.account ? 'rotate(180deg)' : 'none' }}>▼</span>
        </button>
        <div style={{ fontSize: 12, color: '#374151' }}>
          {account ? account.name : (prospect.company_name || 'No account linked')}
          {' · '}{d.knownContactCount || 0} contacts · {d.teamMembersEngaged || 0} team engaged
        </div>
        {expanded.account && (
          <div style={{ paddingTop: 10 }}>
            {(d.pastDealsWon || []).map((deal, i) => (
              <div key={i} style={{ fontSize: 11, color: '#059669', paddingLeft: 10, lineHeight: 1.7 }}>
                ✓ Won: {deal.name} — ${(parseFloat(deal.value || 0) / 1000).toFixed(0)}K
              </div>
            ))}
            {(d.pastDealsLost || []).map((deal, i) => (
              <div key={i} style={{ fontSize: 11, color: '#dc2626', paddingLeft: 10, lineHeight: 1.7 }}>
                ✗ Lost: {deal.name}
              </div>
            ))}
            {(d.openDeals || []).map((deal, i) => (
              <div key={i} style={{ fontSize: 11, color: '#2563eb', paddingLeft: 10, lineHeight: 1.7 }}>
                ◎ Open: {deal.name} — ${(parseFloat(deal.value || 0) / 1000).toFixed(0)}K at {deal.stage}
              </div>
            ))}
            {(teamEngagement || []).length > 0 && (
              <div style={{ marginTop: 6, fontSize: 11, color: '#6b7280' }}>
                Team engaged: {teamEngagement.map(t => `${t.first_name} ${t.last_name}`).join(', ')}
              </div>
            )}
            {(d.otherProspectsAtCompany || []).length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 4, fontWeight: 600 }}>
                  OTHER PROSPECTS AT {(prospect.company_name || '').toUpperCase()}
                </div>
                {d.otherProspectsAtCompany.map((p, i) => (
                  <div key={i} style={{
                    display: 'flex', justifyContent: 'space-between', fontSize: 12,
                    padding: '4px 0', color: '#374151',
                  }}>
                    <span>{p.first_name} {p.last_name} <span style={{ color: '#9ca3af' }}>· {p.title}</span></span>
                    <span style={{
                      fontSize: 10, padding: '1px 6px', borderRadius: 3,
                      background: ['engaged', 'discovery_call', 'qualified_sal', 'converted'].includes(p.stage) ? '#eff6ff' : '#f3f4f6',
                      color: ['engaged', 'discovery_call', 'qualified_sal', 'converted'].includes(p.stage) ? '#2563eb' : '#6b7280',
                    }}>
                      {p.stage}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Engagement stats */}
      <div style={{ borderTop: '1px solid #f3f4f6', paddingTop: 12, marginBottom: 16 }}>
        <button onClick={() => toggle('engagement')} style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '4px 0 8px', background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.8,
        }}>
          <span>Engagement</span>
          <span style={{ fontSize: 9, transition: 'transform 0.2s', transform: expanded.engagement ? 'rotate(180deg)' : 'none' }}>▼</span>
        </button>
        <div style={{ fontSize: 12, color: '#374151' }}>
          {d.sentEmailCount || 0} sent · {d.receivedEmailCount || 0} received · {Math.round((d.responseRate || 0) * 100)}% response rate
        </div>
        {expanded.engagement && (
          <div style={{ paddingTop: 8 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 6 }}>
              {[
                { label: 'Sent', value: d.sentEmailCount || 0 },
                { label: 'Received', value: d.receivedEmailCount || 0 },
                { label: 'Unanswered', value: d.unansweredCount || 0 },
                { label: 'Response', value: `${Math.round((d.responseRate || 0) * 100)}%` },
              ].map((m, i) => (
                <div key={i} style={{ textAlign: 'center', padding: 8, background: '#f9fafb', borderRadius: 6, border: '1px solid #f3f4f6' }}>
                  <div style={{ fontSize: 16, fontWeight: 600, color: '#111827' }}>{m.value}</div>
                  <div style={{ fontSize: 9, color: '#9ca3af', marginTop: 2 }}>{m.label}</div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 6, fontSize: 11, color: '#6b7280' }}>
              {d.daysSinceLastOutreach != null && `Last outreach ${d.daysSinceLastOutreach}d ago`}
              {d.daysSinceLastOutreach != null && d.daysSinceLastResponse != null && ' · '}
              {d.daysSinceLastResponse != null && `Last reply ${d.daysSinceLastResponse}d ago`}
            </div>
          </div>
        )}
      </div>

      {/* AI Outreach CTA */}
      <button
        onClick={() => onOpenOutreach && onOpenOutreach()}
        style={{
          width: '100%', padding: '10px 16px', background: '#0F9D8E',
          border: 'none', borderRadius: 8, color: '#fff', fontSize: 13,
          fontWeight: 600, cursor: 'pointer',
        }}
      >
        ✨ Generate AI Outreach
      </button>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// DRAFT CARD  — reused in SequencesView Drafts tab and prospect Activity tab
// ─────────────────────────────────────────────────────────────────────────────

function DraftCard({ draft, subject, body, isOpen, sending, sendError, onToggle, onSubjectChange, onBodyChange, onSend, onComplete, onDiscard, onConvertAndSend, compact = false }) {
  const overdue  = draft.isOverdue || (draft.scheduledSendAt && new Date(draft.scheduledSendAt) < new Date());
  const channel  = draft.channel || 'email';
  const isEmail  = channel === 'email';

  const scheduledLabel = draft.scheduledSendAt
    ? new Date(draft.scheduledSendAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : null;

  const CHANNEL_LABEL = { email: '✉️ Email', linkedin: '🔗 LinkedIn', call: '📞 Call', task: '📋 Task' };
  const channelLabel  = CHANNEL_LABEL[channel] || channel;

  return (
    <div style={{
      border: `1.5px solid ${overdue ? '#fecaca' : '#e5e7eb'}`,
      borderRadius: 10, background: '#fff', overflow: 'hidden',
    }}>
      {/* Header row */}
      <div
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 14px', cursor: 'pointer',
          background: overdue ? '#fef2f2' : '#f9fafb',
        }}
      >
        <span style={{ fontSize: 14 }}>{isEmail ? '✉️' : channel === 'linkedin' ? '🔗' : channel === 'call' ? '📞' : '📋'}</span>

        {!compact && (
          <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', flexShrink: 0 }}>
            {draft.prospect?.firstName} {draft.prospect?.lastName}
            {draft.prospect?.companyName && (
              <span style={{ fontWeight: 400, color: '#9ca3af' }}> · {draft.prospect.companyName}</span>
            )}
          </div>
        )}

        <div style={{
          fontSize: 11, color: '#6b7280',
          padding: '2px 8px', borderRadius: 10,
          background: '#eff6ff', border: '1px solid #bfdbfe',
          flexShrink: 0,
        }}>
          {draft.sequenceName} · step {draft.stepOrder}
        </div>

        <div style={{
          flex: 1, fontSize: 12, color: '#374151',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {isEmail ? (subject || '(no subject)') : channelLabel}
        </div>

        {overdue ? (
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '2px 8px',
            borderRadius: 10, background: '#fee2e2', color: '#dc2626', flexShrink: 0,
          }}>
            OVERDUE
          </span>
        ) : scheduledLabel && (
          <span style={{ fontSize: 11, color: '#9ca3af', flexShrink: 0 }}>{scheduledLabel}</span>
        )}

        <span style={{ fontSize: 11, color: '#9ca3af' }}>{isOpen ? '▲' : '▼'}</span>
      </div>

      {/* Expanded content + actions */}
      {isOpen && (
        <div style={{ padding: 14, borderTop: '1px solid #f3f4f6', display: 'flex', flexDirection: 'column', gap: 10 }}>

          {/* ── EMAIL channel ─────────────────────────────────────────── */}
          {isEmail && (
            <>
              {draft.suggestedSender && (
                <div style={{ fontSize: 11, color: '#6b7280' }}>
                  Sending from:{' '}
                  <span style={{
                    fontWeight: 600, color: '#374151',
                    background: '#f3f4f6', padding: '2px 8px', borderRadius: 5,
                  }}>
                    {draft.suggestedSender.provider === 'gmail' ? '📧' : '📮'} {draft.suggestedSender.email}
                    {draft.suggestedSender.label && ` (${draft.suggestedSender.label})`}
                  </span>
                </div>
              )}
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.3 }}>
                  Subject
                </label>
                <input
                  value={subject}
                  onChange={e => onSubjectChange(e.target.value)}
                  style={{ width: '100%', padding: '8px 11px', borderRadius: 7, border: '1px solid #e5e7eb', fontSize: 13, boxSizing: 'border-box', fontFamily: 'inherit', color: '#111' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.3 }}>
                  Body
                </label>
                <textarea
                  value={body}
                  onChange={e => onBodyChange(e.target.value)}
                  rows={8}
                  style={{ width: '100%', padding: '8px 11px', borderRadius: 7, border: '1px solid #e5e7eb', fontSize: 13, boxSizing: 'border-box', fontFamily: 'inherit', color: '#111', resize: 'vertical', lineHeight: 1.6 }}
                />
              </div>
            </>
          )}

          {/* ── LINKEDIN channel ──────────────────────────────────────── */}
          {channel === 'linkedin' && (
            <>
              {/* Banner: shown when the step has since been changed to email */}
              {onConvertAndSend && (
                <div style={{ padding: '10px 12px', background: '#fffbeb', borderRadius: 8, border: '1px solid #fcd34d', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontSize: 12, color: '#92400e' }}>
                    ⚡ This step was changed to <strong>Email</strong> after this draft was created. You can send it as an email now, or complete the LinkedIn action manually.
                  </div>
                  {!subject && (
                    <div>
                      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#92400e', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.3 }}>
                        Subject required to send as email
                      </label>
                      <input
                        value={subject}
                        onChange={e => onSubjectChange(e.target.value)}
                        placeholder="Enter email subject…"
                        style={{ width: '100%', padding: '7px 10px', borderRadius: 6, border: '1.5px solid #fcd34d', fontSize: 13, boxSizing: 'border-box', fontFamily: 'inherit', color: '#111', background: '#fff' }}
                      />
                    </div>
                  )}
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                      onClick={onConvertAndSend}
                      disabled={sending || !subject}
                      title={!subject ? 'Enter a subject line first' : ''}
                      style={{ flexShrink: 0, padding: '6px 14px', borderRadius: 7, border: 'none', background: (sending || !subject) ? '#9ca3af' : '#d97706', color: '#fff', fontSize: 12, fontWeight: 600, cursor: (sending || !subject) ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' }}
                    >
                      {sending ? '⏳ Sending…' : '📤 Send as Email'}
                    </button>
                  </div>
                </div>
              )}
              <div style={{ padding: '10px 12px', background: '#f0f9ff', borderRadius: 8, border: '1px solid #bae6fd' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#0369a1', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  🔗 LinkedIn Message
                </div>
                {body ? (
                  <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{body}</div>
                ) : (
                  <div style={{ fontSize: 12, color: '#94a3b8', fontStyle: 'italic' }}>No message template — send a personalised note.</div>
                )}
              </div>
              {draft.prospect?.linkedinUrl || draft.prospect?.linkedin_url ? (
                <a
                  href={draft.prospect.linkedinUrl || draft.prospect.linkedin_url}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '7px 14px', borderRadius: 7, fontSize: 12, fontWeight: 600,
                    background: '#0a66c2', color: '#fff', textDecoration: 'none',
                    alignSelf: 'flex-start',
                  }}
                >
                  🔗 Open LinkedIn Profile ↗
                </a>
              ) : (
                <div style={{ fontSize: 12, color: '#94a3b8', fontStyle: 'italic' }}>
                  No LinkedIn URL on this prospect — add it in their profile.
                </div>
              )}
              <div style={{ fontSize: 11, color: '#6b7280', background: '#f8fafc', borderRadius: 6, padding: '8px 10px' }}>
                💡 Send the message directly on LinkedIn, then click <strong>Mark as Done</strong> to advance the sequence.
              </div>
            </>
          )}

          {/* ── CALL / TASK channel ───────────────────────────────────── */}
          {(channel === 'call' || channel === 'task') && (
            <>
              <div style={{ padding: '10px 12px', background: '#f9fafb', borderRadius: 8, border: '1px solid #e5e7eb' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {channel === 'call' ? '📞 Call Note' : '📋 Task Note'}
                </div>
                {draft.taskNote || body ? (
                  <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                    {draft.taskNote || body}
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: '#94a3b8', fontStyle: 'italic' }}>No note for this step.</div>
                )}
              </div>
              <div style={{ fontSize: 11, color: '#6b7280', background: '#f8fafc', borderRadius: 6, padding: '8px 10px' }}>
                💡 {channel === 'call' ? 'Make the call' : 'Complete the task'}, then click <strong>Mark as Done</strong> to advance the sequence.
              </div>
            </>
          )}

          {sendError && (
            <div style={{ padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, fontSize: 12, color: '#dc2626' }}>
              ⚠️ {sendError}
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              onClick={onDiscard}
              style={{ padding: '7px 14px', borderRadius: 7, border: '1px solid #fecaca', background: '#fef2f2', color: '#dc2626', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
            >
              🗑 Discard
            </button>
            {isEmail ? (
              <button
                onClick={onSend}
                disabled={sending}
                style={{
                  padding: '7px 18px', borderRadius: 7, border: 'none',
                  background: sending ? '#9ca3af' : '#0F9D8E', color: '#fff',
                  fontSize: 12, fontWeight: 600, cursor: sending ? 'not-allowed' : 'pointer',
                }}
              >
                {sending ? '⏳ Sending…' : '📤 Send Now'}
              </button>
            ) : (
              <button
                onClick={onComplete}
                disabled={sending}
                style={{
                  padding: '7px 18px', borderRadius: 7, border: 'none',
                  background: sending ? '#9ca3af' : '#0F9D8E', color: '#fff',
                  fontSize: 12, fontWeight: 600, cursor: sending ? 'not-allowed' : 'pointer',
                }}
              >
                {sending ? '⏳ Saving…' : '✅ Mark as Done'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function InfoRow({ label, value, optional = false, editMode = false, editValue, onEdit }) {
  // optional=true rows are hidden when empty in view mode
  if (!editMode && optional && !value && value !== 0) return null;
  const isEmpty = value === null || value === undefined || value === '';
  return (
    <div className="pv-info-row">
      <span className="pv-info-label">{label}</span>
      {editMode && onEdit ? (
        <input
          value={editValue ?? ''}
          onChange={e => onEdit(e.target.value)}
          style={{
            flex: 1, fontSize: 12, padding: '2px 6px',
            border: '1px solid #d1d5db', borderRadius: 4,
            color: '#374151', background: '#fff', minWidth: 0,
          }}
        />
      ) : (
        <span className="pv-info-value" style={isEmpty ? { color: '#9ca3af' } : {}}>
          {!isEmpty ? value : '—'}
        </span>
      )}
    </div>
  );
}



// ═════════════════════════════════════════════════════════════════════════════
// SEQUENCES VIEW
// Manage sequences + enrollments. Embedded in the Sequences tab of ProspectingView.
// ═════════════════════════════════════════════════════════════════════════════

function SequencesView({ prospects }) {
  const [subTab,       setSubTab]       = useState('library');   // library | drafts | enrollments | stats
  const [sequences,    setSequences]    = useState([]);
  const [enrollments,  setEnrollments]  = useState([]);
  const [drafts,       setDrafts]       = useState([]);
  const [loadingSeq,   setLoadingSeq]   = useState(true);
  const [loadingEnr,   setLoadingEnr]   = useState(false);
  const [loadingDrafts,setLoadingDrafts]= useState(false);
  const [showBuilder,  setShowBuilder]  = useState(false);
  const [editingSeq,   setEditingSeq]   = useState(null);
  const [viewingSeq,   setViewingSeq]   = useState(null); // full sequence for read-only view
  const [showEnroll,   setShowEnroll]   = useState(false);
  const [enrollSeqId,  setEnrollSeqId]  = useState(null);
  const [selectedProspects, setSelectedProspects] = useState([]);
  const [error,        setError]        = useState('');

  // Enrollment drill-down
  const [expandedEnrollId,   setExpandedEnrollId]   = useState(null);
  const [expandedLogs,       setExpandedLogs]       = useState([]);
  const [loadingLogs,        setLoadingLogs]        = useState(false);
  const [expandedStepBody,   setExpandedStepBody]   = useState({}); // { [step_order]: bool }

  // Draft inline-edit state: { [draftId]: { subject, body, editing, sending, error } }
  const [draftEdits,   setDraftEdits]   = useState({});

  // Open builder in edit mode — fetches full sequence (with steps) before opening.
  // The list endpoint only returns step_count, not the steps array.
  const openBuilderForEdit = async (seq) => {
    try {
      const r = await apiFetch(`/sequences/${seq.id}`);
      setEditingSeq(r.sequence);
      setShowBuilder(true);
    } catch (err) {
      setError('Failed to load sequence: ' + (err.message || 'unknown error'));
    }
  };

  // Open read-only view panel — fetches full sequence with steps.
  const openViewPanel = async (seq) => {
    try {
      const r = await apiFetch(`/sequences/${seq.id}`);
      setViewingSeq(r.sequence);
    } catch (err) {
      setError('Failed to load sequence: ' + (err.message || 'unknown error'));
    }
  };

  const toggleEnrollLogs = async (enrollId) => {
    if (expandedEnrollId === enrollId) {
      setExpandedEnrollId(null);
      setExpandedLogs([]);
      setExpandedStepBody({});
      return;
    }
    setExpandedEnrollId(enrollId);
    setExpandedLogs([]);
    setExpandedStepBody({});
    setLoadingLogs(true);
    try {
      const r = await apiFetch(`/sequences/enrollments/${enrollId}`);
      setExpandedLogs(r.logs || []);
    } catch (err) {
      setError('Failed to load step history: ' + err.message);
    } finally {
      setLoadingLogs(false);
    }
  };

  const loadDrafts = useCallback(async () => {
    setLoadingDrafts(true);
    try {
      const r = await apiFetch('/sequences/drafts');
      setDrafts(r.drafts || []);
    } catch (err) {
      setError('Failed to load drafts: ' + err.message);
    } finally {
      setLoadingDrafts(false);
    }
  }, []);

  const handleConvertAndSendDraft = async (draft) => {
    const edit = draftEdits[draft.id] || {};
    const subject = edit.subject !== undefined ? edit.subject : draft.subject;
    if (!subject) {
      setDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], error: 'Please enter a subject line before sending.' } }));
      return;
    }
    setDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], sending: true, error: null } }));
    try {
      // Patch channel to email and ensure subject is saved, then send
      await apiFetch(`/sequences/drafts/${draft.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ channel: 'email', subject }),
      });
      await apiFetch(`/sequences/drafts/${draft.id}/send`, { method: 'POST', body: JSON.stringify({}) });
      setDrafts(prev => prev.filter(d => d.id !== draft.id));
      setDraftEdits(prev => { const n = { ...prev }; delete n[draft.id]; return n; });
    } catch (err) {
      setDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], sending: false, error: err.message } }));
    }
  };

  const handleSendDraft = async (draft) => {
    if (draft.channel && draft.channel !== 'email') { console.error(`handleSendDraft called on ${draft.channel} draft — blocked`); return; }
    const edit = draftEdits[draft.id] || {};
    setDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], sending: true, error: null } }));
    try {
      // Save edits first if any
      if (edit.subject !== undefined || edit.body !== undefined) {
        await apiFetch(`/sequences/drafts/${draft.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            subject: edit.subject !== undefined ? edit.subject : draft.subject,
            body:    edit.body    !== undefined ? edit.body    : draft.body,
          }),
        });
      }
      const sendRes = await apiFetch(`/sequences/drafts/${draft.id}/send`, { method: 'POST', body: JSON.stringify({}) });
      // Backend returns { ok, emailSent, sendError } — if emailSent is false the
      // draft was marked sent in DB but the email never left. With the new fail-fast
      // backend this shouldn't happen, but guard here too.
      if (sendRes && sendRes.emailSent === false && sendRes.sendError) {
        setDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], sending: false, error: sendRes.sendError } }));
        return;
      }
      setDrafts(prev => prev.filter(d => d.id !== draft.id));
      setDraftEdits(prev => { const n = { ...prev }; delete n[draft.id]; return n; });
    } catch (err) {
      setDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], sending: false, error: err.message } }));
    }
  };

  const handleDiscardDraft = async (draftId) => {
    if (!window.confirm('Discard this draft? The step will be skipped and the sequence will advance.')) return;
    try {
      await apiFetch(`/sequences/drafts/${draftId}`, { method: 'DELETE' });
      setDrafts(prev => prev.filter(d => d.id !== draftId));
      setDraftEdits(prev => { const n = { ...prev }; delete n[draftId]; return n; });
    } catch (err) {
      setError('Failed to discard draft: ' + err.message);
    }
  };

  const handleMarkDoneDraft = async (draftId) => {
    setDraftEdits(prev => ({ ...prev, [draftId]: { ...prev[draftId], sending: true, error: null } }));
    try {
      await apiFetch(`/sequences/drafts/${draftId}/complete`, { method: 'POST', body: JSON.stringify({}) });
      setDrafts(prev => prev.filter(d => d.id !== draftId));
      setDraftEdits(prev => { const n = { ...prev }; delete n[draftId]; return n; });
    } catch (err) {
      setDraftEdits(prev => ({ ...prev, [draftId]: { ...prev[draftId], sending: false, error: err.message } }));
    }
  };

  // Stats
  const [statsSeqId,   setStatsSeqId]   = useState(null);
  const [stats,        setStats]        = useState(null);
  const [loadingStats, setLoadingStats] = useState(false);

  const loadStats = useCallback(async (seqId) => {
    setLoadingStats(true);
    setStats(null);
    setError('');
    try {
      const r = await apiFetch(`/sequences/${seqId}/stats`);
      setStats(r);
    } catch (err) {
      setError('Failed to load stats: ' + err.message);
    } finally {
      setLoadingStats(false);
    }
  }, []);

  const openStats = (seqId) => {
    setStatsSeqId(seqId);
    setSubTab('stats');
    loadStats(seqId);
  };

  const loadSequences = useCallback(async () => {
    setLoadingSeq(true);
    setError('');
    try {
      const r = await apiFetch('/sequences');
      setSequences(r.sequences || []);
    } catch (err) {
      setError('Failed to load sequences: ' + err.message);
    } finally {
      setLoadingSeq(false);
    }
  }, []);

  const loadEnrollments = useCallback(async () => {
    setLoadingEnr(true);
    try {
      const r = await apiFetch('/sequences/enrollments');
      setEnrollments(r.enrollments || []);
    } catch (err) {
      setError('Failed to load enrollments: ' + err.message);
    } finally {
      setLoadingEnr(false);
    }
  }, []);

  useEffect(() => { loadSequences(); }, [loadSequences]);
  useEffect(() => {
    if (subTab === 'enrollments') loadEnrollments();
    if (subTab === 'drafts')      loadDrafts();
  }, [subTab, loadEnrollments, loadDrafts]);

  const handleArchive = async (seqId) => {
    if (!window.confirm('Archive this sequence? Existing enrollments will not be affected.')) return;
    try {
      await apiFetch(`/sequences/${seqId}`, { method: 'DELETE' });
      loadSequences();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleStopEnrollment = async (enrollId) => {
    if (!window.confirm('Stop this enrollment? No further steps will fire.')) return;
    try {
      await apiFetch(`/sequences/enrollments/${enrollId}/stop`, { method: 'POST', body: JSON.stringify({ reason: 'manual' }) });
      loadEnrollments();
    } catch (err) {
      setError(err.message);
    }
  };

  const openEnroll = (seqId) => {
    setEnrollSeqId(seqId);
    // Use all prospects or let user pick — for now open modal with full list
    setSelectedProspects(prospects.slice(0, 1)); // default: first prospect; bulk via checkboxes TBD
    setShowEnroll(true);
  };

  const STATUS_COLORS = {
    active:    { bg: '#d1fae5', color: '#065f46' },
    paused:    { bg: '#fef3c7', color: '#92400e' },
    completed: { bg: '#eff6ff', color: '#1d4ed8' },
    stopped:   { bg: '#fee2e2', color: '#991b1b' },
    replied:   { bg: '#f0fdf4', color: '#166534' },
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>

      {/* ── Sub-tab bar ─────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 16px', borderBottom: '1px solid #e5e7eb', background: '#fff', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', gap: 0 }}>
          {[
            { key: 'library',     label: `📚 Library (${sequences.length})` },
            { key: 'drafts',      label: `📋 Drafts${drafts.length > 0 ? ` (${drafts.length})` : ''}` },
            { key: 'enrollments', label: '🗓 Enrollments' },
            { key: 'stats',       label: '📊 Stats' },
          ].map(t => (
            <button
              key={t.key}
              onClick={() => setSubTab(t.key)}
              style={{
                padding: '6px 16px', border: 'none', borderRadius: 7,
                background: subTab === t.key ? '#0F9D8E' : 'transparent',
                color: subTab === t.key ? '#fff' : '#6b7280',
                fontSize: 12, fontWeight: 600, cursor: 'pointer',
                marginRight: 2,
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {subTab === 'library' && (
          <button
            onClick={() => { setEditingSeq(null); setShowBuilder(true); }}
            style={{
              padding: '7px 16px', borderRadius: 7, border: 'none',
              background: '#0F9D8E', color: '#fff',
              fontSize: 12, fontWeight: 600, cursor: 'pointer',
            }}
          >
            + New Sequence
          </button>
        )}
      </div>

      {error && (
        <div style={{ margin: '10px 16px 0', padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 7, fontSize: 12, color: '#dc2626' }}>
          ⚠️ {error}
        </div>
      )}

      {/* ── Library tab ─────────────────────────────────────────────────── */}
      {subTab === 'library' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
          {loadingSeq ? (
            <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Loading sequences…</div>
          ) : sequences.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 60 }}>
              <div style={{ fontSize: 36, marginBottom: 10 }}>📨</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#374151', marginBottom: 6 }}>No sequences yet</div>
              <div style={{ fontSize: 13, color: '#9ca3af', marginBottom: 18 }}>
                Build a multi-step outreach sequence, then enroll prospects to automate follow-ups.
              </div>
              <button
                onClick={() => { setEditingSeq(null); setShowBuilder(true); }}
                style={{
                  padding: '9px 22px', borderRadius: 8, border: 'none',
                  background: '#0F9D8E', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                }}
              >
                Create First Sequence
              </button>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
              {sequences.map(seq => (
                <div key={seq.id} style={{
                  border: '1px solid #e5e7eb', borderRadius: 12, background: '#fff',
                  overflow: 'hidden',
                  boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
                }}>
                  <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid #f3f4f6' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                      <div style={{ fontWeight: 700, fontSize: 14, color: '#111827', lineHeight: 1.3 }}>
                        {seq.name}
                      </div>
                      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                        <button
                          onClick={() => openViewPanel(seq)}
                          title="View steps"
                          style={{ padding: '3px 8px', borderRadius: 5, border: '1px solid #e5e7eb', background: '#fff', color: '#6b7280', fontSize: 11, cursor: 'pointer' }}
                        >
                          👁
                        </button>
                        <button
                          onClick={() => openBuilderForEdit(seq)}
                          title="Edit"
                          style={{ padding: '3px 8px', borderRadius: 5, border: '1px solid #e5e7eb', background: '#fff', color: '#6b7280', fontSize: 11, cursor: 'pointer' }}
                        >
                          ✏️
                        </button>
                        <button
                          onClick={() => handleArchive(seq.id)}
                          title="Archive"
                          style={{ padding: '3px 8px', borderRadius: 5, border: '1px solid #e5e7eb', background: '#fff', color: '#9ca3af', fontSize: 11, cursor: 'pointer' }}
                        >
                          🗃
                        </button>
                      </div>
                    </div>
                    {seq.description && (
                      <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>{seq.description}</div>
                    )}
                  </div>

                  <div style={{ padding: '10px 16px', display: 'flex', gap: 16, fontSize: 12 }}>
                    <span style={{ color: '#374151', fontWeight: 600 }}>{seq.step_count || 0} steps</span>
                    {seq.enrollment_count > 0 && (
                      <span style={{ color: '#0F9D8E', fontWeight: 600 }}>{seq.enrollment_count} active</span>
                    )}
                    <span style={{ color: '#9ca3af', fontSize: 11 }}>
                      {seq.created_at ? new Date(seq.created_at).toLocaleDateString() : ''}
                    </span>
                  </div>

                  <div style={{ padding: '0 16px 14px', display: 'flex', gap: 8 }}>
                    <button
                      onClick={() => openEnroll(seq.id)}
                      style={{
                        flex: 1, padding: '7px', borderRadius: 7,
                        background: '#f0fdf4', border: '1px solid #bbf7d0',
                        color: '#065f46', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                      }}
                    >
                      🚀 Enroll Prospect
                    </button>
                    <button
                      onClick={() => { setSubTab('enrollments'); loadEnrollments(); }}
                      style={{
                        padding: '7px 10px', borderRadius: 7,
                        border: '1px solid #e5e7eb', background: '#fff',
                        color: '#6b7280', fontSize: 12, cursor: 'pointer',
                      }}
                    >
                      🗓
                    </button>
                    <button
                      onClick={() => openStats(seq.id)}
                      style={{
                        padding: '7px 10px', borderRadius: 7,
                        border: '1px solid #e5e7eb', background: '#fff',
                        color: '#6b7280', fontSize: 12, cursor: 'pointer',
                      }}
                    >
                      📊
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Drafts tab ──────────────────────────────────────────────────── */}
      {subTab === 'drafts' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
          {loadingDrafts ? (
            <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Loading drafts…</div>
          ) : drafts.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 60 }}>
              <div style={{ fontSize: 32, marginBottom: 10 }}>✅</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#374151', marginBottom: 6 }}>No drafts waiting</div>
              <div style={{ fontSize: 13, color: '#9ca3af' }}>
                Drafted emails will appear here when sequences fire steps that require review.
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {drafts.map(draft => {
                const edit    = draftEdits[draft.id] || {};
                const subject = edit.subject !== undefined ? edit.subject : draft.subject;
                const body    = edit.body    !== undefined ? edit.body    : draft.body;
                const isOpen  = !!edit.open;
                return (
                  <DraftCard
                    key={draft.id}
                    draft={draft}
                    subject={subject}
                    body={body}
                    isOpen={isOpen}
                    sending={!!edit.sending}
                    sendError={edit.error || null}
                    onToggle={() => setDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], open: !isOpen } }))}
                    onSubjectChange={v => setDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], subject: v } }))}
                    onBodyChange={v => setDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], body: v } }))}
                    onSend={() => handleSendDraft(draft)}
                    onComplete={() => handleMarkDoneDraft(draft.id)}
                    onDiscard={() => handleDiscardDraft(draft.id)}
                    onConvertAndSend={() => handleConvertAndSendDraft(draft)}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Enrollments tab ─────────────────────────────────────────────── */}
      {subTab === 'enrollments' && (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loadingEnr ? (
            <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Loading…</div>
          ) : enrollments.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>📭</div>
              No enrollments yet. Enroll prospects from the Library tab.
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
                  {['Prospect', 'Sequence', 'Status', 'Step', 'Next Due', 'Enrolled', ''].map(h => (
                    <th key={h} style={{
                      padding: '9px 14px', textAlign: 'left', fontSize: 11,
                      fontWeight: 700, color: '#6b7280', textTransform: 'uppercase',
                      letterSpacing: 0.5, whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {enrollments.map(e => {
                  const sc = STATUS_COLORS[e.status] || { bg: '#f3f4f6', color: '#6b7280' };
                  const isExpanded = expandedEnrollId === e.id;
                  return (
                    <React.Fragment key={e.id}>
                      <tr
                        style={{ borderBottom: isExpanded ? 'none' : '1px solid #f3f4f6', cursor: 'pointer' }}
                        onClick={() => toggleEnrollLogs(e.id)}
                      >
                        <td style={{ padding: '9px 14px' }}>
                          <div style={{ fontWeight: 600, color: '#1a202c' }}>{e.first_name} {e.last_name}</div>
                          {e.email && <div style={{ fontSize: 11, color: '#94a3b8' }}>{e.email}</div>}
                        </td>
                        <td style={{ padding: '9px 14px', color: '#374151' }}>{e.sequence_name}</td>
                        <td style={{ padding: '9px 14px' }}>
                          <span style={{
                            padding: '2px 9px', borderRadius: 10, fontSize: 11, fontWeight: 600,
                            background: sc.bg, color: sc.color,
                          }}>
                            {e.status}
                          </span>
                          {e.stop_reason && (
                            <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 1 }}>{e.stop_reason}</div>
                          )}
                        </td>
                        <td style={{ padding: '9px 14px', color: '#374151', textAlign: 'center' }}>
                          {e.status === 'active' ? e.current_step : '—'}
                        </td>
                        <td style={{ padding: '9px 14px', color: '#6b7280', fontSize: 12, whiteSpace: 'nowrap' }}>
                          {e.next_step_due && e.status === 'active'
                            ? new Date(e.next_step_due).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                            : '—'}
                        </td>
                        <td style={{ padding: '9px 14px', color: '#9ca3af', fontSize: 11, whiteSpace: 'nowrap' }}>
                          {new Date(e.enrolled_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                        </td>
                        <td style={{ padding: '9px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
                          {e.status === 'active' && (
                            <button
                              onClick={(ev) => { ev.stopPropagation(); handleStopEnrollment(e.id); }}
                              style={{
                                padding: '3px 10px', borderRadius: 6, fontSize: 11,
                                border: '1px solid #fecaca', background: '#fef2f2',
                                color: '#dc2626', cursor: 'pointer', fontWeight: 500,
                              }}
                            >
                              Stop
                            </button>
                          )}
                          <span style={{ fontSize: 11, color: '#9ca3af' }}>{isExpanded ? '▲' : '▼'}</span>
                        </td>
                      </tr>

                      {/* ── Step timeline drill-down ──────────────────────── */}
                      {isExpanded && (
                        <tr style={{ borderBottom: '1px solid #f3f4f6' }}>
                          <td colSpan={7} style={{ padding: '0 14px 14px 40px', background: '#f9fafb' }}>
                            {loadingLogs ? (
                              <div style={{ padding: '12px 0', fontSize: 12, color: '#9ca3af' }}>Loading timeline…</div>
                            ) : expandedLogs.length === 0 ? (
                              <div style={{ padding: '12px 0', fontSize: 12, color: '#9ca3af' }}>No steps yet.</div>
                            ) : (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 0, paddingTop: 12 }}>
                                {expandedLogs.map((step, idx) => {
                                  const STEP_CHANNEL_ICONS = { email: '✉️', linkedin: '🔗', call: '📞', task: '📋', manual: '📋' };
                                  const icon = STEP_CHANNEL_ICONS[step.channel] || '📋';
                                  const isFuture  = step.is_future;
                                  const isDraft   = step.status === 'draft';
                                  const isSent    = step.status === 'sent';
                                  const isSkipped = step.status === 'skipped';
                                  const isFailed  = step.status === 'failed';
                                  const isLast    = idx === expandedLogs.length - 1;

                                  // Status pill config
                                  const pillCfg = isSent    ? { bg: '#d1fae5', color: '#065f46', label: 'Sent' }
                                    : isDraft   ? { bg: '#fef3c7', color: '#92400e', label: 'Draft – awaiting send' }
                                    : isSkipped ? { bg: '#f3f4f6', color: '#6b7280', label: 'Skipped' }
                                    : isFailed  ? { bg: '#fee2e2', color: '#dc2626', label: 'Failed' }
                                    : isFuture  ? { bg: '#eff6ff', color: '#3b82f6', label: 'Planned' }
                                    :             { bg: '#f3f4f6', color: '#6b7280', label: step.status };

                                  // Timestamp to show
                                  const timestamp = isSent || isDraft
                                    ? (step.fired_at || step.scheduled_send_at)
                                    : step.scheduled_send_at;

                                  const formattedDate = timestamp
                                    ? new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
                                    : null;

                                  // Content to show: actual subject for sent, template for planned
                                  const displaySubject = step.subject || step.subject_template || null;
                                  const displayNote    = step.task_note || null;

                                  return (
                                    <div key={step.step_order} style={{ display: 'flex', gap: 0 }}>
                                      {/* Timeline spine */}
                                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 32, flexShrink: 0 }}>
                                        <div style={{
                                          width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
                                          background: isSent ? '#0F9D8E' : isFuture ? '#e5e7eb' : isDraft ? '#f59e0b' : '#6b7280',
                                          color: isSent ? '#fff' : isFuture ? '#9ca3af' : '#fff',
                                          fontSize: 11, fontWeight: 700,
                                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                                          border: isFuture ? '2px dashed #d1d5db' : 'none',
                                        }}>
                                          {isSent ? '✓' : step.step_order}
                                        </div>
                                        {!isLast && (
                                          <div style={{
                                            width: 2, flex: 1, minHeight: 16,
                                            background: isFuture ? '#e5e7eb' : '#0F9D8E',
                                            margin: '2px 0',
                                          }} />
                                        )}
                                      </div>

                                      {/* Step content */}
                                      <div style={{
                                        flex: 1, marginLeft: 10, marginBottom: isLast ? 0 : 12,
                                        padding: '8px 12px',
                                        background: isFuture ? '#f9fafb' : '#fff',
                                        border: `1px solid ${isDraft ? '#fde68a' : isFuture ? '#e5e7eb' : '#e5e7eb'}`,
                                        borderRadius: 8,
                                        opacity: isSkipped ? 0.5 : 1,
                                      }}>
                                        {/* Top row: channel + status + date */}
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                          <span style={{ fontSize: 13 }}>{icon}</span>
                                          <span style={{ fontSize: 12, fontWeight: 600, color: '#374151', textTransform: 'capitalize' }}>
                                            {step.channel}
                                          </span>
                                          {step.delay_days > 0 && (
                                            <span style={{ fontSize: 11, color: '#9ca3af' }}>
                                              +{step.delay_days}d
                                            </span>
                                          )}
                                          <span style={{
                                            fontSize: 10, fontWeight: 700, padding: '2px 8px',
                                            borderRadius: 10, background: pillCfg.bg, color: pillCfg.color,
                                          }}>
                                            {pillCfg.label}
                                          </span>
                                          {formattedDate && (
                                            <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 'auto' }}>
                                              {isSent ? '✉ Sent ' : isFuture ? '📅 Due ' : ''}{formattedDate}
                                            </span>
                                          )}
                                        </div>

                                        {/* Subject / task note */}
                                        {displaySubject && (
                                          <div style={{
                                            fontSize: 12, color: isFuture ? '#9ca3af' : '#1a202c',
                                            fontWeight: isFuture ? 400 : 500,
                                            marginTop: 5,
                                            fontStyle: isFuture && !step.subject ? 'italic' : 'normal',
                                          }}>
                                            {displaySubject}
                                            {isFuture && !step.subject && (
                                              <span style={{ fontSize: 10, color: '#9ca3af', marginLeft: 6 }}>(template)</span>
                                            )}
                                          </div>
                                        )}
                                        {!displaySubject && displayNote && (
                                          <div style={{ fontSize: 12, color: isFuture ? '#9ca3af' : '#374151', marginTop: 5 }}>
                                            {displayNote}
                                          </div>
                                        )}

                                        {/* Body preview — sent emails only */}
                                        {isSent && step.body && (
                                          <div style={{ marginTop: 4 }}>
                                            <div style={{
                                              fontSize: 11, color: '#6b7280', lineHeight: 1.6,
                                              whiteSpace: 'pre-wrap',
                                              maxHeight: expandedStepBody[step.step_order] ? 'none' : 48,
                                              overflow: 'hidden',
                                              ...(!expandedStepBody[step.step_order] ? {
                                                maskImage: 'linear-gradient(to bottom, black 40%, transparent)',
                                                WebkitMaskImage: 'linear-gradient(to bottom, black 40%, transparent)',
                                              } : {}),
                                            }}>
                                              {stripHtml(step.body)}
                                            </div>
                                            <button
                                              onClick={() => setExpandedStepBody(prev => ({ ...prev, [step.step_order]: !prev[step.step_order] }))}
                                              style={{
                                                marginTop: 4, padding: '2px 8px',
                                                fontSize: 11, fontWeight: 600,
                                                color: '#0F9D8E', background: 'none',
                                                border: '1px solid #0F9D8E',
                                                borderRadius: 5, cursor: 'pointer',
                                              }}
                                            >
                                              {expandedStepBody[step.step_order] ? '▲ Collapse' : '▼ View full email'}
                                            </button>
                                          </div>
                                        )}

                                        {/* Body template — future email steps */}
                                        {isFuture && step.channel === 'email' && step.body_template && (
                                          <div style={{ marginTop: 4 }}>
                                            {expandedStepBody[step.step_order] && (
                                              <div style={{
                                                fontSize: 11, color: '#9ca3af', lineHeight: 1.6,
                                                whiteSpace: 'pre-wrap',
                                                padding: '8px 10px',
                                                background: '#f9fafb',
                                                border: '1px dashed #e5e7eb',
                                                borderRadius: 6,
                                                marginBottom: 4,
                                              }}>
                                                {step.body_template}
                                                {!step.is_personalised && (
                                                  <div style={{ marginTop: 6, fontSize: 10, color: '#d1d5db', fontStyle: 'italic' }}>
                                                    Template — tokens like {'{{first_name}}'} will be replaced when sent
                                                  </div>
                                                )}
                                              </div>
                                            )}
                                            <button
                                              onClick={() => setExpandedStepBody(prev => ({ ...prev, [step.step_order]: !prev[step.step_order] }))}
                                              style={{
                                                marginTop: 2, padding: '2px 8px',
                                                fontSize: 11, fontWeight: 600,
                                                color: '#6b7280', background: 'none',
                                                border: '1px solid #d1d5db',
                                                borderRadius: 5, cursor: 'pointer',
                                              }}
                                            >
                                              {expandedStepBody[step.step_order] ? '▲ Hide template' : '▼ Preview template'}
                                            </button>
                                          </div>
                                        )}

                                        {/* Error message */}
                                        {isFailed && step.error_message && (
                                          <div style={{ fontSize: 11, color: '#dc2626', marginTop: 4 }}>
                                            ⚠️ {step.error_message}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── Stats tab ───────────────────────────────────────────────────── */}
      {subTab === 'stats' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
          {/* Sequence picker */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.3 }}>
              Select Sequence
            </label>
            <select
              value={statsSeqId || ''}
              onChange={e => { const v = parseInt(e.target.value); setStatsSeqId(v); loadStats(v); }}
              style={{ padding: '7px 11px', borderRadius: 7, border: '1px solid #e5e7eb', fontSize: 13, background: '#fff', minWidth: 260 }}
            >
              <option value="">— choose a sequence —</option>
              {sequences.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>

          {loadingStats && (
            <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Loading stats…</div>
          )}

          {!loadingStats && !stats && !statsSeqId && (
            <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>📊</div>
              Select a sequence above to view its performance stats.
            </div>
          )}

          {!loadingStats && stats && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

              {/* Top-line numbers */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
                {[
                  { label: 'Enrolled',    value: stats.totalEnrolled,              color: '#374151' },
                  { label: 'Replied',     value: stats.totalReplied,               color: '#0F9D8E' },
                  { label: 'Reply Rate',  value: `${stats.replyRate}%`,            color: '#0F9D8E' },
                  { label: 'Avg Reply At',value: stats.avgReplyStep ? `Step ${stats.avgReplyStep}` : '—', color: '#6b7280' },
                ].map(({ label, value, color }) => (
                  <div key={label} style={{
                    padding: '14px 16px', background: '#fff',
                    border: '1px solid #e5e7eb', borderRadius: 10,
                    boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
                  }}>
                    <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>{label}</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
                  </div>
                ))}
              </div>

              {/* Status breakdown */}
              <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '14px 16px' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 12 }}>Enrollment Status</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {[
                    { key: 'active',    label: 'Active',    bg: '#d1fae5', color: '#065f46' },
                    { key: 'replied',   label: 'Replied',   bg: '#ccfbf1', color: '#0d9488' },
                    { key: 'completed', label: 'Completed', bg: '#eff6ff', color: '#1d4ed8' },
                    { key: 'paused',    label: 'Paused',    bg: '#fef3c7', color: '#92400e' },
                    { key: 'stopped',   label: 'Stopped',   bg: '#fee2e2', color: '#991b1b' },
                  ].map(({ key, label, bg, color }) => (
                    <div key={key} style={{
                      padding: '6px 14px', borderRadius: 20, background: bg,
                      fontSize: 12, fontWeight: 600, color,
                    }}>
                      {label}: {stats.statusBreakdown[key] || 0}
                    </div>
                  ))}
                </div>
              </div>

              {/* Step funnel */}
              {stats.stepFunnel && stats.stepFunnel.length > 0 && (
                <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '14px 16px' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 14 }}>Step Funnel</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {stats.stepFunnel.map((s) => {
                      const barMax   = stats.totalEnrolled || 1;
                      const barPct   = Math.round((s.sent / barMax) * 100);
                      const replyPct = s.sent > 0 ? Math.round((s.replied_here / s.sent) * 100) : 0;
                      return (
                        <div key={s.step_order}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                            <div style={{
                              width: 22, height: 22, borderRadius: '50%',
                              background: '#0F9D8E', color: '#fff',
                              fontSize: 11, fontWeight: 700,
                              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                            }}>
                              {s.step_order}
                            </div>
                            <div style={{ flex: 1 }}>
                              <div style={{
                                height: 10, borderRadius: 5, background: '#f3f4f6', overflow: 'hidden',
                              }}>
                                <div style={{
                                  width: `${barPct}%`, height: '100%',
                                  background: 'linear-gradient(90deg, #0F9D8E, #0d8a7c)',
                                  borderRadius: 5, transition: 'width 0.4s ease',
                                }} />
                              </div>
                            </div>
                            <div style={{ fontSize: 12, color: '#374151', minWidth: 70, textAlign: 'right' }}>
                              <strong>{s.sent}</strong> <span style={{ color: '#9ca3af' }}>sent</span>
                            </div>
                            {s.replied_here > 0 && (
                              <div style={{
                                fontSize: 11, color: '#0d9488', fontWeight: 600,
                                background: '#ccfbf1', padding: '2px 8px', borderRadius: 10,
                                minWidth: 80, textAlign: 'center',
                              }}>
                                {s.replied_here} replied ({replyPct}%)
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {stats.totalEnrolled === 0 && (
                    <div style={{ textAlign: 'center', padding: '20px 0', color: '#9ca3af', fontSize: 13 }}>
                      No steps fired yet — enroll some prospects to start seeing data.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Sequence View Panel ─────────────────────────────────────────── */}
      {viewingSeq && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.35)',
          display: 'flex', justifyContent: 'flex-end',
        }}
          onClick={e => { if (e.target === e.currentTarget) setViewingSeq(null); }}
        >
          <div style={{
            width: 520, maxWidth: '95vw', height: '100%',
            background: '#fff', overflowY: 'auto',
            boxShadow: '-4px 0 24px rgba(0,0,0,0.12)',
            display: 'flex', flexDirection: 'column',
          }}>
            {/* Header */}
            <div style={{
              padding: '20px 24px 16px', borderBottom: '1px solid #e5e7eb',
              display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
            }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#0F9D8E', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                  SEQUENCE
                </div>
                <div style={{ fontWeight: 700, fontSize: 16, color: '#111827', lineHeight: 1.3 }}>
                  {viewingSeq.name}
                </div>
                {viewingSeq.description && (
                  <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6, lineHeight: 1.5 }}>
                    {viewingSeq.description}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 12, color: '#9ca3af' }}>
                  <span>{(viewingSeq.steps || []).length} steps</span>
                  <span>Draft before sending: {viewingSeq.require_approval ? 'Yes' : 'No'}</span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                <button
                  onClick={() => { setViewingSeq(null); openBuilderForEdit(viewingSeq); }}
                  style={{
                    padding: '6px 14px', borderRadius: 7, fontSize: 12, fontWeight: 600,
                    background: '#1A3A5C', color: '#fff', border: 'none', cursor: 'pointer',
                  }}
                >
                  ✏️ Edit
                </button>
                <button
                  onClick={() => setViewingSeq(null)}
                  style={{
                    padding: '6px 10px', borderRadius: 7, fontSize: 16,
                    background: 'none', border: '1px solid #e5e7eb', color: '#6b7280', cursor: 'pointer',
                  }}
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Steps */}
            <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
              {(viewingSeq.steps || []).length === 0 ? (
                <div style={{ textAlign: 'center', color: '#9ca3af', padding: 40 }}>No steps yet</div>
              ) : (
                (viewingSeq.steps || []).map((step, idx) => {
                  const channelEmoji = { email: '✉️', linkedin: '🔗', call: '📞', task: '📋' }[step.channel] || '📋';
                  const hasContent   = step.subject_template || step.body_template || step.task_note;
                  return (
                    <div key={step.id || idx} style={{
                      border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden',
                    }}>
                      {/* Step header */}
                      <div style={{
                        padding: '10px 14px',
                        background: '#f8fafc',
                        display: 'flex', alignItems: 'center', gap: 10,
                        borderBottom: hasContent ? '1px solid #e5e7eb' : 'none',
                      }}>
                        <div style={{
                          width: 24, height: 24, borderRadius: '50%',
                          background: '#0F9D8E', color: '#fff',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 11, fontWeight: 700, flexShrink: 0,
                        }}>
                          {idx + 1}
                        </div>
                        <span style={{ fontSize: 14 }}>{channelEmoji}</span>
                        <span style={{ fontWeight: 600, fontSize: 13, color: '#111827', textTransform: 'capitalize' }}>
                          {step.channel}
                        </span>
                        <span style={{ fontSize: 12, color: '#9ca3af' }}>
                          {step.delay_days === 0 ? 'Day 0 (on enroll)' : `Day +${step.delay_days}`}
                        </span>
                        {step.require_approval === true && (
                          <span style={{ marginLeft: 'auto', fontSize: 10, padding: '2px 6px', borderRadius: 4, background: '#fef3c7', color: '#92400e', fontWeight: 600 }}>
                            Draft
                          </span>
                        )}
                        {step.require_approval === false && (
                          <span style={{ marginLeft: 'auto', fontSize: 10, padding: '2px 6px', borderRadius: 4, background: '#dcfce7', color: '#166534', fontWeight: 600 }}>
                            Auto-send
                          </span>
                        )}
                      </div>
                      {/* Step content */}
                      {hasContent && (
                        <div style={{ padding: '12px 14px' }}>
                          {step.subject_template && (
                            <div style={{ marginBottom: 8 }}>
                              <div style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Subject</div>
                              <div style={{ fontSize: 13, color: '#111827', fontWeight: 500 }}>{step.subject_template}</div>
                            </div>
                          )}
                          {step.body_template && (
                            <div>
                              <div style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Body</div>
                              <div style={{
                                fontSize: 12, color: '#374151', lineHeight: 1.6,
                                whiteSpace: 'pre-wrap', maxHeight: 200, overflowY: 'auto',
                                background: '#f9fafb', borderRadius: 6, padding: '8px 10px',
                              }}>
                                {step.body_template}
                              </div>
                            </div>
                          )}
                          {step.task_note && (
                            <div>
                              <div style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Note</div>
                              <div style={{ fontSize: 12, color: '#374151', lineHeight: 1.6 }}>{step.task_note}</div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── SequenceBuilder slide-over ───────────────────────────────────── */}
      {showBuilder && (
        <div
          onClick={() => setShowBuilder(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)',
            zIndex: 900, display: 'flex', justifyContent: 'flex-end',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: 620, maxWidth: '95vw', height: '100%',
              background: '#fff', boxShadow: '-8px 0 32px rgba(0,0,0,0.12)',
              display: 'flex', flexDirection: 'column', overflowY: 'auto',
            }}
          >
            <SequenceBuilder
              sequence={editingSeq}
              onSave={(saved) => {
                loadSequences();
                // Fetch full sequence (with steps) then re-open in edit mode
                openBuilderForEdit(saved);
              }}
              onClose={() => { setShowBuilder(false); setEditingSeq(null); }}
            />
          </div>
        </div>
      )}

      {/* ── SequenceEnrollModal ──────────────────────────────────────────── */}
      {showEnroll && selectedProspects.length > 0 && (
        <SequenceEnrollModal
          prospects={selectedProspects}
          preSequenceId={enrollSeqId}
          onEnrolled={(result) => {
            setShowEnroll(false);
            loadEnrollments();
            setSubTab('enrollments');
          }}
          onClose={() => setShowEnroll(false)}
        />
      )}
    </div>
  );
}


// ═════════════════════════════════════════════════════════════════════════════
// PROSPECTING INBOX
// Unified view of all outreach emails sent from prospecting sender accounts.
// Scope: mine | team | org (controlled by the parent ProspectingView scope).
// ═════════════════════════════════════════════════════════════════════════════

function ProspectingInbox({ scope }) {
  const [emails, setEmails]       = useState([]);
  const [stats, setStats]         = useState(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [direction, setDirection] = useState(''); // '' | 'outbound' | 'inbound'
  const [dateRange, setDateRange] = useState('30'); // days
  const [offset, setOffset]       = useState(0);
  const [total, setTotal]         = useState(0);
  const [syncing, setSyncing]     = useState(false);
  const [syncMsg, setSyncMsg]     = useState('');

  const LIMIT = 50;

  const fromDate = () => {
    if (!dateRange) return undefined;
    const d = new Date();
    d.setDate(d.getDate() - parseInt(dateRange));
    return d.toISOString();
  };

  const load = useCallback(async (newOffset = 0) => {
    setLoading(true);
    setError('');
    try {
      const params = {
        scope,
        limit: LIMIT,
        offset: newOffset,
        ...(direction && { direction }),
        ...(dateRange  && { from: fromDate() }),
      };
      const [emailsRes, statsRes] = await Promise.all([
        apiFetch(`/prospecting/inbox?${new URLSearchParams(params)}`),
        apiFetch(`/prospecting/inbox/stats?${new URLSearchParams({ scope, ...(dateRange && { from: fromDate() }) })}`),
      ]);
      setEmails(emailsRes.emails || []);
      setTotal(emailsRes.total  || 0);
      setStats(statsRes.stats   || null);
      setOffset(newOffset);
    } catch (err) {
      setError(err.message || 'Failed to load inbox');
    } finally {
      setLoading(false);
    }
  }, [scope, direction, dateRange]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(0); }, [load]);

  // Refresh when tab becomes visible again
  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === 'visible') load(offset); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [load, offset]);

  // Sync replies from Gmail/Outlook and refresh inbox
  const handleSync = async () => {
    setSyncing(true);
    setSyncMsg('');
    try {
      const res = await apiFetch(`/prospecting/inbox/sync?days=${dateRange || 30}`, { method: 'POST' });
      setSyncMsg(res.message || `${res.saved} new replies synced`);
      await load(0); // refresh list after sync
    } catch (err) {
      setSyncMsg('Sync failed: ' + (err.message || 'Unknown error'));
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMsg(''), 5000); // clear message after 5s
    }
  };

  const DIRECTION_OPTS = [
    { value: '',          label: 'All' },
    { value: 'outbound',  label: 'Sent' },
    { value: 'inbound',   label: 'Replies' },
  ];

  const RANGE_OPTS = [
    { value: '7',   label: '7 days' },
    { value: '14',  label: '14 days' },
    { value: '30',  label: '30 days' },
    { value: '90',  label: '90 days' },
    { value: '',    label: 'All time' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, height: '100%' }}>

      {/* ── Stats bar ──────────────────────────────────────────────────────── */}
      {stats && (
        <div style={{
          display: 'flex', gap: 0, borderBottom: '1px solid #e5e7eb',
          background: '#fff', flexShrink: 0,
        }}>
          {[
            { label: 'Sent',       value: stats.sent       ?? 0, color: '#374151' },
            { label: 'Replies',    value: stats.replies    ?? 0, color: '#0F9D8E' },
            { label: 'Opens',      value: stats.opens      ?? 0, color: '#8b5cf6' },
            { label: 'Reply rate', value: stats.sent > 0 ? `${Math.round((stats.replies / stats.sent) * 100)}%` : '—', color: '#059669' },
            { label: 'Senders',    value: stats.senderCount ?? 0, color: '#f59e0b' },
          ].map(s => (
            <div key={s.label} style={{
              flex: 1, padding: '10px 16px', borderRight: '1px solid #f3f4f6',
              textAlign: 'center',
            }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.3 }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── Filter bar ─────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', gap: 8, alignItems: 'center', padding: '10px 16px',
        borderBottom: '1px solid #e5e7eb', background: '#f9fafb', flexShrink: 0, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #e5e7eb' }}>
          {DIRECTION_OPTS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setDirection(opt.value)}
              style={{
                padding: '5px 12px', fontSize: 12, fontWeight: 500, border: 'none',
                background: direction === opt.value ? '#0F9D8E' : '#fff',
                color:      direction === opt.value ? '#fff' : '#6b7280',
                cursor: 'pointer', borderRight: '1px solid #e5e7eb',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <select
          value={dateRange}
          onChange={e => setDateRange(e.target.value)}
          style={{
            padding: '5px 10px', border: '1px solid #e5e7eb', borderRadius: 6,
            fontSize: 12, color: '#374151', background: '#fff', cursor: 'pointer',
          }}
        >
          {RANGE_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>

        {syncMsg && (
          <span style={{ fontSize: 12, color: syncMsg.includes('failed') ? '#dc2626' : '#059669', fontWeight: 500 }}>
            {syncMsg}
          </span>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, color: '#94a3b8' }}>
            {total} email{total !== 1 ? 's' : ''}
          </span>

          <button
            onClick={handleSync}
            disabled={syncing}
            title="Fetch new replies from Gmail / Outlook"
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '5px 12px', fontSize: 12, fontWeight: 500,
              border: '1px solid #0F9D8E', borderRadius: 6,
              background: syncing ? '#f0fdfa' : '#fff',
              color: '#0F9D8E', cursor: syncing ? 'not-allowed' : 'pointer',
            }}
          >
            {syncing ? '⏳ Syncing…' : '↻ Sync Replies'}
          </button>

          <button
            onClick={() => load(offset)}
            disabled={loading}
            title="Refresh inbox"
            style={{
              padding: '5px 9px', fontSize: 13, border: '1px solid #e5e7eb',
              borderRadius: 6, background: '#fff', color: '#6b7280',
              cursor: loading ? 'not-allowed' : 'pointer',
            }}
          >
            {loading ? '⏳' : '🔄'}
          </button>
        </div>
      </div>

      {/* ── Email list ─────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {error && (
          <div style={{ padding: '16px 20px', color: '#dc2626', fontSize: 13 }}>
            ⚠️ {error}
          </div>
        )}

        {loading && emails.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
        ) : emails.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>📭</div>
            <div style={{ fontWeight: 600, color: '#374151', marginBottom: 4 }}>No outreach emails yet</div>
            <div style={{ fontSize: 13 }}>
              Emails sent via the OutreachComposer will appear here.
            </div>
          </div>
        ) : (
          <>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
                  {['Prospect', 'Company', 'Subject', 'Sent By', 'Date', 'Status'].map(h => (
                    <th key={h} style={{
                      padding: '9px 14px', textAlign: 'left', fontSize: 11,
                      fontWeight: 700, color: '#6b7280', textTransform: 'uppercase',
                      letterSpacing: 0.5, whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {emails.map(email => {
                  const prospect   = email.prospect   || {};
                  const sentBy     = email.sentBy     || {};
                  const sender     = email.senderAccount || {};
                  const isReply    = email.direction === 'inbound' || email.direction === 'received';
                  const wasOpened  = !!email.openedAt;
                  const wasReplied = !!email.repliedAt;
                  return (
                    <tr
                      key={email.id}
                      style={{
                        borderBottom: '1px solid #f3f4f6',
                        background: isReply ? '#f0fdf4' : '#fff',
                      }}
                    >
                      {/* Prospect name + email */}
                      <td style={{ padding: '10px 14px', minWidth: 160 }}>
                        <div style={{ fontWeight: 600, color: '#1a202c' }}>
                          {prospect.firstName} {prospect.lastName}
                        </div>
                        {prospect.email && (
                          <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 1 }}>
                            {prospect.email}
                          </div>
                        )}
                      </td>

                      {/* Company + stage */}
                      <td style={{ padding: '10px 14px', minWidth: 130 }}>
                        <div style={{ fontSize: 12, color: '#374151' }}>
                          {prospect.companyName || '—'}
                        </div>
                        {prospect.stage && (
                          <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 1, textTransform: 'capitalize' }}>
                            {prospect.stage}
                          </div>
                        )}
                      </td>

                      {/* Subject */}
                      <td style={{ padding: '10px 14px', maxWidth: 260 }}>
                        <div style={{
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          color: isReply ? '#065f46' : '#374151',
                          fontWeight: isReply ? 600 : 400,
                        }}>
                          {isReply ? '↩ ' : ''}{email.subject || '(no subject)'}
                        </div>
                      </td>

                      {/* Sent by — CRM user + sender account email */}
                      <td style={{ padding: '10px 14px', minWidth: 140 }}>
                        <div style={{ fontSize: 12, color: '#374151' }}>
                          {sentBy.firstName} {sentBy.lastName}
                        </div>
                        {(sender.email || email.fromAddress) && (
                          <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 1 }}>
                            {sender.email || email.fromAddress}
                          </div>
                        )}
                      </td>

                      {/* Date */}
                      <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', color: '#6b7280', fontSize: 12 }}>
                        {email.sentAt
                          ? new Date(email.sentAt).toLocaleString(undefined, {
                              month: 'short', day: 'numeric',
                              hour: '2-digit', minute: '2-digit',
                            })
                          : '—'}
                      </td>

                      {/* Status badges */}
                      <td style={{ padding: '10px 14px' }}>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {isReply && (
                            <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: '#d1fae5', color: '#065f46', fontWeight: 600 }}>
                              ↩ Reply
                            </span>
                          )}
                          {wasOpened && !isReply && (
                            <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: '#ede9fe', color: '#6d28d9', fontWeight: 600 }}>
                              Opened
                            </span>
                          )}
                          {wasReplied && !isReply && (
                            <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: '#d1fae5', color: '#065f46', fontWeight: 600 }}>
                              ✓ Replied
                            </span>
                          )}
                          {!isReply && !wasOpened && !wasReplied && (
                            <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: '#f3f4f6', color: '#9ca3af' }}>
                              Sent
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* Pagination */}
            {total > LIMIT && (
              <div style={{ display: 'flex', justifyContent: 'center', gap: 8, padding: '12px 16px', borderTop: '1px solid #f3f4f6' }}>
                <button
                  disabled={offset === 0 || loading}
                  onClick={() => load(Math.max(0, offset - LIMIT))}
                  style={{ padding: '5px 14px', border: '1px solid #e5e7eb', borderRadius: 6, background: offset === 0 ? '#f9fafb' : '#fff', color: '#374151', cursor: offset === 0 ? 'default' : 'pointer', fontSize: 12 }}
                >
                  ← Prev
                </button>
                <span style={{ fontSize: 12, color: '#6b7280', padding: '5px 8px' }}>
                  {offset + 1}–{Math.min(offset + LIMIT, total)} of {total}
                </span>
                <button
                  disabled={offset + LIMIT >= total || loading}
                  onClick={() => load(offset + LIMIT)}
                  style={{ padding: '5px 14px', border: '1px solid #e5e7eb', borderRadius: 6, background: offset + LIMIT >= total ? '#f9fafb' : '#fff', color: '#374151', cursor: offset + LIMIT >= total ? 'default' : 'pointer', fontSize: 12 }}
                >
                  Next →
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
