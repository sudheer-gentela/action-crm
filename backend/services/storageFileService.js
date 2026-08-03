/**
 * storageFileService.js
 * Manages the storage_files table.
 *
 * MULTI-ORG: Every function now accepts orgId and includes it in all
 * WHERE / INSERT clauses. The ON CONFLICT key for storage_files is
 * UNIQUE(user_id, provider, provider_file_id, deal_id) — org_id is
 * added to INSERT but not to the conflict key (a file imported by two
 * different users in different orgs is a legitimate separate record).
 */

const { pool } = require('../config/database');

const PROVIDER_DISPLAY = {
  onedrive:    'OneDrive',
  googledrive: 'Google Drive',
};

function buildSourceLabel(provider, fileName) {
  const providerName = PROVIDER_DISPLAY[provider] || provider;
  return `${providerName}: ${fileName}`;
}

async function checkDuplicate(userId, provider, providerFileId, dealId, orgId) {
  const result = await pool.query(
    `SELECT id, file_name, source_label, processing_status, imported_at, processed_at,
            health_score_after, health_status_after
     FROM storage_files
     WHERE user_id = $1 AND org_id = $2 AND provider = $3
       AND provider_file_id = $4
       AND deal_id IS NOT DISTINCT FROM $5`,
    [userId, orgId, provider, providerFileId, dealId || null]
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

async function createImportRecord(fileRef, userId, orgId, dealId = null, contactId = null, force = false) {
  const sourceLabel = buildSourceLabel(fileRef.provider, fileRef.file_name);

  if (force) {
    const result = await pool.query(
      `INSERT INTO storage_files (
        org_id, user_id, deal_id, contact_id, provider, provider_file_id, web_url,
        file_name, file_size, mime_type, category, last_modified_at,
        source_label, folder_id, folder_path, processing_status, imported_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'processing',NOW())
      ON CONFLICT (user_id, provider, provider_file_id, deal_id)
      DO UPDATE SET
        processing_status = 'processing', imported_at = NOW(),
        web_url = EXCLUDED.web_url, file_name = EXCLUDED.file_name,
        folder_id = COALESCE(EXCLUDED.folder_id, storage_files.folder_id),
        folder_path = COALESCE(EXCLUDED.folder_path, storage_files.folder_path),
        source_label = EXCLUDED.source_label, last_modified_at = EXCLUDED.last_modified_at,
        processed_at = NULL, processing_error = NULL,
        ai_summary = NULL, ai_action_items = NULL, ai_sentiment = NULL,
        deal_health_signals = NULL, competitors_found = NULL,
        health_score_after = NULL, health_status_after = NULL, actions_generated = 0
      RETURNING *`,
      [orgId, userId, dealId || null, contactId || null,
       fileRef.provider, fileRef.provider_file_id, fileRef.web_url || null,
       fileRef.file_name, fileRef.file_size || 0, fileRef.mime_type || null,
       fileRef.category || null, fileRef.last_modified_at || null, sourceLabel,
       fileRef.parent_folder_id || null, fileRef.folder_path || null]
    );
    return result.rows[0];
  }

  try {
    const result = await pool.query(
      `INSERT INTO storage_files (
        org_id, user_id, deal_id, contact_id, provider, provider_file_id, web_url,
        file_name, file_size, mime_type, category, last_modified_at,
        source_label, folder_id, folder_path, processing_status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'processing')
      RETURNING *`,
      [orgId, userId, dealId || null, contactId || null,
       fileRef.provider, fileRef.provider_file_id, fileRef.web_url || null,
       fileRef.file_name, fileRef.file_size || 0, fileRef.mime_type || null,
       fileRef.category || null, fileRef.last_modified_at || null, sourceLabel,
       fileRef.parent_folder_id || null, fileRef.folder_path || null]
    );
    return result.rows[0];
  } catch (err) {
    if (err.code === '23505') {
      const dup = await checkDuplicate(userId, fileRef.provider, fileRef.provider_file_id, dealId, orgId);
      const error = new Error(
        `"${fileRef.file_name}" has already been imported for this deal. Pass force: true to re-import.`
      );
      error.code = 'DUPLICATE_IMPORT';
      error.existingRecord = dup.record;
      throw error;
    }
    throw err;
  }
}

// markProcessed and markFailed operate by primary key (recordId) — no org scoping needed
async function markProcessed(recordId, insights) {
  await pool.query(
    `UPDATE storage_files SET
      processing_status = 'completed', processed_at = NOW(),
      pipelines_run = $2, ai_summary = $3, ai_action_items = $4,
      ai_sentiment = $5, ai_analysis_type = $6, deal_health_signals = $7,
      competitors_found = $8, health_score_after = $9,
      health_status_after = $10, actions_generated = $11
    WHERE id = $1`,
    [recordId,
     insights.pipelinesRun      || [],
     insights.aiSummary         || null,
     insights.aiActionItems     ? JSON.stringify(insights.aiActionItems)     : null,
     insights.aiSentiment       || null,
     insights.aiAnalysisType    || null,
     insights.dealHealthSignals ? JSON.stringify(insights.dealHealthSignals) : null,
     insights.competitorsFound  ? JSON.stringify(insights.competitorsFound)  : null,
     insights.healthScoreAfter  || null,
     insights.healthStatusAfter || null,
     insights.actionsGenerated  || 0]
  );
}

async function markFailed(recordId, errorMessage) {
  await pool.query(
    `UPDATE storage_files SET processing_status = 'failed', processed_at = NOW(), processing_error = $2 WHERE id = $1`,
    [recordId, errorMessage]
  );
}

async function getFilesForDeal(dealId, userId, orgId) {
  const result = await pool.query(
    `SELECT id, provider, file_name, file_size, mime_type, category, web_url, source_label,
            imported_at, processed_at, processing_status, processing_error,
            ai_summary, ai_action_items, ai_sentiment, ai_analysis_type,
            deal_health_signals, competitors_found, health_score_after, health_status_after,
            actions_generated, pipelines_run
     FROM storage_files
     WHERE deal_id = $1 AND user_id = $2 AND org_id = $3
     ORDER BY imported_at DESC`,
    [dealId, userId, orgId]
  );
  return result.rows;
}

async function getFilesForContact(contactId, userId, orgId) {
  const result = await pool.query(
    `SELECT id, provider, file_name, file_size, mime_type, category, web_url, source_label,
            imported_at, processed_at, processing_status, ai_summary, ai_action_items,
            ai_sentiment, actions_generated, pipelines_run
     FROM storage_files
     WHERE contact_id = $1 AND user_id = $2 AND org_id = $3
     ORDER BY imported_at DESC`,
    [contactId, userId, orgId]
  );
  return result.rows;
}

async function deleteImportRecord(recordId, userId, orgId) {
  const result = await pool.query(
    'DELETE FROM storage_files WHERE id = $1 AND user_id = $2 AND org_id = $3 RETURNING id, file_name',
    [recordId, userId, orgId]
  );
  if (result.rows.length === 0) {
    throw new Error('Import record not found or you do not have permission to delete it.');
  }
  return result.rows[0];
}

async function getAllFilesForUser(userId, orgId) {
  const result = await pool.query(
    `SELECT
       sf.id,
       sf.org_id,
       sf.user_id,
       sf.deal_id,
       sf.contact_id,
       sf.provider,
       sf.source_label,
       sf.provider_file_id,
       sf.file_name,
       sf.file_size,
       sf.mime_type,
       sf.category,
       sf.web_url,
       sf.last_modified_at,
       sf.imported_at,
       sf.processing_status,
       sf.handover_id,
       sf.tag_source,
       sf.hidden_at,
       d.name AS deal_name,
       COALESCE(h.name, hd.name) AS project_name
     FROM storage_files sf
     LEFT JOIN deals d ON d.id = sf.deal_id AND d.org_id = $2
     LEFT JOIN sales_handovers h ON h.id = sf.handover_id AND h.org_id = $2
     LEFT JOIN deals hd ON hd.id = h.deal_id
     WHERE sf.user_id = $1 AND sf.org_id = $2
     ORDER BY sf.imported_at DESC`,
    [userId, orgId]
  );
  return result.rows;
}


// ─────────────────────────────────────────────────────────────────────────────
// Folder awareness
//
// Everything below is provider-SHAPED — it knows that files live in folders and
// that a provider can be asked for a parent. It knows nothing about projects.
// projectFiles.service.js calls into here rather than talking to a provider
// itself, so Drive-vs-OneDrive stays in one place.
// ─────────────────────────────────────────────────────────────────────────────

// A pathological or looping tree must not turn one import into an unbounded
// number of API calls. Real folder structures are nowhere near this deep.
const MAX_FOLDER_DEPTH = 12;

/**
 * Walk from a file's immediate parent up to the root, returning ancestor folder
 * ids nearest-first. Written once here rather than per provider — the loop is
 * identical, only getParentFolderId() differs.
 *
 * Stops on a null parent (root, or the caller cannot see it). Guards against a
 * cycle, which Drive shortcuts can produce.
 */
async function resolveFolderPath(providerId, userId, immediateParentId) {
  if (!immediateParentId) return null;
  const { getProvider } = require('./StorageProviderFactory');
  const provider = getProvider(providerId);

  const path = [immediateParentId];
  const seen = new Set(path);
  let cursor = immediateParentId;

  for (let depth = 0; depth < MAX_FOLDER_DEPTH; depth += 1) {
    let parent;
    try {
      parent = await provider.getParentFolderId(userId, cursor);
    } catch (err) {
      // A partial chain still resolves any mapping at or below the level we
      // reached. Failing the whole import over an ancestor lookup would be a
      // worse trade.
      console.warn(`[storageFileService] folder walk stopped at ${cursor}: ${err.message}`);
      break;
    }
    if (!parent || seen.has(parent)) break;
    path.push(parent);
    seen.add(parent);
    cursor = parent;
  }
  return path;
}

/** Backfill folder columns on an existing row that predates this feature. */
async function setFolderMetadata(recordId, orgId, folderId, folderPath) {
  const { rows } = await pool.query(
    `UPDATE storage_files
        SET folder_id   = COALESCE($3, folder_id),
            folder_path = COALESCE($4, folder_path)
      WHERE id = $1 AND org_id = $2
      RETURNING id, folder_id, folder_path`,
    [recordId, orgId, folderId || null, folderPath || null]
  );
  return rows[0] || null;
}

/**
 * Reference row for a provider file, created without downloading or analysing
 * it. processing_status stays 'pending' — the column's own default and an
 * accurate description of the state: we hold a reference, we have not extracted
 * anything.
 *
 * Deliberately NOT createImportRecord: that path means "import and analyse this
 * for a deal" and sets status 'processing'. Adding a document to a project is a
 * filing action, not an analysis request.
 *
 * Returns { record, created }.
 */
async function ensureProviderFileRow(providerId, userId, orgId, providerFileId) {
  const { getProvider } = require('./StorageProviderFactory');
  const provider = getProvider(providerId);
  const meta = await provider.getFileMetadata(userId, providerFileId);

  if (meta.isFolder) {
    throw Object.assign(new Error('That is a folder, not a file. Map it to the project instead.'), { status: 400 });
  }

  const folderPath = await resolveFolderPath(providerId, userId, meta.parentFolderId);

  // An unfiled row for this file in this org is reusable — re-adding the same
  // document should not accumulate rows. A row already carrying a deal_id is
  // NOT reused: that link belongs to the deal and has its own lifecycle, and
  // deleting the deal import would otherwise silently drop the project link.
  const { rows: existing } = await pool.query(
    `SELECT * FROM storage_files
      WHERE org_id = $1 AND provider = $2 AND provider_file_id = $3
        AND deal_id IS NULL AND contact_id IS NULL
      ORDER BY (handover_id IS NOT NULL) DESC, id ASC
      LIMIT 1`,
    [orgId, providerId, providerFileId]
  );

  if (existing.length) {
    const patched = await pool.query(
      `UPDATE storage_files
          SET folder_id   = COALESCE($2, folder_id),
              folder_path = COALESCE($3, folder_path),
              web_url     = COALESCE($4, web_url),
              file_name   = $5
        WHERE id = $1 RETURNING *`,
      [existing[0].id, meta.parentFolderId || null, folderPath,
       meta.webViewLink || meta.webUrl || null, meta.name]
    );
    return { record: patched.rows[0], created: false };
  }

  const { rows } = await pool.query(
    `INSERT INTO storage_files (
       org_id, user_id, provider, provider_file_id, web_url, file_name,
       file_size, mime_type, category, last_modified_at, source_label,
       folder_id, folder_path, processing_status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending')
     RETURNING *`,
    [orgId, userId, providerId, providerFileId,
     meta.webViewLink || meta.webUrl || null, meta.name,
     meta.size || 0, meta.mimeType || null, meta.category || null,
     meta.lastModified || null, buildSourceLabel(providerId, meta.name),
     meta.parentFolderId || null, folderPath]
  );
  return { record: rows[0], created: true };
}

module.exports = {
  buildSourceLabel, checkDuplicate, createImportRecord,
  markProcessed, markFailed, getFilesForDeal, getFilesForContact,
  getAllFilesForUser, deleteImportRecord,
  resolveFolderPath, setFolderMetadata, ensureProviderFileRow,
};
