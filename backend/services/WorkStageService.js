/**
 * services/WorkStageService.js
 *
 * DROP-IN LOCATION: backend/services/WorkStageService.js
 *
 * Signal-Based Campaigns — Phase 7: the Work stage (design §7).
 *
 * This is the service behind the rep's Work panel:
 *
 *   buildWorkContext  — "research is assembled LIVE when the contact opens":
 *                       re-runs CampaignSignalEngine on the spot (never trusts
 *                       the stored action metadata), reads every current signal
 *                       on the prospect + its account, joins catalog defs for
 *                       labels/predicate types, and returns one payload the
 *                       panel renders (priority · why-now · active trigger ·
 *                       confirmations-with-input-hints · signal list w/
 *                       source/recency/confidence · saved research · the
 *                       action row for outcome recording).
 *
 *   validateSignal    — an on-page validation: writes a source='rep',
 *                       confidence='high' signal through SignalService (the
 *                       single writer), then reevalOnCapture — which can flip
 *                       the active trigger / priority and resolve or
 *                       re-surface the action (design §7: "on-page validations
 *                       ... can change which trigger/hook applies and the
 *                       priority"). Returns a FRESH work context so the UI
 *                       re-renders the hook/priority live.
 *
 *   clearSignal       — the rep's "that's wrong, and unknown is the truth"
 *                       path: deletes the row + re-evals.
 *
 *   markNotInRole     — mutable contact set, half 1: suppresses this
 *                       prospect's signal action (durably — via the reserved
 *                       contact_not_in_role rep signal the surfacer checks)
 *                       and spawns a find-replacement action on the same
 *                       upsert-and-resolve queue.
 *
 *   replaceContact    — mutable contact set, half 2: "add a better contact
 *                       seen on the page" — captures + classifies a new person
 *                       at the same account/campaign, marks the old one
 *                       not-in-role, resolves the find-replacement task, and
 *                       re-evals the new prospect so their action surfaces.
 *
 * NOT here: outcome recording. "Completion = the recorded outcome" (§7) rides
 * the EXISTING prospecting-actions endpoints — PATCH /:id/status for
 * sent/queued/skipped (with outcome text) and PATCH /:id/snooze for
 * defer-with-reason. Reuse, don't rebuild.
 *
 * IMPORTANT CONTRACT (from P5, by design): SignalService.writeSignal does NOT
 * call the surfacer. Every write here is followed by an explicit
 * SignalActionSurfacer.reevalOnCapture — that decoupling avoids the
 * dependency cycle and this service honours it everywhere.
 *
 * Never reads or writes prospect.stage.
 */

const { pool } = require('../config/database');
const SignalService        = require('./SignalService');
const SignalRegistry       = require('./SignalRegistryService');
const CampaignSignalEngine = require('./CampaignSignalEngine');
const SignalActionSurfacer = require('./SignalActionSurfacer');
const ProspectClassifier   = require('./ProspectClassifier');

// Reserved, uncatalogued, prospect-level signal key. Written source='rep' by
// markNotInRole; checked by SignalActionSurfacer.surfaceForProspect so the
// nightly sweep / on-capture re-evals never resurface a suppressed contact.
// Deliberately NOT seeded into signal_defs: it must never appear in the
// catalog as a targeting signal (it's a queue-suppression fact, not a
// campaign criterion). No TTL (uncatalogued ⇒ ttl_days NULL ⇒ never stale) —
// "not in role" stays true until a rep clears it.
const NOT_IN_ROLE_KEY = 'contact_not_in_role';

const SIGNAL_KEY_RE = /^[a-z][a-z0-9_]{0,99}$/;

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

