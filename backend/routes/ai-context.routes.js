/**
 * ai-context.routes.js
 *
 * POST /api/ai/context-suggest
 *
 * Takes an action and generates context-aware suggestions:
 *  - Draft email (for email/follow_up actions)
 *  - Meeting agenda / talking points (for meeting actions)
 *  - Document outline (for document_prep actions)
 *  - Call script / message draft (for call/whatsapp/linkedin actions)
 *
 * Reuses gatherFullContext() from aiProcessor.js — no duplication.
 */

const express    = require('express');
const router     = express.Router();
const db         = require('../config/database');
const { Anthropic } = require('@anthropic-ai/sdk');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

router.use(authenticateToken);
router.use(orgContext);

// ── Helper: gather deal context for suggestion ──────────────────
async function gatherDealContext(dealId, orgId) {
  const [dealRes, emailsRes, meetingsRes, transcriptsRes, contactsRes] = await Promise.all([
    db.query('SELECT * FROM deals WHERE id = $1 AND org_id = $2', [dealId, orgId]),

    db.query(
      `SELECT id, subject, direction, sent_at, from_address, to_address,
              LEFT(body, 400) AS body_preview
       FROM emails
       WHERE deal_id = $1 AND org_id = $2
       ORDER BY sent_at DESC LIMIT 6`,
      [dealId, orgId]
    ),

    db.query(
      `SELECT id, title, start_time, status, notes, description, prep_doc
       FROM meetings
       WHERE deal_id = $1 AND org_id = $2
       ORDER BY start_time DESC LIMIT 4`,
      [dealId, orgId]
    ),

    db.query(
      `SELECT mt.transcript_text, mt.analysis_result, mt.meeting_date
       FROM meeting_transcripts mt
       WHERE mt.deal_id = $1 AND mt.org_id = $2
         AND mt.analysis_status = 'completed'
       ORDER BY mt.created_at DESC LIMIT 2`,
      [dealId, orgId]
    ),

    db.query(
      `SELECT c.first_name, c.last_name, c.email, c.title, c.role_type
       FROM contacts c
       INNER JOIN deals d ON d.account_id = c.account_id
       WHERE d.id = $1 AND c.org_id = $2
       ORDER BY c.role_type`,
      [dealId, orgId]
    ),
  ]);

  return {
    deal:        dealRes.rows[0] || null,
    emails:      emailsRes.rows,
    meetings:    meetingsRes.rows,
    transcripts: transcriptsRes.rows,
    contacts:    contactsRes.rows,
  };
}

