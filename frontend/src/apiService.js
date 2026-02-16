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
    delete: (id) => api.delete(`/accounts/${id}`)
  },

  // Contacts
  contacts: {
    getAll: () => api.get('/contacts'),
    getById: (id) => api.get(`/contacts/${id}`),
    getByAccount: (accountId) => api.get(`/contacts?account_id=${accountId}`),
    create: (data) => api.post('/contacts', data),
    update: (id, data) => api.put(`/contacts/${id}`, data),
    delete: (id) => api.delete(`/contacts/${id}`)
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
    send: (id) => api.post(`/emails/${id}/send`),
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
    getAll: () => api.get('/actions'),
    getById: (id) => api.get(`/actions/${id}`),
    create: (data) => api.post('/actions', data),
    update: (id, data) => api.put(`/actions/${id}`, data),
    complete: (id) => api.patch(`/actions/${id}`, { completed: true }),
    delete: (id) => api.delete(`/actions/${id}`)
  }
};


// ============================================================
// OUTLOOK & SYNC APIs
// ============================================================

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
