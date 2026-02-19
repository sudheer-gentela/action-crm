/**
 * storageFileService.js
 *
 * Manages the storage_files table.
 *
 * Key design decisions addressed here:
 *
 * 1. DEAL LINKAGE
 *    Every import record carries deal_id (FK → deals). The actions table
 *    uses source = 'storage_file' and source_id = storage_files.id so any
 *    action can be traced back to a readable record with filename and deal.
 *
 * 2. DEDUPLICATION
 *    Two-layer approach:
 *      a) Soft check: checkDuplicate() before processing — returns the existing
 *         record so the frontend can warn the user and let them decide.
 *      b) Hard constraint: UNIQUE(user_id, provider, provider_file_id, deal_id)
 *         at the DB level — the insert will throw if somehow bypassed.
 *    Re-import IS allowed but must be an explicit user choice (force: true).
 *
 * 3. SOURCE LABEL
 *    source_label = "<Provider>: <FileName>" e.g. "OneDrive: Q3 Proposal.docx"
 *    This is stored on the storage_files row AND passed as source_id to the
 *    actions table, replacing the opaque provider file ID.
 */

const { pool } = require('../config/database');

// ── Provider display names for source_label ────────────────────────────────
const PROVIDER_DISPLAY = {
  onedrive:    'OneDrive',
  googledrive: 'Google Drive',
};

/**
 * Build the human-readable source label for a file.
 * Used in storage_files.source_label and actions.source_id.
 * Example: "OneDrive: Q3 Proposal Final.docx"
 */
function buildSourceLabel(provider, fileName) {
  const providerName = PROVIDER_DISPLAY[provider] || provider;
  return `${providerName}: ${fileName}`;
}

/**
 * Check if a file has already been imported for a given deal BEFORE processing.
 * Returns the existing record if found so the frontend can surface a warning.
 *
 * This is the soft pre-check. The DB UNIQUE constraint is the hard guard.
 *
 * @param {string} userId
 * @param {string} provider          - 'onedrive' | 'googledrive'
 * @param {string} providerFileId    - Provider's native file ID
 * @param {string|null} dealId
 * @returns {{ exists: boolean, record?: Object }}
 */
async function checkDuplicate(userId, provider, providerFileId, dealId) {
  const result = await pool.query(
    `SELECT
       id, file_name, source_label, processing_status,
       imported_at, processed_at, health_score_after, health_status_after
     FROM storage_files
     WHERE user_id = $1
       AND provider = $2
       AND provider_file_id = $3
       AND deal_id IS NOT DISTINCT FROM $4`,
    [userId, provider, providerFileId, dealId || null]
  );

  if (result.rows.length === 0) return { exists: false };

  return {
    exists: true,
    record: result.rows[0],
    message: `"${result.rows[0].file_name}" was already imported for this deal on ` +
             `${new Date(result.rows[0].imported_at).toLocaleDateString()}. ` +
             `Import again to re-process with latest file content.`,
  };
}

/**
 * Create an import record in storage_files at the start of processing.
 * Returns the row (including its auto-generated id) for the processor to use.
 *
 * On conflict (duplicate): if force = true, resets the record for re-processing.
 * If force = false, throws a DuplicateImportError — call checkDuplicate() first
 * to surface a friendly warning before this point.
 *
 * @param {Object} fileRef
 * @param {string} userId
 * @param {string|null} dealId
 * @param {string|null} contactId
 * @param {boolean} force  - Allow re-import of already-processed file
 */
async function createImportRecord(fileRef, userId, dealId = null, contactId = null, force = false) {
  const sourceLabel = buildSourceLabel(fileRef.provider, fileRef.file_name);

  if (force) {
    // Re-import: upsert and reset to 'processing'
    const result = await pool.query(
      `INSERT INTO storage_files (
        user_id, deal_id, contact_id,
        provider, provider_file_id, web_url,
        file_name, file_size, mime_type, category, last_modified_at,
        source_label, processing_status, imported_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'processing', NOW())
      ON CONFLICT (user_id, provider, provider_file_id, deal_id)
      DO UPDATE SET
        processing_status  = 'processing',
        imported_at        = NOW(),
        web_url            = EXCLUDED.web_url,
        file_name          = EXCLUDED.file_name,
        source_label       = EXCLUDED.source_label,
        last_modified_at   = EXCLUDED.last_modified_at,
        -- Clear previous results so stale insights don't linger
        processed_at       = NULL,
        processing_error   = NULL,
        ai_summary         = NULL,
        ai_action_items    = NULL,
        ai_sentiment       = NULL,
        deal_health_signals = NULL,
        competitors_found  = NULL,
        health_score_after = NULL,
        health_status_after = NULL,
        actions_generated  = 0
      RETURNING *`,
      [
        userId, dealId || null, contactId || null,
        fileRef.provider, fileRef.provider_file_id, fileRef.web_url || null,
        fileRef.file_name, fileRef.file_size || 0, fileRef.mime_type || null,
        fileRef.category || null, fileRef.last_modified_at || null,
        sourceLabel,
      ]
    );
    return result.rows[0];
  }

  // Normal import — fail loudly on duplicate rather than silently overwriting
  try {
    const result = await pool.query(
      `INSERT INTO storage_files (
        user_id, deal_id, contact_id,
        provider, provider_file_id, web_url,
        file_name, file_size, mime_type, category, last_modified_at,
        source_label, processing_status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'processing')
      RETURNING *`,
      [
        userId, dealId || null, contactId || null,
        fileRef.provider, fileRef.provider_file_id, fileRef.web_url || null,
        fileRef.file_name, fileRef.file_size || 0, fileRef.mime_type || null,
        fileRef.category || null, fileRef.last_modified_at || null,
        sourceLabel,
      ]
    );
    return result.rows[0];
  } catch (err) {
    if (err.code === '23505') {
      // Unique constraint violation — provide a clear message
      const dup = await checkDuplicate(userId, fileRef.provider, fileRef.provider_file_id, dealId);
      const error = new Error(
        `"${fileRef.file_name}" has already been imported for this deal. ` +
        `Pass force: true to re-import and re-process.`
      );
      error.code = 'DUPLICATE_IMPORT';
      error.existingRecord = dup.record;
      throw error;
    }
    throw err;
  }
}

