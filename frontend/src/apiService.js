/**
 * API Utility - Centralized API calls
 * All API endpoints defined here to avoid reference issues
 */

import axios from 'axios';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001/api';
const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001/api';

// Helper to get auth headers
const getAuthHeaders = () => {
  const token = localStorage.getItem('token');
  return {
    'Content-Type': 'application/json',
    ...(token && { 'Authorization': `Bearer ${token}` })
  };
};

// Create axios instance
const api = axios.create({
  baseURL: API_URL,
});

// Add token to all requests
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// API endpoints
export const apiService = {
  // Accounts
  accounts: {
    getAll: () => api.get('/accounts'),
    getById: (id) => api.get(`/accounts/${id}`),
    create: (data) => api.post('/accounts', data),
    update: (id, data) => api.put(`/accounts/${id}`, data),
    delete: (id) => api.delete(`/accounts/${id}`),
    getDuplicates: () => api.get('/accounts/duplicates'),
    merge: (keepId, removeId, fieldOverrides = {}) =>
      api.post('/accounts/merge', { keepId, removeId, fieldOverrides }),
  },

  // Contacts
  contacts: {
    getAll: () => api.get('/contacts'),
    getById: (id) => api.get(`/contacts/${id}`),
    getByAccount: (accountId) => api.get(`/contacts?account_id=${accountId}`),
    create: (data) => api.post('/contacts', data),
    update: (id, data) => api.put(`/contacts/${id}`, data),
    delete: (id) => api.delete(`/contacts/${id}`),
    getDuplicates: () => api.get('/contacts/duplicates'),
    merge: (keepId, removeId, fieldOverrides = {}) =>
      api.post('/contacts/merge', { keepId, removeId, fieldOverrides }),
  },

  // Deals
  deals: {
    getAll: () => api.get('/deals'),
    getById: (id) => api.get(`/deals/${id}`),
    getByAccount: (accountId) => api.get(`/deals?account_id=${accountId}`),
    create: (data) => api.post('/deals', data),
    update: (id, data) => api.put(`/deals/${id}`, data),
    delete: (id) => api.delete(`/deals/${id}`)
  },

  // Emails
  emails: {
    getAll: () => api.get('/emails'),
    getById: (id) => api.get(`/emails/${id}`),
    getByContact: (contactId) => api.get(`/emails?contact_id=${contactId}`),
    getByDeal: (dealId) => api.get(`/emails?deal_id=${dealId}`),
    create: (data) => api.post('/emails', data),
    send: (data) => {
      // If data is a number/string, it's a legacy call to send an existing email by id
      if (typeof data === 'number' || typeof data === 'string') {
        return api.post(`/emails/${data}/send`);
      }
      // Otherwise it's a compose+send with { contact_id, deal_id, subject, body, toAddress }
      return api.post('/emails/compose', data);
    },
    compose: (data) => api.post('/emails/compose', data),
    delete: (id) => api.delete(`/emails/${id}`)
  },

  // Meetings
  meetings: {
    getAll: () => api.get('/meetings'),
    getById: (id) => api.get(`/meetings/${id}`),
    getByDeal: (dealId) => api.get(`/meetings?deal_id=${dealId}`),
    create: (data) => api.post('/meetings', data),
    update: (id, data) => api.put(`/meetings/${id}`, data),
    delete: (id) => api.delete(`/meetings/${id}`)
  },

  // Actions
  actions: {
    getAll:     (params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return api.get(`/actions${qs ? '?' + qs : ''}`);
    },
    getById:    (id)          => api.get(`/actions/${id}`),
    create:     (data)        => api.post('/actions', data),
    update:     (id, data)    => api.put(`/actions/${id}`, data),
    delete:     (id)          => api.delete(`/actions/${id}`),

    // Status
    updateStatus: (id, status) => api.patch(`/actions/${id}/status`, { status }),
    complete:     (id)         => api.patch(`/actions/${id}/complete`),

    // Snooze
    snooze:   (id, reason, duration) => api.patch(`/actions/${id}/snooze`,   { reason, duration }),
    unsnooze: (id)                   => api.patch(`/actions/${id}/unsnooze`),

    // Generation (optionally scoped to a deal — snoozed actions are skipped by the generator)
    generate: (dealId = null) => api.post('/actions/generate', dealId ? { dealId } : {}),

    // Config
    getConfig:    ()     => api.get('/actions/config'),
    updateConfig: (data) => api.put('/actions/config', data),

    // Suggestions
    getSuggestions:    (actionId)     => api.get(`/actions/${actionId}/suggestions`),
    acceptSuggestion:  (suggestionId) => api.post(`/actions/suggestions/${suggestionId}/accept`),
    dismissSuggestion: (suggestionId) => api.post(`/actions/suggestions/${suggestionId}/dismiss`),
  },

  // Transcripts
  transcripts: {
    getAll: () => api.get('/transcripts'),
    getById: (id) => api.get(`/transcripts/${id}`),
    upload: (formData) => {
      return axios.post(`${API_URL}/transcripts/upload`, formData, {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        }
      });
    },
    analyze: (id) => api.post(`/transcripts/${id}/analyze`),
    delete: (id) => api.delete(`/transcripts/${id}`)
  },

  // Deal Health
  health: {
    scoreDeal:      (id)                                            => api.post(`/deals/${id}/score`),
    scoreAll:       ()                                              => api.post('/deals/score-all'),
    updateSignals:  (id, signals)                                   => api.patch(`/deals/${id}/signals`, signals),
    signalOverride: (id, signalKey, value, managerOverride = false) => api.patch(`/deals/${id}/signal-override`, { signalKey, value, managerOverride }),
  },

  // Health Config
  healthConfig: {
    get:  ()     => api.get('/health-config'),
    save: (data) => api.put('/health-config', data),
  },

  // Competitors
  competitors: {
    getAll: ()          => api.get('/competitors'),
    create: (data)      => api.post('/competitors', data),
    update: (id, data)  => api.put(`/competitors/${id}`, data),
    delete: (id)        => api.delete(`/competitors/${id}`),
  },

  // Sales Playbook (single, legacy)
  playbook: {
    get:  ()     => api.get('/playbook'),
    save: (data) => api.put('/playbook', data),
  },

  // Playbooks (multi-playbook per org)
  playbooks: {
    getAll:     ()         => api.get('/playbooks'),
    getDefault: ()         => api.get('/playbooks/default'),
    getById:    (id)       => api.get(`/playbooks/${id}`),
    create:     (data)     => api.post('/playbooks', data),
    update:     (id, data) => api.put(`/playbooks/${id}`, data),
    setDefault: (id)       => api.post(`/playbooks/${id}/set-default`),
    delete:     (id)       => api.delete(`/playbooks/${id}`),
  },

  // Deal Stages
  dealStages: {
    getAll:    ()         => api.get('/deal-stages'),
    getActive: ()         => api.get('/deal-stages/active'),
    create:    (data)     => api.post('/deal-stages', data),
    update:    (id, data) => api.put(`/deal-stages/${id}`, data),
    delete:    (id)       => api.delete(`/deal-stages/${id}`),
  },

  // Deal Contacts (link contacts to deals with roles)
  dealContacts: {
    getByDeal:    (dealId)              => api.get(`/deals/${dealId}/contacts`),
    add:          (dealId, contactId, role) => api.post(`/deals/${dealId}/contacts`, { contactId, role }),
    updateRole:   (dealId, contactId, role) => api.put(`/deals/${dealId}/contacts/${contactId}`, { role }),
    remove:       (dealId, contactId)       => api.delete(`/deals/${dealId}/contacts/${contactId}`),
  },

  // AI Prompts
  prompts: {
    get:        ()    => api.get('/prompts'),
    save:       (data) => api.put('/prompts', data),
    reset:      (key) => api.delete(`/prompts/${key}`),
  },

  // ── Agentic Framework ─────────────────────────────────────────
  agent: {
    getProposals:     (params = {}) => {
      const q = new URLSearchParams();
      if (params.status)       q.set('status', params.status);
      if (params.proposalType) q.set('proposalType', params.proposalType);
      if (params.dealId)       q.set('dealId', params.dealId);
      if (params.limit)        q.set('limit', params.limit);
      const qs = q.toString();
      return api.get(`/agent/proposals${qs ? '?' + qs : ''}`);
    },
    getCount:         ()              => api.get('/agent/proposals/count'),
    getById:          (id)            => api.get(`/agent/proposals/${id}`),
    approve:          (id, body = {}) => api.post(`/agent/proposals/${id}/approve`, body),
    reject:           (id, body = {}) => api.post(`/agent/proposals/${id}/reject`, body),
    editPayload:      (id, payload)   => api.patch(`/agent/proposals/${id}/payload`, { payload }),
    bulkApprove:      (ids)           => api.post('/agent/proposals/bulk-approve', { proposalIds: ids }),
    bulkReject:       (ids, reason)   => api.post('/agent/proposals/bulk-reject', { proposalIds: ids, reason }),
    getStatus:        ()              => api.get('/agent/status'),
    getDealProposals: (dealId)        => api.get(`/agent/deals/${dealId}/proposals`),
    getTokenUsage:    (days = 30)     => api.get(`/agent/token-usage?days=${days}`),
    admin: {
      updateSettings: (settings)      => api.patch('/agent/admin/settings', settings),
      getStats:       (days = 30)     => api.get(`/agent/admin/stats?days=${days}`),
      getTokenUsage:  (days = 30)     => api.get(`/agent/admin/token-usage?days=${days}`),
    },
  },



  // ── Super Admin (platform-level) ─────────────────────────────
  superAdmin: {
    getStats:          ()                        => api.get('/super/stats'),
    getOrgs:           (params = {})             => api.get('/super/orgs', { params }),
    getOrg:            (orgId)                   => api.get(`/super/orgs/${orgId}`),
    createOrg:         (data)                    => api.post('/super/orgs', data),
    updateOrg:         (orgId, data)             => api.patch(`/super/orgs/${orgId}`, data),
    suspendOrg:        (orgId, data)             => api.post(`/super/orgs/${orgId}/suspend`, data),
    impersonateOrg:    (orgId)                   => api.post(`/super/orgs/${orgId}/impersonate`),
    addUserToOrg:      (orgId, data)             => api.post(`/super/orgs/${orgId}/users`, data),
    createUserForOrg:  (orgId, data)             => api.post(`/super/orgs/${orgId}/users/create`, data),
    updateUserInOrg:   (orgId, userId, data)     => api.patch(`/super/orgs/${orgId}/users/${userId}`, data),
    removeUserFromOrg: (orgId, userId)           => api.delete(`/super/orgs/${orgId}/users/${userId}`),
    inviteUserToOrg:   (orgId, data)             => api.post(`/super/orgs/${orgId}/invites`, data),
    getInvites:        (orgId)                   => api.get(`/super/orgs/${orgId}/invites`),
    cancelInvite:      (orgId, inviteId)         => api.delete(`/super/orgs/${orgId}/invites/${inviteId}`),
    getAdmins:         ()                        => api.get('/super/admins'),
    grantAdmin:        (data)                    => api.post('/super/admins', data),
    revokeAdmin:       (userId)                  => api.delete(`/super/admins/${userId}`),
    getAuditLog:       (params = {})             => api.get('/super/audit', { params }),
  },

  // ── Org Admin (org-level) ─────────────────────────────────────
  orgAdmin: {
    getProfile:      ()               => api.get('/org/admin/profile'),
    updateProfile:   (data)           => api.patch('/org/admin/profile', data),
    getStats:        ()               => api.get('/org/admin/stats'),
    getMembers:      ()               => api.get('/org/admin/members'),
    updateMember:    (userId, data)   => api.patch(`/org/admin/members/${userId}`, data),
    removeMember:    (userId)         => api.delete(`/org/admin/members/${userId}`),
    getInvitations:  ()               => api.get('/org/admin/invitations'),
    sendInvitation:  (data)           => api.post('/org/admin/invitations', data),
    cancelInvitation:(id)             => api.delete(`/org/admin/invitations/${id}`),
    getDuplicateSettings: ()          => api.get('/org/admin/duplicate-settings'),
    updateDuplicateSettings: (data)   => api.patch('/org/admin/duplicate-settings', data),
    // Org-level integrations
    getIntegrations:      ()               => api.get('/org/admin/integrations'),
    updateIntegration:    (type, data)     => api.patch(`/org/admin/integrations/${type}`, data),
  },
};


