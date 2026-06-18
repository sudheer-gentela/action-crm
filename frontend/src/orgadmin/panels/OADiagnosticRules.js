/* Extracted from OrgAdminView.js — Phase 2 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Panel: OADiagnosticRules. */
import React, { useState } from 'react';
import { ModuleSubTabs } from '../shared';
import OADiagnosticRulesEdit from './OADiagnosticRulesEdit';
import OADiagnosticRulesSummary from './OADiagnosticRulesSummary';

export default function OADiagnosticRules() {
  const [subTab, setSubTab] = useState('edit'); // 'edit' | 'summary'

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>⚙️ Diagnostic Rules</h2>
          <p className="sv-panel-desc">
            Configure alert thresholds and view the complete rules document for your organisation.
          </p>
        </div>
      </div>
      <ModuleSubTabs
        tabs={[['edit', 'Edit Rules'], ['summary', 'Rules Summary']]}
        active={subTab}
        onChange={setSubTab}
      />
      {subTab === 'edit'    && <OADiagnosticRulesEdit />}
      {subTab === 'summary' && <OADiagnosticRulesSummary />}
    </div>
  );
}
