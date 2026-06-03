const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');
const requireModule = require('../middleware/requireModule.middleware');
const ProspectContextBuilder  = require('../services/ProspectContextBuilder');
const PlaybookActionGenerator = require('../services/PlaybookActionGenerator');
const ActionWriter            = require('../services/ActionWriter');
const { resolveAccountId, normalizeLinkedInCompanyUrl } = require('../services/domainResolver');
const { enrichAccountForProspect } = require('../services/enrichmentService');

// Campaign ownership gate for /bulk-stage when called with a campaignId —
// prevents reps from moving prospects in another rep's campaign. See
// services/CampaignAccess.js for the rules.
const CampaignAccess = require('../services/CampaignAccess');
const { formatStampInZone } = require('../utils/repTimezone');


router.use(authenticateToken);
router.use(orgContext);
router.use(requireModule('prospecting'));

// ── Valid stage transitions ──────────────────────────────────────────────────
// const VALID_STAGES = ['target', 'researched', 'contacted', 'engaged', 'qualified', 'converted', 'disqualified', 'nurture'];

const VALID_STAGES = ['target', 'research', 'outreach', 'engaged', 'discovery_call', 'qualified_sal', 'disqualified', 'nurture'];

//const STAGE_TRANSITIONS = {
//  target:       ['researched', 'contacted', 'disqualified', 'nurture'],
//  researched:   ['contacted', 'disqualified', 'nurture'],
//  contacted:    ['engaged', 'qualified', 'disqualified', 'ss'],
//  engaged:      ['qualified', 'disqualified', 'nurture'],
//  qualified:    ['converted', 'disqualified', 'nurture'],
//  disqualified: ['target'],
//  nurture:      ['target', 'contacted'],
//};

const STAGE_TRANSITIONS = {
  target:        ['research', 'disqualified', 'nurture'],
  research:      ['outreach', 'disqualified', 'nurture'],
  outreach:      ['engaged', 'disqualified', 'nurture'],
  engaged:       ['discovery_call', 'disqualified', 'nurture'],
  discovery_call:['qualified_sal', 'disqualified', 'nurture'],
  qualified_sal: [],                 // terminal — no transitions out
  disqualified:  ['outreach'],       // re-engagement via outreach only
  nurture:       ['outreach'],       // re-entry to outreach only
};


// ── GET / — list prospects ───────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { scope = 'mine', stage, accountId, campaignId, companyDomain, search } = req.query;

    let query = `
      SELECT p.*,
             acc.name AS account_name,
             acc.domain AS account_domain,
             u.first_name AS owner_first_name,
             u.last_name  AS owner_last_name,
             /* Slice-6: data-readiness signal for preview/personalisation.
                A linkedin_profiles row keyed by the prospect's slug means the
                Chrome extension has captured their headline, about, experience,
                education, and activity — which the personalisation skill reads
                directly. Without this row, the skill produces generic output.
                NULL linkedin_url → false (we can't even capture them). */
             (
               p.linkedin_url IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM linkedin_profiles lp
                  WHERE lp.org_id       = p.org_id
                    AND lp.linkedin_slug = lower(substring(p.linkedin_url from '/in/([^/?#]+)'))
               )
             ) AS linkedin_profile_captured,
             /* Slice-6: research-readiness signal. The 'Approve research' flow
                writes a non-empty research_notes; the skill uses it as the
                lead-with-this hook. A campaign with prospects in 'target'
                whose research_notes is empty will personalise less well. */
             (p.research_notes IS NOT NULL AND TRIM(p.research_notes) <> '')
               AS has_research_notes
      FROM prospects p
      LEFT JOIN accounts acc ON p.account_id = acc.id
      LEFT JOIN users u ON p.owner_id = u.id
      WHERE p.org_id = $1 AND p.deleted_at IS NULL
    `;
    const params = [req.orgId];

    if (scope === 'team' && req.subordinateIds?.length > 0) {
      const teamIds = [req.user.userId, ...req.subordinateIds];
      query += ` AND p.owner_id = ANY($${params.length + 1}::int[])`;
      params.push(teamIds);
    } else if (scope === 'org') {
      // No owner filter
    } else {
      query += ` AND p.owner_id = $${params.length + 1}`;
      params.push(req.user.userId);
    }

    if (stage) {
      query += ` AND p.stage = $${params.length + 1}`;
      params.push(stage);
    }

    if (accountId) {
      query += ` AND p.account_id = $${params.length + 1}`;
      params.push(parseInt(accountId));
    }

    // Campaign filter — used by the Campaigns view's "View in Pipeline" action
    // and the campaign-scoped filter banner over the Pipeline/List/Account boards.
    if (campaignId) {
      query += ` AND p.campaign_id = $${params.length + 1}`;
      params.push(parseInt(campaignId));
    }

    if (companyDomain) {
      query += ` AND LOWER(p.company_domain) = LOWER($${params.length + 1})`;
      params.push(companyDomain);
    }

    if (search) {
      query += ` AND (
        LOWER(p.first_name || ' ' || p.last_name) LIKE $${params.length + 1}
        OR LOWER(p.email) LIKE $${params.length + 1}
        OR LOWER(p.company_name) LIKE $${params.length + 1}
      )`;
      params.push(`%${search.toLowerCase()}%`);
    }

    query += ' ORDER BY p.updated_at DESC';

    const result = await db.query(query, params);

    res.json({
      prospects: result.rows.map(row => ({
        ...row,
        account: row.account_id ? {
          id:     row.account_id,
          name:   row.account_name,
          domain: row.account_domain,
        } : null,
        owner: {
          first_name: row.owner_first_name,
          last_name:  row.owner_last_name,
        },
      })),
    });
  } catch (error) {
    console.error('Get prospects error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch prospects' } });
  }
});

// ── GET /pipeline/summary ────────────────────────────────────────────────────
router.get('/pipeline/summary', async (req, res) => {
  try {
    const { scope = 'mine' } = req.query;
    let ownerFilter = '';
    const params = [req.orgId];

    if (scope === 'team' && req.subordinateIds?.length > 0) {
      const teamIds = [req.user.userId, ...req.subordinateIds];
      ownerFilter = `AND owner_id = ANY($${params.length + 1}::int[])`;
      params.push(teamIds);
    } else if (scope === 'org') {
      ownerFilter = '';
    } else {
      ownerFilter = `AND owner_id = $${params.length + 1}`;
      params.push(req.user.userId);
    }

    const result = await db.query(
      `SELECT stage, COUNT(id) AS count
       FROM prospects
       WHERE org_id = $1 AND deleted_at IS NULL ${ownerFilter}
       GROUP BY stage

       ORDER BY CASE stage
         WHEN 'target' THEN 1 WHEN 'researched' THEN 2
         WHEN 'contacted' THEN 3 WHEN 'engaged' THEN 4
         WHEN 'qualified' THEN 5 WHEN 'converted' THEN 6
         WHEN 'disqualified' THEN 7 WHEN 'nurture' THEN 8
         ELSE 9 END`,
      params
    );

    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    weekStart.setHours(0, 0, 0, 0);

    let actionOwnerFilter = '';
    const actionParams = [req.orgId];
    if (scope === 'team' && req.subordinateIds?.length > 0) {
      const teamIds = [req.user.userId, ...req.subordinateIds];
      actionOwnerFilter = `AND user_id = ANY($${actionParams.length + 1}::int[])`;
      actionParams.push(teamIds);
    } else if (scope === 'org') {
      actionOwnerFilter = '';
    } else {
      actionOwnerFilter = `AND user_id = $${actionParams.length + 1}`;
      actionParams.push(req.user.userId);
    }
    actionParams.push(weekStart);

    // Outreach/WK — count sent emails directly (more reliable than action rows)
    // Responses/WK — count received emails (replies) this week
    let emailOwnerFilter = '';
    const emailParams = [req.orgId];
    if (scope === 'team' && req.subordinateIds?.length > 0) {
      const teamIds = [req.user.userId, ...req.subordinateIds];
      emailOwnerFilter = `AND e.user_id = ANY($${emailParams.length + 1}::int[])`;
      emailParams.push(teamIds);
    } else if (scope !== 'org') {
      emailOwnerFilter = `AND e.user_id = $${emailParams.length + 1}`;
      emailParams.push(req.user.userId);
    }
    emailParams.push(weekStart);

    const outreachResult = await db.query(
      `SELECT
         COUNT(CASE WHEN e.direction = 'sent' THEN 1 END)     AS outreach_this_week,
         COUNT(CASE WHEN e.direction IN ('received','inbound')
                     AND EXISTS (
                       SELECT 1 FROM emails out_e
                       WHERE out_e.org_id      = e.org_id
                         AND out_e.prospect_id = e.prospect_id
                         AND out_e.direction   = 'sent'
                         AND out_e.sent_at     < e.sent_at
                     )
                    THEN 1 END) AS responses_this_week
       FROM emails e
       WHERE e.org_id = $1
         AND e.prospect_id IS NOT NULL
         ${emailOwnerFilter}
         AND e.sent_at >= $${emailParams.length}`,
      emailParams
    );

    res.json({
      pipeline: result.rows.map(row => ({
        stage: row.stage,
        count: parseInt(row.count),
      })),
      metrics: {
        outreachThisWeek:  parseInt(outreachResult.rows[0]?.outreach_this_week || 0),
        responsesThisWeek: parseInt(outreachResult.rows[0]?.responses_this_week || 0),
      },
    });
  } catch (error) {
    console.error('Pipeline summary error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch pipeline summary' } });
  }
});

