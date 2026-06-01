// ─────────────────────────────────────────────────────────────────────────────
// routes/prospecting-activity.routes.js
//
// Multi-channel prospecting Activity feed. Unifies two sources into one
// normalized, time-sorted, paginated stream:
//
//   1. emails                  → sent / received email (the inbox source)
//   2. prospecting_activities  → LinkedIn events, calls, sequence events,
//                                stage changes, enrichment, etc.
//
// Each row is normalized to a common shape:
//   { type, channel, category, label, direction, prospect, company,
//     actor, summary, occurredAt, refId, refTable, metadata }
//
// This sits beside the email-only inbox (/api/prospecting/inbox) and the
// calls inbox (/api/prospect-calls/inbox). It reuses their scope convention
// (req.subordinateIds, scope = mine|team|org) rather than the richer
// ReportingScopeService used by /sequences/drafts — so the Activity feed is
// consistent with its sibling inbox endpoints and with the `scope` prop that
// ProspectingInbox already passes.
//
// Mount in server.js (place BEFORE the '/api/prospecting/inbox' mount so the
// more specific path isn't shadowed — though Express matches exact prefixes,
// keeping activity adjacent to inbox is clearest):
//   app.use('/api/prospecting/activity', require('./routes/prospecting-activity.routes'));
// ─────────────────────────────────────────────────────────────────────────────

const express           = require('express');
const router            = express.Router();
const db                = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');
const requireModule     = require('../middleware/requireModule.middleware');

router.use(authenticateToken);
router.use(orgContext);
router.use(requireModule('prospecting'));

// ─────────────────────────────────────────────────────────────────────────────
// activity_type → channel / category classification.
//
// `category` is the coarse filter the UI exposes as chips:
//   email | linkedin | call | sequence | task | system
// `channel` is the literal communication channel where one applies
// (email | linkedin | call), else null.
//
// SYSTEM_TYPES are bookkeeping events (stage changes, enrichment, links,
// research, generated actions, draft-created). They are EXCLUDED from the
// default feed and only surface when ?includeSystem=true. This avoids the
// feed reading like an audit log and avoids double-counting email sends
// (which already come from the `emails` table, not `sequence_step_sent`).
// ─────────────────────────────────────────────────────────────────────────────

// SQL CASE expression mapping activity_type → category. Kept here as a string
// so the same classification drives both the SELECT and the WHERE/counts.
const CATEGORY_CASE = `
  CASE
    WHEN a.activity_type IN ('linkedin_event', 'linkedin_connection_sent') THEN 'linkedin'
    WHEN a.activity_type IN ('call_logged')                                THEN 'call'
    WHEN a.activity_type IN ('outreach_sent', 'response_received', 'email_received')
                                                                           THEN 'email'
    WHEN a.activity_type IN ('sequence_step_sent', 'sequence_step_completed',
                             'sequence_step_skipped', 'sequence_enrolled',
                             'enrollment_undone', 'sequence_draft_created',
                             'activation_completed')
                                                                           THEN 'sequence'
    ELSE 'system'
  END
`;

// Friendly labels per activity_type (UI may override; this is a sensible default).
const LABEL_CASE = `
  CASE a.activity_type
    WHEN 'linkedin_event'            THEN 'LinkedIn activity'
    WHEN 'linkedin_connection_sent'  THEN 'LinkedIn connection sent'
    WHEN 'call_logged'               THEN 'Call logged'
    WHEN 'outreach_sent'             THEN 'Outreach sent'
    WHEN 'response_received'         THEN 'Response received'
    WHEN 'email_received'            THEN 'Email received'
    WHEN 'sequence_step_sent'        THEN 'Sequence step sent'
    WHEN 'sequence_step_completed'   THEN 'Sequence step completed'
    WHEN 'sequence_step_skipped'     THEN 'Sequence step skipped'
    WHEN 'sequence_enrolled'         THEN 'Enrolled in sequence'
    WHEN 'enrollment_undone'         THEN 'Enrollment undone'
    WHEN 'sequence_draft_created'    THEN 'Draft created'
    WHEN 'activation_completed'      THEN 'Campaign activation'
    WHEN 'stage_change'              THEN 'Stage change'
    WHEN 'research_completed'        THEN 'Research completed'
    WHEN 'research_approved'         THEN 'Research approved'
    WHEN 'enrichment'                THEN 'Enrichment'
    WHEN 'account_linked'            THEN 'Account linked'
    WHEN 'contact_linked'            THEN 'Contact linked'
    WHEN 'actions_generated'         THEN 'Actions generated'
    WHEN 'ai_draft'                  THEN 'AI draft generated'
    WHEN 'converted'                 THEN 'Converted'
    ELSE a.activity_type
  END
`;

