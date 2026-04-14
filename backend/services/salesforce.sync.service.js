/**
 * salesforce.sync.service.js
 *
 * DROP-IN LOCATION: backend/services/salesforce.sync.service.js
 *
 * Core Salesforce sync engine. Three phases, all configurable:
 *
 *   Phase 1 — Read-only nightly sync (data hydration)
 *     Contacts → contacts, Accounts → accounts,
 *     Opportunities → deals, Leads → prospects
 *     Uses LastModifiedDate cursor, 1500 records/run per object.
 *
 *   Phase 2 — Activity signal reading
 *     SF Tasks/Events → sf_activity_log → GoWarm actions (source='salesforce_task')
 *     Feeds PlayCompletionService signal pipeline.
 *
 *   Phase 3 — Write-back (when write_back_enabled = true)
 *     Completed GoWarm actions → SF Tasks
 *     Deduped via sf_activity_log + GoWarm_Source__c flag.
 *
 * Called by:
 *   - syncScheduler.js cron at 04:00 UTC (Phase 1+2) and 04:30 UTC (Phase 3)
 *   - salesforce.routes.js POST /trigger (manual run)
 */

const { pool }    = require('../config/database');
const { createClient }          = require('./salesforce.client');
const { getSoqlFields, sfRecordToGwData, gwActionToSfTask, calculateMatchConfidence }
                                = require('./salesforce.mapper');

const CONFIDENCE_THRESHOLD = 0.85; // Auto-link above this, queue for review below

// ── runSyncForOrg ─────────────────────────────────────────────────────────────

/**
 * Run a full sync cycle for one org.
 * Runs Phase 1 + Phase 2. Phase 3 is separate (runWriteBackForOrg).
 *
 * @returns {{ phase1: object, phase2: object, errors: string[] }}
 */
async function runSyncForOrg(orgId) {
  console.log(`🔄 [SF Sync] Starting sync for org ${orgId}`);
  const startTime = Date.now();
  const errors    = [];

  // Load integration config
  const intRes = await pool.query(
    `SELECT settings, instance_url FROM org_integrations WHERE org_id = $1 AND provider = 'salesforce'`,
    [orgId]
  );
  if (intRes.rows.length === 0) {
    throw new Error(`No Salesforce integration found for org ${orgId}`);
  }
  const settings    = intRes.rows[0].settings || {};
  const syncObjects = settings.sync_objects || ['Contact', 'Account', 'Opportunity', 'Lead'];

  // Mark sync as running
  await pool.query(
    `UPDATE org_integrations SET sync_status = 'running', updated_at = NOW() WHERE org_id = $1 AND provider = 'salesforce'`,
    [orgId]
  );

  let phase1 = { contacts: 0, accounts: 0, deals: 0, prospects: 0, identity_queued: 0 };
  let phase2 = { tasks: 0, events: 0 };

  try {
    const sf = await createClient(orgId);

    // ── Phase 1: Data hydration ──────────────────────────────────────────────

    // Sync order matters: Accounts before Contacts (contacts FK to accounts),
    // Contacts before Opportunities (opp contacts resolution).
    const syncOrder = ['Account', 'Contact', 'Opportunity', 'Lead'].filter(o => syncObjects.includes(o));

    for (const sfObject of syncOrder) {
      try {
        const result = await _syncObject(sf, orgId, sfObject, settings);
        if (sfObject === 'Account')     phase1.accounts        += result.upserted;
        if (sfObject === 'Contact')     phase1.contacts        += result.upserted;
        if (sfObject === 'Opportunity') phase1.deals           += result.upserted;
        if (sfObject === 'Lead')        phase1.prospects       += result.upserted;
        phase1.identity_queued += result.identity_queued || 0;
        if (result.cursor) await _saveCursor(orgId, sfObject, result.cursor);
      } catch (err) {
        const msg = `Phase 1 ${sfObject} error: ${err.message}`;
        console.error(`❌ [SF Sync] org ${orgId} — ${msg}`);
        errors.push(msg);
      }
    }

    // ── Phase 2: Activity signal reading ────────────────────────────────────

    if (syncObjects.includes('Task') || true) { // Always sync Tasks
      try {
        const taskResult = await _syncTasks(sf, orgId, settings);
        phase2.tasks = taskResult.processed;
        if (taskResult.cursor) await _saveCursor(orgId, 'Task', taskResult.cursor);
      } catch (err) {
        const msg = `Phase 2 Task error: ${err.message}`;
        console.error(`❌ [SF Sync] org ${orgId} — ${msg}`);
        errors.push(msg);
      }
    }

    // Save successful sync timestamp
    const duration = Math.round((Date.now() - startTime) / 1000);
    await pool.query(`
      UPDATE org_integrations
      SET sync_status = $2, last_sync_at = NOW(), last_sync_error = NULL, updated_at = NOW()
      WHERE org_id = $1 AND provider = 'salesforce'
    `, [orgId, errors.length > 0 ? 'completed_with_errors' : 'idle']);

    console.log(
      `✅ [SF Sync] org ${orgId} done in ${duration}s — ` +
      `accounts:${phase1.accounts} contacts:${phase1.contacts} deals:${phase1.deals} prospects:${phase1.prospects} tasks:${phase2.tasks}`
    );

  } catch (err) {
    await pool.query(`
      UPDATE org_integrations
      SET sync_status = 'error', last_sync_error = $2, updated_at = NOW()
      WHERE org_id = $1 AND provider = 'salesforce'
    `, [orgId, err.message]);
    throw err;
  }

  return { phase1, phase2, errors };
}

