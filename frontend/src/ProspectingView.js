import React, { useState, useEffect, useCallback } from 'react';
import './ProspectingView.css';

// ── Constants ────────────────────────────────────────────────────────────────

const PROSPECT_STAGES = [
  { key: 'target',     label: 'Target',      icon: '🎯', color: '#6b7280' },
  { key: 'researched', label: 'Researched',   icon: '🔍', color: '#8b5cf6' },
  { key: 'contacted',  label: 'Contacted',    icon: '📤', color: '#3b82f6' },
  { key: 'engaged',    label: 'Engaged',      icon: '💬', color: '#0F9D8E' },
  { key: 'qualified',  label: 'Qualified',    icon: '✅', color: '#10b981' },
];

const TERMINAL_STAGES = [
  { key: 'converted',    label: 'Converted',    icon: '🎉', color: '#059669' },
  { key: 'disqualified', label: 'Disqualified', icon: '❌', color: '#ef4444' },
  { key: 'nurture',      label: 'Nurture',      icon: '🌱', color: '#f59e0b' },
];

const ALL_STAGES = [...PROSPECT_STAGES, ...TERMINAL_STAGES];

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
  const [showPlaybookPanel, setShowPlaybookPanel] = useState(false);

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
        apiFetch(`/api/prospects?scope=${scope}${searchQuery ? `&search=${encodeURIComponent(searchQuery)}` : ''}`),
        apiFetch(`/api/prospects/pipeline/summary?scope=${scope}`),
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
      await apiFetch(`/api/prospects/${prospectId}/stage`, {
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
      await apiFetch('/api/prospects', {
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

  return (
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

          <button className="pv-btn-secondary" onClick={() => setShowPlaybookPanel(true)}>
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

      {/* ── Prospecting Playbook Panel ─────────────────────────────────────── */}
      {showPlaybookPanel && (
        <ProspectingPlaybookPanel onClose={() => setShowPlaybookPanel(false)} />
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// PIPELINE BOARD
// ═════════════════════════════════════════════════════════════════════════════

function PipelineBoard({ stages, groupedByStage, onSelect, onStageChange, terminalCounts }) {
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
        {TERMINAL_STAGES.map(s => (
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
            const stageCfg = ALL_STAGES.find(s => s.key === p.stage);
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
          <div className="pv-account-prospects">
            {group.prospects.map(p => {
              const stageCfg = ALL_STAGES.find(s => s.key === p.stage);
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
  const [prospect, setProspect] = useState(null);
  const [actions, setActions] = useState([]);
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');
  const [showStageMenu, setShowStageMenu] = useState(false);

  useEffect(() => {
    const fetchDetail = async () => {
      try {
        setLoading(true);
        const res = await apiFetch(`/api/prospects/${prospectId}`);
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

  const handleStageChange = async (newStage) => {
    try {
      let reason = null;
      if (newStage === 'disqualified') {
        reason = prompt('Reason for disqualification:');
        if (reason === null) return;
      }
      await apiFetch(`/api/prospects/${prospectId}/stage`, {
        method: 'POST',
        body: JSON.stringify({ stage: newStage, reason }),
      });
      // Refresh
      const res = await apiFetch(`/api/prospects/${prospectId}`);
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
      const res = await apiFetch(`/api/prospects/${prospectId}/convert`, {
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
      await apiFetch(`/api/prospecting-actions/${actionId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'completed', outcome }),
      });
      const res = await apiFetch(`/api/prospects/${prospectId}`);
      setProspect(res.prospect);
      setActions(res.actions || []);
      setActivities(res.activities || []);
      onUpdate();
    } catch (err) {
      alert(err.message);
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

  const stageCfg = ALL_STAGES.find(s => s.key === prospect.stage);
  const currentStageIdx = PROSPECT_STAGES.findIndex(s => s.key === prospect.stage);

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
            {prospect.stage === 'qualified' && (
              <button className="pv-btn-convert" onClick={handleConvert}>🎉 Convert</button>
            )}
            <div className="pv-stage-menu-wrap" style={{ position: 'relative' }}>
              <button className="pv-btn-secondary" onClick={() => setShowStageMenu(!showStageMenu)}>
                Move Stage ▾
              </button>
              {showStageMenu && (
                <div className="pv-stage-dropdown">
                  {ALL_STAGES.filter(s => s.key !== prospect.stage).map(s => (
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
            {PROSPECT_STAGES.map((s, idx) => (
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
          {['overview', 'actions', 'activity'].map(t => (
            <button
              key={t}
              className={`pv-detail-tab ${activeTab === t ? 'active' : ''}`}
              onClick={() => setActiveTab(t)}
            >
              {t === 'overview' ? 'Overview' : t === 'actions' ? `Actions (${actions.filter(a => a.status === 'pending').length})` : 'Activity'}
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

          {activeTab === 'actions' && (
            <div className="pv-actions-tab">
              {actions.length === 0 ? (
                <div className="pv-empty-state">No actions yet</div>
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
                    {a.status === 'pending' && (
                      <div className="pv-action-buttons">
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
      </div>
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

// ═════════════════════════════════════════════════════════════════════════════
// PROSPECTING PLAYBOOK PANEL
// ═════════════════════════════════════════════════════════════════════════════

const PROSPECT_STAGE_KEYS = ['target', 'researched', 'contacted', 'engaged', 'qualified'];

const STAGE_LABELS = {
  target: '🎯 Target', researched: '🔍 Researched', contacted: '📤 Contacted',
  engaged: '💬 Engaged', qualified: '✅ Qualified',
};

function ProspectingPlaybookPanel({ onClose }) {
  const [playbooks, setPlaybooks] = useState([]);
  const [selectedPb, setSelectedPb] = useState(null);
  const [pbDetail, setPbDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [editingStage, setEditingStage] = useState(null);
  const [stageForm, setStageForm] = useState({});

  // Fetch prospecting playbooks
  const fetchPlaybooks = useCallback(async () => {
    try {
      setLoading(true);
      const data = await apiFetch('/api/playbooks?type=prospecting');
      setPlaybooks(data.playbooks || []);
      if (data.playbooks?.length > 0 && !selectedPb) {
        setSelectedPb(data.playbooks[0].id);
      }
    } catch (err) {
      console.error('Fetch prospecting playbooks:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchPlaybooks(); }, [fetchPlaybooks]);

  // Fetch detail when selected
  useEffect(() => {
    if (!selectedPb) { setPbDetail(null); return; }
    apiFetch(`/api/playbooks/${selectedPb}`)
      .then(data => setPbDetail(data.playbook))
      .catch(err => console.error('Fetch playbook detail:', err));
  }, [selectedPb]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    try {
      setCreating(true);
      const data = await apiFetch('/api/playbooks', {
        method: 'POST',
        body: JSON.stringify({ name: newName.trim(), type: 'prospecting', description: 'Prospecting playbook' }),
      });
      setNewName('');
      await fetchPlaybooks();
      setSelectedPb(data.playbook?.id);
    } catch (err) {
      alert(err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleSaveStage = async (stageKey) => {
    if (!pbDetail) return;
    try {
      const updatedGuidance = {
        ...(pbDetail.stage_guidance || {}),
        [stageKey]: stageForm,
      };
      await apiFetch(`/api/playbooks/${pbDetail.id}`, {
        method: 'PUT',
        body: JSON.stringify({ stage_guidance: updatedGuidance }),
      });
      setPbDetail(prev => ({ ...prev, stage_guidance: updatedGuidance }));
      setEditingStage(null);
    } catch (err) {
      alert(err.message);
    }
  };

  const handleDeletePlaybook = async (id) => {
    if (!window.confirm('Delete this prospecting playbook?')) return;
    try {
      await apiFetch(`/api/playbooks/${id}`, { method: 'DELETE' });
      setSelectedPb(null);
      fetchPlaybooks();
    } catch (err) {
      alert(err.message);
    }
  };

  // Save account-based config
  const handleSaveContent = async (content) => {
    if (!pbDetail) return;
    try {
      await apiFetch(`/api/playbooks/${pbDetail.id}`, {
        method: 'PUT',
        body: JSON.stringify({ content }),
      });
      setPbDetail(prev => ({ ...prev, content }));
    } catch (err) {
      alert(err.message);
    }
  };

  const guidance = pbDetail?.stage_guidance || {};
  const content = pbDetail?.content || {};

  return (
    <div className="pv-detail-overlay" onClick={onClose}>
      <div className="pv-detail-panel" style={{ width: '620px' }} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="pv-detail-header">
          <h3>📋 Prospecting Playbooks</h3>
          <button className="pv-detail-close" onClick={onClose}>×</button>
        </div>

        <div className="pv-detail-content">
          {/* Playbook selector */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
            {playbooks.map(pb => (
              <button
                key={pb.id}
                className={`pv-btn-sm ${selectedPb === pb.id ? '' : ''}`}
                onClick={() => setSelectedPb(pb.id)}
                style={{
                  background: selectedPb === pb.id ? TEAL : '#f3f4f6',
                  color: selectedPb === pb.id ? '#fff' : '#374151',
                  fontWeight: selectedPb === pb.id ? 600 : 400,
                  padding: '6px 12px',
                  borderRadius: '6px',
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                {pb.name}
              </button>
            ))}
          </div>

          {/* Create new */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '20px' }}>
            <input
              placeholder="New playbook name..."
              value={newName}
              onChange={e => setNewName(e.target.value)}
              style={{
                flex: 1, padding: '7px 10px', border: '1px solid #e2e4ea',
                borderRadius: '6px', fontSize: '13px', outline: 'none',
              }}
              onKeyDown={e => e.key === 'Enter' && handleCreate()}
            />
            <button className="pv-btn-primary" onClick={handleCreate} disabled={creating || !newName.trim()}>
              + Create
            </button>
          </div>

          {loading && <div className="pv-loading">Loading...</div>}

          {!loading && playbooks.length === 0 && (
            <div className="pv-empty-state">
              <p>No prospecting playbooks yet. Create one to define your outreach strategy per stage.</p>
            </div>
          )}

          {/* Playbook detail */}
          {pbDetail && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                <h4 style={{ margin: 0, fontSize: '15px' }}>{pbDetail.name}</h4>
                <button
                  className="pv-btn-sm"
                  style={{ color: '#ef4444' }}
                  onClick={() => handleDeletePlaybook(pbDetail.id)}
                >
                  🗑️ Delete
                </button>
              </div>

              {/* Account-based toggle */}
              <div style={{
                padding: '10px 14px', background: '#f0fdfa', borderRadius: '8px',
                border: '1px solid #99f6e4', marginBottom: '16px',
              }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px' }}>
                  <input
                    type="checkbox"
                    checked={content.account_based || false}
                    onChange={e => handleSaveContent({ ...content, account_based: e.target.checked })}
                  />
                  <strong>Account-Based Prospecting</strong>
                  <span style={{ color: '#6b7280', fontSize: '11px' }}> — define role requirements per account</span>
                </label>
              </div>

              {/* Stage guidance */}
              <h4 style={{ fontSize: '13px', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '16px 0 8px' }}>
                Stage Guidance
              </h4>

              {PROSPECT_STAGE_KEYS.map(stageKey => {
                const g = guidance[stageKey] || {};
                const isEditing = editingStage === stageKey;

                return (
                  <div key={stageKey} style={{
                    border: '1px solid #e5e7eb', borderRadius: '8px', padding: '12px',
                    marginBottom: '8px', background: isEditing ? '#fafbfc' : '#fff',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 600, fontSize: '13px' }}>
                        {STAGE_LABELS[stageKey]}
                      </span>
                      {!isEditing ? (
                        <button className="pv-btn-sm" onClick={() => {
                          setEditingStage(stageKey);
                          setStageForm({
                            goal: g.goal || '',
                            key_actions: g.key_actions || [],
                            success_criteria: g.success_criteria || [],
                            timeline: g.timeline || '',
                          });
                        }}>
                          ✏️ Edit
                        </button>
                      ) : (
                        <div style={{ display: 'flex', gap: '4px' }}>
                          <button className="pv-btn-primary" style={{ padding: '4px 10px', fontSize: '11px' }}
                            onClick={() => handleSaveStage(stageKey)}>
                            Save
                          </button>
                          <button className="pv-btn-sm" onClick={() => setEditingStage(null)}>Cancel</button>
                        </div>
                      )}
                    </div>

                    {!isEditing ? (
                      <div style={{ marginTop: '6px', fontSize: '12px', color: '#6b7280' }}>
                        {g.goal ? (
                          <>
                            <div><strong>Goal:</strong> {g.goal}</div>
                            {g.timeline && <div><strong>Timeline:</strong> {g.timeline}</div>}
                            {g.key_actions?.length > 0 && <div><strong>Actions:</strong> {g.key_actions.join(', ')}</div>}
                            {g.success_criteria?.length > 0 && <div><strong>Exit Criteria:</strong> {g.success_criteria.join(', ')}</div>}
                          </>
                        ) : (
                          <span style={{ fontStyle: 'italic' }}>No guidance configured</span>
                        )}
                      </div>
                    ) : (
                      <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        <input
                          placeholder="Goal for this stage"
                          value={stageForm.goal}
                          onChange={e => setStageForm(f => ({ ...f, goal: e.target.value }))}
                          style={{ padding: '6px 8px', border: '1px solid #e2e4ea', borderRadius: '4px', fontSize: '12px' }}
                        />
                        <input
                          placeholder="Timeline (e.g. 1-2 weeks)"
                          value={stageForm.timeline}
                          onChange={e => setStageForm(f => ({ ...f, timeline: e.target.value }))}
                          style={{ padding: '6px 8px', border: '1px solid #e2e4ea', borderRadius: '4px', fontSize: '12px' }}
                        />
                        <input
                          placeholder="Key actions (comma-separated)"
                          value={(stageForm.key_actions || []).join(', ')}
                          onChange={e => setStageForm(f => ({ ...f, key_actions: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }))}
                          style={{ padding: '6px 8px', border: '1px solid #e2e4ea', borderRadius: '4px', fontSize: '12px' }}
                        />
                        <input
                          placeholder="Exit criteria (comma-separated)"
                          value={(stageForm.success_criteria || []).join(', ')}
                          onChange={e => setStageForm(f => ({ ...f, success_criteria: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }))}
                          style={{ padding: '6px 8px', border: '1px solid #e2e4ea', borderRadius: '4px', fontSize: '12px' }}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
