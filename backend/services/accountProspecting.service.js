// ─────────────────────────────────────────────────────────────────────────────
// accountProspecting.service.js
//
// Aggregation service for account-based prospecting.
// Assembles the full account picture: prospects, existing contacts, deal history,
// and evaluates coverage against playbook requirements.
// ─────────────────────────────────────────────────────────────────────────────

const db = require('../config/database');

class AccountProspectingService {

  // ── getAccountOverview ───────────────────────────────────────────────────────
  // Returns the complete prospecting picture for an account.

  static async getAccountOverview(accountId, orgId) {
    // 1. Account info
    const accountRes = await db.query(
      'SELECT * FROM accounts WHERE id = $1 AND org_id = $2',
      [accountId, orgId]
    );
    if (accountRes.rows.length === 0) return null;
    const account = accountRes.rows[0];

    // 2. Active prospects at this account
    const prospectsRes = await db.query(
      `SELECT * FROM prospects
       WHERE account_id = $1 AND org_id = $2 AND deleted_at IS NULL
       ORDER BY
         CASE stage WHEN 'qualified' THEN 1 WHEN 'engaged' THEN 2
           WHEN 'contacted' THEN 3 WHEN 'researched' THEN 4
           WHEN 'target' THEN 5 ELSE 6 END,
         updated_at DESC`,
      [accountId, orgId]
    );

    // 3. Existing contacts on this account (from deal side)
    const contactsRes = await db.query(
      `SELECT c.*,
              json_agg(
                json_build_object('id', d.id, 'name', d.name, 'stage', d.stage, 'value', d.value)
              ) FILTER (WHERE d.id IS NOT NULL) AS deals
       FROM contacts c
       LEFT JOIN deal_contacts dc ON c.id = dc.contact_id
       LEFT JOIN deals d ON dc.deal_id = d.id AND d.org_id = $2
       WHERE c.account_id = $1 AND c.org_id = $2 AND c.deleted_at IS NULL
       GROUP BY c.id
       ORDER BY c.last_contact_date DESC NULLS LAST`,
      [accountId, orgId]
    );

    // 4. Deal history
    const dealsRes = await db.query(
      `SELECT d.*, ds.name AS stage_name, ds.is_terminal,
              u.first_name AS owner_first_name, u.last_name AS owner_last_name
       FROM deals d
       LEFT JOIN deal_stages ds ON ds.org_id = d.org_id AND ds.key = d.stage
       LEFT JOIN users u ON d.owner_id = u.id
       WHERE d.account_id = $1 AND d.org_id = $2
       ORDER BY d.created_at DESC`,
      [accountId, orgId]
    );

    // 5. Recent prospecting activities across all prospects at this account
    const prospectIds = prospectsRes.rows.map(p => p.id);
    let activities = [];
    if (prospectIds.length > 0) {
      const activitiesRes = await db.query(
        `SELECT pa.*, p.first_name AS prospect_first_name, p.last_name AS prospect_last_name
         FROM prospecting_activities pa
         JOIN prospects p ON pa.prospect_id = p.id
         WHERE pa.prospect_id = ANY($1::int[])
         ORDER BY pa.created_at DESC
         LIMIT 30`,
        [prospectIds]
      );
      activities = activitiesRes.rows;
    }

    return {
      account,
      prospects: prospectsRes.rows,
      contacts:  contactsRes.rows,
      deals:     dealsRes.rows,
      activities,
      summary: {
        totalProspects:      prospectsRes.rows.length,
        totalContacts:       contactsRes.rows.length,
        totalDeals:          dealsRes.rows.length,
        activeDeals:         dealsRes.rows.filter(d => !d.is_terminal).length,
        closedWonDeals:      dealsRes.rows.filter(d => d.stage === 'closed_won').length,
        closedLostDeals:     dealsRes.rows.filter(d => d.stage === 'closed_lost').length,
        prospectsByStage:    this._groupByStage(prospectsRes.rows),
      },
    };
  }

  // ── getCoverageScorecard ─────────────────────────────────────────────────────
  // Evaluates prospect coverage against an account-based playbook's requirements.

  static async getCoverageScorecard(accountId, orgId, playbookId) {
    // Load playbook
    const pbRes = await db.query(
      'SELECT content, stage_guidance FROM playbooks WHERE id = $1 AND org_id = $2',
      [playbookId, orgId]
    );
    if (pbRes.rows.length === 0) return null;

    const playbook = pbRes.rows[0];
    const content = typeof playbook.content === 'string'
      ? JSON.parse(playbook.content)
      : (playbook.content || {});

    if (!content.account_based || !content.role_requirements) {
      return { isAccountBased: false, message: 'This playbook is not configured for account-based prospecting' };
    }

    // Load all people at this account: prospects + contacts
    const prospects = await db.query(
      `SELECT id, first_name, last_name, email, title, stage, 'prospect' AS entity_type
       FROM prospects
       WHERE account_id = $1 AND org_id = $2 AND deleted_at IS NULL
         AND stage NOT IN ('disqualified')`,
      [accountId, orgId]
    );

    const contacts = await db.query(
      `SELECT c.id, c.first_name, c.last_name, c.email, c.title, c.role_type,
              'contact' AS entity_type
       FROM contacts c
       WHERE c.account_id = $1 AND c.org_id = $2 AND c.deleted_at IS NULL`,
      [accountId, orgId]
    );

    const allPeople = [...prospects.rows, ...contacts.rows];
    const requirements = content.role_requirements;
    const minContacts = content.min_contacts || 3;
    const coverageThreshold = content.coverage_threshold || 75;

    // Evaluate each role requirement
    const roleResults = requirements.map(req => {
      const titlePatterns = (req.titles || []).map(t => t.toLowerCase());
      const matches = allPeople.filter(person => {
        const personTitle = (person.title || '').toLowerCase();
        return titlePatterns.some(pattern => personTitle.includes(pattern.toLowerCase()));
      });

      return {
        role:       req.role,
        required:   req.required,
        titles:     req.titles,
        covered:    matches.length > 0,
        matches:    matches.map(m => ({
          id:         m.id,
          name:       `${m.first_name} ${m.last_name}`,
          title:      m.title,
          entityType: m.entity_type,
          stage:      m.stage || null,
          roleType:   m.role_type || null,
        })),
      };
    });

    const coveredRequired = roleResults.filter(r => r.required && r.covered).length;
    const totalRequired   = roleResults.filter(r => r.required).length;
    const coveredAll      = roleResults.filter(r => r.covered).length;
    const totalAll        = roleResults.length;

    const coverageScore = totalRequired > 0
      ? Math.round((coveredRequired / totalRequired) * 100)
      : 100;

    // Identify gaps
    const gaps = roleResults
      .filter(r => !r.covered)
      .map(r => ({
        role:     r.role,
        required: r.required,
        titles:   r.titles,
      }));

    return {
      isAccountBased:    true,
      coverageScore,
      meetsThreshold:    coverageScore >= coverageThreshold,
      totalPeople:       allPeople.length,
      meetsMinContacts:  allPeople.length >= minContacts,
      minContactsRequired: minContacts,
      roles:             roleResults,
      gaps,
      summary: {
        requiredRolesCovered: `${coveredRequired}/${totalRequired}`,
        totalRolesCovered:    `${coveredAll}/${totalAll}`,
        coverageScore:        `${coverageScore}%`,
      },
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  static _groupByStage(prospects) {
    const groups = {};
    for (const p of prospects) {
      groups[p.stage] = (groups[p.stage] || 0) + 1;
    }
    return groups;
  }
}

module.exports = AccountProspectingService;
