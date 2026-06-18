import { useState, useEffect } from 'react';
import { hashSegment, writeHash } from './hashNav';
import { apiService } from './apiService';
import './OrgAdminView.css';
import DealHealthSettings from './DealHealthSettings';
import CustomFieldDefsEditor from './customfields/CustomFieldDefsEditor';
import OAStages from './OAStages';
import OAProducts from './OAProducts';
import OATeamDimensions from './OATeamDimensions';
import OAEmailSettings from './OAEmailSettings';
import OAAIProviderSettings from './OAAIProviderSettings';
import { TrackingDomainSettings } from './prospecting/TrackingSettings';   // Insights/WBR Phase 7

import { MODULE_NAV_DEFS, TAB_META } from './orgadmin/constants';
import { buildNavGroups } from './orgadmin/helpers';

import OATokenUsageModule from './orgadmin/panels/OATokenUsageModule';
import OASalesforceSettings from './orgadmin/panels/OASalesforceSettings';
import OAHubSpotSettings from './orgadmin/panels/OAHubSpotSettings';
import OASettings from './orgadmin/panels/OASettings';
import OAAgentSettings from './orgadmin/panels/OAAgentSettings';
import OADuplicateSettings from './orgadmin/panels/OADuplicateSettings';
import OAIntegrations from './orgadmin/panels/OAIntegrations';
import OAActionsAI from './orgadmin/panels/OAActionsAI';
import OAWorkflows from './orgadmin/panels/OAWorkflows';
import OAModules from './orgadmin/panels/OAModules';
import OAProspectingModule from './orgadmin/panels/OAProspectingModule';
import OACLMModule from './orgadmin/panels/OACLMModule';
import OAHandoverModule from './orgadmin/panels/OAHandoverModule';
import OAServiceModule from './orgadmin/panels/OAServiceModule';
import OAAgencyModule from './orgadmin/panels/OAAgencyModule';
import OAPlaybooks from './orgadmin/panels/OAPlaybooks';
import OADealRoles from './orgadmin/panels/OADealRoles';
import OADiagnosticRules from './orgadmin/panels/OADiagnosticRules';
import OAIcpScoring from './orgadmin/panels/OAIcpScoring';


import OAMembers from './orgadmin/panels/OAMembers';
import OAHierarchy from './orgadmin/panels/OAHierarchy';
import OATeams from './orgadmin/panels/OATeams';
import OAInvitations from './orgadmin/panels/OAInvitations';


// ═══════════════════════════════════════════════════════════════════
// ORG ADMIN VIEW — per-organisation administration
// Accessible to org owners and admins only.
// The SettingsView handles AI/playbook/deal-health configuration —
// this view handles PEOPLE, ROLES, INVITATIONS, and ORG SETTINGS.
// ═══════════════════════════════════════════════════════════════════

// Static nav groups — Modules group is injected dynamically in OrgAdminView
// based on which modules are enabled for the org.


// Module definitions — drives dynamic nav + per-module content routing


// Builds the full nav group list, inserting enabled module items before 'General'


// Content descriptions for the top bar


// ─────────────────────────────────────────────────────────────────────────────
// OATokenUsageModule — AI usage dashboard for Org Admin
// ─────────────────────────────────────────────────────────────────────────────