// ── Build prompt based on action type ──────────────────────────
function buildPrompt(action, ctx) {
  const { deal, emails, meetings, transcripts, contacts } = ctx;

  const dealInfo = deal
    ? `Deal: ${deal.name} | Stage: ${deal.stage} | Value: $${parseFloat(deal.value || 0).toLocaleString()} | Health: ${deal.health || 'unknown'}`
    : 'No deal context available';

  const primaryContact = contacts.find(c => c.role_type === 'decision_maker' || c.role_type === 'champion')
    || contacts[0];
  const contactName = primaryContact
    ? `${primaryContact.first_name} ${primaryContact.last_name} (${primaryContact.title || primaryContact.role_type})`
    : 'Unknown contact';

  const recentEmails = emails.slice(0, 4).map((e, i) =>
    `[${i + 1}] ${e.direction?.toUpperCase()} on ${new Date(e.sent_at).toLocaleDateString()} — "${e.subject}"\n${e.body_preview || ''}`
  ).join('\n\n');

  const recentMeetings = meetings.slice(0, 3).map(m =>
    `${new Date(m.start_time).toLocaleDateString()} — ${m.title} (${m.status})\nNotes: ${m.notes || m.description || 'None'}`
  ).join('\n\n');

  const transcriptSummaries = transcripts.map(t => {
    let analysis = '';
    if (t.analysis_result) {
      try {
        const parsed = typeof t.analysis_result === 'string' ? JSON.parse(t.analysis_result) : t.analysis_result;
        analysis = parsed.summary || parsed.key_points?.join('; ') || '';
      } catch (_) {}
    }
    return `Meeting transcript (${t.meeting_date ? new Date(t.meeting_date).toLocaleDateString() : 'recent'}): ${analysis || t.transcript_text?.substring(0, 300) || 'No summary'}`;
  }).join('\n\n');

  const actionType = action.actionType || action.type || '';
  const nextStep   = action.nextStep || 'email';

  // ── Email / follow-up draft ───────────────────────────────────
  if (actionType.includes('email') || nextStep === 'email') {
    return `You are a B2B sales assistant helping a sales rep draft a follow-up email.

ACTION TO PERFORM: ${action.title}
REASON: ${action.description || action.context || 'Move the deal forward'}
SUGGESTED APPROACH: ${action.suggestedAction || ''}

DEAL CONTEXT:
${dealInfo}

PRIMARY CONTACT: ${contactName}

RECENT EMAIL HISTORY (most recent first):
${recentEmails || 'No previous emails'}

RECENT MEETINGS:
${recentMeetings || 'No meetings on record'}

TRANSCRIPT INSIGHTS:
${transcriptSummaries || 'No transcripts available'}

---

Write a concise, professional follow-up email that:
1. Feels natural and human, not templated
2. References specifics from recent interaction history
3. Has a clear single ask or next step
4. Matches the relationship stage (early/mid/late deal)

Return ONLY valid JSON, no markdown:
{
  "subject": "Email subject line",
  "body": "Full email body with natural line breaks using \\n",
  "keyPoints": ["Why this email is timely", "What makes it specific to this deal"],
  "tone": "friendly|formal|urgent",
  "confidence": 0.0-1.0
}`;
  }

  // ── Meeting schedule / prep ───────────────────────────────────
  if (actionType.includes('meeting') || nextStep === 'meeting' || actionType.includes('review') || actionType.includes('prep')) {
    return `You are a B2B sales assistant helping a sales rep prepare for or schedule a meeting.

ACTION TO PERFORM: ${action.title}
REASON: ${action.description || action.context || ''}

DEAL CONTEXT:
${dealInfo}

CONTACTS:
${contacts.slice(0, 5).map(c => `${c.first_name} ${c.last_name} — ${c.title || c.role_type}`).join('\n') || 'No contacts'}

RECENT MEETINGS:
${recentMeetings || 'No previous meetings'}

TRANSCRIPT INSIGHTS:
${transcriptSummaries || 'No transcripts'}

RECENT EMAILS:
${recentEmails || 'No emails'}

---

Generate a meeting preparation package with:
1. A 3-5 point agenda
2. Key questions to ask
3. Topics to avoid or handle carefully
4. Desired outcome for this meeting

Return ONLY valid JSON, no markdown:
{
  "agenda": ["Agenda item 1", "Agenda item 2", "..."],
  "questions": ["Question to ask 1", "Question to ask 2", "..."],
  "sensitivities": ["Topic to handle carefully", "..."],
  "desiredOutcome": "What success looks like after this meeting",
  "suggestedDuration": "30 min|45 min|60 min",
  "confidence": 0.0-1.0
}`;
  }

  // ── Document prep ─────────────────────────────────────────────
  if (actionType.includes('document') || nextStep === 'document') {
    return `You are a B2B sales assistant helping a sales rep prepare a document.

ACTION TO PERFORM: ${action.title}
REASON: ${action.description || action.context || ''}

DEAL CONTEXT:
${dealInfo}

CONTACTS:
${contacts.slice(0, 5).map(c => `${c.first_name} ${c.last_name} — ${c.title || c.role_type}`).join('\n') || 'No contacts'}

RECENT EMAILS & MEETINGS:
${recentEmails ? `Emails:\n${recentEmails}` : ''}
${recentMeetings ? `Meetings:\n${recentMeetings}` : ''}

TRANSCRIPT INSIGHTS:
${transcriptSummaries || 'No transcripts'}

---

Generate a document preparation brief with key sections and points to cover.

Return ONLY valid JSON, no markdown:
{
  "documentType": "proposal|battlecard|roi_analysis|security_review|other",
  "sections": [{ "title": "Section name", "points": ["Key point 1", "Key point 2"] }],
  "keyMessages": ["Top message 1", "Top message 2"],
  "toneAndAudience": "Who reads this and what tone to use",
  "confidence": 0.0-1.0
}`;
  }

  // ── Call / WhatsApp / LinkedIn ────────────────────────────────
  if (['call', 'whatsapp', 'linkedin', 'slack'].includes(nextStep)) {
    const channelLabel = { call: 'phone call', whatsapp: 'WhatsApp message', linkedin: 'LinkedIn message', slack: 'Slack message' }[nextStep];
    return `You are a B2B sales assistant helping a sales rep prepare a ${channelLabel}.

ACTION TO PERFORM: ${action.title}
REASON: ${action.description || action.context || ''}

DEAL CONTEXT:
${dealInfo}

PRIMARY CONTACT: ${contactName}

RECENT INTERACTION HISTORY:
${recentEmails || 'No emails'}
${recentMeetings || 'No meetings'}

TRANSCRIPT INSIGHTS:
${transcriptSummaries || 'No transcripts'}

---

Generate a ${channelLabel} script/draft that feels natural and specific to this relationship.

Return ONLY valid JSON, no markdown:
{
  "opener": "How to open the conversation",
  "keyPoints": ["Main point 1", "Main point 2", "Main point 3"],
  "ask": "The specific ask or next step",
  "messageDraft": "${nextStep === 'call' ? 'Full call talking points' : 'Full message to send'}",
  "fallbackIfNoAnswer": "${nextStep === 'call' ? 'Voicemail script' : 'Follow-up if no reply'}",
  "confidence": 0.0-1.0
}`;
  }

  // ── Generic fallback ──────────────────────────────────────────
  return `You are a B2B sales assistant. Generate actionable guidance for this task.

ACTION: ${action.title}
DESCRIPTION: ${action.description || action.context || ''}
DEAL: ${dealInfo}
CONTACTS: ${contacts.slice(0, 3).map(c => `${c.first_name} ${c.last_name}`).join(', ') || 'Unknown'}
RECENT EMAILS: ${recentEmails || 'None'}

Return ONLY valid JSON, no markdown:
{
  "guidance": "What specifically to do and how",
  "keyPoints": ["Point 1", "Point 2"],
  "nextStep": "Concrete immediate next step",
  "confidence": 0.0-1.0
}`;
}

