const cron = require('node-cron');
const { pool } = require('../config/database');
const { fetchEmails } = require('../services/outlookService');
const { emailQueue } = require('./emailProcessor');

/**
 * Trigger sync for a user
 */
async function triggerSync(userId, type = 'email') {
  try {
    console.log(`Triggering ${type} sync for user ${userId}`);
    
    // Get last sync date
    const lastSyncResult = await pool.query(
      `SELECT last_sync_date FROM email_sync_history 
       WHERE user_id = $1 AND sync_type = $2 
       ORDER BY created_at DESC LIMIT 1`,
      [userId, type]
    );
    
    const lastSyncDate = lastSyncResult.rows[0]?.last_sync_date;
    
    // Fetch new emails
    const result = await fetchEmails(userId, {
      since: lastSyncDate,
      top: 100
    });
    
    console.log(`Found ${result.emails.length} new emails for user ${userId}`);
    
    // Queue emails for processing
    const queuedJobs = [];
    for (const email of result.emails) {
      const job = await emailQueue.add({
        userId,
        emailId: email.id
      });
      queuedJobs.push(job.id);
    }
    
    // Record sync history
    await pool.query(
      `INSERT INTO email_sync_history (
        user_id, sync_type, status, items_processed, last_sync_date, created_at
      ) VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      [userId, type, 'success', result.emails.length]
    );
    
    return {
      emailsFound: result.emails.length,
      jobsQueued: queuedJobs.length,
      jobIds: queuedJobs
    };
  } catch (error) {
    console.error(`Sync failed for user ${userId}:`, error);
    
    // Record failed sync
    await pool.query(
      `INSERT INTO email_sync_history (
        user_id, sync_type, status, error_message, created_at
      ) VALUES ($1, $2, $3, $4, NOW())`,
      [userId, type, 'failed', error.message]
    );
    
    throw error;
  }
}

/**
 * Get sync status for user
 */
async function getSyncStatus(userId) {
  const result = await pool.query(
    `SELECT * FROM email_sync_history 
     WHERE user_id = $1 
     ORDER BY created_at DESC 
     LIMIT 10`,
    [userId]
  );
  
  return result.rows;
}

/**
 * Sync all connected users
 */
async function syncAllUsers() {
  try {
    console.log('Starting scheduled sync for all users...');
    
    const usersResult = await pool.query(
      'SELECT id FROM users WHERE outlook_connected = true'
    );
    
    console.log(`Found ${usersResult.rows.length} users to sync`);
    
    for (const user of usersResult.rows) {
      try {
        await triggerSync(user.id, 'email');
        // Add delay between users to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        console.error(`Error syncing user ${user.id}:`, error);
        // Continue with next user
      }
    }
    
    console.log('Scheduled sync completed');
  } catch (error) {
    console.error('Error in scheduled sync:', error);
  }
}

/**
 * Schedule automatic syncs
 * Runs every 15 minutes
 */
function startScheduler() {
  // Every 15 minutes
  cron.schedule('*/15 * * * *', () => {
    console.log('Running scheduled sync...');
    syncAllUsers();
  });
  
  console.log('Sync scheduler started (runs every 15 minutes)');
}

module.exports = {
  triggerSync,
  getSyncStatus,
  syncAllUsers,
  startScheduler
};
