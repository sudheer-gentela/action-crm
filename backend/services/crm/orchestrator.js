/**
 * crm/orchestrator.js
 *
 * DROP-IN LOCATION: backend/services/crm/orchestrator.js
 *
 * CRM sync orchestrator — the main sync engine.
 * CRM-agnostic: works with any adapter that implements the adapter interface.
 *
 * Sync order (deterministic FK chain):
 *   1. Users + Hierarchy  → org_hierarchy, teams, team_memberships
 *      MUST be first — deals and contacts need owner_id resolved from email.
 *   2. Accounts           → accounts
 *   3. Contacts           → contacts  (account_id resolved from accountCrmId)
 *   4. Deals              → deals     (account_id, owner_id resolved)
 *      ↳ DealContacts     → deal_contacts (per deal)
 *      ↳ DealProducts     → deal_products + product_catalog (per deal)
 *   5. Leads              → prospects
 *
 * Key principles:
 *   - All CRM IDs stored in external_refs JSONB (GIN indexed)
 *   - All lookups use external_refs — never probabilistic matching
 *   - Owner resolved by email (stable cross-system join key)
 *   - Stage resolved via org_integrations.settings.stage_map
 *   - Null stage on unmapped stages → diagnostic action queued, deal still created
 *   - deals.external_crm_type and deals.external_crm_deal_id backfilled for
 *     backward compat with existing queries
 */

const { pool }         = require('../../config/database');
const { resolveStage } = require('./mapper');
const { syncHierarchy } = require('./hierarchySync');
const { syncDealProducts } = require('./productSync');

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run a full sync cycle for one org.
 *
 * @param {number} orgId
 * @param {string} crmType    - 'salesforce' | 'hubspot'
 * @param {object} adapter    - Initialised CRM adapter
 * @returns {{ results: object, errors: string[] }}
 */