// ── POST /api/ai/context-suggest ──────────────────────────────
router.post('/context-suggest', async (req, res) => {
  const startTime = Date.now();

  try {
    const { action } = req.body;

    if (!action || !action.id) {
      return res.status(400).json({ error: { message: 'action object with id is required' } });
    }

    const dealId = action.deal?.id || action.dealId || null;

    // If no deal context, return a lightweight generic response
    if (!dealId) {
      return res.json({
        suggestion: {
          type:       'generic',
          guidance:   action.suggestedAction || action.description || 'Complete this action as described.',
          keyPoints:  [],
          confidence: 0.3,
        },
        generatedIn: Date.now() - startTime,
      });
    }

    // Gather full deal context from DB
    const ctx    = await gatherDealContext(dealId, req.orgId);
    const prompt = buildPrompt(action, ctx);

    // Call Claude
    const message = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',  // Fast + cheap for real-time UX
      max_tokens: 1200,
      messages:   [{ role: 'user', content: prompt }],
    });

    const rawText = message.content[0]?.text || '{}';
    let parsed;

    try {
      const cleaned = rawText.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();
      const start   = cleaned.indexOf('{');
      const end     = cleaned.lastIndexOf('}');
      parsed = JSON.parse(cleaned.substring(start, end + 1));
    } catch (_) {
      parsed = { guidance: rawText, confidence: 0.5 };
    }

    // Determine suggestion type for frontend rendering
    const actionType = action.actionType || action.type || '';
    const nextStep   = action.nextStep || 'email';
    let type = 'generic';
    if (actionType.includes('email') || nextStep === 'email')    type = 'email';
    else if (actionType.includes('meeting') || nextStep === 'meeting') type = 'meeting';
    else if (actionType.includes('prep') || actionType.includes('review')) type = 'meeting_prep';
    else if (actionType.includes('document') || nextStep === 'document') type = 'document';
    else if (['call', 'whatsapp', 'linkedin'].includes(nextStep)) type = nextStep;

    res.json({
      suggestion: { type, ...parsed },
      context: {
        dealName:    ctx.deal?.name,
        dealStage:   ctx.deal?.stage,
        dealHealth:  ctx.deal?.health,
        emailCount:  ctx.emails.length,
        meetingCount:ctx.meetings.length,
        contactCount:ctx.contacts.length,
        hasTranscripts: ctx.transcripts.length > 0,
      },
      generatedIn: Date.now() - startTime,
    });

  } catch (err) {
    console.error('AI context suggest error:', err);
    res.status(500).json({ error: { message: 'Failed to generate suggestion', detail: err.message } });
  }
});

module.exports = router;
