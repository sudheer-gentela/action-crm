// ============================================================
// ActionCRM Playbook Builder — Module B: Service Layer
// File: backend/services/PlaybookBuilderService.js
// Schema-verified against live \d output, March 2026.
// ============================================================

const { pool } = require('../config/database');

// ─────────────────────────────────────────────────────────────
// Access resolution helpers
// Per-org setting: organizations.settings->>'playbook_default_access'
// Global fallback:  platform_settings WHERE key = 'playbook_default_access'
//                   (value is JSONB so cast with ->> to get text)
// ─────────────────────────────────────────────────────────────
async function getDefaultAccess(org_id) {
  // 1. Per-org override stored in organizations.settings JSONB
  const orgQ = await pool.query(
    `SELECT settings->>'playbook_default_access' AS access
     FROM organizations WHERE id = $1`,
    [org_id]
  );
  const orgVal = orgQ.rows[0]?.access;
  if (orgVal && ['none', 'read_all', 'read_dept'].includes(orgVal)) return orgVal;

  // 2. Global platform default
  const psQ = await pool.query(
    `SELECT value->>0 AS access FROM platform_settings
     WHERE key = 'playbook_default_access'`
  );
  return psQ.rows[0]?.access || 'none';
}

async function resolveAccess(playbook_id, user_id, org_id) {
  // 1. User override
  const overrideQ = await pool.query(
    `SELECT access_level FROM playbook_user_access
     WHERE playbook_id = $1 AND user_id = $2
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [playbook_id, user_id]
  );
  if (overrideQ.rows.length) return overrideQ.rows[0].access_level;

  // 2. Team grant via playbook-dimensioned teams
  const teamQ = await pool.query(
    `SELECT pt.access_level
     FROM playbook_teams pt
     JOIN team_memberships tm ON tm.team_id = pt.team_id
     JOIN teams t ON t.id = pt.team_id
     WHERE pt.playbook_id = $1
       AND tm.user_id = $2
       AND t.dimension = 'playbook'
       AND t.is_active = TRUE
     LIMIT 1`,
    [playbook_id, user_id]
  );
  if (teamQ.rows.length) return teamQ.rows[0].access_level;

  // 3. Org / global default
  const defaultAccess = await getDefaultAccess(org_id);
  if (defaultAccess === 'none') return null;
  if (defaultAccess === 'read_all') return 'reader';
  if (defaultAccess === 'read_dept') {
    const deptQ = await pool.query(
      `SELECT p.department, u.department AS user_dept
       FROM playbooks p JOIN users u ON u.id = $2
       WHERE p.id = $1`,
      [playbook_id, user_id]
    );
    if (deptQ.rows.length && deptQ.rows[0].department === deptQ.rows[0].user_dept) {
      return 'reader';
    }
    return null;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// B1 — Playbook CRUD
// ─────────────────────────────────────────────────────────────

async function listPlaybooks({ org_id, user_id, role, dept, status, search }) {
  if (role === 'owner' || role === 'admin') {
    const result = await pool.query(
      `SELECT p.*, pv.version_number AS live_version_number, pv.status AS version_status,
              u.first_name || ' ' || u.last_name AS created_by_name
       FROM playbooks p
       LEFT JOIN playbook_versions pv ON pv.id = p.current_version_id
       LEFT JOIN users u ON u.id = p.created_by
       WHERE p.org_id = $1
         AND ($2::text IS NULL OR p.department = $2)
         AND ($3::text IS NULL OR p.is_active = ($3 = 'active'))
         AND ($4::text IS NULL OR p.name ILIKE '%' || $4 || '%')
       ORDER BY p.name`,
      [org_id, dept || null, status || null, search || null]
    );
    return result.rows;
  }

  // Non-admins: filter by explicit team/user grants only
  const result = await pool.query(
    `SELECT p.*, pv.version_number AS live_version_number,
            u.first_name || ' ' || u.last_name AS created_by_name,
            COALESCE(pua.access_level, pt_owner.access_level) AS user_access
     FROM playbooks p
     LEFT JOIN playbook_versions pv ON pv.id = p.current_version_id
     LEFT JOIN users u ON u.id = p.created_by
     LEFT JOIN playbook_user_access pua
       ON pua.playbook_id = p.id AND pua.user_id = $2
       AND (pua.expires_at IS NULL OR pua.expires_at > NOW())
     LEFT JOIN (
       SELECT pt.playbook_id, pt.access_level
       FROM playbook_teams pt
       JOIN team_memberships tm ON tm.team_id = pt.team_id
       JOIN teams t ON t.id = pt.team_id
       WHERE tm.user_id = $2
         AND t.dimension = 'playbook'
         AND t.is_active = TRUE
       LIMIT 1
     ) pt_owner ON pt_owner.playbook_id = p.id
     WHERE p.org_id = $1
       AND ($3::text IS NULL OR p.name ILIKE '%' || $3 || '%')
       AND COALESCE(pua.access_level, pt_owner.access_level) IS NOT NULL
       AND COALESCE(pua.access_level, pt_owner.access_level) != 'none'
     ORDER BY p.name`,
    [org_id, user_id, search || null]
  );

  // Supplement with org/global default for read_all
  const defaultAccess = await getDefaultAccess(org_id);
  if (defaultAccess !== 'read_all') return result.rows;

  const existingIds = new Set(result.rows.map(r => r.id));
  const allResult = await pool.query(
    `SELECT p.*, pv.version_number AS live_version_number,
            u.first_name || ' ' || u.last_name AS created_by_name, 'reader' AS user_access
     FROM playbooks p
     LEFT JOIN playbook_versions pv ON pv.id = p.current_version_id
     LEFT JOIN users u ON u.id = p.created_by
     WHERE p.org_id = $1
       AND ($2::text IS NULL OR p.name ILIKE '%' || $2 || '%')
     ORDER BY p.name`,
    [org_id, search || null]
  );
  const merged = [...result.rows];
  for (const row of allResult.rows) {
    if (!existingIds.has(row.id)) merged.push(row);
  }
  return merged.sort((a, b) => a.name.localeCompare(b.name));
}

async function getPlaybook(id) {
  const result = await pool.query(
    `SELECT p.*,
            pv.version_number AS live_version_number,
            pv.status AS version_status,
            pv.change_summary,
            pv.published_at,
            u_created.first_name || ' ' || u_created.last_name AS created_by_name,
            u_approved.first_name || ' ' || u_approved.last_name AS approved_by_name,
            pb_rep.name AS replacement_playbook_name
     FROM playbooks p
     LEFT JOIN playbook_versions pv ON pv.id = p.current_version_id
     LEFT JOIN users u_created ON u_created.id = p.created_by
     LEFT JOIN users u_approved ON u_approved.id = pv.approved_by
     LEFT JOIN playbooks pb_rep ON pb_rep.id = p.replacement_pb_id
     WHERE p.id = $1`,
    [id]
  );
  if (!result.rows.length) throw new Error('Playbook not found');
  const playbook = result.rows[0];

  // Derive the pipeline name from playbook type — same mapping used by
  // playbook.service.js and playbook-plays.routes.js throughout the app.
  // This makes pipeline_stages the single source of truth for stage structure.
  const SALES_LEGACY = ['sales', 'custom', 'market', 'product'];
  const pipeline = SALES_LEGACY.includes(playbook.type) ? 'sales'
    : playbook.type === 'prospecting' ? 'prospecting'
    : playbook.type; // clm, service, handover_s2i, or any custom type

  const stagesResult = await pool.query(
    `SELECT ps.key AS stage_key, ps.name, ps.sort_order AS position,
            ps.is_active, ps.is_terminal,
            COUNT(pp.id)::int AS play_count
     FROM pipeline_stages ps
     LEFT JOIN playbook_plays pp
       ON pp.playbook_id = $1
       AND pp.stage_key = ps.key
       AND pp.is_active = true
     WHERE ps.org_id  = $2
       AND ps.pipeline = $3
       AND ps.is_active = true
     GROUP BY ps.key, ps.name, ps.sort_order, ps.is_active, ps.is_terminal
     ORDER BY ps.sort_order`,
    [id, playbook.org_id, pipeline]
  );
  playbook.stages = stagesResult.rows;
  return playbook;
}

async function createPlaybook({
  org_id, created_by, name, type, department, entity_type,
  description, trigger_mode, conflict_rule, eligibility_filter
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const pbResult = await client.query(
      `INSERT INTO playbooks
         (org_id, name, type, department, entity_type, description,
          trigger_mode, conflict_rule, eligibility_filter, created_by, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)
       RETURNING *`,
      [org_id, name, type || 'custom', department || null, entity_type || null,
       description || null, trigger_mode || null, conflict_rule || null,
       eligibility_filter || null, created_by]
    );
    const playbook = pbResult.rows[0];

    const vResult = await client.query(
      `INSERT INTO playbook_versions (playbook_id, version_number, status, created_by)
       VALUES ($1, 1, 'draft', $2) RETURNING *`,
      [playbook.id, created_by]
    );
    const version = vResult.rows[0];

    await client.query(
      `UPDATE playbooks SET current_version_id = $1, updated_at = NOW() WHERE id = $2`,
      [version.id, playbook.id]
    );

    await client.query('COMMIT');
    return { ...playbook, current_version_id: version.id };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function updatePlaybook(id, updates) {
  const allowed = ['name', 'description', 'department', 'entity_type',
                   'trigger_mode', 'conflict_rule', 'eligibility_filter'];
  const setClauses = [];
  const values = [];
  let i = 1;
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      setClauses.push(`${key} = $${i++}`);
      values.push(updates[key]);
    }
  }
  if (!setClauses.length) throw new Error('No valid fields to update');
  // playbooks.updated_at is confirmed present
  setClauses.push(`updated_at = NOW()`);
  values.push(id);
  const result = await pool.query(
    `UPDATE playbooks SET ${setClauses.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  );
  return result.rows[0];
}

async function archivePlaybook({ playbook_id, archived_by, reason, replacement_pb_id, sunset_days = 7 }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE playbooks SET
         is_active = false,
         archived_at = NOW(),
         archived_by = $2,
         archive_reason = $3,
         replacement_pb_id = $4,
         sunset_days = $5,
         updated_at = NOW()
       WHERE id = $1`,
      [playbook_id, archived_by, reason, replacement_pb_id || null, sunset_days]
    );

    await client.query(
      `UPDATE playbook_versions SET status = 'archived', archived_at = NOW()
       WHERE playbook_id = $1 AND status = 'live'`,
      [playbook_id]
    );

    await client.query(
      `UPDATE playbook_plays SET is_active = false, updated_at = NOW()
       WHERE playbook_id = $1`,
      [playbook_id]
    );

    await client.query('COMMIT');
    return { success: true, archived_at: new Date(), sunset_days };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────
// B2 — Versioning
// ─────────────────────────────────────────────────────────────

async function getVersionHistory(playbook_id) {
  const result = await pool.query(
    `SELECT pv.*,
            u_created.first_name || ' ' || u_created.last_name AS created_by_name,
            u_approved.first_name || ' ' || u_approved.last_name AS approved_by_name
     FROM playbook_versions pv
     LEFT JOIN users u_created ON u_created.id = pv.created_by
     LEFT JOIN users u_approved ON u_approved.id = pv.approved_by
     WHERE pv.playbook_id = $1
     ORDER BY pv.version_number DESC`,
    [playbook_id]
  );
  return result.rows;
}

async function createDraftVersion({ playbook_id, created_by, change_summary }) {
  const existingDraft = await pool.query(
    `SELECT id FROM playbook_versions WHERE playbook_id = $1 AND status = 'draft'`,
    [playbook_id]
  );
  if (existingDraft.rows.length) {
    throw new Error('A draft version already exists. Complete or discard it first.');
  }

  const maxV = await pool.query(
    `SELECT COALESCE(MAX(version_number), 0) AS max_v
     FROM playbook_versions WHERE playbook_id = $1`,
    [playbook_id]
  );
  const next_v = Number(maxV.rows[0].max_v) + 1;

  const result = await pool.query(
    `INSERT INTO playbook_versions
       (playbook_id, version_number, status, created_by, change_summary)
     VALUES ($1, $2, 'draft', $3, $4) RETURNING *`,
    [playbook_id, next_v, created_by, change_summary || null]
  );
  return result.rows[0];
}

async function submitVersionForApproval({ playbook_id, version_number }) {
  const result = await pool.query(
    `UPDATE playbook_versions SET status = 'under_review'
     WHERE playbook_id = $1 AND version_number = $2 AND status = 'draft'
     RETURNING *`,
    [playbook_id, version_number]
  );
  if (!result.rows.length) throw new Error('Draft version not found or already submitted');
  return result.rows[0];
}

async function approveVersion({ playbook_id, version_number, approved_by }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE playbook_versions SET status = 'archived', archived_at = NOW()
       WHERE playbook_id = $1 AND status = 'live'`,
      [playbook_id]
    );

    const result = await client.query(
      `UPDATE playbook_versions SET
         status = 'live', approved_by = $3, published_at = NOW()
       WHERE playbook_id = $1 AND version_number = $2 AND status = 'under_review'
       RETURNING *`,
      [playbook_id, version_number, approved_by]
    );
    if (!result.rows.length) throw new Error('Version not found or not under review');
    const version = result.rows[0];

    await client.query(
      `UPDATE playbooks SET current_version_id = $1, is_active = true, updated_at = NOW()
       WHERE id = $2`,
      [version.id, playbook_id]
    );

    await client.query('COMMIT');
    return { version, published: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function rejectVersion({ playbook_id, version_number, rejected_by, reason }) {
  const result = await pool.query(
    `UPDATE playbook_versions
     SET status = 'draft',
         change_summary = $4
     WHERE playbook_id = $1 AND version_number = $2 AND status = 'under_review'
     RETURNING *`,
    [playbook_id, version_number, rejected_by,
     `REJECTED by user ${rejected_by}: ${reason || 'No reason given'}`]
  );
  if (!result.rows.length) throw new Error('Version not found or not under review');
  return { rejected: true, reason, version: result.rows[0] };
}

// ─────────────────────────────────────────────────────────────
// B3 — Plays CRUD
// Schema notes:
//   - playbook_plays has no role_id column currently (added by migration)
//   - playbook_plays has no action_type column (not in schema, do not insert)
//   - org_id is NOT NULL on playbook_plays — must be passed in
//   - fire_conditions is JSONB NOT NULL with default '[]' — pass [] not null
//   - role name lookup: playbook_roles links playbook→org_role,
//     org_roles has a name. Join via playbook_play_roles junction.
// ─────────────────────────────────────────────────────────────

async function getPlays({ playbook_id, stage_key, version_number }) {
  // FIX: role_id doesn't exist on playbook_plays — roles are in playbook_play_roles
  // Join via junction table to get role names
  const result = await pool.query(
    `SELECT pp.*,
            r.name AS role_name
     FROM playbook_plays pp
     LEFT JOIN playbook_play_roles ppr ON ppr.play_id = pp.id
     LEFT JOIN org_roles r ON r.id = ppr.role_id
     WHERE pp.playbook_id = $1
       AND ($2::text IS NULL OR pp.stage_key = $2)
       AND ($3::int IS NULL OR pp.version_number = $3)
       AND pp.is_active = true
     ORDER BY pp.sort_order ASC, pp.id ASC`,
    [playbook_id, stage_key || null, version_number || null]
  );
  return result.rows;
}

async function createPlay({
  playbook_id, org_id, created_by, stage_key, channel,
  title, description, priority, trigger_mode, schedule_config,
  fire_conditions, generation_mode, ai_config, suggested_action,
  role_id, version_number
}) {
  // FIX: org_id is NOT NULL — must be included
  // FIX: action_type removed — column does not exist on playbook_plays
  // FIX: fire_conditions default is '[]'::jsonb NOT NULL — use [] if not provided
  const result = await pool.query(
    `INSERT INTO playbook_plays
       (playbook_id, org_id, stage_key, channel, title, description,
        priority, trigger_mode, schedule_config, fire_conditions,
        generation_mode, ai_config, suggested_action,
        role_id, version_number, created_by, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12::jsonb,$13,$14,$15,$16,true)
     RETURNING *`,
    [
      playbook_id, org_id, stage_key, channel || null,
      title, description || null,
      priority || 'medium',                   // priority is text 'medium'/'high'/'low'
      trigger_mode || 'stage_change',
      schedule_config ? JSON.stringify(schedule_config) : null,
      JSON.stringify(fire_conditions || []),  // NOT NULL, default []
      generation_mode || 'template',
      ai_config ? JSON.stringify(ai_config) : null,
      suggested_action || null,
      role_id || null,
      version_number || 1,
      created_by
    ]
  );
  return result.rows[0];
}

async function updatePlay(play_id, updates) {
  // FIX: action_type removed (column does not exist)
  const allowed = ['title', 'description', 'channel', 'priority',
                   'trigger_mode', 'schedule_config', 'fire_conditions', 'generation_mode',
                   'ai_config', 'suggested_action', 'role_id', 'stage_key', 'is_active'];
  const jsonbFields = new Set(['schedule_config', 'fire_conditions', 'ai_config']);
  const setClauses = [];
  const values = [];
  let i = 1;
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      if (jsonbFields.has(key)) {
        setClauses.push(`${key} = $${i++}::jsonb`);
        values.push(JSON.stringify(updates[key]));
      } else {
        setClauses.push(`${key} = $${i++}`);
        values.push(updates[key]);
      }
    }
  }
  if (!setClauses.length) throw new Error('No valid fields to update');
  // playbook_plays.updated_at is confirmed present
  setClauses.push(`updated_at = NOW()`);
  values.push(play_id);
  const result = await pool.query(
    `UPDATE playbook_plays SET ${setClauses.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  );
  return result.rows[0];
}

async function deletePlay(play_id) {
  await pool.query(`DELETE FROM playbook_plays WHERE id = $1`, [play_id]);
}

// ─────────────────────────────────────────────────────────────
// B4 — Registrations
// ─────────────────────────────────────────────────────────────

async function listRegistrations({ org_id, user_id, role, status }) {
  if (role === 'owner' || role === 'admin') {
    const result = await pool.query(
      `SELECT pr.*, u.first_name || ' ' || u.last_name AS submitter_name, rv.first_name || ' ' || rv.last_name AS reviewer_name
       FROM playbook_registrations pr
       JOIN users u ON u.id = pr.submitter_id
       LEFT JOIN users rv ON rv.id = pr.reviewer_id
       WHERE pr.org_id = $1 AND ($2::text IS NULL OR pr.status = $2)
       ORDER BY pr.submitted_at DESC NULLS LAST, pr.created_at DESC`,
      [org_id, status || null]
    );
    return result.rows;
  }

  const result = await pool.query(
    `SELECT pr.*, u.first_name || ' ' || u.last_name AS submitter_name
     FROM playbook_registrations pr
     JOIN users u ON u.id = pr.submitter_id
     WHERE pr.org_id = $1 AND pr.submitter_id = $2
       AND ($3::text IS NULL OR pr.status = $3)
     ORDER BY pr.created_at DESC`,
    [org_id, user_id, status || null]
  );
  return result.rows;
}

async function getRegistration(id) {
  const result = await pool.query(
    `SELECT pr.*, u.first_name || ' ' || u.last_name AS submitter_name, rv.first_name || ' ' || rv.last_name AS reviewer_name
     FROM playbook_registrations pr
     JOIN users u ON u.id = pr.submitter_id
     LEFT JOIN users rv ON rv.id = pr.reviewer_id
     WHERE pr.id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

async function createRegistration({
  org_id, submitter_id, name, type, department, owner_team_id,
  purpose, entity_type, trigger_mode, conflict_rule, eligibility_filter
}) {
  const result = await pool.query(
    `INSERT INTO playbook_registrations
       (org_id, submitter_id, name, type, department, owner_team_id, purpose,
        entity_type, trigger_mode, conflict_rule, eligibility_filter, status, stage)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'draft','draft')
     RETURNING *`,
    [org_id, submitter_id, name, type, department || null,
     owner_team_id || null, purpose, entity_type || null,
     trigger_mode || null, conflict_rule || null, eligibility_filter || null]
  );
  return result.rows[0];
}

async function updateRegistration(id, updates) {
  const allowed = ['name', 'type', 'department', 'owner_team_id', 'purpose',
                   'entity_type', 'trigger_mode', 'conflict_rule', 'eligibility_filter'];
  const setClauses = [];
  const values = [];
  let i = 1;
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      setClauses.push(`${key} = $${i++}`);
      values.push(updates[key]);
    }
  }
  if (!setClauses.length) throw new Error('No valid fields to update');
  values.push(id);
  const result = await pool.query(
    `UPDATE playbook_registrations SET ${setClauses.join(', ')}
     WHERE id = $${i} RETURNING *`,
    values
  );
  return result.rows[0];
}

