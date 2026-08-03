// ─────────────────────────────────────────────────────────────────────────────
// projectFiles.service.js
//
// PROJECT semantics for documents: tagging, folder mapping, hiding, precedence.
//
// Deliberately knows nothing about Google Drive or OneDrive. Anything
// provider-shaped — reading file metadata, walking a folder tree, creating the
// storage_files row — is delegated to storageFileService, which owns the
// provider abstraction. If this file ever grows an `if (provider === ...)` that
// is the signal that something has been put in the wrong layer.
//
// PRECEDENCE
//   storage_files.handover_id is the effective project; tag_source says how it
//   got there. A manual tag outranks a folder mapping, and the partial unique
//   index uq_storage_files_project_ref means one file cannot carry a project
//   link on two rows. Precedence is therefore one guard on one UPDATE
//   (tag_source IS DISTINCT FROM 'manual') rather than something every read has
//   to reproduce.
//
// UNTAG vs HIDE
//   untag — drops the link and its provenance. If the file still sits under a
//           mapped folder it falls back to that folder's project, because
//           untagging is an undo of the manual override, not a statement that
//           the document is unrelated to the project.
//   hide  — keeps link and provenance, removes the file from the team view.
//           This is the tool for "not this one", whether the file arrived by
//           folder mapping or was tagged by hand.
// ─────────────────────────────────────────────────────────────────────────────

const { pool }        = require('../config/database');
const storageFiles    = require('./storageFileService');
const projectMembers  = require('./projectMembers.service');

// ── Authority ────────────────────────────────────────────────────────────────

/**
 * Mapping and unmapping folders, and reversing a hide, are project-configuration
 * acts — they change what the whole team sees. Same authority as staffing the
 * project: org admin/owner, service owner, or creator.
 */
async function canManageFiles(handoverId, orgId, userId) {
  return projectMembers.canManageProject(handoverId, orgId, userId);
}

/**
 * Filing a document and hiding one are day-to-day acts, open to anyone actually
 * on the project. 'approved' only — a pending request is not membership.
 */
