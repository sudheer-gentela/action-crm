// ─────────────────────────────────────────────────────────────────────────────
// whatsappTemplates.service.js
//
// Org-authored WhatsApp template governance.
//
// Two gates:
//   review_status : GoWarm-internal — proposed → admin_approved | admin_rejected
//   status        : Meta            — draft → pending → approved | rejected | paused | disabled
//
// Flow:
//   • A user with edit rights PROPOSES        → review_status='proposed', status='draft'
//   • An admin authoring their own template   → review_status='admin_approved' + submitted to Meta
//   • Admin APPROVES a proposal               → submitted to Meta (status='pending')
//   • Admin REJECTS a proposal (with reason)  → review_status='admin_rejected' (visible to proposer)
//   • Meta webhook message_template_status_update → status approved/rejected(+reason)/paused/disabled
//
// Only status='approved' (and review_status='admin_approved') templates are usable
// in the composer.
// ─────────────────────────────────────────────────────────────────────────────
const { pool } = require('../config/database');
const waChannel = require('./channels/whatsappChannel');

function countVars(bodyText) {
  const idxs = [...new Set((String(bodyText || '').match(/\{\{\s*(\d+)\s*\}\}/g) || [])
    .map(m => m.replace(/[^\d]/g, '')))];
  return idxs.length;
}

// Normalise variable_map to exactly the number of {{n}} placeholders in the body.
function normalizeVariableMap(bodyText, variableMap) {
  const n = countVars(bodyText);
  const vm = Array.isArray(variableMap) ? variableMap : [];
  return Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    label: (vm[i] && vm[i].label) || `Variable ${i + 1}`,
    example: (vm[i] && vm[i].example) || '',
  }));
}

// ── Reads ────────────────────────────────────────────────────────────────────

// Admin review screen: every template in the org, newest first.
async function listAll(orgId) {
  const { rows } = await pool.query(
    `SELECT * FROM whatsapp_templates WHERE org_id = $1 ORDER BY updated_at DESC`, [orgId]);
  return { templates: rows };
}

// A user's own proposals and their outcomes (incl. rejection reasons).
async function listMine(orgId, userId) {
  const { rows } = await pool.query(
    `SELECT * FROM whatsapp_templates WHERE org_id = $1 AND created_by = $2 ORDER BY updated_at DESC`,
    [orgId, userId]);
  return { templates: rows };
}

// Templates a user may actually SEND: internally approved + Meta-approved, and
// either org-wide or explicitly granted to this user.
async function listUsable(orgId, userId) {
  const { rows } = await pool.query(
    `SELECT t.* FROM whatsapp_templates t
      WHERE t.org_id = $1
        AND t.review_status = 'admin_approved'
        AND t.status = 'approved'
        AND ( t.visibility = 'org'
              OR EXISTS (SELECT 1 FROM whatsapp_template_grants g
                          WHERE g.template_id = t.id AND g.user_id = $2) )
      ORDER BY t.name`,
    [orgId, userId]);
  return {
    templates: rows.map(t => ({
      name: t.name,
      language: t.language,
      category: t.category,
      audience: t.audience,
      bodyText: t.body_text,
      variables: (t.variable_map && t.variable_map.length
        ? t.variable_map
        : normalizeVariableMap(t.body_text, [])
      ).map(v => ({ label: v.label || `Variable ${v.index}`, placeholder: v.example || '' })),
    })),
  };
}

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Create a template. Admins author directly (auto internally-approved and
 * submitted to Meta). Non-admins propose (awaits admin review).
 */
