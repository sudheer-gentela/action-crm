/**
 * /api/prospect-phones
 *
 * CRUD for a prospect's phone numbers (prospect_phones child table). One number
 * per prospect is is_primary=true; prospects.phone is kept as a denormalized
 * mirror of that primary so existing reads keep working.
 *
 * Endpoints (all org-scoped, prospecting module):
 *   GET    /api/prospect-phones?prospect_id=123   list a prospect's numbers
 *   POST   /api/prospect-phones                   add { prospect_id, phone, label?, is_primary? }
 *   PATCH  /api/prospect-phones/:id               edit { phone?, label?, is_primary? }
 *   DELETE /api/prospect-phones/:id               remove (promotes a new primary if needed)
 *
 * Mount in server.js:
 *   app.use('/api/prospect-phones', require('./routes/prospect-phones.routes'));
 */

const express = require('express');
const router  = express.Router();

const db                = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');
const requireModule     = require('../middleware/requireModule.middleware');
const CallSettingsService = require('../services/callSettings.service');

router.use(authenticateToken);
router.use(orgContext);
router.use(requireModule('prospecting'));

// Phone validation strictness is a per-org setting (call_settings.phone_validation:
// 'lenient' | 'strict'). The actual rule lives in CallSettingsService.isPhoneValid
// so entry validation here and any other importer stay consistent.
async function validatePhoneForOrg(orgId, phone) {
  const settings = await CallSettingsService.getForOrg(orgId);
  const mode = settings.phone_validation || 'lenient';
  if (CallSettingsService.isPhoneValid(mode, phone)) return null;
  return {
    message: mode === 'strict'
      ? 'Enter the number in E.164 format, e.g. +14155551234.'
      : 'Enter a valid phone number.',
    code: 'INVALID_PHONE',
  };
}

function cleanPhone(raw) {
  return String(raw == null ? '' : raw).trim();
}

// Re-point prospects.phone at the current primary (or NULL if none). Called
// after any mutation that could change which number is primary.
async function syncPrimaryMirror(client, prospectId, orgId) {
  await client.query(
    `UPDATE prospects p
        SET phone = (
              SELECT pp.phone FROM prospect_phones pp
               WHERE pp.prospect_id = p.id AND pp.is_primary = true
               LIMIT 1
            ),
            updated_at = NOW()
      WHERE p.id = $1 AND p.org_id = $2`,
    [prospectId, orgId]
  );
}

// Confirm the prospect belongs to this org (and isn't deleted).
async function assertProspect(prospectId, orgId) {
  const { rows } = await db.pool.query(
    `SELECT id FROM prospects WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
    [prospectId, orgId]
  );
  return rows.length > 0;
}


// =========================================================================
// GET /?prospect_id=123 — list a prospect's numbers (primary first)
// =========================================================================
router.get('/', async (req, res) => {
  const prospectId = parseInt(req.query.prospect_id, 10);
  if (!Number.isInteger(prospectId) || prospectId <= 0) {
    return res.status(400).json({ error: { message: 'prospect_id is required' } });
  }
  try {
    const { rows } = await db.pool.query(
      `SELECT id, phone, label, is_primary, created_at
         FROM prospect_phones
        WHERE prospect_id = $1 AND org_id = $2
        ORDER BY is_primary DESC, created_at ASC, id ASC`,
      [prospectId, req.orgId]
    );
    return res.json({ phones: rows });
  } catch (err) {
    console.error('GET /prospect-phones error:', err);
    return res.status(500).json({ error: { message: 'Failed to load phone numbers' } });
  }
});


// =========================================================================
// POST / — add a number
// =========================================================================
// Body: { prospect_id, phone, label?, is_primary? }
// First number for a prospect is forced primary. Setting is_primary unsets the
// previous primary. Mirror is synced.
// =========================================================================
router.post('/', async (req, res) => {
  const prospectId = parseInt(req.body.prospect_id, 10);
  const phone      = cleanPhone(req.body.phone);
  const label      = req.body.label ? String(req.body.label).trim().slice(0, 40) : null;
  let   wantPrimary = req.body.is_primary === true;

  if (!Number.isInteger(prospectId) || prospectId <= 0) {
    return res.status(400).json({ error: { message: 'prospect_id is required' } });
  }
  const phoneErr = await validatePhoneForOrg(req.orgId, phone);
  if (phoneErr) {
    return res.status(400).json({ error: phoneErr });
  }
  if (!(await assertProspect(prospectId, req.orgId))) {
    return res.status(404).json({ error: { message: 'Prospect not found' } });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Force primary if this is the prospect's first number.
    const { rows: cntRows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM prospect_phones WHERE prospect_id = $1 AND org_id = $2`,
      [prospectId, req.orgId]
    );
    if (cntRows[0].n === 0) wantPrimary = true;

    if (wantPrimary) {
      await client.query(
        `UPDATE prospect_phones SET is_primary = false, updated_at = NOW()
          WHERE prospect_id = $1 AND org_id = $2 AND is_primary = true`,
        [prospectId, req.orgId]
      );
    }

    let inserted;
    try {
      const ins = await client.query(
        `INSERT INTO prospect_phones (org_id, prospect_id, phone, label, is_primary)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, phone, label, is_primary, created_at`,
        [req.orgId, prospectId, phone, label, wantPrimary]
      );
      inserted = ins.rows[0];
    } catch (err) {
      if (err.code === '23505') {  // unique_violation on (prospect_id, phone)
        await client.query('ROLLBACK');
        return res.status(409).json({ error: { message: 'This number is already on the prospect.', code: 'DUPLICATE_PHONE' } });
      }
      throw err;
    }

    if (wantPrimary) await syncPrimaryMirror(client, prospectId, req.orgId);

    await client.query('COMMIT');
    return res.status(201).json({ phone: inserted });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /prospect-phones error:', err);
    return res.status(500).json({ error: { message: 'Failed to add phone number' } });
  } finally {
    client.release();
  }
});


