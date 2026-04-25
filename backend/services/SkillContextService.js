// ============================================================================
// services/SkillContextService.js
//
// Assembles the canonical prospect payload (per gowarm-prospect.json schema)
// for the Skills Runner PoC. Owns the org+user override merge logic for
// org_context.
//
// Called from routes/skill-context.routes.js.
//
// Inputs:
//   prospectId (int) - required
//   orgId      (int) - required (looked up before this is called)
//   asUserId   (int) - optional. When provided, merges user-level config
//                       overrides on top of org defaults.
//
// Output: the canonical payload shape consumed by skills.
// ============================================================================

const { pool } = require('../config/database');

// ─────────────────────────────────────────────────────────────────────────────
// safeQuery: tolerates missing tables/columns in dev environments.
// ─────────────────────────────────────────────────────────────────────────────
async function safeQuery(client, sql, params) {
  try {
    const r = await client.query(sql, params);
    return r.rows;
  } catch (err) {
    if (err.code === '42P01' || err.code === '42703') {
      console.warn('[skill-context] Optional query skipped:', err.message);
      return [];
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Title-based seniority and function inference.
// Naïve but good enough until we have real LinkedIn enrichment.
// ─────────────────────────────────────────────────────────────────────────────
function inferSeniority(title) {
  if (!title) return null;
  const t = title.toLowerCase();
  if (/\b(founder|co-founder|ceo|coo|cfo|cto|cmo|cro|cpo|cio|chief)\b/.test(t)) return 'c_level';
  if (/\b(vp|vice president|svp|evp)\b/.test(t)) return 'vp';
  if (/\b(director|head of)\b/.test(t)) return 'director';
  if (/\b(manager|lead)\b/.test(t)) return 'manager';
  return 'ic';
}

function inferFunction(title) {
  if (!title) return null;
  const t = title.toLowerCase();
  if (/\b(sales|account exec|ae|sdr|bdr|revenue)\b/.test(t)) return 'sales';
  if (/\b(revops|rev ops|sales ops|sales operations)\b/.test(t)) return 'revops';
  if (/\b(marketing|growth|demand gen|brand)\b/.test(t)) return 'marketing';
  if (/\b(engineer|developer|architect|cto|technical)\b/.test(t)) return 'engineering';
  if (/\b(product|pm|product manager)\b/.test(t)) return 'product';
  if (/\b(finance|cfo|controller)\b/.test(t)) return 'finance';
  if (/\b(people|hr|talent|recruiting)\b/.test(t)) return 'people';
  if (/\b(operations|coo|ops)\b/.test(t)) return 'operations';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Split the prospect.linkedin_activity array into the three buckets the
// skill expects: posts, comments, reactions.
// ─────────────────────────────────────────────────────────────────────────────
function splitLinkedInActivity(activity) {
  const out = { posts: [], comments: [], reactions: [] };
  if (!Array.isArray(activity)) return out;

  for (const item of activity) {
    if (!item || !item.kind) continue;

    if (item.kind === 'post') {
      out.posts.push({
        id: item.id,
        posted_at: item.occurred_at,
        text: item.text,
        engagement_count: item.engagement_count ?? null,
        topic_tags: item.topic_tags || [],
      });
    } else if (item.kind === 'comment') {
      out.comments.push({
        id: item.id,
        commented_at: item.occurred_at,
        text: item.text,
        parent_post_summary: item.parent_post_summary,
        parent_author: item.parent_author ?? null,
      });
    } else if (item.kind === 'reaction') {
      out.reactions.push({
        id: item.id,
        reacted_at: item.occurred_at,
        reaction_type: item.reaction_type ?? null,
        parent_post_summary: item.parent_post_summary,
        parent_author: item.parent_author ?? null,
      });
    }
  }

  // Sort newest-first within each bucket
  out.posts.sort((a, b) => new Date(b.posted_at) - new Date(a.posted_at));
  out.comments.sort((a, b) => new Date(b.commented_at) - new Date(a.commented_at));
  out.reactions.sort((a, b) => new Date(b.reacted_at) - new Date(a.reacted_at));

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified merge helper: org defaults + user additions, minus user exclusions.
//
// keyFn: how to identify an item for dedup and exclusion matching.
//        Returns a normalized string key (typically lowercased).
// orgItems, userAdditions, userExclusions: arrays of items.
//
// Behavior:
//   - Union: org items first (org wins on key conflict), then user additions
//     whose keys aren't already present.
//   - Exclude: any item whose key matches a user exclusion is dropped.
//   - Exclusion list itself uses the same keyFn so user can write
//     "GoWarmCRM" and it matches "gowarmcrm".
// ─────────────────────────────────────────────────────────────────────────────
function mergeAndExclude({ orgItems, userAdditions, userExclusions, keyFn }) {
  const orgArr = Array.isArray(orgItems) ? orgItems : [];
  const addArr = Array.isArray(userAdditions) ? userAdditions : [];
  const exclArr = Array.isArray(userExclusions) ? userExclusions : [];

  // Normalize keyFn output: a key can be string, null, or {primary, all}.
  // Returns {primary: string|null, all: string[]}.
  const normKey = (item) => {
    const k = keyFn(item);
    if (k == null) return { primary: null, all: [] };
    if (typeof k === 'string') return { primary: k, all: [k] };
    return { primary: k.primary, all: k.all || (k.primary ? [k.primary] : []) };
  };

  // Build exclusion key set from all keys exclusions could match under.
  const excludedKeys = new Set();
  for (const e of exclArr) {
    const wrapped = typeof e === 'string' ? { _str: e } : e;
    const { all } = normKey(wrapped);
    for (const k of all) excludedKeys.add(k);
  }

  // Test: does this item match an exclusion?
  const isExcluded = (allKeys) => allKeys.some(k => excludedKeys.has(k));

  // Org first, then user additions whose primary keys aren't already taken.
  const merged = [];
  const seenPrimary = new Set();

  for (const item of orgArr) {
    const { primary, all } = normKey(item);
    if (!primary) continue;
    if (seenPrimary.has(primary)) continue;
    if (isExcluded(all)) continue;
    merged.push(item);
    seenPrimary.add(primary);
  }

  for (const item of addArr) {
    const { primary, all } = normKey(item);
    if (!primary) continue;
    if (seenPrimary.has(primary)) continue;
    if (isExcluded(all)) continue;
    merged.push(item);
    seenPrimary.add(primary);
  }

  return merged;
}

// Key functions for each category — all normalize to lowercased trimmed strings.
// Each keyFn returns either a single key string, or an array of keys when the
// item could match an exclusion under multiple identifiers (e.g. a case study
// can be referenced by id or customer name).
const stringKey  = (item) => {
  if (typeof item === 'string') return item.trim().toLowerCase();
  if (item?._str)               return String(item._str).trim().toLowerCase();
  if (item?.name)               return String(item.name).trim().toLowerCase();
  return null;
};
const productKey = (item) => {
  if (typeof item === 'string') return item.trim().toLowerCase();
  if (item?._str)               return String(item._str).trim().toLowerCase();
  if (item?.name)               return String(item.name).trim().toLowerCase();
  return null;
};
// caseKey returns a {primary, all} pair — primary is the canonical dedup key,
// `all` is every key the item should be excludable under.
const caseKey = (item) => {
  if (!item) return null;
  if (typeof item === 'string') {
    const s = item.trim().toLowerCase();
    return { primary: s, all: [s] };
  }
  if (item._str) {
    const s = String(item._str).trim().toLowerCase();
    return { primary: s, all: [s] };
  }
  const id  = item.id       ? String(item.id).trim().toLowerCase() : null;
  const cus = item.customer ? String(item.customer).trim().toLowerCase() : null;
  if (!id && !cus) return null;
  return { primary: id || cus, all: [id, cus].filter(Boolean) };
};

// ─────────────────────────────────────────────────────────────────────────────
// Merge org-default + user-override prospecting config into final org_context.
//
// Resolution rules (consistent across categories — union with explicit exclusion):
//   product          : array. union(org.products, user.custom_products) − user.excluded_products
//   value_props      : union(org.default_value_props, user.custom_value_props) − user.excluded_value_props
//   target_personas  : union(org.default_target_personas, user.custom_target_personas) − user.excluded_target_personas
//   case_studies     : union(org.default_case_study_summaries, user.custom_case_studies) − user.excluded_case_studies
//   competitors      : union(competitors-table, user.custom_competitors) − user.excluded_competitors
//   rep              : user-supplied + users-table fallback (no merge — user wins)
//   voice            : user only (org doesn't dictate voice)
//   guardrails_extra : org banned phrasings ∪ user avoid phrases (additive only, no exclusion)
// ─────────────────────────────────────────────────────────────────────────────
function buildOrgContext({ orgConfig, userConfig, repUser, competitors }) {
  const oc = orgConfig || {};
  const uc = userConfig || {};

  // ── product (array, merged) ─────────────────────────────────────────────
  // Org config may carry either `product` (legacy single object) or `products` (array).
  const orgProductsRaw = Array.isArray(oc.products)
    ? oc.products
    : (oc.product ? [oc.product] : []);
  const products = mergeAndExclude({
    orgItems:       orgProductsRaw,
    userAdditions:  uc.custom_products,
    userExclusions: uc.excluded_products,
    keyFn:          productKey,
  });

  // ── value props ─────────────────────────────────────────────────────────
  const valueProps = mergeAndExclude({
    orgItems:       oc.default_value_props,
    userAdditions:  uc.custom_value_props,
    userExclusions: uc.excluded_value_props,
    keyFn:          stringKey,
  });

  // ── target personas ─────────────────────────────────────────────────────
  const targetPersonas = mergeAndExclude({
    orgItems:       oc.default_target_personas,
    userAdditions:  uc.custom_target_personas,
    userExclusions: uc.excluded_target_personas,
    keyFn:          stringKey,
  });

  // ── case studies ────────────────────────────────────────────────────────
  const caseStudies = mergeAndExclude({
    orgItems:       oc.default_case_study_summaries,
    userAdditions:  uc.custom_case_studies,
    userExclusions: uc.excluded_case_studies,
    keyFn:          caseKey,
  });

  // ── competitors ─────────────────────────────────────────────────────────
  // competitors arg comes from the competitors table as [{name}, ...].
  // Normalize all sides to plain strings for the final list.
  const competitorObjs = mergeAndExclude({
    orgItems:       competitors,        // [{name: "X"}, ...]
    userAdditions:  (uc.custom_competitors || []).map(s =>
      typeof s === 'string' ? { name: s } : s
    ),
    userExclusions: uc.excluded_competitors,
    keyFn:          stringKey,
  });
  const competitorNames = competitorObjs.map(c => c.name).filter(Boolean);

  // ── rep info ────────────────────────────────────────────────────────────
  const repFromUser = uc.rep || {};
  const fallbackName = repUser
    ? [repUser.first_name, repUser.last_name].filter(Boolean).join(' ')
    : '';
  const rep = {
    name: fallbackName || 'Sales rep',
    title: repFromUser.title_for_signature || (repUser?.title) || null,
    email_signature: repFromUser.email_signature_block || null,
  };

  // ── voice (user-only) ───────────────────────────────────────────────────
  const voice = uc.voice || null;

  // ── guardrails additions (additive only) ────────────────────────────────
  const orgBanned = Array.isArray(oc.guardrails?.banned_phrasings)
    ? oc.guardrails.banned_phrasings : [];
  const userAvoid = Array.isArray(uc.voice?.avoid_phrases)
    ? uc.voice.avoid_phrases : [];
  const guardrailsExtra = {
    banned_phrasings: [...new Set([...orgBanned, ...userAvoid])],
    required_disclaimers: Array.isArray(oc.guardrails?.required_disclaimers)
      ? oc.guardrails.required_disclaimers : [],
  };

  // ── hook preferences (user-only) ────────────────────────────────────────
  const hookPreferences = uc.hook_preferences || null;

  return {
    rep,
    // Legacy single-product field (first product) for skill backward compat.
    // The schema currently declares `product` as a required object;
    // skills can also read the new `products` array.
    product: products[0] || { name: '', one_liner: '', category: null },
    products,
    value_props: valueProps,
    target_personas: targetPersonas,
    case_study_summaries: caseStudies,
    competitors: competitorNames,
    voice,
    hook_preferences: hookPreferences,
    guardrails_extra: guardrailsExtra,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Build account_events from the prospects table's research_meta JSONB if
// available. This is a stub — real account_events come from a future
// firmographic feed (Crunchbase, news, etc.).
// ─────────────────────────────────────────────────────────────────────────────
function extractAccountEvents(prospect) {
  const meta = prospect.research_meta || {};
  if (Array.isArray(meta.account_events)) {
    return meta.account_events;
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Build engagement_history from emails + prospecting_activities.
// ─────────────────────────────────────────────────────────────────────────────
async function buildEngagementHistory(client, prospect, orgId) {
  if (!prospect) return [];

  const events = [];

  // Emails (only if prospect has an email address)
  if (prospect.email) {
    const emails = await safeQuery(client,
      `SELECT id, subject, direction, sent_at, deal_id
         FROM emails
        WHERE org_id = $1
          AND (LOWER(to_address) = LOWER($2) OR LOWER(from_address) = LOWER($2))
        ORDER BY sent_at DESC NULLS LAST
        LIMIT 30`,
      [orgId, prospect.email]
    );
    for (const e of emails) {
      events.push({
        type: e.direction === 'sent' ? 'email_sent' : 'email_received',
        timestamp: e.sent_at,
        summary: e.subject || '(no subject)',
        direction: e.direction === 'sent' ? 'outbound' : 'inbound',
      });
    }
  }

  // Prospecting activities
  const activities = await safeQuery(client,
    `SELECT activity_type, description, created_at
       FROM prospecting_activities
      WHERE prospect_id = $1
      ORDER BY created_at DESC
      LIMIT 30`,
    [prospect.id]
  );
  for (const a of activities) {
    // Map prospecting activity_types to engagement_history types where possible
    const typeMap = {
      linkedin_connection_sent: 'linkedin_connection_sent',
      linkedin_connection_accepted: 'linkedin_connection_accepted',
      linkedin_message_sent: 'linkedin_message_sent',
      linkedin_message_replied: 'linkedin_message_replied',
      meeting_booked: 'meeting_booked',
      meeting_held: 'meeting_held',
      meeting_no_show: 'meeting_no_show',
    };
    const type = typeMap[a.activity_type] || null;
    if (!type) continue;
    events.push({
      type,
      timestamp: a.created_at,
      summary: a.description || null,
      direction: null,
    });
  }

  // Sort all combined events newest-first
  events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return events.slice(0, 50);
}

// ─────────────────────────────────────────────────────────────────────────────
// Build sequence_state from sequence_enrollments.
// ─────────────────────────────────────────────────────────────────────────────
async function buildSequenceState(client, prospect) {
  if (!prospect) return null;

  const rows = await safeQuery(client,
    `SELECT se.sequence_id, se.current_step, se.next_step_due,
            se.enrolled_at, s.name AS sequence_name,
            (SELECT COUNT(*) FROM sequence_steps ss WHERE ss.sequence_id = se.sequence_id) AS total_steps
       FROM sequence_enrollments se
       JOIN sequences s ON s.id = se.sequence_id
      WHERE se.prospect_id = $1
        AND se.status = 'active'
      ORDER BY se.enrolled_at DESC
      LIMIT 1`,
    [prospect.id]
  );

  if (rows.length === 0) return null;
  const r = rows[0];

  // Channel history (which channels have been used so far in this sequence)
  const channelRows = await safeQuery(client,
    `SELECT DISTINCT ss.channel
       FROM sequence_steps ss
      WHERE ss.sequence_id = $1
        AND ss.step_order < $2`,
    [r.sequence_id, r.current_step]
  );
  const channelsUsed = channelRows.map(c => c.channel).filter(Boolean);

  return {
    sequence_id: String(r.sequence_id),
    sequence_name: r.sequence_name,
    current_step: r.current_step,
    total_steps: parseInt(r.total_steps, 10) || 0,
    last_touched_at: prospect.last_outreach_at || null,
    next_scheduled_at: r.next_step_due || null,
    channels_used: channelsUsed,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry: build the canonical payload.
// ─────────────────────────────────────────────────────────────────────────────
async function buildProspectSkillContext({ prospectId, orgId, asUserId }) {
  let client;
  try {
    client = await pool.connect();

    // RLS session var
    await client.query(
      `SELECT set_config('app.current_org_id', $1::text, true)`,
      [String(orgId)]
    );

    // Prospect (RLS-scoped)
    const prospectRes = await client.query(
      `SELECT * FROM prospects
        WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
      [prospectId, orgId]
    );

    if (prospectRes.rows.length === 0) {
      const e = new Error('Prospect not found');
      e.statusCode = 404;
      throw e;
    }
    const prospect = prospectRes.rows[0];

    // Account (optional join)
    let account = null;
    if (prospect.account_id) {
      const accountRes = await client.query(
        `SELECT * FROM accounts WHERE id = $1 AND org_id = $2`,
        [prospect.account_id, orgId]
      );
      account = accountRes.rows[0] || null;
    }

    // Org settings → prospecting_config
    const orgRes = await client.query(
      `SELECT settings FROM organizations WHERE id = $1`,
      [orgId]
    );
    const orgSettings = orgRes.rows[0]?.settings || {};
    const orgConfig = orgSettings.prospecting_config || null;

    // User preferences → prospecting_config (only if asUserId provided)
    let userConfig = null;
    let repUser = null;
    if (asUserId) {
      const upRes = await safeQuery(client,
        `SELECT preferences FROM user_preferences
          WHERE user_id = $1 AND org_id = $2`,
        [asUserId, orgId]
      );
      userConfig = upRes[0]?.preferences?.prospecting_config || null;

      const userRes = await client.query(
        `SELECT id, first_name, last_name, email, title
           FROM users WHERE id = $1`,
        [asUserId]
      );
      repUser = userRes.rows[0] || null;
    } else if (prospect.owner_id) {
      // Fall back to prospect owner for rep info, even without per-user override
      const userRes = await client.query(
        `SELECT id, first_name, last_name, email, title
           FROM users WHERE id = $1`,
        [prospect.owner_id]
      );
      repUser = userRes.rows[0] || null;
    }

    // Competitors (org-scoped)
    const competitors = await safeQuery(client,
      `SELECT name FROM competitors WHERE org_id = $1 ORDER BY name`,
      [orgId]
    );

    // ICP signals from prospect.icp_signals JSONB
    const icpSignals = prospect.icp_signals || {};

    // LinkedIn activity split
    const linkedInActivity = splitLinkedInActivity(prospect.linkedin_activity);

    // Engagement + sequence state
    const engagementHistory = await buildEngagementHistory(client, prospect, orgId);
    const sequenceState = await buildSequenceState(client, prospect);

    // Org context (the merged result)
    const orgContext = buildOrgContext({
      orgConfig,
      userConfig,
      repUser,
      competitors,
    });

    // ── Compose the canonical payload ───────────────────────────────────
    const payload = {
      prospect: {
        name: [prospect.first_name, prospect.last_name].filter(Boolean).join(' '),
        title: prospect.title || '',
        company: prospect.company_name || account?.name || '',
        linkedin_url: prospect.linkedin_url || null,
        email: prospect.email || null,
        seniority_level: inferSeniority(prospect.title),
        function: inferFunction(prospect.title),
        tenure_in_role_months: null,    // not yet tracked
        seat_count_under: null,         // not yet tracked
        headline: prospect.linkedin_headline || null,
        about: prospect.linkedin_about || null,
        experience: [],                 // future: from a linkedin_experience column
        education: [],                  // future: from a linkedin_education column
        skills_listed: [],              // future
      },
      account: {
        name: prospect.company_name || account?.name || '',
        industry: prospect.company_industry || account?.industry || '',
        sub_industry: null,
        size: prospect.company_size || account?.size || '',
        revenue_band: null,
        growth_stage: null,
        tech_stack: [],
        website: prospect.company_domain
          ? `https://${prospect.company_domain}`
          : (account?.domain ? `https://${account.domain}` : null),
        one_line_description: account?.description || null,
      },
      icp: {
        fit_score: prospect.icp_score || 0,
        matched_criteria: Array.isArray(icpSignals.matched_criteria)
          ? icpSignals.matched_criteria : [],
        missed_criteria: Array.isArray(icpSignals.missed_criteria)
          ? icpSignals.missed_criteria : [],
        persona_match: icpSignals.persona_match || null,
      },
      signals: {
        account_events: extractAccountEvents(prospect),
        linkedin_activity: linkedInActivity,
      },
      engagement_history: engagementHistory,
      sequence_state: sequenceState,
      reply_payload: null,  // populated only by reply-event-triggered skills
      org_context: orgContext,
    };

    return payload;
  } finally {
    if (client) client.release();
  }
}

module.exports = {
  buildProspectSkillContext,
};
