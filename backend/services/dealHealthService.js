/**
 * Deal Health Scoring Service
 * Evaluates all 16 atomic parameters across 6 categories
 * Phases 1 (auto), 2 (manual signals), 3 (AI signals)
 */

const { pool } = require('../config/database');

// ── Main scoring entry point ─────────────────────────────────

async function scoreDeal(dealId, userId) {
  const client = await pool.connect();
  try {
    const [deal, config, contacts, meetings, emails, valueHistory] =
      await Promise.all([
        getDeal(client, dealId, userId),
        getConfig(client, userId),
        getContacts(client, dealId),
        getMeetings(client, dealId),
        getEmails(client, dealId),
        getValueHistory(client, dealId)
      ]);

    if (!deal) throw new Error(`Deal ${dealId} not found`);

    // Resolve enabled map — default all true if not set
    const enabled = config.params_enabled || {};
    const isEnabled = key => enabled[key] !== false;

    // Expose to category scorers via config
    config._isEnabled = isEnabled;
    config._aiOn      = config.ai_enabled !== false;

    const breakdown = { categories: {}, params: {}, signals: {} };

    // ── 6 Category scores ────────────────────────────────────
    const cat1 = scoreCloseDateCredibility(deal, config, breakdown);
    const cat2 = scoreBuyerEngagement(deal, config, contacts, meetings, breakdown);
    const cat3 = scoreProcessCompletion(deal, config, contacts, meetings, breakdown);
    const cat4 = scoreDealSizeRealism(deal, config, valueHistory, breakdown);
    const cat5 = scoreCompetitiveRisk(deal, config, breakdown);
    const cat6 = scoreMomentum(deal, config, meetings, emails, breakdown);

    // Weighted total
    const total = Math.round(
      (cat1 * config.weight_close_date / 100) +
      (cat2 * config.weight_buyer_engagement / 100) +
      (cat3 * config.weight_process / 100) +
      (cat4 * config.weight_deal_size / 100) +
      (cat5 * config.weight_competitive / 100) +
      (cat6 * config.weight_momentum / 100)
    );

    const score   = Math.max(0, Math.min(100, total));
    const health  = score >= config.threshold_healthy ? 'healthy'
                  : score >= config.threshold_watch   ? 'watch'
                  : 'risk';

    // Persist
    await client.query(
      `UPDATE deals
       SET health = $1,
           health_score = $2,
           health_score_breakdown = $3,
           health_score_updated_at = NOW(),
           updated_at = NOW()
       WHERE id = $4`,
      [health, score, JSON.stringify(breakdown), dealId]
    );

    return { dealId, score, health, breakdown };

  } finally {
    client.release();
  }
}

// ── Scoring model ────────────────────────────────────────────
//
// EARN-POINTS HYBRID MODEL
//
// For categories that have positive params (1-4):
//   score = (positivePointsEarned / maxPossiblePositive) * 100 - negativePenalties
//
// For pure-risk categories (5, 6 — all negative params):
//   score = 100 - negativePenalties
//
// Parameter states:
//   confirmed → contributes its full weight (positive adds, negative deducts)
//   unknown   → earns nothing (no bonus, no penalty — deal must prove itself)
//   absent    → earns nothing (explicitly not applicable)
//
// Result: empty deal scores ~30 (Risk). Must earn its way to Healthy.
//
// Helper — score one category given an array of {w, state} param descriptors
function scoreCategory(params) {
  const maxPositive    = params.filter(p => p.w > 0).reduce((s, p) => s + p.w, 0);
  let positiveEarned   = 0;
  let negativePenalty  = 0;

  for (const p of params) {
    if (p.state === 'confirmed') {
      if (p.w > 0) positiveEarned += p.w;
      else         negativePenalty += Math.abs(p.w);
    }
  }

  if (maxPositive === 0) {
    // Pure-risk category — starts at 100, only negatives can fire
    return Math.max(0, 100 - negativePenalty);
  }

  const earnedPct = Math.round((positiveEarned / maxPositive) * 100);
  return Math.max(0, Math.min(100, earnedPct - negativePenalty));
}

