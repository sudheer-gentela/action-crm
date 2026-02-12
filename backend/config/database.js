const { Pool } = require('pg');
require('dotenv').config();

// Use DATABASE_URL if available (Railway), otherwise fall back to individual vars (local dev)
const pool = process.env.DATABASE_URL 
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
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

// Test database connection
pool.on('connect', () => {
  console.log('✅ Database connected successfully');
  console.log('📊 Using:', process.env.DATABASE_URL ? 'DATABASE_URL connection string' : 'Individual DB variables');
});

pool.on('error', (err) => {
  console.error('❌ Unexpected database error:', err);
  console.error('🔍 Connection method:', process.env.DATABASE_URL ? 'DATABASE_URL' : 'Individual variables');
  process.exit(-1);
});

// Log connection attempt (without sensitive data)
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

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
  db: pool,  // ✅ ADDED: This line makes db point to pool
};
