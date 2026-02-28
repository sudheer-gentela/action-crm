import React, { useState, useEffect, useCallback, createContext, useContext } from 'react';
import OutreachComposer from './OutreachComposer';
import CoverageScorecard from './CoverageScorecard';
import './ProspectingView.css';
import './OutreachComposer.css';

// ── Constants ────────────────────────────────────────────────────────────────

// Fallback stages used while loading or if API fails
const DEFAULT_PROSPECT_STAGES = [
  { key: 'target',     label: 'Target',      icon: '🎯', color: '#6b7280' },
  { key: 'researched', label: 'Researched',   icon: '🔍', color: '#8b5cf6' },
  { key: 'contacted',  label: 'Contacted',    icon: '📤', color: '#3b82f6' },
  { key: 'engaged',    label: 'Engaged',      icon: '💬', color: '#0F9D8E' },
  { key: 'qualified',  label: 'Qualified',    icon: '✅', color: '#10b981' },
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

// ── Helpers ──────────────────────────────────────────────────────────────────

const API = process.env.REACT_APP_API_URL || '';

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

  // Dynamic stages from API
  const [PROSPECT_STAGES, setProspectStages] = useState(DEFAULT_PROSPECT_STAGES);
  const [TERMINAL_STAGES, setTerminalStages] = useState(DEFAULT_TERMINAL_STAGES);
  const ALL_STAGES = [...PROSPECT_STAGES, ...TERMINAL_STAGES];

  // Fetch org-customised prospect stages
  useEffect(() => {
    apiFetch('/prospect-stages')
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
              { key: 'pipeline', icon: '▦', label: 'Pipeline' },
              { key: 'list',     icon: '≡', label: 'List' },
              { key: 'account',  icon: '🏢', label: 'Accounts' },
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
      ) : (
        <AccountView
          groups={Object.values(groupedByAccount)}
          onSelect={setSelectedProspect}
        />
      )}

      {/* ── Create Form Modal ──────────────────────────────────────────────── */}
      {showCreateForm && (
        <ProspectCreateModal
          onSave={handleCreateProspect}
          onClose={() => setShowCreateForm(false)}
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
                <td>{p.outreach_count || 0}</td>
                <td>{p.last_outreach_at ? timeAgo(p.last_outreach_at) : '—'}</td>
                <td>{p.icp_score != null ? p.icp_score : '—'}</td>
              </tr>
            );
          })}
          {prospects.length === 0 && (
            <tr><td colSpan="8" className="pv-table-empty">No prospects found</td></tr>
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
  });

  const set = (field, val) => setForm(prev => ({ ...prev, [field]: val }));

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
            <h4>Person</h4>
            <div className="pv-form-row">
              <input placeholder="First name *" value={form.firstName} onChange={e => set('firstName', e.target.value)} required />
              <input placeholder="Last name *" value={form.lastName} onChange={e => set('lastName', e.target.value)} required />
            </div>
            <input placeholder="Email" value={form.email} onChange={e => set('email', e.target.value)} type="email" />
            <input placeholder="Job title" value={form.title} onChange={e => set('title', e.target.value)} />
            <div className="pv-form-row">
              <input placeholder="Phone" value={form.phone} onChange={e => set('phone', e.target.value)} />
              <input placeholder="LinkedIn URL" value={form.linkedinUrl} onChange={e => set('linkedinUrl', e.target.value)} />
            </div>
            <input placeholder="Location" value={form.location} onChange={e => set('location', e.target.value)} />
          </div>

          <div className="pv-form-section">
            <h4>Company</h4>
            <div className="pv-form-row">
              <input placeholder="Company name" value={form.companyName} onChange={e => set('companyName', e.target.value)} />
              <input placeholder="Domain (e.g. acme.com)" value={form.companyDomain} onChange={e => set('companyDomain', e.target.value)} />
            </div>
            <div className="pv-form-row">
              <select value={form.companySize} onChange={e => set('companySize', e.target.value)}>
                <option value="">Company size</option>
                <option value="1-10">1–10</option>
                <option value="11-50">11–50</option>
                <option value="51-200">51–200</option>
                <option value="201-500">201–500</option>
                <option value="501-1000">501–1,000</option>
                <option value="1001-5000">1,001–5,000</option>
                <option value="5001+">5,001+</option>
              </select>
              <input placeholder="Industry" value={form.companyIndustry} onChange={e => set('companyIndustry', e.target.value)} />
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
  const [showStageMenu, setShowStageMenu] = useState(false);
  const [showOutreach, setShowOutreach] = useState(false);
  const [outreachChannel, setOutreachChannel] = useState(null);
  const [outreachAction, setOutreachAction] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [contextData, setContextData] = useState(null);
  const [contextLoading, setContextLoading] = useState(false);

  useEffect(() => {
    const fetchDetail = async () => {
      try {
        setLoading(true);
        const res = await apiFetch(`/prospects/${prospectId}`);
        setProspect(res.prospect);
        setActions(res.actions || []);
        setActivities(res.activities || []);
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
    if (t === 'intel') fetchContext();
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
            {prospect.stage === 'qualified' && (
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
          {['overview', 'intel', 'actions', 'activity'].map(t => (
            <button
              key={t}
              className={`pv-detail-tab ${activeTab === t ? 'active' : ''}`}
              onClick={() => handleTabChange(t)}
            >
              {t === 'overview' ? 'Overview' : t === 'intel' ? '🎯 Intel' : t === 'actions' ? `Actions (${actions.filter(a => a.status === 'pending').length})` : 'Activity'}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="pv-detail-content">
          {activeTab === 'overview' && (
            <div className="pv-overview-tab">
              <div className="pv-info-grid">
                <InfoRow label="Email" value={prospect.email} />
                <InfoRow label="Phone" value={prospect.phone} />
                <InfoRow label="LinkedIn" value={prospect.linkedin_url ? <a href={prospect.linkedin_url} target="_blank" rel="noreferrer">Profile ↗</a> : null} />
                <InfoRow label="Location" value={prospect.location} />
                <InfoRow label="Source" value={prospect.source} />
                <InfoRow label="Preferred Channel" value={prospect.preferred_channel} />
                <InfoRow label="ICP Score" value={prospect.icp_score} />
                <InfoRow label="Outreach Count" value={prospect.outreach_count} />
                <InfoRow label="Response Count" value={prospect.response_count} />
                <InfoRow label="Last Outreach" value={prospect.last_outreach_at ? formatDate(prospect.last_outreach_at) : null} />
                <InfoRow label="Last Response" value={prospect.last_response_at ? formatDate(prospect.last_response_at) : null} />
              </div>

              {prospect.research_notes && (
                <div className="pv-research-notes">
                  <h4>Research Notes</h4>
                  <p>{prospect.research_notes}</p>
                </div>
              )}

              <div className="pv-info-grid" style={{ marginTop: 16 }}>
                <InfoRow label="Company" value={prospect.company_name} />
                <InfoRow label="Domain" value={prospect.company_domain} />
                <InfoRow label="Size" value={prospect.company_size} />
                <InfoRow label="Industry" value={prospect.company_industry} />
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
            </div>
          )}

          {activeTab === 'intel' && (
            <ProspectIntelCard
              contextData={contextData}
              loading={contextLoading}
              prospect={prospect}
              onOpenOutreach={(channel) => openOutreach(channel)}
            />
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
              {activities.length === 0 ? (
                <div className="pv-empty-state">No activity yet</div>
              ) : (
                activities.map(a => (
                  <div key={a.id} className="pv-activity-item">
                    <span className="pv-activity-type">{a.activity_type}</span>
                    <span className="pv-activity-desc">{a.description}</span>
                    <span className="pv-activity-time">{formatDate(a.created_at)}</span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

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
                      background: ['engaged', 'qualified', 'converted'].includes(p.stage) ? '#eff6ff' : '#f3f4f6',
                      color: ['engaged', 'qualified', 'converted'].includes(p.stage) ? '#2563eb' : '#6b7280',
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


function InfoRow({ label, value }) {
  if (!value && value !== 0) return null;
  return (
    <div className="pv-info-row">
      <span className="pv-info-label">{label}</span>
      <span className="pv-info-value">{value}</span>
    </div>
  );
}


