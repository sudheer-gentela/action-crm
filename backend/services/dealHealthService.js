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

// ── Category 1: Close Date Credibility ──────────────────────

function scoreCloseDateCredibility(deal, config, bd) {
  const weights  = config.param_weights;
  const enabled  = config._isEnabled;
  const aiOn     = config._aiOn;
  let score = 100;
  const params = {};

  // 1a: Buyer-confirmed close date
  if (enabled('1a_close_confirmed')) {
    const aiSignal  = aiOn && deal.close_date_ai_confirmed;
    const confirmed = aiSignal || deal.close_date_user_confirmed;
    params['1a'] = {
      label: 'Buyer-confirmed close date', value: confirmed,
      ai: aiSignal, user: deal.close_date_user_confirmed,
      source: deal.close_date_ai_source,
      aiSuppressed: !aiOn && deal.close_date_ai_confirmed,
      impact: confirmed ? weights['1a_close_confirmed'] : 0
    };
    if (confirmed) score += weights['1a_close_confirmed'];
  }

  // 1b: Close date slipped (fully auto — no AI needed)
  if (enabled('1b_close_slipped')) {
    const slipped     = deal.close_date_push_count > 0;
    const pushPenalty = weights['1b_close_slipped'] * Math.min(deal.close_date_push_count, 3);
    params['1b'] = {
      label: 'Close date slipped', value: slipped,
      pushCount: deal.close_date_push_count, auto: true,
      impact: slipped ? pushPenalty : 0
    };
    if (slipped) score += pushPenalty;
  }

  // 1c: Close date tied to buyer event
  if (enabled('1c_buyer_event')) {
    const aiSignal  = aiOn && deal.buyer_event_ai_confirmed;
    const buyerEvent = aiSignal || deal.buyer_event_user_confirmed;
    params['1c'] = {
      label: 'Close date tied to buyer event', value: buyerEvent,
      ai: aiSignal, user: deal.buyer_event_user_confirmed,
      description: deal.buyer_event_description,
      aiSuppressed: !aiOn && deal.buyer_event_ai_confirmed,
      impact: buyerEvent ? weights['1c_buyer_event'] : 0
    };
    if (buyerEvent) score += weights['1c_buyer_event'];
  }

  bd.categories['1'] = { label: 'Close Date Credibility', score: Math.max(0, Math.min(100, score)) };
  bd.params = { ...bd.params, ...params };
  return Math.max(0, Math.min(100, score));
}

// ── Category 2: Buyer Engagement & Power ────────────────────

function scoreBuyerEngagement(deal, config, contacts, meetings, bd) {
  const weights = config.param_weights;
  const enabled = config._isEnabled;
  let score = 100;
  const params = {};

  if (enabled('2a_economic_buyer')) {
    const hasEcoBuyer = deal.economic_buyer_contact_id !== null ||
      contacts.some(c => c.role_type === 'economic_buyer' || c.role_type === 'decision_maker');
    params['2a'] = {
      label: 'Economic buyer identified', value: hasEcoBuyer,
      contact: contacts.find(c => c.id === deal.economic_buyer_contact_id),
      impact: hasEcoBuyer ? weights['2a_economic_buyer'] : 0
    };
    if (hasEcoBuyer) score += weights['2a_economic_buyer'];
  }

  if (enabled('2b_exec_meeting')) {
    const execTitles   = config.exec_titles || [];
    const execContacts = contacts.filter(c =>
      c.role_type === 'executive' ||
      execTitles.some(t => (c.title || '').toLowerCase().includes(t.toLowerCase()))
    );
    const execMeetingHeld = execContacts.length > 0 &&
      meetings.some(m => m.status === 'completed' || new Date(m.start_time) < new Date());
    params['2b'] = {
      label: 'Exec meeting held', value: execMeetingHeld, auto: true,
      execContacts: execContacts.map(c => `${c.first_name} ${c.last_name} (${c.title})`),
      impact: execMeetingHeld ? weights['2b_exec_meeting'] : 0
    };
    if (execMeetingHeld) score += weights['2b_exec_meeting'];
  }

  if (enabled('2c_multi_threaded')) {
    const minContacts    = config.multi_thread_min_contacts || 2;
    const meaningfulRoles = ['decision_maker','champion','influencer','economic_buyer','executive'];
    const stakeholders   = contacts.filter(c => meaningfulRoles.includes(c.role_type));
    const multiThreaded  = stakeholders.length >= minContacts;
    params['2c'] = {
      label: `Multi-threaded (≥${minContacts} stakeholders)`, value: multiThreaded, auto: true,
      count: stakeholders.length,
      impact: multiThreaded ? weights['2c_multi_threaded'] : 0
    };
    if (multiThreaded) score += weights['2c_multi_threaded'];
  }

  bd.categories['2'] = { label: 'Buyer Engagement & Power', score: Math.max(0, Math.min(100, score)) };
  bd.params = { ...bd.params, ...params };
  return Math.max(0, Math.min(100, score));
}

