import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';

/**
 * CoverageScorecard
 *
 * Renders the output from GET /api/accounts/:id/coverage?playbookId=N
 * Shows: overall score, progress bar, per-role status, gaps.
 *
 * Props:
 *   accountId  {number}   — account to evaluate
 *   playbookId {number?}  — pre-selected playbook (optional, can pick from dropdown)
 */

function CoverageScorecard({ accountId, playbookId: initialPlaybookId }) {
  const [playbooks, setPlaybooks]   = useState([]);
  const [playbookId, setPlaybookId] = useState(initialPlaybookId || null);
  const [data, setData]             = useState(null);
  const [loading, setLoading]       = useState(false);

  // Fetch available prospecting playbooks
  useEffect(() => {
    apiService.playbooks.getAll()
      .then(res => {
        const pbs = (res.data?.playbooks || []).filter(p => p.type === 'prospecting');
        setPlaybooks(pbs);
        if (!playbookId && pbs.length > 0) {
          setPlaybookId(pbs[0].id);
        }
      })
      .catch(() => setPlaybooks([]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch coverage when account or playbook changes
  const fetchCoverage = useCallback(async () => {
    if (!accountId || !playbookId) return;
    setLoading(true);
    try {
      const res = await apiService.accountProspecting.getCoverage(accountId, playbookId);
      setData(res.data);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [accountId, playbookId]);

  useEffect(() => { fetchCoverage(); }, [fetchCoverage]);

  // No playbooks available
  if (playbooks.length === 0 && !loading) return null;

  // Score-based color
  const scoreColor = (score) => {
    if (score >= 75) return '#10b981';
    if (score >= 50) return '#f59e0b';
    return '#ef4444';
  };

  const roleStatusColor = (covered, required) => {
    if (covered) return { bg: '#ecfdf5', text: '#047857', label: 'Covered' };
    if (required) return { bg: '#fef2f2', text: '#991b1b', label: 'Gap' };
    return { bg: '#fffbeb', text: '#92400e', label: 'Optional Gap' };
  };

  return (
    <div className="cs-card">
      <div className="cs-header">
        <h4>📊 Coverage Scorecard</h4>
        {data && (
          <span
            className="cs-score-badge"
            style={{
              background: scoreColor(data.coverageScore) + '15',
              color: scoreColor(data.coverageScore),
            }}
          >
            {data.coverageScore}%
          </span>
        )}
      </div>

      {/* Playbook selector */}
      {playbooks.length > 1 && (
        <div className="cs-playbook-select">
          <label>Playbook:</label>
          <select
            value={playbookId || ''}
            onChange={e => setPlaybookId(parseInt(e.target.value))}
          >
            {playbooks.map(pb => (
              <option key={pb.id} value={pb.id}>{pb.name}</option>
            ))}
          </select>
        </div>
      )}

      {loading && <div className="cs-loading">Loading coverage...</div>}

      {!loading && !data && <div className="cs-empty">No coverage data available</div>}

      {!loading && data && (
        <>
          {/* Progress bar */}
          <div className="cs-progress-bar">
            <div
              className="cs-progress-fill"
              style={{
                width: `${Math.min(data.coverageScore, 100)}%`,
                background: scoreColor(data.coverageScore),
              }}
            />
          </div>

          {/* Role rows */}
          {data.roles && data.roles.length > 0 && (
            <div className="cs-roles">
              {data.roles.map((role, idx) => {
                const status = roleStatusColor(role.covered, role.required);
                return (
                  <div
                    key={idx}
                    className="cs-role-row"
                    style={{ background: status.bg }}
                  >
                    <span className="cs-role-name">
                      <span className="cs-role-badge" style={{ background: status.text + '15', color: status.text }}>
                        {status.label}
                      </span>
                      {role.role.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                      {role.required && <span style={{ color: '#ef4444', fontSize: 10 }}>*</span>}
                    </span>
                    <span className="cs-role-matches">
                      {role.matches?.length > 0
                        ? role.matches.map(m => `${m.first_name || m.firstName} ${m.last_name || m.lastName}`).join(', ')
                        : '—'}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Gaps summary */}
          {data.gaps && data.gaps.length > 0 && (
            <div className="cs-gaps-section">
              <div className="cs-gaps-title">Gaps to Fill</div>
              {data.gaps.map((gap, idx) => (
                <div key={idx} className="cs-gap-item">
                  • {gap.role?.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                  {gap.required ? ' (required)' : ' (optional)'}
                  {gap.suggestedTitles?.length > 0 && (
                    <span style={{ color: '#9ca3af' }}> — look for: {gap.suggestedTitles.join(', ')}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default CoverageScorecard;
