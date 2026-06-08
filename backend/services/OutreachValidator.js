// ============================================================================
// services/OutreachValidator.js
//
// Deterministic post-generation validation for outreach skill output. The
// model is instructed about length caps, banned phrasings, and fit/skip
// behaviour in the SKILL.md files, but instructions are not guarantees — this
// service enforces them in code so a bad draft can't silently reach a prospect.
//
// Pure / dependency-free: no DB, no network. Given a parsed skill output and
// the org_context block, it returns a routing decision the caller acts on.
//
// Public API:
//   validateForSkill(skillName, output, orgContext) -> result
//   validateOutreach(output, { channel, intent, bannedExtra, requiredDisclaimers }) -> result
//
// result = {
//   ok:       boolean,          // true when route === 'send'
//   route:    'send' | 'review' | 'reject',
//   channel:  'email' | 'linkedin' | null,
//   intent:   string | null,
//   blocking: string[],         // hard failures (caps, banned, missing disclaimer)
//   warnings: string[],         // soft issues worth a human glance
//   metrics:  object,           // measured lengths, for logging / UI
// }
//
// Routing:
//   reject  -> a hard cap or banned phrasing was hit. Regenerate; never send.
//   review  -> output.recommend_skip is true, or output.fit === 'disqualified'
//              / 'weak'. Send is possible but a human should look first.
//   send    -> clean.
// blocking always forces 'reject'. review is only chosen when nothing blocks.
// ============================================================================

'use strict';

// Phrasings banned for every org. guardrails_extra.banned_phrasings (org +
// campaign + user, already unioned by SkillContextService) are added on top.
// Matched case-insensitively as substrings.
const UNIVERSAL_BANNED = [
  'i hope this email finds you well',
  'i hope this finds you well',
  'i wanted to reach out',
  'i am reaching out',
  'i came across your profile',
  'as a fellow',
  'most teams we work with',
  'companies like yours',
  'in today\u2019s fast-paced',
  'in todays fast-paced',
  'game-changer',
  'game changer',
  'synergy',
  'circle back',
  'low-hanging fruit',
  'pick your brain',
  'touch base',
];

// Length caps by channel + intent. Word caps apply to email; character caps to
// LinkedIn (LinkedIn connection notes are hard-capped at 300 by the platform;
// we hold 280 for safety). Mirrors the caps written into the SKILL.md files.
const EMAIL_CAPS = {
  default:        { bodyWords: 75, subjectWords: 7, previewWords: 12 },
  first_touch:    { bodyWords: 75, subjectWords: 7, previewWords: 12 },
  follow_up:      { bodyWords: 60, subjectWords: 7, previewWords: 12 },
  breakup:        { bodyWords: 55, subjectWords: 7, previewWords: 12 },
};
const LINKEDIN_CAPS = {
  connection_request: 280,   // platform hard limit ~300; safety margin
  post_accept:        1000,
  nurture_dm:         800,
  default:            280,
};

function wordCount(str) {
  if (!str || typeof str !== 'string') return 0;
  const t = str.trim();
  return t === '' ? 0 : t.split(/\s+/).length;
}

function scanBanned(text, banned) {
  if (!text || typeof text !== 'string') return [];
  const hay = text.toLowerCase();
  const hits = [];
  for (const phrase of banned) {
    if (!phrase) continue;
    if (hay.includes(String(phrase).toLowerCase())) hits.push(phrase);
  }
  return hits;
}