// ── Category 1: Close Date Credibility ──────────────────────

function scoreCloseDateCredibility(deal, config, bd) {
  const W      = config.param_weights;
  const enabled = config._isEnabled;
  const aiOn   = config._aiOn;
  const params = {};
  const scored = [];

  // 1a: Buyer-confirmed close date — POSITIVE, NON-AUTO
  if (enabled('1a_close_confirmed')) {
    const aiSig   = aiOn && deal.close_date_ai_confirmed;
    const confirmed = Boolean(aiSig) || Boolean(deal.close_date_user_confirmed);
    const state   = confirmed ? 'confirmed'
                  : deal.close_date_user_confirmed === false ? 'absent'
                  : 'unknown';
    scored.push({ w: W['1a_close_confirmed'], state });
    params['1a'] = { label: 'Buyer-confirmed close date', state, value: confirmed,
      ai: aiSig, user: deal.close_date_user_confirmed, source: deal.close_date_ai_source,
      aiSuppressed: !aiOn && deal.close_date_ai_confirmed,
      impact: state === 'confirmed' ? W['1a_close_confirmed'] : 0 };
  }

  // 1b: Close date slipped — NEGATIVE, AUTO
  if (enabled('1b_close_slipped')) {
    const count   = deal.close_date_push_count || 0;
    const slipped = count > 0;
    const penalty = W['1b_close_slipped'] * Math.min(count, 3); // already negative weight
    scored.push({ w: slipped ? penalty : 0, state: slipped ? 'confirmed' : 'absent' });
    params['1b'] = { label: 'Close date slipped', state: slipped ? 'confirmed' : 'absent',
      value: slipped, pushCount: count, auto: true, impact: slipped ? penalty : 0 };
  }

  // 1c: Close date tied to buyer event — POSITIVE, NON-AUTO
  if (enabled('1c_buyer_event')) {
    const aiSig    = aiOn && deal.buyer_event_ai_confirmed;
    const confirmed = Boolean(aiSig) || Boolean(deal.buyer_event_user_confirmed);
    const state    = confirmed ? 'confirmed'
                   : deal.buyer_event_user_confirmed === false ? 'absent'
                   : 'unknown';
    scored.push({ w: W['1c_buyer_event'], state });
    params['1c'] = { label: 'Close date tied to buyer event', state, value: confirmed,
      ai: aiSig, user: deal.buyer_event_user_confirmed, description: deal.buyer_event_description,
      aiSuppressed: !aiOn && deal.buyer_event_ai_confirmed,
      impact: state === 'confirmed' ? W['1c_buyer_event'] : 0 };
  }

  const catScore = scoreCategory(scored);
  bd.categories['1'] = { label: 'Close Date Credibility', score: catScore };
  bd.params = { ...bd.params, ...params };
  return catScore;
}

// ── Category 2: Buyer Engagement & Power ────────────────────