async function runSyncForOrg(orgId, crmType, adapter) {
  console.log(`🔄 [CRM Sync] Starting ${crmType} sync for org ${orgId}`);
  const startTime = Date.now();
  const errors    = [];

  // Load org settings (stage_map, sync_objects, cursors)
  const intRes = await pool.query(
    `SELECT settings FROM org_integrations WHERE org_id = $1 AND integration_type = $2`,
    [orgId, crmType]
  );
  if (intRes.rows.length === 0) {
    throw new Error(`No ${crmType} integration found for org ${orgId}`);
  }

  const settings    = intRes.rows[0].settings || {};
  const stageMap    = settings.stage_map || {};
  const syncObjects = settings.sync_objects || ['Account', 'Contact', 'Opportunity', 'Lead'];
  const cursors     = settings.sync_cursors || {};

  // Mark sync as running
  await pool.query(
    `UPDATE org_integrations SET sync_status = 'running', updated_at = NOW()
     WHERE org_id = $1 AND integration_type = $2`,
    [orgId, crmType]
  );

  const results = {
    hierarchy: null,
    accounts:  { upserted: 0 },
    contacts:  { upserted: 0 },
    deals:     { upserted: 0, products: 0, dealContacts: 0 },
    prospects: { upserted: 0 },
  };

  try {
    // ── Step 1: Users + Hierarchy ──────────────────────────────────────────
    try {
      results.hierarchy = await syncHierarchy(orgId, adapter);
    } catch (err) {
      const msg = `Hierarchy sync error: ${err.message}`;
      console.error(`  ❌ [CRM Sync] org ${orgId} — ${msg}`);
      errors.push(msg);
      // Non-fatal — continue with data sync
    }

    // ── Step 2: Accounts ──────────────────────────────────────────────────
    if (syncObjects.includes('Account')) {
      try {
        const r = await _syncAccounts(orgId, crmType, adapter, cursors.Account);
        results.accounts = r;
        if (r.nextCursor) await _saveCursor(orgId, crmType, 'Account', r.nextCursor);
      } catch (err) {
        const msg = `Account sync error: ${err.message}`;
        console.error(`  ❌ [CRM Sync] org ${orgId} — ${msg}`);
        errors.push(msg);
      }
    }

    // ── Step 3: Contacts ──────────────────────────────────────────────────
    if (syncObjects.includes('Contact')) {
      try {
        const r = await _syncContacts(orgId, crmType, adapter, cursors.Contact);
        results.contacts = r;
        if (r.nextCursor) await _saveCursor(orgId, crmType, 'Contact', r.nextCursor);
      } catch (err) {
        const msg = `Contact sync error: ${err.message}`;
        console.error(`  ❌ [CRM Sync] org ${orgId} — ${msg}`);
        errors.push(msg);
      }
    }

    // ── Step 4: Deals (+ DealContacts + DealProducts per deal) ────────────
    if (syncObjects.includes('Opportunity')) {
      try {
        const r = await _syncDeals(orgId, crmType, adapter, cursors.Opportunity, stageMap);
        results.deals = r;
        if (r.nextCursor) await _saveCursor(orgId, crmType, 'Opportunity', r.nextCursor);
      } catch (err) {
        const msg = `Deal sync error: ${err.message}`;
        console.error(`  ❌ [CRM Sync] org ${orgId} — ${msg}`);
        errors.push(msg);
      }
    }

    // ── Step 5: Leads → Prospects ─────────────────────────────────────────
    if (syncObjects.includes('Lead')) {
      try {
        const r = await _syncLeads(orgId, crmType, adapter, cursors.Lead, stageMap);
        results.prospects = r;
        if (r.nextCursor) await _saveCursor(orgId, crmType, 'Lead', r.nextCursor);
      } catch (err) {
        const msg = `Lead sync error: ${err.message}`;
        console.error(`  ❌ [CRM Sync] org ${orgId} — ${msg}`);
        errors.push(msg);
      }
    }

    // ── Mark complete ──────────────────────────────────────────────────────
    const duration   = Math.round((Date.now() - startTime) / 1000);
    const syncStatus = errors.length > 0 ? 'completed_with_errors' : 'idle';

    await pool.query(`
      UPDATE org_integrations
      SET sync_status = $2, last_sync_at = NOW(), last_sync_error = NULL, updated_at = NOW()
      WHERE org_id = $1 AND integration_type = $3
    `, [orgId, syncStatus, crmType]);

    console.log(
      `✅ [CRM Sync] org ${orgId} ${crmType} done in ${duration}s — ` +
      `accounts:${results.accounts.upserted} contacts:${results.contacts.upserted} ` +
      `deals:${results.deals.upserted} prospects:${results.prospects.upserted}`
    );

  } catch (err) {
    await pool.query(`
      UPDATE org_integrations
      SET sync_status = 'error', last_sync_error = $2, updated_at = NOW()
      WHERE org_id = $1 AND integration_type = $3
    `, [orgId, err.message, crmType]);
    throw err;
  }

  return { results, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// OBJECT SYNC FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

async function _syncAccounts(orgId, crmType, adapter, cursor) {
  console.log(`  📥 [CRM Sync] Accounts: cursor=${cursor || 'none'}`);
  const { records, nextCursor } = await adapter.getAccounts(cursor || null);

  if (records.length === 0) {
    console.log(`  ✓ [CRM Sync] Accounts: no new records`);
    return { upserted: 0, nextCursor: null };
  }

  // Resolve all owner emails in one query
  const ownerEmails = [...new Set(records.map(r => r.ownerEmail).filter(Boolean))];
  const emailToUser = await _resolveOwners(orgId, ownerEmails);

  let upserted = 0;
  for (const record of records) {
    try {
      const ownerId = record.ownerEmail ? emailToUser.get(record.ownerEmail) || null : null;
      await _upsertAccount(orgId, crmType, record, ownerId);
      upserted++;
    } catch (err) {
      console.error(`  ⚠️  [CRM Sync] Account ${record.crmId}: ${err.message}`);
    }
  }

  console.log(`  ✓ [CRM Sync] Accounts: ${upserted} upserted`);
  return { upserted, nextCursor };
}

async function _syncContacts(orgId, crmType, adapter, cursor) {
  console.log(`  📥 [CRM Sync] Contacts: cursor=${cursor || 'none'}`);
  const { records, nextCursor } = await adapter.getContacts(cursor || null);

  if (records.length === 0) {
    console.log(`  ✓ [CRM Sync] Contacts: no new records`);
    return { upserted: 0, nextCursor: null };
  }

  const ownerEmails = [...new Set(records.map(r => r.ownerEmail).filter(Boolean))];
  const emailToUser = await _resolveOwners(orgId, ownerEmails);

  let upserted = 0;
  for (const record of records) {
    try {
      const userId    = record.ownerEmail ? emailToUser.get(record.ownerEmail) || null : null;
      const accountId = record.accountCrmId
        ? await _resolveCrmId(orgId, 'accounts', crmType, record.accountCrmId)
        : null;

      await _upsertContact(orgId, crmType, record, userId, accountId);
      upserted++;
    } catch (err) {
      console.error(`  ⚠️  [CRM Sync] Contact ${record.crmId}: ${err.message}`);
    }
  }

  // Second pass: resolve reports_to_contact_id (requires contacts to exist first)
  for (const record of records) {
    if (!record.reportsToContactCrmId) continue;
    try {
      const reportsToId = await _resolveCrmId(orgId, 'contacts', crmType, record.reportsToContactCrmId);
      if (!reportsToId) continue;

      const contactId = await _resolveCrmId(orgId, 'contacts', crmType, record.crmId);
      if (!contactId) continue;

      await pool.query(
        `UPDATE contacts SET reports_to_contact_id = $1, updated_at = NOW() WHERE id = $2`,
        [reportsToId, contactId]
      );
    } catch (err) {
      // Non-fatal — dotted line data
    }
  }

  console.log(`  ✓ [CRM Sync] Contacts: ${upserted} upserted`);
  return { upserted, nextCursor };
}

async function _syncDeals(orgId, crmType, adapter, cursor, stageMap) {
  console.log(`  📥 [CRM Sync] Deals: cursor=${cursor || 'none'}`);
  const { records, nextCursor } = await adapter.getDeals(cursor || null);

  if (records.length === 0) {
    console.log(`  ✓ [CRM Sync] Deals: no new records`);
    return { upserted: 0, products: 0, dealContacts: 0, nextCursor: null };
  }

  const ownerEmails = [...new Set(records.map(r => r.ownerEmail).filter(Boolean))];
  const emailToUser = await _resolveOwners(orgId, ownerEmails);

  let upserted     = 0;
  let totalProducts = 0;
  let totalDealContacts = 0;

  for (const record of records) {
    try {
      const ownerId   = record.ownerEmail ? emailToUser.get(record.ownerEmail) || null : null;
      const accountId = record.accountCrmId
        ? await _resolveCrmId(orgId, 'accounts', crmType, record.accountCrmId)
        : null;

      // Resolve stage
      const gwStage = resolveStage(record.stageCrmKey, stageMap);
      if (!gwStage && record.stageCrmKey) {
        console.warn(`  ⚠️  [CRM Sync] Deal ${record.crmId}: unmapped stage "${record.stageCrmKey}"`);
      }

      const gwDealId = await _upsertDeal(orgId, crmType, record, ownerId, accountId, gwStage);

      if (gwDealId) {
        upserted++;

        // Sync deal contacts (OpportunityContactRoles)
        try {
          const dc = await _syncDealContacts(orgId, crmType, gwDealId, record.crmId, adapter);
          totalDealContacts += dc.synced;
        } catch (err) {
          console.error(`  ⚠️  [CRM Sync] DealContacts for ${record.crmId}: ${err.message}`);
        }

        // Sync deal products (OpportunityLineItems)
        try {
          const dp = await syncDealProducts(orgId, gwDealId, record.crmId, adapter);
          totalProducts += dp.synced;
        } catch (err) {
          console.error(`  ⚠️  [CRM Sync] DealProducts for ${record.crmId}: ${err.message}`);
        }
      }
    } catch (err) {
      console.error(`  ⚠️  [CRM Sync] Deal ${record.crmId}: ${err.message}`);
    }
  }

  console.log(`  ✓ [CRM Sync] Deals: ${upserted} upserted, ${totalProducts} products, ${totalDealContacts} deal contacts`);
  return { upserted, products: totalProducts, dealContacts: totalDealContacts, nextCursor };
}

async function _syncLeads(orgId, crmType, adapter, cursor, stageMap) {
  console.log(`  📥 [CRM Sync] Leads: cursor=${cursor || 'none'}`);
  const { records, nextCursor } = await adapter.getLeads(cursor || null);

  if (records.length === 0) {
    console.log(`  ✓ [CRM Sync] Leads: no new records`);
    return { upserted: 0, nextCursor: null };
  }

  const ownerEmails = [...new Set(records.map(r => r.ownerEmail).filter(Boolean))];
  const emailToUser = await _resolveOwners(orgId, ownerEmails);

  let upserted = 0;
  for (const record of records) {
    try {
      // Converted leads: update the corresponding contact/deal's external_refs
      // with the conversion IDs, but don't create a new prospect row.
      if (record.isConverted) {
        await _handleLeadConversion(orgId, crmType, record);
        upserted++;
        continue;
      }

      const ownerId = record.ownerEmail ? emailToUser.get(record.ownerEmail) || null : null;

      // Resolve account if Lead has an account CRM ID (uncommon but possible)
      const accountId = record.accountCrmId
        ? await _resolveCrmId(orgId, 'accounts', crmType, record.accountCrmId)
        : null;

      await _upsertProspect(orgId, crmType, record, ownerId, accountId, stageMap);
      upserted++;
    } catch (err) {
      console.error(`  ⚠️  [CRM Sync] Lead ${record.crmId}: ${err.message}`);
    }
  }

  console.log(`  ✓ [CRM Sync] Leads: ${upserted} upserted`);
  return { upserted, nextCursor };
}

// ─────────────────────────────────────────────────────────────────────────────
// DEAL CONTACTS SYNC
// ─────────────────────────────────────────────────────────────────────────────

async function _syncDealContacts(orgId, crmType, gwDealId, dealCrmId, adapter) {
  const roles = await adapter.getDealContacts(dealCrmId);
  if (roles.length === 0) return { synced: 0 };

  let synced = 0;
  for (const role of roles) {
    try {
      const contactId = await _resolveCrmId(orgId, 'contacts', crmType, role.contactCrmId);
      if (!contactId) continue; // Contact not synced yet

      await pool.query(`
        INSERT INTO deal_contacts (deal_id, contact_id, role, is_primary, created_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (deal_id, contact_id)
        DO UPDATE SET
          role       = COALESCE(EXCLUDED.role, deal_contacts.role),
          is_primary = EXCLUDED.is_primary
      `, [gwDealId, contactId, role.role || null, role.isPrimary]);

      synced++;
    } catch (err) {
      // Non-fatal per role
    }
  }

  return { synced };
}

// ─────────────────────────────────────────────────────────────────────────────
// DB UPSERT HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function _upsertAccount(orgId, crmType, record, ownerId) {
  const externalRefsJson     = JSON.stringify(record.externalRefs);
  const crmLookupJson        = JSON.stringify({ [crmType]: { id: record.crmId } });

  // Try update first (record already synced from a prior run)
  const upd = await pool.query(`
    UPDATE accounts SET
      name        = $2,
      domain      = COALESCE($3, domain),
      industry    = COALESCE($4, industry),
      size        = COALESCE($5, size),
      location    = COALESCE($6, location),
      description = COALESCE($7, description),
      owner_id    = COALESCE($8, owner_id),
      external_refs = external_refs || $9::jsonb,
      updated_at  = NOW()
    WHERE org_id = $1
      AND external_refs @> $10::jsonb
      AND deleted_at IS NULL
    RETURNING id
  `, [
    orgId, record.name, record.domain, record.industry,
    record.size, record.location, record.description,
    ownerId, externalRefsJson, crmLookupJson,
  ]);

  if (upd.rows.length > 0) return upd.rows[0].id;

  // Record not found — insert
  const ins = await pool.query(`
    INSERT INTO accounts (
      org_id, name, domain, industry, size, location, description,
      owner_id, external_refs, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW(), NOW())
    ON CONFLICT DO NOTHING
    RETURNING id
  `, [
    orgId, record.name, record.domain, record.industry,
    record.size, record.location, record.description,
    ownerId, externalRefsJson,
  ]);

  return ins.rows[0]?.id || null;
}

async function _upsertContact(orgId, crmType, record, userId, accountId) {
  const externalRefsJson = JSON.stringify(record.externalRefs);
  const crmLookupJson    = JSON.stringify({ [crmType]: { id: record.crmId } });

  const upd = await pool.query(`
    UPDATE contacts SET
      first_name  = $2,
      last_name   = $3,
      email       = COALESCE($4, email),
      phone       = COALESCE($5, phone),
      title       = COALESCE($6, title),
      location    = COALESCE($7, location),
      linkedin_url = COALESCE($8, linkedin_url),
      account_id  = COALESCE($9, account_id),
      user_id     = COALESCE($10, user_id),
      external_refs = external_refs || $11::jsonb,
      updated_at  = NOW()
    WHERE org_id = $1
      AND external_refs @> $12::jsonb
      AND deleted_at IS NULL
    RETURNING id
  `, [
    orgId, record.firstName, record.lastName,
    record.email, record.phone, record.title,
    record.location, record.linkedinUrl,
    accountId, userId,
    externalRefsJson, crmLookupJson,
  ]);

  if (upd.rows.length > 0) return upd.rows[0].id;

  const ins = await pool.query(`
    INSERT INTO contacts (
      org_id, first_name, last_name, email, phone, title,
      location, linkedin_url, account_id, user_id,
      external_refs, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, NOW(), NOW())
    ON CONFLICT DO NOTHING
    RETURNING id
  `, [
    orgId, record.firstName, record.lastName,
    record.email, record.phone, record.title,
    record.location, record.linkedinUrl,
    accountId, userId, externalRefsJson,
  ]);

  return ins.rows[0]?.id || null;
}

async function _upsertDeal(orgId, crmType, record, ownerId, accountId, gwStage) {
  const externalRefsJson = JSON.stringify(record.externalRefs);
  const crmLookupJson    = JSON.stringify({ [crmType]: { id: record.crmId } });

  // Use stage fallback 'discovery' only if stage map has no entry at all
  // (unmapped stages get logged as warnings above, but deals still get created)
  const stage = gwStage || 'discovery';

  const upd = await pool.query(`
    UPDATE deals SET
      name                  = $2,
      value                 = $3,
      stage                 = COALESCE($4, stage),
      expected_close_date   = COALESCE($5, expected_close_date),
      external_crm_close_date = COALESCE($5, external_crm_close_date),
      probability           = COALESCE($6, probability),
      notes                 = COALESCE($7, notes),
      account_id            = COALESCE($8, account_id),
      owner_id              = COALESCE($9, owner_id),
      user_id               = COALESCE($9, user_id),
      external_crm_type     = $10,
      external_crm_deal_id  = $11,
      external_refs         = external_refs || $12::jsonb,
      updated_at            = NOW()
    WHERE org_id = $1
      AND external_refs @> $13::jsonb
      AND deleted_at IS NULL
    RETURNING id
  `, [
    orgId, record.name, record.value, gwStage,
    record.expectedCloseDate, record.probability, record.notes,
    accountId, ownerId,
    crmType, record.crmId,
    externalRefsJson, crmLookupJson,
  ]);

  if (upd.rows.length > 0) return upd.rows[0].id;

  const ins = await pool.query(`
    INSERT INTO deals (
      org_id, name, value, stage, expected_close_date, external_crm_close_date,
      probability, notes, account_id, owner_id, user_id,
      external_crm_type, external_crm_deal_id,
      external_refs, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9, $9, $10, $11, $12::jsonb, NOW(), NOW())
    ON CONFLICT DO NOTHING
    RETURNING id
  `, [
    orgId, record.name, record.value, stage,
    record.expectedCloseDate, record.probability, record.notes,
    accountId, ownerId,
    crmType, record.crmId, externalRefsJson,
  ]);

  return ins.rows[0]?.id || null;
}

async function _upsertProspect(orgId, crmType, record, ownerId, accountId, stageMap) {
  const externalRefsJson = JSON.stringify(record.externalRefs);
  const crmLookupJson    = JSON.stringify({ [crmType]: { id: record.crmId } });
  const gwStage          = resolveStage(record.stageCrmKey, stageMap) || 'target';

  const upd = await pool.query(`
    UPDATE prospects SET
      first_name       = $2,
      last_name        = $3,
      email            = COALESCE($4, email),
      phone            = COALESCE($5, phone),
      title            = COALESCE($6, title),
      location         = COALESCE($7, location),
      linkedin_url     = COALESCE($8, linkedin_url),
      company_name     = COALESCE($9, company_name),
      company_domain   = COALESCE($10, company_domain),
      company_size     = COALESCE($11, company_size),
      company_industry = COALESCE($12, company_industry),
      source           = COALESCE($13, source),
      icp_score        = COALESCE($14, icp_score),
      account_id       = COALESCE($15, account_id),
      stage            = $16,
      external_refs    = external_refs || $17::jsonb,
      updated_at       = NOW()
    WHERE org_id = $1
      AND external_refs @> $18::jsonb
      AND deleted_at IS NULL
    RETURNING id
  `, [
    orgId, record.firstName, record.lastName,
    record.email, record.phone, record.title, record.location,
    record.linkedinUrl, record.companyName, record.companyDomain,
    record.companySize, record.companyIndustry,
    record.source, record.icpScore,
    accountId, gwStage,
    externalRefsJson, crmLookupJson,
  ]);

  if (upd.rows.length > 0) return upd.rows[0].id;

  // owner_id is NOT NULL on prospects — fall back to first org user
  const effectiveOwnerId = ownerId || await _getDefaultOwnerId(orgId);
  if (!effectiveOwnerId) throw new Error(`No users found for org ${orgId}`);

  const ins = await pool.query(`
    INSERT INTO prospects (
      org_id, owner_id, first_name, last_name, email, phone, title, location,
      linkedin_url, company_name, company_domain, company_size, company_industry,
      source, icp_score, account_id, stage,
      external_refs, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, NOW(), NOW())
    ON CONFLICT DO NOTHING
    RETURNING id
  `, [
    orgId, effectiveOwnerId,
    record.firstName, record.lastName, record.email, record.phone,
    record.title, record.location, record.linkedinUrl,
    record.companyName, record.companyDomain, record.companySize,
    record.companyIndustry, record.source, record.icpScore,
    accountId, gwStage, externalRefsJson,
  ]);

  return ins.rows[0]?.id || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// LEAD CONVERSION
// ─────────────────────────────────────────────────────────────────────────────

async function _handleLeadConversion(orgId, crmType, record) {
  // Find the GoWarm prospect for this lead
  const prospectRes = await pool.query(
    `SELECT id FROM prospects WHERE org_id = $1 AND external_refs @> $2::jsonb AND deleted_at IS NULL LIMIT 1`,
    [orgId, JSON.stringify({ [crmType]: { id: record.crmId } })]
  );
  if (prospectRes.rows.length === 0) return; // Not synced yet

  const prospectId = prospectRes.rows[0].id;

  // Update prospect's external_refs with conversion data
  await pool.query(`
    UPDATE prospects
    SET external_refs = external_refs || $2::jsonb, updated_at = NOW()
    WHERE id = $1
  `, [prospectId, JSON.stringify({
    [crmType]: {
      id:                     record.crmId,
      converted:              true,
      converted_contact_id:   record.convertedContactId,
      converted_account_id:   record.convertedAccountId,
      converted_deal_id:      record.convertedDealId,
    },
  })]);

  // If contact was created from this lead conversion, link prospect → contact
  if (record.convertedContactId) {
    const contactId = await _resolveCrmId(orgId, 'contacts', crmType, record.convertedContactId);
    if (contactId) {
      await pool.query(
        `UPDATE prospects SET contact_id = $1, updated_at = NOW() WHERE id = $2`,
        [contactId, prospectId]
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RESOLUTION HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a CRM native ID to a GoWarm row id via external_refs lookup.
 *
 * @param {number} orgId
 * @param {string} table     - 'accounts' | 'contacts' | 'deals' | 'prospects'
 * @param {string} crmType   - 'salesforce' | 'hubspot'
 * @param {string} crmId     - CRM native ID
 * @returns {number|null}    - GoWarm row id, or null if not found
 */
async function _resolveCrmId(orgId, table, crmType, crmId) {
  if (!crmId) return null;
  const res = await pool.query(
    `SELECT id FROM ${table} WHERE org_id = $1 AND external_refs @> $2::jsonb AND deleted_at IS NULL LIMIT 1`,
    [orgId, JSON.stringify({ [crmType]: { id: crmId } })]
  );
  return res.rows[0]?.id || null;
}

/**
 * Batch-resolve owner emails to GoWarm user IDs.
 * Returns a Map<email, userId>.
 *
 * @param {number}   orgId
 * @param {string[]} emails
 * @returns {Map<string, number>}
 */
async function _resolveOwners(orgId, emails) {
  const map = new Map();
  if (emails.length === 0) return map;

  const lowerEmails = emails.map(e => e.toLowerCase());
  const res = await pool.query(
    `SELECT u.id, LOWER(u.email) AS email
     FROM users u
     JOIN org_users ou ON ou.user_id = u.id
     WHERE ou.org_id = $1
       AND LOWER(u.email) = ANY($2::text[])
       AND ou.is_active = true`,
    [orgId, lowerEmails]
  );

  for (const row of res.rows) {
    map.set(row.email, row.id);
  }
  return map;
}

/**
 * Get the first user in an org as the default owner fallback.
 * Used for prospects (which have a NOT NULL owner_id).
 */
async function _getDefaultOwnerId(orgId) {
  const res = await pool.query(
    `SELECT user_id FROM org_users WHERE org_id = $1 AND is_active = true ORDER BY joined_at ASC LIMIT 1`,
    [orgId]
  );
  return res.rows[0]?.user_id || null;
}

/**
 * Save a sync cursor for a specific CRM object type.
 * Cursor = LastModifiedDate of the last processed record.
 * Stored in org_integrations.settings.sync_cursors.{objectType}
 */
async function _saveCursor(orgId, crmType, objectType, cursor) {
  await pool.query(`
    UPDATE org_integrations
    SET settings = jsonb_set(settings, $3, $4::jsonb), updated_at = NOW()
    WHERE org_id = $1 AND integration_type = $2
  `, [orgId, crmType, `{sync_cursors,${objectType}}`, JSON.stringify(cursor)]);
}

// ─────────────────────────────────────────────────────────────────────────────
// CONNECTED ORGS (for scheduler)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return all org IDs with an active CRM connection of a given type.
 * Used by syncScheduler to drive nightly cron.
 *
 * @param {string} crmType  - 'salesforce' | 'hubspot'
 * @returns {number[]}
 */
async function getConnectedOrgs(crmType) {
  const res = await pool.query(`
    SELECT oi.org_id
    FROM org_integrations oi
    WHERE oi.integration_type = $1
      AND oi.instance_url IS NOT NULL
      AND oi.connected_at IS NOT NULL
      AND oi.sync_status != 'running'
  `, [crmType]);
  return res.rows.map(r => r.org_id);
}

module.exports = { runSyncForOrg, getConnectedOrgs };
