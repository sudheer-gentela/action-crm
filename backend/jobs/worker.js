require('dotenv').config();
const { emailQueue }      = require('./emailProcessor');
const { startScheduler }  = require('./syncScheduler');
const { notificationQueue } = require('./notificationJob');
const notificationScheduler = require('./notificationScheduler');

console.log('🔧 Starting background worker...');

// Start email sync scheduler
startScheduler();

// Start notification scheduler
notificationScheduler.startScheduler();

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing worker...');
  await emailQueue.close();
  await notificationQueue.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, closing worker...');
  await emailQueue.close();
  await notificationQueue.close();
  process.exit(0);
});

console.log('✅ Worker started successfully');
console.log(`Queues: ${emailQueue.name}, ${notificationQueue.name}`);
console.log('Waiting for jobs...');