// ── Categories 3-6 with isEnabled + aiOn guards ──────────────

function scoreProcessCompletion(deal, config, contacts, meetings, bd) {
  const weights = config.param_weights;
  const enabled = config._isEnabled;
  const aiOn    = config._aiOn;
  let score = 100;
  const params = {};

  if (enabled('3a_legal_engaged')) {
    const legalTitles   = config.legal_titles || [];
    const procTitles    = config.procurement_titles || [];
    const legalContacts = contacts.filter(c =>
      ['legal','procurement'].includes(c.role_type) ||
      [...legalTitles, ...procTitles].some(t => (c.title || '').toLowerCase().includes(t.toLowerCase()))
    );
    const legalEngaged = deal.legal_engaged_user ||
      (aiOn && deal.legal_engaged_ai) ||
      legalContacts.some(() => meetings.some(m => new Date(m.start_time) < new Date()));
    params['3a'] = {
      label: 'Legal/procurement engaged', value: legalEngaged,
      ai: aiOn ? deal.legal_engaged_ai : false, user: deal.legal_engaged_user,
      aiSuppressed: !aiOn && deal.legal_engaged_ai, source: deal.legal_engaged_source,
      contacts: legalContacts.map(c => `${c.first_name} ${c.last_name}`),
      impact: legalEngaged ? weights['3a_legal_engaged'] : 0
    };
    if (legalEngaged) score += weights['3a_legal_engaged'];
  }

  if (enabled('3b_security_review')) {
    const secTitles   = config.security_titles || [];
    const secContacts = contacts.filter(c =>
      ['security','it'].includes(c.role_type) ||
      secTitles.some(t => (c.title || '').toLowerCase().includes(t.toLowerCase()))
    );
    const secReview = deal.security_review_user ||
      (aiOn && deal.security_review_ai) ||
      secContacts.some(() => meetings.some(m => new Date(m.start_time) < new Date()));
    params['3b'] = {
      label: 'Security/IT review started', value: secReview,
      ai: aiOn ? deal.security_review_ai : false, user: deal.security_review_user,
      aiSuppressed: !aiOn && deal.security_review_ai, source: deal.security_review_source,
      contacts: secContacts.map(c => `${c.first_name} ${c.last_name}`),
      impact: secReview ? weights['3b_security_review'] : 0
    };
    if (secReview) score += weights['3b_security_review'];
  }

  bd.categories['3'] = { label: 'Process Completion', score: Math.max(0, Math.min(100, score)) };
  bd.params = { ...bd.params, ...params };
  return Math.max(0, Math.min(100, score));
}

function scoreDealSizeRealism(deal, config, valueHistory, bd) {
  const weights = config.param_weights;
  const enabled = config._isEnabled;
  let score = 100;
  const params = {};

  if (enabled('4a_value_vs_segment')) {
    const dealValue  = parseFloat(deal.value) || 0;
    const multiplier = config.segment_size_multiplier || 2.0;
    let segmentAvg   = config.segment_avg_midmarket;
    if (dealValue < 10000)      segmentAvg = config.segment_avg_smb;
    else if (dealValue > 50000) segmentAvg = config.segment_avg_enterprise;
    const oversized = dealValue > (segmentAvg * multiplier);
    params['4a'] = {
      label: `Deal value >${multiplier}× segment avg`, value: oversized, auto: true,
      dealValue, segmentAvg, ratio: segmentAvg > 0 ? (dealValue / segmentAvg).toFixed(1) : 0,
      impact: oversized ? weights['4a_value_vs_segment'] : 0
    };
    if (oversized) score += weights['4a_value_vs_segment'];
  }

  if (enabled('4b_deal_expanded')) {
    const thirtyDaysAgo   = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recentExpansion = valueHistory.some(h =>
      new Date(h.changed_at) > thirtyDaysAgo && h.new_value > h.old_value
    );
    params['4b'] = {
      label: 'Deal expanded in last 30 days', value: recentExpansion, auto: true,
      history: valueHistory.slice(0, 3),
      impact: recentExpansion ? weights['4b_deal_expanded'] : 0
    };
    if (recentExpansion) score += weights['4b_deal_expanded'];
  }

  if (enabled('4c_scope_approved')) {
    const aiSignal      = config._aiOn && deal.scope_approved_ai;
    const scopeApproved = deal.scope_approved_user || aiSignal;
    params['4c'] = {
      label: 'Buyer explicitly approved scope', value: scopeApproved,
      ai: aiSignal, user: deal.scope_approved_user,
      aiSuppressed: !config._aiOn && deal.scope_approved_ai,
      source: deal.scope_approved_source,
      impact: scopeApproved ? weights['4c_scope_approved'] : 0
    };
    if (scopeApproved) score += weights['4c_scope_approved'];
  }

  bd.categories['4'] = { label: 'Deal Size Realism', score: Math.max(0, Math.min(100, score)) };
  bd.params = { ...bd.params, ...params };
  return Math.max(0, Math.min(100, score));
}

