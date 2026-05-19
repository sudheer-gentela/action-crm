// AccountView.js — extracted from ProspectingView.js (2026 module split).
// Verbatim component bodies; only imports added. No behavior changes.

import React from 'react';
import { useStages } from './prospectingShared';
import ProspectRowMenu from './ProspectRowMenu';
import CoverageScorecard from '../CoverageScorecard';

function AccountView({ groups, onSelect, isSelected, onToggleSelect, onSelectMany, onUnselectMany, atCap, onDiscard }) {
  const { allStages } = useStages();
  const showCheckbox = !!onToggleSelect;
  const showMenu     = !!onDiscard;
  return (
    <div className="pv-account-view">
      {groups.sort((a, b) => b.prospects.length - a.prospects.length).map((group, idx) => {
        const groupIds      = group.prospects.map(p => p.id);
        const groupSelCount = showCheckbox ? groupIds.filter(id => isSelected(id)).length : 0;
        const allGroupSelected  = showCheckbox && groupSelCount === groupIds.length && groupIds.length > 0;
        const someGroupSelected = showCheckbox && groupSelCount > 0 && !allGroupSelected;

        const handleGroupToggle = () => {
          if (allGroupSelected) {
            onUnselectMany && onUnselectMany(groupIds);
          } else {
            onSelectMany && onSelectMany(groupIds);
          }
        };

        return (
          <div key={idx} className="pv-account-group">
            <div className="pv-account-header" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {showCheckbox && (
                <input
                  type="checkbox"
                  checked={allGroupSelected}
                  ref={el => { if (el) el.indeterminate = someGroupSelected; }}
                  onChange={e => { e.stopPropagation(); handleGroupToggle(); }}
                  onClick={e => e.stopPropagation()}
                  title={allGroupSelected ? 'Unselect everyone in this account' : 'Select everyone in this account'}
                  style={{ cursor: 'pointer' }}
                />
              )}
              <span className="pv-account-name" style={{ flex: 1 }}>
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
                const selected = showCheckbox && isSelected(p.id);
                const disabled = showCheckbox && !selected && atCap;
                return (
                  <div
                    key={p.id}
                    className="pv-account-prospect-row"
                    onClick={() => onSelect(p)}
                    style={selected ? { background: '#ecfdf5' } : undefined}
                  >
                    {showCheckbox && (
                      <span
                        onClick={e => {
                          e.stopPropagation();
                          if (!disabled) onToggleSelect(p.id);
                        }}
                        style={{ marginRight: 6, cursor: disabled ? 'not-allowed' : 'pointer', lineHeight: 0 }}
                      >
                        <input
                          type="checkbox"
                          checked={!!selected}
                          disabled={disabled}
                          onChange={() => {}}
                          style={{ cursor: disabled ? 'not-allowed' : 'pointer' }}
                        />
                      </span>
                    )}
                    <span className="pv-apr-name">{p.first_name} {p.last_name}</span>
                    <span className="pv-apr-title">{p.title || ''}</span>
                    <span className="pv-stage-badge" style={{ background: stageCfg?.color + '20', color: stageCfg?.color }}>
                      {stageCfg?.icon} {stageCfg?.label}
                    </span>
                    <span className="pv-apr-touches">{p.outreach_count || 0} touches</span>
                    {showMenu && (
                      <span
                        onClick={e => e.stopPropagation()}
                        style={{ marginLeft: 'auto', lineHeight: 0 }}
                      >
                        <ProspectRowMenu prospect={p} onDiscard={onDiscard} />
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
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


export default AccountView;