async function propose(orgId, userId, isAdmin, data) {
  const name     = String(data.name || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const language = String(data.language || 'en_US').trim();
  const category = String(data.category || 'UTILITY').trim().toUpperCase();
  const bodyText = String(data.bodyText || '').trim();
  if (!name)     throw Object.assign(new Error('Template name is required'), { status: 400 });
  if (!bodyText) throw Object.assign(new Error('Template body is required'),  { status: 400 });
  if (!['UTILITY', 'MARKETING', 'AUTHENTICATION'].includes(category))
    throw Object.assign(new Error('Category must be UTILITY, MARKETING, or AUTHENTICATION'), { status: 400 });

  const variableMap = normalizeVariableMap(bodyText, data.variableMap);
  const audience    = ['internal', 'customer', 'any'].includes(data.audience) ? data.audience : 'any';
  const visibility  = data.visibility === 'grant' ? 'grant' : 'org';
  const reviewStatus = isAdmin ? 'admin_approved' : 'proposed';

  const { rows: [tpl] } = await pool.query(
    `INSERT INTO whatsapp_templates
       (org_id, name, language, category, body_text, header_text, footer_text,
        variable_map, purpose, audience, visibility, status, review_status,
        reviewed_by, reviewed_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'draft',$12,
             $13, CASE WHEN $12 = 'admin_approved' THEN now() ELSE NULL END, $14)
     RETURNING *`,
    [orgId, name, language, category, bodyText, data.headerText || null, data.footerText || null,
     JSON.stringify(variableMap), data.purpose || null, audience, visibility,
     reviewStatus, isAdmin ? userId : null, userId]);

  // Admin-authored templates go straight to Meta.
  if (isAdmin) return submitToMeta(orgId, tpl.id);
  return { template: tpl };
}

/** Admin decision on a proposed template. action = 'approve' | 'reject'. */
async function review(orgId, adminId, templateId, action, reason) {
  const { rows: [tpl] } = await pool.query(
    `SELECT * FROM whatsapp_templates WHERE id = $1 AND org_id = $2`, [templateId, orgId]);
  if (!tpl) throw Object.assign(new Error('Template not found'), { status: 404 });

  if (action === 'reject') {
    if (!reason || !String(reason).trim())
      throw Object.assign(new Error('A rejection reason is required'), { status: 400 });
    const { rows: [updated] } = await pool.query(
      `UPDATE whatsapp_templates
          SET review_status = 'admin_rejected', review_reason = $3,
              reviewed_by = $4, reviewed_at = now(), updated_at = now()
        WHERE id = $1 AND org_id = $2 RETURNING *`,
      [templateId, orgId, String(reason).trim(), adminId]);
    return { template: updated };
  }

  if (action === 'approve') {
    await pool.query(
      `UPDATE whatsapp_templates
          SET review_status = 'admin_approved', review_reason = NULL,
              reviewed_by = $3, reviewed_at = now(), updated_at = now()
        WHERE id = $1 AND org_id = $2`,
      [templateId, orgId, adminId]);
    return submitToMeta(orgId, templateId);   // internally approved → send to Meta
  }

  throw Object.assign(new Error("action must be 'approve' or 'reject'"), { status: 400 });
}

/** Submit an internally-approved template to Meta and mark it pending. */
async function submitToMeta(orgId, templateId) {
  const { rows: [tpl] } = await pool.query(
    `SELECT * FROM whatsapp_templates WHERE id = $1 AND org_id = $2`, [templateId, orgId]);
  if (!tpl) throw Object.assign(new Error('Template not found'), { status: 404 });

  const account = await waChannel.getAccount(orgId);
  if (!account) throw Object.assign(new Error('WhatsApp is not connected for this org'), { status: 400, code: 'NOT_CONNECTED' });

  const example = (tpl.variable_map || []).map(v => v.example || 'sample');
  const result = await waChannel.submitTemplate(account, {
    name: tpl.name, language: tpl.language, category: tpl.category,
    bodyText: tpl.body_text, headerText: tpl.header_text, footerText: tpl.footer_text,
    example,
  });

  if (!result.ok) {
    // Keep it as an internally-approved draft so the admin can fix and resubmit.
    await pool.query(
      `UPDATE whatsapp_templates SET status = 'draft', rejection_reason = $3, updated_at = now()
        WHERE id = $1 AND org_id = $2`,
      [templateId, orgId, `Meta submission failed: ${result.error || result.code}`]);
    throw Object.assign(new Error(result.error || 'Meta rejected the template submission'),
      { status: 400, code: result.code });
  }

  const { rows: [updated] } = await pool.query(
    `UPDATE whatsapp_templates
        SET meta_template_id = $3, status = 'pending', rejection_reason = NULL,
            submitted_at = now(), updated_at = now()
      WHERE id = $1 AND org_id = $2 RETURNING *`,
    [templateId, orgId, result.metaId]);
  return { template: updated };
}

/**
 * Apply a Meta `message_template_status_update` webhook. Matches by
 * meta_template_id when present, else by name+language within the org.
 * event is Meta's event string (APPROVED / REJECTED / PAUSED / DISABLED / etc).
 */
async function applyMetaStatusUpdate(orgId, { metaTemplateId, name, language, event, reason }) {
  const map = { APPROVED: 'approved', REJECTED: 'rejected', PAUSED: 'paused',
                DISABLED: 'disabled', FLAGGED: 'paused', PENDING: 'pending' };
  const status = map[String(event || '').toUpperCase()];
  if (!status) return { updated: 0 };

  const setApproved = status === 'approved' ? ', approved_at = now()' : '';
  const params = [orgId, status, reason || null];
  let where, idx = 4;
  if (metaTemplateId) { where = `meta_template_id = $${idx++}`; params.push(String(metaTemplateId)); }
  else                { where = `name = $${idx++} AND language = $${idx++}`; params.push(name, language); }

  const res = await pool.query(
    `UPDATE whatsapp_templates
        SET status = $2, rejection_reason = CASE WHEN $2 = 'rejected' THEN $3 ELSE rejection_reason END${setApproved},
            updated_at = now()
      WHERE org_id = $1 AND ${where}`,
    params);
  return { updated: res.rowCount };
}

module.exports = {
  listAll,
  listMine,
  listUsable,
  propose,
  review,
  submitToMeta,
  applyMetaStatusUpdate,
};
