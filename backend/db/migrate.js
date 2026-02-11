require('dotenv').config();
const { pool } = require('../config/database');
const fs = require('fs');
const path = require('path');

async function migrate() {
  try {
    console.log('Starting Outlook integration migration...');
    
    const migrationFile = path.join(__dirname, 'migrations', '001_outlook_tables.sql');
    const sql = fs.readFileSync(migrationFile, 'utf8');
    
    await pool.query(sql);
    
    console.log('✅ Migration completed successfully');
    console.log('   - Added oauth_tokens table');
    console.log('   - Added email_sync_history table');
    console.log('   - Added Outlook columns to users table');
    console.log('   - Added source tracking to actions table');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
