/**
 * Action CRM Configuration
 * Central configuration for sync settings, features, and system behavior
 */

module.exports = {
  /**
   * EMAIL SYNC CONFIGURATION
   */
  emailSync: {
    // Enable/disable email sync to database
    enabled: process.env.EMAIL_SYNC_ENABLED === 'true',
    
    // Sync frequency options: 'manual', 'scheduled', 'realtime'
    // - manual: Only sync when user triggers
    // - scheduled: Automatic sync based on interval
    // - realtime: Webhook-based (future enhancement)
    frequency: process.env.EMAIL_SYNC_FREQUENCY || 'manual',
    
    // Sync interval (in minutes) - only applies when frequency = 'scheduled'
    intervalMinutes: parseInt(process.env.EMAIL_SYNC_INTERVAL_MINUTES) || 15,
    
    // Sync scope configuration
    scope: {
      // Only sync emails related to deals
      dealRelatedOnly: process.env.EMAIL_SYNC_DEAL_RELATED_ONLY === 'true' || false,
      
      // Maximum number of emails to fetch per sync
      batchSize: parseInt(process.env.EMAIL_SYNC_BATCH_SIZE) || 50,
      
      // Days to look back on first sync (null = all available)
      initialSyncDays: parseInt(process.env.EMAIL_SYNC_INITIAL_DAYS) || null,
      
      // Skip emails older than this many days (null = no limit)
      maxAgeDays: parseInt(process.env.EMAIL_SYNC_MAX_AGE_DAYS) || null,
    },
    
    // Duplicate prevention
    deduplication: {
      // Use Outlook messageId for duplicate detection
      useMessageId: true,
      
      // Use timestamp-based deduplication
      useTimestamp: true,
      
      // Skip emails already in database
      skipExisting: true,
    },
    
    // Auto-generate RULE-BASED actions from synced emails (uses ActionsEngine)
    autoGenerateRuleBasedActions: process.env.EMAIL_AUTO_GENERATE_RULE_ACTIONS === 'true' || true,
    
    // Auto-generate AI-POWERED actions (uses Claude AI)
    // When false, AI analysis only happens via manual trigger
    autoGenerateAIActions: process.env.EMAIL_AUTO_GENERATE_AI_ACTIONS === 'true' || false,
    
    // Retry configuration
    retry: {
      maxAttempts: parseInt(process.env.EMAIL_SYNC_MAX_RETRIES) || 3,
      delayMs: parseInt(process.env.EMAIL_SYNC_RETRY_DELAY_MS) || 1000,
    },
  },
  
  /**
   * CALENDAR SYNC CONFIGURATION (Future)
   */
  calendarSync: {
    enabled: process.env.CALENDAR_SYNC_ENABLED === 'true' || false,
    frequency: process.env.CALENDAR_SYNC_FREQUENCY || 'manual',
    intervalMinutes: parseInt(process.env.CALENDAR_SYNC_INTERVAL_MINUTES) || 15,
  },
  
  /**
   * MEETING NOTES CONFIGURATION (Future)
   */
  meetingNotes: {
    enabled: process.env.MEETING_NOTES_ENABLED === 'true' || false,
    // Supported platforms: zoom, teams, meet
    supportedPlatforms: ['zoom', 'teams', 'meet'],
  },
  
  /**
   * SYSTEM SETTINGS
   */
  system: {
    // Enable debug logging
    debug: process.env.DEBUG === 'true' || false,
    
    // Timezone for scheduled tasks
    timezone: process.env.TZ || 'UTC',
  },
};
