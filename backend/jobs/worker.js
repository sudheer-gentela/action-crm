require('dotenv').config();
const { emailQueue }      = require('./emailProcessor');
const { startScheduler }  = require('./syncScheduler');
const { escalationQueue } = require('./escalationJob');
const escalationScheduler = require('./escalationScheduler');

console.log('🔧 Starting background worker...');

// Start email sync scheduler
startScheduler();

// Start escalation scheduler
escalationScheduler.startScheduler();

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing worker...');
  await emailQueue.close();
  await escalationQueue.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, closing worker...');
  await emailQueue.close();
  await escalationQueue.close();
  process.exit(0);
});

console.log('✅ Worker started successfully');
console.log(`Queues: ${emailQueue.name}, ${escalationQueue.name}`);
console.log('Waiting for jobs...');
