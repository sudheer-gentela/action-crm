const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');
const { workflowRulesMiddleware } = require('../middleware/workflowRules.middleware');
const { normalizeDomain, CATCHALL_DOMAIN } = require('../services/domainResolver');

router.use(authenticateToken);
router.use(orgContext);

// ── GET / — list accounts ────────────────────────────────────────────────────
// Supports ?scope=mine|team|org (default: mine)
router.get('/', async (req, res) => {
  try {
    const { scope = 'mine' } = req.query;
    let query = 'SELECT * FROM accounts WHERE org_id = $1';
    const params = [req.orgId];

    if (scope === 'team' && req.subordinateIds?.length > 0) {
      const teamIds = [req.user.userId, ...req.subordinateIds];
      query += ` AND owner_id = ANY($${params.length + 1}::int[])`;
      params.push(teamIds);
    } else if (scope === 'org') {
      // No owner filter — all org accounts
    } else {
      query += ` AND owner_id = $${params.length + 1}`;
      params.push(req.user.userId);
    }

    query += ' ORDER BY name';
    const result = await db.query(query, params);
    res.json({ accounts: result.rows });
  } catch (error) {
    res.status(500).json({ error: { message: 'Failed to fetch accounts' } });
  }
});

// ── GET /duplicates — find duplicate account groups ──────────────────────────
router.get('/duplicates', async (req, res) => {
  try {
    // ── Read org-level duplicate detection settings ──────────
    const orgRes = await db.query(`SELECT settings FROM organizations WHERE id = $1`, [req.orgId]);
    const settings = orgRes.rows[0]?.settings || {};
    const dedupConfig = settings.duplicate_detection || {};

    // Enabled rules (default: all on)
    const domainMatchEnabled = dedupConfig.account_domain_match !== false;
    const nameMatchEnabled   = dedupConfig.account_name_match !== false;

    // Visibility: 'org' (default) = all accounts in org; 'own' = only user's accounts
    const visibility = dedupConfig.account_visibility || 'org';

    // Build the scope filter
    let scopeFilter = `a.org_id = $1`;
    const scopeParams = [req.orgId];
    if (visibility === 'own') {
      scopeFilter += ` AND a.owner_id = $${scopeParams.length + 1}`;
      scopeParams.push(req.user.userId);
    }

    const groups = [];
    const seenPairs = new Set();

    // Group 1: Same domain (case-insensitive, non-empty)
    if (domainMatchEnabled) {
      const domainDupes = await db.query(
        `SELECT LOWER(domain) AS match_key, 'domain' AS match_type,
                json_agg(
                  json_build_object(
                    'id', a.id, 'name', a.name, 'domain', a.domain,
                    'industry', a.industry, 'size', a.size,
                    'location', a.location, 'description', a.description,
                    'owner_id', a.owner_id,
                    'created_at', a.created_at
                  ) ORDER BY a.created_at ASC
                ) AS accounts
         FROM accounts a
         WHERE ${scopeFilter}
           AND a.domain IS NOT NULL AND a.domain != ''
         GROUP BY LOWER(a.domain)
         HAVING COUNT(*) > 1`,
        scopeParams
      );
      for (const row of domainDupes.rows) {
        const ids = row.accounts.map(a => a.id).sort().join(',');
        if (!seenPairs.has(ids)) {
          seenPairs.add(ids);
          groups.push({ matchType: row.match_type, matchKey: row.match_key, accounts: row.accounts });
        }
      }
    }

    // Group 2: Same name (case-insensitive)
    if (nameMatchEnabled) {
      const nameDupes = await db.query(
        `SELECT LOWER(name) AS match_key, 'name' AS match_type,
                json_agg(
                  json_build_object(
                    'id', a.id, 'name', a.name, 'domain', a.domain,
                    'industry', a.industry, 'size', a.size,
                    'location', a.location, 'description', a.description,
                    'owner_id', a.owner_id,
                    'created_at', a.created_at
                  ) ORDER BY a.created_at ASC
                ) AS accounts
         FROM accounts a
         WHERE ${scopeFilter}
         GROUP BY LOWER(a.name)
         HAVING COUNT(*) > 1`,
        scopeParams
      );
      for (const row of nameDupes.rows) {
        const ids = row.accounts.map(a => a.id).sort().join(',');
        if (!seenPairs.has(ids)) {
          seenPairs.add(ids);
          groups.push({ matchType: row.match_type, matchKey: row.match_key, accounts: row.accounts });
        }
      }
    }

    res.json({ duplicateGroups: groups, totalGroups: groups.length });
  } catch (error) {
    console.error('Get account duplicates error:', error);
    res.status(500).json({ error: { message: 'Failed to find duplicates' } });
  }
});

