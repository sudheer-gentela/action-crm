/**
 * Action CRM Configuration (REPLACEMENT)
 *
 * DROP-IN LOCATION: backend/config/config.js
 *
 * Key changes from original:
 *   - calendarSync section now has 'providers' array for multi-provider support
 *   - Added syncDaysAhead and syncDaysBehind settings
 *   - Section no longer marked as "(Future)" — it's active now
 */

module.exports = {
  /**
   * EMAIL SYNC CONFIGURATION
   */
  emailSync: {
    // Enable/disable email sync to database
    enabled: process.env.EMAIL_SYNC_ENABLED === 'true' || false,

    // Sync frequency options: 'manual', 'scheduled', 'realtime'
    frequency: process.env.EMAIL_SYNC_FREQUENCY || 'manual',

    // Sync interval (in minutes) - only applies when frequency = 'scheduled'
    intervalMinutes: parseInt(process.env.EMAIL_SYNC_INTERVAL_MINUTES) || 15,

    // Sync scope configuration
    scope: {
      dealRelatedOnly: process.env.EMAIL_SYNC_DEAL_RELATED_ONLY === 'true' || false,
      batchSize: parseInt(process.env.EMAIL_SYNC_BATCH_SIZE) || 50,
      initialSyncDays: parseInt(process.env.EMAIL_SYNC_INITIAL_DAYS) || null,
      maxAgeDays: parseInt(process.env.EMAIL_SYNC_MAX_AGE_DAYS) || null,
    },

    // Duplicate prevention
    deduplication: {
      useMessageId: true,
      useTimestamp: true,
      skipExisting: true,
    },

    // Auto-generate RULE-BASED actions from synced emails (uses ActionsEngine)
    autoGenerateRuleBasedActions: process.env.EMAIL_AUTO_GENERATE_RULE_ACTIONS === 'true' || true,

    // Auto-generate AI-POWERED actions (uses Claude AI)
    autoGenerateAIActions: process.env.EMAIL_AUTO_GENERATE_AI_ACTIONS === 'true' || false,

    // Retry configuration
    retry: {
      maxAttempts: parseInt(process.env.EMAIL_SYNC_MAX_RETRIES) || 3,
      delayMs: parseInt(process.env.EMAIL_SYNC_RETRY_DELAY_MS) || 1000,
    },
  },

  /**
   * CALENDAR SYNC CONFIGURATION
   */
  calendarSync: {
    enabled: process.env.CALENDAR_SYNC_ENABLED === 'true' || false,
    frequency: process.env.CALENDAR_SYNC_FREQUENCY || 'manual',
    intervalMinutes: parseInt(process.env.CALENDAR_SYNC_INTERVAL_MINUTES) || 15,

    // How many days ahead/behind to sync by default
    syncDaysAhead:  parseInt(process.env.CALENDAR_SYNC_DAYS_AHEAD)  || 30,
    syncDaysBehind: parseInt(process.env.CALENDAR_SYNC_DAYS_BEHIND) || 7,

    // Supported providers — used by scheduled sync to iterate connected users
    providers: ['outlook', 'google'],
  },

  /**
   * MEETING NOTES CONFIGURATION (Future)
   */
  meetingNotes: {
    enabled: process.env.MEETING_NOTES_ENABLED === 'true' || false,
    supportedPlatforms: ['zoom', 'teams', 'meet'],
  },

  /**
   * SYSTEM SETTINGS
   */
  system: {
    debug: process.env.DEBUG === 'true' || false,
    timezone: process.env.TZ || 'UTC',
  },
};
