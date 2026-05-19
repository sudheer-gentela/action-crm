// ListView.js — extracted from ProspectingView.js (2026 module split).
// Verbatim component bodies; only imports added. No behavior changes.

import React from 'react';
import { useStages, CHANNEL_ICONS, LI_STATUS_LABELS, getLiStatus, getLiDotColor, timeAgo } from './prospectingShared';
import ProspectRowMenu from './ProspectRowMenu';

function ListView({
  prospects,
  onSelect,
  isSelected,
  onToggleSelect,
  onSelectMany,
  onUnselectMany,
  selectedCount = 0,
  atCap = false,
  bulkCap = 20,
  onDiscard,
  overdueCallProspectIds,
}) {
  const { allStages } = useStages();
  const showMenu = !!onDiscard;

  // Header "select all" — checked when all visible rows are selected.
  // If any are unselected, header acts as "select all visible" (bounded by cap).
  const visibleIds     = prospects.map(p => p.id);
  const allSelected    = visibleIds.length > 0 && visibleIds.every(id => isSelected && isSelected(id));
  const someSelected   = !allSelected && visibleIds.some(id => isSelected && isSelected(id));
  const handleHeaderToggle = () => {
    if (allSelected) {
      onUnselectMany && onUnselectMany(visibleIds);
    } else {
      onSelectMany && onSelectMany(visibleIds);
    }
  };

  // Column count used for the empty-state cell's colSpan.
  const colCount = 9 + (onToggleSelect ? 1 : 0) + (showMenu ? 1 : 0);

  return (
    <div className="pv-list">
      <table className="pv-table">
        <thead>
          <tr>
            {onToggleSelect && (
              <th style={{ width: 32, paddingLeft: 12 }}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={el => { if (el) el.indeterminate = someSelected; }}
                  onChange={handleHeaderToggle}
                  title={allSelected ? 'Unselect all visible' : 'Select all visible (up to ' + bulkCap + ')'}
                  style={{ cursor: 'pointer' }}
                />
              </th>
            )}
            <th>Name</th>
            <th>Company</th>
            <th>Title</th>
            <th>Stage</th>
            <th>Channel</th>
            <th>LinkedIn</th>
            <th>Outreach</th>
            <th>Last Touch</th>
            <th>ICP</th>
            {showMenu && <th style={{ width: 36 }}></th>}
          </tr>
        </thead>
        <tbody>
          {prospects.map(p => {
            const stageCfg = allStages.find(s => s.key === p.stage);
            const selected = isSelected && isSelected(p.id);
            // Prevent adding a new row past the cap; allow unchecking always.
            const disabled = !selected && atCap;
            return (
              <tr
                key={p.id}
                onClick={() => onSelect(p)}
                className="pv-table-row"
                style={selected ? { background: '#ecfdf5' } : undefined}
              >
                {onToggleSelect && (
                  <td
                    style={{ paddingLeft: 12 }}
                    onClick={e => {
                      // Don't let row-click navigate when the user is clicking the checkbox cell.
                      e.stopPropagation();
                      if (!disabled) onToggleSelect(p.id);
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={!!selected}
                      disabled={disabled}
                      onChange={() => {}}
                      title={disabled ? `Max ${bulkCap} per bulk enroll` : ''}
                      style={{ cursor: disabled ? 'not-allowed' : 'pointer' }}
                    />
                  </td>
                )}
                <td className="pv-table-name">
                  {overdueCallProspectIds && overdueCallProspectIds.has(p.id) && (
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
                {showMenu && (
                  <td onClick={e => e.stopPropagation()} style={{ textAlign: 'right' }}>
                    <ProspectRowMenu prospect={p} onDiscard={onDiscard} />
                  </td>
                )}
              </tr>
            );
          })}
          {prospects.length === 0 && (
            <tr><td colSpan={colCount} className="pv-table-empty">No prospects found</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// ACCOUNT VIEW
// ═════════════════════════════════════════════════════════════════════════════


export default ListView;