// ── POST /bulk — bulk import prospects from CSV ───────────────────────────────
// Body: {
//   prospects: [{ firstName, lastName, email, title, companyName, linkedinUrl, ... }],
//   source?: string,
//   campaignId?: int,
//   mode?: 'insert' | 'upsert' | 'update_by_id'   // default 'insert'
//   matchField?: 'linkedin_url'     // upsert match key (only linkedin_url supported)
// }
//
// mode='insert' (default, legacy behavior):
//   Insert-only. Rows whose email already exists are skipped.
//
// mode='upsert':
//   Match each row to an existing live prospect by LinkedIn URL slug
//   (org-scoped). On match → UPDATE the mapped fields in place (this is the
//   "re-import to fix bad data" path). On no match → INSERT as new.
//   Email is NOT used for matching here (it may be the very field being
//   corrected), and the email-duplicate skip is bypassed in this mode.
//
// mode='update_by_id':
//   Match each row to a live prospect by its exported `id` (the immutable
//   primary key). Verifies the row's read-only `do_not_edit_check` echo
//   against the live record before applying — a mismatch flags the row
//   (misaligned or changed-since-export) rather than updating blindly.
//   Updates only mapped, non-empty fields. Never inserts: an id with no
//   live match is an error, not a new prospect.
//
// Returns: { imported, updated, skipped, errors: [{ row, reason }] }
router.post('/bulk', async (req, res) => {
  try {
    const { prospects: rows, source = 'csv_import', campaignId = null,
            mode = 'insert', matchField = 'linkedin_url',
            moveExistingIds = [] } = req.body;
    const isUpsert     = mode === 'upsert';
    const isUpdateById = mode === 'update_by_id';
    // Ids the user explicitly chose (after preflight) to MOVE into this
    // campaign rather than skip as a duplicate. Only meaningful with a
    // campaignId target.
    const moveSet = new Set((Array.isArray(moveExistingIds) ? moveExistingIds : []).map(x => parseInt(x, 10)));
    let moved = 0;

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: { message: 'prospects array is required and must not be empty' } });
    }

    if (rows.length > 500) {
      return res.status(400).json({ error: { message: 'Maximum 500 prospects per import' } });
    }

    if (isUpsert && matchField !== 'linkedin_url') {
      return res.status(400).json({ error: { message: 'Only matchField="linkedin_url" is supported for upsert' } });
    }

    let imported = 0;
    let updated  = 0;
    let skipped  = 0;
    const errors = [];

    // Slug extractor — mirrors the by-linkedin-url lookup so matching is
    // robust to www/https/trailing-slash/query-param variance.
    const slugOf = (u) => {
      if (!u) return null;
      const m = String(u).match(/\/in\/([^/?#]+)/);
      return m ? m[1].toLowerCase() : null;
    };

    // Build the SET clause for an in-place UPDATE from a CSV row. Only
    // mapped, non-empty cells are written, so blank cells never clobber
    // existing data. Returns { sets, vals } with positional params starting
    // at $1. Shared by upsert and update_by_id.
    const buildFieldSet = (row) => {
      const sets = [];
      const vals = [];
      let n = 1;
      const setIf = (col, val) => {
        if (val !== undefined && val !== null && String(val).trim() !== '') {
          sets.push(`${col} = $${n++}`);
          vals.push(val);
        }
      };
      setIf('first_name',        row.firstName);
      setIf('last_name',         row.lastName);
      setIf('email',             row.email);
      setIf('phone',             row.phone);
      setIf('title',             row.title);
      setIf('location',          row.location);
      setIf('linkedin_url',      row.linkedinUrl);
      setIf('company_name',      row.companyName);
      setIf('company_industry',  row.companyIndustry);
      setIf('company_size',      row.companySize);
      setIf('preferred_channel', row.preferredChannel);
      return { sets, vals, nextIdx: n };
    };

    // Normalize an echo string for tolerant comparison (collapse whitespace,
    // lowercase). Must match the export's echo format:
    //   "First Last · Company"
    const normEcho = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

    // Resolve default prospecting playbook once for the whole import
    const defaultPbResult = await db.query(
      `SELECT id FROM playbooks
       WHERE org_id = $1 AND type = 'prospecting' AND is_default = TRUE
       LIMIT 1`,
      [req.orgId]
    );
    const defaultPlaybookId = defaultPbResult.rows[0]?.id || null;

    // If importing into a campaign, validate it belongs to this org once.
    // resolvedCampaignId is written onto every imported prospect.
    let resolvedCampaignId = null;
    if (campaignId) {
      const campRes = await db.query(
        `SELECT id FROM prospecting_campaigns WHERE id = $1 AND org_id = $2`,
        [campaignId, req.orgId]
      );
      if (!campRes.rows.length) {
        return res.status(400).json({ error: { message: 'Campaign not found in this org' } });
      }
      resolvedCampaignId = campRes.rows[0].id;
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 1;

      // ── Update-by-ID mode: match by exported primary key, verify echo ─────
      if (isUpdateById) {
        const id = parseInt(row.id, 10);
        if (!Number.isFinite(id)) {
          errors.push({ row: rowNum, reason: 'Missing or invalid id — required for update-by-ID' });
          skipped++;
          continue;
        }
        try {
          const match = await db.query(
            `SELECT id, first_name, last_name, company_name
               FROM prospects
              WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
            [id, req.orgId]
          );
          if (match.rows.length === 0) {
            errors.push({ row: rowNum, reason: `No live prospect with id ${id} in this org` });
            skipped++;
            continue;
          }

          // Echo verification — recompute the identity snapshot from the LIVE
          // record and compare to the row's read-only do_not_edit_check. A
          // mismatch means the row is misaligned or the record changed since
          // export; flag rather than update blindly.
          const liveEcho = `${match.rows[0].first_name || ''} ${match.rows[0].last_name || ''} · ${match.rows[0].company_name || ''}`;
          const rowEcho  = row.verifyCheck;
          if (rowEcho === undefined || rowEcho === null || String(rowEcho).trim() === '') {
            errors.push({ row: rowNum, reason: 'Missing do_not_edit_check value — cannot verify row' });
            skipped++;
            continue;
          }
          if (normEcho(rowEcho) !== normEcho(liveEcho)) {
            errors.push({ row: rowNum, reason: `Verification failed for id ${id} (row may be misaligned, or the record changed since export)` });
            skipped++;
            continue;
          }

          const { sets, vals, nextIdx } = buildFieldSet(row);
          if (sets.length === 0) {
            errors.push({ row: rowNum, reason: `id ${id} matched but no updatable fields provided` });
            skipped++;
            continue;
          }
          let n = nextIdx;
          sets.push('updated_at = CURRENT_TIMESTAMP');
          vals.push(id, req.orgId);
          await db.query(
            `UPDATE prospects SET ${sets.join(', ')}
              WHERE id = $${n++} AND org_id = $${n}`,
            vals
          );
          updated++;
          continue;
        } catch (idErr) {
          console.error(`Bulk update-by-id row ${rowNum} error:`, idErr.message);
          errors.push({ row: rowNum, reason: idErr.message });
          skipped++;
          continue;
        }
      }

      // ── Upsert mode: match by LinkedIn slug, UPDATE in place if found ──────
      if (isUpsert) {
        const slug = slugOf(row.linkedinUrl);
        if (!slug) {
          errors.push({ row: rowNum, reason: 'Upsert requires a LinkedIn URL to match on' });
          skipped++;
          continue;
        }
        try {
          const match = await db.query(
            `SELECT id FROM prospects
              WHERE org_id = $1
                AND LOWER(REGEXP_REPLACE(linkedin_url, '.*/in/([^/?#]+).*', '\\1')) = $2
                AND linkedin_url IS NOT NULL
                AND deleted_at IS NULL`,
            [req.orgId, slug]
          );

          if (match.rows.length === 0) {
            // No existing prospect → fall through to the INSERT path below by
            // NOT continuing. But insert needs first/last name.
            if (!row.firstName || !row.lastName) {
              errors.push({ row: rowNum, reason: `No match for LinkedIn "${slug}" and firstName/lastName missing to insert` });
              skipped++;
              continue;
            }
            // (falls through to shared INSERT block)
          } else if (match.rows.length > 1) {
            errors.push({ row: rowNum, reason: `Ambiguous: ${match.rows.length} live prospects share LinkedIn "${slug}" — skipped for safety` });
            skipped++;
            continue;
          } else {
            // Exactly one match → UPDATE only the fields the CSV actually
            // provided. Undefined/empty cells never overwrite existing data,
            // so a narrow "fix the email" CSV touches only email.
            const id = match.rows[0].id;
            const { sets, vals, nextIdx } = buildFieldSet(row);

            if (sets.length === 0) {
              errors.push({ row: rowNum, reason: 'Matched but no updatable fields provided' });
              skipped++;
              continue;
            }

            let n = nextIdx;
            sets.push('updated_at = CURRENT_TIMESTAMP');
            vals.push(id, req.orgId);
            await db.query(
              `UPDATE prospects SET ${sets.join(', ')}
                WHERE id = $${n++} AND org_id = $${n}`,
              vals
            );
            updated++;
            continue;
          }
        } catch (uErr) {
          console.error(`Bulk upsert row ${rowNum} match error:`, uErr.message);
          errors.push({ row: rowNum, reason: uErr.message });
          skipped++;
          continue;
        }
      }

      // Required fields (insert path)
      if (!row.firstName || !row.lastName) {
        errors.push({ row: rowNum, reason: 'firstName and lastName are required' });
        skipped++;
        continue;
      }

      try {
        // Duplicate check — skipped in upsert mode (matching already happened
        // by LinkedIn there, and email may be the field being corrected).
        if (!isUpsert) {
          // (a) LinkedIn slug: the strongest identity signal. If a live
          // prospect already shares this row's LinkedIn URL, it's the same
          // person — skip regardless of email. This is what prevents a
          // re-add / double-import from creating duplicate people when the
          // email is blank, changed, or wrong.
          const rowSlug = slugOf(row.linkedinUrl);
          if (rowSlug) {
            const dupLi = await db.query(
              `SELECT id, campaign_id FROM prospects
                WHERE org_id = $1
                  AND LOWER(REGEXP_REPLACE(linkedin_url, '.*/in/([^/?#]+).*', '\\1')) = $2
                  AND linkedin_url IS NOT NULL
                  AND deleted_at IS NULL`,
              [req.orgId, rowSlug]
            );
            if (dupLi.rows.length > 0) {
              const existingId = dupLi.rows[0].id;
              // If the user reviewed conflicts and chose to MOVE this existing
              // person into the target campaign, do that instead of skipping.
              if (campaignId != null && moveSet.has(existingId)) {
                await db.query(
                  `UPDATE prospects SET campaign_id = $1, updated_at = CURRENT_TIMESTAMP
                    WHERE id = $2 AND org_id = $3 AND deleted_at IS NULL`,
                  [parseInt(campaignId, 10), existingId, req.orgId]
                );
                moved++;
                continue;
              }
              errors.push({ row: rowNum, reason: `Already exists (LinkedIn: ${rowSlug}) — skipped` });
              skipped++;
              continue;
            }
          }

          // (b) Email fallback: catches dupes for rows that have no LinkedIn URL.
          if (row.email) {
            const dup = await db.query(
              `SELECT id FROM prospects
               WHERE org_id = $1 AND LOWER(email) = LOWER($2) AND deleted_at IS NULL`,
              [req.orgId, row.email]
            );
            if (dup.rows.length > 0) {
              errors.push({ row: rowNum, reason: `Duplicate email: ${row.email}` });
              skipped++;
              continue;
            }
          }
        }

        // Auto-match or create account, with domain normalization.
        // resolveAccountId handles:
        //   - normalizing the domain (rejects linkedin.com, personal hosts, junk)
        //   - falling back to email host if companyDomain is missing/junk
        //   - matching by domain, then by name
        //   - creating a catchall account when no real domain resolves
        //   - persisting / backfilling the LinkedIn company URL when provided
        const accountResolution = await resolveAccountId({
          client:              db,
          orgId:               req.orgId,
          ownerId:             req.user.userId,
          accountId:           null,                // CSV doesn't pass an account id
          companyName:         row.companyName,
          companyDomain:       row.companyDomain,
          companyIndustry:     row.companyIndustry,
          companySize:         row.companySize,
          companyLinkedInUrl:  normalizeLinkedInCompanyUrl(row.companyLinkedInUrl),
          email:               row.email,
        });
        const resolvedAccountId = accountResolution.accountId;

        // Whatever the writer sent for companyDomain, the resolver may have
        // normalized it (or rejected it). Mirror what's actually on the
        // resolved account back onto the prospect's company_domain column,
        // so they stay in sync. NULL when the resolver couldn't get an id.
        let prospectCompanyDomain = null;
        if (resolvedAccountId) {
          const accLookup = await db.query(
            `SELECT domain FROM accounts WHERE id = $1`,
            [resolvedAccountId]
          );
          prospectCompanyDomain = accLookup.rows[0]?.domain || null;
        }

        await db.query(
          `INSERT INTO prospects (
             org_id, owner_id, first_name, last_name, email, phone, linkedin_url,
             title, location, company_name, company_domain, company_size,
             company_industry, account_id, source, playbook_id, tags, campaign_id,
             stage, stage_changed_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7,
             $8, $9, $10, $11, $12,
             $13, $14, $15, $16, $17, $18,
             'target', CURRENT_TIMESTAMP
           )`,
          [
            req.orgId,
            req.user.userId,
            row.firstName,
            row.lastName,
            row.email            || null,
            row.phone            || null,
            row.linkedinUrl      || null,
            row.title            || null,
            row.location         || null,
            row.companyName      || null,
            prospectCompanyDomain,
            row.companySize      || null,
            row.companyIndustry  || null,
            resolvedAccountId,
            source,
            row.playbookId       || defaultPlaybookId,
            JSON.stringify(row.tags || []),
            resolvedCampaignId,
          ]
        );

        imported++;
      } catch (rowErr) {
        console.error(`Bulk import row ${rowNum} error:`, rowErr.message);
        errors.push({ row: rowNum, reason: rowErr.message });
        skipped++;
      }
    }

    // Log a single import activity
    if (imported > 0) {
      await db.query(
        `INSERT INTO prospecting_activities (org_id, prospect_id, user_id, activity_type, description, metadata)
         SELECT $4, id, $1, 'created', $2, $3
         FROM prospects
         WHERE org_id = $4 AND owner_id = $1 AND source = $5
           AND created_at >= NOW() - INTERVAL '10 seconds'
         LIMIT 1`,
        [
          req.user.userId,
          `Imported via ${source}`,
          JSON.stringify({ imported, skipped, source }),
          req.orgId,
          source,
        ]
      );
    }

    console.log(`📥 Bulk import (${mode}): ${imported} inserted, ${updated} updated, ${moved} moved, ${skipped} skipped (org ${req.orgId})`);

    const parts = [];
    if (imported) parts.push(`imported ${imported}`);
    if (updated)  parts.push(`updated ${updated}`);
    if (moved)    parts.push(`moved ${moved}`);
    if (skipped)  parts.push(`skipped ${skipped}`);
    res.status(201).json({
      imported,
      updated,
      moved,
      skipped,
      errors: errors.length > 0 ? errors : undefined,
      message: parts.length
        ? `Done — ${parts.join(', ')}.`
        : 'No rows processed.',
    });
  } catch (error) {
    console.error('Bulk import error:', error);
    res.status(500).json({ error: { message: 'Bulk import failed: ' + error.message } });
  }
});

// ── GET /duplicates — read-only report of prospects sharing a LinkedIn slug ───
// Groups live prospects by their normalized LinkedIn slug and returns every
// group with 2+ members, so duplicates can be reviewed before cleanup. Does
// NOT modify anything. Optional ?campaignId= to scope to one campaign.
// Must be defined BEFORE /:id routes.
router.get('/duplicates', async (req, res) => {
  try {
    const { campaignId } = req.query;
    const where = [
      'p.org_id = $1',
      'p.deleted_at IS NULL',
      'p.linkedin_url IS NOT NULL',
    ];
    const params = [req.orgId];
    let n = 2;
    if (campaignId) { where.push(`p.campaign_id = $${n++}`); params.push(parseInt(campaignId, 10)); }

    // slug = lowercased /in/<slug> capture, matching the bulk importer.
    const result = await db.query(
      `WITH norm AS (
         SELECT p.id, p.first_name, p.last_name, p.email, p.title,
                p.company_name, p.campaign_id, p.stage, p.source,
                p.linkedin_url, p.created_at, p.updated_at,
                LOWER(REGEXP_REPLACE(p.linkedin_url, '.*/in/([^/?#]+).*', '\\1')) AS slug,
                EXISTS (
                  SELECT 1 FROM sequence_enrollments se
                   WHERE se.prospect_id = p.id AND se.org_id = p.org_id
                     AND se.status = 'active'
                ) AS has_active_sequence
           FROM prospects p
          WHERE ${where.join(' AND ')}
       ),
       dup_slugs AS (
         SELECT slug FROM norm GROUP BY slug HAVING COUNT(*) > 1
       )
       SELECT n.* FROM norm n
        WHERE n.slug IN (SELECT slug FROM dup_slugs)
        ORDER BY n.slug, n.created_at ASC`,
      params
    );

    // Group rows by slug for an easy-to-render shape.
    const groups = {};
    for (const r of result.rows) {
      (groups[r.slug] = groups[r.slug] || []).push(r);
    }
    const duplicateGroups = Object.entries(groups).map(([slug, members]) => ({
      slug,
      count: members.length,
      members,
    }));

    res.json({
      duplicateGroups,
      groupCount: duplicateGroups.length,
      prospectCount: result.rows.length,
    });
  } catch (error) {
    console.error('Prospect duplicates report error:', error);
    res.status(500).json({ error: { message: 'Duplicates report failed' } });
  }
});

// ── POST /duplicates/resolve — collapse LinkedIn-slug duplicate groups ────────
// For each LinkedIn slug with 2+ live prospects, KEEP one and soft-delete the
// rest. Keep-rule (deterministic, in priority order):
//   1. has an active sequence enrollment   (don't orphan live outreach)
//   2. has a real email (contains '@')
//   3. oldest created_at                    (the original record)
//   4. lowest id                            (final tie-break)
//
// Body: { dryRun?: boolean (default true), campaignId?: int }
//   dryRun=true  → returns the plan (keep/delete ids per group), changes NOTHING.
//   dryRun=false → soft-deletes the losers (deleted_at=NOW()) and returns the
//                  same plan plus a deletedCount. Soft delete is reversible.
//
// Note: child rows (enrollments, step logs, activities, actions) are left on
// the deleted prospects; because the keep-rule prefers the enrolled record,
// the kept prospect retains active outreach. This does not merge field data —
// it removes redundant copies. Must be defined BEFORE /:id routes.
router.post('/duplicates/resolve', async (req, res) => {
  const { dryRun = true, campaignId = null } = req.body || {};
  const client = await (db.pool ? db.pool.connect() : db.connect());
  try {
    const where = [
      'p.org_id = $1',
      'p.deleted_at IS NULL',
      'p.linkedin_url IS NOT NULL',
    ];
    const params = [req.orgId];
    let n = 2;
    if (campaignId) { where.push(`p.campaign_id = $${n++}`); params.push(parseInt(campaignId, 10)); }

    const { rows } = await client.query(
      `SELECT p.id, p.first_name, p.last_name, p.email, p.created_at,
              LOWER(REGEXP_REPLACE(p.linkedin_url, '.*/in/([^/?#]+).*', '\\1')) AS slug,
              EXISTS (
                SELECT 1 FROM sequence_enrollments se
                 WHERE se.prospect_id = p.id AND se.org_id = p.org_id
                   AND se.status = 'active'
              ) AS has_active_sequence
         FROM prospects p
        WHERE ${where.join(' AND ')}`,
      params
    );

    // Group by slug; keep only groups with 2+ members.
    const groups = {};
    for (const r of rows) (groups[r.slug] = groups[r.slug] || []).push(r);

    const plan = [];
    const toDelete = [];
    for (const [slug, members] of Object.entries(groups)) {
      if (members.length < 2) continue;
      // Sort by keep-rule; index 0 is the keeper.
      const sorted = [...members].sort((a, b) => {
        if (a.has_active_sequence !== b.has_active_sequence) return a.has_active_sequence ? -1 : 1;
        const aEmail = a.email && a.email.includes('@');
        const bEmail = b.email && b.email.includes('@');
        if (aEmail !== bEmail) return aEmail ? -1 : 1;
        const at = new Date(a.created_at).getTime();
        const bt = new Date(b.created_at).getTime();
        if (at !== bt) return at - bt;
        return a.id - b.id;
      });
      const keep = sorted[0];
      const drop = sorted.slice(1);
      drop.forEach(d => toDelete.push(d.id));
      plan.push({
        slug,
        keep:   { id: keep.id, name: `${keep.first_name || ''} ${keep.last_name || ''}`.trim(), email: keep.email, has_active_sequence: keep.has_active_sequence },
        delete: drop.map(d => ({ id: d.id, name: `${d.first_name || ''} ${d.last_name || ''}`.trim(), email: d.email, has_active_sequence: d.has_active_sequence })),
      });
    }

    let deletedCount = 0;
    if (!dryRun && toDelete.length > 0) {
      // Extra guard: never delete a record that has an active sequence if its
      // keeper does NOT — the sort already prevents this, but assert it so a
      // future rule change can't silently orphan live outreach.
      const enrolledToDelete = plan.flatMap(g => g.delete.filter(d => d.has_active_sequence && !g.keep.has_active_sequence));
      if (enrolledToDelete.length > 0) {
        return res.status(409).json({ error: {
          message: 'Aborted: some records slated for deletion have active sequences while their keeper does not.',
          details: enrolledToDelete,
        } });
      }
      const del = await client.query(
        `UPDATE prospects SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = ANY($1::int[]) AND org_id = $2 AND deleted_at IS NULL`,
        [toDelete, req.orgId]
      );
      deletedCount = del.rowCount;
    }

    res.json({
      dryRun,
      groupCount: plan.length,
      wouldDeleteCount: toDelete.length,
      deletedCount,
      plan,
    });
  } catch (error) {
    console.error('Resolve duplicates error:', error);
    res.status(500).json({ error: { message: 'Resolve duplicates failed: ' + error.message } });
  } finally {
    client.release();
  }
});

// ── POST /duplicates/restore-campaign — backfill campaign tag from deleted twin
// After a dedup that kept the wrong copy w.r.t. campaign membership: for each
// LIVE prospect that shares a LinkedIn slug with a recently SOFT-DELETED
// prospect, copy campaign_id (and stage) from the deleted twin onto the live
// survivor where the survivor is missing it. Reversible-friendly (only writes
// campaign_id/stage; never un-deletes or deletes).
//
// Body: { dryRun?: boolean (default true), sinceMinutes?: int (default 120),
//         overwrite?: boolean (default false) }
//   overwrite=false → only fills when the live record's campaign_id IS NULL.
//   overwrite=true  → also overwrites a non-null live campaign_id when it
//                     differs from the deleted twin (use with care).
// Must be defined BEFORE /:id routes.
router.post('/duplicates/restore-campaign', async (req, res) => {
  const { dryRun = true, sinceMinutes = 120, overwrite = false } = req.body || {};
  const client = await (db.pool ? db.pool.connect() : db.connect());
  try {
    // Live survivors keyed by slug.
    const live = await client.query(
      `SELECT id, campaign_id, stage, first_name, last_name,
              LOWER(REGEXP_REPLACE(linkedin_url, '.*/in/([^/?#]+).*', '\\1')) AS slug
         FROM prospects
        WHERE org_id = $1 AND deleted_at IS NULL AND linkedin_url IS NOT NULL`,
      [req.orgId]
    );
    // Recently soft-deleted twins that HAD a campaign, keyed by slug. Newest
    // deletion wins if multiple.
    const dead = await client.query(
      `SELECT DISTINCT ON (slug) id, campaign_id, stage, slug FROM (
         SELECT id, campaign_id, stage, deleted_at,
                LOWER(REGEXP_REPLACE(linkedin_url, '.*/in/([^/?#]+).*', '\\1')) AS slug
           FROM prospects
          WHERE org_id = $1
            AND deleted_at IS NOT NULL
            AND deleted_at >= NOW() - ($2 || ' minutes')::interval
            AND linkedin_url IS NOT NULL
            AND campaign_id IS NOT NULL
       ) t
       ORDER BY slug, deleted_at DESC`,
      [req.orgId, String(parseInt(sinceMinutes, 10) || 120)]
    );

    const deadBySlug = {};
    for (const d of dead.rows) deadBySlug[d.slug] = d;

    const plan = [];
    const updates = []; // { id, campaign_id, stage }
    for (const l of live.rows) {
      const twin = deadBySlug[l.slug];
      if (!twin) continue;
      const needsCampaign = overwrite
        ? (l.campaign_id !== twin.campaign_id)
        : (l.campaign_id == null && twin.campaign_id != null);
      if (!needsCampaign) continue;
      // Bring stage along only if the survivor is at the default 'target' (i.e.
      // hasn't progressed on its own) and the twin had moved further.
      const newStage = (l.stage === 'target' && twin.stage && twin.stage !== 'target') ? twin.stage : l.stage;
      updates.push({ id: l.id, campaign_id: twin.campaign_id, stage: newStage });
      plan.push({
        slug: l.slug,
        name: `${l.first_name || ''} ${l.last_name || ''}`.trim(),
        liveId: l.id,
        fromCampaign: l.campaign_id,
        toCampaign: twin.campaign_id,
        stage: newStage,
      });
    }

    let updatedCount = 0;
    if (!dryRun && updates.length > 0) {
      await client.query('BEGIN');
      for (const u of updates) {
        const r = await client.query(
          `UPDATE prospects SET campaign_id = $1, stage = $2, updated_at = CURRENT_TIMESTAMP
            WHERE id = $3 AND org_id = $4 AND deleted_at IS NULL`,
          [u.campaign_id, u.stage, u.id, req.orgId]
        );
        updatedCount += r.rowCount;
      }
      await client.query('COMMIT');
    }

    res.json({ dryRun, matched: plan.length, updatedCount, plan });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('restore-campaign error:', error);
    res.status(500).json({ error: { message: 'restore-campaign failed: ' + error.message } });
  } finally {
    client.release();
  }
});

// ── GET /export.csv — export prospects as an editable CSV ─────────────────────
// Used by the "export → edit → re-import (update by ID)" round-trip. Emits a
// stable `id` (the immutable match key), a read-only `do_not_edit_check` echo
// column (used by the importer to detect row misalignment / stale records),
// then the full editable field set. Optional filters: ?campaignId= and ?ids=.
// Must be defined BEFORE /:id routes.
router.get('/export.csv', async (req, res) => {
  try {
    const { campaignId, ids } = req.query;

    const where = ['p.org_id = $1', 'p.deleted_at IS NULL'];
    const params = [req.orgId];
    let n = 2;
    if (campaignId) { where.push(`p.campaign_id = $${n++}`); params.push(parseInt(campaignId, 10)); }
    if (ids) {
      const idList = String(ids).split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);
      if (idList.length) { where.push(`p.id = ANY($${n++}::int[])`); params.push(idList); }
    }

    const result = await db.query(
      `SELECT p.id, p.first_name, p.last_name, p.email, p.phone, p.title,
              p.company_name, p.company_industry, p.company_size,
              p.linkedin_url, p.location, p.preferred_channel
         FROM prospects p
        WHERE ${where.join(' AND ')}
        ORDER BY p.id ASC`,
      params
    );

    // CSV cell escaper — quote when the value contains comma, quote, or newline.
    const esc = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    // Read-only echo: snapshot of identity at export time. The importer
    // recomputes this from the live record and compares, flagging any row
    // where it no longer matches.
    const echo = (r) => `${r.first_name || ''} ${r.last_name || ''} · ${r.company_name || ''}`.trim();

    // Header keys are chosen to auto-map cleanly on re-import.
    const headers = [
      'id', 'do_not_edit_check',
      'firstName', 'lastName', 'email', 'phone', 'title',
      'companyName', 'companyIndustry', 'companySize',
      'linkedinUrl', 'location', 'preferredChannel',
    ];
    const lines = [headers.join(',')];
    for (const r of result.rows) {
      lines.push([
        r.id, echo(r),
        r.first_name, r.last_name, r.email, r.phone, r.title,
        r.company_name, r.company_industry, r.company_size,
        r.linkedin_url, r.location, r.preferred_channel,
      ].map(esc).join(','));
    }
    // Prepend a UTF-8 BOM so Excel opens it with correct encoding.
    const csv = '\uFEFF' + lines.join('\r\n');

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="prospects-${stamp}.csv"`);
    res.send(csv);
  } catch (error) {
    console.error('Prospect export error:', error);
    res.status(500).json({ error: { message: 'Export failed' } });
  }
});

// ── GET /by-linkedin-url — look up prospect by LinkedIn profile URL ───────────
// Used by the Chrome extension. Must be defined BEFORE /:id routes.
// Query: ?url=https://www.linkedin.com/in/username
router.get('/by-linkedin-url', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) {
      return res.status(400).json({ error: { message: 'url query param is required' } });
    }

    // Extract the slug from both the incoming URL and stored URLs so matching
    // is robust regardless of: missing https://, www., trailing slashes,
    // extra path segments, or query params.
    // e.g. "https://www.linkedin.com/in/paulcrist/",
    //      "www.linkedin.com/in/paulcrist",
    //      "linkedin.com/in/paulcrist" all resolve to slug "paulcrist"
    const slugMatch = url.match(/\/in\/([^/?#]+)/);
    if (!slugMatch) {
      return res.status(400).json({ error: { message: 'Could not extract LinkedIn slug from url' } });
    }
    const slug = slugMatch[1].toLowerCase();

    const result = await db.query(
      `SELECT p.*,
              acc.name  AS account_name,
              u.first_name AS owner_first_name,
              u.last_name  AS owner_last_name,
              camp.name AS campaign_name,
              camp.status AS campaign_status
       FROM prospects p
       LEFT JOIN accounts acc ON p.account_id = acc.id
       LEFT JOIN users    u   ON p.owner_id   = u.id
       LEFT JOIN prospecting_campaigns camp
              ON camp.id = p.campaign_id AND camp.org_id = p.org_id
       WHERE p.org_id = $1
         AND LOWER(REGEXP_REPLACE(p.linkedin_url, '.*/in/([^/?#]+).*', '\\1')) = $2
         AND p.linkedin_url IS NOT NULL
         AND p.deleted_at IS NULL
       LIMIT 1`,
      [req.orgId, slug]
    );

    if (result.rows.length === 0) {
      return res.json({ prospect: null });
    }

    const row = result.rows[0];

    // ── Pending sequence drafts count (for extension badge) ──────────────────
    const draftsResult = await db.query(
      `SELECT COUNT(*) FROM sequence_step_logs
       WHERE prospect_id = $1 AND status = 'draft'`,
      [row.id]
    );
    const pendingDrafts = parseInt(draftsResult.rows[0].count);

    // ── Active sequence enrollments (for extension "Sequence ·" strip and the
    //    smart-suggest "already enrolled?" check). One row per active
    //    (sequence_id, prospect_id). Ordered newest-first so the strip's
    //    "first two by name" stays stable. ──────────────────────────────────
    const seqResult = await db.query(
      `SELECT s.id, s.name
         FROM sequence_enrollments se
         JOIN sequences s ON s.id = se.sequence_id
        WHERE se.prospect_id = $1
          AND se.org_id = $2
          AND se.status = 'active'
        ORDER BY se.enrolled_at DESC NULLS LAST, s.id DESC`,
      [row.id, req.orgId]
    );
    const activeSequences   = seqResult.rows.map(r => ({ id: r.id, name: r.name }));
    const activeSequenceIds = activeSequences.map(s => s.id);

    res.json({
      prospect: {
        ...row,
        account:       row.account_id ? { id: row.account_id, name: row.account_name } : null,
        owner:         { first_name: row.owner_first_name, last_name: row.owner_last_name },
        // Campaign as an { id, name } object — the extension reads
        // prospect.campaign.name for the "Campaign ·" strip and
        // prospect.campaign_id for the smart-suggest default match.
        campaign:      row.campaign_id ? { id: row.campaign_id, name: row.campaign_name, status: row.campaign_status } : null,
        // Active sequence enrollments — extension reads activeSequences (for
        // the names strip) and activeSequenceIds (for the default-match check).
        activeSequences,
        activeSequenceIds,
        pendingDrafts, // ← consumed by extension badge
      },
    });
  } catch (error) {
    console.error('LinkedIn URL lookup error:', error);
    res.status(500).json({ error: { message: 'Lookup failed' } });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT p.*,
              acc.name AS account_name, acc.domain AS account_domain,
              u.first_name AS owner_first_name, u.last_name AS owner_last_name,
              c.first_name AS linked_contact_first_name, c.last_name AS linked_contact_last_name
       FROM prospects p
       LEFT JOIN accounts acc ON p.account_id = acc.id
       LEFT JOIN users u ON p.owner_id = u.id
       LEFT JOIN contacts c ON p.contact_id = c.id
       WHERE p.id = $1 AND p.org_id = $2 AND p.deleted_at IS NULL`,
      [req.params.id, req.orgId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }

    const row = result.rows[0];

    const activities = await db.query(
      `SELECT * FROM prospecting_activities
       WHERE prospect_id = $1
       ORDER BY created_at DESC LIMIT 20`,
      [req.params.id]
    );

    const actions = await db.query(
      `SELECT * FROM prospecting_actions
       WHERE prospect_id = $1 AND org_id = $2
       ORDER BY
         CASE status WHEN 'pending' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'snoozed' THEN 3 ELSE 4 END,
         CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
         due_date ASC NULLS LAST`,
      [req.params.id, req.orgId]
    );

    res.json({
      prospect: {
        ...row,
        account: row.account_id ? { id: row.account_id, name: row.account_name, domain: row.account_domain } : null,
        owner:   { first_name: row.owner_first_name, last_name: row.owner_last_name },
        linkedContact: row.contact_id ? { id: row.contact_id, first_name: row.linked_contact_first_name, last_name: row.linked_contact_last_name } : null,
      },
      activities: activities.rows,
      actions:    actions.rows,
    });
  } catch (error) {
    console.error('Get prospect detail error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch prospect' } });
  }
});

// ── GET /:id/emails — email history for a prospect ───────────────────────────
router.get('/:id/emails', async (req, res) => {
  try {
    const check = await db.query(
      'SELECT id FROM prospects WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL',
      [req.params.id, req.orgId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }

    const result = await db.query(
      `SELECT
         e.id,
         e.direction,
         e.subject,
         e.body,
         e.to_address,
         e.from_address,
         e.sent_at,
         e.provider,
         u.first_name  AS sender_first_name,
         u.last_name   AS sender_last_name,
         psa.email     AS sender_account_email,
         psa.provider  AS sender_account_provider,
         psa.label     AS sender_account_label
       FROM emails e
       JOIN  users u   ON u.id   = e.user_id
       LEFT JOIN prospecting_sender_accounts psa ON psa.id = e.sender_account_id
       WHERE e.prospect_id = $1
         AND e.org_id      = $2
       ORDER BY e.sent_at DESC
       LIMIT 50`,
      [req.params.id, req.orgId]
    );

    res.json({
      emails: result.rows.map(row => ({
        id:          row.id,
        direction:   row.direction,
        subject:     row.subject,
        bodyPreview: (row.body || '').replace(/<[^>]+>/g, '').slice(0, 200),
        body:        row.body,
        toAddress:   row.to_address,
        fromAddress: row.from_address,
        sentAt:      row.sent_at,
        provider:    row.provider,
        sentBy: {
          firstName: row.sender_first_name,
          lastName:  row.sender_last_name,
        },
        senderAccount: row.sender_account_email ? {
          email:    row.sender_account_email,
          provider: row.sender_account_provider,
          label:    row.sender_account_label,
        } : null,
      })),
    });
  } catch (error) {
    console.error('Get prospect emails error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch prospect emails' } });
  }
});

// ── POST /:id/research — AI-powered prospect research ────────────────────────
router.post('/:id/research', async (req, res) => {
  try {
    const prospectResult = await db.query(
      `SELECT p.*,
              acc.name AS account_name, acc.industry AS account_industry
       FROM prospects p
       LEFT JOIN accounts acc ON p.account_id = acc.id
       WHERE p.id = $1 AND p.org_id = $2 AND p.deleted_at IS NULL`,
      [req.params.id, req.orgId]
    );

    if (prospectResult.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }

    const p = prospectResult.rows[0];

    const prospectInfo = [
      `Name: ${p.first_name} ${p.last_name}`,
      p.title            ? `Title: ${p.title}`                          : null,
      p.email            ? `Email: ${p.email}`                          : null,
      p.linkedin_url     ? `LinkedIn: ${p.linkedin_url}`                : null,
      p.company_name     ? `Company: ${p.company_name}`                 : null,
      p.company_domain   ? `Company domain: ${p.company_domain}`        : null,
      p.company_industry ? `Industry: ${p.company_industry}`            : null,
      p.company_size     ? `Company size: ${p.company_size}`            : null,
      p.location         ? `Location: ${p.location}`                    : null,
      p.account_name     ? `Account: ${p.account_name}`                 : null,
      p.account_industry ? `Account industry: ${p.account_industry}`    : null,
      p.tags?.length     ? `Tags: ${JSON.parse(p.tags || '[]').join(', ')}` : null,
    ].filter(Boolean).join('\n');

    const companyInfo = [
      p.company_name     ? `Company: ${p.company_name}`                 : null,
      p.company_domain   ? `Domain: ${p.company_domain}`                : null,
      p.company_industry ? `Industry: ${p.company_industry}`            : null,
      p.company_size     ? `Size: ${p.company_size}`                    : null,
      p.location         ? `HQ location: ${p.location}`                 : null,
      p.account_name     ? `Account name: ${p.account_name}`            : null,
    ].filter(Boolean).join('\n');

    const [userPrefRes, orgIntRes, userStage1Res, orgStage1Res, userStage2Res, orgStage2Res] = await Promise.all([
      db.query(
        `SELECT preferences FROM user_preferences WHERE user_id = $1 AND org_id = $2`,
        [req.user.userId, req.orgId]
      ),
      db.query(
        `SELECT config FROM org_integrations WHERE org_id = $1 AND integration_type = 'prospecting'`,
        [req.orgId]
      ),
      db.query(
        `SELECT template_data FROM user_prompts
         WHERE user_id = $1 AND org_id = $2 AND template_type = 'prospecting_research_account'`,
        [req.user.userId, req.orgId]
      ),
      db.query(
        `SELECT id, template FROM prompts
         WHERE org_id = $1 AND user_id IS NULL AND key = 'prospecting_research_account'`,
        [req.orgId]
      ),
      db.query(
        `SELECT template_data FROM user_prompts
         WHERE user_id = $1 AND org_id = $2 AND template_type = 'prospecting_research'`,
        [req.user.userId, req.orgId]
      ),
      db.query(
        `SELECT id, template FROM prompts
         WHERE org_id = $1 AND user_id IS NULL AND key = 'prospecting_research'`,
        [req.orgId]
      ),
    ]);

    const userPrefs  = userPrefRes.rows[0]?.preferences || {};
    const orgConfig  = orgIntRes.rows[0]?.config || {};
    const prospPrefs = userPrefs.prospecting || {};

    const productCtx = prospPrefs.product_context !== undefined
                         ? prospPrefs.product_context
                         : (orgConfig.product_context || '');

    const AI_PROMPTS = require('../config/aiPrompts');
    const TokenTrackingService = require('../services/TokenTrackingService');
    const AIClientResolver     = require('../services/ai/AIClientResolver');

    // Resolve provider/model once for this request — used by callAI below and
    // also stamped onto prospect/account records further down.
    const _resolved  = await AIClientResolver._resolveProviderAndModel(
      req.orgId, req.user.userId, 'prospecting_research'
    );
    const aiProvider = _resolved.provider;
    const aiModel    = _resolved.model;

    async function callAI(prompt, maxTokens = 800, callType = 'prospecting_research') {
      const { adapter, model, provider, keySource } =
        await AIClientResolver.resolve(req.orgId, req.user.userId, callType);

      const { text, usage } = await adapter.complete({
        model,
        prompt,
        maxTokens,
      });

      TokenTrackingService.log({
        orgId: req.orgId, userId: req.user.userId,
        callType, provider, keySource, model, usage,
      }).catch(() => {});

      return { text: text || '', usage };
    }

    let accountResearchText = '';
    let accountResearchJson = null;
    const CACHE_DAYS = 30;

    if (p.account_id) {
      const accountRes = await db.query(
        `SELECT research_notes, research_updated_at FROM accounts
         WHERE id = $1 AND org_id = $2`,
        [p.account_id, req.orgId]
      );
      const acct = accountRes.rows[0];
      const isStale = !acct?.research_updated_at ||
        (Date.now() - new Date(acct.research_updated_at).getTime()) > CACHE_DAYS * 24 * 60 * 60 * 1000;

      if (acct?.research_notes && !isStale) {
        accountResearchText = typeof acct.research_notes === 'string'
          ? acct.research_notes
          : JSON.stringify(acct.research_notes, null, 2);
        console.log(`📋 Using cached account research for account ${p.account_id}`);
      } else {
        console.log(`🔍 Running Stage 1 account research for ${p.company_name}...`);
        const stage1Template = userStage1Res.rows[0]?.template_data
          || orgStage1Res.rows[0]?.template
          || AI_PROMPTS.prospecting_research_account
          || '';

        if (stage1Template) {
          const stage1Prompt = stage1Template
            .replace('{{companyInfo}}',   companyInfo)
            .replace('{{productContext}}', productCtx || 'Not specified');

          const { text: stage1Raw } = await callAI(stage1Prompt, 1000, 'research_account');

          try {
            const cleaned = stage1Raw.replace(/\`\`\`json\n?/gi, '').replace(/\`\`\`\n?/g, '').trim();
            const start = cleaned.indexOf('{');
            const end   = cleaned.lastIndexOf('}');
            accountResearchJson = JSON.parse(cleaned.substring(start, end + 1));
            accountResearchText = JSON.stringify(accountResearchJson, null, 2);
          } catch {
            accountResearchText = stage1Raw;
          }

          const stage1PromptId     = orgStage1Res.rows[0]?.id     || null;
          const stage1PromptSource = userStage1Res.rows[0]
            ? 'user_override'
            : orgStage1Res.rows[0] ? 'org_default' : 'system_default';

          const accountMeta = {
            provider:            aiProvider,
            model:               aiModel,
            stage1_prompt_id:    stage1PromptId,
            stage1_prompt_key:   'prospecting_research_account',
            stage1_prompt_source: stage1PromptSource,
            generated_by_user_id: req.user.userId,
            generated_at:        new Date().toISOString(),
          };

          db.query(
            `UPDATE accounts
             SET research_notes       = $1,
                 research_updated_at  = CURRENT_TIMESTAMP,
                 research_meta        = $2::jsonb,
                 updated_at           = CURRENT_TIMESTAMP
             WHERE id = $3 AND org_id = $4`,
            [accountResearchText, JSON.stringify(accountMeta), p.account_id, req.orgId]
          ).catch(err => console.warn('Account research cache save failed:', err.message));
        }
      }
    }

    console.log(`🎯 Running Stage 2 person research for ${p.first_name} ${p.last_name}...`);
    const stage2Template = userStage2Res.rows[0]?.template_data
      || orgStage2Res.rows[0]?.template
      || AI_PROMPTS.prospecting_research
      || '';

    const stage2SystemDefault = `You are an expert B2B sales researcher. Based on the prospect and account info below, generate research bullets and a crisp pitch.

PERSON:
{{prospectInfo}}

ACCOUNT RESEARCH:
{{accountResearch}}

WHAT WE SELL:
{{productContext}}

Return ONLY valid JSON:
{
  "researchBullets": ["bullet 1", "bullet 2", "bullet 3", "bullet 4", "bullet 5"],
  "pitchAngle": "Single strongest angle for this person",
  "crispPitch": "3-5 sentence pitch written directly to them",
  "subjectLine": "Email subject line",
  "confidence": 0.8
}`;

    const stage2Prompt = (stage2Template || stage2SystemDefault)
      .replace('{{prospectInfo}}',   prospectInfo)
      .replace('{{accountResearch}}', accountResearchText || 'No account research available.')
      .replace('{{productContext}}',  productCtx || 'Not specified');

    const { text: stage2Raw } = await callAI(stage2Prompt, 900, 'research_person');

    let parsed = null;
    let researchNotes = '';
    try {
      const cleaned = stage2Raw.replace(/\`\`\`json\n?/gi, '').replace(/\`\`\`\n?/g, '').trim();
      const start = cleaned.indexOf('{');
      const end   = cleaned.lastIndexOf('}');
      parsed = JSON.parse(cleaned.substring(start, end + 1));

      const bullets = parsed.researchBullets || [];
      researchNotes = bullets.map(b => `• ${b}`).join('\n');
      if (parsed.pitchAngle)  researchNotes += `\n\n💡 Pitch angle: ${parsed.pitchAngle}`;
      if (parsed.crispPitch)  researchNotes += `\n\n✉️ Crisp pitch:\n${parsed.crispPitch}`;
      if (parsed.subjectLine) researchNotes += `\n\n📧 Subject: ${parsed.subjectLine}`;
    } catch {
      researchNotes = stage2Raw;
    }

    if (!researchNotes) {
      return res.status(500).json({ error: { message: 'Research generation returned empty response' } });
    }

    const stage2PromptId     = orgStage2Res.rows[0]?.id || null;
    const stage2PromptSource = userStage2Res.rows[0]
      ? 'user_override'
      : orgStage2Res.rows[0] ? 'org_default' : 'system_default';

    const prospectMeta = {
      provider:            aiProvider,
      model:               aiModel,
      stage2_prompt_id:    stage2PromptId,
      stage2_prompt_key:   'prospecting_research',
      stage2_prompt_source: stage2PromptSource,
      account_research_used: !!accountResearchText,
      account_research_cached: !!(p.account_id && accountResearchText),
      generated_by_user_id: req.user.userId,
      generated_at:        new Date().toISOString(),
      confidence:          parsed?.confidence || null,
    };

    await db.query(
      `UPDATE prospects
       SET research_notes = $1,
           research_meta  = $2::jsonb,
           updated_at     = CURRENT_TIMESTAMP
       WHERE id = $3 AND org_id = $4`,
      [researchNotes, JSON.stringify(prospectMeta), req.params.id, req.orgId]
    );

    let stageAdvanced = false;
    if (p.stage === 'target') {
      // Slice 2 fix: canonical stage value is 'research', not 'researched'.
      // The pre-Slice-2 migration backfills any legacy 'researched' rows.
      await db.query(
        `UPDATE prospects
         SET stage = 'research', stage_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND org_id = $2`,
        [req.params.id, req.orgId]
      );
      stageAdvanced = true;

      await db.query(
        `INSERT INTO prospecting_activities (org_id, prospect_id, user_id, activity_type, description)
         VALUES ($1, $2, $3, 'stage_change', 'Auto-advanced to research after AI research')`,
        [req.orgId, req.params.id, req.user.userId]
      );
    }

    await db.query(
      `INSERT INTO prospecting_activities (org_id, prospect_id, user_id, activity_type, description, metadata)
       VALUES ($1, $2, $3, 'research_completed', 'AI research notes generated', $4)`,
      [req.orgId, 
        req.params.id,
        req.user.userId,
        JSON.stringify({ stageAdvanced, model: aiModel, provider: aiProvider }),
      ]
    );

    res.json({
      researchNotes,
      stageAdvanced,
      newStage:           stageAdvanced ? 'research' : p.stage,
      researchBullets:    parsed?.researchBullets    || null,
      pitchAngle:         parsed?.pitchAngle         || null,
      crispPitch:         parsed?.crispPitch         || null,
      suggestedSubject:   parsed?.subjectLine        || null,
      confidence:         parsed?.confidence         || null,
      accountResearchCached: !!accountResearchText,
      accountResearch:    accountResearchJson,
      meta: {
        provider:      aiProvider,
        model:         aiModel,
        promptSources: {
          account: userStage1Res.rows[0] ? 'user_override' : orgStage1Res.rows[0] ? 'org_default' : 'system_default',
          person:  userStage2Res.rows[0] ? 'user_override' : orgStage2Res.rows[0] ? 'org_default' : 'system_default',
        },
      },
    });
  } catch (error) {
    console.error('Prospect research error:', error);
    if (error.message?.includes('API key')) {
      return res.status(500).json({ error: { message: 'AI research unavailable — ANTHROPIC_API_KEY not configured' } });
    }
    res.status(500).json({ error: { message: 'Research failed: ' + error.message } });
  }
});

// ── POST / — create prospect ─────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const {
      firstName, lastName, email, phone, linkedinUrl, title, linkedinHeadline, location,
      companyName, companyDomain, companySize, companyIndustry, companyLinkedInUrl,
      accountId, source, playbookId, tags,
    } = req.body;

    if (!firstName || !lastName) {
      return res.status(400).json({ error: { message: 'firstName and lastName are required' } });
    }

    if (email) {
      const emailDup = await db.query(
        `SELECT id, first_name, last_name FROM prospects
         WHERE org_id = $1 AND LOWER(email) = LOWER($2) AND deleted_at IS NULL`,
        [req.orgId, email]
      );
      if (emailDup.rows.length > 0) {
        const dup = emailDup.rows[0];
        return res.status(409).json({
          error: {
            message: `A prospect with email "${email}" already exists: ${dup.first_name} ${dup.last_name} (ID ${dup.id})`,
            code: 'DUPLICATE_EMAIL',
            existingProspectId: dup.id,
          },
        });
      }
    }

    // Always go through resolveAccountId. When the caller passes an explicit
    // accountId it short-circuits (status 'caller_provided') and backfills
    // linkedin_company_url on that account if the writer provided one and
    // the existing row was missing it.
    const accountResolution = await resolveAccountId({
      client:              db,
      orgId:               req.orgId,
      ownerId:             req.user.userId,
      accountId:           accountId || null,
      companyName:         companyName,
      companyDomain:       companyDomain,
      companyIndustry:     companyIndustry,
      companySize:         companySize,
      companyLinkedInUrl:  normalizeLinkedInCompanyUrl(companyLinkedInUrl),
      email:               email,
    });
    let resolvedAccountId = accountResolution.accountId;
    let prospectCompanyDomain = null;

    // Mirror the resolved account's domain onto the prospect row so the
    // two stay in sync (the resolver may have normalized or replaced what
    // the writer sent). When no account resolved (e.g. no companyName at
    // all), leave prospect.company_domain null too.
    if (resolvedAccountId) {
      const accLookup = await db.query(
        `SELECT domain FROM accounts WHERE id = $1`,
        [resolvedAccountId]
      );
      prospectCompanyDomain = accLookup.rows[0]?.domain || null;
    }

    // Resolve playbook — use explicit playbookId or fall back to org default
    let resolvedPlaybookId = playbookId || null;
    if (!resolvedPlaybookId) {
      const defaultPb = await db.query(
        `SELECT id FROM playbooks
         WHERE org_id = $1 AND type = 'prospecting' AND is_default = TRUE
         LIMIT 1`,
        [req.orgId]
      );
      resolvedPlaybookId = defaultPb.rows[0]?.id || null;
    }

    const result = await db.query(
      `INSERT INTO prospects (
         org_id, owner_id, first_name, last_name, email, phone, linkedin_url,
         title, linkedin_headline, location, company_name, company_domain, company_size,
         company_industry, account_id, source, playbook_id, tags,
         stage, stage_changed_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12, $13,
         $14, $15, $16, $17, $18,
         'target', CURRENT_TIMESTAMP
       ) RETURNING *`,
      [
        req.orgId, req.user.userId, firstName, lastName, email, phone, linkedinUrl,
        title, linkedinHeadline || null, location, companyName, prospectCompanyDomain, companySize,
        companyIndustry, resolvedAccountId, source || 'manual', resolvedPlaybookId,
        JSON.stringify(tags || []),
      ]
    );

    await db.query(
      `INSERT INTO prospecting_activities (org_id, prospect_id, user_id, activity_type, description)
       VALUES ($1, $2, $3, 'created', $4)`,
      [req.orgId, result.rows[0].id, req.user.userId, `Prospect created from ${source || 'manual'}`]
    );

    res.status(201).json({ prospect: result.rows[0] });
  } catch (error) {
    console.error('Create prospect error:', error);
    res.status(500).json({ error: { message: 'Failed to create prospect' } });
  }
});

// ── PUT /:id — update prospect ───────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const {
      firstName, lastName, email, phone, linkedinUrl, title, location,
      companyName, companyDomain, companySize, companyIndustry,
      accountId, playbookId, preferredChannel, researchNotes, tags, ownerId,
    } = req.body;

    const fields = [];
    const values = [];
    let idx = 1;

    const maybeSet = (col, val) => {
      if (val !== undefined) {
        fields.push(`${col} = $${idx++}`);
        values.push(val);
      }
    };

    maybeSet('first_name',        firstName);
    maybeSet('last_name',         lastName);
    maybeSet('email',             email);
    maybeSet('phone',             phone);
    maybeSet('linkedin_url',      linkedinUrl);
    maybeSet('title',             title);
    maybeSet('location',          location);
    maybeSet('company_name',      companyName);
    maybeSet('company_domain',    companyDomain);
    maybeSet('company_size',      companySize);
    maybeSet('company_industry',  companyIndustry);
    maybeSet('account_id',        accountId);
    maybeSet('playbook_id',       playbookId);
    maybeSet('preferred_channel', preferredChannel);
    maybeSet('research_notes',    researchNotes);
    maybeSet('owner_id',          ownerId);

    if (tags !== undefined) {
      fields.push(`tags = $${idx++}`);
      values.push(JSON.stringify(tags));
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: { message: 'No fields to update' } });
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(req.params.id, req.orgId);

    const result = await db.query(
      `UPDATE prospects SET ${fields.join(', ')}
       WHERE id = $${idx++} AND org_id = $${idx}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }

    res.json({ prospect: result.rows[0] });
  } catch (error) {
    console.error('Update prospect error:', error);
    res.status(500).json({ error: { message: 'Failed to update prospect' } });
  }
});

// Allowed codes for structured discard reasons. If a reason_code is provided
// on a disqualify transition it must be one of these; anything else is
// rejected with a 400. Keep this in sync with the frontend DISCARD_REASONS.
const VALID_DQ_REASON_CODES = [
  'account_not_fit',
  'contact_not_fit',
  'timing',
  'competitor',
  'no_budget',
  'duplicate',
  'other',
];

// ── POST /:id/stage — change prospect stage ──────────────────────────────────
router.post('/:id/stage', async (req, res) => {
  try {
    const { stage, reason, reasonCode } = req.body;

    if (!VALID_STAGES.includes(stage)) {
      return res.status(400).json({ error: { message: `Invalid stage: ${stage}` } });
    }

    // Validate reason_code when disqualifying. Optional for backward compat —
    // older clients may still send reason without a code.
    if (stage === 'disqualified' && reasonCode != null && !VALID_DQ_REASON_CODES.includes(reasonCode)) {
      return res.status(400).json({
        error: { message: `Invalid reasonCode: ${reasonCode}. Allowed: ${VALID_DQ_REASON_CODES.join(', ')}` }
      });
    }

    const current = await db.query(
      `SELECT id, stage FROM prospects WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
      [req.params.id, req.orgId]
    );

    if (current.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }

    const currentStage = current.rows[0].stage;
    const allowed = STAGE_TRANSITIONS[currentStage] || [];

    if (!allowed.includes(stage)) {
      return res.status(400).json({
        error: { message: `Cannot transition from "${currentStage}" to "${stage}". Allowed: ${allowed.join(', ')}` }
      });
    }

    // Persist the structured fit reason only. The free-text note is NOT stored
    // on the prospect row — it goes into the activity description below, in the
    // rep's timezone, so it's visible in the Activity feed. revisit_disposition
    // is deliberately left untouched here: scheduling a revisit is the job of
    // the full /:id/disqualify flow, not a lightweight discard.
    const result = await db.query(
      `UPDATE prospects
       SET stage = $1, stage_changed_at = CURRENT_TIMESTAMP,
           disqualified_reason_code = COALESCE($2, disqualified_reason_code),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 AND org_id = $4
       RETURNING *`,
      [
        stage,
        stage === 'disqualified' ? (reasonCode || null) : null,
        req.params.id, req.orgId,
      ]
    );

    // Build the activity description. For a disqualify, embed the rep's local
    // timestamp and the free-text note so it's readable in the feed (which
    // renders `description`, not `metadata`).
    let description = `Stage changed from ${currentStage} to ${stage}`;
    if (stage === 'disqualified') {
      const tzRes = await db.query(
        `SELECT timezone FROM users WHERE id = $1`,
        [req.user.userId]
      );
      const stamp = formatStampInZone(new Date(), tzRes.rows[0]?.timezone);
      const code  = reasonCode ? ` (${reasonCode})` : '';
      const note  = (reason && reason.trim()) ? `: ${reason.trim()}` : '';
      description = `Disqualified from ${currentStage}${code} — ${stamp}${note}`;
    }

    await db.query(
      `INSERT INTO prospecting_activities (org_id, prospect_id, user_id, activity_type, description, metadata)
       VALUES ($1, $2, $3, 'stage_change', $4, $5)`,
      [req.orgId, 
        req.params.id, req.user.userId,
        description,
        JSON.stringify({
          from:       currentStage,
          to:         stage,
          reason:     reason     || null,
          reasonCode: reasonCode || null,
        }),
      ]
    );

    res.json({ prospect: result.rows[0] });
  } catch (error) {
    console.error('Stage change error:', error);
    res.status(500).json({ error: { message: 'Failed to change stage' } });
  }
});

// ── POST /bulk-preflight — classify CSV rows before importing ─────────────────
// Read-only. Given the same rows you'd POST to /bulk (and the target
// campaignId), returns a per-row classification so the UI can show conflicts
// and let the user decide per-contact. Inserts nothing.
//
// Body: { prospects: [...], campaignId?: int }
// Returns: { rows: [{ index, slug, name, status, existingId?, currentCampaign?,
//                      activeSequences? }] }
//   status ∈ 'new' | 'in_this_campaign' | 'in_other_campaign' | 'no_match_email_dupe'
//   activeSequences: [{id,name}] present when the existing record is enrolled.
// Must be defined BEFORE /:id routes.
router.post('/bulk-preflight', async (req, res) => {
  try {
    const { prospects: rows, campaignId = null } = req.body || {};
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: { message: 'prospects array is required' } });
    }
    if (rows.length > 500) {
      return res.status(400).json({ error: { message: 'Maximum 500 rows' } });
    }

    const slugOf = (u) => {
      if (!u) return null;
      const m = String(u).match(/\/in\/([^/?#]+)/);
      return m ? m[1].toLowerCase() : null;
    };
    const targetCampaignId = campaignId != null ? parseInt(campaignId, 10) : null;

    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const name = `${row.firstName || ''} ${row.lastName || ''}`.trim();
      const slug = slugOf(row.linkedinUrl);

      // Resolve existing live prospect: by slug first, else by email.
      let existing = null;
      if (slug) {
        const r = await db.query(
          `SELECT p.id, p.campaign_id, c.name AS campaign_name
             FROM prospects p
             LEFT JOIN prospecting_campaigns c ON c.id = p.campaign_id AND c.org_id = p.org_id
            WHERE p.org_id = $1
              AND LOWER(REGEXP_REPLACE(p.linkedin_url, '.*/in/([^/?#]+).*', '\\1')) = $2
              AND p.linkedin_url IS NOT NULL AND p.deleted_at IS NULL
            LIMIT 1`,
          [req.orgId, slug]
        );
        if (r.rows.length) existing = r.rows[0];
      }
      if (!existing && row.email) {
        const r = await db.query(
          `SELECT p.id, p.campaign_id, c.name AS campaign_name
             FROM prospects p
             LEFT JOIN prospecting_campaigns c ON c.id = p.campaign_id AND c.org_id = p.org_id
            WHERE p.org_id = $1 AND LOWER(p.email) = LOWER($2) AND p.deleted_at IS NULL
            LIMIT 1`,
          [req.orgId, row.email]
        );
        if (r.rows.length) existing = r.rows[0];
      }

      if (!existing) {
        out.push({ index: i, slug, name, status: 'new' });
        continue;
      }

      // Active sequence enrollments for the existing record.
      const seqR = await db.query(
        `SELECT s.id, s.name
           FROM sequence_enrollments se
           JOIN sequences s ON s.id = se.sequence_id
          WHERE se.prospect_id = $1 AND se.org_id = $2 AND se.status = 'active'`,
        [existing.id, req.orgId]
      );
      const activeSequences = seqR.rows.map(r => ({ id: r.id, name: r.name }));

      let status;
      if (existing.campaign_id != null && targetCampaignId != null && existing.campaign_id === targetCampaignId) {
        status = 'in_this_campaign';
      } else if (existing.campaign_id != null) {
        status = 'in_other_campaign';
      } else {
        // Exists but unassigned (or email-dupe with no campaign).
        status = 'no_match_email_dupe';
      }

      out.push({
        index: i,
        slug,
        name,
        status,
        existingId: existing.id,
        currentCampaign: existing.campaign_id
          ? { id: existing.campaign_id, name: existing.campaign_name }
          : null,
        activeSequences,
      });
    }

    const summary = out.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
    res.json({ rows: out, summary });
  } catch (error) {
    console.error('bulk-preflight error:', error);
    res.status(500).json({ error: { message: 'Preflight failed: ' + error.message } });
  }
});

// ── POST /bulk-campaign — assign, move, or REMOVE prospects' campaign tag ─────
// Unlike /bulk-stage (stage only) and discard (disqualifies), this changes ONLY
// campaign membership without touching stage or marking anyone disqualified.
// Body: { prospectIds: int[], campaignId: int | null }
//   campaignId: null → remove from any campaign (untag)
//   campaignId: int  → assign/move to that campaign (validated as live in org)
router.post('/bulk-campaign', async (req, res) => {
  try {
    const { prospectIds, campaignId = null } = req.body || {};
    if (!Array.isArray(prospectIds) || prospectIds.length === 0) {
      return res.status(400).json({ error: { message: 'prospectIds array is required' } });
    }
    const ids = prospectIds.map(x => parseInt(x, 10)).filter(Number.isFinite);
    if (ids.length === 0) {
      return res.status(400).json({ error: { message: 'No valid prospectIds' } });
    }

    // If assigning to a campaign, verify it belongs to this org.
    if (campaignId != null) {
      const camp = await db.query(
        `SELECT id FROM prospecting_campaigns WHERE id = $1 AND org_id = $2`,
        [parseInt(campaignId, 10), req.orgId]
      );
      if (camp.rows.length === 0) {
        return res.status(404).json({ error: { message: `Campaign ${campaignId} not found in this org` } });
      }
    }

    const result = await db.query(
      `UPDATE prospects
          SET campaign_id = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ANY($2::int[]) AND org_id = $3 AND deleted_at IS NULL
        RETURNING id`,
      [campaignId != null ? parseInt(campaignId, 10) : null, ids, req.orgId]
    );

    res.json({
      updated: result.rowCount,
      campaignId: campaignId != null ? parseInt(campaignId, 10) : null,
      message: campaignId == null
        ? `Removed ${result.rowCount} prospect(s) from their campaign.`
        : `Moved ${result.rowCount} prospect(s) to campaign ${campaignId}.`,
    });
  } catch (error) {
    console.error('bulk-campaign error:', error);
    res.status(500).json({ error: { message: 'Failed to update campaign: ' + error.message } });
  }
});

// ── POST /bulk-stage — change stage for many prospects at once ───────────────
//
// Body: { fromStage, toStage, campaignId?, prospectIds? }
//
// Two selection modes (one required):
//   - campaignId + fromStage  → all prospects in that campaign on fromStage
//   - prospectIds[]           → explicit list (still gated by fromStage)
//
// Validates that fromStage → toStage is in STAGE_TRANSITIONS. Org-scoped.
// Skips prospects not currently on fromStage (so the operation is idempotent
// and safe to re-run). Returns { moved, skipped, fromStage, toStage }.
//
// Designed for cases like "I imported 400 CSV prospects (all stage='target')
// and want to skip the research step for templated outreach" — call once
// with fromStage='target', toStage='research', campaignId=N.
router.post('/bulk-stage', async (req, res) => {
  try {
    const { fromStage, toStage, campaignId, prospectIds } = req.body || {};

    if (!VALID_STAGES.includes(fromStage)) {
      return res.status(400).json({ error: { message: `Invalid fromStage: ${fromStage}` } });
    }
    if (!VALID_STAGES.includes(toStage)) {
      return res.status(400).json({ error: { message: `Invalid toStage: ${toStage}` } });
    }
    const allowed = STAGE_TRANSITIONS[fromStage] || [];
    if (!allowed.includes(toStage)) {
      return res.status(400).json({ error: {
        message: `Cannot bulk-transition from "${fromStage}" to "${toStage}". Allowed: ${allowed.join(', ') || '(none)'}`,
      } });
    }

    // Need at least one selector
    const hasCampaign     = campaignId != null && Number.isFinite(parseInt(campaignId, 10));
    const idsArray        = Array.isArray(prospectIds) ? prospectIds.filter(Number.isFinite) : null;
    const hasProspectList = idsArray && idsArray.length > 0;

    if (!hasCampaign && !hasProspectList) {
      return res.status(400).json({ error: {
        message: 'Provide either campaignId or prospectIds[] to select prospects.',
      } });
    }

    // ── Campaign ownership gate ─────────────────────────────────────────────
    // When the caller scopes the bulk-move by campaignId, the operation is
    // semantically "advance the stage on someone's campaign queue". That's a
    // campaign mutation — so it must respect the same owner/admin rules as
    // POST /prospecting-campaigns/:id/bulk-activate and the rest of the
    // campaign mutation surface.
    //
    // Without this gate the operation would silently filter to 0 rows for
    // non-owners (their org_id matches but the prospects they don't own
    // don't appear in the campaign), but the user would have no idea why.
    // We chose explicit 403 with a clear message over silent zero-row
    // success — the user always has visibility into why an action failed.
    if (hasCampaign) {
      const campId = parseInt(campaignId, 10);
      const cRes = await db.query(
        `SELECT id, owner_id FROM prospecting_campaigns
          WHERE id = $1 AND org_id = $2`,
        [campId, req.orgId]
      );
      if (!cRes.rows.length) {
        return res.status(404).json({ error: { message: 'Campaign not found' } });
      }
      if (!(await CampaignAccess.requireCanMutate(req, res, cRes.rows[0]))) return;
    }

    // Build the UPDATE. The WHERE filters silently drop any prospect not on
    // fromStage, making this safe to re-run on a mixed-stage set.
    let query = `UPDATE prospects
                    SET stage             = $1,
                        stage_changed_at  = CURRENT_TIMESTAMP,
                        updated_at        = CURRENT_TIMESTAMP
                  WHERE org_id     = $2
                    AND stage      = $3
                    AND deleted_at IS NULL`;
    const params = [toStage, req.orgId, fromStage];

    if (hasCampaign) {
      params.push(parseInt(campaignId, 10));
      query += ` AND campaign_id = $${params.length}`;
    }
    if (hasProspectList) {
      params.push(idsArray);
      query += ` AND id = ANY($${params.length}::int[])`;
    }

    query += ` RETURNING id`;
    const result = await db.query(query, params);

    // For "skipped" count: if the caller gave explicit IDs, the gap between
    // requested and moved is the skipped count (already on toStage, or
    // illegal transition row-wise). For campaign-scoped, "skipped" isn't
    // meaningful in the same way, so we report 0.
    const moved = result.rowCount;
    const skipped = hasProspectList ? Math.max(0, idsArray.length - moved) : 0;

    res.json({
      moved,
      skipped,
      fromStage,
      toStage,
      campaignId: hasCampaign ? parseInt(campaignId, 10) : null,
    });
  } catch (error) {
    console.error('Bulk stage change error:', error);
    res.status(500).json({ error: { message: 'Failed to bulk-change stage' } });
  }
});

// ── POST /:id/disqualify ──────────────────────────────────────────────────────
router.post('/:id/disqualify', async (req, res) => {
  const client = await require('../config/database').pool.connect();
  try {
    const {
      reason,
      accountDisposition,
      revisitDate,
      accountRevisitDate,
    } = req.body;

    const VALID_REASONS = ['kill', 'long_term', 'unable_to_decide'];
    if (!reason || !VALID_REASONS.includes(reason)) {
      return res.status(400).json({
        error: {
          message: `reason is required and must be one of: ${VALID_REASONS.join(', ')}`,
        },
      });
    }

    const VALID_DISPOSITIONS = ['kill_account', 'long_term_account', 'unable_to_decide_account'];
    if (accountDisposition && !VALID_DISPOSITIONS.includes(accountDisposition)) {
      return res.status(400).json({
        error: {
          message: `accountDisposition must be one of: ${VALID_DISPOSITIONS.join(', ')}`,
        },
      });
    }

    const current = await client.query(
      `SELECT id, stage, account_id, owner_id
       FROM prospects
       WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
      [req.params.id, req.orgId]
    );

    if (current.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }

    const prospect     = current.rows[0];
    const currentStage = prospect.stage;

    const allowed = STAGE_TRANSITIONS[currentStage] || [];
    if (currentStage !== 'disqualified' && !allowed.includes('disqualified')) {
      return res.status(400).json({
        error: {
          message: `Cannot disqualify a prospect in stage "${currentStage}"`,
        },
      });
    }

    let computedRevisitDate = revisitDate || null;
    if (!computedRevisitDate) {
      const today = new Date();
      if (reason === 'long_term') {
        today.setDate(today.getDate() + 90);
        computedRevisitDate = today.toISOString().split('T')[0];
      } else if (reason === 'unable_to_decide') {
        today.setDate(today.getDate() + 45);
        computedRevisitDate = today.toISOString().split('T')[0];
      }
    }

    await client.query('BEGIN');

    const prospectResult = await client.query(
      `UPDATE prospects
       SET stage               = 'disqualified',
           stage_changed_at    = CURRENT_TIMESTAMP,
           revisit_disposition = $1,
           revisit_date        = $2,
           updated_at          = CURRENT_TIMESTAMP
       WHERE id = $3 AND org_id = $4
       RETURNING *`,
      [reason, computedRevisitDate, req.params.id, req.orgId]
    );

    let updatedAccount = null;
    if (accountDisposition && prospect.account_id) {
      const computedAccountRevisitDate = accountRevisitDate || (
        accountDisposition === 'long_term_account'
          ? (() => { const d = new Date(); d.setDate(d.getDate() + 90); return d.toISOString().split('T')[0]; })()
          : accountDisposition === 'unable_to_decide_account'
          ? (() => { const d = new Date(); d.setDate(d.getDate() + 45); return d.toISOString().split('T')[0]; })()
          : null
      );

      const accResult = await client.query(
        `UPDATE accounts
         SET account_disposition  = $1,
             account_revisit_date = $2,
             updated_at           = CURRENT_TIMESTAMP
         WHERE id = $3 AND org_id = $4
         RETURNING id, name, account_disposition, account_revisit_date`,
        [accountDisposition, computedAccountRevisitDate, prospect.account_id, req.orgId]
      );
      updatedAccount = accResult.rows[0] || null;
    }

    const tzRes = await client.query(
      `SELECT timezone FROM users WHERE id = $1`,
      [req.user.userId]
    );
    const stamp = formatStampInZone(new Date(), tzRes.rows[0]?.timezone);

    await client.query(
      `INSERT INTO prospecting_activities
         (org_id, prospect_id, user_id, activity_type, description, metadata)
       VALUES ($1, $2, $3, 'stage_change', $4, $5)`,
      [req.orgId, 
        req.params.id,
        req.user.userId,
        `Disqualified from ${currentStage} — disposition: ${reason} — ${stamp}`,
        JSON.stringify({
          from:               currentStage,
          to:                 'disqualified',
          reason,
          revisitDate:        computedRevisitDate,
          accountDisposition: accountDisposition || null,
          accountRevisitDate: accountRevisitDate || null,
        }),
      ]
    );

    await client.query('COMMIT');

    console.log(`🚫 Prospect #${req.params.id} disqualified (reason: ${reason}, revisit: ${computedRevisitDate || 'none'}) by user ${req.user.userId} (org ${req.orgId})`);

    res.json({
      prospect:    prospectResult.rows[0],
      account:     updatedAccount,
      revisitDate: computedRevisitDate,
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Disqualify prospect error:', error);
    res.status(500).json({ error: { message: 'Failed to disqualify prospect' } });
  } finally {
    client.release();
  }
});

// ── POST /:id/nurture ─────────────────────────────────────────────────────────
router.post('/:id/nurture', async (req, res) => {
  try {
    const { revisit_date, reason } = req.body;

    const current = await db.query(
      `SELECT id, stage FROM prospects WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
      [req.params.id, req.orgId]
    );

    if (current.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }

    const result = await db.query(
      `UPDATE prospects
       SET stage = 'nurture', stage_changed_at = CURRENT_TIMESTAMP,
           revisit_date = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND org_id = $3
       RETURNING *`,
      [revisit_date || null, req.params.id, req.orgId]
    );

    await db.query(
      `INSERT INTO prospecting_activities (org_id, prospect_id, user_id, activity_type, description, metadata)
       VALUES ($1, $2, $3, 'stage_change', $4, $5)`,
      [req.orgId, 
        req.params.id, req.user.userId,
        `Moved to nurture from ${current.rows[0].stage}`,
        JSON.stringify({ from: current.rows[0].stage, to: 'nurture', revisit_date, reason }),
      ]
    );

    res.json({ prospect: result.rows[0] });
  } catch (error) {
    console.error('Nurture error:', error);
    res.status(500).json({ error: { message: 'Failed to move to nurture' } });
  }
});

// ── POST /:id/convert — convert prospect to contact + deal ───────────────────
router.post('/:id/convert', async (req, res) => {
  const client = await (db.pool ? db.pool.connect() : db.connect());
  try {
    const { dealName, dealValue, dealStage, createDeal = true } = req.body;

    const prospect = await client.query(
      `SELECT * FROM prospects WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
      [req.params.id, req.orgId]
    );

    if (prospect.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }

    const p = prospect.rows[0];

    if (p.stage === 'converted') {
      return res.status(400).json({ error: { message: 'Prospect is already converted' } });
    }

    await client.query('BEGIN');

    let accountId = p.account_id;
    if (!accountId && p.company_name) {
      if (p.company_domain) {
        const accMatch = await client.query(
          `SELECT id FROM accounts WHERE org_id = $1 AND LOWER(domain) = LOWER($2) LIMIT 1`,
          [req.orgId, p.company_domain]
        );
        if (accMatch.rows.length > 0) {
          accountId = accMatch.rows[0].id;
        }
      }
      if (!accountId) {
        const newAcc = await client.query(
          `INSERT INTO accounts (org_id, owner_id, name, domain, industry, size)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [req.orgId, req.user.userId, p.company_name, p.company_domain, p.company_industry, p.company_size]
        );
        accountId = newAcc.rows[0].id;
      }
    }

    let contactId = p.contact_id;
    if (!contactId) {
      if (p.email) {
        const cMatch = await client.query(
          `SELECT id FROM contacts WHERE org_id = $1 AND LOWER(email) = LOWER($2) AND deleted_at IS NULL LIMIT 1`,
          [req.orgId, p.email]
        );
        if (cMatch.rows.length > 0) {
          contactId = cMatch.rows[0].id;
          await client.query(
            `UPDATE contacts SET
               converted_from_prospect_id = $1,
               account_id = COALESCE(account_id, $2),
               phone = COALESCE(phone, $3),
               title = COALESCE(title, $4),
               linkedin_url = COALESCE(linkedin_url, $5),
               location = COALESCE(location, $6),
               updated_at = CURRENT_TIMESTAMP
             WHERE id = $7`,
            [p.id, accountId, p.phone, p.title, p.linkedin_url, p.location, contactId]
          );
        }
      }

      if (!contactId) {
        const newContact = await client.query(
          `INSERT INTO contacts (
             org_id, account_id, first_name, last_name, email, phone,
             title, location, linkedin_url, converted_from_prospect_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id`,
          [
            req.orgId, accountId, p.first_name, p.last_name, p.email, p.phone,
            p.title, p.location, p.linkedin_url, p.id,
          ]
        );
        contactId = newContact.rows[0].id;
      }
    }

    let dealId = null;
    if (createDeal) {
      let stageKey = dealStage;
      if (!stageKey) {
        const stageRes = await client.query(
          `SELECT key FROM pipeline_stages
           WHERE org_id = $1 AND pipeline = 'sales' AND is_active = TRUE AND is_terminal = FALSE
           ORDER BY sort_order ASC LIMIT 1`,
          [req.orgId]
        );
        stageKey = stageRes.rows[0]?.key || 'qualified';
      }

      const newDeal = await client.query(
        `INSERT INTO deals (org_id, owner_id, account_id, name, value, stage)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          req.orgId, req.user.userId, accountId,
          dealName || `${p.company_name || p.first_name + ' ' + p.last_name} — New Deal`,
          dealValue || 0, stageKey,
        ]
      );
      dealId = newDeal.rows[0].id;

      await client.query(
        `INSERT INTO deal_contacts (deal_id, contact_id, role) VALUES ($1, $2, 'primary') ON CONFLICT DO NOTHING`,
        [dealId, contactId]
      );
    }

    await client.query(
      `UPDATE prospects
       SET stage = 'converted', stage_changed_at = CURRENT_TIMESTAMP,
           contact_id = $1, deal_id = $2, account_id = COALESCE(account_id, $3),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4`,
      [contactId, dealId, accountId, p.id]
    );

    await client.query(
      `INSERT INTO prospecting_activities (org_id, prospect_id, user_id, activity_type, description, metadata)
       VALUES ($1, $2, $3, 'converted', $4, $5)`,
      [req.orgId, 
        p.id, req.user.userId,
        `Converted to contact${dealId ? ' + deal' : ''}`,
        JSON.stringify({ contactId, dealId, accountId }),
      ]
    );

    await client.query('COMMIT');

    console.log(`🎯 Prospect #${p.id} converted → contact #${contactId}${dealId ? ` + deal #${dealId}` : ''} (org ${req.orgId})`);

    res.json({ success: true, contactId, dealId, accountId });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Convert prospect error:', error);
    res.status(500).json({ error: { message: 'Failed to convert prospect' } });
  } finally {
    client.release();
  }
});

// ── POST /:id/enrich-from-coresignal — enrich the prospect's account ──────────
//
// Called by the extension (and eventually by an in-product UI button) to
// fill in firmographics for the prospect's account. Reads either the
// account's linkedin_company_url or its (real) domain, calls the
// configured enrichment provider (CoreSignal by default), and applies
// the result to the account row.
//
// Apply rules are documented in services/enrichmentService.js — short
// version: never overwrites existing real values, only fills blanks.
//
// Response shape (200 on success, 422 on provider failure that wasn't
// our fault, 404 on prospect/account not found):
//   { ok: true,  accountId, status, enriched: { ... }, provider }
//   { ok: false, accountId?, reason, provider? }
router.post('/:id/enrich-from-coresignal', async (req, res) => {
  try {
    const prospectId = parseInt(req.params.id, 10);
    if (!Number.isInteger(prospectId)) {
      return res.status(400).json({ error: { message: 'invalid prospect id' } });
    }

    const result = await enrichAccountForProspect({
      prospectId,
      orgId: req.orgId,
    });

    if (!result.ok) {
      // Distinguish "we couldn't find the inputs" (4xx) from "provider
      // gave up" (also 4xx but for a different reason). Both are caller-
      // visible, but the status code helps the extension surface the
      // right message.
      const userVisible404 = ['prospect_not_found', 'account_not_found'];
      const userVisible422 = [
        'prospect_has_no_account', 'no_identifier_on_account',
        'not_found', 'ambiguous',
        'no_credits', 'auth_failed', 'rate_limited',
        'timeout', 'network_error', 'invalid_response',
        'http_error', 'no_api_key', 'no_identifier',
        'unknown_provider',
      ];
      const code = userVisible404.includes(result.reason) ? 404
                 : userVisible422.includes(result.reason) ? 422
                 : 500;
      return res.status(code).json({
        ok: false,
        reason:          result.reason,
        accountId:       result.accountId,
        provider:        result.provider,
        upstream_status: result.upstream_status,
        upstream_body:   result.upstream_body,
        hit_count:       result.hit_count,
      });
    }

    res.json(result);
  } catch (err) {
    console.error('enrich-from-coresignal error:', err);
    res.status(500).json({ error: { message: 'Enrichment failed: ' + err.message } });
  }
});

// ── POST /:id/enrich-person ───────────────────────────────────────────────────
// Person-level enrichment for a prospect. Calls the orchestrator's
// enrichPerson chain (default: Apollo), normalizes the response, and writes:
//   - person-level data back onto the prospects row (title, headline,
//     linkedin_url, phone, location — only fields currently null/empty)
//   - rich person data (experience, education) into linkedin_profiles with
//     source='apollo', via the same internal upsert path the Chrome
//     extension uses
//
// Distinct from /enrich-from-coresignal which only does account-level
// (organization) enrichment.
//
// Response: { ok, prospectId, provider, written, raw? }   on success
//           { ok: false, reason, provider? }              on failure
router.post('/:id/enrich-person', async (req, res) => {
  try {
    const prospectId = parseInt(req.params.id, 10);
    if (!Number.isInteger(prospectId)) {
      return res.status(400).json({ error: { message: 'invalid prospect id' } });
    }

    // Load prospect — need the identifiers to pass to the orchestrator.
    const pres = await db.query(
      `SELECT id, org_id, first_name, last_name, email, linkedin_url,
              title, linkedin_headline, location, phone, company_domain
         FROM prospects
        WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
      [prospectId, req.orgId]
    );
    if (pres.rows.length === 0) {
      return res.status(404).json({ ok: false, reason: 'prospect_not_found' });
    }
    const p = pres.rows[0];

    const enrichment = require('../services/enrichment');
    const result = await enrichment.enrichPerson(req.orgId, {
      email:       p.email,
      linkedinUrl: p.linkedin_url,
      firstName:   p.first_name,
      lastName:    p.last_name,
      domain:      p.company_domain,
      prospectId:  p.id,
    });

    if (!result.ok) {
      const userVisible404 = [];
      const userVisible422 = [
        'no_identifier', 'not_found', 'ambiguous', 'no_credits',
        'auth_failed', 'rate_limited', 'timeout', 'network_error',
        'invalid_response', 'http_error', 'no_api_key',
        'monthly_cap_exceeded', 'no_providers_configured',
      ];
      const code = userVisible404.includes(result.reason) ? 404
                 : userVisible422.includes(result.reason) ? 422
                 : 500;
      return res.status(code).json({
        ok:       false,
        reason:   result.reason,
        provider: result.provider,
        // Pass through cap usage when it's the reason — UI can show "X of Y used"
        ...(result.reason === 'monthly_cap_exceeded' ? { cap: result.cap, used: result.used } : {}),
      });
    }

    // Write the prospect-level fields. Only fill columns currently null/empty —
    // never overwrite user-entered data with a third-party guess.
    const d = result.data || {};
    const updates = {};
    if (d.title       && !p.title)              updates.title              = d.title;
    if (d.headline    && !p.linkedin_headline)  updates.linkedin_headline  = d.headline;
    if (d.linkedin_url && !p.linkedin_url)      updates.linkedin_url       = d.linkedin_url;
    if (d.location    && !p.location)           updates.location           = d.location;
    if (d.phone       && !p.phone)              updates.phone              = d.phone;

    if (Object.keys(updates).length > 0) {
      const fields = Object.keys(updates);
      const params = [prospectId, req.orgId];
      const sets   = fields.map((f, i) => {
        params.push(updates[f]);
        return `${f} = $${params.length}`;
      }).join(', ');
      await db.query(
        `UPDATE prospects SET ${sets}, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND org_id = $2`,
        params
      );
    }

    // Write rich payload (experience, education, headline) to linkedin_profiles.
    // We do this only if the prospect has a linkedin_url we can key on, since
    // linkedin_profiles is slug-indexed. Apollo also returns a linkedin_url
    // for the person; prefer the one already on the prospect if both exist.
    const liUrl = p.linkedin_url || d.linkedin_url;
    let profileWritten = false;
    if (liUrl && (d.experience?.length || d.education?.length || d.headline || d.full_name)) {
      try {
        // Internal HTTP-shape call: reuse the /api/linkedin-profiles/upsert
        // logic by calling the function inline. To keep the route handler
        // simple and avoid spinning a sub-request, we hit the DB pattern
        // used by the upsert directly here.
        //
        // We DO NOT call the API route via fetch — that would round-trip
        // auth, which is silly. The schema is documented enough that an
        // inline INSERT … ON CONFLICT works.
        const slugMatch = String(liUrl).match(/\/in\/([^/?#]+)/);
        const slug = slugMatch ? slugMatch[1].toLowerCase() : null;
        if (slug) {
          await db.query(
            `INSERT INTO linkedin_profiles
               (org_id, linkedin_slug, linkedin_url, full_name, headline, location,
                experience, education, source, last_captured_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, 'apollo', NOW())
             ON CONFLICT (org_id, linkedin_slug) DO UPDATE
               SET linkedin_url = EXCLUDED.linkedin_url,
                   full_name    = COALESCE(NULLIF(EXCLUDED.full_name, ''),    linkedin_profiles.full_name),
                   headline     = COALESCE(NULLIF(EXCLUDED.headline, ''),     linkedin_profiles.headline),
                   location     = COALESCE(NULLIF(EXCLUDED.location, ''),     linkedin_profiles.location),
                   experience   = CASE
                                    WHEN jsonb_array_length(EXCLUDED.experience) > 0 THEN EXCLUDED.experience
                                    ELSE linkedin_profiles.experience
                                  END,
                   education    = CASE
                                    WHEN jsonb_array_length(EXCLUDED.education) > 0 THEN EXCLUDED.education
                                    ELSE linkedin_profiles.education
                                  END,
                   source       = 'apollo',
                   last_captured_at = NOW()`,
            [
              req.orgId, slug, liUrl,
              d.full_name || null, d.headline || null, d.location || null,
              JSON.stringify(d.experience || []),
              JSON.stringify(d.education  || []),
            ]
          );
          profileWritten = true;
        }
      } catch (lpErr) {
        // Non-fatal — the prospect was still enriched, just no linkedin_profiles row.
        console.warn('enrich-person: linkedin_profiles upsert failed:', lpErr.message);
      }
    }

    // Activity log
    await db.query(
      `INSERT INTO prospecting_activities
         (org_id, prospect_id, user_id, activity_type, description, metadata)
       VALUES ($1, $2, $3, 'enrichment', $4, $5::jsonb)`,
      [
        req.orgId, prospectId, req.user.userId,
        `Person enrichment from ${result.provider}`,
        JSON.stringify({
          provider:        result.provider,
          identifier_used: result.identifier_used,
          fields_written:  Object.keys(updates),
          profile_written: profileWritten,
        }),
      ]
    );

    res.json({
      ok:              true,
      prospectId,
      provider:        result.provider,
      written:         Object.keys(updates),
      profile_written: profileWritten,
      identifier_used: result.identifier_used,
    });
  } catch (err) {
    console.error('enrich-person error:', err);
    res.status(500).json({ error: { message: 'Person enrichment failed: ' + err.message } });
  }
});

// ── POST /:id/linkedin-event — log a LinkedIn interaction ─────────────────────
router.post('/:id/linkedin-event', async (req, res) => {
  try {
    const { event, note, sentiment } = req.body;

    const VALID_EVENTS = [
      'connection_request_sent',
      'connection_accepted',
      'message_sent',
      'inmail_sent',
      'reply_received',
      'voice_note_sent',
      'profile_viewed',
      'meeting_booked',
    ];

    const VALID_SENTIMENTS = ['positive', 'neutral', 'negative', 'follow_up_later'];

    if (!event || !VALID_EVENTS.includes(event)) {
      return res.status(400).json({ error: { message: `event must be one of: ${VALID_EVENTS.join(', ')}` } });
    }
    if (sentiment && !VALID_SENTIMENTS.includes(sentiment)) {
      return res.status(400).json({ error: { message: `sentiment must be one of: ${VALID_SENTIMENTS.join(', ')}` } });
    }

    const prospectRes = await db.query(
      `SELECT id, stage, channel_data, outreach_count, response_count
       FROM prospects WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
      [req.params.id, req.orgId]
    );

    if (prospectRes.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }

    const p           = prospectRes.rows[0];
    const channelData = p.channel_data || {};
    const li          = channelData.linkedin || {};
    const now         = new Date().toISOString();

    const STATUS_ORDER = [
      'connection_request_sent', 'connection_accepted',
      'message_sent', 'reply_received', 'meeting_booked',
    ];
    const statusForEvent   = event === 'inmail_sent' ? 'message_sent' : event;
    const currentStatusIdx = STATUS_ORDER.indexOf(li.connection_status || '');
    const newStatusIdx     = STATUS_ORDER.indexOf(statusForEvent);

    // ── Dedup guard ──────────────────────────────────────────────────────────
    // If stage is already outreach+ AND this LinkedIn status was already recorded,
    // sequences/actions already counted this touch — skip outreach_count bump.
    const OUTREACH_STAGES = ['outreach', 'engaged', 'discovery_call', 'qualified_sal', 'converted'];
    const alreadyAdvanced = OUTREACH_STAGES.includes(p.stage);
    const alreadyLogged   = currentStatusIdx >= newStatusIdx && newStatusIdx >= 0;
    const skipCount       = alreadyAdvanced && alreadyLogged;

    if (newStatusIdx > currentStatusIdx) {
      li.connection_status = statusForEvent;
    }

    switch (event) {
      case 'connection_request_sent':
        li.request_sent_at = now;
        if (note) li.request_note = note.substring(0, 500);
        break;
      case 'connection_accepted':
        li.connected_at = now;
        break;
      case 'message_sent':
        li.last_message_at   = now;
        li.message_count     = (li.message_count || 0) + 1;
        if (note) li.last_message_text = note.substring(0, 500);
        break;
      case 'inmail_sent':
        li.last_message_at = now;
        li.inmail_count    = (li.inmail_count || 0) + 1;
        li.message_count   = (li.message_count || 0) + 1;
        if (note) li.last_message_text = note.substring(0, 500);
        break;
      case 'reply_received':
        li.last_reply_at  = now;
        li.reply_count    = (li.reply_count || 0) + 1;
        if (sentiment) li.last_reply_sentiment = sentiment;
        if (note)      li.last_reply_text      = note.substring(0, 500);
        break;
      case 'voice_note_sent':
        li.last_voice_note_at = now;
        li.voice_note_count   = (li.voice_note_count || 0) + 1;
        break;
      case 'profile_viewed':
        li.last_profile_view_at = now;
        break;
      case 'meeting_booked':
        li.meeting_booked_at = now;
        if (note) li.meeting_note = note.substring(0, 500);
        break;
    }

    channelData.linkedin = li;

    const isOutreach = ['connection_request_sent', 'message_sent', 'inmail_sent', 'voice_note_sent'].includes(event);
    const isResponse = ['reply_received', 'meeting_booked'].includes(event);

    // Apply dedup: if sequences already counted this outreach, don't bump counters again
    const countOutreach = isOutreach && !skipCount;
    const countResponse = isResponse && !skipCount;

    // Auto-advance stage: target/research → outreach on first outreach
    // Only runs if sequences haven't already advanced it (skipCount guard)
    if (isOutreach && !skipCount) {
      const currentStage = p.stage;
      if (['target', 'research'].includes(currentStage)) {
        await db.query(
          `UPDATE prospects SET stage = 'outreach', stage_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND org_id = $2`,
          [req.params.id, req.orgId]
        );
        await db.query(
          `INSERT INTO prospecting_activities (org_id, prospect_id, user_id, activity_type, description)
           VALUES ($1, $2, $3, 'stage_change', 'Auto-advanced to outreach after LinkedIn outreach')`,
          [req.orgId, req.params.id, req.user.userId]
        );
      }
    }

    await db.query(
      `UPDATE prospects SET
         channel_data     = $1::jsonb,
         last_outreach_at = CASE WHEN $2 THEN CURRENT_TIMESTAMP ELSE last_outreach_at END,
         outreach_count   = CASE WHEN $2 THEN COALESCE(outreach_count, 0) + 1 ELSE outreach_count END,
         last_response_at = CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE last_response_at END,
         response_count   = CASE WHEN $3 THEN COALESCE(response_count, 0) + 1 ELSE response_count END,
         updated_at       = CURRENT_TIMESTAMP
       WHERE id = $4 AND org_id = $5`,
      [JSON.stringify(channelData), countOutreach, countResponse, req.params.id, req.orgId]
    );

    const EVENT_LABELS = {
      connection_request_sent: 'LinkedIn connection request sent',
      connection_accepted:     'LinkedIn connection accepted',
      message_sent:            'LinkedIn message sent',
      inmail_sent:             'LinkedIn InMail sent',
      reply_received:          'LinkedIn reply received',
      voice_note_sent:         'LinkedIn voice note sent',
      profile_viewed:          'LinkedIn profile viewed',
      meeting_booked:          'Meeting booked via LinkedIn',
    };

    const descParts = [
      EVENT_LABELS[event],
      sentiment ? `(${sentiment})` : null,
      note       ? `: ${note.substring(0, 120)}` : null,
    ].filter(Boolean);

    await db.query(
      `INSERT INTO prospecting_activities (org_id, prospect_id, user_id, activity_type, description, metadata)
       VALUES ($1, $2, $3, 'linkedin_event', $4, $5)`,
      [req.orgId, 
        req.params.id, req.user.userId,
        descParts.join(' '),
        JSON.stringify({ event, channel: 'linkedin', sentiment: sentiment || null }),
      ]
    );

    console.log(`🔗 LinkedIn "${event}" logged for prospect #${req.params.id} (org ${req.orgId})`);
    res.json({ success: true, event, channelData });

  } catch (error) {
    console.error('LinkedIn event error:', error);
    res.status(500).json({ error: { message: 'Failed to record LinkedIn event' } });
  }
});

// ── POST /:id/link-account ────────────────────────────────────────────────────
router.post('/:id/link-account', async (req, res) => {
  try {
    const { accountId } = req.body;

    if (!accountId) {
      return res.status(400).json({ error: { message: 'accountId is required' } });
    }

    const acc = await db.query(
      'SELECT id, name FROM accounts WHERE id = $1 AND org_id = $2',
      [accountId, req.orgId]
    );
    if (acc.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Account not found' } });
    }

    const result = await db.query(
      `UPDATE prospects SET account_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND org_id = $3 AND deleted_at IS NULL
       RETURNING *`,
      [accountId, req.params.id, req.orgId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }

    await db.query(
      `INSERT INTO prospecting_activities (org_id, prospect_id, user_id, activity_type, description)
       VALUES ($1, $2, $3, 'account_linked', $4)`,
      [req.orgId, req.params.id, req.user.userId, `Linked to account: ${acc.rows[0].name}`]
    );

    res.json({ prospect: result.rows[0] });
  } catch (error) {
    console.error('Link account error:', error);
    res.status(500).json({ error: { message: 'Failed to link account' } });
  }
});

// ── POST /:id/link-contact ────────────────────────────────────────────────────
router.post('/:id/link-contact', async (req, res) => {
  try {
    const { contactId } = req.body;

    if (!contactId) {
      return res.status(400).json({ error: { message: 'contactId is required' } });
    }

    const contact = await db.query(
      'SELECT id, first_name, last_name FROM contacts WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL',
      [contactId, req.orgId]
    );
    if (contact.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Contact not found' } });
    }

    const result = await db.query(
      `UPDATE prospects SET contact_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND org_id = $3 AND deleted_at IS NULL
       RETURNING *`,
      [contactId, req.params.id, req.orgId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }

    const c = contact.rows[0];
    await db.query(
      `INSERT INTO prospecting_activities (org_id, prospect_id, user_id, activity_type, description)
       VALUES ($1, $2, $3, 'contact_linked', $4)`,
      [req.orgId, req.params.id, req.user.userId, `Linked to existing contact: ${c.first_name} ${c.last_name}`]
    );

    res.json({ prospect: result.rows[0] });
  } catch (error) {
    console.error('Link contact error:', error);
    res.status(500).json({ error: { message: 'Failed to link contact' } });
  }
});

// ── GET /:id/activities — activity timeline ──────────────────────────────────
router.get('/:id/activities', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT pa.*, u.first_name AS user_first_name, u.last_name AS user_last_name
       FROM prospecting_activities pa
       LEFT JOIN users u ON pa.user_id = u.id
       WHERE pa.prospect_id = $1
       ORDER BY pa.created_at DESC`,
      [req.params.id]
    );
    res.json({ activities: result.rows });
  } catch (error) {
    console.error('Get activities error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch activities' } });
  }
});

// ── PATCH /:id — update prospect fields ──────────────────────────────────────
router.patch('/:id', async (req, res) => {
  try {
    const allowed = [
      'first_name', 'last_name', 'email', 'phone', 'title',
      'linkedin_headline', 'location', 'linkedin_url', 'company_name', 'company_domain',
      'company_size', 'company_industry', 'source', 'preferred_channel',
      'icp_score', 'tags', 'research_notes',
    ];

    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    const camelMap = {
      firstName: 'first_name', lastName: 'last_name',
      linkedinUrl: 'linkedin_url', linkedinHeadline: 'linkedin_headline',
      companyName: 'company_name',
      companyDomain: 'company_domain', companySize: 'company_size',
      companyIndustry: 'company_industry', preferredChannel: 'preferred_channel',
      icpScore: 'icp_score', researchNotes: 'research_notes',
    };
    for (const [camel, snake] of Object.entries(camelMap)) {
      if (req.body[camel] !== undefined) updates[snake] = req.body[camel];
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: { message: 'No valid fields to update' } });
    }

    const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 1}`);
    setClauses.push(`updated_at = CURRENT_TIMESTAMP`);
    const values = [...Object.values(updates), req.params.id, req.orgId];

    const result = await db.query(
      `UPDATE prospects
       SET ${setClauses.join(', ')}
       WHERE id = $${values.length - 1} AND org_id = $${values.length} AND deleted_at IS NULL
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }

    res.json({ prospect: result.rows[0] });
  } catch (error) {
    console.error('Update prospect error:', error);
    res.status(500).json({ error: { message: 'Failed to update prospect' } });
  }
});

// ── DELETE /:id — soft delete ────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE prospects SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL
       RETURNING id`,
      [req.params.id, req.orgId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }

    res.json({ message: 'Prospect deleted' });
  } catch (error) {
    console.error('Delete prospect error:', error);
    res.status(500).json({ error: { message: 'Failed to delete prospect' } });
  }
});

// ── POST /:id/generate-actions ───────────────────────────────────────────────
router.post('/:id/generate-actions', async (req, res) => {
  try {
    const prospectId = parseInt(req.params.id);
    const userId     = req.user.userId;
    const orgId      = req.orgId;
    const { mode = 'template', deduplicate = true } = req.body;

    const prospectRes = await db.query(
      'SELECT * FROM prospects WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL',
      [prospectId, orgId]
    );
    if (prospectRes.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }
    const prospect = prospectRes.rows[0];
    const stageKey = prospect.stage;

    if (!stageKey) {
      return res.status(400).json({ error: { message: 'Prospect has no stage assigned' } });
    }

    const context = await ProspectContextBuilder.build(prospectId, userId, orgId);

    const { actions, playbookId, playbookName, mode: effectiveMode } =
      await PlaybookActionGenerator.generate({
        entityType: 'prospect',
        context,
        playbookId: prospect.playbook_id || context.playbook?.id || null,
        stageKey,
        mode,
        orgId,
        userId,
      });

    if (actions.length === 0) {
      return res.json({
        inserted: 0, skipped: 0,
        playbookName: playbookName || null,
        mode: effectiveMode,
        message: playbookName
          ? `No plays defined for stage "${stageKey}" in "${playbookName}"`
          : 'No playbook found for this prospect',
      });
    }

    const result = await ActionWriter.write({
      entityType:        'prospect',
      entityId:          prospectId,
      actions,
      playbookId,
      playbookName,
      orgId,
      userId,
      deduplicateSource: deduplicate ? 'playbook' : null,
    });

    if (result.inserted > 0) {
      await db.query(
        `INSERT INTO prospecting_activities (org_id, prospect_id, user_id, activity_type, description, metadata)
         VALUES ($1, $2, $3, 'actions_generated', $4, $5)`,
        [req.orgId, 
          prospectId, userId,
          `Generated ${result.inserted} action(s) from "${playbookName || 'playbook'}" via ${effectiveMode} mode`,
          JSON.stringify({ playbookId, stage: stageKey, mode: effectiveMode, inserted: result.inserted }),
        ]
      ).catch(() => {});
    }

    res.json({
      inserted:     result.inserted,
      skipped:      result.skipped,
      playbookName: playbookName || null,
      mode:         effectiveMode,
      message:      `Generated ${result.inserted} action(s) from "${playbookName || 'playbook'}"`,
    });

  } catch (err) {
    console.error('generate-actions (prospect) error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// POST /:id/approve-research  (Slice 2 — researcher workflow)
// ─────────────────────────────────────────────────────────────────────────────
// Researcher-facing endpoint. Saves the curated signal blob (if any),
// transitions stage target → research, and writes a research_approved
// activity row.
//
// Body (all fields optional):
//   {
//     signalSummary:   string  — 1-3 sentences of factual observation, OR
//                                empty/omitted to advance without a curated
//                                signal (LinkedIn-capture-driven workflow)
//     signalCategory:  string  — one of: prospect_post, prospect_comment,
//                                account_post, account_event, tech_stack,
//                                role_curiosity, researcher_override.
//                                Defaults to 'researcher_override' when
//                                signalSummary is present and the caller
//                                hasn't picked one explicitly.
//     signalSourceUrl: string  — URL of the source (e.g. LinkedIn post link)
//     signalOverride:  boolean — when true AND signalSummary is non-empty,
//                                the skill is instructed to use the
//                                researcher's note AS THE HOOK, overriding
//                                whatever auto-detection would have picked.
//                                When false (default), the note is surfaced
//                                as ADDITIONAL CONTEXT the skill may use or
//                                ignore at its discretion.
//   }
//
// Behavior:
//   - target stage → updates to 'research'
//   - already in 'research' → fields updated, stage unchanged, idempotent
//   - any other stage → 409 (researcher shouldn't touch active-outreach
//     prospects; manual edit is still available via PUT /:id)
//
// When signalSummary is blank/omitted, the prospect still advances to
// 'research' but research_meta records no curated signal. The skill will
// pick its own hook from LinkedIn data (signals.linkedin_activity) and
// account enrichment (signals.account_events). If neither yields a viable
// signal, the SequenceStepFirer falls back to the raw sequence template
// at send time. This is the LinkedIn-capture-driven workflow: the rep
// uses the Chrome extension to populate linkedin_profiles, and the skill
// auto-picks the best hook from that data.
//
// research_notes mirrors signalSummary (the existing column already used by
// the personalisation prompt). research_meta jsonb keeps the structured fields
// the skill's hookPreferences picker can consume.
// ─────────────────────────────────────────────────────────────────────────────

const VALID_SIGNAL_CATEGORIES = [
  'prospect_post', 'prospect_comment', 'account_post',
  'account_event', 'tech_stack', 'role_curiosity',
  // Used when the researcher's own note IS the hook — the skill anchors
  // on the researcher's observation rather than something it found in the
  // LinkedIn activity feed or account enrichment.
  'researcher_override',
];

router.post('/:id/approve-research', async (req, res) => {
  try {
    const { signalSummary, signalCategory, signalSourceUrl, signalOverride } = req.body || {};

    // signalSummary is now optional. If provided, validate it; if blank,
    // we advance the prospect without recording a curated signal.
    const trimmedSummary = (typeof signalSummary === 'string' && signalSummary.trim())
      ? signalSummary.trim().substring(0, 4000)
      : null;

    // signalCategory is only meaningful when there's a summary.
    let resolvedCategory = null;
    if (trimmedSummary) {
      if (signalCategory && !VALID_SIGNAL_CATEGORIES.includes(signalCategory)) {
        return res.status(400).json({ error: {
          message: `signalCategory must be one of: ${VALID_SIGNAL_CATEGORIES.join(', ')}`,
        } });
      }
      // Default: when override is on the category IS researcher_override.
      // When override is off and no category was picked, default to
      // researcher_override too — the note isn't a real LinkedIn post or
      // account event the skill can validate, so attributing it to one of
      // the other categories would mislead the model into Pattern 1/2
      // expectations (verbatim quote, dated source, etc).
      resolvedCategory = signalCategory || 'researcher_override';
    }

    // signalOverride only meaningful when there's a summary to override with.
    const isOverride = !!(trimmedSummary && signalOverride === true);

    // Soft sanity check on URL; we don't strictly validate it being well-formed.
    const sourceUrl = (typeof signalSourceUrl === 'string' && signalSourceUrl.trim())
      ? signalSourceUrl.trim().substring(0, 1000)
      : null;

    // Load prospect — enforce org scope.
    const pRes = await db.query(
      `SELECT id, stage, research_meta FROM prospects
        WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
      [req.params.id, req.orgId]
    );
    if (pRes.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }
    const p = pRes.rows[0];

    // Stage gating: only target or research are valid starting points.
    if (!['target', 'research'].includes(p.stage)) {
      return res.status(409).json({ error: {
        message: `Cannot approve research from stage '${p.stage}'. Use the prospect edit screen instead.`,
      } });
    }

    // Merge structured signal fields into research_meta (preserve any keys
    // already there — e.g. researchBullets from the AI research action).
    // When summary is blank, we explicitly null out signal_* fields so a
    // researcher who previously typed something can also clear it.
    const existingMeta = (p.research_meta && typeof p.research_meta === 'object') ? p.research_meta : {};
    const newMeta = {
      ...existingMeta,
      signal_summary:    trimmedSummary,
      signal_category:   resolvedCategory,
      signal_source_url: sourceUrl,
      // Explicit override flag — read by SkillContextService to decide
      // whether to prepend 'researcher_override' to preferred_categories.
      signal_override:   isOverride,
      approved_by:       req.user.userId,
      approved_at:       new Date().toISOString(),
    };

    const stageAdvanced = p.stage === 'target';
    const nextStage = 'research';

    // Single UPDATE — research_notes mirrors summary for back-compat with the
    // inline personalisation prompt, which reads research_notes free-text.
    // When summary is null (blank), research_notes is also set to null so
    // the legacy prompt path doesn't pick up stale text.
    //
    // Explicit ::type casts on every parameter — pg-node doesn't send type
    // hints when a parameter is null, and when $1 is null Postgres has to
    // deduce types for the remaining params from context alone. Because
    // $3 (nextStage) is used in BOTH `stage = $3` (SET clause) and
    // `stage != $3` (CASE expression), the parser can deduce inconsistent
    // types ("text" in one path, "character varying" in the other) and
    // raise SQLSTATE 42P08. Casts make every parameter's type unambiguous.
    await db.query(
      `UPDATE prospects
          SET research_notes    = $1::text,
              research_meta     = $2::jsonb,
              stage             = $3::varchar,
              stage_changed_at  = CASE WHEN stage != $3::varchar THEN CURRENT_TIMESTAMP ELSE stage_changed_at END,
              updated_at        = CURRENT_TIMESTAMP
        WHERE id = $4::int AND org_id = $5::int`,
      [trimmedSummary, JSON.stringify(newMeta), nextStage, req.params.id, req.orgId]
    );

    // Activity row — researcher audit trail. Non-fatal. The description
    // distinguishes the three cases (advance with signal / advance without
    // signal / update in place) so the audit log is honest about what
    // happened, including whether the override flag was set.
    const activityDescription = (() => {
      if (!stageAdvanced) return 'Researcher updated signal on already-researched prospect';
      if (!trimmedSummary) return 'Researcher approved — moved to research stage (no curated signal)';
      if (isOverride)      return 'Researcher approved — moved to research stage (override hook)';
      return                       'Researcher approved — moved to research stage';
    })();

    try {
      await db.query(
        `INSERT INTO prospecting_activities
                     (org_id, prospect_id, user_id, activity_type, description, metadata)
              VALUES ($1, $2, $3, 'research_approved', $4, $5::jsonb)`,
        [
          req.orgId, req.params.id, req.user.userId,
          activityDescription,
          JSON.stringify({
            signal_category:   resolvedCategory,
            signal_source_url: sourceUrl,
            signal_override:   isOverride,
            had_signal:        !!trimmedSummary,
            stageAdvanced,
          }),
        ]
      );
    } catch (actErr) {
      console.warn('approve-research: activity log failed:', actErr.message);
    }

    res.json({
      prospectId:    parseInt(req.params.id, 10),
      stageAdvanced,
      stage:         nextStage,
      research_meta: newMeta,
    });
  } catch (err) {
    console.error('approve-research error:', err);
    res.status(500).json({ error: { message: 'Failed to approve research: ' + err.message } });
  }
});

module.exports = router;

