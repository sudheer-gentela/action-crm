// ─────────────────────────────────────────────────────────────
// previewApi.js  —  DROP-IN addition to apiService
//
// Add this block into the exported `apiService` object in
// frontend/src/apiService.js (alongside `accounts`, `contacts`, ...):
//
//   preview: previewApi,
//
// It reuses the same axios `api` instance / auth interceptor, so it
// inherits the Bearer token automatically. Read-only endpoints that
// surface the migrated Mongo data staged for validation.
// ─────────────────────────────────────────────────────────────

// If you prefer, paste just the `preview: { ... }` object literal below
// directly into apiService. This file shows it as a standalone for clarity.

export const previewApi = {
  // whether the logged-in user has migrated preview data + counts
  me: () => api.get('/preview/me'),

  // paginated, searchable list of the user's contacts WITH activity
  //   opts: { q, limit, offset, workspace }
  getContacts: (opts = {}) => {
    const params = new URLSearchParams();
    if (opts.q)         params.set('q', opts.q);
    if (opts.limit)     params.set('limit', String(opts.limit));
    if (opts.offset)    params.set('offset', String(opts.offset));
    if (opts.workspace) params.set('workspace', opts.workspace);
    return api.get(`/preview/contacts?${params.toString()}`);
  },

  // full merged timeline (email + linkedin + tags + connection status)
  getTimeline: (contactId) => api.get(`/preview/contacts/${contactId}/timeline`),
};

// ── INTEGRATION NOTE ─────────────────────────────────────────
// In apiService.js, inside `export const apiService = { ... }`, add:
//
//   preview: {
//     me: () => api.get('/preview/me'),
//     getContacts: (opts = {}) => {
//       const params = new URLSearchParams();
//       if (opts.q)         params.set('q', opts.q);
//       if (opts.limit)     params.set('limit', String(opts.limit));
//       if (opts.offset)    params.set('offset', String(opts.offset));
//       if (opts.workspace) params.set('workspace', opts.workspace);
//       return api.get(`/preview/contacts?${params.toString()}`);
//     },
//     getTimeline: (contactId) => api.get(`/preview/contacts/${contactId}/timeline`),
//   },
//
// (uses the existing module-scoped `api` axios instance)