function scoreBuyerEngagement(deal, config, contacts, meetings, bd) {
  const W       = config.param_weights;
  const enabled = config._isEnabled;
  const params  = {};
  const scored  = [];

  // 2a: Economic buyer — POSITIVE, NON-AUTO (manual tagging)
  if (enabled('2a_economic_buyer')) {
    const found = deal.economic_buyer_contact_id !== null ||
      contacts.some(c => c.role_type === 'economic_buyer' || c.role_type === 'decision_maker');
    // if contacts exist but none tagged → absent; no contacts yet → unknown
    const state = found ? 'confirmed' : contacts.length > 0 ? 'absent' : 'unknown';
    scored.push({ w: W['2a_economic_buyer'], state });
    params['2a'] = { label: 'Economic buyer identified', state, value: found,
      contact: contacts.find(c => c.id === deal.economic_buyer_contact_id),
      impact: state === 'confirmed' ? W['2a_economic_buyer'] : 0 };
  }

  // 2b: Exec meeting — POSITIVE, AUTO
  if (enabled('2b_exec_meeting')) {
    const execTitles  = config.exec_titles || [];
    const execContacts = contacts.filter(c =>
      c.role_type === 'executive' ||
      execTitles.some(t => (c.title || '').toLowerCase().includes(t.toLowerCase()))
    );
    const held  = execContacts.length > 0 &&
      meetings.some(m => m.status === 'completed' || new Date(m.start_time) < new Date());
    const state = held ? 'confirmed' : 'absent';
    scored.push({ w: W['2b_exec_meeting'], state });
    params['2b'] = { label: 'Exec meeting held', state, value: held, auto: true,
      execContacts: execContacts.map(c => `${c.first_name} ${c.last_name} (${c.title})`),
      impact: held ? W['2b_exec_meeting'] : 0 };
  }

  // 2c: Multi-threaded — POSITIVE, AUTO
  if (enabled('2c_multi_threaded')) {
    const min    = config.multi_thread_min_contacts || 2;
    const roles  = ['decision_maker','champion','influencer','economic_buyer','executive'];
    const count  = contacts.filter(c => roles.includes(c.role_type)).length;
    const met    = count >= min;
    const state  = met ? 'confirmed' : 'absent';
    scored.push({ w: W['2c_multi_threaded'], state });
    params['2c'] = { label: `Multi-threaded (≥${min} stakeholders)`, state, value: met,
      auto: true, count,
      impact: met ? W['2c_multi_threaded'] : 0 };
  }

  const catScore = scoreCategory(scored);
  bd.categories['2'] = { label: 'Buyer Engagement & Power', score: catScore };
  bd.params = { ...bd.params, ...params };
  return catScore;
}

// ── Category 3: Process Completion ──────────────────────────

function scoreProcessCompletion(deal, config, contacts, meetings, bd) {
  const W       = config.param_weights;
  const enabled = config._isEnabled;
  const aiOn    = config._aiOn;
  const params  = {};
  const scored  = [];

  // 3a: Legal/procurement — POSITIVE, NON-AUTO
  if (enabled('3a_legal_engaged')) {
    const legalTitles = config.legal_titles || [];
    const procTitles  = config.procurement_titles || [];
    const legalCs     = contacts.filter(c =>
      ['legal','procurement'].includes(c.role_type) ||
      [...legalTitles, ...procTitles].some(t => (c.title||'').toLowerCase().includes(t.toLowerCase()))
    );
    const confirmed = Boolean(deal.legal_engaged_user) ||
      (aiOn && Boolean(deal.legal_engaged_ai)) ||
      legalCs.some(() => meetings.some(m => new Date(m.start_time) < new Date()));
    const state = confirmed ? 'confirmed'
                : deal.legal_engaged_user === false ? 'absent'
                : 'unknown';
    scored.push({ w: W['3a_legal_engaged'], state });
    params['3a'] = { label: 'Legal/procurement engaged', state, value: confirmed,
      ai: aiOn ? deal.legal_engaged_ai : false, user: deal.legal_engaged_user,
      aiSuppressed: !aiOn && deal.legal_engaged_ai, source: deal.legal_engaged_source,
      contacts: legalCs.map(c => `${c.first_name} ${c.last_name}`),
      impact: state === 'confirmed' ? W['3a_legal_engaged'] : 0 };
  }

  // 3b: Security/IT review — POSITIVE, NON-AUTO
  if (enabled('3b_security_review')) {
    const secTitles = config.security_titles || [];
    const secCs     = contacts.filter(c =>
      ['security','it'].includes(c.role_type) ||
      secTitles.some(t => (c.title||'').toLowerCase().includes(t.toLowerCase()))
    );
    const confirmed = Boolean(deal.security_review_user) ||
      (aiOn && Boolean(deal.security_review_ai)) ||
      secCs.some(() => meetings.some(m => new Date(m.start_time) < new Date()));
    const state = confirmed ? 'confirmed'
                : deal.security_review_user === false ? 'absent'
                : 'unknown';
    scored.push({ w: W['3b_security_review'], state });
    params['3b'] = { label: 'Security/IT review started', state, value: confirmed,
      ai: aiOn ? deal.security_review_ai : false, user: deal.security_review_user,
      aiSuppressed: !aiOn && deal.security_review_ai, source: deal.security_review_source,
      contacts: secCs.map(c => `${c.first_name} ${c.last_name}`),
      impact: state === 'confirmed' ? W['3b_security_review'] : 0 };
  }

  const catScore = scoreCategory(scored);
  bd.categories['3'] = { label: 'Process Completion', score: catScore };
  bd.params = { ...bd.params, ...params };
  return catScore;
}