// ── POST / — create account (with duplicate prevention) ──────────────────────
router.post('/', workflowRulesMiddleware('account', 'create'), async (req, res) => {
  try {
    const p = req.mutatedPayload || req.body;
    const { name, domain, industry, size, location, description } = p;

    // Prevention: same domain in this org
    if (domain) {
      const domainDup = await db.query(
        `SELECT id, name FROM accounts
         WHERE org_id = $1 AND owner_id = $2 AND LOWER(domain) = LOWER($3)`,
        [req.orgId, req.user.userId, domain]
      );
      if (domainDup.rows.length > 0) {
        const dup = domainDup.rows[0];
        return res.status(409).json({
          error: {
            message: `An account with domain "${domain}" already exists: ${dup.name} (ID ${dup.id})`,
            code: 'DUPLICATE_DOMAIN',
            existingAccountId: dup.id,
          }
        });
      }
    }
    // Prevention: same name
    if (name) {
      const nameDup = await db.query(
        `SELECT id, name FROM accounts
         WHERE org_id = $1 AND owner_id = $2 AND LOWER(name) = LOWER($3)`,
        [req.orgId, req.user.userId, name]
      );
      if (nameDup.rows.length > 0) {
        const dup = nameDup.rows[0];
        return res.status(409).json({
          error: {
            message: `An account named "${name}" already exists (ID ${dup.id})`,
            code: 'DUPLICATE_NAME',
            existingAccountId: dup.id,
          }
        });
      }
    }

    const result = await db.query(
      `INSERT INTO accounts (org_id, name, domain, industry, size, location, description, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.orgId, name, domain, industry, size, location, description, req.user.userId]
    );
    const response = { account: result.rows[0] };
    // Collect all warnings — workflow engine warnings + domain warning
    const warnings = [...(req.ruleWarnings || [])];
    if (!domain || !domain.trim()) {
      warnings.push({
        field:    'domain',
        message:  'Account domain is missing — emails and meetings from this account\'s contacts may not be auto-linked',
        severity: 'warn',
        code:     'MISSING_ACCOUNT_DOMAIN',
      });
    }
    if (warnings.length > 0) response.warnings = warnings;
    res.status(201).json(response);
  } catch (error) {
    console.error('Create account error:', error);
    res.status(500).json({ error: { message: 'Failed to create account' } });
  }
});

// ── POST /bulk — bulk-create accounts from CSV import ────────────────────────
// Body: { rows: [{ name, domain?, industry?, size?, location?, description? }] }
// Returns: { imported: number, accounts: [], errors: [{ row, message }] }
router.post('/bulk', async (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: { message: 'rows array is required' } });
    }

    const MAX_ROWS = 500;
    if (rows.length > MAX_ROWS) {
      return res.status(400).json({ error: { message: `Maximum ${MAX_ROWS} rows per import` } });
    }

    const imported = [];
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2; // +2 because row 1 is headers, data starts at 2
      try {
        if (!row.name || !row.name.trim()) {
          errors.push({ row: rowNum, message: 'Account name is required' });
          continue;
        }

        const result = await db.query(
          `INSERT INTO accounts (org_id, name, domain, industry, size, location, description, owner_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [req.orgId, row.name.trim(), row.domain || null, row.industry || null,
           row.size || null, row.location || null, row.description || null, req.user.userId]
        );
        imported.push(result.rows[0]);
      } catch (err) {
        if (err.code === '23505') {
          errors.push({ row: rowNum, message: `Duplicate: ${row.name}` });
        } else {
          errors.push({ row: rowNum, message: err.message });
        }
      }
    }

    console.log(`📥 Bulk account import: ${imported.length} imported, ${errors.length} errors (org ${req.orgId})`);
    res.json({ imported: imported.length, accounts: imported, errors });
  } catch (error) {
    console.error('Bulk account import error:', error);
    res.status(500).json({ error: { message: 'Failed to bulk import accounts' } });
  }
});

