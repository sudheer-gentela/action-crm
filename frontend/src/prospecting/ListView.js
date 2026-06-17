// ListView.js — extracted from ProspectingView.js (2026 module split).
// Verbatim component bodies; only imports added. No behavior changes.

import React from 'react';
import { useStages, CHANNEL_ICONS, LI_STATUS_LABELS, getLiStatus, getLiDotColor, timeAgo } from './prospectingShared';
import ProspectRowMenu from './ProspectRowMenu';
import { formatCustomValue } from '../customfields/customFieldColumns';

// Source pill — mapped from prospects.source to a short label and tone.
// Unknown values get a neutral grey pill with the raw value so we don't lose
// information when a writer introduces a new source.
const SOURCE_META = {
  manual:        { label: 'Manual',    bg: '#e0e7ff', fg: '#3730a3' },
  csv_import:    { label: 'CSV',       bg: '#dbeafe', fg: '#1d4ed8' },
  extension:     { label: 'Extension', bg: '#dcfce7', fg: '#166534' },
  linkedin:      { label: 'LinkedIn',  bg: '#e0f2fe', fg: '#0369a1' },
  referral:      { label: 'Referral',  bg: '#fef3c7', fg: '#92400e' },
  event:         { label: 'Event',     bg: '#fce7f3', fg: '#9d174d' },
  inbound:       { label: 'Inbound',   bg: '#f3e8ff', fg: '#6b21a8' },
  import:        { label: 'Import',    bg: '#dbeafe', fg: '#1d4ed8' },
};
function SourcePill({ source }) {
  if (!source) return <span style={{ color: '#9ca3af' }}>—</span>;
  const meta = SOURCE_META[source] || { label: source, bg: '#f3f4f6', fg: '#374151' };
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px',
      fontSize: 10, fontWeight: 600,
      background: meta.bg, color: meta.fg,
      borderRadius: 10, whiteSpace: 'nowrap',
    }}>{meta.label}</span>
  );
}

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
  onActivate,
  overdueCallProspectIds,
  customColumns,   // { keys:[], defs:[], byEntity:{} } — optional custom-field columns
}) {
  const { allStages } = useStages();
  const showMenu = !!onDiscard || !!onActivate;

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
  // 10 base cols (Name, Company, Title, Stage, Channel, Source, LinkedIn,
  // Outreach, Last Touch, ICP) + optional select column + optional menu.
  const colCount = 10 + (onToggleSelect ? 1 : 0) + (showMenu ? 1 : 0) + (customColumns?.keys?.length || 0);

  const cfKeys = customColumns?.keys || [];
  const cfDefs = customColumns?.defs || [];
  const cfByEntity = customColumns?.byEntity || {};
  const cfDefFor = (k) => cfDefs.find(d => d.field_key === k) || { field_key: k };

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
            <th>Source</th>
            <th>LinkedIn</th>
            <th>Outreach</th>
            <th>Last Touch</th>
            <th>ICP</th>
            {cfKeys.map(k => <th key={k}>{(cfDefFor(k).label) || k}</th>)}
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
                <td><SourcePill source={p.source} /></td>
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
                {cfKeys.map(k => (
                  <td key={k}>{formatCustomValue(cfDefFor(k), cfByEntity[p.id]?.[k]) || '—'}</td>
                ))}
                {showMenu && (
                  <td onClick={e => e.stopPropagation()} style={{ textAlign: 'right' }}>
                    <ProspectRowMenu prospect={p} onDiscard={onDiscard} onActivate={onActivate} />
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


export { SourcePill };
export default ListView;