// =========================================================================
// PATCH /:id — edit a number (phone / label / make primary)
// =========================================================================
router.patch('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: { message: 'Invalid phone id' } });
  }

  const sets = [];
  const vals = [];
  let i = 1;

  if ('phone' in req.body) {
    const phone = cleanPhone(req.body.phone);
    const phoneErr = await validatePhoneForOrg(req.orgId, phone);
    if (phoneErr) {
      return res.status(400).json({ error: phoneErr });
    }
    sets.push(`phone = $${i++}`); vals.push(phone);
  }
  if ('label' in req.body) {
    sets.push(`label = $${i++}`);
    vals.push(req.body.label ? String(req.body.label).trim().slice(0, 40) : null);
  }
  const makePrimary = req.body.is_primary === true;

  if (!sets.length && !makePrimary) {
    return res.status(400).json({ error: { message: 'No editable fields supplied' } });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Ownership + get prospect_id.
    const { rows: own } = await client.query(
      `SELECT prospect_id FROM prospect_phones WHERE id = $1 AND org_id = $2`,
      [id, req.orgId]
    );
    if (!own.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Phone number not found' } });
    }
    const prospectId = own[0].prospect_id;

    if (makePrimary) {
      await client.query(
        `UPDATE prospect_phones SET is_primary = false, updated_at = NOW()
          WHERE prospect_id = $1 AND org_id = $2 AND is_primary = true`,
        [prospectId, req.orgId]
      );
      sets.push(`is_primary = $${i++}`); vals.push(true);
    }

    sets.push(`updated_at = NOW()`);
    vals.push(id, req.orgId);

    let updated;
    try {
      const upd = await client.query(
        `UPDATE prospect_phones SET ${sets.join(', ')}
          WHERE id = $${i++} AND org_id = $${i++}
          RETURNING id, phone, label, is_primary, created_at`,
        vals
      );
      updated = upd.rows[0];
    } catch (err) {
      if (err.code === '23505') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: { message: 'This number is already on the prospect.', code: 'DUPLICATE_PHONE' } });
      }
      throw err;
    }

    await syncPrimaryMirror(client, prospectId, req.orgId);
    await client.query('COMMIT');
    return res.json({ phone: updated });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('PATCH /prospect-phones/:id error:', err);
    return res.status(500).json({ error: { message: 'Failed to update phone number' } });
  } finally {
    client.release();
  }
});


// =========================================================================
// DELETE /:id — remove a number; promote a new primary if the deleted one was
// =========================================================================
router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: { message: 'Invalid phone id' } });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `DELETE FROM prospect_phones WHERE id = $1 AND org_id = $2
       RETURNING prospect_id, is_primary`,
      [id, req.orgId]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Phone number not found' } });
    }
    const { prospect_id: prospectId, is_primary: wasPrimary } = rows[0];

    // If we removed the primary, promote the oldest remaining number.
    if (wasPrimary) {
      await client.query(
        `UPDATE prospect_phones
            SET is_primary = true, updated_at = NOW()
          WHERE id = (
            SELECT id FROM prospect_phones
             WHERE prospect_id = $1 AND org_id = $2
             ORDER BY created_at ASC, id ASC
             LIMIT 1
          )`,
        [prospectId, req.orgId]
      );
    }

    await syncPrimaryMirror(client, prospectId, req.orgId);
    await client.query('COMMIT');
    return res.json({ deleted: true, id });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('DELETE /prospect-phones/:id error:', err);
    return res.status(500).json({ error: { message: 'Failed to delete phone number' } });
  } finally {
    client.release();
  }
});

module.exports = router;
