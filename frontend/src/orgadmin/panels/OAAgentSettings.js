/* Extracted from OrgAdminView.js — Phase 4 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Panel: OAAgentSettings. */
import React, { useState, useEffect } from 'react';
import { apiService } from '../../apiService';

export default function OAAgentSettings() {
  const [enabled, setEnabled]               = useState(false);
  const [autoExpireDays, setAutoExpireDays] = useState(7);
  const [maxPerDeal, setMaxPerDeal]         = useState(10);
  const [minConfidence, setMinConfidence]   = useState(0.40);
  const [loading, setLoading]               = useState(true);
  const [saving, setSaving]                 = useState(false);
  const [error, setError]                   = useState('');
  const [success, setSuccess]               = useState('');
  const [stats, setStats]                   = useState(null);
  const [tokenUsage, setTokenUsage]         = useState(null);
  const [period, setPeriod]                 = useState(30);

  const flash = (type, msg) => {
    if (type === 'success') { setSuccess(msg); setError(''); }
    else                    { setError(msg);   setSuccess(''); }
    setTimeout(() => { setSuccess(''); setError(''); }, 3500);
  };

  useEffect(() => {
    (async () => {
      try {
        const statusRes = await apiService.agent.getStatus();
        setEnabled(statusRes.data?.enabled || false);
        if (statusRes.data?.settings) {
          setMaxPerDeal(statusRes.data.settings.max_proposals_per_deal || 10);
          setMinConfidence(statusRes.data.settings.min_confidence ?? 0.40);
          setAutoExpireDays(statusRes.data.settings.auto_expire_days || 7);
        }

        const statsRes = await apiService.agent.admin.getStats(period);
        setStats(statsRes.data?.stats || null);

        const usageRes = await apiService.agent.admin.getTokenUsage(period);
        setTokenUsage(usageRes.data || null);
      } catch (e) {
        console.log('Agent settings load:', e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [period]);

  const handleToggle = async () => {
    setSaving(true);
    try {
      await apiService.agent.admin.updateSettings({
        agentic_framework_enabled: !enabled,
        agentic_auto_expire_days: autoExpireDays,
      });
      setEnabled(!enabled);
      flash('success', `AI Agent ${!enabled ? 'enabled' : 'disabled'} ✓`);
    } catch (e) {
      flash('error', e.message || 'Failed to update settings');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveExpiry = async () => {
    setSaving(true);
    try {
      await apiService.agent.admin.updateSettings({ agentic_auto_expire_days: autoExpireDays });
      flash('success', 'Auto-expire setting saved ✓');
    } catch (e) {
      flash('error', e.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div style={{ padding: 32, color: '#6b7280' }}>Loading AI Agent settings…</div>;

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2 style={{ margin: '0 0 4px' }}>🤖 AI Agent Framework</h2>
          <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>
            Enable the AI agent to propose CRM actions that require team member approval before execution.
          </p>
        </div>
      </div>

      {error   && <div className="sv-error" style={{ margin: '12px 0' }}>⚠️ {error}</div>}
      {success && <div className="sv-success" style={{ margin: '12px 0' }}>{success}</div>}

      <div className="sv-panel-body">
        {/* Toggle */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 12 }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>
              {enabled ? '🟢 AI Agent is Enabled' : '⚪ AI Agent is Disabled'}
            </div>
            <div style={{ fontSize: 13, color: '#6b7280' }}>
              {enabled
                ? 'The agent is actively generating proposals for your team. All proposals require human approval.'
                : 'Enable to let the AI agent propose CRM actions. No changes are made without approval.'}
            </div>
          </div>
          <button onClick={handleToggle} disabled={saving} style={{
            padding: '8px 20px', borderRadius: 8, border: 'none', fontWeight: 600, fontSize: 13, cursor: 'pointer',
            background: enabled ? '#fee2e2' : '#d1fae5', color: enabled ? '#dc2626' : '#059669',
          }}>
            {saving ? '⏳…' : enabled ? 'Disable' : 'Enable'}
          </button>
        </div>

        {/* Auto-expire */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 12 }}>
          <label style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap' }}>Auto-expire pending proposals after:</label>
          <select value={autoExpireDays} onChange={e => setAutoExpireDays(parseInt(e.target.value))}
            style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}>
            <option value={3}>3 days</option>
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
            <option value={0}>Never</option>
          </select>
          <button onClick={handleSaveExpiry} disabled={saving}
            style={{ padding: '6px 14px', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
            Save
          </button>
        </div>

        {/* Max proposals per deal per day */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 12 }}>
          <label style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap' }}>Max proposals per deal/day:</label>
          <select value={maxPerDeal} onChange={e => setMaxPerDeal(parseInt(e.target.value))}
            style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}>
            <option value={3}>3 (conservative)</option>
            <option value={5}>5</option>
            <option value={10}>10 (default)</option>
            <option value={15}>15</option>
            <option value={25}>25</option>
            <option value={50}>50 (max)</option>
          </select>
          <button onClick={async () => {
            setSaving(true);
            try { await apiService.agent.admin.updateSettings({ agentic_max_proposals_per_deal: maxPerDeal }); flash('success', 'Daily cap saved ✓'); }
            catch (e) { flash('error', e.message); }
            finally { setSaving(false); }
          }} disabled={saving}
            style={{ padding: '6px 14px', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
            Save
          </button>
          <span style={{ fontSize: 11, color: '#9ca3af' }}>Lower = less noise, higher = more proposals to review</span>
        </div>

        {/* Confidence floor */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 16 }}>
          <label style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap' }}>Min. confidence threshold:</label>
          <select value={minConfidence} onChange={e => setMinConfidence(parseFloat(e.target.value))}
            style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}>
            <option value={0}>0% (show all)</option>
            <option value={0.25}>25%</option>
            <option value={0.40}>40% (default)</option>
            <option value={0.50}>50%</option>
            <option value={0.60}>60%</option>
            <option value={0.75}>75% (high only)</option>
          </select>
          <button onClick={async () => {
            setSaving(true);
            try { await apiService.agent.admin.updateSettings({ agentic_min_confidence: minConfidence }); flash('success', 'Confidence threshold saved ✓'); }
            catch (e) { flash('error', e.message); }
            finally { setSaving(false); }
          }} disabled={saving}
            style={{ padding: '6px 14px', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
            Save
          </button>
          <span style={{ fontSize: 11, color: '#9ca3af' }}>Proposals below this confidence are discarded automatically</span>
        </div>

        {/* Proposal Stats */}
        {stats && (
          <div style={{ marginTop: 20 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: '#374151', marginBottom: 10 }}>📊 Proposal Stats (last {period} days)</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
              {[
                { label: 'Pending',  value: stats.pending,  color: '#f59e0b' },
                { label: 'Executed', value: stats.executed,  color: '#059669' },
                { label: 'Rejected', value: stats.rejected,  color: '#ef4444' },
                { label: 'Failed',   value: stats.failed,    color: '#dc2626' },
                { label: 'Expired',  value: stats.expired,   color: '#6b7280' },
                { label: 'Total',    value: stats.total,     color: '#374151' },
              ].map(s => (
                <div key={s.label} style={{ padding: '12px 14px', textAlign: 'center', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10 }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: s.color }}>{s.value || 0}</div>
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{s.label}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Token Usage */}
        {tokenUsage && (
          <div style={{ marginTop: 20 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: '#374151', marginBottom: 10 }}>
              🔢 AI Token Usage (last {period} days)
              <select value={period} onChange={e => setPeriod(parseInt(e.target.value))}
                style={{ marginLeft: 12, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12 }}>
                <option value={7}>7 days</option>
                <option value={30}>30 days</option>
                <option value={90}>90 days</option>
              </select>
            </h3>
            <div style={{ padding: '14px 20px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, display: 'flex', gap: 32, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>Total Tokens</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#374151' }}>
                  {parseInt(tokenUsage.totals?.total_tokens || 0).toLocaleString()}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>Est. Cost</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#374151' }}>
                  ${parseFloat(tokenUsage.totals?.estimated_cost || 0).toFixed(4)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>API Calls</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#374151' }}>
                  {parseInt(tokenUsage.totals?.call_count || 0).toLocaleString()}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
