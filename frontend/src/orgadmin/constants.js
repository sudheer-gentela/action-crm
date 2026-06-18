/* Extracted from OrgAdminView.js — Phase 0 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Cross-cutting constants for the OrgAdmin shell, nav, and panels. */
export const STATIC_NAV_GROUPS = [
  {
    label: 'Team',
    items: [
      { id: 'members',         icon: '👥', label: 'Members' },
      { id: 'hierarchy',       icon: '🏢', label: 'Hierarchy' },
      { id: 'teams',           icon: '🏷️', label: 'Teams' },
      { id: 'invitations',     icon: '✉️', label: 'Invitations' },
      { id: 'team-dimensions', icon: '🏷️', label: 'Team Dimensions' },
    ],
  },
  {
    label: 'Sales Process',
    items: [
      { id: 'playbooks', icon: '📘', label: 'Playbooks' },
      { id: 'stages',    icon: '🏷️', label: 'Stages' },
      { id: 'org-roles', icon: '🎭', label: 'Org Roles' },
      { id: 'products',  icon: '📦', label: 'Products' },
    ],
  },
  {
    label: 'Sales Execution Insights',
    items: [
      { id: 'health',      icon: '🏥', label: 'Deal Health' },
      { id: 'icp-scoring',        icon: '🎯', label: 'ICP Scoring'        },
      { id: 'diagnostic-rules', icon: '⚙️',  label: 'Diagnostic Rules'  },
    ],
  },
  {
    label: 'Auto Action Execution',
    items: [
      { id: 'ai-agent',  icon: '🤖', label: 'AI Agent' },
      { id: 'ai-providers', icon: '🧠', label: 'AI Providers' },
      { id: 'action-ai', icon: '✨', label: 'Actions AI' },
      { id: 'ai-usage',  icon: '📊', label: 'AI Usage' },
    ],
  },
  {
    label: 'Data Quality',
    items: [
      { id: 'duplicates',     icon: '🔍', label: 'Duplicates'     },
      { id: 'workflows',      icon: '⚙️', label: 'Workflows'      },
      { id: 'email-settings', icon: '📧', label: 'Email Settings'  },
      { id: 'tracking-domain', icon: '🔗', label: 'Tracking Domain' },   // Insights/WBR Phase 7
      { id: 'custom-fields',   icon: '🧱', label: 'Custom Fields'   },
    ],
  },
  // 'Modules' group is injected here dynamically — see buildNavGroups()
  {
    label: 'General',
    items: [
      { id: 'integrations', icon: '🔌', label: 'Integrations' },
      { id: 'salesforce',   icon: '☁️', label: 'Salesforce' },
      { id: 'hubspot',      icon: '🟠', label: 'HubSpot' },
      { id: 'settings', icon: '⚙️', label: 'Org Settings' },
    ],
  },
];

export const MODULE_NAV_DEFS = [
  { moduleKey: 'prospecting', navId: 'mod-prospecting', icon: '🎯', label: 'Prospecting' },
  { moduleKey: 'contracts',   navId: 'mod-contracts',   icon: '📄', label: 'CLM' },
  { moduleKey: 'handovers',   navId: 'mod-handovers',   icon: '🤝', label: 'Handover S→I' },
  { moduleKey: 'service',     navId: 'mod-service',     icon: '🎧', label: 'Service' },
  { moduleKey: 'agency',      navId: 'mod-agency',      icon: '🏢', label: 'Agency' },
];

