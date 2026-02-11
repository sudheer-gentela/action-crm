require('dotenv').config();
const { emailQueue } = require('./emailProcessor');
const { startScheduler } = require('./syncScheduler');

console.log('🔧 Starting background worker...');

// Start the scheduler
startScheduler();

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing worker...');
  await emailQueue.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, closing worker...');
  await emailQueue.close();
  process.exit(0);
});

console.log('✅ Worker started successfully');
console.log(`Queue: ${emailQueue.name}`);
console.log('Waiting for jobs...');
