/**
 * apiService.js — DROP-IN REPLACEMENT
 *
 * Added in this version:
 *   prospectingActions.outreachSend()   — new send endpoint
 *   prospectingSenders.*                — sender account management
 *   outreachLimits.*                    — org ceiling GET/PUT
 *   prospectingInbox.*                  — unified inbox + stats
 *   prospects.bulkImport()             — CSV bulk import
 *   prospects.research()               — AI research
 *   prospects.getEmails()              — email history per prospect
 *
 * Everything else is IDENTICAL to the previous version.
 */

import axios from 'axios';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001/api';
const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001/api';

const getAuthHeaders = () => {
  const token = localStorage.getItem('token');
  return {
    'Content-Type': 'application/json',
    ...(token && { 'Authorization': `Bearer ${token}` })
  };
};

const api = axios.create({ baseURL: API_URL });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export const apiService = {
  accounts: {
    getAll: (scope = 'mine') => api.get(`/accounts?scope=${scope}`),
    getById: (id) => api.get(`/accounts/${id}`),
    create: (data) => api.post('/accounts', data),
    update: (id, data) => api.put(`/accounts/${id}`, data),
    delete: (id) => api.delete(`/accounts/${id}`),
    getDuplicates: () => api.get('/accounts/duplicates'),
    merge: (keepId, removeId, fieldOverrides = {}) => api.post('/accounts/merge', { keepId, removeId, fieldOverrides }),
    bulk: (rows) => api.post('/accounts/bulk', { rows }),
  },

  contacts: {
    getAll: (scope = 'mine') => api.get(`/contacts?scope=${scope}`),
    getById: (id) => api.get(`/contacts/${id}`),
    getByAccount: (accountId) => api.get(`/contacts?account_id=${accountId}`),
    create: (data) => api.post('/contacts', data),
    update: (id, data) => api.put(`/contacts/${id}`, data),
    delete: (id) => api.delete(`/contacts/${id}`),
    getDuplicates: () => api.get('/contacts/duplicates'),
    merge: (keepId, removeId, fieldOverrides = {}) => api.post('/contacts/merge', { keepId, removeId, fieldOverrides }),
    bulk: (rows) => api.post('/contacts/bulk', { rows }),
  },

  deals: {
    getAll: (scope = 'mine') => api.get(`/deals?scope=${scope}`),
    getById: (id) => api.get(`/deals/${id}`),
    getByAccount: (accountId) => api.get(`/deals?account_id=${accountId}`),
    getPlaybookGuide: (id) => api.get(`/deals/${id}/playbook-guide`),
    create: (data) => api.post('/deals', data),
    update: (id, data) => api.put(`/deals/${id}`, data),
    delete: (id) => api.delete(`/deals/${id}`),
    bulk: (rows) => api.post('/deals/bulk', { rows }),
    generateActions: (id, data) => api.post(`/deals/${id}/generate-actions`, data),

  },

  emails: {
    getAll: () => api.get('/emails'),
    getById: (id) => api.get(`/emails/${id}`),
    getByContact: (contactId) => api.get(`/emails?contact_id=${contactId}`),
    getByDeal: (dealId) => api.get(`/emails?deal_id=${dealId}`),
    create: (data) => api.post('/emails', data),
    send: (data) => {
      if (typeof data === 'number' || typeof data === 'string') return api.post(`/emails/${data}/send`);
      return api.post('/emails/compose', data);
    },
    compose: (data) => api.post('/emails/compose', data),
    delete: (id) => api.delete(`/emails/${id}`)
  },

  meetings: {
    getAll: () => api.get('/meetings'),
    getById: (id) => api.get(`/meetings/${id}`),
    getByDeal: (dealId) => api.get(`/meetings?deal_id=${dealId}`),
    create: (data) => api.post('/meetings', data),
    update: (id, data) => api.put(`/meetings/${id}`, data),
    delete: (id) => api.delete(`/meetings/${id}`)
  },

  actions: {
    getAll: (params = {}) => { const qs = new URLSearchParams(params).toString(); return api.get(`/actions${qs ? '?' + qs : ''}`); },
    getById: (id) => api.get(`/actions/${id}`),
    create: (data) => api.post('/actions', data),
    update: (id, data) => api.put(`/actions/${id}`, data),
    delete: (id) => api.delete(`/actions/${id}`),
    updateStatus: (id, status) => api.patch(`/actions/${id}/status`, { status }),
    complete: (id) => api.patch(`/actions/${id}/complete`),
    snooze: (id, reason, duration) => api.patch(`/actions/${id}/snooze`, { reason, duration }),
    unsnooze: (id) => api.patch(`/actions/${id}/unsnooze`),
    generate: (dealId = null) => api.post('/actions/generate', dealId ? { dealId } : {}),
    getConfig: () => api.get('/actions/config'),
    updateConfig: (data) => api.put('/actions/config', data),
    getSuggestions: (actionId) => api.get(`/actions/${actionId}/suggestions`),
    acceptSuggestion: (suggestionId) => api.post(`/actions/suggestions/${suggestionId}/accept`),
    dismissSuggestion: (suggestionId) => api.post(`/actions/suggestions/${suggestionId}/dismiss`),
  },

  transcripts: {
    getAll: () => api.get('/transcripts'),
    getById: (id) => api.get(`/transcripts/${id}`),
    upload: (formData) => axios.post(`${API_URL}/transcripts/upload`, formData, { headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` } }),
    analyze: (id) => api.post(`/transcripts/${id}/analyze`),
    delete: (id) => api.delete(`/transcripts/${id}`)
  },

  health: {
    scoreDeal: (id) => api.post(`/deals/${id}/score`),
    scoreAll: () => api.post('/deals/score-all'),
    updateSignals: (id, signals) => api.patch(`/deals/${id}/signals`, signals),
    signalOverride: (id, signalKey, value, managerOverride = false) => api.patch(`/deals/${id}/signal-override`, { signalKey, value, managerOverride }),
  },

  healthConfig: {
    get: () => api.get('/health-config'),
    save: (data) => api.put('/health-config', data),
  },

  competitors: {
    getAll: () => api.get('/competitors'),
    create: (data) => api.post('/competitors', data),
    update: (id, data) => api.put(`/competitors/${id}`, data),
    delete: (id) => api.delete(`/competitors/${id}`),
  },

  playbook: {
    get: () => api.get('/playbook'),
    save: (data) => api.put('/playbook', data),
  },

  playbooks: {
    getAll: () => api.get('/playbooks'),
    getDefault: () => api.get('/playbooks/default'),
    getById: (id) => api.get(`/playbooks/${id}`),
    create: (data) => api.post('/playbooks', data),
    update: (id, data) => api.put(`/playbooks/${id}`, data),
    setDefault: (id) => api.post(`/playbooks/${id}/set-default`),
    delete: (id) => api.delete(`/playbooks/${id}`),
  },

  dealStages: {
    getAll: () => api.get('/deal-stages'),
    getActive: () => api.get('/deal-stages/active'),
    create: (data) => api.post('/deal-stages', data),
    update: (id, data) => api.put(`/deal-stages/${id}`, data),
    delete: (id) => api.delete(`/deal-stages/${id}`),
  },

  dealContacts: {
    getByDeal: (dealId) => api.get(`/deals/${dealId}/contacts`),
    add: (dealId, contactId, role) => api.post(`/deals/${dealId}/contacts`, { contactId, role }),
    updateRole: (dealId, contactId, role) => api.put(`/deals/${dealId}/contacts/${contactId}`, { role }),
    remove: (dealId, contactId) => api.delete(`/deals/${dealId}/contacts/${contactId}`),
  },

  prompts: {
    get: () => api.get('/prompts'),
    save: (data) => api.put('/prompts', data),
    reset: (key) => api.delete(`/prompts/${key}`),
  },

  agent: {
    getProposals: (params = {}) => {
      const q = new URLSearchParams();
      if (params.status) q.set('status', params.status);
      if (params.proposalType) q.set('proposalType', params.proposalType);
      if (params.dealId) q.set('dealId', params.dealId);
      if (params.limit) q.set('limit', params.limit);
      const qs = q.toString();
      return api.get(`/agent/proposals${qs ? '?' + qs : ''}`);
    },
    getCount: () => api.get('/agent/proposals/count'),
    getById: (id) => api.get(`/agent/proposals/${id}`),
    approve: (id, body = {}) => api.post(`/agent/proposals/${id}/approve`, body),
    reject: (id, body = {}) => api.post(`/agent/proposals/${id}/reject`, body),
    editPayload: (id, payload) => api.patch(`/agent/proposals/${id}/payload`, { payload }),
    bulkApprove: (ids) => api.post('/agent/proposals/bulk-approve', { proposalIds: ids }),
    bulkReject: (ids, reason) => api.post('/agent/proposals/bulk-reject', { proposalIds: ids, reason }),
    getStatus: () => api.get('/agent/status'),
    getDealProposals: (dealId) => api.get(`/agent/deals/${dealId}/proposals`),
    getTokenUsage: (days = 30) => api.get(`/agent/token-usage?days=${days}`),
    admin: {
      updateSettings: (settings) => api.patch('/agent/admin/settings', settings),
      getStats: (days = 30) => api.get(`/agent/admin/stats?days=${days}`),
      getTokenUsage: (days = 30) => api.get(`/agent/admin/token-usage?days=${days}`),
    },
  },

  straps: {
    getActive:    (entityType, entityId)        => api.get(`/straps/${entityType}/${entityId}`),
    getHistory:   (entityType, entityId)        => api.get(`/straps/${entityType}/${entityId}/history`),
    generate:     (entityType, entityId, useAI) => api.post(`/straps/${entityType}/${entityId}/generate`, { useAI }),
    override:     (entityType, entityId, data)  => api.post(`/straps/${entityType}/${entityId}/override`, data),
    getById:      (strapId)                     => api.get(`/straps/${strapId}`),
    resolve:      (strapId, data)               => api.put(`/straps/${strapId}/resolve`, data),
    reassess:     (strapId)                     => api.put(`/straps/${strapId}/reassess`),
    getAllActive:  (scope = 'mine', filters = {}) => {
      const params = new URLSearchParams({ scope, ...filters });
      return api.get(`/actions/straps?${params.toString()}`);
    },
    update:       (strapId, data)               => api.patch(`/actions/straps/${strapId}`, data),
    getProgress:  (strapId)                     => api.get(`/actions/straps/${strapId}/progress`),
  },

  superAdmin: {
    getStats: () => api.get('/super/stats'),
    getOrgs: (params = {}) => api.get('/super/orgs', { params }),
    getOrg: (orgId) => api.get(`/super/orgs/${orgId}`),
    createOrg: (data) => api.post('/super/orgs', data),
    updateOrg: (orgId, data) => api.patch(`/super/orgs/${orgId}`, data),
    suspendOrg: (orgId, data) => api.post(`/super/orgs/${orgId}/suspend`, data),
    impersonateOrg: (orgId) => api.post(`/super/orgs/${orgId}/impersonate`),
    addUserToOrg: (orgId, data) => api.post(`/super/orgs/${orgId}/users`, data),
    createUserForOrg: (orgId, data) => api.post(`/super/orgs/${orgId}/users/create`, data),
    updateUserInOrg: (orgId, userId, data) => api.patch(`/super/orgs/${orgId}/users/${userId}`, data),
    removeUserFromOrg: (orgId, userId) => api.delete(`/super/orgs/${orgId}/users/${userId}`),
    inviteUserToOrg: (orgId, data) => api.post(`/super/orgs/${orgId}/invites`, data),
    getInvites: (orgId) => api.get(`/super/orgs/${orgId}/invites`),
    cancelInvite: (orgId, inviteId) => api.delete(`/super/orgs/${orgId}/invites/${inviteId}`),
    getAdmins: () => api.get('/super/admins'),
    grantAdmin: (data) => api.post('/super/admins', data),
    revokeAdmin: (userId) => api.delete(`/super/admins/${userId}`),
    getAuditLog: (params = {}) => api.get('/super/audit', { params }),

    // ── Module provisioning ─────────────────────────────────────────────────
    // modules: { prospecting: true, contracts: false, ... }
    getOrgModules:    (orgId)          => api.get(`/super/orgs/${orgId}/modules`),
    updateOrgModules: (orgId, modules) => api.patch(`/super/orgs/${orgId}/modules`, { modules }),

    // ── Workflow engine (platform-scoped) ───────────────────────────────────
    getWorkflows:        ()                  => api.get('/super/workflows'),
    createWorkflow:      (data)              => api.post('/super/workflows', data),
    updateWorkflow:      (id, data)          => api.patch(`/super/workflows/${id}`, data),
    deleteWorkflow:      (id)               => api.delete(`/super/workflows/${id}`),

    getWorkflowSteps:    (id)               => api.get(`/super/workflows/${id}/steps`),
    createWorkflowStep:  (id, data)         => api.post(`/super/workflows/${id}/steps`, data),
    updateWorkflowStep:  (id, stepId, data) => api.patch(`/super/workflows/${id}/steps/${stepId}`, data),
    deleteWorkflowStep:  (id, stepId)       => api.delete(`/super/workflows/${id}/steps/${stepId}`),

    getRules:            (params)           => api.get('/super/rules', { params }),
    createRule:          (data)             => api.post('/super/rules', data),
    updateRule:          (id, data)         => api.patch(`/super/rules/${id}`, data),
    deleteRule:          (id)               => api.delete(`/super/rules/${id}`),

    getExecutions:       (params)           => api.get('/super/executions', { params }),

    // Platform settings (super admin only)
    getPlatformSetting:    (key)        => api.get(`/super/platform-settings/${key}`),
    updatePlatformSetting: (key, value) => api.patch(`/super/platform-settings/${key}`, { value }),

  },

  prospects: {
    toggleModule: (enabled) => api.patch('/org/admin/module/prospecting', { enabled }),
    getAll: (scope = 'mine', params = {}) => { const qs = new URLSearchParams({ scope, ...params }).toString(); return api.get(`/prospects?${qs}`); },
    getById: (id) => api.get(`/prospects/${id}`),
    create: (data) => api.post('/prospects', data),
    update: (id, data) => api.put(`/prospects/${id}`, data),
    delete: (id) => api.delete(`/prospects/${id}`),
    updateStage: (id, stage, reason) => api.post(`/prospects/${id}/stage`, { stage, reason }),
    disqualify: (id, reason) => api.post(`/prospects/${id}/disqualify`, { reason }),
    nurture: (id, nurtureUntil, reason) => api.post(`/prospects/${id}/nurture`, { nurtureUntil, reason }),
    convert: (id, data) => api.post(`/prospects/${id}/convert`, data),
    linkAccount: (id, accountId) => api.post(`/prospects/${id}/link-account`, { accountId }),
    linkContact: (id, contactId) => api.post(`/prospects/${id}/link-contact`, { contactId }),
    getActivities: (id) => api.get(`/prospects/${id}/activities`),
    getPipelineSummary: (scope = 'mine') => api.get(`/prospects/pipeline/summary?scope=${scope}`),
    getContext: (id) => api.get(`/prospect-context/${id}`),
    scoreIcp: (id) => api.post(`/prospect-context/${id}/score`),
    scoreAllIcp: () => api.post('/prospect-context/score-all'),
    getIcpConfig: () => api.get('/prospect-context/icp-config/current'),
    updateIcpConfig: (config) => api.put('/prospect-context/icp-config/current', config),
    getIcpFields: () => api.get('/prospect-context/icp-config/fields'),
    getIcpDefaults: () => api.get('/prospect-context/icp-config/defaults'),
    // ── NEW ──────────────────────────────────────────────────────────────────
    bulkImport: (prospects, source = 'csv_import') => api.post('/prospects/bulk', { prospects, source }),
    research: (id) => api.post(`/prospects/${id}/research`),
    getEmails: (id) => api.get(`/prospects/${id}/emails`),
    generateActions: (id, data) => api.post(`/prospects/${id}/generate-actions`, data),
  },

  prospectingActions: {
    getAll: (params = {}) => { const qs = new URLSearchParams(params).toString(); return api.get(`/prospecting-actions${qs ? '?' + qs : ''}`); },
    getById: (id) => api.get(`/prospecting-actions/${id}`),
    create: (data) => api.post('/prospecting-actions', data),
    update: (id, data) => api.put(`/prospecting-actions/${id}`, data),
    updateStatus: (id, status, outcome) => api.patch(`/prospecting-actions/${id}/status`, { status, outcome }),
    snooze: (id, duration, reason) => api.patch(`/prospecting-actions/${id}/snooze`, { duration, reason }),
    unsnooze: (id) => api.patch(`/prospecting-actions/${id}/unsnooze`),
    execute: (id, outcome, notes) => api.post(`/prospecting-actions/${id}/execute`, { outcome, notes }),
    delete: (id) => api.delete(`/prospecting-actions/${id}`),
    // ── NEW ──────────────────────────────────────────────────────────────────
    // Send an actual email via a prospecting sender account.
    // data: { prospectId, subject, body, toAddress, senderAccountId?, actionId? }
    outreachSend: (data) => api.post('/prospecting-actions/outreach-send', data),
    // AI draft email — returns { subject, body, tone, confidence, personalisationHooks }
    draftEmail:   (prospectId) => api.post('/prospecting-actions/outreach/draft-email', { prospectId }),
  },

  // ── NEW: Prospecting sender accounts ──────────────────────────────────────
  // Manages Gmail / Outlook accounts used specifically for outreach.
  // Tokens are never returned to the frontend.
  prospectingSenders: {
    getAll: () => api.get('/prospecting-senders'),
    getOrgLimits: () => api.get('/prospecting-senders/org-limits'),
    getConnectUrl: (provider, label) => api.get(`/prospecting-senders/connect-url?provider=${provider}${label ? '&label=' + encodeURIComponent(label) : ''}`),
    update: (id, data) => api.patch(`/prospecting-senders/${id}`, data),
    remove: (id) => api.delete(`/prospecting-senders/${id}`),
  },

  // ── NEW: Org outreach limits (admin only) ─────────────────────────────────
  outreachLimits: {
    get: () => api.get('/org/outreach-limits'),
    update: (data) => api.put('/org/outreach-limits', data),
  },

  // ── NEW: Prospecting inbox ─────────────────────────────────────────────────
  prospectingInbox: {
    // params: { scope, direction, from, to, limit, offset }
    get: (params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return api.get(`/prospecting/inbox${qs ? '?' + qs : ''}`);
    },
    // params: { scope, from, to }
    getStats: (params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return api.get(`/prospecting/inbox/stats${qs ? '?' + qs : ''}`);
    },
  },

  accountProspecting: {
    getOverview: (accountId) => api.get(`/accounts/${accountId}/prospecting`),
    getCoverage: (accountId, playbookId) => api.get(`/accounts/${accountId}/coverage?playbookId=${playbookId}`),
  },

  unifiedActions: {
    getAll: (scope = 'mine', source = 'all') => api.get(`/actions/unified?scope=${scope}&source=${source}`),
  },

  userPreferences: {
    get:    ()     => api.get('/users/me/preferences'),
    update: (data) => api.patch('/users/me/preferences', data),
  },

  orgAdmin: {
    getProfile: () => api.get('/org/admin/profile'),
    updateProfile: (data) => api.patch('/org/admin/profile', data),
    getStats: () => api.get('/org/admin/stats'),
    getMembers: () => api.get('/org/admin/members'),
    updateMember: (userId, data) => api.patch(`/org/admin/members/${userId}`, data),
    removeMember: (userId) => api.delete(`/org/admin/members/${userId}`),
    getInvitations: () => api.get('/org/admin/invitations'),
    sendInvitation: (data) => api.post('/org/admin/invitations', data),
    cancelInvitation: (id) => api.delete(`/org/admin/invitations/${id}`),
    getDuplicateSettings: () => api.get('/org/admin/duplicate-settings'),
    updateDuplicateSettings: (data) => api.patch('/org/admin/duplicate-settings', data),
    getIntegrations: () => api.get('/org/admin/integrations'),
    updateIntegration: (type, data) => api.patch(`/org/admin/integrations/${type}`, data),
    getHierarchy: () => api.get('/org/admin/hierarchy'),
    getMyTeam: () => api.get('/org/admin/hierarchy/my-team'),
    updateHierarchy: (userId, data) => api.put(`/org/admin/hierarchy/${userId}`, data),
    bulkUpdateHierarchy: (entries) => api.post('/org/admin/hierarchy/bulk', { entries }),
    removeFromHierarchy: (userId) => api.delete(`/org/admin/hierarchy/${userId}`),
    removeDottedLine: (userId, managerId) => api.delete(`/org/admin/hierarchy/${userId}/dotted/${managerId}`),
    importHierarchy: async (file) => {
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch(`${API_BASE_URL}/org/admin/hierarchy/import`, {
        method: 'POST',
        headers: getAuthHeaders(), // no Content-Type — browser sets multipart boundary automatically
        body: formData,
      });
      if (!response.ok) {
        const e = await response.json().catch(() => ({}));
        throw new Error(e.error?.message || 'Failed to import hierarchy CSV');
      }
      return response.json();
    },
    getPlaybookTypes: () => api.get('/org/admin/playbook-types'),
    createPlaybookType: (data) => api.post('/org/admin/playbook-types', data),
    updatePlaybookType: (key, data) => api.put(`/org/admin/playbook-types/${key}`, data),
    deletePlaybookType: (key) => api.delete(`/org/admin/playbook-types/${key}`),
    getTeamDimensions: () => api.get('/org/admin/team-dimensions'),
    updateTeamDimensions: (dimensions) => api.put('/org/admin/team-dimensions', { dimensions }),
    getTeams: (dimension) => api.get(`/org/admin/teams${dimension ? '?dimension=' + dimension : ''}`),
    createTeam: (data) => api.post('/org/admin/teams', data),
    updateTeam: (id, data) => api.put(`/org/admin/teams/${id}`, data),
    deleteTeam: (id) => api.delete(`/org/admin/teams/${id}`),
    getTeamMemberships: () => api.get('/org/admin/team-memberships'),
    setTeamMembership: (userId, teamId) => api.post('/org/admin/team-memberships', { userId, teamId }),
    removeTeamMembership: (userId, teamId) => api.delete(`/org/admin/team-memberships/${userId}/${teamId}`),
    getUserTeamProfile: (userId) => api.get(`/org/admin/team-profile/${userId}`),
    bulkAssignTeams: (assignments) => api.post('/org/admin/team-memberships/bulk', { assignments }),

    // Workflows (org-scoped + inherited platform)
    getWorkflows:       ()                  => api.get('/org/admin/workflows'),
    createWorkflow:     (data)              => api.post('/org/admin/workflows', data),
    updateWorkflow:     (id, data)          => api.patch(`/org/admin/workflows/${id}`, data),
    deleteWorkflow:     (id)               => api.delete(`/org/admin/workflows/${id}`),

    // Workflow steps
    getWorkflowSteps:   (id)               => api.get(`/org/admin/workflows/${id}/steps`),
    createWorkflowStep: (id, data)         => api.post(`/org/admin/workflows/${id}/steps`, data),
    updateWorkflowStep: (id, stepId, data) => api.patch(`/org/admin/workflows/${id}/steps/${stepId}`, data),
    deleteWorkflowStep: (id, stepId)       => api.delete(`/org/admin/workflows/${id}/steps/${stepId}`),

    // Standalone rules (org-scoped + inherited platform)
    getRules:           (params)           => api.get('/org/admin/rules', { params }),
    createRule:         (data)             => api.post('/org/admin/rules', data),
    updateRule:         (id, data)         => api.patch(`/org/admin/rules/${id}`, data),
    deleteRule:         (id)               => api.delete(`/org/admin/rules/${id}`),

    // Execution history + violations
    getExecutions:      (params)           => api.get('/org/admin/executions', { params }),
    getViolations:      (params)           => api.get('/org/admin/violations', { params }),

    // Email filter settings
    getEmailSettings:              ()           => api.get('/org/admin/email-settings'),
    updateEmailSettings:           (data)       => api.patch('/org/admin/email-settings', data),
    deriveAccountDomains:          ()           => api.post('/org/admin/email-settings/derive-account-domains'),
    applyAccountDomains:           (updates)    => api.patch('/org/admin/email-settings/apply-account-domains', { updates }),

    getEmailFilterLog:   (params = {}) => api.get('/org/admin/email-filter-log', { params }),
    purgeEmailFilterLog: ()             => api.delete('/org/admin/email-filter-log'),
  },

  products: {
    getAll:      (status) => api.get(`/products${status ? '?status=' + status : ''}`),
    getById:     (id) => api.get(`/products/${id}`),
    create:      (data) => api.post('/products', data),
    update:      (id, data) => api.put(`/products/${id}`, data),
    delete:      (id) => api.delete(`/products/${id}`),
    getGroups:   () => api.get('/products/groups'),
    createGroup: (data) => api.post('/products/groups', data),
    updateGroup: (id, data) => api.put(`/products/groups/${id}`, data),
    deleteGroup: (id) => api.delete(`/products/groups/${id}`),
  },

  dealProducts: {
    getByDeal: (dealId) => api.get(`/products/deals/${dealId}/items`),
    add:       (dealId, data) => api.post(`/products/deals/${dealId}/items`, data),
    update:    (dealId, itemId, data) => api.put(`/products/deals/${dealId}/items/${itemId}`, data),
    remove:    (dealId, itemId) => api.delete(`/products/deals/${dealId}/items/${itemId}`),
    syncValue: (dealId) => api.post(`/products/deals/${dealId}/items/sync-value`),
  },

  teamNotifications: {
    getPreferences:   () => api.get('/team-notifications/preferences'),
    updatePreferences:(data) => api.patch('/team-notifications/preferences', data),
    getOrgMembers:    () => api.get('/team-notifications/org-members'),
    triggerImmediate: () => api.post('/team-notifications/trigger/immediate'),
    triggerDigest:    () => api.post('/team-notifications/trigger/digest'),
  },

  notifications: {
    getAll: (params = {}) => {
      const qs = new URLSearchParams();
      if (params.unread) qs.set('unread', 'true');
      if (params.limit)  qs.set('limit',  params.limit);
      if (params.offset) qs.set('offset', params.offset);
      return api.get(`/team-notifications?${qs.toString()}`);
    },
    markRead:    (ids = []) => api.patch('/team-notifications/read', { ids }),
    markOneRead: (id) => api.patch(`/team-notifications/${id}/read`),
  },

  orgHierarchy: {
    getContactTree:         (accountId) => api.get(`/org-hierarchy/contacts/account/${accountId}`),
    getContactPosition:     (contactId) => api.get(`/org-hierarchy/contacts/${contactId}/position`),
    setReportsTo:           (contactId, reportsToContactId) => api.patch(`/org-hierarchy/contacts/${contactId}/reports-to`, { reportsToContactId }),
    updateContactMeta:      (contactId, data) => api.patch(`/org-hierarchy/contacts/${contactId}/meta`, data),
    getAccountHierarchy:    (accountId) => api.get(`/org-hierarchy/accounts/${accountId}`),
    addAccountRelationship: (parentAccountId, childAccountId, relationshipType) => api.post('/org-hierarchy/accounts/relationship', { parentAccountId, childAccountId, relationshipType }),
    removeAccountRelationship: (parentAccountId, childAccountId) => api.delete(`/org-hierarchy/accounts/relationship?parentAccountId=${parentAccountId}&childAccountId=${childAccountId}`),
    setVisibility:          (visibility) => api.patch('/org-hierarchy/settings/visibility', { visibility }),
  },

  // ══════════════════════════════════════════════════════════
  // CLM — Contract Lifecycle Management
  // ══════════════════════════════════════════════════════════
  contracts: {
    toggleModule:       (enabled) => api.patch('/contracts/admin/module', { enabled }),
    getWorkflowConfig:  () => api.get('/contracts/admin/workflow-config'),
    saveWorkflowConfig: (data) => api.put('/contracts/admin/workflow-config', data),
    getApprovalConfig:  () => api.get('/contracts/admin/approval-config'),
    saveApprovalConfig: (rules) => api.put('/contracts/admin/approval-config', { rules }),
    getLegalQueue:    () => api.get('/contracts/legal/queue'),
    getLegalAssigned: () => api.get('/contracts/legal/assigned'),
    getPendingApprovals: () => api.get('/contracts/approvals/pending'),
    decideApproval:      (id, decision, note) => api.post(`/contracts/approvals/${id}/decide`, { decision, note }),
    getAll:   (params = {}) => { const qs = new URLSearchParams(params).toString(); return api.get(`/contracts${qs ? '?' + qs : ''}`); },
    getById:  (id) => api.get(`/contracts/${id}`),
    create:   (data) => api.post('/contracts', data),
    update:   (id, data) => api.put(`/contracts/${id}`, data),
    delete:   (id) => api.delete(`/contracts/${id}`),
    getVersions:   (id) => api.get(`/contracts/${id}/versions`),
    uploadVersion: (id, data) => api.post(`/contracts/${id}/versions`, data),
    submitForLegal: (id, data) => api.post(`/contracts/${id}/submit-legal`, data),
    pickUp:   (id) => api.post(`/contracts/${id}/pick-up`),
    reassign: (id, newAssigneeId) => api.post(`/contracts/${id}/reassign`, { newAssigneeId }),
    handoffTo: (id, toSubStatus, note) => api.post(`/contracts/${id}/handoff`, { toSubStatus, note }),
    returnToSales: (id) => api.post(`/contracts/${id}/return-sales`),
    resubmit:      (id) => api.post(`/contracts/${id}/resubmit`),
    sendForSignature:  (id) => api.post(`/contracts/${id}/send-signature`),
    markSigned:        (id) => api.post(`/contracts/${id}/mark-signed`),
    activate:          (id) => api.post(`/contracts/${id}/activate`),
    recall:            (id, data) => api.post(`/contracts/${id}/recall`, data),
    void:              (id, data) => api.post(`/contracts/${id}/void`, data),
    amend:             (id) => api.post(`/contracts/${id}/amend`),
    startApproval:     (id) => api.post(`/contracts/${id}/start-approval`),
    terminate:      (id, data) => api.post(`/contracts/${id}/terminate`, data),
    cancel:         (id, data) => api.post(`/contracts/${id}/cancel`, data),
    confirmBooking: (id) => api.post(`/contracts/${id}/confirm-booking`),
    legalSendSignature:     (id) => api.post(`/contracts/${id}/legal-send-signature`),
    markCustomerSigning:    (id, data) => api.post(`/contracts/${id}/customer-signing`, data),
    uploadExecutedDocument: (id, data) => api.post(`/contracts/${id}/upload-executed`, data),
    bulkSubmitLegal: (contractIds, assigneeUserId) =>
      api.post('/contracts/bulk-submit-legal', { contractIds, assigneeUserId }),
    getHierarchy: (id) => api.get(`/contracts/${id}/hierarchy`),
    getLegalMembers: () => api.get('/contracts/legal/members'),
    getTemplates:       () => api.get('/contracts/templates'),
    getTemplatesByType: (contractType) => api.get(`/contracts/templates/by-type/${contractType}`),
    createTemplate:     (data) => api.post('/contracts/templates', data),
    updateTemplate:     (id, data) => api.put(`/contracts/templates/${id}`, data),
    deleteTemplate:     (id) => api.delete(`/contracts/templates/${id}`),
    addSignatory:    (id, data) => api.post(`/contracts/${id}/signatories`, data),
    removeSignatory: (id, sigId) => api.delete(`/contracts/${id}/signatories/${sigId}`),
    addNote: (id, note) => api.post(`/contracts/${id}/notes`, { note }),
    generateActions: (id, data) => api.post(`/contracts/${id}/generate-actions`, data),
  },

  // ══════════════════════════════════════════════════════════
  // Team Dimensions  (Phase 3 — Handover module)
  // ══════════════════════════════════════════════════════════
  teamDimensions: {
    list:   (params = {}) => {
      const qs = new URLSearchParams();
      if (params.appliesTo)          qs.set('appliesTo',       params.appliesTo);
      if (params.activeOnly === false) qs.set('includeInactive', 'true');
      return api.get(`/team-dimensions${qs.toString() ? '?' + qs : ''}`);
    },
    create: (data)           => api.post('/team-dimensions', data),
    update: (id, data)       => api.put(`/team-dimensions/${id}`, data),
    toggle: (id, isActive)   => api.patch(`/team-dimensions/${id}/toggle`, { isActive }),
    remove: (id)             => api.delete(`/team-dimensions/${id}`),
  },

  // ══════════════════════════════════════════════════════════
  // Account Teams  (Phase 3 — Handover module)
  // ══════════════════════════════════════════════════════════
  accountTeams: {
    listByAccount: (accountId, params = {}) => {
      const qs = new URLSearchParams({ accountId, ...params }).toString();
      return api.get(`/account-teams?${qs}`);
    },
    listByContact: (contactId) => api.get(`/account-teams/contact/${contactId}`),
    create:        (data)      => api.post('/account-teams', data),
    update:        (id, data)  => api.put(`/account-teams/${id}`, data),
    delete:        (id)        => api.delete(`/account-teams/${id}`),
    addMember:     (teamId, data)       => api.post(`/account-teams/${teamId}/members`, data),
    updateMember:  (teamId, memberId, data) => api.put(`/account-teams/${teamId}/members/${memberId}`, data),
    removeMember:  (teamId, memberId)   => api.delete(`/account-teams/${teamId}/members/${memberId}`),
  },

  // ══════════════════════════════════════════════════════════
  // Sequences — Prospecting Phase 3
  // ══════════════════════════════════════════════════════════
  sequences: {
    // ── Library ────────────────────────────────────────────────────────────
    getAll:  ()           => api.get('/sequences'),
    getById: (id)         => api.get(`/sequences/${id}`),
    create:  (data)       => api.post('/sequences', data),
    update:  (id, data)   => api.put(`/sequences/${id}`, data),
    archive: (id)         => api.delete(`/sequences/${id}`),
    // ── Steps ──────────────────────────────────────────────────────────────
    addStep:     (seqId, data)          => api.post(`/sequences/${seqId}/steps`, data),
    updateStep:  (seqId, stepId, data)  => api.put(`/sequences/${seqId}/steps/${stepId}`, data),
    deleteStep:  (seqId, stepId)        => api.delete(`/sequences/${seqId}/steps/${stepId}`),
    reorderSteps:(seqId, order)         => api.post(`/sequences/${seqId}/steps/reorder`, { order }),
    // ── AI ─────────────────────────────────────────────────────────────────
    aiGenerate: (seqId, prospectId)     => api.post(`/sequences/${seqId}/ai-generate`, { prospectId }),
    // ── Enroll ─────────────────────────────────────────────────────────────
    enroll: (sequenceId, prospectIds)   => api.post('/sequences/enroll', { sequenceId, prospectIds }),
    // ── Enrollments ────────────────────────────────────────────────────────
    getEnrollments:  (params = {})      => {
      const qs = new URLSearchParams(params).toString();
      return api.get(`/sequences/enrollments${qs ? '?' + qs : ''}`);
    },
    getEnrollment:   (enrollId)         => api.get(`/sequences/enrollments/${enrollId}`),
    stopEnrollment:  (enrollId, reason) => api.post(`/sequences/enrollments/${enrollId}/stop`, { reason }),
    pauseEnrollment: (enrollId)         => api.post(`/sequences/enrollments/${enrollId}/pause`),
    resumeEnrollment:(enrollId)         => api.post(`/sequences/enrollments/${enrollId}/resume`),
  },

  // ══════════════════════════════════════════════════════════
  // Handovers — Sales → Implementation  (Phase 3)
  // ══════════════════════════════════════════════════════════
  handovers: {
    list:      (scope = 'mine', status) => {
      const qs = new URLSearchParams({ scope, ...(status && { status }) }).toString();
      return api.get(`/handovers/sales?${qs}`);
    },
    create:    (dealId)      => api.post('/handovers/sales', { dealId }),
    getById:   (id)          => api.get(`/handovers/sales/${id}`),
    update:    (id, data)    => api.put(`/handovers/sales/${id}`, data),
    setStatus: (id, status)  => api.patch(`/handovers/sales/${id}/status`, { status }),
    canSubmit: (id)          => api.get(`/handovers/sales/${id}/can-submit`),

    addStakeholder:    (id, data) => api.post(`/handovers/sales/${id}/stakeholders`, data),
    updateStakeholder: (id, sid, data) => api.put(`/handovers/sales/${id}/stakeholders/${sid}`, data),
    removeStakeholder: (id, sid)  => api.delete(`/handovers/sales/${id}/stakeholders/${sid}`),

    addCommitment:    (id, data) => api.post(`/handovers/sales/${id}/commitments`, data),
    removeCommitment: (id, cid)  => api.delete(`/handovers/sales/${id}/commitments/${cid}`),

    completePlay: (id, instanceId) => api.post(`/handovers/sales/${id}/plays/${instanceId}/complete`),
    toggleModule: (enabled) => api.patch('/handovers/admin/module', { enabled }),
  },

  // ══════════════════════════════════════════════════════════
  // Service / Customer Support Module
  // ══════════════════════════════════════════════════════════
  support: {
    toggleModule:  (enabled) => api.patch('/support/admin/module', { enabled }),
    // SLA Tiers
    getSlaTiers:   () => api.get('/support/sla-tiers'),
    createSlaTier: (data) => api.post('/support/sla-tiers', data),
    updateSlaTier: (id, data) => api.patch(`/support/sla-tiers/${id}`, data),
    // Teams (assignment pickers)
    getTeams:      () => api.get('/support/teams'),
    getTeamMembers:(teamId) => api.get(`/support/teams/${teamId}/members`),
    // Cases
    getCases:      (params = {}) => {
      const qs = new URLSearchParams();
      if (params.status)    qs.set('status',    params.status);
      if (params.accountId) qs.set('accountId', params.accountId);
      if (params.assignedTo)qs.set('assignedTo',params.assignedTo);
      if (params.teamId)    qs.set('teamId',    params.teamId);
      if (params.priority)  qs.set('priority',  params.priority);
      if (params.breach)    qs.set('breach',    params.breach);
      if (params.scope)     qs.set('scope',     params.scope);
      if (params.search)    qs.set('search',    params.search);
      if (params.limit)     qs.set('limit',     params.limit);
      if (params.offset)    qs.set('offset',    params.offset);
      return api.get(`/support/cases${qs.toString() ? '?' + qs : ''}`);
    },
    getCase:       (id) => api.get(`/support/cases/${id}`),
    createCase:    (data) => api.post('/support/cases', data),
    updateCase:    (id, data) => api.patch(`/support/cases/${id}`, data),
    addNote:       (id, data) => api.post(`/support/cases/${id}/notes`, data),
    updatePlay:    (caseId, playId, data) => api.patch(`/support/cases/${caseId}/plays/${playId}`, data),
    // Dashboard
    getDashboard:  (scope = 'mine') => api.get(`/support/dashboard?scope=${scope}`),
    generateCaseActions: (caseId, data) => api.post(`/support/cases/${caseId}/generate-actions`, data),
  },

  // ══════════════════════════════════════════════════════════
  // Agency / Client Management Module
  // ══════════════════════════════════════════════════════════
  agency: {
    toggleModule: (enabled) => api.patch('/org/admin/module/agency', { enabled }),

    // Clients CRUD
    getAll:   (params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return api.get(`/clients${qs ? '?' + qs : ''}`);
    },
    getById:  (id)          => api.get(`/clients/${id}`),
    create:   (data)        => api.post('/clients', data),
    update:   (id, data)    => api.put(`/clients/${id}`, data),
    archive:  (id)          => api.delete(`/clients/${id}`),

    // Team assignment
    addTeamMember:    (clientId, data)        => api.post(`/clients/${clientId}/team`, data),
    removeTeamMember: (clientId, userId)      => api.delete(`/clients/${clientId}/team/${userId}`),

    // Prospect / Account scoping
    assignProspects:  (clientId, prospectIds) => api.post(`/clients/${clientId}/prospects/assign`, { prospectIds }),
    assignAccounts:   (clientId, accountIds)  => api.post(`/clients/${clientId}/accounts/assign`, { accountIds }),

    // Portal users
    getPortalUsers:   (clientId)              => api.get(`/clients/${clientId}/portal-users`),
    invitePortalUser: (clientId, data)        => api.post(`/clients/${clientId}/portal-users`, data),
    revokePortalUser: (clientId, userId)      => api.delete(`/clients/${clientId}/portal-users/${userId}`),
    resendInvite:     (clientId, userId)      => api.post(`/clients/${clientId}/portal-users/${userId}/resend`),

    // Dashboard
    getDashboard:     (clientId)              => api.get(`/clients/${clientId}/dashboard`),

    // Report token
    regenerateToken:  (clientId)              => api.post(`/clients/${clientId}/report-token`),
  },

  // ══════════════════════════════════════════════════════════
  // Playbook Builder — versioning, registrations, access mgmt
  // New routes added by the Playbook Builder module.
  // Separate from apiService.playbooks.* which handles the
  // legacy stage-guidance / content editing surface.
  // ══════════════════════════════════════════════════════════
  playbookBuilder: {
    // ── Playbooks ─────────────────────────────────────────
    list:    (params = {}) => api.get('/playbooks', { params }),
    getById: (id)          => api.get(`/playbooks/${id}`),
    create:  (data)        => api.post('/playbooks', data),
    update:  (id, data)    => api.patch(`/playbooks/${id}`, data),
    archive: (id, data)    => api.post(`/playbooks/${id}/archive`, data),

    // ── Versions ──────────────────────────────────────────
    getVersions:    (id)               => api.get(`/playbooks/${id}/versions`),
    createVersion:  (id, data)         => api.post(`/playbooks/${id}/versions`, data),
    submitVersion:  (id, v)            => api.post(`/playbooks/${id}/versions/${v}/submit`),
    approveVersion: (id, v)            => api.post(`/playbooks/${id}/versions/${v}/approve`),
    rejectVersion:  (id, v, reason)    => api.post(`/playbooks/${id}/versions/${v}/reject`, { reason }),

    // ── Plays ─────────────────────────────────────────────
    getPlays:   (id, params = {}) => api.get(`/playbooks/${id}/plays`, { params }),
    createPlay: (id, data)        => api.post(`/playbooks/${id}/plays`, data),
    updatePlay: (id, playId, data)=> api.patch(`/playbooks/${id}/plays/${playId}`, data),
    deletePlay: (id, playId)      => api.delete(`/playbooks/${id}/plays/${playId}`),

    // ── Registrations ─────────────────────────────────────
    getRegistrations:   (params = {}) => api.get('/playbook-registrations', { params }),
    getRegistration:    (id)          => api.get(`/playbook-registrations/${id}`),
    createRegistration: (data)        => api.post('/playbook-registrations', data),
    updateRegistration: (id, data)    => api.patch(`/playbook-registrations/${id}`, data),
    submitRegistration: (id)          => api.post(`/playbook-registrations/${id}/submit`),
    approveRegistration:(id)          => api.post(`/playbook-registrations/${id}/approve`),
    rejectRegistration: (id, reason)  => api.post(`/playbook-registrations/${id}/reject`, { reason }),
    requestChanges:     (id, notes)   => api.post(`/playbook-registrations/${id}/request-changes`, { notes }),

    // ── Access management ─────────────────────────────────
    resolveAccess:     (id, userId) => api.get(`/playbooks/${id}/access`, { params: { user_id: userId } }),
    getTeamGrants:     (id)         => api.get(`/playbooks/${id}/teams`),
    addTeamGrant:      (id, data)   => api.post(`/playbooks/${id}/teams`, data),
    removeTeamGrant:   (id, teamId) => api.delete(`/playbooks/${id}/teams/${teamId}`),
    getUserOverrides:  (id)         => api.get(`/playbooks/${id}/user-access`),
    setUserOverride:   (id, data)   => api.post(`/playbooks/${id}/user-access`, data),
    removeUserOverride:(id, userId) => api.delete(`/playbooks/${id}/user-access/${userId}`),

    // ── Stats ─────────────────────────────────────────────
    getStats:         ()   => api.get('/playbooks/stats/summary'),
    getPlaybookStats: (id) => api.get(`/playbooks/${id}/stats`),
  },
};

// ============================================================
// OUTLOOK & SYNC APIs (unchanged)
// ============================================================

export const outlookAPI = {
  getAuthUrl: async (userId) => {
    const url = `${API_BASE_URL}/outlook/connect?userId=${userId}`;
    const response = await fetch(url, { headers: { 'Content-Type': 'application/json' } });
    if (!response.ok) { const errorData = await response.json().catch(() => ({})); throw new Error(errorData.error || 'Failed to get auth URL'); }
    return response.json();
  },
  getStatus: async (userId) => {
    const response = await fetch(`${API_BASE_URL}/outlook/status?userId=${userId}`, { headers: { 'Content-Type': 'application/json' } });
    if (!response.ok) throw new Error('Failed to get status');
    return response.json();
  },
  disconnect: async (userId) => {
    const response = await fetch(`${API_BASE_URL}/outlook/disconnect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) });
    if (!response.ok) throw new Error('Failed to disconnect');
    return response.json();
  },
  fetchEmails: async (userId, options = {}) => {
    const params = new URLSearchParams({ top: options.top || 50, skip: options.skip || 0, ...(options.since && { since: options.since }) });
    const response = await fetch(`${API_BASE_URL}/emails/outlook?${params}`, { headers: getAuthHeaders() });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    return response.json();
  },
  processEmail: async (userId, emailId) => {
    const response = await fetch(`${API_BASE_URL}/emails/process`, { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify({ userId, emailId }) });
    if (!response.ok) throw new Error('Failed to process email');
    return response.json();
  }
};