export const TAB_META = {
  members:       { title: 'Members',       desc: 'Manage team members, roles, and permissions' },
  hierarchy:     { title: 'Hierarchy',     desc: 'Reporting structure and team visibility' },
  teams:         { title: 'Teams',         desc: 'Organise users by market segment, role, product, geo, and motion' },
  invitations:   { title: 'Invitations',   desc: 'Invite new members to your organisation' },
  'team-dimensions': { title: 'Team Dimensions', desc: 'Configure the dimension vocabulary used for internal and customer-side teams' },
  playbooks:     { title: 'Playbooks',     desc: 'Configure deal playbooks and templates' },
  'stages':      { title: 'Stages',       desc: 'Customise your deal and prospecting pipeline stages' },
  'org-roles':   { title: 'Organization Roles', desc: 'Manage roles used across deals, prospecting, and all playbooks' },
  'products':    { title: 'Product Catalog', desc: 'Manage products and services available for deal line items' },
  health:        { title: 'Deal Health',   desc: 'Configure health scoring parameters' },
  'diagnostic-rules': { title: 'Diagnostic Rules', desc: 'Configure thresholds for nightly and real-time diagnostic alerts across all modules' },
  'icp-scoring': { title: 'ICP Scoring',   desc: 'Define your Ideal Customer Profile and scoring criteria' },
  duplicates:    { title: 'Duplicates',    desc: 'Duplicate detection rules and visibility' },
  'workflows':   { title: 'Workflows',       desc: 'Manage data-integrity workflows and standalone rules for deals, contacts, and accounts' },
  'email-settings': { title: 'Email Settings', desc: 'Configure which emails are synced and matched to deals, prospects, and accounts' },
  'tracking-domain': { title: 'Tracking Domain', desc: 'Per-customer CNAME domain for email open/click tracking — one DNS record on your domain keeps tracked links aligned with your sending reputation' },
  'wf-log':      { title: 'Execution Log', desc: 'Workflow execution history and open violations' },
  'ai-agent':    { title: 'AI Agent',      desc: 'Agentic framework settings and token usage' },
  'ai-providers': { title: 'AI Providers', desc: 'Choose AI provider and model, manage API keys, and set user policy for your organisation' },
  modules:             { title: 'Modules',                           desc: 'Enable or disable product modules for your organisation' },
  'mod-prospecting':   { title: 'Prospecting',                       desc: 'Prospecting module settings' },
  'mod-contracts':     { title: 'Contract Lifecycle Management',      desc: 'CLM module settings — eSign configuration and contract templates' },
  'mod-handovers':     { title: 'Sales → Implementation Handover',   desc: 'Handover module settings' },
  'mod-service':       { title: 'Customer Support & Service',         desc: 'Service module settings — SLA tiers and general configuration' },
  'mod-agency':        { title: 'Agency Client Management',           desc: 'Agency module settings — client portal and team configuration' },
  integrations:  { title: 'Integrations',  desc: 'Manage org-wide email, calendar, and cloud connections' },
  'integrations-overview':{ title: 'Email & Calendar', desc: 'Manage Microsoft and Google connections for your team' },
  'integrations-meeting': { title: 'Meeting & Transcript Integrations', desc: 'Configure transcript providers — Zoom, Teams, Fireflies, and more' },
  salesforce:    { title: 'Salesforce Integration', desc: 'Sync contacts, accounts, deals, and leads with Salesforce. Configure stage/field mapping and write-back settings.' },
  hubspot:       { title: 'HubSpot Integration',    desc: 'Sync companies, contacts, and deals with HubSpot. Configure stage and field mapping.' },
  settings:      { title: 'Org Settings',  desc: 'Organisation name, plan, and preferences' },

};

export const MODULE_COLORS = {
  deals:        '#6366f1',
  prospecting:  '#0F9D8E',
  other:        '#9ca3af',
};

export const CALL_TYPE_LABELS = {
  action_generation:          'Action Generation',
  ai_enhancement:             'AI Enhancement',
  email_analysis:             'Email Analysis',
  deal_health_check:          'Deal Health Check',
  context_suggest:            'Context Suggest',
  agent_proposal:             'Agent Proposal',
  prospecting_research:       'Prospect Research',
  prospecting_research_account: 'Account Research',
  prospecting_draft:          'Draft Email',
};

export const ROLE_META = {
  owner:  { label: 'Owner',  color: 'purple', icon: '👑', desc: 'Full control — org settings, billing, all data. Cannot be removed.' },
  admin:  { label: 'Admin',  color: 'blue',   icon: '🔑', desc: 'Manage members, invitations, integrations, and all CRM data.' },
  member: { label: 'Member', color: 'green',  icon: '👤', desc: 'Full CRM access — deals, contacts, emails, AI. Cannot manage users.' },
  viewer: { label: 'Viewer', color: 'grey',   icon: '👁',  desc: 'Read-only access to all CRM data. Cannot create or edit records.' },
};

export const HIERARCHY_ROLES = [
  { value: 'vp',       label: 'VP',       color: '#7c3aed' },
  { value: 'director', label: 'Director', color: '#2563eb' },
  { value: 'manager',  label: 'Manager',  color: '#059669' },
  { value: 'rep',      label: 'Rep',      color: '#64748b' },
];

export const DIMENSION_COLORS = {
  market_segment: '#7c3aed',
  seller_role:    '#2563eb',
  product_line:   '#059669',
  geo:            '#d97706',
  motion:         '#dc2626',
};

/* Promoted from OrgAdminView.js — Phase 1 (used across people panels). */
export const DEPARTMENT_OPTIONS = [
  { value: '',                 label: '— No department —' },
  { value: 'sales',            label: 'Sales' },
  { value: 'legal',            label: 'Legal' },
  { value: 'implementation',   label: 'Implementation' },
  { value: 'customer_support', label: 'Customer Support' },
  { value: 'finance',          label: 'Finance' },
  { value: 'executive',        label: 'Executive' },
];

export const DEPARTMENT_META = {
  sales:            { label: 'Sales',            color: '#2563eb' },
  legal:            { label: 'Legal',            color: '#7c3aed' },
  implementation:   { label: 'Implementation',   color: '#059669' },
  customer_support: { label: 'Customer Support', color: '#d97706' },
  finance:          { label: 'Finance',          color: '#dc2626' },
  executive:        { label: 'Executive',        color: '#0891b2' },
};
