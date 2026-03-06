/**
 * apiService.js — DROP-IN REPLACEMENT
 *
 * CLM added: contracts section with all 22 endpoints.
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
  },

  prospects: {
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
  },

  accountProspecting: {
    getOverview: (accountId) => api.get(`/accounts/${accountId}/prospecting`),
    getCoverage: (accountId, playbookId) => api.get(`/accounts/${accountId}/coverage?playbookId=${playbookId}`),
  },

  unifiedActions: {
    getAll: (scope = 'mine', source = 'all') => api.get(`/actions/unified?scope=${scope}&source=${source}`),
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
    // Admin
    toggleModule:       (enabled) => api.patch('/contracts/admin/module', { enabled }),
    getWorkflowConfig:  () => api.get('/contracts/admin/workflow-config'),
    saveWorkflowConfig: (data) => api.put('/contracts/admin/workflow-config', data),
    getApprovalConfig:  () => api.get('/contracts/admin/approval-config'),
    saveApprovalConfig: (rules) => api.put('/contracts/admin/approval-config', { rules }),

    // Legal inbox
    getLegalTeamStatus: () => api.get('/contracts/legal/team-status'),
    getLegalQueue:      () => api.get('/contracts/legal/queue'),
    getLegalAssigned:   () => api.get('/contracts/legal/assigned'),

    // Approvals
    getPendingApprovals: () => api.get('/contracts/approvals/pending'),
    decideApproval:      (id, decision, note) => api.post(`/contracts/approvals/${id}/decide`, { decision, note }),

    // CRUD
    getAll:   (params = {}) => { const qs = new URLSearchParams(params).toString(); return api.get(`/contracts${qs ? '?' + qs : ''}`); },
    getById:  (id) => api.get(`/contracts/${id}`),
    create:   (data) => api.post('/contracts', data),
    update:   (id, data) => api.put(`/contracts/${id}`, data),
    delete:   (id) => api.delete(`/contracts/${id}`),

    // Document versions
    getVersions:   (id) => api.get(`/contracts/${id}/versions`),
    uploadVersion: (id, data) => api.post(`/contracts/${id}/versions`, data),

    // Transitions
    submitForLegal:    (id, data) => api.post(`/contracts/${id}/submit-legal`, data),
    pickUp:            (id) => api.post(`/contracts/${id}/pick-up`),
    reassign:          (id, newAssigneeId) => api.post(`/contracts/${id}/reassign`, { newAssigneeId }),
    returnToSales:     (id) => api.post(`/contracts/${id}/return-sales`),
    resubmit:          (id) => api.post(`/contracts/${id}/resubmit`),
    sendForSignature:  (id) => api.post(`/contracts/${id}/send-signature`),
    markSigned:        (id) => api.post(`/contracts/${id}/mark-signed`),
    activate:          (id) => api.post(`/contracts/${id}/activate`),
    recall:            (id, data) => api.post(`/contracts/${id}/recall`, data),
    void:              (id, data) => api.post(`/contracts/${id}/void`, data),
    amend:             (id) => api.post(`/contracts/${id}/amend`),
    startApproval:     (id) => api.post(`/contracts/${id}/start-approval`),

    // Signatories
    addSignatory:    (id, data) => api.post(`/contracts/${id}/signatories`, data),
    removeSignatory: (id, sigId) => api.delete(`/contracts/${id}/signatories/${sigId}`),

    // Notes
    addNote: (id, note) => api.post(`/contracts/${id}/notes`, { note }),
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
