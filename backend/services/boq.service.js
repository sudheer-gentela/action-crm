// ─────────────────────────────────────────────────────────────────────────────
// boq.service.js — Bill of Quantities (2026_113 / 2026_114)
//
// A BoQ belongs to exactly one project. Vendor work spanning projects is
// handled on the budget side, so there is no cross-project order or allocation
// concept here.
//
// FOUR RULES THIS SERVICE EXISTS TO ENFORCE. Each protects a number that would
// otherwise be quietly wrong:
//
//   1. The client never supplies a rate. recordProgress reads it from the item
//      and snapshots it onto the entry. A client-supplied rate would let spend
//      be booked at any figure, and would break the guarantee that revising an
//      item rate cannot rewrite history.
//
//   2. A reversal reuses the ORIGINAL entry's rate, not the item's current
//      rate. Reversing a 250-rate entry at today's 400 rate would leave phantom
//      spend behind. This is the single easiest thing to get wrong here.
//
//   3. Progress is append-only at the database level. This service never issues
//      an UPDATE or DELETE against boq_progress — the trigger would reject it
//      anyway, but the code should not try.
//
//   4. A vendor must be an approved vendor. accounts has no 'vendor' type
//      (chk_account_type allows none|target|customer|churned), so vendor-ness
//      lives entirely in account_relationships. A bare FK would accept a
//      customer account.
// ─────────────────────────────────────────────────────────────────────────────

const { pool } = require('../config/database');

const PROCUREMENT_STATUSES = [
  'not_required', 'to_procure', 'rfq_issued', 'quoted',
  'po_issued', 'in_transit', 'delivered',
];

