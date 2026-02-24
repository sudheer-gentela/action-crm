/**
 * ProposalExecutor.js
 *
 * Picks up approved proposals and executes them against the CRM service layer.
 * Each proposal_type maps to a handler that calls the same DB operations
 * the REST routes use — direct function calls, not HTTP.
 *
 * Called by:
 *   - agent.routes.js POST /approve (immediate execution after approval)
 *   - A periodic job for batch processing (optional)
 */

const db = require('../config/database');
const AgentProposalService = require('./AgentProposalService');

class ProposalExecutor {

  /**
   * Execute a single approved proposal.
   * Transitions: approved → executing → executed (or failed).
   */
  static async execute(proposalId) {
    // Mark as executing
    const proposal = await AgentProposalService.markExecuting(proposalId);
    if (!proposal) {
      console.warn(`ProposalExecutor: proposal ${proposalId} not found or not approved`);
      return { success: false, error: 'Not found or not in approved state' };
    }

    const { proposal_type, payload, org_id, user_id, deal_id, contact_id, account_id } = proposal;
    const data = typeof payload === 'string' ? JSON.parse(payload) : payload;

    try {
      let result;

      switch (proposal_type) {
        case 'create_contact':
          result = await this._execCreateContact(data, org_id, user_id);
          break;
        case 'update_deal_stage':
          result = await this._execUpdateDealStage(data, org_id, user_id);
          break;
        case 'draft_email':
          result = await this._execDraftEmail(data, org_id, user_id);
          break;
        case 'schedule_meeting':
          result = await this._execScheduleMeeting(data, org_id, user_id);
          break;
        case 'flag_risk':
          result = await this._execFlagRisk(data, org_id, deal_id);
          break;
        case 'update_contact':
          result = await this._execUpdateContact(data, org_id, contact_id);
          break;
        case 'link_contact_deal':
          result = await this._execLinkContactDeal(data, org_id);
          break;
        default:
          throw new Error(`Unknown proposal_type: ${proposal_type}`);
      }

      // Mark executed
      await AgentProposalService.markExecuted(proposalId, result);
      console.log(`✅ Proposal ${proposalId} executed: ${proposal_type}`);
      return { success: true, result };

    } catch (err) {
      console.error(`❌ Proposal ${proposalId} execution failed:`, err.message);
      await AgentProposalService.markFailed(proposalId, err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Execute all approved proposals for an org.
   * Used by a periodic job if desired.
   */
  static async executeAllApproved(orgId) {
    const proposals = await AgentProposalService.getApproved(orgId);
    const results = [];
    for (const p of proposals) {
      const result = await this.execute(p.id);
      results.push({ id: p.id, ...result });
    }
    return results;
  }

  // ── Type-specific handlers ─────────────────────────────────────────────────

  static async _execCreateContact(data, orgId, userId) {
    const result = await db.query(
      `INSERT INTO contacts
         (org_id, user_id, first_name, last_name, email, phone, title, role_type,
          account_id, notes, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
       RETURNING id, first_name, last_name, email`,
      [
        orgId, userId,
        data.first_name, data.last_name,
        data.email || null, data.phone || null,
        data.title || null, data.role_type || null,
        data.account_id || null,
        data.notes || data.source_evidence || null,
      ]
    );
    return { created_contact_id: result.rows[0].id, contact: result.rows[0] };
  }

  static async _execUpdateDealStage(data, orgId, userId) {
    const result = await db.query(
      `UPDATE deals
       SET stage = $1, stage_changed_at = NOW(), updated_at = NOW()
       WHERE id = $2 AND org_id = $3
       RETURNING id, name, stage`,
      [data.proposed_stage, data.deal_id, orgId]
    );
    if (result.rows.length === 0) throw new Error('Deal not found');

    // Log activity
    await db.query(
      `INSERT INTO deal_activities (deal_id, user_id, activity_type, description, metadata, created_at)
       VALUES ($1, $2, 'stage_change', $3, $4, NOW())`,
      [
        data.deal_id, userId,
        `Stage changed from ${data.current_stage} to ${data.proposed_stage} (via agent proposal)`,
        JSON.stringify({ source: 'agent_proposal', from: data.current_stage, to: data.proposed_stage }),
      ]
    );

    return { deal: result.rows[0] };
  }

  static async _execDraftEmail(data, orgId, userId) {
    // Create the email as a draft (not sent) — user can review in Email view
    // FIX: direction='draft' so it doesn't appear as an already-sent message.
    //      sent_at is NULL to further indicate draft status.
    const result = await db.query(
      `INSERT INTO emails
         (org_id, user_id, deal_id, contact_id, direction, subject, body,
          to_address, from_address, sent_at, created_at)
       VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,NULL,NULL,NOW())
       RETURNING id, subject`,
      [
        orgId, userId,
        data.deal_id || null, data.contact_id || null,
        data.subject, data.body,
        data.to_address || null,
      ]
    );
    return { created_email_id: result.rows[0].id, subject: result.rows[0].subject, status: 'draft_created' };
  }

  static async _execScheduleMeeting(data, orgId, userId) {
    const startTime = data.start_time || new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const endTime   = data.end_time   || new Date(new Date(startTime).getTime() + 30 * 60 * 1000);

    const result = await db.query(
      `INSERT INTO meetings
         (org_id, user_id, deal_id, title, description, meeting_type,
          start_time, end_time, status, source, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'scheduled','agent_proposal',NOW(),NOW())
       RETURNING id, title, start_time`,
      [
        orgId, userId,
        data.deal_id || null,
        data.title || 'Meeting (Agent Proposed)',
        data.description || data.agenda || null,
        data.meeting_type || 'virtual',
        startTime, endTime,
      ]
    );
    return { created_meeting_id: result.rows[0].id, meeting: result.rows[0] };
  }

  static async _execFlagRisk(data, orgId, dealId) {
    const targetDealId = data.deal_id || dealId;
    if (!targetDealId) throw new Error('No deal_id for risk flag');

    // Update the specific signal on the deal
    const signalKey = data.signal_key || 'agent_risk_flag';
    const update = {};
    update[signalKey] = { flagged: true, reason: data.reason, flagged_at: new Date().toISOString() };

    await db.query(
      `UPDATE deals
       SET signal_overrides = COALESCE(signal_overrides, '{}'::jsonb) || $1::jsonb,
           updated_at = NOW()
       WHERE id = $2 AND org_id = $3`,
      [JSON.stringify(update), targetDealId, orgId]
    );

    // Log activity
    await db.query(
      `INSERT INTO deal_activities (deal_id, activity_type, description, metadata, created_at)
       VALUES ($1, 'risk_flagged', $2, $3, NOW())`,
      [targetDealId, data.reason || 'Risk flagged by agent', JSON.stringify({ source: 'agent_proposal', signal_key: signalKey })]
    );

    return { deal_id: targetDealId, signal_key: signalKey, flagged: true };
  }

  static async _execUpdateContact(data, orgId, contactId) {
    const targetId = data.contact_id || contactId;
    if (!targetId) throw new Error('No contact_id for update');

    const fields = [];
    const values = [];
    let idx = 1;

    const updatable = ['title', 'role_type', 'phone', 'email', 'engagement_level', 'notes'];
    for (const field of updatable) {
      if (data[field] !== undefined) {
        fields.push(`${field} = $${idx}`);
        values.push(data[field]);
        idx++;
      }
    }

    if (fields.length === 0) throw new Error('No fields to update');

    fields.push(`updated_at = NOW()`);
    values.push(targetId, orgId);

    const result = await db.query(
      `UPDATE contacts SET ${fields.join(', ')}
       WHERE id = $${idx} AND org_id = $${idx + 1}
       RETURNING id, first_name, last_name, title, role_type`,
      values
    );

    if (result.rows.length === 0) throw new Error('Contact not found');
    return { contact: result.rows[0] };
  }

  static async _execLinkContactDeal(data, orgId) {
    if (!data.deal_id || !data.contact_id) throw new Error('deal_id and contact_id required');

    // Check both entities belong to this org
    const [dealCheck, contactCheck] = await Promise.all([
      db.query('SELECT id FROM deals WHERE id = $1 AND org_id = $2', [data.deal_id, orgId]),
      db.query('SELECT id FROM contacts WHERE id = $1 AND org_id = $2', [data.contact_id, orgId]),
    ]);
    if (dealCheck.rows.length === 0) throw new Error('Deal not found in org');
    if (contactCheck.rows.length === 0) throw new Error('Contact not found in org');

    // Upsert into deal_contacts
    await db.query(
      `INSERT INTO deal_contacts (deal_id, contact_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (deal_id, contact_id) DO UPDATE SET role = $3`,
      [data.deal_id, data.contact_id, data.role || 'stakeholder']
    );

    return { deal_id: data.deal_id, contact_id: data.contact_id, role: data.role || 'stakeholder' };
  }
}

module.exports = ProposalExecutor;
