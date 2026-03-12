/**
 * AI PROMPT TEMPLATES - FIXED
 * Customize how Claude analyzes emails and deals
 */

const AI_PROMPTS = {
  
  // ============================================================
  // EMAIL ANALYSIS PROMPT
  // Template variables will be replaced by aiProcessor.js
  // ============================================================
  email_analysis: `You are an AI sales assistant analyzing a sales conversation with FULL CONTEXT.

# SALES PLAYBOOK CONTEXT

## Deal Information
- **Deal Name:** DEAL_NAME_PLACEHOLDER
- **Stage:** DEAL_STAGE_PLACEHOLDER
- **Value:** $DEAL_VALUE_PLACEHOLDER
- **Expected Close:** DEAL_CLOSE_DATE_PLACEHOLDER
- **Health:** DEAL_HEALTH_PLACEHOLDER

### Playbook for this stage:
- **Goal:** PLAYBOOK_GOAL_PLACEHOLDER
- **Next Step:** PLAYBOOK_NEXT_STEP_PLACEHOLDER
- **Timeline:** PLAYBOOK_TIMELINE_PLACEHOLDER

## Contact Information
- **Name:** CONTACT_NAME_PLACEHOLDER
- **Title:** CONTACT_TITLE_PLACEHOLDER
- **Role Type:** CONTACT_ROLE_PLACEHOLDER

## Account Information
- **Company:** ACCOUNT_NAME_PLACEHOLDER
- **Industry:** ACCOUNT_INDUSTRY_PLACEHOLDER

---

# COMPLETE EMAIL CONVERSATION

EMAIL_THREAD_PLACEHOLDER

---

# RECENT MEETINGS

MEETINGS_PLACEHOLDER

---

# DEAL PROGRESSION HISTORY

DEAL_HISTORY_PLACEHOLDER

---

# CURRENT EMAIL (Just received)

**Subject:** CURRENT_EMAIL_SUBJECT_PLACEHOLDER
**From:** CURRENT_EMAIL_FROM_PLACEHOLDER
**Body:**
CURRENT_EMAIL_BODY_PLACEHOLDER

---

# YOUR TASK

Based on the COMPLETE CONTEXT above (entire email thread, meetings, deal history):

1. Identify patterns and trends in the conversation
2. Detect concerns, objections, or blockers mentioned across multiple interactions
3. Notice what was promised in previous emails/meetings and follow up
4. Generate 1-3 intelligent next-step actions that consider the FULL PICTURE

# OUTPUT FORMAT (JSON only, no markdown)

**CRITICAL INSTRUCTIONS:**
- Return ONLY the JSON array below
- Do NOT include any explanatory text before or after the JSON
- Do NOT wrap in markdown code blocks
- Start your response with [ and end with ]
- If data is missing or insufficient, still return valid JSON with available information

[
  {
    "title": "Specific action based on full context",
    "description": "Why needed (reference specific past interactions)",
    "priority": "high|medium|low",
    "due_date": "YYYY-MM-DD",
    "action_type": "email|meeting|follow_up|review",
    "suggested_action": "Detailed HOW-TO",
    "context": "What across ALL interactions triggered this",
    "confidence": 0.X,
    "email_trigger": "trigger_name or null"
  }
]

# QUALITY EXAMPLES

✅ GOOD (Shows full context awareness):
{
  "title": "Address HIPAA concerns raised in 3 separate emails",
  "description": "Customer asked about HIPAA on Jan 5, mentioned it again in meeting on Jan 12, and just asked for docs again today",
  "context": "Repeated concern across email thread (3 mentions) and 1 meeting - critical blocker",
  "confidence": 0.95
}

❌ BAD (Ignores context):
{
  "title": "Follow up on email",
  "description": "Email was received"
}

Now analyze and generate intelligent actions based on the FULL CONTEXT.`,

  // ============================================================
  // DEAL HEALTH CHECK PROMPT
  // ============================================================
  deal_health_check: `You are conducting a comprehensive health check on a sales deal.

# DEAL OVERVIEW

- **Deal Name:** DEAL_NAME_PLACEHOLDER
- **Stage:** DEAL_STAGE_PLACEHOLDER
- **Value:** $DEAL_VALUE_PLACEHOLDER
- **Days in Stage:** DAYS_IN_STAGE_PLACEHOLDER

# COMPLETE CONTEXT

## Email Thread
EMAIL_THREAD_PLACEHOLDER

## Meetings
MEETINGS_PLACEHOLDER

## Deal History
DEAL_HISTORY_PLACEHOLDER

---

# SPECIAL INSTRUCTIONS FOR DEAL HEALTH CHECK

Analyze:
1. Is the deal progressing normally or stalled?
2. Are there unresolved concerns from past conversations?
3. What commitments were made that haven't been followed up?
4. Are key stakeholders engaged or going silent?
5. Does the timeline still make sense?

Generate 2-4 strategic actions to move this deal forward or address risks.

# OUTPUT FORMAT (JSON only)

**CRITICAL INSTRUCTIONS:**
- Return ONLY the JSON array below
- Do NOT include any explanatory text before or after the JSON
- Do NOT wrap in markdown code blocks
- Start your response with [ and end with ]
- If data is missing or insufficient, still return valid JSON with available information

[
  {
    "title": "Strategic action title",
    "description": "Why this is critical for deal health",
    "priority": "high|medium|low",
    "due_date": "YYYY-MM-DD",
    "action_type": "email|meeting|follow_up|review",
    "suggested_action": "Specific steps to take",
    "context": "What signals from the data triggered this",
    "confidence": 0.X
  }
]`,

  // ============================================================
  // PROSPECTING — STAGE 1: ACCOUNT RESEARCH
  // Cached per account (30-day TTL). Reused for all prospects
  // at the same company. Stored in accounts.research_notes.
  // Placeholders: {{companyInfo}}, {{productContext}}
  // ============================================================
  prospecting_research_account: `You are an expert B2B sales researcher. Research this company thoroughly and return a structured JSON profile a sales rep can use to prepare outreach.

COMPANY INFORMATION:
{{companyInfo}}

WHAT WE SELL:
{{productContext}}

Return ONLY valid JSON, no markdown fences:
{
  "companyOverview": "2-3 sentence summary of what this company does, their market position, and what makes them notable",

  "whatTheySellToClients": "Describe their own products or services — what do they sell to their customers? Include key offerings, verticals they serve, and how they go to market. This is critical for spotting the cobbler's children angle.",

  "techStackTheyImplement": ["List technologies, platforms, or vendors they use or implement — e.g. Salesforce, SAP, NetSuite, AWS"],

  "goToMarketMotion": "How do they sell — direct sales, partnerships, advisory-led, product-led? What is their typical deal motion?",

  "businessPriorities": [
    "Current strategic priority 1",
    "Current strategic priority 2",
    "Current strategic priority 3"
  ],

  "likelyPainPoints": [
    "Pain point that maps to what we sell — be specific to their size, stage, and industry",
    "Pain point related to their growth or operational complexity",
    "Pain point their own clients face that they might also face internally"
  ],

  "cobblerAngle": "If this is a consulting, services, or implementation firm: do they help clients do something they may not have well-optimised internally? Describe the irony and how to use it as a pitch hook. If not applicable, return null.",

  "recentSignals": [
    "Any known acquisitions, funding, headcount growth, or leadership changes",
    "Any product launches, new market entries, or strategic pivots"
  ],

  "whyNow": "1-2 sentences on why this company would care about what we sell right now — timing, triggers, or market forces",

  "whatToAvoid": "Any sensitivities, poor-fit signals, or things that would make outreach feel tone-deaf",

  "accountScore": "0-100 fit score based on how well what we sell maps to their likely needs"
}`,

  // ============================================================
  // PROSPECTING — STAGE 2: INDIVIDUAL PERSON RESEARCH + PITCH
  // Always runs fresh per person. Uses Stage 1 account research
  // as context. Stored in prospects.research_notes.
  // Placeholders: {{prospectInfo}}, {{accountResearch}}, {{productContext}}
  // ============================================================
  prospecting_research: `You are an expert B2B sales researcher and copywriter preparing outreach for a specific person.

PERSON:
{{prospectInfo}}

ACCOUNT RESEARCH (already gathered — use this, do not repeat it verbatim):
{{accountResearch}}

WHAT WE SELL:
{{productContext}}

Return ONLY valid JSON, no markdown fences:
{
  "researchBullets": [
    "Bullet on this person's likely priorities given their specific role and seniority — what keeps them up at night",
    "Bullet on the strongest value angle for them personally — what outcome would make them look good internally",
    "Bullet on timing — why now is a good moment to reach out to this specific person",
    "Bullet referencing the cobbler's children angle if relevant — do they sell or implement something they may not have optimised internally",
    "Bullet on what to avoid or handle carefully — sensitivities, red flags, or things that would feel off"
  ],

  "pitchAngle": "The single sharpest angle to lead with for this specific person — one sentence",

  "crispPitch": "3-5 sentence pitch written directly to this person. Rules: open with an insight about them or their company, not an intro about us. Reference something specific. Connect to a pain they likely feel. End with a low-friction hook. No buzzwords, no flattery, no generic lines.",

  "subjectLine": "A subject line for an outreach email that would make this person open it — specific, curiosity-driven, not salesy",

  "confidence": 0.0
}`,

  // ============================================================
  // PROSPECTING — DRAFT EMAIL
  // Uses research notes already gathered. Called by the
  // AI Draft button in OutreachComposer as a fallback when
  // Stage 2 research didn't return a crispPitch directly.
  // Placeholders: {{prospectInfo}}, {{productContext}}, {{researchNotes}}
  // ============================================================
  prospecting_draft: `You are an expert B2B sales copywriter writing a first-touch outreach email.

PROSPECT:
{{prospectInfo}}

WHAT WE SELL:
{{productContext}}

RESEARCH NOTES (backbone for personalisation — do not repeat verbatim):
{{researchNotes}}

Write a short, personalised outreach email. Hard rules:
- Subject: specific and curiosity-driven. No "quick question", "touching base", or "I wanted to reach out".
- Opening line: reference something specific to them — their company, role, a recent signal, or the cobbler's angle if relevant. Do NOT open with "I" or "We".
- Body: 2-3 short paragraphs max. Lead with insight, follow with relevance, close with one ask.
- CTA: one low-friction ask — 20-minute call, a specific question, or "worth a conversation?". Never ask for more than one thing.
- Tone: confident, human, peer-to-peer. No buzzwords, no excessive flattery, no feature lists.
- Length: under 150 words total body (excluding subject).

Return ONLY valid JSON, no markdown fences:
{
  "subject": "Email subject line",
  "body": "Full email body. Use \n for paragraph breaks.",
  "tone": "consultative|direct|curious",
  "confidence": 0.0,
  "personalisationHooks": ["The specific detail that makes this feel personal, not templated"]
}`,

  // ============================================================
  // SYSTEM INSTRUCTIONS
  // ============================================================
  system_instructions: {
    model: "claude-sonnet-4-20250514",
    max_tokens: 4000,
    temperature: 0.7,
    
    guidelines: [
      "Always return valid JSON with no markdown formatting",
      "Be specific and reference concrete details from the context",
      "Prioritize actions that address repeated concerns or patterns",
      "Consider the contact's role when determining urgency",
      "Use the playbook rules to guide recommended timelines"
    ]
  }
};

module.exports = AI_PROMPTS;