export const googleAPI = {
  getAuthUrl: async (userId) => {
    const response = await fetch(`${API_BASE_URL}/google/connect?userId=${userId}`, { headers: { 'Content-Type': 'application/json' } });
    if (!response.ok) { const errorData = await response.json().catch(() => ({})); throw new Error(errorData.error || 'Failed to get auth URL'); }
    return response.json();
  },
  getStatus: async (userId) => {
    const response = await fetch(`${API_BASE_URL}/google/status?userId=${userId}`, { headers: { 'Content-Type': 'application/json' } });
    if (!response.ok) throw new Error('Failed to get status');
    return response.json();
  },
  disconnect: async (userId) => {
    const response = await fetch(`${API_BASE_URL}/google/disconnect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) });
    if (!response.ok) throw new Error('Failed to disconnect');
    return response.json();
  },
  fetchEmails: async (userId, options = {}) => {
    const params = new URLSearchParams({ top: options.top || 50, skip: options.skip || 0 });
    const response = await fetch(`${API_BASE_URL}/emails/gmail?${params}`, { headers: getAuthHeaders() });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  },
};

export const unifiedEmailAPI = {
  fetchEmails: async (options = {}) => {
    const params = new URLSearchParams({ top: options.top || 50, ...(options.dealId && { dealId: options.dealId }) });
    const response = await fetch(`${API_BASE_URL}/emails/unified?${params}`, { headers: getAuthHeaders() });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    return response.json();
  },
  getConnectedProviders: async () => {
    const userId = JSON.parse(localStorage.getItem('user') || '{}').id;
    if (!userId) return [];
    const [outlookStatus, googleStatus] = await Promise.allSettled([outlookAPI.getStatus(userId), googleAPI.getStatus(userId)]);
    const providers = [];
    if (outlookStatus.status === 'fulfilled' && outlookStatus.value?.connected) providers.push('outlook');
    if (googleStatus.status === 'fulfilled' && googleStatus.value?.connected) providers.push('gmail');
    return providers;
  },
};

export const syncAPI = {
  triggerSync: async (userId, provider = 'outlook') => {
    const response = await fetch(`${API_BASE_URL}/sync/emails`, { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify({ provider }) });
    if (!response.ok) { const errorData = await response.json().catch(() => ({})); throw new Error(errorData.error || 'Failed to trigger sync'); }
    return response.json();
  },
  triggerSyncAll: async (userId) => {
    const providers = await unifiedEmailAPI.getConnectedProviders();
    const results = [];
    for (const provider of providers) {
      try { const result = await syncAPI.triggerSync(userId, provider); results.push({ provider, ...result }); }
      catch (err) { results.push({ provider, success: false, error: err.message }); }
    }
    return results;
  },
  getStatus: async (userId) => {
    const response = await fetch(`${API_BASE_URL}/sync/emails/status`, { headers: getAuthHeaders() });
    if (!response.ok) throw new Error('Failed to get sync status');
    return response.json();
  },
  getConfig: async () => {
    const response = await fetch(`${API_BASE_URL}/sync/config`, { headers: getAuthHeaders() });
    if (!response.ok) throw new Error('Failed to get sync config');
    return response.json();
  },
};

export default api;

// ─── Salesforce Integration API ───────────────────────────────────────────────
export const salesforceAPI = {
  getAuthUrl: async () => {
    const response = await fetch(`${API_BASE_URL}/salesforce/connect`, { headers: getAuthHeaders() });
    if (!response.ok) { const e = await response.json().catch(() => ({})); throw new Error(e.error || 'Failed to get SF auth URL'); }
    return response.json();
  },
  getStatus: async () => {
    const response = await fetch(`${API_BASE_URL}/salesforce/status`, { headers: getAuthHeaders() });
    if (!response.ok) throw new Error('Failed to get SF status');
    return response.json();
  },
  disconnect: async () => {
    const response = await fetch(`${API_BASE_URL}/salesforce/disconnect`, { method: 'POST', headers: getAuthHeaders() });
    if (!response.ok) throw new Error('Failed to disconnect SF');
    return response.json();
  },
  triggerSync: async () => {
    const response = await fetch(`${API_BASE_URL}/salesforce/trigger`, { method: 'POST', headers: getAuthHeaders() });
    if (!response.ok) throw new Error('Failed to trigger SF sync');
    return response.json();
  },
  getSettings: async () => {
    const response = await fetch(`${API_BASE_URL}/salesforce/settings`, { headers: getAuthHeaders() });
    if (!response.ok) throw new Error('Failed to get SF settings');
    return response.json();
  },
  updateSettings: async (settings) => {
    const response = await fetch(`${API_BASE_URL}/salesforce/settings`, {
      method: 'PATCH', headers: getAuthHeaders(), body: JSON.stringify(settings),
    });
    if (!response.ok) { const e = await response.json().catch(() => ({})); throw new Error(e.error || 'Failed to save SF settings'); }
    return response.json();
  },
  describeObject: async (sfObject) => {
    const response = await fetch(`${API_BASE_URL}/salesforce/describe/${sfObject}`, { headers: getAuthHeaders() });
    if (!response.ok) throw new Error(`Failed to describe ${sfObject}`);
    return response.json();
  },
  getStages: async () => {
    const response = await fetch(`${API_BASE_URL}/salesforce/stages`, { headers: getAuthHeaders() });
    if (!response.ok) throw new Error('Failed to fetch SF stages');
    return response.json();
  },
  getIdentityQueue: async () => {
    const response = await fetch(`${API_BASE_URL}/salesforce/identity-queue`, { headers: getAuthHeaders() });
    if (!response.ok) throw new Error('Failed to get identity queue');
    return response.json();
  },
  resolveIdentity: async (id, action) => {
    const response = await fetch(`${API_BASE_URL}/salesforce/identity-queue/${id}/resolve`, {
      method: 'POST', headers: getAuthHeaders(), body: JSON.stringify({ action }),
    });
    if (!response.ok) throw new Error('Failed to resolve identity');
    return response.json();
  },
  getLockedFields: async (entity) => {
    const response = await fetch(`${API_BASE_URL}/salesforce/locked-fields/${entity}`, { headers: getAuthHeaders() });
    if (!response.ok) return { data: [] };
    return response.json();
  },
};