// ============================================================
// OUTLOOK & SYNC APIs
// ============================================================

//const API_BASE_URL_SYNC = process.env.REACT_APP_API_URL || 'http://localhost:3001/api';

// Outlook API
export const outlookAPI = {
  getAuthUrl: async (userId) => {
    console.log('📤 Calling getAuthUrl with userId:', userId);
    
    const url = `${API_BASE_URL}/outlook/connect?userId=${userId}`;
    console.log('📤 Request URL:', url);
    
    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    console.log('📥 Response status:', response.status);
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('❌ Error response:', errorData);
      throw new Error(errorData.error || 'Failed to get auth URL');
    }
    
    return response.json();
  },

  getStatus: async (userId) => {
    const response = await fetch(`${API_BASE_URL}/outlook/status?userId=${userId}`, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error('Failed to get status');
    }
    
    return response.json();
  },

  disconnect: async (userId) => {
    const response = await fetch(`${API_BASE_URL}/outlook/disconnect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ userId })
    });
    
    if (!response.ok) {
      throw new Error('Failed to disconnect');
    }
    
    return response.json();
  },

  fetchEmails: async (userId, options = {}) => {
    const params = new URLSearchParams({
      top: options.top || 50,
      skip: options.skip || 0,
      ...(options.since && { since: options.since })
    });

    // ✅ Uses auth headers (this endpoint has authenticateToken middleware)
    const response = await fetch(`${API_BASE_URL}/emails/outlook?${params}`, {
      headers: getAuthHeaders()
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    return response.json();
  },

  processEmail: async (userId, emailId) => {
    // ✅ Uses auth headers (this endpoint has authenticateToken middleware)
    const response = await fetch(`${API_BASE_URL}/emails/process`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ userId, emailId })
    });
    
    if (!response.ok) {
      throw new Error('Failed to process email');
    }
    
    return response.json();
  }
};

// Google API
export const googleAPI = {
  getAuthUrl: async (userId) => {
    const response = await fetch(`${API_BASE_URL}/google/connect?userId=${userId}`, {
      headers: { 'Content-Type': 'application/json' }
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || 'Failed to get auth URL');
    }
    return response.json();
  },

  getStatus: async (userId) => {
    const response = await fetch(`${API_BASE_URL}/google/status?userId=${userId}`, {
      headers: { 'Content-Type': 'application/json' }
    });
    if (!response.ok) throw new Error('Failed to get status');
    return response.json();
  },

  disconnect: async (userId) => {
    const response = await fetch(`${API_BASE_URL}/google/disconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId })
    });
    if (!response.ok) throw new Error('Failed to disconnect');
    return response.json();
  },
};

// Sync API - ✅ FIXED: Use correct endpoints from sync.routes.js
export const syncAPI = {
  // ✅ FIXED: Changed from /sync/trigger to /sync/emails
  triggerSync: async (userId) => {
    const response = await fetch(`${API_BASE_URL}/sync/emails`, {
      method: 'POST',
      headers: getAuthHeaders()
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || 'Failed to trigger sync');
    }
    
    return response.json();
  },

  // ✅ FIXED: Changed from /sync/status to /sync/emails/status
  getStatus: async (userId) => {
    const response = await fetch(`${API_BASE_URL}/sync/emails/status`, {
      headers: getAuthHeaders()
    });
    
    if (!response.ok) {
      throw new Error('Failed to get sync status');
    }
    
    return response.json();
  },

  // ✅ NEW: Get sync configuration
  getConfig: async () => {
    const response = await fetch(`${API_BASE_URL}/sync/config`, {
      headers: getAuthHeaders()
    });
    
    if (!response.ok) {
      throw new Error('Failed to get sync config');
    }
    
    return response.json();
  }
};

export default api;