async function submitRegistration({ id, submitted_by }) {
  const result = await pool.query(
    `UPDATE playbook_registrations
     SET status = 'submitted', stage = 'submitted', submitted_at = NOW()
     WHERE id = $1 AND status = 'draft' AND submitter_id = $2
     RETURNING *`,
    [id, submitted_by]
  );
  if (!result.rows.length) throw new Error('Registration not found or not in draft status');
  return result.rows[0];
}

async function approveRegistration({ id, approved_by }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const regResult = await client.query(
      `UPDATE playbook_registrations
       SET status = 'approved', stage = 'approved',
           approved_at = NOW(), approved_by = $2
       WHERE id = $1 AND status IN ('submitted', 'under_review')
       RETURNING *`,
      [id, approved_by]
    );
    if (!regResult.rows.length) {
      throw new Error('Registration not found or not in reviewable status');
    }
    const reg = regResult.rows[0];

    const pbResult = await client.query(
      `INSERT INTO playbooks
         (org_id, name, type, department, entity_type, description,
          trigger_mode, conflict_rule, eligibility_filter, created_by, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)
       RETURNING *`,
      [reg.org_id, reg.name, reg.type || 'custom', reg.department || null,
       reg.entity_type || null, reg.purpose,
       reg.trigger_mode || null, reg.conflict_rule || null,
       reg.eligibility_filter || null, reg.submitter_id]
    );
    const playbook = pbResult.rows[0];

    const vResult = await client.query(
      `INSERT INTO playbook_versions (playbook_id, version_number, status, created_by)
       VALUES ($1, 1, 'draft', $2) RETURNING *`,
      [playbook.id, reg.submitter_id]
    );

    await client.query(
      `UPDATE playbooks SET current_version_id = $1, updated_at = NOW() WHERE id = $2`,
      [vResult.rows[0].id, playbook.id]
    );

    if (reg.owner_team_id) {
      await client.query(
        `INSERT INTO playbook_teams (playbook_id, team_id, access_level)
         VALUES ($1, $2, 'owner')
         ON CONFLICT (playbook_id, team_id) DO UPDATE SET access_level = 'owner'`,
        [playbook.id, reg.owner_team_id]
      );
    }

    await client.query('COMMIT');
    return { registration: reg, playbook };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function rejectRegistration({ id, rejected_by, reason }) {
  const result = await pool.query(
    `UPDATE playbook_registrations
     SET status = 'rejected', stage = 'rejected',
         rejected_at = NOW(), rejection_reason = $3, reviewer_id = $2
     WHERE id = $1 RETURNING *`,
    [id, rejected_by, reason]
  );
  if (!result.rows.length) throw new Error('Registration not found');
  return result.rows[0];
}

async function requestChanges({ id, reviewer_id, notes }) {
  const result = await pool.query(
    `UPDATE playbook_registrations
     SET status = 'changes_requested', stage = 'changes_requested',
         reviewer_id = $2, rejection_reason = $3
     WHERE id = $1 RETURNING *`,
    [id, reviewer_id, notes]
  );
  if (!result.rows.length) throw new Error('Registration not found');
  return result.rows[0];
}

// ─────────────────────────────────────────────────────────────
// B5 — Access management
// ─────────────────────────────────────────────────────────────

async function getTeamGrants(playbook_id) {
  const result = await pool.query(
    `SELECT pt.*, t.name AS team_name, t.dimension
     FROM playbook_teams pt
     JOIN teams t ON t.id = pt.team_id
     WHERE pt.playbook_id = $1
     ORDER BY pt.access_level, t.name`,
    [playbook_id]
  );
  return result.rows;
}

async function addTeamGrant({ playbook_id, team_id, access_level }) {
  const result = await pool.query(
    `INSERT INTO playbook_teams (playbook_id, team_id, access_level)
     VALUES ($1, $2, $3)
     ON CONFLICT (playbook_id, team_id) DO UPDATE SET access_level = EXCLUDED.access_level
     RETURNING *`,
    [playbook_id, team_id, access_level]
  );
  return result.rows[0];
}

async function removeTeamGrant(playbook_id, team_id) {
  await pool.query(
    `DELETE FROM playbook_teams WHERE playbook_id = $1 AND team_id = $2`,
    [playbook_id, team_id]
  );
}

async function getUserOverrides(playbook_id) {
  const result = await pool.query(
    `SELECT pua.*, u.first_name || ' ' || u.last_name AS user_name, u.email AS user_email,
            sb.first_name || ' ' || sb.last_name AS set_by_name
     FROM playbook_user_access pua
     JOIN users u ON u.id = pua.user_id
     LEFT JOIN users sb ON sb.id = pua.set_by
     WHERE pua.playbook_id = $1
     ORDER BY u.first_name, u.last_name`,
    [playbook_id]
  );
  return result.rows;
}

async function setUserOverride({ playbook_id, user_id, access_level, reason, expires_at, set_by }) {
  const result = await pool.query(
    `INSERT INTO playbook_user_access
       (playbook_id, user_id, access_level, reason, expires_at, set_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (playbook_id, user_id) DO UPDATE SET
       access_level = EXCLUDED.access_level,
       reason = EXCLUDED.reason,
       expires_at = EXCLUDED.expires_at,
       set_by = EXCLUDED.set_by
     RETURNING *`,
    [playbook_id, user_id, access_level, reason || null, expires_at || null, set_by || null]
  );
  return result.rows[0];
}

async function removeUserOverride(playbook_id, user_id) {
  await pool.query(
    `DELETE FROM playbook_user_access WHERE playbook_id = $1 AND user_id = $2`,
    [playbook_id, user_id]
  );
}

// ─────────────────────────────────────────────────────────────
// B6 — Stats
// FIX: deal_play_instances has no playbook_id yet (migration adds it).
// Intermediate fallback: join via play_id → playbook_plays.playbook_id
// so stats work even before the migration adds the direct column.
// ─────────────────────────────────────────────────────────────

async function getStats({ org_id }) {
  const result = await pool.query(
    `SELECT
       p.id AS playbook_id,
       p.name AS playbook_name,
       COUNT(DISTINCT dpi.id) AS total_instances,
       COUNT(DISTINCT CASE WHEN dpi.status = 'completed' THEN dpi.id END) AS completed_instances,
       ROUND(
         COUNT(DISTINCT CASE WHEN dpi.status = 'completed' THEN dpi.id END)::numeric /
         NULLIF(COUNT(DISTINCT dpi.id), 0) * 100, 1
       ) AS completion_rate
     FROM playbooks p
     LEFT JOIN playbook_plays pp ON pp.playbook_id = p.id
     LEFT JOIN deal_play_instances dpi ON dpi.play_id = pp.id
     WHERE p.org_id = $1
     GROUP BY p.id, p.name
     ORDER BY completion_rate DESC NULLS LAST`,
    [org_id]
  );
  return result.rows;
}

async function getPlaybookStats(playbook_id) {
  const result = await pool.query(
    `SELECT
       pp.id AS play_id,
       pp.title AS play_title,
       pp.stage_key,
       pp.channel,
       COUNT(dpi.id) AS total_fires,
       COUNT(CASE WHEN dpi.status = 'completed' THEN 1 END) AS completed,
       COUNT(CASE WHEN dpi.status = 'yet_to_start' THEN 1 END) AS yet_to_start,
       COUNT(CASE WHEN dpi.status = 'in_progress'  THEN 1 END) AS in_progress,
       ROUND(
         COUNT(CASE WHEN dpi.status = 'completed' THEN 1 END)::numeric /
         NULLIF(COUNT(dpi.id), 0) * 100, 1
       ) AS completion_rate
     FROM playbook_plays pp
     LEFT JOIN deal_play_instances dpi ON dpi.play_id = pp.id
     WHERE pp.playbook_id = $1
     GROUP BY pp.id, pp.title, pp.stage_key, pp.channel
     ORDER BY pp.stage_key, pp.sort_order`,
    [playbook_id]
  );
  return result.rows;
}

module.exports = {
  resolveAccess,
  listPlaybooks, getPlaybook, createPlaybook, updatePlaybook, archivePlaybook,
  getVersionHistory, createDraftVersion, submitVersionForApproval, approveVersion, rejectVersion,
  getPlays, createPlay, updatePlay, deletePlay,
  listRegistrations, getRegistration, createRegistration, updateRegistration,
  submitRegistration, approveRegistration, rejectRegistration, requestChanges,
  getTeamGrants, addTeamGrant, removeTeamGrant,
  getUserOverrides, setUserOverride, removeUserOverride,
  getStats, getPlaybookStats,
};
