const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');

router.use(authenticateToken);
router.use(orgContext);

// ── GET / — list accounts ────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM accounts WHERE org_id = $1 AND owner_id = $2 ORDER BY name',
      [req.orgId, req.user.userId]
    );
    res.json({ accounts: result.rows });
  } catch (error) {
    res.status(500).json({ error: { message: 'Failed to fetch accounts' } });
  }
});

// ── GET /duplicates — find duplicate account groups ──────────────────────────
router.get('/duplicates', async (req, res) => {
  try {
    // Group 1: Same domain (case-insensitive, non-empty)
    const domainDupes = await db.query(
      `SELECT LOWER(domain) AS match_key, 'domain' AS match_type,
              json_agg(
                json_build_object(
                  'id', a.id, 'name', a.name, 'domain', a.domain,
                  'industry', a.industry, 'size', a.size,
                  'location', a.location, 'description', a.description,
                  'created_at', a.created_at
                ) ORDER BY a.created_at ASC
              ) AS accounts
       FROM accounts a
       WHERE a.org_id = $1 AND a.owner_id = $2
         AND a.domain IS NOT NULL AND a.domain != ''
       GROUP BY LOWER(a.domain)
       HAVING COUNT(*) > 1`,
      [req.orgId, req.user.userId]
    );

    // Group 2: Same name (case-insensitive)
    const nameDupes = await db.query(
      `SELECT LOWER(name) AS match_key, 'name' AS match_type,
              json_agg(
                json_build_object(
                  'id', a.id, 'name', a.name, 'domain', a.domain,
                  'industry', a.industry, 'size', a.size,
                  'location', a.location, 'description', a.description,
                  'created_at', a.created_at
                ) ORDER BY a.created_at ASC
              ) AS accounts
       FROM accounts a
       WHERE a.org_id = $1 AND a.owner_id = $2
       GROUP BY LOWER(a.name)
       HAVING COUNT(*) > 1`,
      [req.orgId, req.user.userId]
    );

    // Deduplicate groups
    const seenPairs = new Set();
    const groups = [];
    for (const row of [...domainDupes.rows, ...nameDupes.rows]) {
      const ids = row.accounts.map(a => a.id).sort().join(',');
      if (!seenPairs.has(ids)) {
        seenPairs.add(ids);
        groups.push({
          matchType: row.match_type,
          matchKey:  row.match_key,
          accounts:  row.accounts,
        });
      }
    }

    res.json({ duplicateGroups: groups, totalGroups: groups.length });
  } catch (error) {
    console.error('Get account duplicates error:', error);
    res.status(500).json({ error: { message: 'Failed to find duplicates' } });
  }
});

// ── POST / — create account (with duplicate prevention) ──────────────────────
router.post('/', async (req, res) => {
  try {
    const { name, domain, industry, size, location, description } = req.body;

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
    res.status(201).json({ account: result.rows[0] });
  } catch (error) {
    console.error('Create account error:', error);
    res.status(500).json({ error: { message: 'Failed to create account' } });
  }
});

// ── PUT /:id — update account ────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const { name, domain, industry, size, location, description } = req.body;

    const result = await db.query(
      `UPDATE accounts
       SET name        = COALESCE($1, name),
           domain      = COALESCE($2, domain),
           industry    = COALESCE($3, industry),
           size        = COALESCE($4, size),
           location    = COALESCE($5, location),
           description = COALESCE($6, description),
           updated_at  = CURRENT_TIMESTAMP
       WHERE id = $7 AND org_id = $8 AND owner_id = $9
       RETURNING *`,
      [name, domain, industry, size, location, description, req.params.id, req.orgId, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Account not found' } });
    }

    res.json({ account: result.rows[0] });
  } catch (error) {
    console.error('Update account error:', error);
    res.status(500).json({ error: { message: 'Failed to update account' } });
  }
});

// ── POST /merge — merge two accounts ─────────────────────────────────────────
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

    // Verify both belong to this user/org
    const bothRes = await client.query(
      `SELECT id, name, domain, industry, size, location, description
       FROM accounts WHERE id IN ($1, $2) AND org_id = $3 AND owner_id = $4`,
      [keepId, removeId, req.orgId, req.user.userId]
    );
    if (bothRes.rows.length !== 2) {
      return res.status(404).json({ error: { message: 'One or both accounts not found' } });
    }
    const keepAcct   = bothRes.rows.find(r => r.id === keepId);
    const removeAcct = bothRes.rows.find(r => r.id === removeId);

    await client.query('BEGIN');

    // 1. Apply field overrides
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

    // 2. Move contacts from removed account to keeper
    await client.query(
      `UPDATE contacts SET account_id = $1, updated_at = CURRENT_TIMESTAMP WHERE account_id = $2`,
      [keepId, removeId]
    );

    // 3. Move deals from removed account to keeper
    await client.query(
      `UPDATE deals SET account_id = $1, updated_at = CURRENT_TIMESTAMP WHERE account_id = $2`,
      [keepId, removeId]
    );

    // 4. Delete the removed account
    await client.query(
      `DELETE FROM accounts WHERE id = $1 AND org_id = $2`,
      [removeId, req.orgId]
    );

    await client.query('COMMIT');

    // Fetch updated keeper
    const updatedRes = await db.query(
      `SELECT * FROM accounts WHERE id = $1`,
      [keepId]
    );

    res.json({
      success: true,
      mergedAccount: updatedRes.rows[0],
      removedId: removeId,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Merge accounts error:', error);
    res.status(500).json({ error: { message: 'Failed to merge accounts' } });
  } finally {
    client.release();
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