// ── Category 4: Deal Size Realism ───────────────────────────

function scoreDealSizeRealism(deal, config, valueHistory, bd) {
  const W       = config.param_weights;
  const enabled = config._isEnabled;
  const params  = {};
  const scored  = [];

  // 4a: Oversized — NEGATIVE, AUTO
  if (enabled('4a_value_vs_segment')) {
    const dealValue  = parseFloat(deal.value) || 0;
    const mult       = config.segment_size_multiplier || 2.0;
    let segAvg       = config.segment_avg_midmarket;
    if (dealValue < 10000)      segAvg = config.segment_avg_smb;
    else if (dealValue > 50000) segAvg = config.segment_avg_enterprise;
    const oversized  = dealValue > (segAvg * mult);
    scored.push({ w: oversized ? W['4a_value_vs_segment'] : 0, state: oversized ? 'confirmed' : 'absent' });
    params['4a'] = { label: `Deal value >${mult}× segment avg`, state: oversized ? 'confirmed' : 'absent',
      value: oversized, auto: true, dealValue, segmentAvg: segAvg,
      ratio: segAvg > 0 ? (dealValue / segAvg).toFixed(1) : 0,
      impact: oversized ? W['4a_value_vs_segment'] : 0 };
  }

  // 4b: Deal expanded — POSITIVE, AUTO
  if (enabled('4b_deal_expanded')) {
    const cutoff  = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const expanded = valueHistory.some(h => new Date(h.changed_at) > cutoff && h.new_value > h.old_value);
    const state   = expanded ? 'confirmed' : 'absent';
    scored.push({ w: W['4b_deal_expanded'], state });
    params['4b'] = { label: 'Deal expanded in last 30 days', state, value: expanded,
      auto: true, history: valueHistory.slice(0, 3),
      impact: expanded ? W['4b_deal_expanded'] : 0 };
  }

  // 4c: Scope approved — POSITIVE, NON-AUTO
  if (enabled('4c_scope_approved')) {
    const aiSig    = config._aiOn && deal.scope_approved_ai;
    const confirmed = Boolean(deal.scope_approved_user) || Boolean(aiSig);
    const state    = confirmed ? 'confirmed'
                   : deal.scope_approved_user === false ? 'absent'
                   : 'unknown';
    scored.push({ w: W['4c_scope_approved'], state });
    params['4c'] = { label: 'Buyer explicitly approved scope', state, value: confirmed,
      ai: aiSig, user: deal.scope_approved_user,
      aiSuppressed: !config._aiOn && deal.scope_approved_ai,
      source: deal.scope_approved_source,
      impact: state === 'confirmed' ? W['4c_scope_approved'] : 0 };
  }

  const catScore = scoreCategory(scored);
  bd.categories['4'] = { label: 'Deal Size Realism', score: catScore };
  bd.params = { ...bd.params, ...params };
  return catScore;
}

// ── Category 5: Competitive & Pricing Risk ───────────────────
// Pure-risk category — starts at 100, only negatives fire

