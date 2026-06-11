// prospecting/PacingTile.js
//
// Slice 2 — Pacing tile shown inside CampaignDetailDrawer. Surfaces:
//   - Funnel counts (target → research → outreach → ... )
//   - 7-day activation rate
//   - Estimated days-to-clear-research-pile
//   - Health indicator (green / amber / red)
//
// Backend: GET /api/prospecting-campaigns/:id/pacing

import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch } from './prospectingShared';

const HEALTH_COLORS = {
  green: { bg: '#ecfdf5', fg: '#065f46', dot: '#10b981', label: 'On pace' },
  amber: { bg: '#fffbeb', fg: '#92400e', dot: '#f59e0b', label: 'Behind pace' },
  red:   { bg: '#fef2f2', fg: '#991b1b', dot: '#ef4444', label: 'Stalled' },
  gray:  { bg: '#f9fafb', fg: '#6b7280', dot: '#9ca3af', label: 'No activity yet' },
};

// onStageClick (optional): (stageKey, label) => void — makes the mini-funnel
// tiles clickable so the drawer can open a "who's in this stage" drill-down.
export default function PacingTile({ campaignId, onStageClick }) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiFetch(`/prospecting-campaigns/${campaignId}/pacing`);
      setData(r);
      setError('');
    } catch (err) {
      setError(err.message || 'Failed to load pacing');
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div style={tileStyle}>
        <div style={{ fontSize: 12, color: '#9ca3af' }}>Loading pacing…</div>
      </div>
    );
  }
  if (error) {
    return (
      <div style={tileStyle}>
        <div style={{ fontSize: 12, color: '#991b1b' }}>Pacing unavailable: {error}</div>
      </div>
    );
  }
  if (!data) return null;

  const { stages, pacing } = data;
  const health = HEALTH_COLORS[pacing.health] || HEALTH_COLORS.gray;

  return (
    <div style={tileStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#1A3A5C' }}>📈 Pacing</div>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600,
          padding: '3px 9px', borderRadius: 12,
          background: health.bg, color: health.fg,
        }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: health.dot }} />
          {health.label}
        </span>
      </div>

      {/* Mini-funnel: counts by stage */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6, marginBottom: 12 }}>
        <FunnelStep label="Target"    count={stages.target}    color="#6b7280" onClick={onStageClick && (() => onStageClick('target', 'Target'))} />
        <FunnelStep label="Research"  count={stages.research}  color="#8b5cf6" highlight onClick={onStageClick && (() => onStageClick('research', 'Research'))} />
        <FunnelStep label="Outreach"  count={stages.outreach}  color="#3b82f6" onClick={onStageClick && (() => onStageClick('outreach', 'Outreach'))} />
        <FunnelStep label="Engaged"   count={stages.engaged}   color="#0F9D8E" onClick={onStageClick && (() => onStageClick('engaged', 'Engaged'))} />
        <FunnelStep label="Disc."     count={stages.discovery_call} color="#f59e0b" onClick={onStageClick && (() => onStageClick('discovery_call', 'Discovery call'))} />
        <FunnelStep label="SAL"       count={stages.qualified_sal}  color="#10b981" onClick={onStageClick && (() => onStageClick('qualified_sal', 'Qualified (SAL)'))} />
      </div>

      {/* Activation rate stats */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8,
        background: '#f8fafc', borderRadius: 6, padding: '8px 10px',
        fontSize: 12,
      }}>
        <Stat
          label="Ready to activate"
          value={pacing.readyToActivate}
          accent={pacing.readyToActivate > 0 ? '#8b5cf6' : '#9ca3af'}
        />
        <Stat
          label="Activations / day (7d)"
          value={pacing.activationsPerDay > 0 ? pacing.activationsPerDay : '—'}
          accent="#1A3A5C"
        />
        <Stat
          label="Days to clear"
          value={pacing.daysToClear !== null ? pacing.daysToClear : '—'}
          accent={pacing.health === 'red' ? '#ef4444' : pacing.health === 'amber' ? '#f59e0b' : '#1A3A5C'}
        />
      </div>

      {pacing.readyToActivate > 0 && pacing.activationsPerDay === 0 && (
        <div style={{
          marginTop: 10, fontSize: 11, color: '#991b1b',
          background: '#fef2f2', borderRadius: 6, padding: '6px 9px',
          border: '1px solid #fecaca',
        }}>
          ⚠️ {pacing.readyToActivate} prospects ready but no activations in the last 7 days.
        </div>
      )}
    </div>
  );
}

function FunnelStep({ label, count, color, highlight, onClick }) {
  return (
    <div
      onClick={onClick || undefined}
      title={onClick ? 'Click to see who' : undefined}
      style={{
        textAlign: 'center', padding: '6px 4px',
        background: highlight ? '#f5f3ff' : '#fff',
        border: highlight ? `1px solid ${color}33` : '1px solid #f1f5f9',
        borderRadius: 6,
        cursor: onClick ? 'pointer' : 'default',
      }}>
      <div style={{ fontSize: 16, fontWeight: 700, color }}>{count}</div>
      <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>{label}</div>
    </div>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 700, color: accent || '#1A3A5C', marginTop: 2 }}>{value}</div>
    </div>
  );
}

const tileStyle = {
  marginTop: 16,
  padding: 14,
  background: '#fff',
  border: '1px solid #e5e7eb',
  borderRadius: 8,
};
