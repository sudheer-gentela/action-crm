// PipelineBoard.js — extracted from ProspectingView.js (2026 module split).
// Verbatim component bodies; only imports added. No behavior changes.

import React from 'react';
import { useStages, CHANNEL_ICONS, LI_STATUS_LABELS, getLiStatus, getLiDotColor, timeAgo } from './prospectingShared';
import ProspectRowMenu from './ProspectRowMenu';

function PipelineBoard({ stages, groupedByStage, onSelect, onStageChange, terminalCounts, isSelected, onToggleSelect, selectionActive, atCap, onDiscard, overdueCallProspectIds }) {
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
                <ProspectCard
                  key={p.id}
                  prospect={p}
                  onClick={() => onSelect(p)}
                  isSelected={isSelected && isSelected(p.id)}
                  onToggleSelect={onToggleSelect}
                  selectionActive={selectionActive}
                  atCap={atCap}
                  onDiscard={onDiscard}
                  hasOverdueCall={overdueCallProspectIds && overdueCallProspectIds.has(p.id)}
                />
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

function ProspectCard({ prospect: p, onClick, isSelected = false, onToggleSelect, selectionActive = false, atCap = false, onDiscard, hasOverdueCall = false }) {
  // The checkbox is fully visible when:
  //   - the card is selected, OR
  //   - the user already has a selection in progress (so additions are easy)
  // Otherwise it's 0.35 opacity and rises on hover via the existing .pv-card:hover rule.
  const showCheckbox = !!onToggleSelect;
  const showMenu     = !!onDiscard;
  const visible      = isSelected || selectionActive;
  const disabled     = !isSelected && atCap;

  return (
    <div
      className="pv-card"
      onClick={onClick}
      style={{
        position: 'relative',
        ...(isSelected ? { background: '#ecfdf5', borderColor: '#6ee7b7' } : {}),
      }}
    >
      {showCheckbox && (
        <label
          onClick={e => {
            e.stopPropagation();
            if (!disabled) onToggleSelect(p.id);
          }}
          title={disabled ? 'Max reached' : (isSelected ? 'Unselect' : 'Select')}
          style={{
            position: 'absolute',
            top: 6, right: 6,
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: visible ? 1 : 0.35,
            transition: 'opacity 0.15s',
            lineHeight: 0,
          }}
        >
          <input
            type="checkbox"
            checked={!!isSelected}
            disabled={disabled}
            onChange={() => {}}
            style={{ cursor: disabled ? 'not-allowed' : 'pointer' }}
          />
        </label>
      )}
      {showMenu && (
        <div
          style={{
            position: 'absolute',
            top: 2,
            // sits left of the checkbox if present, else tight to the right
            right: showCheckbox ? 28 : 4,
          }}
        >
          <ProspectRowMenu prospect={p} onDiscard={onDiscard} />
        </div>
      )}
      <div className="pv-card-top">
        <span className="pv-card-name">
          {hasOverdueCall && (
            <span
              title="Has overdue call task"
              style={{
                display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
                background: '#dc2626', marginRight: 6, verticalAlign: 'middle',
                boxShadow: '0 0 0 2px #fee2e2',
              }}
            />
          )}
          {p.first_name} {p.last_name}
        </span>
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

export default PipelineBoard;
export { ProspectCard };
