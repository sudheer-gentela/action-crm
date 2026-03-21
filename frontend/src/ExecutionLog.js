import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';

// ═══════════════════════════════════════════════════════════════════
// ExecutionLog.js
// Execution history and violation viewer for the ActionCRM Workflow Engine.
//
// Shows:
//   - Workflow execution history with per-step drill-down
//   - Active violations (for org admins only)
//
// Props:
//   scope   — 'org' | 'super'
//   orgId   — (super only) filter by org
// ═══════════════════════════════════════════════════════════════════

const STEP_STATUS_META = {
  passed:  { icon: '✅', color: '#059669', bg: '#f0fdf4' },
  failed:  { icon: '❌', color: '#dc2626', bg: '#fef2f2' },
  skipped: { icon: '⏭', color: '#9ca3af', bg: '#f3f4f6' },
  pending: { icon: '⏳', color: '#d97706', bg: '#fffbeb' },
  running: { icon: '🔄', color: '#6366f1', bg: '#eef2ff' },
};

const EXEC_STATUS_META = {
  passed:  { label: 'Passed',  color: '#059669', bg: '#f0fdf4'  },
  failed:  { label: 'Failed',  color: '#dc2626', bg: '#fef2f2'  },
  partial: { label: 'Partial', color: '#d97706', bg: '#fffbeb'  },
  running: { label: 'Running', color: '#6366f1', bg: '#eef2ff'  },
};

