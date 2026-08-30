// ─────────────────────────────────────────────────────────────────────────────
// Add to frontend/src/apiService.js, inside the `apiService` object.
//
// Place it alphabetically near `handovers`. It uses the shared `api` axios
// instance, so the auth interceptor and base URL apply automatically — do not
// build URLs with API_URL by hand here.
//
// Two conventions worth keeping:
//
//   Dates are STRINGS, 'YYYY-MM-DD', both directions. The backend deliberately
//   casts every date column to text because node-postgres parses DATE at local
//   midnight, which reports the previous day for anyone east of UTC. Passing a
//   JS Date into any of these, or calling .toISOString() on what comes back,
//   reintroduces exactly that bug.
//
//   The day's date is NEVER sent when saving. The server resolves it from the
//   owner's timezone. Sending it would let a browser choose which day its work
//   counted for.
// ─────────────────────────────────────────────────────────────────────────────

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

    proposeActivityType: (label) => api.post('/daily-work/activity-types', { label }),

    // Changing an item's activity or anchor affects entries written FROM NOW
    // ON. Entries already saved keep their own snapshot, so correcting a
    // mis-categorised item today does not rewrite last month.
    updateItem: (itemId, patch) => api.patch(`/daily-work/items/${itemId}`, patch),

    attachEvidence: (entryId, { note, channel = 'manual', storageFileId = null }) =>
      api.post(`/daily-work/entries/${entryId}/evidence`, { note, channel, storageFileId }),

    // ── manager ──────────────────────────────────────────────────────────
    // `filters` accepts { account, anchorKind, anchorId, activity, department }.
    // Anything else is dropped server-side, so a stray key is harmless.
    teamLog: ({ from, to, users, ...filters } = {}) =>
      api.get('/daily-work/team/log', { params: { from, to, users, ...filters } }),

    teamDayDetail: ({ user, date, ...filters }) =>
      api.get('/daily-work/team/day-detail', { params: { user, date, ...filters } }),

    teamRollup: ({ from, to, users, ...filters } = {}) =>
      api.get('/daily-work/team/rollup', { params: { from, to, users, ...filters } }),

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
