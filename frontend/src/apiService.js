/**
 * apiService.js — DROP-IN REPLACEMENT
 *
 * Added in this version:
 *   msteams.*                           — Microsoft Teams connect, discovery
 *                                         and triage (phase 0; captures nothing
 *                                         yet). Sits ABOVE the WhatsApp block.
 *
 * Added previously, kept for reference:
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
    // getAll accepts either the legacy single-string scope, or an options
    // object: { scope, needsReview }. Backwards-compatible for existing callers.
    getAll: (scopeOrOpts = 'mine', maybeOpts = {}) => {
      const opts = typeof scopeOrOpts === 'string'
        ? { scope: scopeOrOpts, ...maybeOpts }
        : (scopeOrOpts || {});
      const params = new URLSearchParams();
      if (opts.scope) params.set('scope', opts.scope);
      if (opts.needsReview) params.set('needs_review', 'true');
      return api.get(`/accounts?${params.toString()}`);
    },
    getById: (id) => api.get(`/accounts/${id}`),
    create: (data) => api.post('/accounts', data),
    update: (id, data) => api.put(`/accounts/${id}`, data),
    delete: (id) => api.delete(`/accounts/${id}`),
    getDuplicates: () => api.get('/accounts/duplicates'),
    merge: (keepId, removeId, fieldOverrides = {}) => api.post('/accounts/merge', { keepId, removeId, fieldOverrides }),
    bulk: (rows) => api.post('/accounts/bulk', { rows }),
    enrichFromCoresignal: (id) => api.post(`/accounts/${id}/enrich-from-coresignal`),
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


twilio: {
    // Org-admin endpoints
    listReps:        ()                     => api.get(`/org/admin/twilio/reps`),
    provisionDid:    (userId, areaCode)     => api.post(`/org/admin/twilio/provision-did/${userId}`, { area_code: areaCode }),
    releaseDid:      (userId)               => api.post(`/org/admin/twilio/release-did/${userId}`),
    patchSettings:   (patch)                => api.patch(`/org/admin/twilio/settings`, patch),

    // Per-user phone
    getMyPhone:      ()                     => api.get(`/users/me/phone`),
    setMyPhone:      (phone)                => api.patch(`/users/me/phone`, { phone }),

    // Call lifecycle
    initiateCall:    (prospectId, sequenceStepLogId = null) => api.post(`/prospect-calls/initiate`, {
      prospect_id: prospectId,
      ...(sequenceStepLogId ? { sequence_step_log_id: sequenceStepLogId } : {}),
    }),
    getCallStatus:   (callId)               => api.get(`/prospect-calls/${callId}/status`),

    // Per-org subaccount (Model A) + browser dialing (Voice SDK v2)
    provisionAccount: ()                     => api.post(`/org/admin/twilio/provision-account`),
    getAccount:       ()                     => api.get(`/org/admin/twilio/account`),
    getVoiceToken:    ()                     => api.get(`/twilio/voice/token`),
    // Browser-dial: creates the call row; the softphone originates the call.
    prepareCall:      (prospectId, sequenceStepLogId = null, phoneId = null) => api.post(`/prospect-calls/prepare`, {
      prospect_id: prospectId,
      ...(sequenceStepLogId ? { sequence_step_log_id: sequenceStepLogId } : {}),
      ...(phoneId ? { phone_id: phoneId } : {}),
    }),
  },

  prospectPhones: {
    list:       (prospectId)                       => api.get(`/prospect-phones?prospect_id=${prospectId}`),
    add:        (prospectId, phone, label = null, isPrimary = false) =>
                  api.post(`/prospect-phones`, { prospect_id: prospectId, phone, label, is_primary: isPrimary }),
    update:     (id, patch)                        => api.patch(`/prospect-phones/${id}`, patch),
    setPrimary: (id)                               => api.patch(`/prospect-phones/${id}`, { is_primary: true }),
    remove:     (id)                               => api.delete(`/prospect-phones/${id}`),
  },

  health: {
    // dealHealth routes moved from a bare /api mount to /api/deal-health
    // (the bare mount was an auth-gated catch-all that broke public webhooks).
    scoreDeal: (id) => api.post(`/deal-health/deals/${id}/score`),
    scoreAll: () => api.post('/deal-health/deals/score-all'),
    updateSignals: (id, signals) => api.patch(`/deal-health/deals/${id}/signals`, signals),
    // NOTE: signalOverride is NOT a dealHealth route — it lives in
    // deals.routes.js at /api/deals/:id/signal-override. Left unchanged.
    signalOverride: (id, signalKey, value, managerOverride = false) => api.patch(`/deals/${id}/signal-override`, { signalKey, value, managerOverride }),
  },

  healthConfig: {
    get: () => api.get('/deal-health/health-config'),
    save: (data) => api.put('/deal-health/health-config', data),
  },

  competitors: {
    getAll: () => api.get('/deal-health/competitors'),
    create: (data) => api.post('/deal-health/competitors', data),
    update: (id, data) => api.put(`/deal-health/competitors/${id}`, data),
    delete: (id) => api.delete(`/deal-health/competitors/${id}`),
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
    // WhatsApp session capture — platform-wide health (no message content)
    whatsappSessions:        ()   => api.get('/super/whatsapp-sessions'),
    disableWhatsappSession:  (id) => api.post(`/super/whatsapp-sessions/${id}/disable`),
    getStats: () => api.get('/super/stats'),
    getOrgs: (params = {}) => api.get('/super/orgs', { params }),
    getOrg: (orgId) => api.get(`/super/orgs/${orgId}`),
    createOrg: (data) => api.post('/super/orgs', data),
    updateOrg: (orgId, data) => api.patch(`/super/orgs/${orgId}`, data),
    suspendOrg: (orgId, data) => api.post(`/super/orgs/${orgId}/suspend`, data),
    convertOrgToStandard: (orgId) => api.post(`/super/orgs/${orgId}/convert-to-standard`),
    impersonateOrg: (orgId) => api.post(`/super/orgs/${orgId}/impersonate`),
    impersonateUser: (userId) => api.post(`/super/users/${userId}/impersonate`),
    getUsers: (params = {}) => api.get('/super/users', { params }),
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

    // ── LinkedIn seats (user_linkedin_seats) ────────────────────────────────
    // Seats are created lazily by the extension; superadmin can only view,
    // reassign within the org, or unbind. DELETE returns 409
    // SEAT_HAS_ACTIVE_LEASES unless force=true.
    getOrgLinkedInSeats:     (orgId)                 => api.get(`/super/orgs/${orgId}/linkedin-seats`),
    reassignLinkedInSeat:    (orgId, seatId, userId) => api.patch(`/super/orgs/${orgId}/linkedin-seats/${seatId}`, { user_id: userId }),
    deleteLinkedInSeat:      (orgId, seatId, force = false) =>
      api.delete(`/super/orgs/${orgId}/linkedin-seats/${seatId}`, { params: force ? { force: 'true' } : {} }),

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
    // Enrich the prospect's account via the configured firmographic provider
    // (CoreSignal today). Backend route never overwrites existing real values
    // — only fills blanks. See backend/services/enrichmentService.js for rules.
    enrichFromCoresignal: (id) => api.post(`/prospects/${id}/enrich-from-coresignal`),
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
    getConnectUrl: (provider, label, returnTo) => api.get(`/prospecting-senders/connect-url?provider=${provider}${label ? '&label=' + encodeURIComponent(label) : ''}${returnTo ? '&returnTo=' + encodeURIComponent(returnTo) : ''}`),
    update: (id, data) => api.patch(`/prospecting-senders/${id}`, data),
    remove: (id) => api.delete(`/prospecting-senders/${id}`),
    // Live-checks a sender's OAuth credential; refreshes + stamps health, or
    // reports { valid: false, reason } if revoked. Backs the health badge and
    // the "check before reconnect" affordance.
    validate: (id) => api.post(`/prospecting-senders/${id}/validate`),
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
    getMemberModules: (userId) => api.get(`/org/admin/members/${userId}/modules`),
    setMemberModules: (userId, modules) => api.put(`/org/admin/members/${userId}/modules`, { modules }),
    updateMember: (userId, data) => api.patch(`/org/admin/members/${userId}`, data),
    removeMember: (userId) => api.delete(`/org/admin/members/${userId}`),
    getInvitations: () => api.get('/org/admin/invitations'),
    sendInvitation: (data) => api.post('/org/admin/invitations', data),
    cancelInvitation: (id) => api.delete(`/org/admin/invitations/${id}`),
    approveInvitation: (id) => api.post(`/org/admin/invitations/${id}/approve`),
    rejectInvitation: (id, reason) => api.post(`/org/admin/invitations/${id}/reject`, { reason }),
    testEmail: (to) => api.post('/org/admin/test-email', { to }),
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
    testSlack:        () => api.post('/team-notifications/test-slack'),
    setSlackEmail:    (slack_email) => api.patch('/team-notifications/slack-email', { slack_email }),
    getOrgMembers:    () => api.get('/team-notifications/org-members'),
    // Backs the "which teams am I on" modal in NotificationSettings. The route
    // has existed since the team-notifications work; only this binding was
    // missing, so the call resolved to undefined and the modal never opened.
    getMyTeams:       () => api.get('/team-notifications/my-teams'),
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
    config:      () => api.get('/team-notifications/config'),
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
  // Configurable roles for EXTERNAL project people, per side. Separate from
  // orgRoles (internal, routable) on purpose.
  contactRoles: {
    list:    (side)        => api.get(`/contact-roles${side ? `?side=${side}` : ''}`),
    listAll: (side)        => api.get(`/contact-roles?all=true${side ? `&side=${side}` : ''}`),
    create:  (data)        => api.post('/contact-roles', data),
    update:  (id, patch)   => api.patch(`/contact-roles/${id}`, patch),
    remove:  (id)          => api.delete(`/contact-roles/${id}`),
    reorder: (side, ids)   => api.post('/contact-roles/reorder', { side, ids }),
  },

  // Vendors and partners are ACCOUNTS carrying a relationship, so these return
  // the account shape.
  accountRelationships: {
    vendors:    (status = 'active') => api.get(`/account-relationships/vendors?status=${status}`),
    partners:   (status = 'active') => api.get(`/account-relationships/partners?status=${status}`),
    forAccount: (accountId)         => api.get(`/account-relationships/account/${accountId}`),
    // Per-project involvement for one vendor/partner. Scoped server-side to the
    // projects the caller may see, so the count differs between viewers.
    projectsForAccount: (accountId)  => api.get(`/account-relationships/account/${accountId}/projects`),
    // Bound group conversations for a vendor. Scoped to the viewer, so two
    // people can legitimately see different counts for the same account.
    conversationsForAccount: (accountId) => api.get(`/account-relationships/account/${accountId}/conversations`),
    // Threads that could be bound to this vendor but are not yet.
    bindableForAccount:      (accountId) => api.get(`/account-relationships/account/${accountId}/bindable`),
    request:    (data)              => api.post('/account-relationships', data),
    review:     (id, body)          => api.post(`/account-relationships/${id}/review`, body),
    end:        (id)                => api.post(`/account-relationships/${id}/end`),
    getPolicy:  ()                  => api.get('/account-relationships/policy'),
    setPolicy:  (patch)             => api.put('/account-relationships/policy', patch),
  },

  // Email conversations filed to a project. Thread-level: tagging one message
  // files the whole conversation and publishes every mailbox copy to the team.
  projectEmails: {
    threads:     (handoverId)        => api.get(`/project-emails/${handoverId}/threads`),
    tagThread:   (handoverId, body)  => api.post(`/project-emails/${handoverId}/threads`, body),
    untagThread: (handoverId, convId) =>
      api.delete(`/project-emails/${handoverId}/threads/${encodeURIComponent(convId)}`),
    hide:        (handoverId, emailId) => api.post(`/project-emails/${handoverId}/messages/${emailId}/hide`),
    unhide:      (handoverId, emailId) => api.post(`/project-emails/${handoverId}/messages/${emailId}/unhide`),
    untagged:    (accountId)         =>
      api.get(`/emails/untagged${accountId ? `?accountId=${accountId}` : ''}`),
  },

  // The org's cloud storage account — where WhatsApp attachments are written.
  orgStorage: {
    list:       ()                 => api.get('/org-storage'),
    disconnect: (provider)         => api.delete(`/org-storage/${provider}`),
    target:     (handoverId)       => api.get(`/org-storage/projects/${handoverId}/target`),
    // Connect runs through the SAME OAuth routes as mailbox connect, with
    // mode=org_storage in the state — so there is one callback per provider,
    // not two.
    connectUrl: (provider, userId, orgId) =>
      api.get(`/${provider === 'onedrive' ? 'outlook' : 'google'}/connect`
        + `?userId=${userId}&mode=org_storage&orgId=${orgId}`),
  },

  whatsappMedia: {
    forProject: (handoverId)  => api.get(`/whatsapp-media/projects/${handoverId}`),
    keep:       (messageId)   => api.post(`/whatsapp-media/messages/${messageId}/keep`),
    // Body carries an optional { reason }. Removal is destructive and the audit
    // row keeps it, so "wrong project" and "confidential, sent by mistake" stay
    // distinguishable long after everyone has forgotten which was which.
    remove:     (messageId, body = {}) => api.post(`/whatsapp-media/messages/${messageId}/remove`, body),
    retry:      (messageId)   => api.post(`/whatsapp-media/messages/${messageId}/retry`),
  },

  handovers: {
    // trackingMode: 'timeboxed' (default on the server) | 'standing' | 'all'.
    // Omitted means time-boxed projects only — the Projects list. Standing
    // initiatives have their own screen and must not inflate its counts.
    list:      (scope = 'mine', status, kind, trackingMode) => {
      const qs = new URLSearchParams({
        scope,
        ...(status && { status }),
        ...(kind && { kind }),        // 'customer' | 'internal'; omit for both
        ...(trackingMode && { trackingMode }),
      }).toString();
      return api.get(`/handovers/sales?${qs}`);
    },
    // 2026_133. Separate from update() because that endpoint writes every field
    // through COALESCE, so it cannot CLEAR the go-live date — which converting
    // to a standing initiative has to do in the same statement.
    //
    // Rejects with 409 + code GO_LIVE_ANCHORED_PLAYS when open tasks are
    // scheduled from the go-live date. details.plays lists them; resend with
    // acknowledgeAnchoredPlays to proceed.
    convertTrackingMode: (id, body) => api.patch(`/handovers/sales/${id}/tracking-mode`, body),

    // Open go_live-anchored tasks still scheduled from a date the project no
    // longer has. Only ever non-empty for a project whose plan is FROZEN —
    // on an unfrozen one the dates have already been moved, so any remaining
    // difference is a deliberate manual adjustment, not drift.
    goLiveDrift: (id) => api.get(`/handovers/sales/${id}/go-live-drift`),
    retire:   (id) => api.post(`/handovers/sales/${id}/retire`),
    unretire: (id) => api.delete(`/handovers/sales/${id}/retire`),
    // Projects that don't come from a won deal: internal, or the customer
    // exception. Deal-driven creation stays on create().
    createProject: (data) => api.post('/handovers/projects', data),
    availablePlaybooks: ()                 => api.get('/handovers/playbooks/available'),
    setPlaybook: (id, playbookId, stageKey, replace = false) =>
      api.put(`/handovers/sales/${id}/playbook`, {
        playbookId, ...(stageKey && { stageKey }), ...(replace && { replace: true }),
      }),
    create:    (dealId)      => api.post('/handovers/sales', { dealId }),
    portfolio: ()            => api.get('/handovers/portfolio'),
    // Scope config + what the current viewer is allowed to use, in one call so
    // the scope switcher can render without a second round trip.
    projectAccess:    ()      => api.get('/handovers/admin/project-access'),
    setProjectAccess: (patch) => api.put('/handovers/admin/project-access', patch),
    healthRollup: (groupBy = 'account') => api.get(`/reporting/health?groupBy=${groupBy}`),
    dealsHealth:   (groupBy = 'owner') => api.get(`/reporting/deals/health?groupBy=${groupBy}`),
    dealsFunnel:   () => api.get('/reporting/deals/funnel'),
    dealsForecast: (bucket = 'month') => api.get(`/reporting/deals/forecast?bucket=${bucket}`),
    dealsWinLoss:  (window = 90, groupBy = 'owner') => api.get(`/reporting/deals/winloss?window=${window}&groupBy=${groupBy}`),
    dealsVelocity:    () => api.get('/reporting/deals/velocity'),
    dealsLeaderboard: (window = 90) => api.get(`/reporting/deals/leaderboard?window=${window}`),
    dealsSlippage:    () => api.get('/reporting/deals/slippage'),
    dealsAging:       (threshold = 30) => api.get(`/reporting/deals/aging?threshold=${threshold}`),
    communications: (id)     => api.get(`/handovers/sales/${id}/communications`),
    getById:   (id)          => api.get(`/handovers/sales/${id}`),
    update:    (id, data)    => api.put(`/handovers/sales/${id}`, data),
    setStatus: (id, status, closureSummary) => api.patch(`/handovers/sales/${id}/status`, { status, closureSummary }),
    canSubmit: (id)          => api.get(`/handovers/sales/${id}/can-submit`),
    canClose:  (id)          => api.get(`/handovers/sales/${id}/can-close`),

    // Internal-customer sign-off. Only a named acceptor may call these — the
    // service enforces it, so the UI only ever hides the button.
    signOff:       (id, note) => api.post(`/handovers/sales/${id}/sign-off`, { note }),
    revokeSignOff: (id)       => api.delete(`/handovers/sales/${id}/sign-off`),

    addStakeholder:    (id, data) => api.post(`/handovers/sales/${id}/stakeholders`, data),    updateStakeholder: (id, sid, data) => api.put(`/handovers/sales/${id}/stakeholders/${sid}`, data),
    removeStakeholder: (id, sid)  => api.delete(`/handovers/sales/${id}/stakeholders/${sid}`),
    getContactPolicy:  (id)       => api.get(`/handovers/sales/${id}/contact-policy`),
    setContactPolicy:  (id, policy) => api.put(`/handovers/sales/${id}/contact-policy`, { policy }),

    addCommitment:    (id, data)      => api.post(`/handovers/sales/${id}/commitments`, data),
    updateCommitment: (id, cid, data) => api.patch(`/handovers/sales/${id}/commitments/${cid}`, data),
    removeCommitment: (id, cid)       => api.delete(`/handovers/sales/${id}/commitments/${cid}`),

    completePlay: (id, instanceId, data) => api.post(`/handovers/sales/${id}/plays/${instanceId}/complete`, data || {}),
    addPlay:    (id, data)       => api.post(`/handovers/sales/${id}/plays`, data),
    // Task prerequisites (2026_117). Instance ids on the same project; [] clears.
    setPlayDependencies: (id, instanceId, dependsOn) =>
      api.put(`/handovers/sales/${id}/plays/${instanceId}/dependencies`, { dependsOn }),
    // 2026_118
    startPreview:   (id, startDate) =>
      api.get(`/handovers/sales/${id}/start-preview${startDate ? `?startDate=${startDate}` : ''}`),
    evidencePolicy: (id) => api.get(`/handovers/sales/${id}/evidence-policy`),
    // Project stages (2026_116). project_stages is authoritative, so these
    // read/write the project's own stage list — not an org-wide catalogue.
    listStages:   (id)        => api.get(`/handovers/sales/${id}/stages`),
    addStage:     (id, data)  => api.post(`/handovers/sales/${id}/stages`, data),
    updateStages: (id, stages) => api.patch(`/handovers/sales/${id}/stages`, { stages }),
    removeStage:  (id, stageKey) => api.delete(`/handovers/sales/${id}/stages/${encodeURIComponent(stageKey)}`),
    updatePlay: (id, instanceId, data) => api.patch(`/handovers/sales/${id}/plays/${instanceId}`, data),

    // ── Review loop (2026_130) ──
    // One endpoint for submit / approve / send back. `to` decides which:
    //   { to: 'in_review',   targetStatus, evidence }
    //   { to: 'completed' | 'skipped' | 'cancelled', evidence? }
    //   { to: 'in_progress', reason }
    transitionPlay: (id, instanceId, data) =>
      api.post(`/handovers/sales/${id}/plays/${instanceId}/transition`, data),
    playTransitions: (id, instanceId) =>
      api.get(`/handovers/sales/${id}/plays/${instanceId}/transitions`),
    reviewQueue:     (id) => api.get(`/handovers/sales/${id}/review-queue`),
    // Awaiting MY review, across every project I run. Not project-scoped.
    myReviewQueue:   ()   => api.get('/handovers/review-queue'),
    reviewWatchers:  (id) => api.get(`/handovers/sales/${id}/review-watchers`),
    setReviewWatchers: (id, userIds) =>
      api.put(`/handovers/sales/${id}/review-watchers`, { userIds }),
    removePlay: (id, instanceId) => api.delete(`/handovers/sales/${id}/plays/${instanceId}`),
    reorderPlays: (id, stageKey, orderedIds) =>
      api.patch(`/handovers/sales/${id}/plays/reorder`, { stageKey, orderedIds }),

    // ── Notes on a checklist task (2026_120) ──
    // Available on tasks in ANY status: a manager writing up a finished
    // project needs to annotate closed items, not just open ones.
    playNotes:      (id, instanceId) => api.get(`/handovers/sales/${id}/plays/${instanceId}/notes`),
    addPlayNote:    (id, instanceId, data) =>
      api.post(`/handovers/sales/${id}/plays/${instanceId}/notes`, data),
    // Soft delete. Keyed on the note, not the play — the note id already
    // resolves to one task.
    deletePlayNote: (id, noteId) => api.delete(`/handovers/sales/${id}/notes/${noteId}`),

    // ── File attachments (2026_124) ──
    // multipart/form-data. The Content-Type header is deliberately NOT set:
    // the browser must add its own multipart boundary, and naming the type
    // by hand omits it and the request fails to parse server-side.
    //
    // The bytes go to the org's Drive/OneDrive, never to the database.
    uploadPlayEvidence: (id, instanceId, file, note) => {
      const fd = new FormData();
      fd.append('file', file);
      if (note) fd.append('note', note);
      return api.post(`/handovers/sales/${id}/plays/${instanceId}/evidence/upload`, fd);
    },
    addPlayNoteAttachment: (id, noteId, file) => {
      const fd = new FormData();
      fd.append('file', file);
      return api.post(`/handovers/sales/${id}/notes/${noteId}/attachments`, fd);
    },

    // ── Plan vs actual (2026_111) ──
    variance:       (id) => api.get(`/handovers/sales/${id}/variance`),
    canRebaseline:  (id) => api.get(`/handovers/sales/${id}/can-rebaseline`),

    // ── Bill of Quantities (2026_113/114) ──
    // Bill-scoped calls take boqId rather than the project id, so they keep
    // working when a project may hold more than one bill.
    boq:              (id) => api.get(`/handovers/sales/${id}/boq`),
    boqSummary:       (id) => api.get(`/handovers/sales/${id}/boq/summary`),
    createBoq:        (id, data) => api.post(`/handovers/sales/${id}/boq`, data),
    updateBoq:        (boqId, data) => api.patch(`/handovers/boq/${boqId}`, data),
    addBoqItem:       (boqId, data) => api.post(`/handovers/boq/${boqId}/items`, data),
    updateBoqItem:    (itemId, data) => api.patch(`/handovers/boq/items/${itemId}`, data),
    removeBoqItem:    (itemId) => api.delete(`/handovers/boq/items/${itemId}`),
    boqItemProgress:  (itemId) => api.get(`/handovers/boq/items/${itemId}/progress`),
    recordBoqProgress:(itemId, data) => api.post(`/handovers/boq/items/${itemId}/progress`, data),
    recordBoqBulk:    (boqId, data) => api.post(`/handovers/boq/${boqId}/progress/bulk`, data),
    reverseBoqEntry:  (entryId, data) => api.post(`/handovers/boq/progress/${entryId}/reverse`, data),
    // Query string rather than an axios params object, matching the
    // convention used elsewhere in this file (see dealsAging above).
    boqLedger:        (boqId, limit = 200, offset = 0) =>
      api.get(`/handovers/boq/${boqId}/ledger?limit=${limit}&offset=${offset}`),
    setBoqProcurement:(boqId, data) => api.patch(`/handovers/boq/${boqId}/procurement`, data),
    boqVendors:       () => api.get('/handovers/boq/vendors'),
    boqVariations:    (boqId) => api.get(`/handovers/boq/${boqId}/variations`),
    addBoqVariation:  (boqId, data) => api.post(`/handovers/boq/${boqId}/variations`, data),
    decideBoqVariation: (id, variationId, decision, reason) =>
      api.post(`/handovers/sales/${id}/boq/variations/${variationId}/decision`, { decision, reason }),
    varianceStages: (id) => api.get(`/handovers/sales/${id}/variance/stages`),
    playRevisions:  (id, instanceId) =>
      api.get(`/handovers/sales/${id}/plays/${instanceId}/revisions`),
    playEvidence:   (id, instanceId) =>
      api.get(`/handovers/sales/${id}/plays/${instanceId}/evidence`),
    addPlayEvidence: (id, instanceId, data) =>
      api.post(`/handovers/sales/${id}/plays/${instanceId}/evidence`, data),
    revokePlayEvidence: (id, evidenceId, reason) =>
      api.post(`/handovers/sales/${id}/evidence/${evidenceId}/revoke`, { reason }),
    teamMemberProjects: (userId) => api.get(`/handovers/team-members/${userId}/projects`),
    personDashboard: (userId) => api.get(`/handovers/team-members/${userId}/dashboard`),
    contactCommunications: (contactId) => api.get(`/handovers/contacts/${contactId}/communications`),
    projectActions:        (id) => api.get(`/handovers/sales/${id}/actions`),
    tabViewers:            (id, tab = 'commercial') => api.get(`/handovers/sales/${id}/tab-viewers?tab=${tab}`),
    setTabViewers:         (id, tabKey, userIds) => api.put(`/handovers/sales/${id}/tab-viewers`, { tabKey, userIds }),
    addProjectAction:      (id, data) => api.post(`/handovers/sales/${id}/actions`, data),
    completeProjectAction: (id, actionId) => api.post(`/handovers/sales/${id}/actions/${actionId}/complete`),
    commitmentActivity: (cid) => api.get(`/handovers/commitments/${cid}/activity`),
    assignableUsers: () => api.get('/handovers/assignable-users'),
    orgRoles:         () => api.get('/org-roles'),
    // Module access requests (a member requests a module for a colleague)
    moduleColleagues:   () => api.get('/module-requests/colleagues'),
    grantableModules:   (target) => api.get(`/module-requests/grantable?target=${target}`),
    myGrantableModules: () => api.get('/module-requests/my-grantable'),
    requestNewUserModule: (email, moduleKey) => api.post('/module-requests/invite-new', { email, moduleKey }),
    myModuleRequests:   () => api.get('/module-requests/mine'),
    requestModuleFor:   (targetUserId, moduleKey, reason) => api.post('/module-requests', { targetUserId, moduleKey, reason }),
    pendingModuleRequests: () => api.get('/module-requests/pending'),
    reviewModuleRequest: (id, body) => api.post(`/module-requests/${id}/review`, body),
    // Unified admin approvals queue
    getApprovals:    () => api.get('/approvals'),
    reviewApproval:  (body) => api.post('/approvals/review', body),
    // Project members (internal team, request/approve) + org email domains
    members:        (id)          => api.get(`/project-members/handovers/${id}/members`),
    requestMember:  (id, data)    => api.post(`/project-members/handovers/${id}/members`, data),
    // Change an existing member's role or side. There was no way to do this
    // before — members could only be added and removed.
    updateMember:   (id, mid, data) => api.patch(`/project-members/handovers/${id}/members/${mid}`, data),
    // Phone only. Email is the login identity and is read-only by design.
    updateMemberContact: (id, mid, data) =>
      api.patch(`/project-members/handovers/${id}/members/${mid}/contact`, data),
    // Keyed on the USER — reaches deal-team members, who have no
    // project_members row.
    updateUserContact: (id, userId, data) =>
      api.patch(`/project-members/handovers/${id}/users/${userId}/contact`, data),
    reviewMember:   (id, mid, b)  => api.post(`/project-members/handovers/${id}/members/${mid}/review`, b),
    removeMember:   (id, mid)     => api.delete(`/project-members/handovers/${id}/members/${mid}`),
    orgDomains:     ()            => api.get('/project-members/domains'),
    addOrgDomain:   (domain)      => api.post('/project-members/domains', { domain }),
    removeOrgDomain:(did)         => api.delete(`/project-members/domains/${did}`),
    toggleModule: (enabled) => api.patch('/handovers/admin/module', { enabled }),
  },


  // ══════════════════════════════════════════════════════════
  // Daily work Tracking
  // ══════════════════════════════════════════════════════════

  dailyWork: {
    // ── member ───────────────────────────────────────────────────────────
    getDay:  (date)    => api.get('/daily-work/day', { params: date ? { date } : {} }),
    saveDay: (entries) => api.post('/daily-work/day', { entries }),

    getAnchors: () => api.get('/daily-work/anchors'),

    createItem: ({ kind, title, activityTypeKey, anchorKind, anchorId, targetDate }) =>
      api.post('/daily-work/items', {
        kind, title, activityTypeKey, anchorKind, anchorId, targetDate,
      }),

    // The shared list, used by every picker: the per-row dropdown, the
    // add-item form, and the manager's merge target.
    listActivityTypes: () => api.get('/daily-work/activity-types'),

    // The management screen's view: retired types included, so it can show
    // what it retired and offer to bring it back. Pickers use the plain
    // listActivityTypes above, which never returns retired ones.
    listAllActivityTypes: () =>
      api.get('/daily-work/activity-types', { params: { retired: 'true' } }),

    // Manager/admin: add straight to the shared list, rename, retire, restore.
    createActivityType: (label) =>
      api.post('/daily-work/activity-types/manage', { label }),
    renameActivityType: (key, label) =>
      api.patch(`/daily-work/activity-types/${encodeURIComponent(key)}`, { label }),
    setActivityTypeRetired: (key, retired) =>
      api.patch(`/daily-work/activity-types/${encodeURIComponent(key)}`, { retired }),

    proposeActivityType: (label) => api.post('/daily-work/activity-types', { label }),

    // Changing an item's activity or anchor affects entries written FROM NOW
    // ON. Entries already saved keep their own snapshot, so correcting a
    // mis-categorised item today does not rewrite last month.
    updateItem: (itemId, patch) => api.patch(`/daily-work/items/${itemId}`, patch),

    attachEvidence: (entryId, { note, channel = 'manual', storageFileId = null }) =>
      api.post(`/daily-work/entries/${entryId}/evidence`, { note, channel, storageFileId }),

    // Revoked rows come back too, marked. Evidence is immutable, so a
    // correction is a withdrawal plus a replacement — never an edit.
    listEvidence:    (entryId) => api.get(`/daily-work/entries/${entryId}/evidence`),
    revokeEvidence:  (id, reason) => api.post(`/daily-work/evidence/${id}/revoke`, { reason }),
    replaceEvidence: (id, { note, reason }) =>
      api.post(`/daily-work/evidence/${id}/replace`, { note, reason }),

    listDepartments: () => api.get('/daily-work/departments'),

    // The rows behind the overdue chip. Carries userId, not a name — the
    // People screen already has names from the rollup.
    overdue: () => api.get('/daily-work/people/overdue'),

    // Ask whether a project task link is still worth following before
    // navigating. Resolves with { ok, scope, project } or rejects with a 403
    // whose body carries `reason` — the caller shows that text rather than
    // inventing its own, so the explanation stays with the rule that produced
    // it.
    checkProjectLink: (userId, handoverId) =>
      api.get(`/daily-work/people/${userId}/project/${handoverId}`),

    // ── setup, owner and admin only ──────────────────────────────────
    listCalendars:      () => api.get('/daily-work/calendars'),
    createCalendar:     ({ name, isDefault }) => api.post('/daily-work/calendars', { name, isDefault }),
    setDefaultCalendar: (id) => api.post(`/daily-work/calendars/${id}/default`),
    deleteCalendar:     (id) => api.delete(`/daily-work/calendars/${id}`),
    // Many at once: nobody wants to click through fourteen dates.
    addHolidays:        (id, dates) => api.post(`/daily-work/calendars/${id}/dates`, { dates }),
    removeHoliday:      (id) => api.delete(`/daily-work/holidays/${id}`),

    listSchedules: () => api.get('/daily-work/schedules'),
    // Effective-dated: this adds a row, it does not rewrite the old one, so
    // past rates keep being computed against the week that was in force then.
    setSchedule:   (userId, { weekdayMask, holidayCalendarId, effectiveFrom }) =>
      api.put(`/daily-work/schedules/${userId}`, { weekdayMask, holidayCalendarId, effectiveFrom }),
    // Set deliberately by an admin. The browser no longer fills this at login —
    // it decides which day someone's work counts for.
    setUserTimezone: (userId, timezone) =>
      api.put(`/daily-work/schedules/${userId}/timezone`, { timezone }),

    // Recurring work only. Assigned items take their status from the day's
    // stage, so this path refuses them.
    retireItem: (itemId) => api.patch(`/daily-work/items/${itemId}`, { status: 'retired' }),
    reopenItem: (itemId) => api.patch(`/daily-work/items/${itemId}`, { status: 'active' }),

    // ── manager ──────────────────────────────────────────────────────────
    // `filters` accepts { account, anchorKind, anchorId, activity, department }.
    // Anything else is dropped server-side, so a stray key is harmless.
    teamLog: ({ from, to, users, ...filters } = {}) =>
      api.get('/daily-work/team/log', { params: { from, to, users, ...filters } }),

    // Cross-module (2026_133). The project side of one person's work, so the
    // daily work person view is not a dead end. Scoped server-side to the
    // viewer's own chain and returns empty rather than 403 for anyone outside
    // it. 404 when the Projects module is off for this org — the caller hides
    // the panel rather than showing an error for a module they do not have.
    personProjectSummary: (userId) =>
      api.get(`/handovers/team-members/${userId}/project-summary`),

    teamDayDetail: ({ user, date, ...filters }) =>
      api.get('/daily-work/team/day-detail', { params: { user, date, ...filters } }),

    teamRollup: ({ from, to, users, ...filters } = {}) =>
      api.get('/daily-work/team/rollup', { params: { from, to, users, ...filters } }),

    // ── the People screen ────────────────────────────────────────────────
    // One row per person the viewer may see, carrying both the logging record
    // and the open project work owed. Replaced the separate team rollup call
    // on that screen; teamRollup is still used elsewhere.
    people: ({ from, to, users, ...filters } = {}) =>
      api.get('/daily-work/people', { params: { from, to, users, ...filters } }),

    // One person: their daily work log and their project items, returned
    // SEPARATELY. An entry is anchored to the day it was done, a task to the
    // day it is due — the client interleaves them and keeps them labelled.
    person: (userId, { from, to, ...filters } = {}) =>
      api.get(`/daily-work/people/${userId}`, { params: { from, to, ...filters } }),

    accountSummary: ({ account, from, to, users }) =>
      api.get('/daily-work/team/account-summary', { params: { account, from, to, users } }),

    stalled: ({ users, staleDays } = {}) =>
      api.get('/daily-work/team/stalled', { params: { users, staleDays } }),

    candidates: () => api.get('/daily-work/team/candidates'),

    assign: ({ ownerUserId, kind = 'assigned', title, activityTypeKey,
               anchorKind, anchorId, targetDate }) =>
      api.post('/daily-work/items/assign', {
        ownerUserId, kind, title, activityTypeKey, anchorKind, anchorId, targetDate,
      }),

    promoteActivityType: (key) => api.post(`/daily-work/activity-types/${key}/promote`),
    mergeActivityType:   (key, intoKey) =>
      api.post(`/daily-work/activity-types/${key}/merge`, { intoKey }),
  },
 

  // ══════════════════════════════════════════════════════════
  // Microsoft Teams channel
  // ══════════════════════════════════════════════════════════

  // Delegated and READ-ONLY: every call runs as the signed-in rep and sees
  // exactly the chats and channels that rep is already in. There is no send
  // endpoint here and the OAuth scopes cannot send.
  //
  // Named msteams and not teams because /api/org/admin already serves
  // teams.routes.js — the SALES TEAM hierarchy. Two different things called
  // "teams" is a bug waiting for a tired evening.
  //
  // Phase 0 discovers and triages; it captures nothing. Message search arrives
  // through whatsappMessages.search()'s channel registry, not here.
  msteams: {
    status:          ()        => api.get('/msteams/status'),
    connect:         ()        => api.get('/msteams/connect'),
    // The URL a TENANT ADMIN opens once to approve the app org-wide. Needed
    // because reading Teams channels cannot be consented to by a normal user —
    // ChannelMessage.Read.All is admin-consent-required even as a delegated
    // scope. Admin-only server-side.
    adminConsentUrl: ()        => api.get('/msteams/admin-consent-url'),
    disconnect:      ()        => api.post('/msteams/disconnect'),

    // Discovery normally runs hourly on the worker, because nothing in Graph
    // notifies us that a rep joined a channel. This is the "I was added to
    // that channel two minutes ago" button.
    discover:        ()        => api.post('/msteams/discover'),

    // params: { status, watched, q, limit }. Scoped server-side to the
    // CALLER'S OWN connection — two reps in the same channel each see and
    // decide on their own row.
    conversations:   (params = {}) =>
      api.get(`/msteams/conversations?${new URLSearchParams(params).toString()}`),

    // Both take { conversationIds: number[] } plus watched / ignored.
    // Bulk by design: a rep in forty channels triages in sweeps, not one
    // dialog at a time.
    watch:           (body)    => api.post('/msteams/conversations/watch', body),
    ignore:          (body)    => api.post('/msteams/conversations/ignore', body),

    // body: { mode: 'project'|'account'|'pool', handoverId?, accountId?,
    //         candidateIds?, force? }
    //
    // A 409 with code NEEDS_FORCE is not a failure — it is the server asking to
    // confirm a transition that loses something (dropping a project link, or
    // declining to back-fill). Show the message, then retry with force: true.
    bind:            (id, body) => api.post(`/msteams/conversations/${id}/bind`, body),
    unbind:          (id)       => api.post(`/msteams/conversations/${id}/unbind`),

    // Pauses capture WITHOUT tearing down the connection — deliberately not
    // the same thing as disconnecting, so a freeze window does not cost a
    // re-consent. body: { enabled: boolean }
    capture:         (body)    => api.post('/msteams/capture', body),
  },

  // ══════════════════════════════════════════════════════════
  // WhatsApp channel
  // ══════════════════════════════════════════════════════════

  // Communication -> Messages. Authorisation is per-message and server-side:
  // scoped by WhatsApp group participation plus project membership.
  whatsappMessages: {
    search:         (params={}) => api.get(`/whatsapp-messages/search?${new URLSearchParams(params).toString()}`),
    channels:       ()          => api.get('/whatsapp-messages/channels'),
    diagnose:       (body)      => api.post('/whatsapp-messages/diagnose', body),
    file:           (id, body)  => api.post(`/whatsapp-messages/${id}/file`, body),
    exclude:        (id, body)  => api.post(`/whatsapp-messages/${id}/exclude`, body),
    audit:          (limit)     => api.get(`/whatsapp-messages/audit${limit ? `?limit=${limit}` : ''}`),

    identity:       ()          => api.get('/whatsapp-messages/identity/me'),
    identities:     ()          => api.get('/whatsapp-messages/identity'),
    setIdentity:    (userId, body) => api.put(`/whatsapp-messages/identity/${userId}`, body),

    requestCapture: (body)      => api.post('/whatsapp-messages/capture-requests', body),
    captureRequests:(status)    => api.get(`/whatsapp-messages/capture-requests${status ? `?status=${status}` : ''}`),
    decideRequest:  (id, body)  => api.post(`/whatsapp-messages/capture-requests/${id}/decide`, body),

    stewards:       ()          => api.get('/whatsapp-messages/stewards'),
    grantSteward:   (body)      => api.post('/whatsapp-messages/stewards', body),
    revokeSteward:  (userId)    => api.delete(`/whatsapp-messages/stewards/${userId}`),
  },

  // Session capture (companion-device client). Separate transport from the
  // Cloud API block below — different number, read-only, sees phone-created groups.
  whatsappSession: {
    status:         ()          => api.get('/whatsapp-session'),
    create:         (data)      => api.post('/whatsapp-session', data),
    disable:        ()          => api.delete('/whatsapp-session'),
    qr:             ()          => api.get('/whatsapp-session/qr'),
    updateSettings: (data)      => api.put('/whatsapp-session/settings', data),
    phoneSeen:      ()          => api.post('/whatsapp-session/phone-seen'),
    triage:         (status)    => api.get(`/whatsapp-session/triage${status ? `?status=${status}` : ''}`),
    triageQuery:    (params={})  => api.get(`/whatsapp-session/triage?${new URLSearchParams(params).toString()}`),
    watch:          (body)      => api.post('/whatsapp-session/triage/watch', body),
    watchJid:       (body)      => api.post('/whatsapp-session/triage/watch-jid', body),
    // body: { mode: 'project'|'account'|'pool', handoverId?, accountId?,
    //         candidateIds?: number[], force?: boolean }
    // mode defaults to 'project' server-side, so { handoverId } alone still
    // works exactly as it did before conversation bindings existed.
    // A 409 with code NEEDS_FORCE means the change would break an existing
    // decision: show the message it carries and re-send with force: true.
    bind:           (id, body)  => api.post(`/whatsapp-session/triage/${id}/bind`, body),
    // Back to legacy behaviour. Does not restore a cleared project link and
    // does not retract anything already filed.
    unbind:         (id)        => api.post(`/whatsapp-session/triage/${id}/unbind`),
    // Bind by THREAD id — direct threads, and binds initiated from the vendor
    // panel. body: { mode: 'account', accountId, force? }. 409 NEEDS_FORCE
    // means an existing project link would be cleared; re-send with force.
    bindThread:     (threadId, body) => api.post(`/whatsapp-session/threads/${threadId}/bind`, body),
    ignore:         (id)        => api.post(`/whatsapp-session/triage/${id}/ignore`),
    // Per-group attachment policy. Bulk, like the watch routes: a number in
    // eighty groups is configured in sweeps, not one dialog at a time.
    // policy: 'inherit' | 'all' | 'documents' | 'none'
    mediaPolicy:    (body)      => api.post('/whatsapp-session/triage/media-policy', body),
  },

  whatsapp: {
    account:        ()         => api.get('/whatsapp/account'),
    connect:        (data)     => api.post('/whatsapp/connect', data),
    disconnect:     ()         => api.delete('/whatsapp/account'),
    handoverThread: (id)       => api.get(`/whatsapp/handovers/${id}/thread`),
    sendTargets:    (id)       => api.get(`/whatsapp/handovers/${id}/targets`),
    // Moving a misfiled message. moveTargets is a short, permission-checked
    // list of the projects this conversation actually touches — not every
    // project in the org.
    moveTargets:    (messageId)       => api.get(`/whatsapp/messages/${messageId}/move-targets`),
    moveMessage:    (messageId, body) => api.post(`/whatsapp/messages/${messageId}/move`, body),
    templates:      ()         => api.get(`/whatsapp/templates`),
    // Org-authored template governance (Stage 2)
    tplMine:    ()          => api.get('/whatsapp-templates/mine'),
    tplAll:     ()          => api.get('/whatsapp-templates/all'),
    tplUsable:  ()          => api.get('/whatsapp-templates/usable'),
    tplPropose: (data)      => api.post('/whatsapp-templates', data),
    tplReview:  (id, body)  => api.post(`/whatsapp-templates/${id}/review`, body),
    tplSubmit:  (id)        => api.post(`/whatsapp-templates/${id}/submit`),
    // Usage & billing (Stage 2)
    usage:        (q = '')  => api.get(`/whatsapp-billing/usage${q}`),
    billingConfig:()        => api.get('/whatsapp-billing/config'),
    setBilling:   (data)    => api.put('/whatsapp-billing/config', data),
    adminUsage:   (q = '')  => api.get(`/whatsapp-billing/admin/usage${q}`),
    adminSetBilling: (orgId, data) => api.put(`/whatsapp-billing/admin/config/${orgId}`, data),
    sendToHandover: (id, body) => api.post(`/whatsapp/handovers/${id}/messages`, body),
    // Groups API: create an API-managed group (mirrored as a group thread) and
    // return its invite link. Pass { subject, handoverId } to link it to a handover.
    createGroup:    (body)     => api.post('/whatsapp/groups', body),
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

  // ── Mongo migration preview (read-only) ──────────────────────────────
  preview: {
    me: () => api.get('/preview/me'),
    getContacts: (opts = {}) => {
      const params = new URLSearchParams();
      if (opts.q)         params.set('q', opts.q);
      if (opts.limit)     params.set('limit', String(opts.limit));
      if (opts.offset)    params.set('offset', String(opts.offset));
      if (opts.workspace) params.set('workspace', opts.workspace);
      return api.get(`/preview/contacts?${params.toString()}`);
    },
    getTimeline: (contactId) => api.get(`/preview/contacts/${contactId}/timeline`),
    byProspectTimeline: (prospectId) => api.get(`/preview/by-prospect/${prospectId}/timeline`),
    getEmail: (messageId) => api.get(`/preview/emails/${encodeURIComponent(messageId)}`),
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
  // params: { environment: 'production'|'sandbox'|'custom', login_url?, purpose? }
  getAuthUrl: async (params = {}) => {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== ''))
    ).toString();
    const response = await fetch(`${API_BASE_URL}/salesforce/connect${qs ? `?${qs}` : ''}`, { headers: getAuthHeaders() });
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

export const slackAPI = {
  getAuthUrl: async () => {
    const response = await fetch(`${API_BASE_URL}/slack/connect`, { headers: getAuthHeaders() });
    return response.json();
  },
  getStatus: async () => {
    const response = await fetch(`${API_BASE_URL}/slack/status`, { headers: getAuthHeaders() });
    return response.json();
  },
  disconnect: async () => {
    const response = await fetch(`${API_BASE_URL}/slack/disconnect`, { method: 'POST', headers: getAuthHeaders() });
    return response.json();
  },
};

export const hubspotAPI = {
  getAuthUrl: async () => {
    const response = await fetch(`${API_BASE_URL}/hubspot/connect`, { headers: getAuthHeaders() });
    if (!response.ok) { const e = await response.json().catch(() => ({})); throw new Error(e.error || 'Failed to get HubSpot auth URL'); }
    return response.json();
  },
  getStatus: async () => {
    const response = await fetch(`${API_BASE_URL}/hubspot/status`, { headers: getAuthHeaders() });
    if (!response.ok) throw new Error('Failed to get HubSpot status');
    return response.json();
  },
  disconnect: async () => {
    const response = await fetch(`${API_BASE_URL}/hubspot/disconnect`, { method: 'POST', headers: getAuthHeaders() });
    if (!response.ok) throw new Error('Failed to disconnect HubSpot');
    return response.json();
  },
  triggerSync: async () => {
    const response = await fetch(`${API_BASE_URL}/hubspot/trigger`, { method: 'POST', headers: getAuthHeaders() });
    if (!response.ok) throw new Error('Failed to trigger HubSpot sync');
    return response.json();
  },
  getSettings: async () => {
    const response = await fetch(`${API_BASE_URL}/hubspot/settings`, { headers: getAuthHeaders() });
    if (!response.ok) throw new Error('Failed to get HubSpot settings');
    return response.json();
  },
  updateSettings: async (settings) => {
    const response = await fetch(`${API_BASE_URL}/hubspot/settings`, {
      method: 'PATCH', headers: getAuthHeaders(), body: JSON.stringify(settings),
    });
    if (!response.ok) { const e = await response.json().catch(() => ({})); throw new Error(e.error || 'Failed to save HubSpot settings'); }
    return response.json();
  },
  getStages: async () => {
    const response = await fetch(`${API_BASE_URL}/hubspot/stages`, { headers: getAuthHeaders() });
    if (!response.ok) throw new Error('Failed to fetch HubSpot stages');
    return response.json();
  },
  // ── P8 — Form inflow (activity webhooks) ────────────────────────────────
  getInflow: async (status) => {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    const response = await fetch(`${API_BASE_URL}/hubspot/inflow${qs}`, { headers: getAuthHeaders() });
    if (!response.ok) throw new Error('Failed to fetch inflow events');
    return response.json();
  },
  approveInflow: async (id) => {
    const response = await fetch(`${API_BASE_URL}/hubspot/inflow/${id}/approve`, { method: 'POST', headers: getAuthHeaders() });
    if (!response.ok) { const e = await response.json().catch(() => ({})); throw new Error(e.error || 'Failed to approve event'); }
    return response.json();
  },
  dismissInflow: async (id) => {
    const response = await fetch(`${API_BASE_URL}/hubspot/inflow/${id}/dismiss`, { method: 'POST', headers: getAuthHeaders() });
    if (!response.ok) { const e = await response.json().catch(() => ({})); throw new Error(e.error || 'Failed to dismiss event'); }
    return response.json();
  },
};