function scoreCompetitiveRisk(deal, config, bd) {
  const weights = config.param_weights;
  const enabled = config._isEnabled;
  const aiOn    = config._aiOn;
  let score = 100;
  const params = {};

  if (enabled('5a_competitive')) {
    const competitive = deal.competitive_deal_user || (aiOn && deal.competitive_deal_ai);
    params['5a'] = {
      label: 'Competitive deal', value: competitive,
      ai: aiOn ? deal.competitive_deal_ai : false, user: deal.competitive_deal_user,
      aiSuppressed: !aiOn && deal.competitive_deal_ai,
      competitors: deal.competitive_competitors || [],
      impact: competitive ? weights['5a_competitive'] : 0
    };
    if (competitive) score += weights['5a_competitive'];
  }

  if (enabled('5b_price_sensitivity')) {
    const priceSensitive = deal.price_sensitivity_user || (aiOn && deal.price_sensitivity_ai);
    params['5b'] = {
      label: 'Price sensitivity flagged', value: priceSensitive,
      ai: aiOn ? deal.price_sensitivity_ai : false, user: deal.price_sensitivity_user,
      aiSuppressed: !aiOn && deal.price_sensitivity_ai, source: deal.price_sensitivity_source,
      impact: priceSensitive ? weights['5b_price_sensitivity'] : 0
    };
    if (priceSensitive) score += weights['5b_price_sensitivity'];
  }

  if (enabled('5c_discount_pending')) {
    const discountPending = deal.discount_pending_user || (aiOn && deal.discount_pending_ai);
    params['5c'] = {
      label: 'Discount approval pending', value: discountPending,
      ai: aiOn ? deal.discount_pending_ai : false, user: deal.discount_pending_user,
      aiSuppressed: !aiOn && deal.discount_pending_ai,
      impact: discountPending ? weights['5c_discount_pending'] : 0
    };
    if (discountPending) score += weights['5c_discount_pending'];
  }

  bd.categories['5'] = { label: 'Competitive & Pricing Risk', score: Math.max(0, Math.min(100, score)) };
  bd.params = { ...bd.params, ...params };
  return Math.max(0, Math.min(100, score));
}

function scoreMomentum(deal, config, meetings, emails, bd) {
  const weights = config.param_weights;
  const enabled = config._isEnabled;
  let score = 100;
  const params = {};

  if (enabled('6a_no_meeting_14d')) {
    const noMeetingDays = config.no_meeting_days || 14;
    const cutoff        = new Date(Date.now() - noMeetingDays * 24 * 60 * 60 * 1000);
    const recentMeeting = meetings.some(m => new Date(m.start_time) > cutoff);
    const lastMeeting   = meetings.length > 0
      ? meetings.reduce((a, b) => new Date(a.start_time) > new Date(b.start_time) ? a : b)
      : null;
    const daysSince = lastMeeting ? Math.floor((Date.now() - new Date(lastMeeting.start_time)) / 86400000) : null;
    params['6a'] = {
      label: `No buyer meeting in last ${noMeetingDays} days`, value: !recentMeeting, auto: true,
      daysSinceLastMeeting: daysSince,
      impact: (!recentMeeting && meetings.length > 0) ? weights['6a_no_meeting_14d'] : 0
    };
    if (!recentMeeting && meetings.length > 0) score += weights['6a_no_meeting_14d'];
  }

  if (enabled('6b_slow_response')) {
    const multiplier   = config.response_time_multiplier || 1.5;
    const slowResponse = calculateSlowResponse(emails, multiplier);
    params['6b'] = {
      label: 'Avg response time > historical norm', value: slowResponse.isSlow, auto: true,
      avgHours: slowResponse.avgHours, normHours: slowResponse.normHours,
      impact: slowResponse.isSlow ? weights['6b_slow_response'] : 0
    };
    if (slowResponse.isSlow) score += weights['6b_slow_response'];
  }

  bd.categories['6'] = { label: 'Momentum & Activity', score: Math.max(0, Math.min(100, score)) };
  bd.params = { ...bd.params, ...params };
  return Math.max(0, Math.min(100, score));
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