// ── _syncObject ───────────────────────────────────────────────────────────────

async function _syncObject(sf, orgId, sfObject, settings) {
  const cursor     = settings.sync_cursors?.[sfObject] || null;
  const fieldMap   = settings.field_map || [];
  const fields     = getSoqlFields(sfObject, fieldMap);
  const soql       = sf.buildIncrementalQuery(sfObject, fields, cursor);

  console.log(`  📥 [SF Sync] org ${orgId} ${sfObject}: cursor=${cursor || 'none'}`);

  const result   = await sf.query(soql);
  const records  = result.records;

  if (records.length === 0) {
    console.log(`  ✓ [SF Sync] org ${orgId} ${sfObject}: no new records`);
    return { upserted: 0, identity_queued: 0, cursor: null };
  }

  let upserted       = 0;
  let identityQueued = 0;

  // Get the default owner for this org (fallback for records with no GoWarm owner)
  const ownerRes = await pool.query(
    `SELECT id FROM users u JOIN org_users ou ON ou.user_id = u.id WHERE ou.org_id = $1 ORDER BY ou.joined_at ASC LIMIT 1`,
    [orgId]
  );
  const defaultOwnerId = ownerRes.rows[0]?.id;
  if (!defaultOwnerId) throw new Error(`No users found for org ${orgId}`);

  for (const sfRecord of records) {
    try {
      // Handle Lead conversion specially
      if (sfObject === 'Lead' && sfRecord.IsConverted) {
        await _handleLeadConversion(orgId, sfRecord, settings, defaultOwnerId);
        upserted++;
        continue;
      }

      const { gwData } = sfRecordToGwData(sfObject, sfRecord, settings);

      // Try to find existing GoWarm record via external_refs first
      const existing = await _findByExternalRef(orgId, sfObject, sfRecord.Id);

      if (existing) {
        // Record found via SF ID — update it
        await _upsertRecord(orgId, sfObject, existing.id, gwData, settings);
        upserted++;
      } else {
        // No existing SF-linked record — try fuzzy identity match
        const match = await _findByIdentity(orgId, sfObject, sfRecord, settings);

        if (match && match.confidence >= CONFIDENCE_THRESHOLD) {
          // High confidence — auto-link and update
          await _upsertRecord(orgId, sfObject, match.id, gwData, settings);
          await _recordIdentity(orgId, sfObject, sfRecord.Id, match.id, match.confidence);
          upserted++;
        } else if (match && match.confidence > 0) {
          // Low confidence — create identity resolution action and create new record
          const newId = await _createRecord(orgId, sfObject, gwData, defaultOwnerId, settings);
          await _recordIdentityPendingReview(orgId, sfObject, sfRecord, newId, match, settings);
          identityQueued++;
          upserted++;
        } else {
          // No match — create new record
          await _createRecord(orgId, sfObject, gwData, defaultOwnerId, settings);
          upserted++;
        }
      }
    } catch (err) {
      console.error(`  ⚠️ [SF Sync] org ${orgId} ${sfObject} ${sfRecord.Id}: ${err.message}`);
    }
  }

  // Cursor = LastModifiedDate of the last record processed
  const newCursor = records[records.length - 1]?.LastModifiedDate || null;
  return { upserted, identity_queued: identityQueued, cursor: newCursor };
}