function scoreCompetitiveRisk(deal, config, bd) {
  const W       = config.param_weights;
  const enabled = config._isEnabled;
  const aiOn    = config._aiOn;
  const params  = {};
  const scored  = [];

  if (enabled('5a_competitive')) {
    const val   = deal.competitive_deal_user || (aiOn && deal.competitive_deal_ai);
    const state = val ? 'confirmed' : 'absent';
    scored.push({ w: val ? W['5a_competitive'] : 0, state });
    params['5a'] = { label: 'Competitive deal', state, value: val,
      ai: aiOn ? deal.competitive_deal_ai : false, user: deal.competitive_deal_user,
      aiSuppressed: !aiOn && deal.competitive_deal_ai,
      competitors: deal.competitive_competitors || [],
      impact: val ? W['5a_competitive'] : 0 };
  }

  if (enabled('5b_price_sensitivity')) {
    const val   = deal.price_sensitivity_user || (aiOn && deal.price_sensitivity_ai);
    const state = val ? 'confirmed' : 'absent';
    scored.push({ w: val ? W['5b_price_sensitivity'] : 0, state });
    params['5b'] = { label: 'Price sensitivity flagged', state, value: val,
      ai: aiOn ? deal.price_sensitivity_ai : false, user: deal.price_sensitivity_user,
      aiSuppressed: !aiOn && deal.price_sensitivity_ai, source: deal.price_sensitivity_source,
      impact: val ? W['5b_price_sensitivity'] : 0 };
  }

  if (enabled('5c_discount_pending')) {
    const val   = deal.discount_pending_user || (aiOn && deal.discount_pending_ai);
    const state = val ? 'confirmed' : 'absent';
    scored.push({ w: val ? W['5c_discount_pending'] : 0, state });
    params['5c'] = { label: 'Discount approval pending', state, value: val,
      ai: aiOn ? deal.discount_pending_ai : false, user: deal.discount_pending_user,
      aiSuppressed: !aiOn && deal.discount_pending_ai,
      impact: val ? W['5c_discount_pending'] : 0 };
  }

  const catScore = scoreCategory(scored);
  bd.categories['5'] = { label: 'Competitive & Pricing Risk', score: catScore };
  bd.params = { ...bd.params, ...params };
  return catScore;
}

// ── Category 6: Momentum & Activity ─────────────────────────
// Pure-risk category — starts at 100, only negatives fire (on real evidence)

function scoreMomentum(deal, config, meetings, emails, bd) {
  const W       = config.param_weights;
  const enabled = config._isEnabled;
  const params  = {};
  const scored  = [];

  // 6a: No recent meeting — NEGATIVE, AUTO
  // Only fires if meetings exist but are stale (brand-new deal with no meetings stays neutral)
  if (enabled('6a_no_meeting_14d')) {
    const days       = config.no_meeting_days || 14;
    const cutoff     = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const hasRecent  = meetings.some(m => new Date(m.start_time) > cutoff);
    const lastMeet   = meetings.length > 0
      ? meetings.reduce((a, b) => new Date(a.start_time) > new Date(b.start_time) ? a : b)
      : null;
    const daysSince  = lastMeet ? Math.floor((Date.now() - new Date(lastMeet.start_time)) / 86400000) : null;
    const penalise   = !hasRecent && meetings.length > 0;
    scored.push({ w: penalise ? W['6a_no_meeting_14d'] : 0, state: penalise ? 'confirmed' : 'absent' });
    params['6a'] = { label: `No buyer meeting in last ${days} days`,
      state: penalise ? 'confirmed' : 'absent', value: !hasRecent,
      auto: true, daysSinceLastMeeting: daysSince,
      impact: penalise ? W['6a_no_meeting_14d'] : 0 };
  }

  // 6b: Slow response — NEGATIVE, AUTO
  if (enabled('6b_slow_response')) {
    const mult   = config.response_time_multiplier || 1.5;
    const slow   = calculateSlowResponse(emails, mult);
    scored.push({ w: slow.isSlow ? W['6b_slow_response'] : 0, state: slow.isSlow ? 'confirmed' : 'absent' });
    params['6b'] = { label: 'Avg response time > historical norm',
      state: slow.isSlow ? 'confirmed' : 'absent', value: slow.isSlow,
      auto: true, avgHours: slow.avgHours, normHours: slow.normHours,
      impact: slow.isSlow ? W['6b_slow_response'] : 0 };
  }

  const catScore = scoreCategory(scored);
  bd.categories['6'] = { label: 'Momentum & Activity', score: catScore };
  bd.params = { ...bd.params, ...params };
  return catScore;
}

