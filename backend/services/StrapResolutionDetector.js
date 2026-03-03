/**
 * StrapResolutionDetector.js
 *
 * Monitors deal events (emails, meetings, contact additions, health changes)
 * to detect when an active STRAP's hurdle has been resolved.
 *
 * Pattern: static class methods with org_id on every query
 * (matches actionCompletionDetector.service.js exactly).
 *
 * Integration points (called from existing event hooks):
 *   - checkFromEmail(dealId, orgId, userId)      — after email received/sent
 *   - checkFromMeeting(dealId, orgId, userId)     — after meeting completed
 *   - checkFromContactAdded(dealId, orgId, userId)— after contact linked to deal
 *   - checkFromHealthChange(dealId, orgId, userId, oldScore, newScore) — after health re-score
 *
 * Each method is non-blocking and never throws (matches AgentObserver pattern).
 */

const db          = require('../config/database');
const StrapEngine = require('./StrapEngine');

class StrapResolutionDetector {

  // ── Public: Check from email event ──────────────────────────────────────

  static async checkFromEmail(dealId, orgId, userId) {
    try {
      const strap = await StrapEngine.getActiveStrap(dealId, orgId);
      if (!strap) return;

      const hurdle = strap.hurdle_type;
      let resolved = false;
      let signals  = {};

      if (hurdle === 'momentum') {
        // Momentum hurdle resolved if new email exchange happened
        const recent = await db.query(
          `SELECT COUNT(*) as cnt FROM emails
           WHERE deal_id = $1 AND org_id = $2 AND direction = 'received'
             AND sent_at > $3`,
          [dealId, orgId, strap.created_at]
        );
        if (parseInt(recent.rows[0].cnt) > 0) {
          resolved = true;
          signals  = { trigger: 'email_received_after_strap', count: recent.rows[0].cnt };
        }
      }

      if (hurdle === 'close_date') {
        // Check if close date was confirmed via email (AI signal)
        const deal = await db.query('SELECT close_date_ai_confirmed FROM deals WHERE id = $1', [dealId]);
        if (deal.rows[0]?.close_date_ai_confirmed) {
          resolved = true;
          signals  = { trigger: 'close_date_confirmed_via_email' };
        }
      }

      if (hurdle === 'competitive') {
        // Check if a response was received after competitive materials were shared
        const strapActions = strap.actions || [];
        const shareAction  = strapActions.find(a =>
          a.action_type === 'email_send' && a.action_status === 'completed'
        );
        if (shareAction) {
          const replies = await db.query(
            `SELECT COUNT(*) as cnt FROM emails
             WHERE deal_id = $1 AND org_id = $2 AND direction = 'received'
               AND sent_at > $3`,
            [dealId, orgId, strap.created_at]
          );
          if (parseInt(replies.rows[0].cnt) > 0) {
            resolved = true;
            signals  = { trigger: 'reply_after_competitive_share' };
          }
        }
      }

      if (resolved) {
        await this._autoResolve(strap, orgId, signals);
      }
    } catch (err) {
      console.error(`🎯 StrapResolutionDetector.checkFromEmail error (deal ${dealId}):`, err.message);
    }
  }

  // ── Public: Check from meeting event ────────────────────────────────────

  static async checkFromMeeting(dealId, orgId, userId) {
    try {
      const strap = await StrapEngine.getActiveStrap(dealId, orgId);
      if (!strap) return;

      const hurdle = strap.hurdle_type;
      let resolved = false;
      let signals  = {};

      if (hurdle === 'momentum') {
        // New meeting scheduled or completed = momentum restored
        const recent = await db.query(
          `SELECT COUNT(*) as cnt FROM meetings
           WHERE deal_id = $1 AND org_id = $2
             AND (status = 'scheduled' OR status = 'completed')
             AND created_at > $3`,
          [dealId, orgId, strap.created_at]
        );
        if (parseInt(recent.rows[0].cnt) > 0) {
          resolved = true;
          signals  = { trigger: 'meeting_after_strap', count: recent.rows[0].cnt };
        }
      }

      if (hurdle === 'buyer_engagement') {
        // Check if meeting includes exec-level attendees
        const recentMeetings = await db.query(
          `SELECT m.id FROM meetings m
           WHERE m.deal_id = $1 AND m.org_id = $2
             AND m.created_at > $3`,
          [dealId, orgId, strap.created_at]
        );
        if (recentMeetings.rows.length > 0) {
          // Check if decision maker contacts are now on the deal
          const dms = await db.query(
            `SELECT COUNT(*) as cnt FROM deal_contacts dc
             JOIN contacts c ON c.id = dc.contact_id
             WHERE dc.deal_id = $1
               AND c.role_type IN ('decision_maker', 'economic_buyer', 'executive')`,
            [dealId]
          );
          if (parseInt(dms.rows[0].cnt) > 0) {
            resolved = true;
            signals  = { trigger: 'exec_meeting_scheduled', dm_count: dms.rows[0].cnt };
          }
        }
      }

      if (resolved) {
        await this._autoResolve(strap, orgId, signals);
      }
    } catch (err) {
      console.error(`🎯 StrapResolutionDetector.checkFromMeeting error (deal ${dealId}):`, err.message);
    }
  }