// ── _syncTasks (Phase 2) ──────────────────────────────────────────────────────

async function _syncTasks(sf, orgId, settings) {
  const cursor = settings.sync_cursors?.Task || null;
  const soql   = sf.buildIncrementalQuery('Task',
    ['Subject', 'Description', 'ActivityDate', 'Status', 'Priority', 'WhoId', 'WhatId',
     'OwnerId', 'GoWarm_Source__c', 'GoWarm_Action_ID__c'],
    cursor
  );

  const result  = await sf.query(soql);
  const records = result.records;
  let processed = 0;

  for (const sfTask of records) {
    try {
      // Skip tasks that GoWarm wrote back (prevent echo loop)
      if (sfTask.GoWarm_Source__c === true) continue;

      // Skip if already processed
      const already = await pool.query(
        `SELECT id FROM sf_activity_log WHERE org_id = $1 AND sf_object_id = $2`,
        [orgId, sfTask.Id]
      );
      if (already.rows.length > 0) continue;

      // Resolve WhatId (Opportunity → deal) and WhoId (Contact → contact)
      const dealId    = sfTask.WhatId ? await _resolveSfIdToGwId(orgId, 'deals',    sfTask.WhatId) : null;
      const contactId = sfTask.WhoId  ? await _resolveSfIdToGwId(orgId, 'contacts', sfTask.WhoId)  : null;

      if (!dealId && !contactId) {
        // Can't link to any GoWarm record — skip (unrelated SF task)
        continue;
      }

      // Resolve SF owner to GoWarm user
      const userRes = await pool.query(
        `SELECT u.id FROM users u JOIN org_users ou ON ou.user_id = u.id WHERE ou.org_id = $1 ORDER BY ou.joined_at ASC LIMIT 1`,
        [orgId]
      );
      const userId = userRes.rows[0]?.id;

      // Create GoWarm action from SF Task
      const actionRes = await pool.query(`
        INSERT INTO actions (
          org_id, user_id, deal_id, contact_id, type, priority,
          title, description, due_date, completed, completed_at,
          source, source_id, external_refs, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,'task',$5,$6,$7,$8,$9,$10,'salesforce_task',$11,$12,NOW(),NOW())
        ON CONFLICT DO NOTHING
        RETURNING id
      `, [
        orgId, userId, dealId, contactId,
        sfTask.Priority === 'High' ? 'high' : sfTask.Priority === 'Low' ? 'low' : 'medium',
        sfTask.Subject || 'SF Task',
        sfTask.Description || null,
        sfTask.ActivityDate ? new Date(sfTask.ActivityDate) : null,
        sfTask.Status === 'Completed',
        sfTask.Status === 'Completed' ? new Date() : null,
        sfTask.Id,
        JSON.stringify({ salesforce: { id: sfTask.Id, object_type: 'Task', synced_at: new Date().toISOString() } }),
      ]);

      const actionId = actionRes.rows[0]?.id;

      // Log to sf_activity_log for dedup
      await pool.query(`
        INSERT INTO sf_activity_log (org_id, sf_object_id, sf_object_type, direction, gw_action_id, gw_entity_type, gw_entity_id)
        VALUES ($1,$2,'Task','inbound',$3,$4,$5)
        ON CONFLICT (org_id, sf_object_id) DO NOTHING
      `, [orgId, sfTask.Id, actionId, dealId ? 'deal' : 'contact', dealId || contactId]);

      processed++;
    } catch (err) {
      console.error(`  ⚠️ [SF Sync] Task ${sfTask.Id}: ${err.message}`);
    }
  }

  const newCursor = records[records.length - 1]?.LastModifiedDate || null;
  return { processed, cursor: newCursor };
}

