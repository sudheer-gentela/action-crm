/**
 * Action Completion Detector
 * Analyzes emails and meetings to detect action completions.
 * Supports rules-only, AI-only, and hybrid modes.
 *
 * NEW: detectFromEmailForAction(emailId, userId, actionId)
 *   Targeted check for a specific action triggered from the email composer.
 *   Per product spec:
 *   - Runs AI semantic check to verify email contains what suggested_action said
 *   - If AI confirms content matches → auto-complete
 *   - If AI is unsure or content doesn't match → leave in_progress, flag for manual review
 *   - This is ONLY called for next_step=email|follow_up actions
 */

const db = require('../config/database');
const ActionConfigService = require('./actionConfig.service');

// Lazy-load Anthropic to avoid crash if API key not set
let anthropic = null;
function getAnthropic() {
  if (!anthropic) {
    const { Anthropic } = require('@anthropic-ai/sdk');
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

class ActionCompletionDetector {

  // ─────────────────────────────────────────────────────────────────────────
  // PUBLIC: Broad scan — checks all open actions for a deal
  // Called after any email send when no actionId is known
  // ─────────────────────────────────────────────────────────────────────────

  static async detectFromEmail(emailId, userId) {
    const config = await ActionConfigService.getConfig(userId);
    if (config.detection_mode === 'manual' || !config.detect_from_emails) return;

    try {
      const emailResult = await db.query('SELECT * FROM emails WHERE id = $1', [emailId]);
      if (emailResult.rows.length === 0) return;
      const email = emailResult.rows[0];
      if (!email.deal_id) return;

      const actionsResult = await db.query(
        `SELECT * FROM actions
         WHERE deal_id = $1 AND completed = false AND user_id = $2`,
        [email.deal_id, userId]
      );

      for (const action of actionsResult.rows) {
        const result = await this.analyze(action, email, 'email', config);
        if (result && result.confidence >= config.confidence_threshold) {
          if (result.confidence >= config.auto_complete_threshold) {
            await this.completeAction(action.id, result);
          } else {
            await this.createSuggestion(action.id, email.id, 'email', result, userId);
          }
        }
      }
    } catch (err) {
      console.error('detectFromEmail error:', err.message);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PUBLIC: Targeted check — called when email was sent FROM an action card
  //
  // Logic per spec:
  //   1. Get the action's suggested_action text (what the email was supposed to say)
  //   2. Run AI semantic check: does the sent email actually contain that intent?
  //   3. High confidence match  → auto-complete (status = completed)
  //   4. Low/medium confidence  → leave as in_progress, create suggestion for manual review
  //   5. AI disabled in config  → auto-complete (user clicked Send, that's enough)
  // ─────────────────────────────────────────────────────────────────────────

  static async detectFromEmailForAction(emailId, userId, actionId) {
    try {
      const config = await ActionConfigService.getConfig(userId);

      // Fetch email and action in parallel
      const [emailRes, actionRes] = await Promise.all([
        db.query('SELECT * FROM emails WHERE id = $1', [emailId]),
        db.query('SELECT * FROM actions WHERE id = $1 AND user_id = $2', [actionId, userId]),
      ]);

      if (emailRes.rows.length === 0 || actionRes.rows.length === 0) return;
      const email  = emailRes.rows[0];
      const action = actionRes.rows[0];

      // If AI detection is disabled → sending the email is sufficient, auto-complete
      if (config.detection_mode === 'manual' || !config.detect_from_emails) {
        await this._markCompleteManual(actionId, email, userId);
        return;
      }

      // Run AI content check
      const result = await this._checkEmailContentMatchesAction(email, action);

      if (result.confidence >= 75) {
        // AI is confident the email addressed what it was supposed to → auto-complete
        await this.completeAction(actionId, {
          ...result,
          detection_source: 'ai_content_check',
        });
        console.log(`✅ Email content verified — auto-completed action ${actionId} (${result.confidence}%)`);
      } else {
        // Email sent but content didn't clearly match — leave in_progress, surface for review
        await this.createSuggestion(actionId, email.id, 'email', {
          ...result,
          reasoning: `Email sent but content match was ${result.confidence}% — please confirm this completes the action.`,
        }, userId);
        console.log(`💡 Email sent but content uncertain (${result.confidence}%) — suggestion created for action ${actionId}`);
      }

    } catch (err) {
      console.error(`detectFromEmailForAction error (action ${actionId}):`, err.message);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRIVATE: AI semantic content check
  // Compares the sent email body against the action's suggested_action text
  // Returns { confidence: 0-100, reasoning, evidence }
  // ─────────────────────────────────────────────────────────────────────────

  static async _checkEmailContentMatchesAction(email, action) {
    // Fast path: no suggested_action to check against → assume match
    if (!action.suggested_action) {
      return { confidence: 80, reasoning: 'No specific content requirement — email sent is sufficient.', evidence: email.subject };
    }

    try {
      const client = getAnthropic();
      const prompt = `You are evaluating whether a sent email fulfils a specific sales action.

ACTION TITLE: ${action.title}
ACTION INTENT (what the email was supposed to achieve):
"${action.suggested_action}"

SENT EMAIL:
Subject: ${email.subject || '(no subject)'}
Body:
${(email.body || '').substring(0, 1500)}

---
Does this email meaningfully address the intent of the action?

Reply ONLY with valid JSON (no markdown):
{
  "confidence": <0-100>,
  "match": <true|false>,
  "reasoning": "<one sentence explaining your score>"
}

Scoring guide:
- 90-100: Email clearly and specifically addresses the action intent
- 70-89:  Email broadly addresses the intent but may be missing specifics
- 40-69:  Email is related but doesn't clearly fulfil the action
- 0-39:   Email does not address the action intent`;

      const message = await client.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages:   [{ role: 'user', content: prompt }],
      });

      const text    = message.content[0]?.text || '{}';
      const cleaned = text.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();
      const parsed  = JSON.parse(cleaned);

      return {
        confidence: Math.max(0, Math.min(100, parseInt(parsed.confidence) || 0)),
        reasoning:  parsed.reasoning || 'AI content check completed',
        evidence:   `${email.subject} — ${(email.body || '').substring(0, 100)}`,
      };

    } catch (err) {
      console.error('AI content check failed, defaulting to 70%:', err.message);
      // On AI failure, give benefit of the doubt — user did send the email
      return { confidence: 70, reasoning: 'AI check unavailable — email send accepted as completion signal.', evidence: email.subject };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRIVATE: Manual-style complete (used when AI disabled)
  // ─────────────────────────────────────────────────────────────────────────

  static async _markCompleteManual(actionId, email, userId) {
    await db.query(
      `UPDATE actions
       SET completed    = true,
           status       = 'completed',
           auto_completed = false,
           completed_by = $1,
           completion_evidence = $2,
           completed_at = CURRENT_TIMESTAMP,
           updated_at   = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [
        userId,
        JSON.stringify({ source: 'email_sent', subject: email.subject, email_id: email.id }),
        actionId,
      ]
    );
    console.log(`✅ Action ${actionId} marked complete (email sent, AI detection off)`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PUBLIC: Meeting-based detection (unchanged)
  // ─────────────────────────────────────────────────────────────────────────

  static async detectFromMeeting(meetingId, userId) {
    const config = await ActionConfigService.getConfig(userId);
    if (config.detection_mode === 'manual' || !config.detect_from_meetings) return;

    try {
      const meetingResult = await db.query('SELECT * FROM meetings WHERE id = $1', [meetingId]);
      if (meetingResult.rows.length === 0) return;
      const meeting = meetingResult.rows[0];
      if (!meeting.deal_id) return;

      const actionsResult = await db.query(
        `SELECT * FROM actions WHERE deal_id = $1 AND completed = false AND user_id = $2`,
        [meeting.deal_id, userId]
      );

      for (const action of actionsResult.rows) {
        const result = await this.analyze(action, meeting, 'meeting', config);
        if (result && result.confidence >= config.confidence_threshold) {
          if (result.confidence >= config.auto_complete_threshold) {
            await this.completeAction(action.id, result);
          } else {
            await this.createSuggestion(action.id, meeting.id, 'meeting', result, userId);
          }
        }
      }
    } catch (err) {
      console.error('detectFromMeeting error:', err.message);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Analyze (hybrid/rules/ai routing)
  // ─────────────────────────────────────────────────────────────────────────

  static async analyze(action, evidence, evidenceType, config) {
    const mode = config.detection_mode;
    if (mode === 'rules_only') return this.analyzeWithRules(action, evidence, evidenceType);
    if (mode === 'ai_only')    return this.analyzeWithAI(action, evidence, evidenceType);
    if (mode === 'hybrid') {
      const rulesResult = this.analyzeWithRules(action, evidence, evidenceType);
      if (rulesResult.confidence < 40 || rulesResult.confidence > 90) {
        rulesResult.detection_source = 'rules';
        return rulesResult;
      }
      const aiResult = await this.analyzeWithAI(action, evidence, evidenceType);
      aiResult.detection_source = 'ai';
      return aiResult;
    }
    return null;
  }

  static analyzeWithRules(action, evidence, evidenceType) {
    let score = 0;
    const weights = { keyword_match: 30, attachment_type: 20, external_recipient: 20, type_match: 15, timing: 10, no_negation: 5 };
    const flags = [];

    let searchText = '';
    if (evidenceType === 'email')   searchText = `${evidence.subject || ''} ${evidence.body || ''}`.toLowerCase();
    if (evidenceType === 'meeting') searchText = `${evidence.title || ''} ${evidence.description || ''}`.toLowerCase();

    if (action.keywords?.length > 0) {
      const matches = action.keywords.filter(kw => searchText.includes(kw.toLowerCase()));
      score += weights.keyword_match * (matches.length / action.keywords.length);
    }

    if (evidenceType === 'email' && action.action_type === 'email_send' && evidence.has_attachments) {
      score += weights.attachment_type;
    }

    if (action.requires_external_evidence && evidenceType === 'email') {
      if (evidence.direction === 'sent') score += weights.external_recipient;
      else { flags.push('internal_only'); score -= 20; }
    }

    if (action.action_type === 'email_send' && evidenceType === 'email')        score += weights.type_match;
    if (action.action_type === 'meeting_schedule' && evidenceType === 'meeting') score += weights.type_match;

    const negationWords = ['discuss', 'planning', 'thinking about', 'considering', 'not yet', 'prepare to'];
    if (negationWords.some(w => searchText.includes(w))) { flags.push('negation_detected'); score -= 15; }
    else score += weights.no_negation;

    const confidence = Math.max(0, Math.min(100, Math.round(score)));
    return {
      completes_action:  confidence >= 60,
      confidence,
      reasoning:         `Rules-based analysis: ${confidence}% confidence`,
      evidence:          this.extractEvidence(evidence, evidenceType),
      flags,
      detection_source:  'rules',
    };
  }

  static async analyzeWithAI(action, evidence, evidenceType) {
    // Falls back to rules until full AI implementation is wired
    console.log('⚠️ analyzeWithAI: using rules fallback');
    return this.analyzeWithRules(action, evidence, evidenceType);
  }

  static extractEvidence(evidence, evidenceType) {
    if (evidenceType === 'email') {
      const snippet = evidence.body ? evidence.body.substring(0, 100) : '';
      return `${evidence.subject || ''} — ${snippet}${snippet.length === 100 ? '...' : ''}`;
    }
    if (evidenceType === 'meeting') return evidence.title || '';
    return '';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DB helpers
  // ─────────────────────────────────────────────────────────────────────────

  static async completeAction(actionId, analysis) {
    await db.query(
      `UPDATE actions
       SET completed            = true,
           status               = 'completed',
           auto_completed       = true,
           completion_confidence = $1,
           completion_evidence  = $2,
           completed_at         = CURRENT_TIMESTAMP,
           updated_at           = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [
        analysis.confidence,
        JSON.stringify({ reasoning: analysis.reasoning, evidence: analysis.evidence, flags: analysis.flags, source: analysis.detection_source }),
        actionId,
      ]
    );
    console.log(`✅ Auto-completed action ${actionId} (${analysis.confidence}%)`);
  }

  static async createSuggestion(actionId, evidenceId, evidenceType, analysis, userId) {
    await db.query(
      `INSERT INTO action_suggestions
         (action_id, user_id, evidence_type, evidence_id, evidence_snippet, confidence, reasoning, detection_source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [actionId, userId, evidenceType, evidenceId, analysis.evidence, analysis.confidence, analysis.reasoning, analysis.detection_source]
    );

    await db.query(
      `UPDATE actions
       SET pending_suggestions = COALESCE(pending_suggestions, '{}') || $1::jsonb
       WHERE id = $2`,
      [JSON.stringify({ id: evidenceId, type: evidenceType, confidence: analysis.confidence, snippet: analysis.evidence }), actionId]
    );

    console.log(`💡 Suggestion created for action ${actionId} (${analysis.confidence}%)`);
  }

  static async acceptSuggestion(suggestionId, userId) {
    const suggResult = await db.query(
      'SELECT * FROM action_suggestions WHERE id = $1 AND user_id = $2',
      [suggestionId, userId]
    );
    if (suggResult.rows.length === 0) throw new Error('Suggestion not found');
    const suggestion = suggResult.rows[0];

    await db.query(
      `UPDATE actions
       SET completed = true, status = 'completed', auto_completed = false,
           completion_confidence = $1, completion_evidence = $2,
           completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [
        suggestion.confidence,
        JSON.stringify({ type: suggestion.evidence_type, id: suggestion.evidence_id, snippet: suggestion.evidence_snippet, source: 'user_accepted_suggestion' }),
        suggestion.action_id,
      ]
    );

    await db.query(
      `UPDATE action_suggestions SET status = 'accepted', resolved_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [suggestionId]
    );
    console.log(`✅ Suggestion ${suggestionId} accepted — action ${suggestion.action_id} completed`);
  }

  static async dismissSuggestion(suggestionId, userId) {
    await db.query(
      `UPDATE action_suggestions SET status = 'dismissed', resolved_at = CURRENT_TIMESTAMP WHERE id = $1 AND user_id = $2`,
      [suggestionId, userId]
    );
    console.log(`❌ Suggestion ${suggestionId} dismissed`);
  }
}

module.exports = ActionCompletionDetector;