export default function OrgAdminView() {
  // Restored from #/org-admin/<tab> on refresh; 'members' (the default)
  // is represented by no segment. See hashNav.js for the ownership model.
  const [tab, setTab]               = useState(() => {
    if (hashSegment(0) === 'org-admin') {
      const s = hashSegment(1);
      if (s) return s;
    }
    return 'members';
  });

  useEffect(() => {
    if (hashSegment(0) !== 'org-admin') return;
    writeHash(['org-admin', tab === 'members' ? null : tab]);
  }, [tab]);
  const [stats, setStats]           = useState(null);
  const [orgName, setOrgName]       = useState('');
  const [orgId,   setOrgId]         = useState(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // orgModules — controls which module nav items are visible.
  // Kept in sync via moduleToggle events fired by child components.
  const [orgModules, setOrgModules] = useState({
    contracts:   false,
    prospecting: false,
    handovers:   false,
    service:     false,
    agency:      false,
  });

  useEffect(() => {
    apiService.orgAdmin.getStats()
      .then(r => setStats(r.data))
      .catch(console.error);

   apiService.orgAdmin.getProfile()
     .then(r => {
       const org  = r.data?.org ?? r.data ?? {};
       const name = org.name || '';
       if (name) setOrgName(name);
       if (org.id) setOrgId(org.id);


       // New profile shape: r.data.modules = { key: { allowed, enabled } }
       // Legacy shape:      r.data.org.settings.modules = { key: true/false }
       // buildNavGroups and orgModules state only need `enabled` — extract that.
       const normalisedMods = r.data.modules;
       if (normalisedMods) {
         setOrgModules({
           contracts:   normalisedMods.contracts?.enabled   || false,
           prospecting: normalisedMods.prospecting?.enabled || false,
           handovers:   normalisedMods.handovers?.enabled   || false,
           service:     normalisedMods.service?.enabled     || false,
           agency:      normalisedMods.agency?.enabled      || false,
         });
       } else {
         // Legacy fallback
         const mods =
           org?.settings?.modules ||
           org?.modules           ||
           {};
         setOrgModules({
           contracts:   mods.contracts   === true || mods.contracts?.enabled   || false,
           prospecting: mods.prospecting === true || mods.prospecting?.enabled || false,
           handovers:   mods.handovers   === true || mods.handovers?.enabled   || false,
           service:     mods.service     === true || mods.service?.enabled     || false,
           agency:      mods.agency      === true || mods.agency?.enabled      || false,
         });
       }
     })
     .catch(e => console.error('[OrgAdminView] getProfile failed:', e));


    // Listen for module toggle events fired by child General sub-tabs
    const handleModuleToggle = (e) => {
      const { module, enabled } = e.detail;
      setOrgModules(prev => ({ ...prev, [module]: enabled }));
    };
    window.addEventListener('moduleToggle', handleModuleToggle);
    return () => window.removeEventListener('moduleToggle', handleModuleToggle);
  }, []);

  const currentUser = JSON.parse(localStorage.getItem('user') || '{}');
  const meta = TAB_META[tab] || TAB_META.members;
  const navGroups = buildNavGroups(orgModules);

  // When a module is disabled via its General sub-tab, redirect to the Modules overview
  // so the user can see the full list and re-enable if needed.
  useEffect(() => {
    if (tab.startsWith('mod-')) {
      const def = MODULE_NAV_DEFS.find(m => m.navId === tab);
      if (def && !orgModules[def.moduleKey]) {
        setTab('modules');
      }
    }
  }, [orgModules, tab]);

  return (
    <div className="oa-layout">
      {/* ── Sidebar ── */}
      <nav className={`oa-sidebar ${sidebarCollapsed ? 'oa-sidebar--collapsed' : ''}`}>
        <div className="oa-sidebar-header">
          {!sidebarCollapsed && <span className="oa-sidebar-title">{orgName || 'Admin'}</span>}
          <button
            className="oa-sidebar-toggle"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? '›' : '‹'}
          </button>
        </div>

        <div className="oa-sidebar-nav">
          {navGroups.map(group => (
            <div key={group.label} className="oa-nav-group">
              {!sidebarCollapsed && <div className="oa-nav-group-label">{group.label}</div>}
              {group.items.map(item => (
                <button
                  key={item.id}
                  className={`oa-nav-item ${tab === item.id ? 'oa-nav-item--active' : ''}`}
                  onClick={() => setTab(item.id)}
                  title={sidebarCollapsed ? item.label : undefined}
                >
                  <span className="oa-nav-icon">{item.icon}</span>
                  {!sidebarCollapsed && <span className="oa-nav-label">{item.label}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>

        {!sidebarCollapsed && (
          <div className="oa-sidebar-footer">Organisation Admin</div>
        )}
      </nav>

      {/* ── Main Content ── */}
      <main className="oa-main">
        <div className="oa-topbar">
          <h1 className="oa-topbar-title">{meta.title}</h1>
          <p className="oa-topbar-desc">{meta.desc}</p>
        </div>

        <div className="oa-content">
          {tab === 'custom-fields' && <CustomFieldDefsEditor />}
          {/* Stats cards — show on members tab */}
          {tab === 'members' && stats && (
            <div className="oa-stats-grid">
              <div className="oa-stat-card">
                <div className="oa-stat-card-label">Active Members</div>
                <div className="oa-stat-card-value" style={{ color: '#059669' }}>{stats.members.active}</div>
              </div>
              <div className="oa-stat-card">
                <div className="oa-stat-card-label">Pending Invites</div>
                <div className="oa-stat-card-value" style={{ color: '#d97706' }}>{stats.invitations.total}</div>
              </div>
              <div className="oa-stat-card">
                <div className="oa-stat-card-label">Total Deals</div>
                <div className="oa-stat-card-value" style={{ color: '#4338ca' }}>{stats.deals.total}</div>
              </div>
              <div className="oa-stat-card">
                <div className="oa-stat-card-label">Actions (7d)</div>
                <div className="oa-stat-card-value" style={{ color: '#0284c7' }}>{stats.actions.week}</div>
              </div>
            </div>
          )}

          <div className="oa-tab-content">
            {/* ── Modules overview — always accessible for enable/disable ── */}
            {tab === 'modules'          && <OAModules />}
            {/* ── Per-module settings pages (only reachable when module is enabled) ── */}
            {tab === 'ai-usage'          && <OATokenUsageModule />}
            {tab === 'mod-prospecting'  && <OAProspectingModule />}
            {tab === 'mod-contracts'    && <OACLMModule />}
            {tab === 'mod-handovers'    && <OAHandoverModule />}
            {tab === 'mod-service'      && <OAServiceModule />}
            {tab === 'mod-agency'       && <OAAgencyModule />}
            {/* ── All other existing sections (untouched) ── */}
            {tab === 'members'          && <OAMembers currentUserId={currentUser.id} />}
            {tab === 'hierarchy'        && <OAHierarchy />}
            {tab === 'teams'            && <OATeams />}
            {tab === 'invitations'      && <OAInvitations />}
            {tab === 'playbooks'        && <OAPlaybooks />}
            {tab === 'health'           && <DealHealthSettings />}
            {tab === 'icp-scoring'      && <OAIcpScoring />}
            {tab === 'diagnostic-rules' && <OADiagnosticRules />}
            {tab === 'stages'           && <OAStages />}
            {tab === 'org-roles'        && <OADealRoles />}
            {tab === 'products'         && <OAProducts />}
            {tab === 'ai-agent'         && <OAAgentSettings />}
            {tab === 'ai-providers'     && <OAAIProviderSettings />}
            {tab === 'action-ai'        && <OAActionsAI />}
            {tab === 'duplicates'       && <OADuplicateSettings />}
            {tab === 'workflows'        && <OAWorkflows />}
            {tab === 'email-settings'   && <OAEmailSettings />}
            {tab === 'tracking-domain'  && <TrackingDomainSettings />}   {/* Insights/WBR Phase 7 */}
            {tab === 'team-dimensions'  && <OATeamDimensions />}
            {(tab === 'integrations' || tab === 'integrations-overview') && <OAIntegrations orgId={orgId} />}
            {tab === 'salesforce'        && <OASalesforceSettings />}
            {tab === 'hubspot'           && <OAHubSpotSettings />}
            {tab === 'settings'         && <OASettings />}
          </div>
        </div>
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// ROLE DEFINITIONS — rendered as cards so users understand what each means
// ─────────────────────────────────────────────────────────────────


// v2: Department options for CLM legal team routing


// ─────────────────────────────────────────────────────────────────
// MEMBERS TAB
// ─────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────
// HIERARCHY TAB — visual org tree with drag-drop & matrix reporting
// ─────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────
// TEAMS TAB
// Multi-dimensional team management: dimensions config, team CRUD,
// and user assignment grid.
// ─────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────
// OATeamRoster — read-only view of user assignments across dimensions
// Filterable by dimension and team, with search and summary stats.
// ─────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────
// ICP SCORING CONFIG TAB
// Configures the Ideal Customer Profile scoring model.
// Reads/writes organizations.settings.icp_config via the
// existing icpScoring.service.js GET/PUT /icp-config/current.
// ─────────────────────────────────────────────────────────────────

// ── Color palette for categories ──────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// OADiagnosticRules
// Configure thresholds for nightly + real-time diagnostic engines.
// One collapsible section per module. Save button per section.
// ─────────────────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────────────────
// OADiagnosticRulesSummary
// Live per-org rules document. Shows every module, every rule, with the org's
// actual effective thresholds substituted in. Updates whenever rules are saved.
// ─────────────────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────
// INVITATIONS TAB
// ─────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────
// ORG SETTINGS TAB
// ─────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// OAPlaybooks — full playbook management for org admins
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────
// OAPlaybooks — wired to deal_stages + stage_guidance
// ─────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────
// OASalesforceSettings — Salesforce integration settings tab
// ─────────────────────────────────────────────────────────────────


// OAHubSpotSettings — HubSpot integration settings tab
// ─────────────────────────────────────────────────────────────────


// ── OAPlaybookTypes ──────────────────────────────────────────────────────────
// Manage configurable playbook types (stored in organizations.settings.playbook_types)
// System types (Sales, Prospecting) cannot be removed. Custom types can be added/removed.


// ── OADealRoles (Organization Roles) ──────────────────────────────────────────
// Lets org admins manage roles available across all playbooks and workflows.
// System roles can be toggled active/inactive but not renamed or deleted.
// Custom roles can be created, renamed, and deleted.


// Helper: try /org-roles, fall back to /deal-roles for backward compat


// ─────────────────────────────────────────────────────────────────
// AI AGENT TAB — org-level toggle, proposal stats, token usage
// ─────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────
// AI AGENT TAB — org-level toggle, proposal stats, token usage
// ─────────────────────────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════
// Duplicate Detection Settings (Org Admin)
// ═══════════════════════════════════════════════════════════════


// ── Integrations (org-level) ──────────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════
// MODULE SETTINGS PAGES
// One component per module, each with its own sub-tab shell.
// These are rendered when the user clicks a module nav item.
// General sub-tab always has the enable/disable toggle.
// Other sub-tabs are hidden until the module is enabled.
// ═══════════════════════════════════════════════════════════════════

// ── Shared sub-tab bar ──────────────────────────────────────────────
// ── Module toggle helpers ─────────────────────────────────────────────────────
// All four use apiService.X.toggleModule — see apiService.js for endpoints.

// ─────────────────────────────────────────────────────────────────
// OAModuleSeedPanel — reusable GoWarm sample playbook seed panel
// Used in the Playbook sub-tab of each module settings page.
// Props:
//   seedDone    bool    — whether seed has already been run
//   seeding     bool    — in-flight
//   seedMsg     string  — success/error message
//   onSeed      fn      — fires the seed request
//   color       string  — accent colour matching the module
//   playbookName string — display name
//   playbookDesc string — short description of what's seeded
// ─────────────────────────────────────────────────────────────────


// ── Generic module General tab ───────────────────────────────────────
// Reusable enable/disable toggle for any module.
// moduleKey: 'contracts' | 'prospecting' | 'handovers' | 'service'
// toggleFn: async (enabled: bool) => Promise  (calls the relevant apiService method)


// ─────────────────────────────────────────────────────────────────
// PROSPECTING MODULE — General only
// ─────────────────────────────────────────────────────────────────


// ── Org-wide campaign-delete switch ──────────────────────────────────────────
// "Campaign owners may delete their own campaigns." Reads/writes
// GET|PUT /prospecting-campaigns/org/delete-policy, persisted in
// org_action_config.campaign_settings.owner_delete_enabled. Admins/owners are
// never restricted by this switch — it gates campaign OWNERS only. Default ON.


// ── Org-wide "managers can edit subordinates' items" switch ──────────────────
// Reads/writes GET|PUT /prospecting-campaigns/org/manager-edit-policy, persisted
// in org_action_config.campaign_settings.manager_can_edit. Read by
// services/AccessPolicy.js. When OFF (default), managers are view-only on a
// subordinate's prospecting items unless the owner opts a specific item in.


// ─────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────
// HANDOVER MODULE — General | Playbook
// ─────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────
// SERVICE MODULE — General | SLA Settings | Playbook
// Wraps the existing OAServiceGeneral + OAServiceSLATiers.
// ─────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────
// AGENCY MODULE SETTINGS TAB
// ─────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────
// MODULES TAB — enable/disable product modules per org
// ─────────────────────────────────────────────────────────────────

// ═════════════════════════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────────────────────
// OAModules — enable/disable product modules + GoWarm sample playbook seeding
// ─────────────────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────
// CLM TEMPLATES TAB
// Admins upload master DOCX templates per contract type.
// Users download, fill in Word, upload back as v1.0.
// ─────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────────────────
// OAActionsAI — per-module AI enhancement toggles + export context settings
// Phase 3: AI is optional per action type, with a master toggle.
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// REPLACE the entire OAActionsAI function in OrgAdminView.js with this block.
// Find: `function OAActionsAI() {`  …  `// ═══ function OAServiceGeneral`
// Replace with everything below up to the separator comment.
// ─────────────────────────────────────────────────────────────────────────────


// ── Shared toggle switch used in OAActionsAI ──────────────────────────────────
// Add this helper just above OAActionsAI in OrgAdminView.js (or inline above).


// ─────────────────────────────────────────────────────────────────────────────
// END OF OAActionsAI REPLACEMENT BLOCK
// ─────────────────────────────────────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════


// ─────────────────────────────────────────────────────────────────────────────
// OAWorkflows — Workflow Engine tab for Org Admin
// Placed in the Data Quality nav group alongside Duplicates.
// Renders two sub-tabs:
//   Workflows   — WorkflowCanvas (org scope)
//   Exec Log    — ExecutionLog (org scope, includes Violations sub-tab)
// ─────────────────────────────────────────────────────────────────────────────


// ═════════════════════════════════════════════════════════════════════════════
// OACallSettings
//
// Sub-tab inside OAProspectingModule. Lets org admins customize:
//   - The list of call outcomes shown in the "Log call" form dropdown
//   - The edit window — how long after a call can be edited by the logger
//
// The component reads org settings from /api/org/call-settings on mount and
// PATCHes them on save. Validation surfaces server messages inline.
// ═════════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════════
// OAProspectingEscalation — per-org policy for the prospecting notification
// pipeline. Edits org_action_config.prospecting_escalation via the new
// /org/admin/prospecting-escalation endpoints (Sprint 1, Group A).
//
// What lives here:
//   - Master enable + per-channel enable (immediate, daily digest)
//   - immediate_hours threshold (when to fire the "overdue" alert)
//   - tier hours (when to loop in manager / skip-level / org admins)
//   - digest_hour_utc (when the daily summary fires for this org)
//   - delivery channels (email, in_app)
//
// What does NOT live here (intentionally):
//   - Per-user opt-outs — those live in NotificationSettings.js so reps can
//     quiet just themselves without disabling for the whole org.
//   - Manager hierarchy — that's a separate org-admin concern (org_hierarchy
//     table) and already has its own UI.
// ═════════════════════════════════════════════════════════════════════════════


// ═════════════════════════════════════════════════════════════════════════════
// OAProspectingEnrichment — per-org enrichment configuration (Sprint 3).
//
// Edits org_action_config.enrichment via /org/admin/enrichment-config:
//   - chain_company / chain_person — drag-to-reorder provider chains
//   - monthly_cap — hard stop on enrichment credits per calendar month
//
// Also surfaces:
//   - Per-provider API key entry (calls /org/admin/enrichment-credentials)
//   - Current month's usage tile (calls /org/admin/enrichment-usage)
//
// Provider keys are stored encrypted in org_credentials with purpose='enrichment'.
// ═════════════════════════════════════════════════════════════════════════════