function bad(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

// ── Org configuration ────────────────────────────────────────────────────────
// organizations.settings jsonb, matching the playbook_default_access convention.
async function getConfig(orgId) {
  const { rows } = await pool.query(
    `SELECT settings->>'boq_progress_entry_mode' AS entry_mode,
            settings->>'boq_lock_active_bill'    AS lock_active
       FROM organizations WHERE id = $1`,
    [orgId]
  );
  const r = rows[0] || {};
  return {
    entryMode:  r.entry_mode === 'bulk_sheet' ? 'bulk_sheet' : 'per_item',
    lockActive: r.lock_active === 'true' || r.lock_active === true,
  };
}

// ── Bill ─────────────────────────────────────────────────────────────────────

async function getBill(handoverId, orgId) {
  const { rows: [bill] } = await pool.query(
    `SELECT b.id, b.handover_id, b.name, b.status, b.currency, b.notes,
            b.created_at, b.updated_at,
            u.first_name || ' ' || u.last_name AS created_by_name
       FROM boqs b
       LEFT JOIN users u ON u.id = b.created_by
      WHERE b.handover_id = $1 AND b.org_id = $2 AND b.status <> 'archived'
      LIMIT 1`,
    [handoverId, orgId]
  );
  if (!bill) return null;

  const [items, sections, config] = await Promise.all([
    pool.query(
      `SELECT * FROM boq_item_rollup WHERE boq_id = $1 ORDER BY section NULLS LAST, boq_item_id`,
      [bill.id]
    ),
    pool.query(
      `SELECT * FROM boq_section_rollup WHERE boq_id = $1 ORDER BY section`,
      [bill.id]
    ),
    getConfig(orgId),
  ]);

  const mapped = items.rows.map(mapItem);

  return {
    bill: {
      id: bill.id, handoverId: bill.handover_id, name: bill.name,
      status: bill.status, currency: bill.currency, notes: bill.notes,
      createdByName: bill.created_by_name, createdAt: bill.created_at,
    },
    items: mapped,
    sections: sections.rows.map(s => ({
      section:            s.section,
      items:              s.items,
      plannedAmount:      num(s.planned_amount),
      variationAmount:    num(s.approved_variation_amount),
      sanctionedAmount:   num(s.sanctioned_amount),
      spentAmount:        num(s.spent_amount),
      remainingAmount:    num(s.remaining_amount),
      overrunItems:       s.overrun_items,
      awaitingOrder:      s.awaiting_order,
      onOrder:            s.on_order,
      delivered:          s.delivered,
    })),
    totals: totalsOf(mapped),
    config: {
      // Surfaced so the UI shows the right entry screen and disables the right
      // fields, rather than guessing and being corrected by a 4xx.
      entryMode:   config.entryMode,
      itemsLocked: config.lockActive && bill.status === 'active',
    },
  };
}

function num(v) { return v === null || v === undefined ? 0 : Number(v); }

function mapItem(r) {
  return {
    id:                r.boq_item_id,
    section:           r.section,
    itemCode:          r.item_code,
    description:       r.description,
    unit:              r.unit,
    plannedQty:        num(r.planned_qty),
    rate:              num(r.rate),
    plannedAmount:     num(r.planned_amount),
    variationQty:      num(r.approved_variation_qty),
    variationAmount:   num(r.approved_variation_amount),
    sanctionedAmount:  num(r.sanctioned_amount),
    executedQty:       num(r.executed_qty),
    spentAmount:       num(r.spent_amount),
    remainingAmount:   num(r.remaining_amount),
    entryCount:        r.entry_count,
    lastEntryDate:     r.last_entry_date,
    vendorAccountId:   r.vendor_account_id,
    vendorName:        r.vendor_name,
    procurementStatus: r.procurement_status,
    procurementRef:    r.procurement_ref,
    // Derived here so every consumer agrees on what "overrun" means.
    isOverrun:         num(r.remaining_amount) < 0,
  };
}

function totalsOf(items) {
  const sum = (f) => items.reduce((a, i) => a + f(i), 0);
  return {
    itemCount:        items.length,
    plannedAmount:    sum(i => i.plannedAmount),
    variationAmount:  sum(i => i.variationAmount),
    sanctionedAmount: sum(i => i.sanctionedAmount),
    spentAmount:      sum(i => i.spentAmount),
    remainingAmount:  sum(i => i.remainingAmount),
    overrunItems:     items.filter(i => i.isOverrun).length,
    // Lines with nothing booked yet. A bill that is 90% unstarted has a
    // remaining figure that means very little, and the UI should be able to
    // say so.
    unstartedItems:   items.filter(i => i.entryCount === 0).length,
  };
}

async function createBill(handoverId, orgId, userId, data = {}) {
  const { rows: [h] } = await pool.query(
    `SELECT id FROM sales_handovers WHERE id = $1 AND org_id = $2`, [handoverId, orgId]
  );
  if (!h) throw bad('Project not found', 404);

  try {
    const { rows: [b] } = await pool.query(
      `INSERT INTO boqs (org_id, handover_id, name, status, currency, notes, created_by)
       VALUES ($1, $2, $3, 'draft', $4, $5, $6) RETURNING id`,
      [orgId, handoverId, (data.name || '').trim() || 'Bill of Quantities',
       (data.currency || 'INR').trim(), (data.notes || '').trim() || null, userId]
    );
    return { id: b.id };
  } catch (err) {
    // uq_boqs_one_live_per_project. Reported as a plain conflict rather than a
    // constraint name, since the user's action was reasonable.
    if (err.code === '23505') {
      throw bad('This project already has a bill. Archive it before creating another.', 409);
    }
    throw err;
  }
}

async function updateBill(boqId, orgId, data = {}) {
  const sets = [], params = [];
  const add = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

  if (data.name !== undefined)     add('name', (data.name || '').trim() || 'Bill of Quantities');
  if (data.notes !== undefined)    add('notes', (data.notes || '').trim() || null);
  if (data.currency !== undefined) add('currency', (data.currency || 'INR').trim());
  if (data.status !== undefined) {
    if (!['draft', 'active', 'archived'].includes(data.status)) throw bad('Unknown bill status');
    add('status', data.status);
  }
  if (!sets.length) return { updated: false };

  sets.push('updated_at = now()');
  params.push(boqId, orgId);
  const { rowCount } = await pool.query(
    `UPDATE boqs SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND org_id = $${params.length}`,
    params
  );
  if (!rowCount) throw bad('Bill not found', 404);
  return { updated: true };
}

// ── Items ────────────────────────────────────────────────────────────────────

async function assertItemsEditable(boqId, orgId) {
  const [{ rows: [b] }, config] = await Promise.all([
    pool.query(`SELECT status FROM boqs WHERE id = $1 AND org_id = $2`, [boqId, orgId]),
    getConfig(orgId),
  ]);
  if (!b) throw bad('Bill not found', 404);
  if (b.status === 'archived') throw bad('This bill is archived and cannot be changed.', 409);
  if (config.lockActive && b.status === 'active') {
    throw bad(
      'Quantities and rates are locked once the bill is active. Raise a variation instead.',
      409
    );
  }
  return b;
}

async function addItem(boqId, orgId, userId, data = {}) {
  await assertItemsEditable(boqId, orgId);

  const description = (data.description || '').trim();
  if (!description) throw bad('A description is required.');

  const qty  = data.plannedQty === undefined ? 0 : Number(data.plannedQty);
  const rate = data.rate === undefined ? 0 : Number(data.rate);
  if (!Number.isFinite(qty)  || qty  < 0) throw bad('Quantity must be zero or more.');
  if (!Number.isFinite(rate) || rate < 0) throw bad('Rate must be zero or more.');

  if (data.vendorAccountId) await assertApprovedVendor(data.vendorAccountId, orgId);

  // Sparse ordering, same rationale as the play checklist: leaves room to
  // insert a line between two others without renumbering the section.
  const { rows: [{ next_order: nextOrder }] } = await pool.query(
    `SELECT COALESCE(MAX(sort_order), 0) + 10 AS next_order FROM boq_items WHERE boq_id = $1`,
    [boqId]
  );

  try {
    const { rows: [it] } = await pool.query(
      `INSERT INTO boq_items
         (org_id, boq_id, section, item_code, description, unit,
          planned_qty, rate, sort_order, notes, vendor_account_id,
          procurement_status, procurement_ref, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id`,
      [orgId, boqId,
       (data.section || '').trim() || null,
       (data.itemCode || '').trim() || null,
       description,
       (data.unit || '').trim() || null,
       qty, rate, nextOrder,
       (data.notes || '').trim() || null,
       data.vendorAccountId || null,
       normaliseStatus(data.procurementStatus),
       (data.procurementRef || '').trim() || null,
       userId]
    );
    return { id: it.id };
  } catch (err) {
    if (err.code === '23505') throw bad('That item code is already used in this bill.', 409);
    throw err;
  }
}

async function updateItem(itemId, orgId, data = {}) {
  const { rows: [item] } = await pool.query(
    `SELECT id, boq_id FROM boq_items WHERE id = $1 AND org_id = $2`, [itemId, orgId]
  );
  if (!item) throw bad('Item not found', 404);

  // Quantity and rate are the locked fields. Everything else — description,
  // section, vendor, procurement — stays editable on an active bill, because
  // locking those would stop people recording what is actually happening.
  const touchesMoney = data.plannedQty !== undefined || data.rate !== undefined;
  if (touchesMoney) await assertItemsEditable(item.boq_id, orgId);

  const sets = [], params = [];
  const add = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

  if (data.description !== undefined) {
    const d = (data.description || '').trim();
    if (!d) throw bad('A description is required.');
    add('description', d);
  }
  if (data.section  !== undefined) add('section',  (data.section  || '').trim() || null);
  if (data.itemCode !== undefined) add('item_code', (data.itemCode || '').trim() || null);
  if (data.unit     !== undefined) add('unit',     (data.unit     || '').trim() || null);
  if (data.notes    !== undefined) add('notes',    (data.notes    || '').trim() || null);

  if (data.plannedQty !== undefined) {
    const q = Number(data.plannedQty);
    if (!Number.isFinite(q) || q < 0) throw bad('Quantity must be zero or more.');
    add('planned_qty', q);
  }
  if (data.rate !== undefined) {
    const r = Number(data.rate);
    if (!Number.isFinite(r) || r < 0) throw bad('Rate must be zero or more.');
    add('rate', r);
  }
  if (data.sortOrder !== undefined) {
    const s = parseInt(data.sortOrder, 10);
    if (!Number.isFinite(s) || s < 0) throw bad('Sort order must be zero or more.');
    add('sort_order', s);
  }
  if (data.vendorAccountId !== undefined) {
    if (data.vendorAccountId) await assertApprovedVendor(data.vendorAccountId, orgId);
    add('vendor_account_id', data.vendorAccountId || null);
  }
  if (data.procurementStatus !== undefined) add('procurement_status', normaliseStatus(data.procurementStatus));
  if (data.procurementRef    !== undefined) add('procurement_ref', (data.procurementRef || '').trim() || null);

  if (!sets.length) return { updated: false };
  sets.push('updated_at = now()');
  params.push(itemId, orgId);

  try {
    await pool.query(
      `UPDATE boq_items SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND org_id = $${params.length}`,
      params
    );
  } catch (err) {
    if (err.code === '23505') throw bad('That item code is already used in this bill.', 409);
    throw err;
  }
  return { updated: true };
}

async function removeItem(itemId, orgId) {
  const { rows: [item] } = await pool.query(
    `SELECT i.id, i.boq_id,
            (SELECT count(*)::int FROM boq_progress p WHERE p.boq_item_id = i.id) AS entries
       FROM boq_items i WHERE i.id = $1 AND i.org_id = $2`,
    [itemId, orgId]
  );
  if (!item) throw bad('Item not found', 404);
  await assertItemsEditable(item.boq_id, orgId);

  // The FK would cascade the ledger away. Deleting recorded spend is exactly
  // what append-only exists to prevent, so a measured line cannot be removed.
  if (item.entries > 0) {
    throw bad(
      `This line has ${item.entries} progress ${item.entries === 1 ? 'entry' : 'entries'} against it ` +
      'and cannot be deleted. Reverse the entries first, or set its quantity to zero.',
      409
    );
  }

  await pool.query(`DELETE FROM boq_items WHERE id = $1 AND org_id = $2`, [itemId, orgId]);
  return { removed: true };
}

function normaliseStatus(s) {
  const v = (s || '').trim() || 'not_required';
  if (!PROCUREMENT_STATUSES.includes(v)) throw bad(`Unknown procurement status: ${v}`);
  return v;
}

// accounts has no 'vendor' type — vendor-ness lives in account_relationships,
// and an ACTIVE one additionally requires approval (approval_shape_chk). So the
// picker and this guard must both mean "approved vendor", not "any account".
async function assertApprovedVendor(accountId, orgId) {
  const { rows } = await pool.query(
    `SELECT 1
       FROM account_relationships ar
      WHERE ar.account_id = $1 AND ar.org_id = $2
        AND ar.relationship = 'vendor' AND ar.status = 'active'
      LIMIT 1`,
    [accountId, orgId]
  );
  if (!rows.length) {
    throw bad('That account is not an approved vendor for this organisation.', 409);
  }
}

async function listVendors(orgId) {
  const { rows } = await pool.query(
    `SELECT a.id, a.name
       FROM accounts a
       JOIN account_relationships ar
         ON ar.account_id = a.id AND ar.org_id = a.org_id
        AND ar.relationship = 'vendor' AND ar.status = 'active'
      WHERE a.org_id = $1
      ORDER BY a.name`,
    [orgId]
  );
  return { vendors: rows.map(r => ({ id: r.id, name: r.name })) };
}

// ── Progress ─────────────────────────────────────────────────────────────────

async function recordProgress(itemId, orgId, userId, data = {}) {
  const qty = Number(data.qtyDelta);
  if (!Number.isFinite(qty) || qty === 0) {
    throw bad('Enter a quantity. Use a reversal to undo an earlier entry.');
  }

  // The rate is read from the item, never accepted from the caller, and copied
  // onto the entry. This is what makes a later rate revision safe.
  const { rows: [item] } = await pool.query(
    `SELECT i.id, i.rate, b.status AS bill_status
       FROM boq_items i JOIN boqs b ON b.id = i.boq_id
      WHERE i.id = $1 AND i.org_id = $2`,
    [itemId, orgId]
  );
  if (!item) throw bad('Item not found', 404);
  if (item.bill_status === 'archived') throw bad('This bill is archived.', 409);

  const { rows: [row] } = await pool.query(
    `INSERT INTO boq_progress
       (org_id, boq_item_id, entry_date, qty_delta, rate_used, note, recorded_by)
     VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), $4, $5, $6, $7)
     RETURNING id, amount_delta`,
    [orgId, itemId, data.entryDate || null, qty, item.rate,
     (data.note || '').trim() || null, userId]
  );
  return { id: row.id, amountDelta: num(row.amount_delta) };
}

/**
 * Bulk sheet entry — one measurement across many lines, for orgs configured
 * that way. Written in ONE transaction: a half-posted measurement sheet is
 * worse than a rejected one, because nobody can tell which lines landed.
 */
async function recordProgressBulk(boqId, orgId, userId, data = {}) {
  const entries = Array.isArray(data.entries) ? data.entries : [];
  if (!entries.length) throw bad('No entries supplied.');

  const { rows: [bill] } = await pool.query(
    `SELECT status FROM boqs WHERE id = $1 AND org_id = $2`, [boqId, orgId]
  );
  if (!bill) throw bad('Bill not found', 404);
  if (bill.status === 'archived') throw bad('This bill is archived.', 409);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const written = [];

    for (const e of entries) {
      const qty = Number(e.qtyDelta);
      if (!Number.isFinite(qty) || qty === 0) continue;   // blank rows are skipped, not errors

      const { rows: [item] } = await client.query(
        `SELECT id, rate FROM boq_items WHERE id = $1 AND boq_id = $2 AND org_id = $3`,
        [e.itemId, boqId, orgId]
      );
      if (!item) throw bad(`Item ${e.itemId} is not part of this bill.`, 400);

      const { rows: [row] } = await client.query(
        `INSERT INTO boq_progress
           (org_id, boq_item_id, entry_date, qty_delta, rate_used, note, recorded_by)
         VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), $4, $5, $6, $7)
         RETURNING id`,
        [orgId, item.id, data.entryDate || null, qty, item.rate,
         (e.note || data.note || '').trim() || null, userId]
      );
      written.push(row.id);
    }

    await client.query('COMMIT');
    return { recorded: written.length, ids: written };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Reverse an entry.
 *
 * The reversing row copies the ORIGINAL entry's rate_used, not the item's
 * current rate. Reversing a 250-rate entry at today's 400 rate would cancel
 * the quantity but leave phantom money behind.
 */
async function reverseProgress(entryId, orgId, userId, data = {}) {
  const { rows: [orig] } = await pool.query(
    `SELECT p.id, p.boq_item_id, p.qty_delta, p.rate_used, b.status AS bill_status,
            (SELECT count(*)::int FROM boq_progress r WHERE r.reverses_id = p.id) AS already
       FROM boq_progress p
       JOIN boq_items i ON i.id = p.boq_item_id
       JOIN boqs b      ON b.id = i.boq_id
      WHERE p.id = $1 AND p.org_id = $2`,
    [entryId, orgId]
  );
  if (!orig) throw bad('Entry not found', 404);
  if (orig.bill_status === 'archived') throw bad('This bill is archived.', 409);
  if (orig.already > 0) throw bad('That entry has already been reversed.', 409);

  const { rows: [row] } = await pool.query(
    `INSERT INTO boq_progress
       (org_id, boq_item_id, entry_date, qty_delta, rate_used, note, reverses_id, recorded_by)
     VALUES ($1, $2, CURRENT_DATE, $3, $4, $5, $6, $7)
     RETURNING id`,
    [orgId, orig.boq_item_id, -Number(orig.qty_delta), orig.rate_used,
     (data.note || '').trim() || null, entryId, userId]
  );
  return { id: row.id, reversed: entryId };
}

async function listProgress(itemId, orgId) {
  const { rows } = await pool.query(
    `SELECT p.id, p.entry_date, p.qty_delta, p.rate_used, p.amount_delta,
            p.note, p.reverses_id, p.recorded_at,
            u.first_name || ' ' || u.last_name AS recorded_by_name,
            EXISTS (SELECT 1 FROM boq_progress r WHERE r.reverses_id = p.id) AS is_reversed
       FROM boq_progress p
       LEFT JOIN users u ON u.id = p.recorded_by
      WHERE p.boq_item_id = $1 AND p.org_id = $2
      ORDER BY p.entry_date, p.id`,
    [itemId, orgId]
  );
  return { entries: rows.map(mapEntry) };
}

/** Chronological ledger across the whole bill — the "what happened in June" view. */
async function listBillLedger(boqId, orgId, { limit = 200, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT p.id, p.entry_date, p.qty_delta, p.rate_used, p.amount_delta,
            p.note, p.reverses_id, p.recorded_at,
            u.first_name || ' ' || u.last_name AS recorded_by_name,
            EXISTS (SELECT 1 FROM boq_progress r WHERE r.reverses_id = p.id) AS is_reversed,
            i.id AS item_id, i.item_code, i.description, i.unit, i.section
       FROM boq_progress p
       JOIN boq_items i  ON i.id = p.boq_item_id
       LEFT JOIN users u ON u.id = p.recorded_by
      WHERE i.boq_id = $1 AND p.org_id = $2
      ORDER BY p.entry_date DESC, p.id DESC
      LIMIT $3 OFFSET $4`,
    [boqId, orgId, Math.min(parseInt(limit, 10) || 200, 500), parseInt(offset, 10) || 0]
  );
  return {
    entries: rows.map(r => ({
      ...mapEntry(r),
      itemId: r.item_id, itemCode: r.item_code,
      description: r.description, unit: r.unit, section: r.section,
    })),
  };
}

function mapEntry(r) {
  return {
    id:             r.id,
    entryDate:      r.entry_date,
    qtyDelta:       num(r.qty_delta),
    rateUsed:       num(r.rate_used),
    amountDelta:    num(r.amount_delta),
    note:           r.note,
    reversesId:     r.reverses_id,
    isReversal:     r.reverses_id !== null,
    isReversed:     r.is_reversed,
    recordedAt:     r.recorded_at,
    recordedByName: r.recorded_by_name,
  };
}

// ── Procurement ──────────────────────────────────────────────────────────────

/**
 * Advance procurement. Either one item, or every item sharing a reference —
 * one PO usually covers several lines, and updating them individually is the
 * friction that leaves statuses stale.
 */
async function setProcurement(boqId, orgId, data = {}) {
  const status = normaliseStatus(data.status);
  const byRef  = (data.procurementRef || '').trim();
  const itemId = data.itemId ? parseInt(data.itemId, 10) : null;

  if (!byRef && !itemId) throw bad('Supply either an item or a procurement reference.');
  if (data.vendorAccountId) await assertApprovedVendor(data.vendorAccountId, orgId);

  const sets = ['procurement_status = $1', 'updated_at = now()'];
  const params = [status];
  if (data.vendorAccountId !== undefined) {
    params.push(data.vendorAccountId || null);
    sets.push(`vendor_account_id = $${params.length}`);
  }

  let where;
  if (itemId) { params.push(itemId); where = `id = $${params.length}`; }
  else        { params.push(byRef);  where = `procurement_ref = $${params.length}`; }

  params.push(boqId, orgId);
  const { rowCount } = await pool.query(
    `UPDATE boq_items SET ${sets.join(', ')}
      WHERE ${where} AND boq_id = $${params.length - 1} AND org_id = $${params.length}`,
    params
  );
  if (!rowCount) throw bad('No matching lines found.', 404);
  return { updated: rowCount };
}

// ── Variations ───────────────────────────────────────────────────────────────

async function addVariation(boqId, orgId, userId, data = {}) {
  const description = (data.description || '').trim();
  if (!description) throw bad('A description is required.');

  const qty  = data.qtyDelta === undefined ? 0 : Number(data.qtyDelta);
  const rate = data.rate === undefined ? 0 : Number(data.rate);
  if (!Number.isFinite(qty))  throw bad('Quantity change must be a number.');
  if (!Number.isFinite(rate) || rate < 0) throw bad('Rate must be zero or more.');

  if (data.boqItemId) {
    const { rows } = await pool.query(
      `SELECT 1 FROM boq_items WHERE id = $1 AND boq_id = $2 AND org_id = $3`,
      [data.boqItemId, boqId, orgId]
    );
    if (!rows.length) throw bad('That item is not part of this bill.', 400);
  }

  const { rows: [v] } = await pool.query(
    `INSERT INTO boq_variations
       (org_id, boq_id, boq_item_id, reference, description, qty_delta, rate,
        status, reason, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'proposed',$8,$9)
     RETURNING id`,
    [orgId, boqId, data.boqItemId || null,
     (data.reference || '').trim() || null, description, qty, rate,
     (data.reason || '').trim() || null, userId]
  );
  return { id: v.id };
}

/**
 * Approve or reject. Approval is what makes a variation count towards the
 * sanctioned amount, so it records who and when — the DB constraint requires
 * both, and this is the only place they are set.
 */
async function decideVariation(variationId, orgId, userId, decision, reason) {
  if (!['approved', 'rejected'].includes(decision)) throw bad('Unknown decision.');

  const { rows: [v] } = await pool.query(
    `SELECT id, status FROM boq_variations WHERE id = $1 AND org_id = $2`,
    [variationId, orgId]
  );
  if (!v) throw bad('Variation not found', 404);
  if (v.status !== 'proposed') {
    throw bad(`That variation has already been ${v.status}.`, 409);
  }

  await pool.query(
    `UPDATE boq_variations
        SET status = $1,
            reason = COALESCE($2, reason),
            approved_by = CASE WHEN $1 = 'approved' THEN $3 ELSE approved_by END,
            approved_at = CASE WHEN $1 = 'approved' THEN now() ELSE approved_at END,
            updated_at  = now()
      WHERE id = $4 AND org_id = $5`,
    [decision, (reason || '').trim() || null, userId, variationId, orgId]
  );
  return { id: variationId, status: decision };
}

async function listVariations(boqId, orgId) {
  const { rows } = await pool.query(
    `SELECT v.id, v.boq_item_id, v.reference, v.description, v.qty_delta, v.rate,
            v.amount_delta, v.status, v.reason, v.approved_at, v.created_at,
            i.item_code, i.description AS item_description,
            au.first_name || ' ' || au.last_name AS approved_by_name,
            cu.first_name || ' ' || cu.last_name AS created_by_name
       FROM boq_variations v
       LEFT JOIN boq_items i ON i.id = v.boq_item_id
       LEFT JOIN users au    ON au.id = v.approved_by
       LEFT JOIN users cu    ON cu.id = v.created_by
      WHERE v.boq_id = $1 AND v.org_id = $2
      ORDER BY v.created_at DESC`,
    [boqId, orgId]
  );
  return {
    variations: rows.map(r => ({
      id:              r.id,
      boqItemId:       r.boq_item_id,
      itemCode:        r.item_code,
      itemDescription: r.item_description,
      reference:       r.reference,
      description:     r.description,
      qtyDelta:        num(r.qty_delta),
      rate:            num(r.rate),
      amountDelta:     num(r.amount_delta),
      status:          r.status,
      reason:          r.reason,
      approvedAt:      r.approved_at,
      approvedByName:  r.approved_by_name,
      createdByName:   r.created_by_name,
      createdAt:       r.created_at,
    })),
  };
}

/** One-line figure for the project Overview. */
async function summaryForProject(handoverId, orgId) {
  const { rows: [r] } = await pool.query(
    `SELECT b.id AS boq_id, b.currency,
            COALESCE(sum(ir.planned_amount), 0)     AS planned,
            COALESCE(sum(ir.sanctioned_amount), 0)  AS sanctioned,
            COALESCE(sum(ir.spent_amount), 0)       AS spent,
            count(ir.boq_item_id) FILTER (WHERE ir.remaining_amount < 0)::int AS overrun_items,
            (SELECT count(*)::int FROM boq_variations v
              WHERE v.boq_id = b.id AND v.status = 'proposed')                AS pending_variations
       FROM boqs b
       LEFT JOIN boq_item_rollup ir ON ir.boq_id = b.id
      WHERE b.handover_id = $1 AND b.org_id = $2 AND b.status <> 'archived'
      GROUP BY b.id, b.currency`,
    [handoverId, orgId]
  );
  if (!r) return { hasBill: false };
  return {
    hasBill:           true,
    boqId:             r.boq_id,
    currency:          r.currency,
    plannedAmount:     num(r.planned),
    sanctionedAmount:  num(r.sanctioned),
    spentAmount:       num(r.spent),
    remainingAmount:   num(r.sanctioned) - num(r.spent),
    overrunItems:      r.overrun_items,
    pendingVariations: r.pending_variations,
  };
}

module.exports = {
  PROCUREMENT_STATUSES,
  getConfig,
  getBill, createBill, updateBill,
  addItem, updateItem, removeItem,
  listVendors,
  recordProgress, recordProgressBulk, reverseProgress,
  listProgress, listBillLedger,
  setProcurement,
  addVariation, decideVariation, listVariations,
  summaryForProject,
};