const ENTITY_ICONS = { deal: '🤝', contact: '👤', account: '🏢' };
const TRIGGER_LABELS = { create: 'Create', update: 'Update', stage_change: 'Stage Change', audit: 'Audit' };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDuration(ms) {
  if (!ms && ms !== 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatDatetime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

function formatRelative(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function ExecStatusBadge({ status }) {
  const m = EXEC_STATUS_META[status] || { label: status, color: '#9ca3af', bg: '#f3f4f6' };
  return (
    <span style={{ fontSize: 11, fontWeight: 700, color: m.color, background: m.bg, borderRadius: 5, padding: '2px 7px' }}>
      {m.label}
    </span>
  );
}

function SeverityBadge({ severity }) {
  return (
    <span style={{
      fontSize: 10,
      fontWeight: 700,
      color: severity === 'block' ? '#dc2626' : '#d97706',
      background: severity === 'block' ? '#fef2f2' : '#fffbeb',
      borderRadius: 4,
      padding: '1px 6px',
      textTransform: 'uppercase',
    }}>
      {severity}
    </span>
  );
}

// ─── Step results drill-down ──────────────────────────────────────────────────

function StepResultsPanel({ stepResults }) {
  if (!stepResults || Object.keys(stepResults).length === 0) {
    return <div style={{ fontSize: 12, color: '#9ca3af', padding: '8px 0' }}>No step results recorded.</div>;
  }

  const steps = Object.entries(stepResults).map(([id, result]) => ({ id, ...result }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {steps.map(step => {
        const meta = STEP_STATUS_META[step.status] || STEP_STATUS_META.pending;
        return (
          <div
            key={step.id}
            style={{
              background: meta.bg,
              border: `1px solid ${meta.color}22`,
              borderRadius: 7,
              padding: '9px 12px',
            }}
          >
            {/* Step header row */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: step.violations?.length ? 8 : 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>{meta.icon}</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>Step {step.id}</span>
                {step.skipped_reason && (
                  <span style={{ fontSize: 11, color: '#9ca3af', fontStyle: 'italic' }}>
                    ({step.skipped_reason.replace(/_/g, ' ')})
                  </span>
                )}
              </div>
              <span style={{ fontSize: 11, color: '#9ca3af' }}>
                {formatDuration(step.duration_ms)}
              </span>
            </div>

            {/* Violations */}
            {step.violations?.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {step.violations.map((v, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, background: '#fff8f8', border: '1px solid #fca5a5', borderRadius: 5, padding: '6px 10px' }}>
                    <SeverityBadge severity={v.severity} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, color: '#dc2626', fontWeight: 500 }}>{v.message}</div>
                      {v.field && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>field: {v.field}</div>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Single execution row ─────────────────────────────────────────────────────

function ExecutionRow({ exec }) {
  const [expanded, setExpanded] = useState(false);

  const totalSteps   = exec.step_results ? Object.keys(exec.step_results).length : 0;
  const failedSteps  = exec.step_results
    ? Object.values(exec.step_results).filter(s => s.status === 'failed').length
    : 0;
  const skippedSteps = exec.step_results
    ? Object.values(exec.step_results).filter(s => s.status === 'skipped').length
    : 0;

  const duration = exec.completed_at && exec.started_at
    ? new Date(exec.completed_at) - new Date(exec.started_at)
    : null;

  return (
    <div style={logStyles.execRow}>
      {/* Header */}
      <div
        style={logStyles.execHeader}
        onClick={() => setExpanded(e => !e)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 18 }}>{ENTITY_ICONS[exec.entity_type] || '📋'}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>
                {exec.entity_type} #{exec.entity_id}
              </span>
              <ExecStatusBadge status={exec.status} />
              <span style={{ fontSize: 11, color: '#9ca3af' }}>
                {TRIGGER_LABELS[exec.trigger] || exec.trigger}
              </span>
            </div>
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
              Workflow #{exec.workflow_id} ·{' '}
              {totalSteps} step{totalSteps !== 1 ? 's' : ''}
              {failedSteps > 0 && <span style={{ color: '#dc2626' }}> · {failedSteps} failed</span>}
              {skippedSteps > 0 && <span style={{ color: '#9ca3af' }}> · {skippedSteps} skipped</span>}
              {duration !== null && ` · ${formatDuration(duration)}`}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 11, color: '#6b7280' }}>{formatRelative(exec.started_at)}</div>
            <div style={{ fontSize: 10, color: '#9ca3af' }}>{formatDatetime(exec.started_at)}</div>
          </div>
          <span style={{ fontSize: 14, color: '#9ca3af' }}>{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* Expanded step results */}
      {expanded && (
        <div style={{ borderTop: '1px solid #f3f4f6', paddingTop: 12, marginTop: 4 }}>
          <StepResultsPanel stepResults={exec.step_results} />
          {exec.metadata && Object.keys(exec.metadata).length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary style={{ fontSize: 11, color: '#9ca3af', cursor: 'pointer' }}>Metadata</summary>
              <pre style={{ fontSize: 10, color: '#6b7280', background: '#f9fafb', borderRadius: 5, padding: 8, marginTop: 4, overflow: 'auto' }}>
                {JSON.stringify(exec.metadata, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Executions tab ───────────────────────────────────────────────────────────

function ExecutionsTab({ scope, orgId }) {
  const [execs,   setExecs]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [page,    setPage]    = useState(1);
  const [filters, setFilters] = useState({ entity_type: '', status: '', trigger: '' });
  const [error,   setError]   = useState('');

  const api = scope === 'super' ? apiService.superAdmin : apiService.orgAdmin;
  const LIMIT = 25;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit: LIMIT, ...filters };
      if (orgId) params.org_id = orgId;
      // Remove empty filters
      Object.keys(params).forEach(k => { if (params[k] === '') delete params[k]; });
      const r = await api.getExecutions(params);
      setExecs(r.data.executions || []);
    } catch { setError('Failed to load executions'); }
    finally { setLoading(false); }
  }, [page, filters, api, orgId]);

  useEffect(() => { load(); }, [load]);

  const updateFilter = (key, val) => {
    setFilters(f => ({ ...f, [key]: val }));
    setPage(1);
  };

  return (
    <div>
      {error && <div style={logStyles.errLine}>{error}</div>}

      {/* Filters */}
      <div style={logStyles.filterRow}>
        <select style={logStyles.filterSelect} value={filters.entity_type} onChange={e => updateFilter('entity_type', e.target.value)}>
          <option value="">All entities</option>
          <option value="deal">Deals</option>
          <option value="contact">Contacts</option>
          <option value="account">Accounts</option>
        </select>
        <select style={logStyles.filterSelect} value={filters.status} onChange={e => updateFilter('status', e.target.value)}>
          <option value="">All statuses</option>
          <option value="passed">Passed</option>
          <option value="failed">Failed</option>
          <option value="partial">Partial</option>
          <option value="running">Running</option>
        </select>
        <select style={logStyles.filterSelect} value={filters.trigger} onChange={e => updateFilter('trigger', e.target.value)}>
          <option value="">All triggers</option>
          <option value="create">Create</option>
          <option value="update">Update</option>
          <option value="stage_change">Stage Change</option>
          <option value="audit">Audit</option>
        </select>
        <button style={logStyles.refreshBtn} onClick={load}>↻ Refresh</button>
      </div>

      {loading ? (
        <div style={{ color: '#9ca3af', fontSize: 13, padding: 8 }}>Loading executions…</div>
      ) : execs.length === 0 ? (
        <div style={logStyles.empty}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>📋</div>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>No executions found</div>
          <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>
            Executions are recorded when workflow rules run against entity writes.
          </div>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {execs.map(exec => (
              <ExecutionRow key={exec.id} exec={exec} />
            ))}
          </div>

          <div style={logStyles.pagination}>
            <button style={logStyles.pageBtn} disabled={page === 1} onClick={() => setPage(p => p - 1)}>← Prev</button>
            <span style={{ fontSize: 12, color: '#6b7280' }}>Page {page}</span>
            <button style={logStyles.pageBtn} disabled={execs.length < LIMIT} onClick={() => setPage(p => p + 1)}>Next →</button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Violations tab (org only) ────────────────────────────────────────────────

function ViolationsTab() {
  const [violations, setViolations] = useState([]);
  const [loading, setLoading]       = useState(true);
  const [filters,  setFilters]      = useState({ entity_type: '', resolved: '' });
  const [error,    setError]        = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (filters.entity_type) params.entity_type = filters.entity_type;
      // resolved=false = only open violations (default for this view)
      params.resolved = filters.resolved || 'false';
      const r = await apiService.orgAdmin.getViolations(params);
      setViolations(r.data.violations || []);
    } catch { setError('Failed to load violations'); }
    finally { setLoading(false); }
  }, [filters]);

  useEffect(() => { load(); }, [load]);

  const updateFilter = (key, val) => setFilters(f => ({ ...f, [key]: val }));

  return (
    <div>
      {error && <div style={logStyles.errLine}>{error}</div>}

      {/* Filter row */}
      <div style={logStyles.filterRow}>
        <select style={logStyles.filterSelect} value={filters.entity_type} onChange={e => updateFilter('entity_type', e.target.value)}>
          <option value="">All entities</option>
          <option value="deal">Deals</option>
          <option value="contact">Contacts</option>
          <option value="account">Accounts</option>
        </select>
        <select style={logStyles.filterSelect} value={filters.resolved} onChange={e => updateFilter('resolved', e.target.value)}>
          <option value="false">Open violations</option>
          <option value="true">Resolved violations</option>
          <option value="">All violations</option>
        </select>
        <button style={logStyles.refreshBtn} onClick={load}>↻ Refresh</button>
      </div>

      {/* Summary bar */}
      {!loading && violations.length > 0 && (
        <div style={logStyles.summaryBar}>
          <div style={logStyles.summaryCard}>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#dc2626' }}>
              {violations.filter(v => !v.resolved_at).length}
            </div>
            <div style={{ fontSize: 11, color: '#9ca3af' }}>Open</div>
          </div>
          <div style={logStyles.summaryCard}>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#059669' }}>
              {violations.filter(v => !!v.resolved_at).length}
            </div>
            <div style={{ fontSize: 11, color: '#9ca3af' }}>Resolved</div>
          </div>
          {['deal', 'contact', 'account'].map(e => {
            const count = violations.filter(v => v.entity_type === e && !v.resolved_at).length;
            if (count === 0) return null;
            return (
              <div key={e} style={logStyles.summaryCard}>
                <div style={{ fontSize: 20, fontWeight: 700, color: '#374151' }}>{count}</div>
                <div style={{ fontSize: 11, color: '#9ca3af' }}>{ENTITY_ICONS[e]} {e}s</div>
              </div>
            );
          })}
        </div>
      )}

      {loading ? (
        <div style={{ color: '#9ca3af', fontSize: 13, padding: 8 }}>Loading violations…</div>
      ) : violations.length === 0 ? (
        <div style={logStyles.empty}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>No violations found</div>
          <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>
            All records are passing their audit rules.
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {violations.map(v => (
            <ViolationRow key={v.id} violation={v} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Single violation row ─────────────────────────────────────────────────────

function ViolationRow({ violation: v }) {
  const isResolved = !!v.resolved_at;
  return (
    <div
      style={{
        background: isResolved ? '#f9fafb' : '#fff',
        border: `1px solid ${isResolved ? '#e5e7eb' : '#fca5a5'}`,
        borderRadius: 8,
        padding: '11px 14px',
        opacity: isResolved ? 0.7 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span style={{ fontSize: 18 }}>{ENTITY_ICONS[v.entity_type] || '📋'}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>
              {v.entity_type} #{v.entity_id}
            </span>
            <span style={{ fontSize: 11, color: '#6b7280' }}>Rule #{v.rule_id}</span>
            {isResolved ? (
              <span style={{ fontSize: 11, fontWeight: 600, color: '#059669', background: '#f0fdf4', borderRadius: 4, padding: '1px 6px' }}>
                ✓ Resolved
              </span>
            ) : (
              <span style={{ fontSize: 11, fontWeight: 600, color: '#dc2626', background: '#fef2f2', borderRadius: 4, padding: '1px 6px' }}>
                ⚠ Open
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>
            Detected {formatDatetime(v.detected_at)}
            {isResolved && ` · Resolved ${formatDatetime(v.resolved_at)}`}
          </div>
          {v.metadata && Object.keys(v.metadata).length > 0 && (
            <details style={{ marginTop: 4 }}>
              <summary style={{ fontSize: 11, color: '#9ca3af', cursor: 'pointer' }}>Details</summary>
              <pre style={{ fontSize: 10, color: '#6b7280', marginTop: 3, background: '#f9fafb', borderRadius: 5, padding: 6 }}>
                {JSON.stringify(v.metadata, null, 2)}
              </pre>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main export ───────────────────────────────────────────────────────────────

export default function ExecutionLog({ scope = 'org', orgId }) {
  const [activeTab, setActiveTab] = useState('executions');

  const tabs = [
    { id: 'executions', label: '📋 Execution History' },
    ...(scope === 'org' ? [{ id: 'violations', label: '⚠️ Violations' }] : []),
  ];

  return (
    <div style={logStyles.container}>
      {/* Tab bar */}
      <div style={logStyles.tabBar}>
        {tabs.map(t => (
          <button
            key={t.id}
            style={{ ...logStyles.tab, ...(activeTab === t.id ? logStyles.tabActive : {}) }}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ paddingTop: 16 }}>
        {activeTab === 'executions' && <ExecutionsTab scope={scope} orgId={orgId} />}
        {activeTab === 'violations' && <ViolationsTab />}
      </div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const logStyles = {
  container: {
    display: 'flex',
    flexDirection: 'column',
  },
  tabBar: {
    display: 'flex',
    gap: 4,
    borderBottom: '1px solid #e5e7eb',
    paddingBottom: 0,
  },
  tab: {
    padding: '8px 16px',
    borderRadius: '7px 7px 0 0',
    border: '1px solid transparent',
    borderBottom: 'none',
    background: 'transparent',
    fontSize: 13,
    fontWeight: 500,
    color: '#6b7280',
    cursor: 'pointer',
    marginBottom: -1,
  },
  tabActive: {
    background: '#fff',
    border: '1px solid #e5e7eb',
    borderBottom: '1px solid #fff',
    color: '#111827',
    fontWeight: 600,
  },
  filterRow: {
    display: 'flex',
    gap: 8,
    marginBottom: 14,
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  filterSelect: {
    padding: '6px 10px',
    borderRadius: 7,
    border: '1px solid #d1d5db',
    fontSize: 12,
    background: '#fff',
    color: '#374151',
  },
  refreshBtn: {
    padding: '6px 12px',
    borderRadius: 7,
    border: '1px solid #e5e7eb',
    background: '#fff',
    fontSize: 12,
    color: '#6b7280',
    cursor: 'pointer',
    marginLeft: 'auto',
  },
  summaryBar: {
    display: 'flex',
    gap: 10,
    marginBottom: 14,
    flexWrap: 'wrap',
  },
  summaryCard: {
    background: '#f9fafb',
    border: '1px solid #e5e7eb',
    borderRadius: 9,
    padding: '10px 16px',
    textAlign: 'center',
    minWidth: 70,
  },
  execRow: {
    background: '#fff',
    border: '1px solid #e5e7eb',
    borderRadius: 9,
    padding: '11px 14px',
    cursor: 'pointer',
    transition: 'border-color 0.1s',
  },
  execHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
  },
  errLine: {
    fontSize: 12,
    color: '#dc2626',
    background: '#fef2f2',
    borderRadius: 6,
    padding: '5px 10px',
    marginBottom: 10,
  },
  empty: {
    padding: '32px 16px',
    textAlign: 'center',
    color: '#9ca3af',
  },
  pagination: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    marginTop: 14,
  },
  pageBtn: {
    padding: '5px 12px',
    borderRadius: 6,
    border: '1px solid #e5e7eb',
    background: '#fff',
    fontSize: 12,
    color: '#374151',
    cursor: 'pointer',
  },
};