// ----------------------------------------------------------------------------
// validateOutreach -- core validator.
// ----------------------------------------------------------------------------
function validateOutreach(output, opts = {}) {
  const channel = opts.channel || null;
  const intent  = opts.intent  || null;
  const bannedExtra         = Array.isArray(opts.bannedExtra) ? opts.bannedExtra : [];
  const requiredDisclaimers = Array.isArray(opts.requiredDisclaimers) ? opts.requiredDisclaimers : [];

  const blocking = [];
  const warnings = [];
  const metrics  = {};

  const out = (output && typeof output === 'object') ? output : {};
  const banned = [...UNIVERSAL_BANNED, ...bannedExtra.map(b => String(b))];

  // ---- Fit / skip routing (channel-agnostic) -------------------------------
  // These do not block a send, but they pull the draft into the review lane.
  let fitReview = false;
  if (out.recommend_skip === true) {
    fitReview = true;
    warnings.push('recommend_skip=true: skill judged this prospect not worth a touch.');
  }
  if (out.fit === 'disqualified' || out.fit === 'weak') {
    fitReview = true;
    warnings.push(`fit=${out.fit}: route to manual review before sending.`);
  }

  // ---- Channel-specific length + content checks ----------------------------
  if (channel === 'email') {
    const email = (out.email && typeof out.email === 'object') ? out.email : {};
    const caps  = EMAIL_CAPS[intent] || EMAIL_CAPS.default;

    const bodyW    = wordCount(email.body);
    const subjW    = wordCount(email.subject);
    const previewW = wordCount(email.preview_text);
    metrics.body_words = bodyW;
    metrics.subject_words = subjW;
    metrics.preview_words = previewW;

    if (!email.body || bodyW === 0) blocking.push('email.body is empty.');
    if (bodyW > caps.bodyWords)
      blocking.push(`email.body is ${bodyW} words (cap ${caps.bodyWords} for ${intent || 'default'}).`);
    if (subjW > caps.subjectWords)
      blocking.push(`email.subject is ${subjW} words (cap ${caps.subjectWords}).`);
    if (email.preview_text && previewW > caps.previewWords)
      blocking.push(`email.preview_text is ${previewW} words (cap ${caps.previewWords}).`);

    const bannedHits = scanBanned(
      [email.subject, email.preview_text, email.body].filter(Boolean).join('\n'),
      banned
    );
    if (bannedHits.length) blocking.push(`banned phrasing in email: ${bannedHits.join('; ')}`);

    for (const d of requiredDisclaimers) {
      if (d && !(email.body || '').toLowerCase().includes(String(d).toLowerCase())) {
        blocking.push(`required disclaimer missing from email.body: "${d}"`);
      }
    }
  } else if (channel === 'linkedin') {
    const li  = (out.linkedin && typeof out.linkedin === 'object') ? out.linkedin : {};
    const cap = LINKEDIN_CAPS[intent] || LINKEDIN_CAPS.default;

    const body = typeof li.body === 'string' ? li.body : '';
    // Trust the measured length, not the model's self-reported character_count.
    const measured = body.length;
    metrics.char_count = measured;
    metrics.reported_char_count = (typeof li.character_count === 'number') ? li.character_count : null;

    if (!body) blocking.push('linkedin.body is empty.');
    if (measured > cap)
      blocking.push(`linkedin.body is ${measured} chars (cap ${cap} for ${intent || 'default'}).`);
    if (typeof li.character_count === 'number' && Math.abs(li.character_count - measured) > 5)
      warnings.push(`linkedin.character_count (${li.character_count}) disagrees with measured length (${measured}).`);

    const bannedHits = scanBanned(body, banned);
    if (bannedHits.length) blocking.push(`banned phrasing in linkedin.body: ${bannedHits.join('; ')}`);

    for (const d of requiredDisclaimers) {
      if (d && !body.toLowerCase().includes(String(d).toLowerCase())) {
        blocking.push(`required disclaimer missing from linkedin.body: "${d}"`);
      }
    }
  } else {
    warnings.push(`unknown channel "${channel}" -- content not length-validated.`);
  }

  const route = blocking.length > 0 ? 'reject' : (fitReview ? 'review' : 'send');
  return { ok: route === 'send', route, channel, intent, blocking, warnings, metrics };
}

// ----------------------------------------------------------------------------
// validateForSkill -- convenience wrapper that derives channel / intent /
// banned / disclaimers from the skill name and org_context, so the runner can
// call with a single line. Non-outreach skills pass through as 'send'.
// ----------------------------------------------------------------------------
function validateForSkill(skillName, output, orgContext) {
  const oc = orgContext || {};
  let channel = null;
  if (skillName === 'outreach-linkedin') channel = 'linkedin';
  else if (skillName === 'outreach-email') channel = 'email';

  if (!channel) {
    return { ok: true, route: 'send', channel: null, intent: null,
             blocking: [], warnings: [`${skillName} is not an outreach skill -- skipped validation.`],
             metrics: {} };
  }

  const intent = oc.step_intent
    || (channel === 'email' ? 'first_touch' : 'connection_request');
  const ge = oc.guardrails_extra || {};
  return validateOutreach(output, {
    channel,
    intent,
    bannedExtra:         Array.isArray(ge.banned_phrasings) ? ge.banned_phrasings : [],
    requiredDisclaimers: Array.isArray(ge.required_disclaimers) ? ge.required_disclaimers : [],
  });
}

module.exports = {
  validateForSkill,
  validateOutreach,
  UNIVERSAL_BANNED,
  EMAIL_CAPS,
  LINKEDIN_CAPS,
};
