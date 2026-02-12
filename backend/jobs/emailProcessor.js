const Queue = require('bull');
const { fetchEmailById } = require('../services/outlookService');
const { analyzeEmail } = require('../services/claudeService');
const { createActionsFromEmail } = require('../services/emailActionsService');
const { db } = require('../config/database');

// Create queue
const emailQueue = new Queue('email-processing', process.env.REDIS_URL, {
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000
    },
    removeOnComplete: 100,
    removeOnFail: 50
  }
});

// Process jobs
emailQueue.process(async (job) => {
  const { userId, emailId } = job.data;
  
  console.log(`Processing email ${emailId} for user ${userId}`);
  
  try {
    // Check if already processed
    const existing = await db.query(
      'SELECT id FROM actions WHERE source = $1 AND source_id = $2 AND user_id = $3',
      ['outlook_email', emailId, userId]
    );
    
    if (existing.rows.length > 0) {
      console.log(`Email ${emailId} already processed, skipping`);
      return { 
        success: true, 
        skipped: true,
        reason: 'Already processed' 
      };
    }
    
    // Fetch email from Outlook
    job.progress(20);
    const email = await fetchEmailById(userId, emailId);
    
    // Analyze with Claude
    job.progress(50);
    const analysis = await analyzeEmail(email);
    
    // Create actions
    job.progress(80);
    const actions = await createActionsFromEmail(userId, email, analysis);
    
    job.progress(100);
    
    console.log(`Successfully processed email ${emailId}, created ${actions.length} actions`);
    
    return {
      success: true,
      emailId,
      actionsCreated: actions.length,
      actions: actions.map(a => ({ id: a.id, title: a.title }))
    };
  } catch (error) {
    console.error(`Error processing email ${emailId}:`, error);
    throw error;
  }
});

// Event listeners
emailQueue.on('completed', (job, result) => {
  console.log(`Job ${job.id} completed:`, result);
});

emailQueue.on('failed', (job, err) => {
  console.error(`Job ${job.id} failed:`, err.message);
});

emailQueue.on('stalled', (job) => {
  console.warn(`Job ${job.id} stalled`);
});

module.exports = { emailQueue };