// ── Helpers ──────────────────────────────────────────────────

function calculateSlowResponse(emails, multiplier) {
  const pairs = [];
  const sent = emails.filter(e => e.direction === 'sent').sort((a,b) => new Date(a.sent_at) - new Date(b.sent_at));
  const recv = emails.filter(e => e.direction === 'received').sort((a,b) => new Date(a.sent_at) - new Date(b.sent_at));

  sent.forEach(s => {
    const reply = recv.find(r => new Date(r.sent_at) > new Date(s.sent_at));
    if (reply) {
      const hours = (new Date(reply.sent_at) - new Date(s.sent_at)) / 3600000;
      if (hours < 720) pairs.push(hours); // ignore >30 day gaps
    }
  });

  if (pairs.length < 2) return { isSlow: false, avgHours: null, normHours: null };

  const avg  = pairs.reduce((a,b) => a+b, 0) / pairs.length;
  const norm = pairs.slice(0, Math.floor(pairs.length / 2))
                    .reduce((a,b) => a+b, 0) / Math.floor(pairs.length / 2);
  return { isSlow: avg > norm * multiplier, avgHours: Math.round(avg), normHours: Math.round(norm) };
}

async function getDeal(client, dealId, userId) {
  const r = await client.query('SELECT * FROM deals WHERE id = $1', [dealId]);
  return r.rows[0] || null;
}

async function getConfig(client, userId) {
  const r = await client.query(
    'SELECT * FROM deal_health_config WHERE user_id = $1', [userId]
  );
  if (r.rows.length === 0) {
    // Insert defaults and return
    const ins = await client.query(
      'INSERT INTO deal_health_config (user_id) VALUES ($1) RETURNING *', [userId]
    );
    return parseConfig(ins.rows[0]);
  }
  return parseConfig(r.rows[0]);
}

function parseConfig(row) {
  return {
    ...row,
    param_weights:       typeof row.param_weights       === 'string' ? JSON.parse(row.param_weights)       : row.param_weights,
    exec_titles:         typeof row.exec_titles         === 'string' ? JSON.parse(row.exec_titles)         : row.exec_titles,
    legal_titles:        typeof row.legal_titles        === 'string' ? JSON.parse(row.legal_titles)        : row.legal_titles,
    procurement_titles:  typeof row.procurement_titles  === 'string' ? JSON.parse(row.procurement_titles)  : row.procurement_titles,
    security_titles:     typeof row.security_titles     === 'string' ? JSON.parse(row.security_titles)     : row.security_titles,
  };
}

async function getContacts(client, dealId) {
  const r = await client.query(
    `SELECT c.*, dc.role as deal_role
     FROM contacts c
     LEFT JOIN deal_contacts dc ON dc.contact_id = c.id AND dc.deal_id = $1
     LEFT JOIN accounts a ON c.account_id = a.id
     WHERE dc.deal_id = $1`,
    [dealId]
  );
  return r.rows;
}

async function getMeetings(client, dealId) {
  const r = await client.query(
    'SELECT * FROM meetings WHERE deal_id = $1 ORDER BY start_time DESC', [dealId]
  );
  return r.rows;
}

async function getEmails(client, dealId) {
  const r = await client.query(
    'SELECT * FROM emails WHERE deal_id = $1 ORDER BY sent_at ASC', [dealId]
  );
  return r.rows;
}

async function getValueHistory(client, dealId) {
  const r = await client.query(
    'SELECT * FROM deal_value_history WHERE deal_id = $1 ORDER BY changed_at DESC', [dealId]
  );
  return r.rows;
}

// ── AI Signal Detection ──────────────────────────────────────