/**
 * Update a storage_files record after all pipelines complete successfully.
 * Stores extracted insights — never the full text.
 *
 * @param {number} recordId
 * @param {Object} insights
 */
async function markProcessed(recordId, insights) {
  await pool.query(
    `UPDATE storage_files SET
      processing_status    = 'completed',
      processed_at         = NOW(),
      pipelines_run        = $2,
      ai_summary           = $3,
      ai_action_items      = $4,
      ai_sentiment         = $5,
      ai_analysis_type     = $6,
      deal_health_signals  = $7,
      competitors_found    = $8,
      health_score_after   = $9,
      health_status_after  = $10,
      actions_generated    = $11
    WHERE id = $1`,
    [
      recordId,
      insights.pipelinesRun        || [],
      insights.aiSummary           || null,
      insights.aiActionItems       ? JSON.stringify(insights.aiActionItems)     : null,
      insights.aiSentiment         || null,
      insights.aiAnalysisType      || null,
      insights.dealHealthSignals   ? JSON.stringify(insights.dealHealthSignals) : null,
      insights.competitorsFound    ? JSON.stringify(insights.competitorsFound)  : null,
      insights.healthScoreAfter    || null,
      insights.healthStatusAfter   || null,
      insights.actionsGenerated    || 0,
    ]
  );
}

/**
 * Mark a record as failed.
 *
 * @param {number} recordId
 * @param {string} errorMessage
 */
async function markFailed(recordId, errorMessage) {
  await pool.query(
    `UPDATE storage_files SET
      processing_status = 'failed',
      processed_at      = NOW(),
      processing_error  = $2
    WHERE id = $1`,
    [recordId, errorMessage]
  );
}

/**
 * Get all imported files for a deal, ordered newest first.
 * Returns web_url so the deal view can render "Open in OneDrive/Google Drive" links.
 *
 * @param {string} dealId
 * @param {string} userId
 */
async function getFilesForDeal(dealId, userId) {
  const result = await pool.query(
    `SELECT
       id, provider, file_name, file_size, mime_type, category,
       web_url, source_label,
       imported_at, processed_at, processing_status, processing_error,
       ai_summary, ai_action_items, ai_sentiment, ai_analysis_type,
       deal_health_signals, competitors_found,
       health_score_after, health_status_after,
       actions_generated, pipelines_run
     FROM storage_files
     WHERE deal_id = $1 AND user_id = $2
     ORDER BY imported_at DESC`,
    [dealId, userId]
  );
  return result.rows;
}

/**
 * Get all imported files for a contact.
 *
 * @param {string} contactId
 * @param {string} userId
 */
async function getFilesForContact(contactId, userId) {
  const result = await pool.query(
    `SELECT
       id, provider, file_name, file_size, mime_type, category,
       web_url, source_label,
       imported_at, processed_at, processing_status,
       ai_summary, ai_action_items, ai_sentiment,
       actions_generated, pipelines_run
     FROM storage_files
     WHERE contact_id = $1 AND user_id = $2
     ORDER BY imported_at DESC`,
    [contactId, userId]
  );
  return result.rows;
}

/**
 * Remove a storage_files record.
 * ONLY removes the CRM reference — the file in OneDrive/Google Drive is untouched.
 *
 * @param {number} recordId
 * @param {string} userId  - Ownership check
 */
async function deleteImportRecord(recordId, userId) {
  const result = await pool.query(
    'DELETE FROM storage_files WHERE id = $1 AND user_id = $2 RETURNING id, file_name',
    [recordId, userId]
  );
  if (result.rows.length === 0) {
    throw new Error('Import record not found or you do not have permission to delete it.');
  }
  return result.rows[0];
}

module.exports = {
  buildSourceLabel,
  checkDuplicate,
  createImportRecord,
  markProcessed,
  markFailed,
  getFilesForDeal,
  getFilesForContact,
  deleteImportRecord,
};
