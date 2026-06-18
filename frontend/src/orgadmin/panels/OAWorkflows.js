/* Extracted from OrgAdminView.js — Phase 4 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Panel: OAWorkflows. */
import React, { useState } from 'react';
import ExecutionLog from '../../ExecutionLog';
import WorkflowCanvas from '../../WorkflowCanvas';

export default function OAWorkflows() {
  const [subTab, setSubTab] = useState('canvas');

  const SUB_TABS = [
    { id: 'canvas', label: '⚙️ Workflows & Rules' },
    { id: 'log',    label: '📋 Execution Log'     },
  ];

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>⚙️ Workflows</h2>
          <p className="sv-panel-desc">
            Define data-integrity rules for deals, contacts, and accounts.
            Platform workflows (🔒) are managed by ActionCRM and cannot be modified.
          </p>
        </div>
      </div>

      {/* Sub-tab bar */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #e5e7eb', marginBottom: 20 }}>
        {SUB_TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setSubTab(t.id)}
            style={{
              padding: '7px 16px',
              borderRadius: '7px 7px 0 0',
              border: '1px solid transparent',
              borderBottom: 'none',
              background: subTab === t.id ? '#fff' : 'transparent',
              borderColor: subTab === t.id ? '#e5e7eb' : 'transparent',
              borderBottomColor: subTab === t.id ? '#fff' : 'transparent',
              fontSize: 13,
              fontWeight: subTab === t.id ? 600 : 500,
              color: subTab === t.id ? '#111827' : '#6b7280',
              cursor: 'pointer',
              marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {subTab === 'canvas' && <WorkflowCanvas scope="org" />}
      {subTab === 'log'    && <ExecutionLog   scope="org" />}
    </div>
  );
}