  // ── Public: Check from contact added ────────────────────────────────────

  static async checkFromContactAdded(dealId, orgId, userId) {
    try {
      const strap = await StrapEngine.getActiveStrap(dealId, orgId);
      if (!strap) return;

      const hurdle = strap.hurdle_type;
      let resolved = false;
      let signals  = {};

      if (hurdle === 'buyer_engagement') {
        // Decision maker or economic buyer added
        const dms = await db.query(
          `SELECT COUNT(*) as cnt FROM deal_contacts dc
           JOIN contacts c ON c.id = dc.contact_id
           WHERE dc.deal_id = $1
             AND c.role_type IN ('decision_maker', 'economic_buyer', 'executive')`,
          [dealId]
        );
        if (parseInt(dms.rows[0].cnt) > 0) {
          resolved = true;
          signals  = { trigger: 'decision_maker_added', count: dms.rows[0].cnt };
        }
      }

      if (hurdle === 'contact_coverage') {
        // Check if stakeholder count increased enough
        const stakeholders = await db.query(
          `SELECT COUNT(*) as cnt FROM deal_contacts dc
           JOIN contacts c ON c.id = dc.contact_id
           WHERE dc.deal_id = $1
             AND c.role_type IN ('decision_maker', 'champion', 'influencer', 'economic_buyer', 'executive')`,
          [dealId]
        );
        const baselineCount = strap.hurdle_evidence?.stakeholderCount || 0;
        const currentCount  = parseInt(stakeholders.rows[0].cnt);
        if (currentCount >= baselineCount + 2) {
          resolved = true;
          signals  = { trigger: 'stakeholder_coverage_expanded', baseline: baselineCount, current: currentCount };
        }
      }

      if (resolved) {
        await this._autoResolve(strap, orgId, signals);
      }
    } catch (err) {
      console.error(`🎯 StrapResolutionDetector.checkFromContactAdded error (deal ${dealId}):`, err.message);
    }
  }

  // ── Public: Check from health score change ──────────────────────────────

  static async checkFromHealthChange(dealId, orgId, userId, oldScore, newScore) {
    try {
      const strap = await StrapEngine.getActiveStrap(dealId, orgId);
      if (!strap) return;

      // Significant improvement in the hurdle's category suggests resolution
      const oldNum = parseFloat(oldScore) || 0;
      const newNum = parseFloat(newScore) || 0;
      const improvement = newNum - oldNum;

      if (improvement >= 15) {
        // Health improved significantly — the hurdle may be resolved
        console.log(`🎯 Health improved by ${improvement} pts for deal ${dealId} — checking STRAP resolution`);
        await this._autoResolve(strap, orgId, {
          trigger:     'health_improvement',
          oldScore:    oldNum,
          newScore:    newNum,
          improvement,
        });
      }
    } catch (err) {
      console.error(`🎯 StrapResolutionDetector.checkFromHealthChange error (deal ${dealId}):`, err.message);
    }
  }

  // ── Private: Auto-resolve ───────────────────────────────────────────────

  static async _autoResolve(strap, orgId, signals) {
    try {
      console.log(`🎯 Auto-resolving STRAP #${strap.id} — signals: ${JSON.stringify(signals)}`);
      await StrapEngine.resolveStrap(
        strap.id,
        orgId,
        'successful',
        `Auto-resolved: ${signals.trigger}`,
        signals,
        true  // auto-create next STRAP
      );
    } catch (err) {
      console.error(`🎯 Auto-resolve failed for STRAP #${strap.id}:`, err.message);
    }
  }
}

module.exports = StrapResolutionDetector;
