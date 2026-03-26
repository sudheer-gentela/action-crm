// ============================================================
// ActionCRM Playbook Builder — B5: Access Resolver Service
// File: backend/services/PlaybookAccessResolver.js
// ============================================================

const { resolveAccess } = require('./PlaybookBuilderService');

/**
 * Thin wrapper around the access resolution logic.
 * Returns: 'owner' | 'reader' | null (null = no access)
 * Note: 'none' user_override is converted to null here so callers
 * see a consistent null === blocked API.
 */
async function resolve(playbook_id, user_id, org_id) {
  const level = await resolveAccess(playbook_id, user_id, org_id);
  return level === 'none' ? null : level;
}

module.exports = { resolve };


// ============================================================
// B7: ENTITY_CONFIG patch snippet
// Add this block to ENTITY_CONFIG in backend/services/playbook.service.js
// ============================================================

/*
  FIND in playbook.service.js:
  const ENTITY_CONFIG = {
    deals: { ... },
    contracts: { ... },
    // ... other entities
  };

  ADD this key inside ENTITY_CONFIG:

  registration: {
    table: 'playbook_registrations',
    idField: 'id',
    orgField: 'org_id',
    stageField: 'stage',
    nameField: 'name',
    ownerField: 'submitter_id',
    labelSingular: 'Registration',
    labelPlural: 'Registrations',
  },

  This enables the playbook engine to fire plays for
  playbook_registrations entities — the self-referential
  "Register Playbook" playbook that validates the engine end-to-end.
*/