// Direction for activity rows. Inbound = the prospect did something toward us
// (replied / connection accepted shows in metadata, but as a coarse signal we
// treat response_received / email_received as inbound, everything else neutral).
const ACTIVITY_DIRECTION_CASE = `
  CASE
    WHEN a.activity_type IN ('response_received', 'email_received') THEN 'received'
    WHEN a.activity_type IN ('outreach_sent', 'sequence_step_sent',
                             'linkedin_connection_sent')           THEN 'sent'
    ELSE 'neutral'
  END
`;

// Valid coarse type filters the UI may pass.
const VALID_TYPES = ['all', 'email', 'linkedin', 'call', 'sequence', 'task', 'system'];

// ── GET / — the unified activity feed ────────────────────────────────────────
// Query params:
//   scope         = mine | team | org             (default: mine)
//   type          = all | email | linkedin | call | sequence | system (default: all)
//   direction     = all | sent | received | outbound | inbound        (default: all)
//   campaignId    = <int> | none                  (optional; 'none' = no campaign)
//   sequenceId    = <int>                          (optional)
//   from          = ISO date                       (optional)
//   to            = ISO date                       (optional)
//   includeSystem = true|false                     (default: false)
//   limit         = int (default 50, max 200)
//   offset        = int (default 0)
router.get('/', async (req, res) => {
  try {
    const {
      scope         = 'mine',
      type          = 'all',
      direction     = 'all',
      campaignId,
      sequenceId,
      from,
      to,
      includeSystem = 'false',
      limit         = 50,
      offset        = 0,
    } = req.query;

    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({ error: { message: `Invalid type. Use one of: ${VALID_TYPES.join(', ')}` } });
    }

    const wantSystem = includeSystem === 'true' || includeSystem === true || type === 'system';

    // ── Resolve scope → a user-id predicate fragment per branch ───────────────
    // We compute the predicate twice (emails alias `e`, activities alias `a`)
    // but they share the same param. Build the shared user-id value first.
    let scopeMode = 'mine';
    let scopeUserIds = null; // array for team, single id for mine, null for org
    if (scope === 'team' && req.subordinateIds?.length > 0) {
      scopeMode = 'team';
      scopeUserIds = [req.user.userId, ...req.subordinateIds];
    } else if (scope === 'org') {
      if (req.user.role !== 'admin' && req.user.role !== 'org_admin') {
        return res.status(403).json({ error: { message: 'Org scope requires admin access' } });
      }
      scopeMode = 'org';
    } else {
      scopeMode = 'mine';
      scopeUserIds = req.user.userId;
    }

    // ── Date bounds (shared) ──────────────────────────────────────────────────
    let fromDate = null, toDate = null;
    if (from) {
      const d = new Date(from);
      if (isNaN(d.getTime())) return res.status(400).json({ error: { message: 'Invalid "from" date' } });
      fromDate = d;
    }
    if (to) {
      const d = new Date(to);
      if (isNaN(d.getTime())) return res.status(400).json({ error: { message: 'Invalid "to" date' } });
      d.setHours(23, 59, 59, 999);
      toDate = d;
    }

    const campaignNone = campaignId === 'none';
    const campaignIdInt = (!campaignNone && campaignId != null && campaignId !== '')
      ? parseInt(campaignId, 10) : null;
    if (campaignId != null && campaignId !== '' && !campaignNone && isNaN(campaignIdInt)) {
      return res.status(400).json({ error: { message: 'Invalid campaignId' } });
    }
    const sequenceIdInt = (sequenceId != null && sequenceId !== '') ? parseInt(sequenceId, 10) : null;
    if (sequenceId != null && sequenceId !== '' && isNaN(sequenceIdInt)) {
      return res.status(400).json({ error: { message: 'Invalid sequenceId' } });
    }

    // Direction normalization to DB terms.
    let dirNorm = 'all';
    if (direction === 'sent' || direction === 'outbound')   dirNorm = 'sent';
    if (direction === 'received' || direction === 'inbound') dirNorm = 'received';

    // ─────────────────────────────────────────────────────────────────────────
    // Build params + the two UNION branches. We push params in a fixed order so
    // the placeholder numbers stay in sync across both branches.
    //
    // Param plan (1-indexed):
    //   $1  org_id  (used by both branches via their own org column)
    //   then scope param (array or int) if not org
    //   then from / to if present
    //   then campaign / sequence if present
    //   finally limit, offset (outer query)
    // ─────────────────────────────────────────────────────────────────────────
    const params = [req.orgId];

    // Scope predicate builders (return SQL fragment for a given user-id column).
    let scopeParamIndex = null;
    if (scopeMode === 'team' || scopeMode === 'mine') {
      params.push(scopeUserIds);
      scopeParamIndex = params.length;
    }
    const scopePredicate = (col) => {
      if (scopeMode === 'org') return '';
      if (scopeMode === 'team') return `AND ${col} = ANY($${scopeParamIndex}::int[])`;
      return `AND ${col} = $${scopeParamIndex}`;
    };

    // Date predicate builders (per timestamp column).
    let fromIdx = null, toIdx = null;
    if (fromDate) { params.push(fromDate); fromIdx = params.length; }
    if (toDate)   { params.push(toDate);   toIdx   = params.length; }
    const datePredicate = (col) => {
      let s = '';
      if (fromIdx) s += ` AND ${col} >= $${fromIdx}`;
      if (toIdx)   s += ` AND ${col} <= $${toIdx}`;
      return s;
    };

    // Campaign predicate (joins prospects p in each branch).
    let campaignIdx = null;
    if (campaignIdInt != null) { params.push(campaignIdInt); campaignIdx = params.length; }
    const campaignPredicate = () => {
      if (campaignNone) return ` AND p.campaign_id IS NULL`;
      if (campaignIdx)  return ` AND p.campaign_id = $${campaignIdx}`;
      return '';
    };

    // Sequence predicate. Emails don't carry a sequence id directly, so when a
    // sequenceId filter is active we restrict to prospects enrolled in that
    // sequence (a left-join-style EXISTS), applied to BOTH branches so we don't
    // silently drop activity rows. This keeps "show me everything for sequence
    // X" honest across channels.
    let sequenceIdx = null;
    if (sequenceIdInt != null) { params.push(sequenceIdInt); sequenceIdx = params.length; }
    const sequenceExists = () => {
      if (!sequenceIdx) return '';
      return ` AND EXISTS (
        SELECT 1 FROM sequence_enrollments se
        WHERE se.prospect_id = p.id
          AND se.org_id = $1
          AND se.sequence_id = $${sequenceIdx}
      )`;
    };

    // ── Branch 1: emails ──────────────────────────────────────────────────────
    // direction filter applies here (sent/received). When the coarse type
    // filter is set to a non-email category, this branch is dropped entirely.
    const emailDirectionFilter =
      dirNorm === 'sent'     ? `AND e.direction = 'sent'` :
      dirNorm === 'received' ? `AND e.direction = 'received'` : '';

    const emailBranch = `
      SELECT
        'email'                                   AS type,
        'email'                                   AS channel,
        'email'                                   AS category,
        CASE WHEN e.direction = 'received' THEN 'Email received' ELSE 'Email sent' END AS label,
        e.direction                               AS direction,
        p.id                                      AS prospect_id,
        p.first_name                              AS prospect_first_name,
        p.last_name                               AS prospect_last_name,
        p.company_name                            AS company,
        p.campaign_id                             AS campaign_id,
        e.user_id                                 AS actor_user_id,
        u.first_name                              AS actor_first_name,
        u.last_name                               AS actor_last_name,
        COALESCE(NULLIF(e.subject, ''), '(no subject)') AS summary,
        LEFT(regexp_replace(COALESCE(e.body, ''), '<[^>]+>', '', 'g'), 200) AS snippet,
        e.sent_at                                 AS occurred_at,
        e.id                                      AS ref_id,
        'emails'                                  AS ref_table,
        '{}'::jsonb                               AS metadata
      FROM emails e
      JOIN prospects p ON p.id = e.prospect_id
      JOIN users u     ON u.id = e.user_id
      WHERE e.org_id = $1
        AND e.prospect_id IS NOT NULL
        ${scopePredicate('e.user_id')}
        ${emailDirectionFilter}
        ${datePredicate('e.sent_at')}
        ${campaignPredicate()}
        ${sequenceExists()}
    `;

    // ── Branch 2: prospecting_activities ──────────────────────────────────────
    // Exclude system types unless requested. Apply direction filter by mapping
    // sent/received onto the activity-direction CASE.
    const activitySystemFilter = wantSystem ? '' : `AND (${CATEGORY_CASE}) <> 'system'`;
    const activityDirectionFilter =
      dirNorm === 'sent'     ? `AND (${ACTIVITY_DIRECTION_CASE}) = 'sent'` :
      dirNorm === 'received' ? `AND (${ACTIVITY_DIRECTION_CASE}) = 'received'` : '';

    const activityBranch = `
      SELECT
        a.activity_type                           AS type,
        CASE
          WHEN (${CATEGORY_CASE}) = 'linkedin' THEN 'linkedin'
          WHEN (${CATEGORY_CASE}) = 'call'     THEN 'call'
          WHEN (${CATEGORY_CASE}) = 'email'    THEN 'email'
          ELSE NULL
        END                                       AS channel,
        (${CATEGORY_CASE})                        AS category,
        (${LABEL_CASE})                           AS label,
        (${ACTIVITY_DIRECTION_CASE})              AS direction,
        p.id                                      AS prospect_id,
        p.first_name                              AS prospect_first_name,
        p.last_name                               AS prospect_last_name,
        p.company_name                            AS company,
        p.campaign_id                             AS campaign_id,
        a.user_id                                 AS actor_user_id,
        u.first_name                              AS actor_first_name,
        u.last_name                               AS actor_last_name,
        COALESCE(NULLIF(a.description, ''), (${LABEL_CASE})) AS summary,
        NULL                                      AS snippet,
        a.created_at                              AS occurred_at,
        a.id                                      AS ref_id,
        'prospecting_activities'                  AS ref_table,
        COALESCE(a.metadata, '{}'::jsonb)         AS metadata
      FROM prospecting_activities a
      JOIN prospects p     ON p.id = a.prospect_id
      LEFT JOIN users u    ON u.id = a.user_id
      WHERE a.org_id = $1
        ${scopePredicate('a.user_id')}
        ${activitySystemFilter}
        ${activityDirectionFilter}
        ${datePredicate('a.created_at')}
        ${campaignPredicate()}
        ${sequenceExists()}
    `;

    // ── Assemble the UNION, applying the coarse `type` (category) filter on the
    // outer wrapper so it applies uniformly. When type names an email-only or
    // activity-only category we still UNION both branches and let the outer
    // WHERE prune — simpler and correct, volume is low (dogfooding).
    const typeFilter =
      type === 'all'      ? '' :
      type === 'task'     ? `WHERE feed.category = 'task'` :   // reserved; no rows today
      type === 'system'   ? `WHERE feed.category = 'system'` :
      `WHERE feed.category = '${type}'`;                       // type is whitelisted above

    // Pagination params (outer).
    const effectiveLimit  = Math.min(parseInt(limit) || 50, 200);
    const effectiveOffset = parseInt(offset) || 0;
    params.push(effectiveLimit, effectiveOffset);
    const limitIdx  = params.length - 1;
    const offsetIdx = params.length;

    const feedQuery = `
      SELECT * FROM (
        ${emailBranch}
        UNION ALL
        ${activityBranch}
      ) feed
      ${typeFilter}
      ORDER BY feed.occurred_at DESC NULLS LAST
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;

    // ── Counts-by-category (for the filter chips + total). Same predicates,
    // no pagination, no coarse type filter (we want every category's count).
    // We reuse the same params minus the trailing limit/offset.
    const countParams = params.slice(0, params.length - 2);
    const countQuery = `
      SELECT feed.category, COUNT(*)::int AS n
      FROM (
        ${emailBranch}
        UNION ALL
        ${activityBranch}
      ) feed
      GROUP BY feed.category
    `;

    const [feedResult, countResult] = await Promise.all([
      db.query(feedQuery, params),
      db.query(countQuery, countParams),
    ]);

    const items = feedResult.rows.map(row => ({
      type:      row.type,
      channel:   row.channel,
      category:  row.category,
      label:     row.label,
      direction: row.direction,
      summary:   row.summary,
      snippet:   row.snippet || null,
      occurredAt: row.occurred_at,
      refId:     row.ref_id,
      refTable:  row.ref_table,
      metadata:  row.metadata || {},
      prospect: {
        id:          row.prospect_id,
        firstName:   row.prospect_first_name,
        lastName:    row.prospect_last_name,
        companyName: row.company,
        campaignId:  row.campaign_id,
      },
      actor: row.actor_user_id ? {
        userId:    row.actor_user_id,
        firstName: row.actor_first_name,
        lastName:  row.actor_last_name,
      } : null,
    }));

    // Build counts object. `all` is the sum of everything returned by the
    // count query (which already respects includeSystem via the branch filter).
    const counts = { all: 0, email: 0, linkedin: 0, call: 0, sequence: 0, task: 0, system: 0 };
    for (const r of countResult.rows) {
      if (counts[r.category] != null) counts[r.category] = r.n;
      counts.all += r.n;
    }

    res.json({
      items,
      counts,
      total:  counts.all,
      limit:  effectiveLimit,
      offset: effectiveOffset,
    });
  } catch (error) {
    console.error('Prospecting activity feed error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch activity feed' } });
  }
});

module.exports = router;