// ── POST /merge — merge two accounts ─────────────────────────────────────────
// ⚠️  Must be declared BEFORE /:id routes so Express doesn't treat "merge" as an id
// Allows merge if both accounts are owned by user OR their subordinates (team scope)
router.post('/merge', async (req, res) => {
  const client = await (db.pool ? db.pool.connect() : db.connect());
  try {
    const { keepId, removeId, fieldOverrides = {} } = req.body;
    if (!keepId || !removeId) {
      return res.status(400).json({ error: { message: 'keepId and removeId are required' } });
    }
    if (keepId === removeId) {
      return res.status(400).json({ error: { message: 'Cannot merge an account with itself' } });
    }

    // Verify BOTH accounts belong to THIS org
    const bothRes = await client.query(
      `SELECT id, name, domain, industry, size, location, description, owner_id, org_id
       FROM accounts WHERE id IN ($1, $2) AND org_id = $3`,
      [keepId, removeId, req.orgId]
    );
    if (bothRes.rows.length !== 2) {
      return res.status(404).json({ error: { message: 'One or both accounts not found in your organisation' } });
    }

    const keepAcct   = bothRes.rows.find(r => r.id === keepId);
    const removeAcct = bothRes.rows.find(r => r.id === removeId);

    // Double-check org_id matches on both (belt + suspenders)
    if (keepAcct.org_id !== req.orgId || removeAcct.org_id !== req.orgId) {
      return res.status(403).json({ error: { message: 'Cannot merge accounts from different organisations' } });
    }

    // Authorization: user can merge if they own the accounts OR if the accounts
    // are owned by their subordinates (team hierarchy scope)
    const allowedOwnerIds = req.teamUserIds || [req.user.userId];
    if (!allowedOwnerIds.includes(keepAcct.owner_id) || !allowedOwnerIds.includes(removeAcct.owner_id)) {
      return res.status(403).json({ error: { message: 'You can only merge accounts owned by you or your team' } });
    }

    await client.query('BEGIN');

    // 0. Archive the removed account for recovery (create table if needed)
    await client.query(`
      CREATE TABLE IF NOT EXISTS merged_accounts_archive (
        id              SERIAL PRIMARY KEY,
        original_id     INTEGER NOT NULL,
        merged_into_id  INTEGER NOT NULL,
        org_id          INTEGER NOT NULL,
        account_data    JSONB NOT NULL,
        merged_by       INTEGER,
        field_overrides JSONB DEFAULT '{}',
        merged_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      INSERT INTO merged_accounts_archive (original_id, merged_into_id, org_id, account_data, merged_by, field_overrides)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      removeId,
      keepId,
      req.orgId,
      JSON.stringify(removeAcct),
      req.user.userId,
      JSON.stringify(fieldOverrides),
    ]);

    // 1. Apply field overrides to keeper
    const overridableFields = ['name', 'domain', 'industry', 'size', 'location', 'description'];
    const updates = [];
    const values  = [];
    let paramIdx  = 1;

    for (const field of overridableFields) {
      if (fieldOverrides[field] === 'from_remove' && removeAcct[field]) {
        updates.push(`${field} = $${paramIdx}`);
        values.push(removeAcct[field]);
        paramIdx++;
      }
    }

    if (updates.length > 0) {
      values.push(keepId);
      await client.query(
        `UPDATE accounts SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
         WHERE id = $${paramIdx}`,
        values
      );
    }

    // 2. Move contacts — scoped to org_id to prevent cross-org contamination
    const movedContacts = await client.query(
      `UPDATE contacts SET account_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE account_id = $2 AND org_id = $3
       RETURNING id`,
      [keepId, removeId, req.orgId]
    );

    // 3. Move deals — scoped to org_id
    const movedDeals = await client.query(
      `UPDATE deals SET account_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE account_id = $2 AND org_id = $3
       RETURNING id`,
      [keepId, removeId, req.orgId]
    );

    // 4. Delete the removed account (org-scoped)
    await client.query(
      `DELETE FROM accounts WHERE id = $1 AND org_id = $2`,
      [removeId, req.orgId]
    );

    await client.query('COMMIT');

    console.log(`🔗 Account merge: kept #${keepId}, removed #${removeId} (org ${req.orgId}) — moved ${movedContacts.rowCount} contacts, ${movedDeals.rowCount} deals. Archived for recovery.`);

    // Fetch updated keeper
    const updatedRes = await db.query(
      `SELECT * FROM accounts WHERE id = $1`,
      [keepId]
    );

    res.json({
      success: true,
      mergedAccount: updatedRes.rows[0],
      removedId: removeId,
      movedContacts: movedContacts.rowCount,
      movedDeals: movedDeals.rowCount,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Merge accounts error:', error);
    res.status(500).json({ error: { message: 'Failed to merge accounts' } });
  } finally {
    client.release();
  }
});

// ── PUT /:id — update account ────────────────────────────────────────────────
router.put('/:id', workflowRulesMiddleware('account', 'update'), async (req, res) => {
  try {
    const p = req.mutatedPayload || req.body;
    const { name, domain, industry, size, location, description } = p;

    // Normalize the domain. If the writer sent a real domain, this trims
    // protocol/path/etc. If they sent linkedin.com or a personal-email host,
    // normalizeDomain returns null and we don't overwrite the existing value.
    // To support the user explicitly clearing the field, we treat the literal
    // empty string as "clear it" while undefined leaves it alone.
    let domainForUpdate;
    if (domain === undefined) {
      domainForUpdate = undefined;        // leave unchanged
    } else if (domain === '' || domain === null) {
      domainForUpdate = null;              // explicit clear
    } else {
      const normalized = normalizeDomain(domain);
      domainForUpdate = normalized || undefined;  // junk → leave unchanged
    }

    // If a real (non-catchall) domain is being set, also clear the review flag.
    const clearReviewFlag =
      typeof domainForUpdate === 'string' &&
      domainForUpdate.length > 0 &&
      domainForUpdate !== CATCHALL_DOMAIN;

    const result = await db.query(
      `UPDATE accounts
       SET name        = COALESCE($1, name),
           domain      = COALESCE($2, domain),
           industry    = COALESCE($3, industry),
           size        = COALESCE($4, size),
           location    = COALESCE($5, location),
           description = COALESCE($6, description),
           needs_domain_review = CASE WHEN $7 THEN FALSE ELSE needs_domain_review END,
           updated_at  = CURRENT_TIMESTAMP
       WHERE id = $8 AND org_id = $9 AND owner_id = $10
       RETURNING *`,
      [name, domainForUpdate, industry, size, location, description,
       clearReviewFlag, req.params.id, req.orgId, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Account not found' } });
    }

    const updatedAccount = result.rows[0];
    const putResponse = { account: updatedAccount };
    const putWarnings = [...(req.ruleWarnings || [])];
    if (!updatedAccount.domain || !updatedAccount.domain.trim()) {
      putWarnings.push({
        field:    'domain',
        message:  'Account domain is missing — emails and meetings from this account\'s contacts may not be auto-linked',
        severity: 'warn',
        code:     'MISSING_ACCOUNT_DOMAIN',
      });
    }
    if (putWarnings.length > 0) putResponse.warnings = putWarnings;
    res.json(putResponse);
  } catch (error) {
    console.error('Update account error:', error);
    res.status(500).json({ error: { message: 'Failed to update account' } });
  }
});

// ── DELETE /:id — delete account ─────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM accounts WHERE id = $1 AND org_id = $2 AND owner_id = $3 RETURNING id',
      [req.params.id, req.orgId, req.user.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Account not found' } });
    }
    res.json({ message: 'Account deleted' });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ error: { message: 'Failed to delete account' } });
  }
});

module.exports = router;
