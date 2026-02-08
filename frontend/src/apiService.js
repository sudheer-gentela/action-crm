/**
 * API Utility - Centralized API calls
 * All API endpoints defined here to avoid reference issues
 */

import axios from 'axios';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001/api';

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

export default api;