async function applyAISignals(dealId, analysisResult, sourceType, userId) {
  // Respect AI enabled setting — bail out immediately if AI is off
  if (userId) {
    const cfg = await pool.query('SELECT ai_enabled FROM deal_health_config WHERE user_id = $1', [userId]);
    if (cfg.rows.length > 0 && cfg.rows[0].ai_enabled === false) {
      console.log(`AI signals skipped for deal ${dealId} — AI disabled by user`);
      return {};
    }
  }

  const signals = {};
  const text = JSON.stringify(analysisResult).toLowerCase();

  // 1a: Close date confirmed
  if (/confirmed.*close|close.*date.*agreed|target.*date.*confirmed|committed.*by/i.test(text)) {
    signals.close_date_ai_confirmed = true;
    signals.close_date_ai_source = sourceType;
    signals.close_date_ai_confidence = 0.8;
  }

  // 1c: Buyer event
  if (/budget.*cycle|board.*meeting|fiscal.*year|quarter.*end|procurement.*cycle/i.test(text)) {
    signals.buyer_event_ai_confirmed = true;
    signals.buyer_event_ai_source = sourceType;
  }

  // 3a: Legal/procurement
  if (/legal.*review|procurement|contract.*redline|msa|nda|sow|vendor.*approval|legal.*team/i.test(text)) {
    signals.legal_engaged_ai = true;
    signals.legal_engaged_source = sourceType;
  }

  // 3b: Security/IT
  if (/security.*review|soc2|penetration.*test|it.*review|information.*security|security.*questionnaire|compliance.*review/i.test(text)) {
    signals.security_review_ai = true;
    signals.security_review_source = sourceType;
  }

  // 4c: Scope approved
  if (/scope.*approved|agreed.*on.*scope|proposal.*accepted|confirmed.*the.*plan|approved.*the.*proposal/i.test(text)) {
    signals.scope_approved_ai = true;
    signals.scope_approved_source = sourceType;
  }

  // 5b: Price sensitivity
  if (/budget.*constraint|too.*expensive|price.*concern|can.*you.*do.*better|need.*to.*justify.*cost|checking.*with.*finance/i.test(text)) {
    signals.price_sensitivity_ai = true;
    signals.price_sensitivity_source = sourceType;
  }

  // 5c: Discount pending
  if (/discount.*request|pricing.*exception|approval.*needed.*discount|special.*pricing/i.test(text)) {
    signals.discount_pending_ai = true;
  }

  if (Object.keys(signals).length > 0) {
    const setClauses = Object.keys(signals).map((k, i) => `${k} = $${i + 2}`).join(', ');
    await pool.query(
      `UPDATE deals SET ${setClauses}, updated_at = NOW() WHERE id = $1`,
      [dealId, ...Object.values(signals)]
    );
  }

  return signals;
}

// ── Competitor Detection ─────────────────────────────────────

async function detectCompetitors(dealId, userId, text) {
  const client = await pool.connect();
  try {
    // Check AI enabled
    const cfgCheck = await client.query('SELECT ai_enabled FROM deal_health_config WHERE user_id = $1', [userId]);
    if (cfgCheck.rows.length > 0 && cfgCheck.rows[0].ai_enabled === false) {
      return [];
    }

    const r = await client.query(
      'SELECT * FROM competitors WHERE user_id = $1', [userId]
    );
    const competitors = r.rows;
    const found = [];

    competitors.forEach(comp => {
      const names = [comp.name, ...(comp.aliases || [])];
      const hit = names.find(n => text.toLowerCase().includes(n.toLowerCase()));
      if (hit) found.push({ id: comp.id, name: comp.name, matched: hit });
    });

    if (found.length > 0) {
      await client.query(
        `UPDATE deals
         SET competitive_deal_ai = true,
             competitive_competitors = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [JSON.stringify(found), dealId]
      );
    }

    return found;
  } finally {
    client.release();
  }
}

module.exports = { scoreDeal, applyAISignals, detectCompetitors };
