const { Pool } = require('pg');
require('dotenv').config();

// ─────────────────────────────────────────────────────────────
// Connection Pool
// ─────────────────────────────────────────────────────────────
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    })
  : new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      database: process.env.DB_NAME || 'action_crm',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

pool.on('connect', () => {
  console.log('✅ Database connected successfully');
  console.log('📊 Using:', process.env.DATABASE_URL ? 'DATABASE_URL connection string' : 'Individual DB variables');
});

pool.on('error', (err) => {
  // An idle client erroring (network blip, server-side connection reset) is
  // recoverable — the pool discards the client and creates a new one on
  // demand. Exiting here turned every routine blip into a full API outage.
  console.error('❌ Idle database client error (recoverable, pool will replace the client):', err.message);
});

if (process.env.DATABASE_URL) {
  const urlParts = process.env.DATABASE_URL.match(/postgresql:\/\/([^:]+):(.+)@([^:]+):(\d+)\/(.+)/);
  if (urlParts) {
    console.log('🔗 Connecting to PostgreSQL:');
    console.log('   Host:', urlParts[3]);
    console.log('   Port:', urlParts[4]);
    console.log('   Database:', urlParts[5]);
    console.log('   User:', urlParts[1]);
  }
} else {
  console.log('🔗 Connecting to PostgreSQL (individual vars):');
  console.log('   Host:', process.env.DB_HOST || 'localhost');
  console.log('   Port:', process.env.DB_PORT || 5432);
  console.log('   Database:', process.env.DB_NAME || 'action_crm');
  console.log('   User:', process.env.DB_USER || 'postgres');
}

// ─────────────────────────────────────────────────────────────
// Simple query helper (unchanged — all existing code works)
// ─────────────────────────────────────────────────────────────
const query = (text, params) => pool.query(text, params);

// ─────────────────────────────────────────────────────────────
// Org-scoped query helper
//
// Use this instead of query() inside routes that have gone
// through orgContext middleware. It:
//   1. Checks out a dedicated client from the pool
//   2. Sets the RLS session variable for this transaction
//   3. Runs your query
//   4. Releases the client back to the pool
//
// Usage:
//   const rows = await orgQuery(req.orgId, 'SELECT * FROM deals WHERE id = $1', [dealId]);
//
// ─────────────────────────────────────────────────────────────
const orgQuery = async (orgId, text, params = []) => {
  const client = await pool.connect();
  try {
    // SET LOCAL is a NO-OP outside a transaction (Postgres silently ignores
    // it), so the RLS session variable must be set inside BEGIN/COMMIT for
    // it to apply to the query. Single-statement reads still benefit: the
    // whole round trip is one short transaction.
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_org_id = '${parseInt(orgId, 10)}'`);
    const result = await client.query(text, params);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────────────────────
// Transaction helper with org scope
//
// For operations that need multiple queries in one transaction.
// Automatically sets the RLS session variable and handles
// commit/rollback.
//
// Usage:
//   const result = await withOrgTransaction(req.orgId, async (client) => {
//     await client.query('INSERT INTO deals ...', [...]);
//     await client.query('INSERT INTO deal_activities ...', [...]);
//     return { success: true };
//   });
//
// ─────────────────────────────────────────────────────────────
const withOrgTransaction = async (orgId, fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // SET LOCAL only lives for this transaction — perfect for RLS
    await client.query(`SET LOCAL app.current_org_id = '${parseInt(orgId, 10)}'`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────────────────────
// Exports
//
// query()              — existing single query, unchanged
// orgQuery()           — org-scoped single query (use in new routes)
// withOrgTransaction() — org-scoped multi-query transaction
// pool                 — raw pool for advanced use
// db                   — alias for pool (backwards compat)
// ─────────────────────────────────────────────────────────────
module.exports = {
  query,
  orgQuery,
  withOrgTransaction,
  pool,
  db: pool,
};