async function canFile(handoverId, orgId, userId) {
  if (!userId) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM project_members
      WHERE context_type = 'handover' AND context_id = $1
        AND org_id = $2 AND user_id = $3 AND status = 'approved'
      LIMIT 1`,
    [handoverId, orgId, userId]
  );
  if (rows.length) return true;
  return canManageFiles(handoverId, orgId, userId);
}

async function assertCanFile(handoverId, orgId, userId) {
  if (!(await canFile(handoverId, orgId, userId))) {
    throw Object.assign(new Error('You are not on this project'), { status: 403 });
  }
}

async function assertCanManage(handoverId, orgId, userId) {
  if (!(await canManageFiles(handoverId, orgId, userId))) {
    throw Object.assign(
      new Error('Only the project owner or an org admin can change folder mappings'),
      { status: 403 }
    );
  }
}

async function assertProjectExists(handoverId, orgId) {
  const { rows } = await pool.query(
    `SELECT id FROM sales_handovers WHERE id = $1 AND org_id = $2`, [handoverId, orgId]);
  if (!rows.length) throw Object.assign(new Error('Project not found'), { status: 404 });
}

// ── Folder mappings ──────────────────────────────────────────────────────────

async function listFolders(handoverId, orgId) {
  const { rows } = await pool.query(
    `SELECT pf.id, pf.provider, pf.folder_id, pf.folder_name, pf.created_at,
            pf.created_by, (u.first_name || ' ' || u.last_name) AS created_by_name,
            (SELECT count(*) FROM storage_files sf
              WHERE sf.org_id = pf.org_id AND sf.handover_id = pf.handover_id
                AND sf.tag_source = 'folder'
                AND pf.folder_id = ANY(sf.folder_path)) AS file_count
       FROM project_folders pf
       LEFT JOIN users u ON u.id = pf.created_by
      WHERE pf.handover_id = $1 AND pf.org_id = $2
      ORDER BY pf.created_at`,
    [handoverId, orgId]
  );
  return { folders: rows };
}

/**
 * Map a folder to this project. Covers subfolders — resolution matches the
 * folder id anywhere in a file's ancestor chain.
 *
 * Does NOT import the folder's contents. Files are browsed and added
 * deliberately; a mapping decides which project a document lands in when
 * somebody adds it, and back-fills documents already known to us.
 */
async function mapFolder(handoverId, orgId, userId, { provider, folderId, folderName }) {
  await assertProjectExists(handoverId, orgId);
  await assertCanManage(handoverId, orgId, userId);

  if (!provider || !folderId) {
    throw Object.assign(new Error('provider and folderId are required'), { status: 400 });
  }

  const { rows: clash } = await pool.query(
    `SELECT pf.handover_id, h.name AS project_name
       FROM project_folders pf
       LEFT JOIN sales_handovers h ON h.id = pf.handover_id
      WHERE pf.org_id = $1 AND pf.provider = $2 AND pf.folder_id = $3`,
    [orgId, provider, folderId]
  );
  if (clash.length && clash[0].handover_id !== handoverId) {
    throw Object.assign(
      new Error(`That folder is already mapped to "${clash[0].project_name || 'another project'}". A folder belongs to one project.`),
      { status: 409 }
    );
  }

  const { rows } = await pool.query(
    `INSERT INTO project_folders (org_id, handover_id, provider, folder_id, folder_name, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (org_id, provider, folder_id)
       DO UPDATE SET folder_name = COALESCE(EXCLUDED.folder_name, project_folders.folder_name)
     RETURNING *`,
    [orgId, handoverId, provider, folderId, folderName || null, userId]
  );

  const resolved = await resolveFolderMembership(orgId, { handoverId });
  return { folder: rows[0], filesLinked: resolved.linked };
}

async function unmapFolder(handoverId, orgId, userId, mappingId) {
  await assertCanManage(handoverId, orgId, userId);

  const { rows } = await pool.query(
    `DELETE FROM project_folders
      WHERE id = $1 AND org_id = $2 AND handover_id = $3
      RETURNING provider, folder_id`,
    [mappingId, orgId, handoverId]
  );
  if (!rows.length) throw Object.assign(new Error('Folder mapping not found'), { status: 404 });

  // Only folder-derived links are released. A file someone tagged by hand stays
  // on the project — the mapping is not why it is there.
  const { rowCount } = await pool.query(
    `UPDATE storage_files
        SET handover_id = NULL, tag_source = NULL, tagged_by = NULL, tagged_at = NULL,
            hidden_at = NULL, hidden_by = NULL
      WHERE org_id = $1 AND handover_id = $2 AND tag_source = 'folder'
        AND provider = $3 AND $4 = ANY(folder_path)`,
    [orgId, handoverId, rows[0].provider, rows[0].folder_id]
  );
  return { deleted: true, filesReleased: rowCount };
}

/**
 * Re-apply folder mappings to file rows we already hold.
 *
 * Scope is an option, and picking the wrong one is a real bug rather than a
 * performance detail:
 *   { handoverId } — after mapping a folder: back-fill that project.
 *   { recordId }   — after untagging ONE file: the folder that should reclaim
 *                    it may belong to a DIFFERENT project than the one it was
 *                    just untagged from, so scoping this to a project silently
 *                    leaves the file unfiled.
 *
 * Two guards carry the precedence rule:
 *   tag_source IS DISTINCT FROM 'manual'  — never override a hand-tagged file.
 *   NOT EXISTS (... other project row ...) — never create a second project link
 *     for a file that already has one. Without this the partial unique index
 *     would reject the whole statement; with it, the already-filed file is
 *     simply skipped, which is the intended precedence outcome.
 */
async function resolveFolderMembership(orgId, { handoverId = null, recordId = null } = {}) {
  const { rowCount } = await pool.query(
    `UPDATE storage_files sf
        SET handover_id = pf.handover_id,
            tag_source  = 'folder',
            tagged_at   = COALESCE(sf.tagged_at, now())
       FROM project_folders pf
      WHERE pf.org_id = sf.org_id
        AND pf.provider = sf.provider
        AND pf.folder_id = ANY(sf.folder_path)
        AND sf.org_id = $1
        AND ($2::int IS NULL OR pf.handover_id = $2)
        AND ($3::int IS NULL OR sf.id = $3)
        AND sf.tag_source IS DISTINCT FROM 'manual'
        AND sf.handover_id IS DISTINCT FROM pf.handover_id
        AND NOT EXISTS (
              SELECT 1 FROM storage_files other
               WHERE other.org_id = sf.org_id
                 AND other.provider = sf.provider
                 AND other.provider_file_id = sf.provider_file_id
                 AND other.handover_id IS NOT NULL
                 AND other.id <> sf.id
            )`,
    [orgId, handoverId, recordId]
  );
  return { linked: rowCount };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * The project's documents.
 *
 * Org-scoped, NOT user-scoped. Every other storage_files read filters
 * user_id — correct for "my imports", wrong here: a document Alice filed has to
 * be visible to the team or the feature does nothing. Those existing functions
 * are left exactly as they are.
 */
async function listForProject(handoverId, orgId, { includeHidden = false } = {}) {
  const { rows } = await pool.query(
    `SELECT sf.id, sf.provider, sf.provider_file_id, sf.file_name, sf.file_size,
            sf.mime_type, sf.category, sf.web_url, sf.source_label,
            sf.imported_at, sf.processing_status, sf.ai_summary,
            sf.folder_id, sf.folder_path, sf.tag_source,
            sf.tagged_by, sf.tagged_at, sf.hidden_at, sf.hidden_by,
            sf.deal_id,
            (tu.first_name || ' ' || tu.last_name) AS tagged_by_name,
            (hu.first_name || ' ' || hu.last_name) AS hidden_by_name,
            pf.folder_name AS via_folder_name,
            pf.folder_id   AS via_folder_id
       FROM storage_files sf
       LEFT JOIN users tu ON tu.id = sf.tagged_by
       LEFT JOIN users hu ON hu.id = sf.hidden_by
       LEFT JOIN project_folders pf
              ON sf.tag_source = 'folder'
             AND pf.org_id = sf.org_id
             AND pf.provider = sf.provider
             AND pf.folder_id = ANY(sf.folder_path)
             AND pf.handover_id = sf.handover_id
      WHERE sf.handover_id = $1 AND sf.org_id = $2
        AND ($3::boolean OR sf.hidden_at IS NULL)
      ORDER BY sf.hidden_at NULLS FIRST, sf.file_name`,
    [handoverId, orgId, includeHidden]
  );
  return { files: rows };
}

/**
 * Which of these provider files are already on a project, and which one.
 *
 * Backs the on-demand browse: the picker lists a folder through the existing
 * storage endpoints, then asks this so it can show what is already filed
 * instead of offering to add it twice.
 */
async function linkStatus(orgId, provider, providerFileIds = []) {
  if (!Array.isArray(providerFileIds) || !providerFileIds.length) return { status: {} };
  const { rows } = await pool.query(
    `SELECT sf.provider_file_id, sf.id AS record_id, sf.handover_id,
            sf.tag_source, sf.hidden_at, h.name AS project_name
       FROM storage_files sf
       LEFT JOIN sales_handovers h ON h.id = sf.handover_id
      WHERE sf.org_id = $1 AND sf.provider = $2
        AND sf.provider_file_id = ANY($3::text[])
        AND sf.handover_id IS NOT NULL`,
    [orgId, provider, providerFileIds]
  );
  const status = {};
  for (const r of rows) {
    status[r.provider_file_id] = {
      recordId: r.record_id, handoverId: r.handover_id, tagSource: r.tag_source,
      hidden: !!r.hidden_at, projectName: r.project_name,
    };
  }
  return { status };
}

// ── Writes: tag / untag / hide / unhide ──────────────────────────────────────

/**
 * File a document under this project by hand. Outranks any folder mapping.
 *
 * Takes a provider + provider file id rather than a storage_files id: the
 * document may be one we have never referenced before. Creating the row is
 * provider-shaped work and belongs to storageFileService.
 */
async function tagFile(handoverId, orgId, userId, { provider, providerFileId }) {
  await assertProjectExists(handoverId, orgId);
  await assertCanFile(handoverId, orgId, userId);

  if (!provider || !providerFileId) {
    throw Object.assign(new Error('provider and providerFileId are required'), { status: 400 });
  }

  const { record } = await storageFiles.ensureProviderFileRow(provider, userId, orgId, providerFileId);

  // Another row for the same file may already hold the project link — typically
  // the folder-derived one. Move that row rather than adding a second, so the
  // file ends up in exactly one project. This is the case the previous draft
  // got wrong: it left the folder-derived link in place and added a manual one,
  // and the file showed up in both projects.
  const { rows: holder } = await pool.query(
    `SELECT id FROM storage_files
      WHERE org_id = $1 AND provider = $2 AND provider_file_id = $3
        AND handover_id IS NOT NULL AND id <> $4
      LIMIT 1`,
    [orgId, provider, providerFileId, record.id]
  );

  const targetId = holder.length ? holder[0].id : record.id;

  const { rows } = await pool.query(
    `UPDATE storage_files
        SET handover_id = $2, tag_source = 'manual',
            tagged_by = $3, tagged_at = now(),
            hidden_at = NULL, hidden_by = NULL
      WHERE id = $1 AND org_id = $4
      RETURNING id, handover_id, tag_source, file_name`,
    [targetId, handoverId, userId, orgId]
  );
  return { file: rows[0], movedExistingLink: !!holder.length };
}

/**
 * Remove the link and its provenance.
 *
 * If the document still sits under a folder mapped to a project it is picked up
 * again by that mapping — untag undoes the manual override, it does not assert
 * the document is unrelated. Use hide for that.
 */
async function untagFile(handoverId, orgId, userId, recordId) {
  await assertCanFile(handoverId, orgId, userId);

  const { rows } = await pool.query(
    `UPDATE storage_files
        SET handover_id = NULL, tag_source = NULL, tagged_by = NULL, tagged_at = NULL,
            hidden_at = NULL, hidden_by = NULL
      WHERE id = $1 AND org_id = $2 AND handover_id = $3
      RETURNING id, provider, provider_file_id, file_name`,
    [recordId, orgId, handoverId]
  );
  if (!rows.length) throw Object.assign(new Error('File is not on this project'), { status: 404 });

  // Scoped to the file, not to handoverId: the mapping that should reclaim it
  // may belong to another project entirely.
  const re = await resolveFolderMembership(orgId, { recordId: rows[0].id });
  return { untagged: true, file: rows[0], reclaimedByFolder: re.linked > 0 };
}

/** Suppress from the team view. Link and provenance are kept. */
async function hideFile(handoverId, orgId, userId, recordId) {
  await assertCanFile(handoverId, orgId, userId);
  const { rows } = await pool.query(
    `UPDATE storage_files
        SET hidden_at = now(), hidden_by = $4
      WHERE id = $1 AND org_id = $2 AND handover_id = $3 AND hidden_at IS NULL
      RETURNING id, file_name, hidden_at`,
    [recordId, orgId, handoverId, userId]
  );
  if (!rows.length) throw Object.assign(new Error('File is not on this project, or is already hidden'), { status: 404 });
  return { hidden: true, file: rows[0] };
}

/** Reversing a hide changes what the whole team sees — manage authority. */
async function unhideFile(handoverId, orgId, userId, recordId) {
  await assertCanManage(handoverId, orgId, userId);
  const { rows } = await pool.query(
    `UPDATE storage_files
        SET hidden_at = NULL, hidden_by = NULL
      WHERE id = $1 AND org_id = $2 AND handover_id = $3
      RETURNING id, file_name`,
    [recordId, orgId, handoverId]
  );
  if (!rows.length) throw Object.assign(new Error('File is not on this project'), { status: 404 });
  return { hidden: false, file: rows[0] };
}

module.exports = {
  canManageFiles, canFile,
  listFolders, mapFolder, unmapFolder, resolveFolderMembership,
  listForProject, linkStatus,
  tagFile, untagFile, hideFile, unhideFile,
};