async function loadProspect(db, orgId, prospectId) {
  const { rows } = await db.query(
    `SELECT id, org_id, owner_id, first_name, last_name, email, title,
            linkedin_url, company_name, account_id, campaign_id, playbook_id,
            stage, research_notes, research_meta
       FROM prospects
      WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
    [prospectId, orgId]
  );
  return rows[0] || null;
}

async function loadCampaign(db, orgId, campaignId) {
  if (!campaignId) return null;
  const { rows } = await db.query(
    `SELECT id, name, solution, activity_type, prospecting_config_override
       FROM prospecting_campaigns
      WHERE id = $1 AND org_id = $2`,
    [campaignId, orgId]
  );
  return rows[0] || null;
}

/** The prospect's signal action row for its campaign (any status), or null. */
async function loadSignalAction(db, orgId, prospectId, campaignId) {
  if (!campaignId) return null;
  const { rows } = await db.query(
    `SELECT id, title, description, priority, due_date, status, outcome,
            snoozed_until, snooze_reason, auto_completed, completed_at,
            metadata, source_rule, created_at, updated_at
       FROM prospecting_actions
      WHERE org_id = $1 AND prospect_id = $2
        AND source = 'signal' AND source_rule = $3`,
    [orgId, prospectId, SignalActionSurfacer.sourceRuleFor(campaignId)]
  );
  return rows[0] || null;
}

/**
 * Decide which entity a rep validation lands on when the caller doesn't say:
 * the def's scope is the tell — target_role facts are about the PERSON
 * (prospect), company facts are about the ACCOUNT. Uncatalogued keys default
 * to prospect (the safest: prospect-level wins reads, and it never pollutes
 * sibling prospects at the account).
 */
function defaultEntityFor(def) {
  if (def && def.scope === 'company') return 'account';
  return 'prospect';
}

/**
 * Shape one signal read (SignalService.readByEntity item) + its def into the
 * Work-panel row: label, value/staleValue, source, recency, confidence, and
 * enough type info (predicateType) for the correction control.
 */
function shapeSignal(sig, def) {
  return {
    key:           sig.key,
    label:         (def && def.label) || sig.key,
    entityType:    sig.entityType,
    entityId:      sig.entityId,
    state:         sig.state,                 // 'known' | 'unknown'
    value:         sig.value,
    staleValue:    sig.staleValue,            // last-seen, when state='unknown'
    source:        sig.source,                // shown to reps (§10 signal panel)
    observedAt:    sig.observedAt,
    confidence:    sig.confidence,
    ttlDays:       sig.ttlDays,
    predicateType: (def && def.predicateType) || null,
    catalogued:    !!def,
    repWritten:    sig.source === 'rep',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// buildWorkContext — the live Work-panel payload
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} opts { orgId, prospectId, client? }
 * @returns {Promise<object|null>} null when the prospect doesn't exist.
 *
 * Shape:
 * {
 *   prospect:  { id, name, title, companyName, email, linkedinUrl, stage, accountId },
 *   campaign:  { id, name, activityType } | null,
 *   hasTargeting: boolean,
 *   verdict:   CampaignSignalEngine verdict | null      // LIVE, not cached
 *   confirmations: [ { signalKey, label, reason, predicate, predicateType,
 *                      entityType, staleValue, lastObservedAt } ],
 *   signals:   [ shapeSignal... ]                       // prospect + account, defs joined
 *   notInRole: boolean,
 *   action:    prospecting_actions row (signal) | null, // for outcome recording
 *   research:  { notes, meta } | null,
 * }
 */
async function buildWorkContext({ orgId, prospectId, client }) {
  const db = client || pool;
  const prospect = await loadProspect(db, orgId, prospectId);
  if (!prospect) return null;

  const campaign = await loadCampaign(db, orgId, prospect.campaign_id);
  const targeting = campaign ? CampaignSignalEngine.extractTargeting(campaign) : { filters: [], prioritizers: [] };
  const hasTargeting = targeting.filters.length > 0 || targeting.prioritizers.length > 0;

  // ── Live evaluation — never trust the stored metadata (§7: research is
  //    assembled live when the contact opens, re-renders as signals change).
  let verdict = null;
  if (campaign && hasTargeting) {
    verdict = await CampaignSignalEngine.evaluateProspect({
      orgId, campaign, prospect, targeting, client,
    });
  }

  // ── Every current signal on the prospect + its account (not just targeting
  //    keys — the panel is also the rep's correction surface, §10).
  const [prospectSignals, accountSignals] = await Promise.all([
    SignalService.readByEntity({ orgId, entityType: 'prospect', entityId: prospect.id, client }),
    prospect.account_id
      ? SignalService.readByEntity({ orgId, entityType: 'account', entityId: prospect.account_id, client })
      : [],
  ]);

  const allKeys = [...new Set([
    ...prospectSignals.map((s) => s.key),
    ...accountSignals.map((s) => s.key),
    ...targeting.filters.map((c) => c.signal_key),
    ...targeting.prioritizers.map((c) => c.signal_key),
  ])];
  const defsByKey = await SignalRegistry.getDefsByKeys({ orgId, keys: allKeys, client });

  // The reserved suppression key is plumbing, not a fact to display.
  const visible = (s) => s.key !== NOT_IN_ROLE_KEY;
  const signals = [
    ...prospectSignals.filter(visible).map((s) => shapeSignal(s, defsByKey.get(s.key))),
    ...accountSignals.filter(visible).map((s) => shapeSignal(s, defsByKey.get(s.key))),
  ];

  const notInRoleSig = prospectSignals.find((s) => s.key === NOT_IN_ROLE_KEY);
  const notInRole = !!(notInRoleSig && notInRoleSig.state === 'known' && notInRoleSig.value === true);

  // ── Confirmations, enriched for the validate controls: the criterion's
  //    predicate (so a one_of shows its options, a gte shows a number input),
  //    the def's predicateType, the resolved target entity, and the last-seen
  //    stale value ("we last saw X on <date> — confirm on the page").
  const criterionByKey = new Map();
  for (const c of targeting.filters) criterionByKey.set(c.signal_key, c);

  const signalByKey = new Map();
  for (const s of accountSignals) signalByKey.set(s.key, s);
  for (const s of prospectSignals) signalByKey.set(s.key, s); // prospect wins, same as the engine

  const confirmations = (verdict ? verdict.confirmations : []).map((conf) => {
    const criterion = criterionByKey.get(conf.signalKey) || null;
    const def = defsByKey.get(conf.signalKey) || null;
    const sig = signalByKey.get(conf.signalKey) || null;
    return {
      signalKey:      conf.signalKey,
      label:          conf.label,
      reason:         conf.reason,                        // 'stale' | 'never_observed'
      predicate:      criterion ? criterion.predicate : null,
      predicateType:  (def && def.predicateType) || null,
      entityType:     defaultEntityFor(def),
      staleValue:     sig ? sig.staleValue : undefined,
      lastObservedAt: sig ? sig.observedAt : null,
    };
  });

  return {
    prospect: {
      id:          prospect.id,
      firstName:   prospect.first_name,
      lastName:    prospect.last_name,
      title:       prospect.title,
      email:       prospect.email,
      linkedinUrl: prospect.linkedin_url,
      companyName: prospect.company_name,
      accountId:   prospect.account_id,
      ownerId:     prospect.owner_id,
      stage:       prospect.stage,
    },
    campaign: campaign
      ? { id: campaign.id, name: campaign.name, activityType: campaign.activity_type }
      : null,
    hasTargeting,
    verdict,
    confirmations,
    signals,
    notInRole,
    action: await loadSignalAction(db, orgId, prospect.id, prospect.campaign_id),
    research: prospect.research_notes
      ? { notes: prospect.research_notes, meta: prospect.research_meta || null }
      : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// validateSignal — the on-page validation write
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write one rep validation and re-evaluate. `value` is any JSON-serializable
 * value; the ENGINE decides what it means — confirming a failing value is a
 * legitimate outcome (the prospect drops honestly, no silent unknowns).
 *
 * @param {object} opts { orgId, userId, prospectId, key, value, entityType?, client? }
 * @returns fresh work context (so the panel re-renders hook/priority live)
 */
async function validateSignal({ orgId, userId, prospectId, key, value, entityType, client }) {
  const db = client || pool;
  if (!SIGNAL_KEY_RE.test(key || '')) {
    throw Object.assign(new Error('Invalid signal key'), { statusCode: 400 });
  }
  if (key === NOT_IN_ROLE_KEY) {
    throw Object.assign(new Error('Use the not-in-role endpoint for contact suppression'), { statusCode: 400 });
  }
  const prospect = await loadProspect(db, orgId, prospectId);
  if (!prospect) throw Object.assign(new Error('Prospect not found'), { statusCode: 404 });

  const def = await SignalRegistry.getDef({ orgId, key, client });
  let effEntityType = entityType || defaultEntityFor(def);
  let effEntityId = effEntityType === 'account' ? prospect.account_id : prospect.id;
  if (effEntityType === 'account' && !prospect.account_id) {
    // No account row to hang a company fact on — land it on the prospect
    // (prospect-level wins reads anyway, so the engine still sees it).
    effEntityType = 'prospect';
    effEntityId = prospect.id;
  }

  // The write: rep source, high confidence — P5's on-page-validation contract.
  await SignalService.writeSignal({
    orgId, entityType: effEntityType, entityId: effEntityId,
    key, value, source: 'rep', confidence: 'high', client,
  });

  await db.query(
    `INSERT INTO prospecting_activities (org_id, prospect_id, user_id, activity_type, description, metadata)
     VALUES ($1, $2, $3, 'signal_validated', $4, $5)`,
    [orgId, prospect.id, userId || null,
     `Validated "${(def && def.label) || key}" on the page`,
     JSON.stringify({ key, value, entityType: effEntityType })]
  ).catch(() => { /* activity log is best-effort */ });

  // Explicit reeval — the SignalService/surfacer decoupling contract.
  await SignalActionSurfacer.reevalOnCapture({
    orgId, entityType: effEntityType, entityId: effEntityId, client,
  });

  return buildWorkContext({ orgId, prospectId, client });
}

/**
 * "That's wrong, and unknown is the truth" — remove the row, re-eval, return
 * the fresh context. (A cleared filter signal becomes a confirmation again,
 * never a drop — the TTL/unknown rule at work.)
 */
async function clearSignal({ orgId, userId, prospectId, key, entityType, client }) {
  const db = client || pool;
  if (!SIGNAL_KEY_RE.test(key || '')) {
    throw Object.assign(new Error('Invalid signal key'), { statusCode: 400 });
  }
  const prospect = await loadProspect(db, orgId, prospectId);
  if (!prospect) throw Object.assign(new Error('Prospect not found'), { statusCode: 404 });

  const def = await SignalRegistry.getDef({ orgId, key, client });
  let effEntityType = entityType || defaultEntityFor(def);
  let effEntityId = effEntityType === 'account' ? prospect.account_id : prospect.id;
  if (effEntityType === 'account' && !prospect.account_id) {
    effEntityType = 'prospect';
    effEntityId = prospect.id;
  }

  await SignalService.deleteSignal({ orgId, entityType: effEntityType, entityId: effEntityId, key, client });
  await SignalActionSurfacer.reevalOnCapture({ orgId, entityType: effEntityType, entityId: effEntityId, client });

  await db.query(
    `INSERT INTO prospecting_activities (org_id, prospect_id, user_id, activity_type, description, metadata)
     VALUES ($1, $2, $3, 'signal_cleared', $4, $5)`,
    [orgId, prospect.id, userId || null,
     `Cleared "${(def && def.label) || key}" — unknown is the truth`,
     JSON.stringify({ key, entityType: effEntityType })]
  ).catch(() => { /* best-effort */ });

  return buildWorkContext({ orgId, prospectId, client });
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutable contact set (§7)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "Not in role": suppress this contact's signal action + spawn a
 * find-replacement task. Durable — the reserved rep signal is checked by the
 * surfacer, so nightly sweeps never resurface the action; and being a rep
 * write, no vendor observation can clobber it (P1 reconciliation).
 *
 * @param {object} opts { orgId, userId, prospectId, spawnReplacementTask=true, client? }
 * @returns {Promise<{ suppressed: boolean, replacementActionId: number|null }>}
 */
async function markNotInRole({ orgId, userId, prospectId, spawnReplacementTask = true, client }) {
  const db = client || pool;
  const prospect = await loadProspect(db, orgId, prospectId);
  if (!prospect) throw Object.assign(new Error('Prospect not found'), { statusCode: 404 });

  await SignalService.writeSignal({
    orgId, entityType: 'prospect', entityId: prospect.id,
    key: NOT_IN_ROLE_KEY, value: true, source: 'rep', confidence: 'high', client,
  });

  // Re-eval: the (P7-modified) surfacer sees the reserved signal and resolves
  // the prospect's signal action.
  await SignalActionSurfacer.reevalOnCapture({
    orgId, entityType: 'prospect', entityId: prospect.id, client,
  });

  // Spawn the find-replacement task on the SAME queue, same upsert-and-resolve
  // key pattern (distinct source_rule keeps it isolated from the main
  // signal:<campaignId> row). Skipped when the caller already has a
  // replacement (replaceContact) or the prospect isn't in a campaign.
  let replacementActionId = null;
  if (spawnReplacementTask && prospect.campaign_id) {
    const name = [prospect.first_name, prospect.last_name].filter(Boolean).join(' ') || 'this contact';
    const company = prospect.company_name ? ` at ${prospect.company_name}` : '';
    const { rows } = await db.query(
      `INSERT INTO prospecting_actions (
         org_id, user_id, prospect_id, title, description,
         action_type, channel, priority, due_date,
         source, source_rule, metadata, status
       ) VALUES (
         $1, $2, $3, $4, $5,
         'signal', 'general', 'medium', NOW() + interval '3 days',
         'signal', $6, $7, 'pending'
       )
       ON CONFLICT (prospect_id, source_rule)
       WHERE prospect_id IS NOT NULL AND source_rule IS NOT NULL
       DO UPDATE SET
         status = 'pending', auto_completed = false, completed_at = NULL,
         title = EXCLUDED.title, description = EXCLUDED.description,
         due_date = EXCLUDED.due_date, updated_at = NOW()
       RETURNING id`,
      [
        orgId, prospect.owner_id ?? userId ?? null, prospect.id,
        `Find replacement for ${name}${company}`,
        `${name} is no longer in role. Find who now owns this seat${company} and add them to the campaign.`,
        `signal:${prospect.campaign_id}:replace`,
        JSON.stringify({ kind: 'find_replacement', campaign_id: prospect.campaign_id, replaced_prospect_id: prospect.id }),
      ]
    );
    replacementActionId = rows[0] ? rows[0].id : null;
  }

  await db.query(
    `INSERT INTO prospecting_activities (org_id, prospect_id, user_id, activity_type, description)
     VALUES ($1, $2, $3, 'not_in_role', 'Marked not-in-role from the Work panel — signal action suppressed')`,
    [orgId, prospect.id, userId || null]
  ).catch(() => { /* best-effort */ });

  return { suppressed: true, replacementActionId };
}

/** Undo: clear the reserved signal + re-eval (the action can resurface). */
async function clearNotInRole({ orgId, userId, prospectId, client }) {
  const db = client || pool;
  const prospect = await loadProspect(db, orgId, prospectId);
  if (!prospect) throw Object.assign(new Error('Prospect not found'), { statusCode: 404 });

  await SignalService.deleteSignal({
    orgId, entityType: 'prospect', entityId: prospect.id, key: NOT_IN_ROLE_KEY, client,
  });
  await SignalActionSurfacer.reevalOnCapture({
    orgId, entityType: 'prospect', entityId: prospect.id, client,
  });

  // Auto-complete a dangling find-replacement task, if any.
  if (prospect.campaign_id) {
    await db.query(
      `UPDATE prospecting_actions
          SET status = 'completed', auto_completed = true, completed_at = NOW(), updated_at = NOW()
        WHERE org_id = $1 AND prospect_id = $2 AND source = 'signal'
          AND source_rule = $3 AND status = 'pending'`,
      [orgId, prospect.id, `signal:${prospect.campaign_id}:replace`]
    );
  }
  return { cleared: true };
}

/**
 * "Add a better contact seen on the page": create the new person at the same
 * account + campaign, classify their title (logged — the same
 * ProspectClassifier the engine's taxonomy bridge uses), suppress the old
 * contact WITHOUT spawning a find-replacement (we have the replacement), and
 * re-eval the newcomer so their signal action surfaces — typically with the
 * campaign's confirmations as the work.
 *
 * @param {object} opts { orgId, userId, prospectId (the one being replaced),
 *                        firstName, lastName, title?, email?, linkedinUrl?, client? }
 * @returns {Promise<{ prospect, classification, workContext }>}
 */
async function replaceContact({ orgId, userId, prospectId, firstName, lastName, title, email, linkedinUrl, client }) {
  const db = client || pool;
  if (!firstName || !lastName) {
    throw Object.assign(new Error('firstName and lastName are required'), { statusCode: 400 });
  }
  const old = await loadProspect(db, orgId, prospectId);
  if (!old) throw Object.assign(new Error('Prospect not found'), { statusCode: 404 });

  // Same dedup contract as POST /prospects.
  if (email) {
    const dup = await db.query(
      `SELECT id, first_name, last_name FROM prospects
        WHERE org_id = $1 AND LOWER(email) = LOWER($2) AND deleted_at IS NULL`,
      [orgId, email]
    );
    if (dup.rows.length > 0) {
      const d = dup.rows[0];
      throw Object.assign(
        new Error(`A prospect with email "${email}" already exists: ${d.first_name} ${d.last_name} (ID ${d.id})`),
        { statusCode: 409, code: 'DUPLICATE_EMAIL', existingProspectId: d.id }
      );
    }
  }

  // Inherit the seat: same account, campaign, owner, playbook. Company fields
  // mirror the old row so account grouping stays intact. Stage starts at
  // 'target' like every capture — the queue (not the stage) is what P7 drives.
  const { rows } = await db.query(
    `INSERT INTO prospects (
       org_id, owner_id, created_by, first_name, last_name, email, linkedin_url, title,
       company_name, company_domain, account_id, campaign_id, playbook_id,
       source, stage, stage_changed_at
     )
     SELECT $1, o.owner_id, $2, $3, $4, $5, $6, $7,
            o.company_name, o.company_domain, o.account_id, o.campaign_id, o.playbook_id,
            'work_replacement', 'target', CURRENT_TIMESTAMP
       FROM prospects o WHERE o.id = $8 AND o.org_id = $1
     RETURNING *`,
    [orgId, userId || null, firstName, lastName, email || null, linkedinUrl || null, title || null, old.id]
  );
  const created = rows[0];

  const classification = ProspectClassifier.classifyTitle(title || null);

  const oldName = [old.first_name, old.last_name].filter(Boolean).join(' ');
  await db.query(
    `INSERT INTO prospecting_activities (org_id, prospect_id, user_id, activity_type, description, metadata)
     VALUES ($1, $2, $3, 'created', $4, $5)`,
    [orgId, created.id, userId || null,
     `Captured from the Work panel as replacement for ${oldName}`,
     JSON.stringify({ replaced_prospect_id: old.id, classification })]
  ).catch(() => { /* best-effort */ });

  // Suppress the old contact — no replacement task, the replacement is here.
  await markNotInRole({ orgId, userId, prospectId: old.id, spawnReplacementTask: false, client });

  // If a find-replacement task was already pending on the old contact
  // (rep hit "Not in role" first, then found someone), complete it.
  if (old.campaign_id) {
    await db.query(
      `UPDATE prospecting_actions
          SET status = 'completed', auto_completed = true, completed_at = NOW(), updated_at = NOW()
        WHERE org_id = $1 AND prospect_id = $2 AND source = 'signal'
          AND source_rule = $3 AND status = 'pending'`,
      [orgId, old.id, `signal:${old.campaign_id}:replace`]
    );
    await db.query(
      `INSERT INTO prospecting_activities (org_id, prospect_id, user_id, activity_type, description, metadata)
       VALUES ($1, $2, $3, 'contact_replaced', $4, $5)`,
      [orgId, old.id, userId || null,
       `Replaced by ${firstName} ${lastName} (ID ${created.id})`,
       JSON.stringify({ replacement_prospect_id: created.id })]
    ).catch(() => { /* best-effort */ });
  }

  // Surface the newcomer's signal action (account-level signals apply
  // immediately; their unknowns become the confirmations the rep works next).
  await SignalActionSurfacer.reevalOnCapture({
    orgId, entityType: 'prospect', entityId: created.id, client,
  });

  const workContext = await buildWorkContext({ orgId, prospectId: created.id, client });
  return { prospect: created, classification, workContext };
}

module.exports = {
  buildWorkContext,
  validateSignal,
  clearSignal,
  markNotInRole,
  clearNotInRole,
  replaceContact,
  NOT_IN_ROLE_KEY,
};