// ── runWriteBackForOrg (Phase 3) ──────────────────────────────────────────────

/**
 * Write completed GoWarm actions back to Salesforce as Tasks.
 * Only runs if org.settings.write_back_enabled = true.
 */
async function runWriteBackForOrg(orgId) {
  const intRes = await pool.query(
    `SELECT settings FROM org_integrations WHERE org_id = $1 AND provider = 'salesforce'`,
    [orgId]
  );
  if (intRes.rows.length === 0) return { skipped: true, reason: 'no_integration' };

  const settings = intRes.rows[0].settings || {};
  if (!settings.write_back_enabled) return { skipped: true, reason: 'write_back_disabled' };

  console.log(`📤 [SF Write-back] Starting for org ${orgId}`);

  // Find actions completed since last write-back that haven't been written to SF yet
  // and belong to a deal/contact that has a SF ID
  const actionsRes = await pool.query(`
    SELECT a.id, a.title, a.description, a.context, a.due_date, a.completed,
           a.completed_at, a.priority, a.type,
           a.external_refs,
           d.external_refs AS deal_external_refs,
           c.external_refs AS contact_external_refs
    FROM actions a
    LEFT JOIN deals    d ON d.id = a.deal_id
    LEFT JOIN contacts c ON c.id = a.contact_id
    WHERE a.org_id    = $1
      AND a.completed = true
      AND a.completed_at >= NOW() - INTERVAL '25 hours'
      AND a.source NOT IN ('salesforce_task', 'salesforce_event')
      AND NOT EXISTS (
        SELECT 1 FROM sf_activity_log sal
        WHERE sal.org_id = $1 AND sal.gw_action_id = a.id AND sal.direction = 'outbound'
      )
      AND (
        d.external_refs->'salesforce'->>'id' IS NOT NULL
        OR c.external_refs->'salesforce'->>'id' IS NOT NULL
      )
    LIMIT 200
  `, [orgId]);

  if (actionsRes.rows.length === 0) {
    console.log(`  ✓ [SF Write-back] org ${orgId}: no actions to write back`);
    return { written: 0 };
  }

  const sf = await createClient(orgId);
  let written = 0;

  for (const action of actionsRes.rows) {
    try {
      const sfTask = gwActionToSfTask(action, settings);
      const sfTaskId = await sf.createTask(sfTask);

      // Log outbound to prevent re-processing
      await pool.query(`
        INSERT INTO sf_activity_log (org_id, sf_object_id, sf_object_type, direction, gw_action_id, gw_entity_type, gw_entity_id)
        VALUES ($1,$2,'Task','outbound',$3,'action',$4)
        ON CONFLICT (org_id, sf_object_id) DO NOTHING
      `, [orgId, sfTaskId, action.id, action.id]);

      // Update action external_refs with the new SF Task ID
      await pool.query(`
        UPDATE actions
        SET external_refs = external_refs || $2::jsonb, updated_at = NOW()
        WHERE id = $1
      `, [action.id, JSON.stringify({ salesforce: { task_id: sfTaskId, written_at: new Date().toISOString() } })]);

      written++;
    } catch (err) {
      console.error(`  ⚠️ [SF Write-back] action ${action.id}: ${err.message}`);
    }
  }

  console.log(`✅ [SF Write-back] org ${orgId}: ${written} actions written to SF`);
  return { written };
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function _findByExternalRef(orgId, sfObject, sfId) {
  const tableMap = { Contact: 'contacts', Account: 'accounts', Opportunity: 'deals', Lead: 'prospects' };
  const table    = tableMap[sfObject];
  const res = await pool.query(
    `SELECT id FROM ${table} WHERE org_id = $1 AND external_refs @> $2::jsonb AND deleted_at IS NULL LIMIT 1`,
    [orgId, JSON.stringify({ salesforce: { id: sfId } })]
  );
  return res.rows[0] || null;
}

async function _findByIdentity(orgId, sfObject, sfRecord, settings) {
  const tableMap   = { Contact: 'contacts', Account: 'accounts', Opportunity: 'deals', Lead: 'prospects' };
  const table      = tableMap[sfObject];

  // Email-based lookup for Contact/Lead
  if ((sfObject === 'Contact' || sfObject === 'Lead') && sfRecord.Email) {
    const res = await pool.query(
      `SELECT id, email, first_name, last_name, external_refs FROM ${table}
       WHERE org_id = $1 AND LOWER(email) = $2 AND deleted_at IS NULL LIMIT 1`,
      [orgId, sfRecord.Email.toLowerCase().trim()]
    );
    if (res.rows.length > 0) {
      const confidence = calculateMatchConfidence(sfRecord, res.rows[0], sfObject);
      return { id: res.rows[0].id, confidence };
    }
  }

  // Domain-based lookup for Account
  if (sfObject === 'Account' && sfRecord.Website) {
    const domain = _extractDomain(sfRecord.Website);
    if (domain) {
      const res = await pool.query(
        `SELECT id, name, domain, external_refs FROM ${table}
         WHERE org_id = $1 AND LOWER(domain) = $2 AND deleted_at IS NULL LIMIT 1`,
        [orgId, domain]
      );
      if (res.rows.length > 0) {
        const confidence = calculateMatchConfidence(sfRecord, res.rows[0], sfObject);
        return { id: res.rows[0].id, confidence };
      }
    }
  }

  return null;
}

function _extractDomain(url) {
  if (!url) return null;
  try {
    const u = url.startsWith('http') ? url : `https://${url}`;
    return new URL(u).hostname.replace(/^www\./, '').toLowerCase();
  } catch { return null; }
}

async function _upsertRecord(orgId, sfObject, gwId, gwData, settings) {
  const tableMap = { Contact: 'contacts', Account: 'accounts', Opportunity: 'deals', Lead: 'prospects' };
  const table    = tableMap[sfObject];
  const mode     = settings.sf_sync_mode || 'sf_primary';

  // In sf_primary mode, GoWarm fields mapped from SF are always overwritten.
  // In gowarm_primary, we do NOT overwrite GoWarm's values.
  if (mode === 'gowarm_primary') {
    // Only update external_refs (identity anchor) and sync timestamp
    await pool.query(
      `UPDATE ${table} SET external_refs = external_refs || $2::jsonb, updated_at = NOW() WHERE id = $1`,
      [gwId, JSON.stringify(gwData.external_refs)]
    );
    return;
  }

  // Build dynamic SET clause from gwData keys (exclude external_refs — merge separately)
  const { external_refs, stage, ...coreData } = gwData;
  const setClauses = [];
  const values     = [gwId];
  let   paramIdx   = 2;

  for (const [col, val] of Object.entries(coreData)) {
    // Skip null values in sf_primary to avoid overwriting GoWarm enriched data
    if (val === null && mode !== 'bidirectional') continue;
    setClauses.push(`${col} = $${paramIdx++}`);
    values.push(val);
  }

  // Stage: only update if mapped (non-null)
  if (stage !== null && stage !== undefined) {
    setClauses.push(`stage = $${paramIdx++}`);
    values.push(stage);
  }

  // Merge external_refs (preserve other CRM entries)
  setClauses.push(`external_refs = external_refs || $${paramIdx++}::jsonb`);
  values.push(JSON.stringify(external_refs));

  setClauses.push('updated_at = NOW()');

  if (setClauses.length > 1) {
    await pool.query(
      `UPDATE ${table} SET ${setClauses.join(', ')} WHERE id = $1`,
      values
    );
  }
}

async function _createRecord(orgId, sfObject, gwData, defaultOwnerId, settings) {
  const tableMap = { Contact: 'contacts', Account: 'accounts', Opportunity: 'deals', Lead: 'prospects' };
  const table    = tableMap[sfObject];
  const { external_refs, ...coreData } = gwData;

  const cols   = ['org_id', 'external_refs', 'created_at', 'updated_at'];
  const vals   = [orgId, JSON.stringify(external_refs), 'NOW()', 'NOW()'];
  const params = ['$1', '$2', 'NOW()', 'NOW()'];
  let   idx    = 3;

  for (const [col, val] of Object.entries(coreData)) {
    if (val === undefined) continue;
    cols.push(col);
    vals.push(val);
    params.push(`$${idx++}`);
  }

  // Add owner for tables that require it
  if (['deals', 'prospects'].includes(table)) {
    cols.push('owner_id');
    vals.push(defaultOwnerId);
    params.push(`$${idx++}`);
  }

  // Ensure required NOT NULL fields have values
  if (table === 'contacts') {
    if (!coreData.first_name) { cols.push('first_name'); vals.push('Unknown'); params.push(`$${idx++}`); }
    if (!coreData.last_name)  { cols.push('last_name');  vals.push('Unknown'); params.push(`$${idx++}`); }
  }
  if (table === 'accounts' && !coreData.name) {
    cols.push('name'); vals.push('Unknown Account'); params.push(`$${idx++}`);
  }
  if (table === 'deals') {
    if (!coreData.name)  { cols.push('name');  vals.push('Unnamed Deal'); params.push(`$${idx++}`); }
    if (!coreData.value) { cols.push('value'); vals.push(0);              params.push(`$${idx++}`); }
    if (!coreData.stage) { cols.push('stage'); vals.push('discovery');    params.push(`$${idx++}`); }
  }
  if (table === 'prospects') {
    if (!coreData.first_name)   { cols.push('first_name');   vals.push('Unknown');   params.push(`$${idx++}`); }
    if (!coreData.last_name)    { cols.push('last_name');    vals.push('Unknown');   params.push(`$${idx++}`); }
    if (!coreData.stage)        { cols.push('stage');        vals.push('target');    params.push(`$${idx++}`); }
    if (!coreData.company_name) { cols.push('company_name'); vals.push('Unknown');   params.push(`$${idx++}`); }
  }

  const res = await pool.query(
    `INSERT INTO ${table} (${cols.join(',')}) VALUES (${params.join(',')}) RETURNING id`,
    vals.filter((_, i) => params[i] !== 'NOW()')
  );
  return res.rows[0]?.id;
}

async function _recordIdentity(orgId, sfObject, sfId, gwId, confidence) {
  const typeMap = { Contact: 'salesforce_contact', Account: 'salesforce_account', Opportunity: 'salesforce_opportunity', Lead: 'salesforce_lead' };
  const isContact  = sfObject === 'Contact';
  const isProspect = sfObject === 'Lead';
  await pool.query(`
    INSERT INTO contact_identities (org_id, canonical_contact_id, canonical_prospect_id, identity_type, identity_value, confidence, status, confirmed_at)
    VALUES ($1, $2, $3, $4, $5, $6, 'confirmed', NOW())
    ON CONFLICT (org_id, identity_type, identity_value) DO UPDATE
      SET confidence = EXCLUDED.confidence, status = 'confirmed', confirmed_at = NOW()
  `, [orgId, isContact ? gwId : null, isProspect ? gwId : null, typeMap[sfObject], sfId, confidence]);
}

async function _recordIdentityPendingReview(orgId, sfObject, sfRecord, newGwId, possibleMatch, settings) {
  // Create pending identity record
  const typeMap = { Contact: 'salesforce_contact', Lead: 'salesforce_lead' };
  await pool.query(`
    INSERT INTO contact_identities (org_id, canonical_contact_id, canonical_prospect_id, identity_type, identity_value, confidence, status)
    VALUES ($1, $2, $3, $4, $5, $6, 'pending_review')
    ON CONFLICT (org_id, identity_type, identity_value) DO NOTHING
  `, [
    orgId,
    sfObject === 'Contact' ? newGwId : null,
    sfObject === 'Lead'    ? newGwId : null,
    typeMap[sfObject] || 'salesforce_contact',
    sfRecord.Id,
    possibleMatch?.confidence || 0,
  ]);

  // Find the deal owner to assign the identity resolution action to
  const dealRes = await pool.query(`
    SELECT d.id AS deal_id, d.owner_id
    FROM deals d
    JOIN deal_contacts dc ON dc.deal_id = d.id
    JOIN contacts c ON c.id = dc.contact_id
    WHERE d.org_id = $1 AND c.id = $2
    ORDER BY d.updated_at DESC LIMIT 1
  `, [orgId, newGwId]);

  const dealId  = dealRes.rows[0]?.deal_id;
  const ownerId = dealRes.rows[0]?.owner_id;
  if (!dealId || !ownerId) return; // No deal yet — identity will be resolved when deal is created

  const sfName = `${sfRecord.FirstName || ''} ${sfRecord.LastName || ''}`.trim() || sfRecord.Name || sfRecord.Id;
  await pool.query(`
    INSERT INTO actions (org_id, user_id, deal_id, type, priority, title, description, source, source_id, external_refs, created_at, updated_at)
    VALUES ($1, $2, $3, 'identity_resolution', 'medium', $4, $5, 'salesforce_sync', $6, $7, NOW(), NOW())
  `, [
    orgId, ownerId, dealId,
    `Confirm contact match: ${sfName}`,
    `Salesforce sync found a possible match. Is ${sfName} (Salesforce) the same person as contact #${newGwId} in GoWarm?\n\nConfidence: ${Math.round((possibleMatch?.confidence || 0) * 100)}%`,
    sfRecord.Id,
    JSON.stringify({ salesforce: { sf_id: sfRecord.Id, object_type: sfObject, pending_gw_id: newGwId, possible_match_id: possibleMatch?.id } }),
  ]);
}

async function _handleLeadConversion(orgId, sfRecord, settings, defaultOwnerId) {
  // Find the GoWarm prospect linked to this Lead
  const prospectRes = await pool.query(
    `SELECT id, contact_id FROM prospects WHERE org_id = $1 AND external_refs @> $2::jsonb AND deleted_at IS NULL LIMIT 1`,
    [orgId, JSON.stringify({ salesforce: { id: sfRecord.Id } })]
  );

  if (prospectRes.rows.length === 0) return; // Prospect not synced yet — skip

  const prospect   = prospectRes.rows[0];
  const sfContactId = sfRecord.ConvertedContactId;
  const sfAccountId = sfRecord.ConvertedAccountId;
  const sfOppId     = sfRecord.ConvertedOpportunityId;

  // Update prospect's external_refs with conversion info
  await pool.query(`
    UPDATE prospects
    SET external_refs = external_refs || $2::jsonb, updated_at = NOW()
    WHERE id = $1
  `, [prospect.id, JSON.stringify({ salesforce: { id: sfRecord.Id, converted: true, converted_contact_id: sfContactId, converted_opportunity_id: sfOppId } })]);

  // If prospect already has a contact_id, just update that contact's external_refs
  if (prospect.contact_id && sfContactId) {
    await pool.query(`
      UPDATE contacts SET external_refs = external_refs || $2::jsonb, updated_at = NOW() WHERE id = $1
    `, [prospect.contact_id, JSON.stringify({ salesforce: { id: sfContactId, synced_at: new Date().toISOString() } })]);
  }
}

async function _saveCursor(orgId, sfObject, cursor) {
  await pool.query(`
    UPDATE org_integrations
    SET settings = jsonb_set(settings, $2, $3::jsonb), updated_at = NOW()
    WHERE org_id = $1 AND provider = 'salesforce'
  `, [orgId, `{sync_cursors,${sfObject}}`, JSON.stringify(cursor)]);
}

async function _resolveSfIdToGwId(orgId, table, sfId) {
  const res = await pool.query(
    `SELECT id FROM ${table} WHERE org_id = $1 AND external_refs @> $2::jsonb AND deleted_at IS NULL LIMIT 1`,
    [orgId, JSON.stringify({ salesforce: { id: sfId } })]
  );
  return res.rows[0]?.id || null;
}

// ── getConnectedOrgs ──────────────────────────────────────────────────────────

/**
 * Return all org IDs that have an active Salesforce connection.
 * Used by syncScheduler to drive the nightly cron.
 */
async function getConnectedOrgs() {
  const res = await pool.query(`
    SELECT oi.org_id
    FROM org_integrations oi
    JOIN oauth_tokens ot ON ot.provider = 'salesforce' AND ot.user_id = oi.connected_by
    WHERE oi.provider = 'salesforce'
      AND oi.instance_url IS NOT NULL
      AND oi.connected_at IS NOT NULL
  `);
  return res.rows.map(r => r.org_id);
}

module.exports = { runSyncForOrg, runWriteBackForOrg, getConnectedOrgs };
