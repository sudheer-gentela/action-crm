/**
 * services/HubSpotFormIngestService.js
 *
 * DROP-IN LOCATION: backend/services/HubSpotFormIngestService.js
 *
 * Motion-2 adapter (Phase 8) — HubSpot FORM SUBMISSIONS → trigger signal +
 * form contact. The activity *is* the trigger (§5); the contact comes from
 * the form.
 *
 * HOW EVENTS ARRIVE (routes/activity-webhooks.routes.js):
 *   The public HubSpot app subscribes to contact.propertyChange on
 *   `recent_conversion_event_name` + `recent_conversion_date` — the two
 *   analytics properties HubSpot sets on EVERY form conversion, for new and
 *   existing contacts alike. Deliberately NOT contact.creation: bulk imports
 *   by a HubSpot admin create contacts but never set conversion properties
 *   (they're analytics-managed, not import-settable), so a 10,000-row import
 *   never reaches this adapter. A defensive changeSource==='IMPORT' skip is
 *   kept anyway (belt and braces).
 *
 * THE ADAPTER CONTRACT (§5, unchanged since P5/P6/P7):
 *   normalize → SignalService.writeSignal({ source:'webhook', observedAt:
 *   <event time>, confidence:'high' }) → THEN explicitly call
 *   SignalActionSurfacer.reevalOnCapture. writeSignal deliberately does not
 *   call the surfacer (dependency-cycle avoidance) — write-then-reeval,
 *   exactly like P6 list ingest and P7 validations. Reconciliation upstream
 *   already guarantees a webhook write can never clobber a rep validation.
 *
 * ROUTING CASCADE (decided in-session, active campaigns only at every step):
 *   1. Contact is an existing prospect whose campaign is active → that
 *      campaign (signal + reeval; never moves the prospect).
 *   2. Contact's account (matched by email domain / company) has prospects
 *      in active campaigns → the campaign with the most recently updated
 *      prospects at that account; the new prospect is created there.
 *   3. Otherwise → the org's system "Activity Tracking" campaign (lazily
 *      ensured; owner = the org admin who connected HubSpot; delete-locked;
 *      recognized by prospecting_config_override.system_role =
 *      'activity_inflow', never by name).
 *   An existing prospect with campaign_id NULL is adopted into the routed
 *   campaign; an existing prospect in a paused/completed campaign is left
 *   where they are (signal still written — history preserved, nothing moved).
 *
 * GUARDS (the "10,000 contacts" protections):
 *   - form allowlist  — settings.form_inflow.allowed_forms ([] = allow all);
 *     unlisted forms are logged as skipped, never processed.
 *   - freshness       — the contact's recent_conversion_date must be within
 *     FRESHNESS_HOURS of processing time; stale conversion data riding along
 *     on any other property change is skipped.
 *   - daily cap       — settings.form_inflow.daily_create_cap (default 200)
 *     on prospects CREATED by this adapter per UTC day; past it, events park
 *     as pending_review instead of auto-creating. Signal writes to existing
 *     prospects are never capped (no new records → no review burden).
 *
 * MODES (settings.form_inflow.mode, default 'auto'):
 *   'auto'   — execute immediately; the event row records what happened.
 *   'review' — park every event as pending_review with a computed preview of
 *     what WOULD happen; the admin approves (executes the same path) or
 *     dismisses. Events are logged in both modes, so the first few are always
 *     inspectable even in auto.
 *
 * Never reads or writes prospect.stage (new prospects land stage='target'
 * like every capture — the queue, not the stage, is what signals drive).
 */

const axios = require('axios');
const { pool } = require('../config/database');
const SignalService        = require('./SignalService');
const SignalRegistry       = require('./SignalRegistryService');
const SignalActionSurfacer = require('./SignalActionSurfacer');
const ProspectClassifier   = require('./ProspectClassifier');
const { resolveAccountId, extractDomainFromEmail } = require('./domainResolver');
const { createNotification } = require('./notificationService');

const HS_API = 'https://api.hubapi.com';

// The one fixed signal this adapter writes (no event→signal mapping in v1).
// predicate_type 'recency' — the evaluator falls back to observed_at when the
// value isn't date-like, so value stays the human-readable form name and
// "within_days" predicates still work off the submission time.
const SUBMITTED_FORM_KEY = 'submitted_form';

// A conversion older than this at processing time is stale data riding along
// on some other change — skip. 72h tolerates HubSpot's retry window.
const FRESHNESS_HOURS = 72;

// Contact properties fetched on the follow-up read.
const CONTACT_PROPERTIES = [
  'email', 'firstname', 'lastname', 'jobtitle', 'company', 'website', 'phone',
  'recent_conversion_event_name', 'recent_conversion_date',
  'hs_analytics_source', 'hubspot_owner_id', 'lifecyclestage',
].join(',');

const DEFAULT_SETTINGS = Object.freeze({
  mode: 'auto',                // 'auto' | 'review'
  allowed_forms: [],           // [] = allow all forms
  daily_create_cap: 200,       // prospects created per UTC day
});

// ─────────────────────────────────────────────────────────────────────────────
// Settings + org resolution
// ─────────────────────────────────────────────────────────────────────────────

async function getInflowSettings(orgId, client) {
  const db = client || pool;
  const { rows } = await db.query(
    `SELECT settings->'form_inflow' AS fi, connected_by
       FROM org_integrations
      WHERE org_id = $1 AND integration_type = 'hubspot'`,
    [orgId]
  );
  const fi = rows[0]?.fi || {};
  return {
    mode: fi.mode === 'review' ? 'review' : DEFAULT_SETTINGS.mode,
    allowed_forms: Array.isArray(fi.allowed_forms)
      ? fi.allowed_forms.map((f) => String(f).trim()).filter(Boolean)
      : DEFAULT_SETTINGS.allowed_forms,
    daily_create_cap: Number.isInteger(fi.daily_create_cap) && fi.daily_create_cap > 0
      ? fi.daily_create_cap
      : DEFAULT_SETTINGS.daily_create_cap,
    connectedBy: rows[0]?.connected_by || null,
  };
}

/**
 * portalId (HubSpot hub_id) → orgId. hub_id lives in oauth_tokens.account_data
 * (written at connect). If the same portal is somehow connected by two orgs,
 * routing is ambiguous — refuse loudly rather than guess.
 */
async function resolveOrgByPortal(portalId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ot.org_id
       FROM oauth_tokens ot
       JOIN org_integrations oi
         ON oi.org_id = ot.org_id AND oi.integration_type = 'hubspot'
      WHERE ot.provider = 'hubspot'
        AND ot.account_data->>'hub_id' = $1`,
    [String(portalId)]
  );
  if (rows.length === 0) return { orgId: null, reason: 'unknown_portal' };
  if (rows.length > 1) return { orgId: null, reason: 'ambiguous_portal' };
  return { orgId: rows[0].org_id };
}

// ─────────────────────────────────────────────────────────────────────────────
// HubSpot reads (follow-up contact fetch + owner email)
// ─────────────────────────────────────────────────────────────────────────────

async function _hsGet(orgId, path, params = {}) {
  const { getValidToken } = require('./hubspot.auth');
  const { accessToken } = await getValidToken(orgId);
  try {
    const res = await axios.get(`${HS_API}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params,
    });
    return res.data;
  } catch (err) {
    const detail = err.response?.data?.message || err.message;
    const e = new Error(`HubSpot GET ${path}: ${detail}`);
    e.statusCode = err.response?.status;
    throw e;
  }
}

/** Read the contact behind the event. Returns null on 404 (deleted contact). */
async function fetchContact(orgId, contactId) {
  try {
    const data = await _hsGet(orgId, `/crm/v3/objects/contacts/${contactId}`, {
      properties: CONTACT_PROPERTIES,
    });
    return data?.properties ? { id: String(data.id), ...data.properties } : null;
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

/** HubSpot owner id → owner email (best-effort; null on any failure). */
async function fetchOwnerEmail(orgId, ownerId) {
  if (!ownerId) return null;
  try {
    const data = await _hsGet(orgId, `/crm/v3/owners/${ownerId}`);
    return data?.email || null;
  } catch (_) {
    return null;
  }
}

// All internal HubSpot reads route through this object so integration tests
// can stub the network (Object.assign(FormIngest._hs, {...})) without hitting
// the real API or needing a live token.
const _hs = { fetchContact, fetchOwnerEmail };

// ─────────────────────────────────────────────────────────────────────────────
// Def + system campaign (lazily ensured)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure the org catalog carries the submitted_form def so campaigns can add
 * it as a prioritizer. sourceKind 'harvest' (activity-harvested; the schema's
 * CHECK has no 'webhook') → reliability 'medium' → capability 'prioritize'.
 * Idempotent: createDef's ON CONFLICT throw is swallowed as already-exists.
 */
async function ensureSubmittedFormDef(orgId, client) {
  const existing = await SignalRegistry.getDef({ orgId, key: SUBMITTED_FORM_KEY, client });
  if (existing) return existing;
  try {
    return await SignalRegistry.createDef({
      orgId,
      key: SUBMITTED_FORM_KEY,
      label: 'Submitted a form',
      description: 'The contact submitted a website form (HubSpot). Value is the form / conversion name; recency runs off the submission time.',
      capability: 'prioritize',
      scope: 'target_role',
      predicateType: 'recency',
      sourceKind: 'harvest',
      ttlDays: 30,
      defaultHook: 'just raised a hand on your website',
      client,
    });
  } catch (err) {
    if (/already exists/i.test(err.message)) {
      return SignalRegistry.getDef({ orgId, key: SUBMITTED_FORM_KEY, client });
    }
    throw err;
  }
}

/**
 * Find-or-create the org's system "Activity Tracking" campaign — the default
 * landing spot for form contacts that route nowhere else. Recognized by the
 * config marker (never by name — orgs can rename it), owned by the org admin
 * who connected HubSpot, delete-locked so it can't be accidentally removed.
 */
async function ensureActivityTrackingCampaign(orgId, connectedBy, client) {
  const db = client || pool;
  const found = await db.query(
    `SELECT id, name, owner_id, status
       FROM prospecting_campaigns
      WHERE org_id = $1
        AND prospecting_config_override->>'system_role' = 'activity_inflow'
      ORDER BY id
      LIMIT 1`,
    [orgId]
  );
  if (found.rows.length > 0) {
    const c = found.rows[0];
    // Re-activate if someone paused/completed it — inflow needs a live target.
    if (c.status !== 'active') {
      await db.query(
        `UPDATE prospecting_campaigns SET status = 'active', updated_at = NOW() WHERE id = $1`,
        [c.id]
      );
      c.status = 'active';
    }
    return c;
  }

  if (!connectedBy) {
    throw new Error('HubSpotFormIngest: cannot create Activity Tracking campaign — no connected_by on the HubSpot integration');
  }

  const { rows } = await db.query(
    `INSERT INTO prospecting_campaigns
       (org_id, name, description, status, owner_id, created_by,
        activity_type, delete_locked, prospecting_config_override)
     VALUES ($1, $2, $3, 'active', $4, $4, 'digital', true, $5)
     RETURNING id, name, owner_id, status`,
    [
      orgId,
      'Activity Tracking',
      'System campaign — receives inbound form-fill contacts that don\'t route to an existing campaign. Created automatically by the HubSpot form inflow.',
      connectedBy,
      JSON.stringify({ system_role: 'activity_inflow' }),
    ]
  );
  console.log(`📥 [FormInflow] Created Activity Tracking campaign ${rows[0].id} for org ${orgId}`);
  return rows[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Routing cascade
// ─────────────────────────────────────────────────────────────────────────────

async function findExistingProspect(db, orgId, hubspotContactId, email) {
  // external_refs first (deterministic), then email (the POST /prospects
  // dedup contract). URN-first only applies to extension captures.
  const byRef = await db.query(
    `SELECT p.id, p.first_name, p.last_name, p.owner_id, p.account_id, p.campaign_id,
            c.status AS campaign_status, c.name AS campaign_name, c.owner_id AS campaign_owner_id
       FROM prospects p
       LEFT JOIN prospecting_campaigns c ON c.id = p.campaign_id
      WHERE p.org_id = $1 AND p.deleted_at IS NULL
        AND p.external_refs @> $2::jsonb
      LIMIT 1`,
    [orgId, JSON.stringify({ hubspot_contact_id: String(hubspotContactId) })]
  );
  if (byRef.rows.length > 0) return byRef.rows[0];

  if (!email) return null;
  const byEmail = await db.query(
    `SELECT p.id, p.first_name, p.last_name, p.owner_id, p.account_id, p.campaign_id,
            c.status AS campaign_status, c.name AS campaign_name, c.owner_id AS campaign_owner_id
       FROM prospects p
       LEFT JOIN prospecting_campaigns c ON c.id = p.campaign_id
      WHERE p.org_id = $1 AND p.deleted_at IS NULL
        AND LOWER(p.email) = LOWER($2)
      LIMIT 1`,
    [orgId, email]
  );
  return byEmail.rows[0] || null;
}

/** Step 2: the account's most-recently-worked ACTIVE campaign, or null. */
async function findAccountCampaign(db, orgId, accountId) {
  if (!accountId) return null;
  const { rows } = await db.query(
    `SELECT c.id, c.name, c.owner_id, MAX(p.updated_at) AS last_touch
       FROM prospects p
       JOIN prospecting_campaigns c
         ON c.id = p.campaign_id AND c.org_id = p.org_id
      WHERE p.org_id = $1 AND p.account_id = $2 AND p.deleted_at IS NULL
        AND c.status = 'active'
        AND (c.prospecting_config_override->>'system_role') IS DISTINCT FROM 'activity_inflow'
      GROUP BY c.id, c.name, c.owner_id
      ORDER BY last_touch DESC
      LIMIT 1`,
    [orgId, accountId]
  );
  return rows[0] || null;
}

/** GoWarm user id for a HubSpot owner email (orchestrator's precedent). */
async function resolveGoWarmUserByEmail(db, orgId, email) {
  if (!email) return null;
  const { rows } = await db.query(
    `SELECT u.id
       FROM users u
       JOIN org_users ou ON ou.user_id = u.id
      WHERE ou.org_id = $1 AND LOWER(u.email) = LOWER($2)
        AND ou.is_active = true
      LIMIT 1`,
    [orgId, email]
  );
  return rows[0]?.id || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Guards
// ─────────────────────────────────────────────────────────────────────────────

function formAllowed(settings, formName) {
  if (!settings.allowed_forms.length) return true; // [] = allow all
  const target = String(formName || '').trim().toLowerCase();
  return settings.allowed_forms.some((f) => f.toLowerCase() === target);
}

function conversionFresh(conversionDateMs, now = Date.now()) {
  if (!conversionDateMs) return false;
  return now - conversionDateMs <= FRESHNESS_HOURS * 3600 * 1000;
}

/** Prospects created by this adapter today (UTC). */
async function createdTodayCount(db, orgId) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n
       FROM prospects
      WHERE org_id = $1 AND source = 'hubspot_form'
        AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'utc')`,
    [orgId]
  );
  return rows[0].n;
}

// ─────────────────────────────────────────────────────────────────────────────
// The pipeline: plan → (execute | park)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the routing plan for an event WITHOUT writing anything (used both
 * as the review-mode preview and as the first half of execution).
 */
async function planEvent({ orgId, contact, settings }) {
  const db = pool;
  const email = contact.email || null;

  const existing = await findExistingProspect(db, orgId, contact.id, email);
  if (existing) {
    const activeCampaign = existing.campaign_id && existing.campaign_status === 'active';
    return {
      routed_via: 'existing_prospect',
      prospect_id: existing.id,
      prospect_created: false,
      campaign_id: activeCampaign ? existing.campaign_id : null,
      campaign_name: activeCampaign ? existing.campaign_name : null,
      campaign_owner_id: activeCampaign ? existing.campaign_owner_id : null,
      owner_id: existing.owner_id,
      adopt_if_unassigned: !existing.campaign_id, // NULL → adopt into routed campaign
      account_id: existing.account_id || null,
      existing_campaign_status: existing.campaign_status || null,
    };
  }

  // New person — resolve account (read-only probe: domain match only; the
  // authoritative resolveAccountId create runs at execute time).
  const domain = extractDomainFromEmail ? extractDomainFromEmail(email) : null;
  let accountId = null;
  if (domain) {
    const acc = await db.query(
      `SELECT id FROM accounts
        WHERE org_id = $1 AND LOWER(domain) = LOWER($2) AND deleted_at IS NULL
        LIMIT 1`,
      [orgId, domain]
    );
    accountId = acc.rows[0]?.id || null;
  }
  if (!accountId && contact.company) {
    const acc = await db.query(
      `SELECT id FROM accounts
        WHERE org_id = $1 AND LOWER(TRIM(name)) = LOWER($2) AND deleted_at IS NULL
        LIMIT 1`,
      [orgId, String(contact.company).trim().toLowerCase()]
    );
    accountId = acc.rows[0]?.id || null;
  }

  const accountCampaign = await findAccountCampaign(db, orgId, accountId);
  if (accountCampaign) {
    return {
      routed_via: 'account_campaign',
      prospect_id: null,
      prospect_created: true,
      campaign_id: accountCampaign.id,
      campaign_name: accountCampaign.name,
      campaign_owner_id: accountCampaign.owner_id,
      account_id: accountId,
    };
  }

  const sysCampaign = await ensureActivityTrackingCampaign(orgId, settings.connectedBy);
  return {
    routed_via: 'default_campaign',
    prospect_id: null,
    prospect_created: true,
    campaign_id: sysCampaign.id,
    campaign_name: sysCampaign.name,
    campaign_owner_id: sysCampaign.owner_id,
    account_id: accountId,
  };
}

/**
 * Execute an event end-to-end: (create prospect if needed) → write signal →
 * reevalOnCapture → notify campaign owner. Returns the final resolution.
 * The event row is NOT touched here — callers own status transitions.
 */
async function executeEvent({ orgId, contact, formName, occurredAt, settings }) {
  const plan = await planEvent({ orgId, contact, settings });
  const resolution = { ...plan };

  let prospectId = plan.prospect_id;
  let ownerId = plan.owner_id || null;

  if (!prospectId) {
    // ── Create the form contact ──────────────────────────────────────────
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Owner: HubSpot contact owner → GoWarm user by email → campaign owner.
      const hsOwnerEmail = await _hs.fetchOwnerEmail(orgId, contact.hubspot_owner_id);
      const hsResolvedUserId = await resolveGoWarmUserByEmail(client, orgId, hsOwnerEmail);
      ownerId = hsResolvedUserId || plan.campaign_owner_id;
      resolution.owner_id = ownerId;
      resolution.owner_source = hsResolvedUserId ? 'hubspot_owner' : 'campaign_owner';

      // Account: authoritative resolve (creates if needed) — same path as
      // POST /prospects. Free-mail domains are handled inside (catchall/name).
      const accountResolution = await resolveAccountId({
        client,
        orgId,
        ownerId,
        accountId: plan.account_id || undefined,
        companyName: contact.company || null,
        companyDomain: contact.website || null,
        email: contact.email || null,
      });
      const accountId = accountResolution.accountId || null;
      resolution.account_id = accountId;
      resolution.account_status = accountResolution.status;

      const emailLocal = contact.email ? contact.email.split('@')[0] : null;
      const firstName = (contact.firstname || '').trim() || emailLocal || 'Unknown';
      const lastName  = (contact.lastname || '').trim() || '(form lead)';
      const title     = (contact.jobtitle || '').trim() || null;

      const ins = await client.query(
        `INSERT INTO prospects
           (org_id, owner_id, created_by, first_name, last_name, email, phone,
            title, company_name, company_domain, account_id, campaign_id,
            source, stage, stage_changed_at, external_refs)
         VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
                 'hubspot_form','target',CURRENT_TIMESTAMP,$12)
         RETURNING id`,
        [
          orgId, ownerId, firstName, lastName,
          contact.email || null, contact.phone || null, title,
          contact.company || null,
          extractDomainFromEmail ? extractDomainFromEmail(contact.email) : null,
          accountId, plan.campaign_id,
          JSON.stringify({ hubspot_contact_id: String(contact.id) }),
        ]
      );
      prospectId = ins.rows[0].id;
      resolution.prospect_id = prospectId;

      const classification = ProspectClassifier.classifyTitle(title);
      await client.query(
        `INSERT INTO prospecting_activities (org_id, prospect_id, user_id, activity_type, description, metadata)
         VALUES ($1, $2, $3, 'created', $4, $5)`,
        [orgId, prospectId, ownerId,
         `Captured from HubSpot form submission: "${formName || 'unknown form'}"`,
         JSON.stringify({ source: 'hubspot_form', form: formName, hubspot_contact_id: String(contact.id), classification })]
      ).catch(() => { /* best-effort */ });

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } else {
    // Existing prospect: stamp the HubSpot ref if missing; adopt into the
    // routed campaign ONLY when campaign_id is NULL (never move someone out
    // of a campaign, active or not).
    await pool.query(
      `UPDATE prospects
          SET external_refs = external_refs || $3::jsonb, updated_at = NOW()
        WHERE id = $1 AND org_id = $2
          AND NOT (external_refs ? 'hubspot_contact_id')`,
      [prospectId, orgId, JSON.stringify({ hubspot_contact_id: String(contact.id) })]
    );
    if (plan.adopt_if_unassigned) {
      const sysCampaign = await ensureActivityTrackingCampaign(orgId, settings.connectedBy);
      await pool.query(
        `UPDATE prospects SET campaign_id = $3, updated_at = NOW()
          WHERE id = $1 AND org_id = $2 AND campaign_id IS NULL`,
        [prospectId, orgId, sysCampaign.id]
      );
      resolution.campaign_id = sysCampaign.id;
      resolution.campaign_name = sysCampaign.name;
      resolution.campaign_owner_id = sysCampaign.owner_id;
      resolution.routed_via = 'default_campaign';
      resolution.adopted = true;
    }
  }

  // ── Signal + reeval (the adapter contract: write, THEN reeval) ──────────
  await ensureSubmittedFormDef(orgId);
  const conversionAt = contact.recent_conversion_date
    ? new Date(Number(contact.recent_conversion_date) || contact.recent_conversion_date)
    : null;
  const observedAt = (conversionAt && !Number.isNaN(conversionAt.getTime()))
    ? conversionAt
    : (occurredAt || new Date());

  const write = await SignalService.writeSignal({
    orgId,
    entityType: 'prospect',
    entityId: prospectId,
    key: SUBMITTED_FORM_KEY,
    value: formName || 'form submission',
    source: 'webhook',
    observedAt,
    confidence: 'high',
  });
  resolution.signal_written = write.written;
  if (!write.written) resolution.signal_skip_reason = write.reason;

  await SignalActionSurfacer.reevalOnCapture({
    orgId, entityType: 'prospect', entityId: prospectId,
  });

  // ── Notify the campaign owner with the specific action item ─────────────
  const notifyUserId = resolution.campaign_owner_id || ownerId;
  if (notifyUserId && resolution.campaign_id) {
    const personName = [contact.firstname, contact.lastname].filter(Boolean).join(' ')
      || contact.email || 'A new contact';
    await createNotification(
      orgId, notifyUserId, 'form_inflow',
      `📥 ${personName} submitted "${formName || 'a form'}"`,
      resolution.prospect_created
        ? `Added to ${resolution.campaign_name} — review them in the Work Queue and act while the hand-raise is fresh.`
        : `Already in ${resolution.campaign_name || 'your pipeline'} — their form submission is now a live signal in the Work Queue.`,
      'prospect', prospectId,
      { campaign_id: resolution.campaign_id, form: formName || null, routed_via: resolution.routed_via }
    ).catch((err) => console.warn('[FormInflow] notification failed:', err.message));
  }

  return resolution;
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhook entry point
// ─────────────────────────────────────────────────────────────────────────────

/** Minute-bucketed idempotency key: retries + the dual-property subscription
 *  (name + date fire per submission) collapse to one event row. */
function dedupeKeyFor(portalId, contactId, occurredAtMs) {
  const bucket = Math.floor(occurredAtMs / 60000);
  return `hubspot:${portalId}:contact:${contactId}:${bucket}`;
}

/**
 * Handle one verified HubSpot webhook batch. Groups property-change events by
 * contact, dedupes, records an inflow event per contact, and processes each
 * per the org's mode + guards. Never throws on a per-contact failure — the
 * event row carries status='error' instead (webhook 200s so HubSpot doesn't
 * retry forever on a poison event).
 *
 * @param {object[]} events - raw HubSpot webhook events (already sig-verified)
 * @returns {Promise<{received:number, recorded:number, processed:number, parked:number, skipped:number, errors:number}>}
 */
async function handleWebhookEvents(events) {
  const out = { received: events.length, recorded: 0, processed: 0, parked: 0, skipped: 0, errors: 0 };

  // Keep only the form-conversion property changes; group by portal+contact,
  // taking the max occurredAt per contact (one submission → up to two events).
  const CONVERSION_PROPS = new Set(['recent_conversion_event_name', 'recent_conversion_date']);
  const byContact = new Map();
  for (const ev of events) {
    if (ev.subscriptionType !== 'contact.propertyChange') continue;
    if (!CONVERSION_PROPS.has(ev.propertyName)) continue;
    if (String(ev.changeSource || '').toUpperCase() === 'IMPORT') continue; // belt & braces
    const k = `${ev.portalId}:${ev.objectId}`;
    const prev = byContact.get(k);
    if (!prev || ev.occurredAt > prev.occurredAt) {
      byContact.set(k, {
        portalId: ev.portalId,
        contactId: String(ev.objectId),
        occurredAt: ev.occurredAt,
        formName: ev.propertyName === 'recent_conversion_event_name' ? ev.propertyValue : (prev?.formName || null),
      });
    } else if (ev.propertyName === 'recent_conversion_event_name' && !prev.formName) {
      prev.formName = ev.propertyValue;
    }
  }

  for (const item of byContact.values()) {
    try {
      const { orgId, reason } = await resolveOrgByPortal(item.portalId);
      if (!orgId) {
        console.warn(`[FormInflow] dropping event for portal ${item.portalId}: ${reason}`);
        out.skipped++;
        continue;
      }
      const r = await processContactEvent({ orgId, ...item });
      out[r.bucket]++;
      if (r.recorded) out.recorded++;
    } catch (err) {
      console.error(`[FormInflow] contact ${item.contactId} failed:`, err.message);
      out.errors++;
    }
  }
  return out;
}

/**
 * Record + process one contact's form-submission event.
 * @returns {{bucket:'processed'|'parked'|'skipped'|'errors', recorded:boolean}}
 */
async function processContactEvent({ orgId, portalId, contactId, occurredAt, formName }) {
  const dedupeKey = dedupeKeyFor(portalId, contactId, occurredAt);
  const occurredAtDate = new Date(occurredAt);
  const settings = await getInflowSettings(orgId);

  // Follow-up read (the webhook payload is thin by design).
  const contact = await _hs.fetchContact(orgId, contactId);
  if (!contact) {
    // Contact deleted between event and read — record the skip and move on.
    const rec = await recordEvent({
      orgId, dedupeKey, formName, occurredAt: occurredAtDate, contactId,
      snapshot: {}, status: 'skipped',
      resolution: { skip_reason: 'contact_not_found' },
    });
    return { bucket: 'skipped', recorded: rec };
  }

  const effectiveForm = contact.recent_conversion_event_name || formName || null;
  const conversionMs = contact.recent_conversion_date
    ? Number(contact.recent_conversion_date) || new Date(contact.recent_conversion_date).getTime()
    : null;

  // ── Guards ────────────────────────────────────────────────────────────────
  let skipReason = null;
  if (!effectiveForm && !conversionMs) skipReason = 'no_conversion_data';
  else if (!conversionFresh(conversionMs)) skipReason = 'stale_conversion';
  else if (!formAllowed(settings, effectiveForm)) skipReason = 'form_not_allowed';

  if (skipReason) {
    const rec = await recordEvent({
      orgId, dedupeKey, formName: effectiveForm, occurredAt: occurredAtDate,
      contactId, snapshot: contact, status: 'skipped',
      resolution: { skip_reason: skipReason },
    });
    return { bucket: 'skipped', recorded: rec };
  }

  // Daily cap applies only to would-be CREATIONS (existing-prospect signal
  // writes create no records, hence no review burden).
  const plan = await planEvent({ orgId, contact, settings });
  const capHit = plan.prospect_created
    && (await createdTodayCount(pool, orgId)) >= settings.daily_create_cap;

  const shouldPark = settings.mode === 'review' || capHit;
  if (shouldPark) {
    const rec = await recordEvent({
      orgId, dedupeKey, formName: effectiveForm, occurredAt: occurredAtDate,
      contactId, snapshot: contact, status: 'pending_review',
      resolution: { ...plan, ...(capHit ? { parked_reason: 'daily_cap' } : { parked_reason: 'review_mode' }) },
    });
    return { bucket: 'parked', recorded: rec };
  }

  // ── Auto mode: record first (claims the dedupe key), then execute ────────
  const rec = await recordEvent({
    orgId, dedupeKey, formName: effectiveForm, occurredAt: occurredAtDate,
    contactId, snapshot: contact, status: 'pending_review',
    resolution: {},
  });
  if (!rec) return { bucket: 'skipped', recorded: false }; // duplicate — already handled

  try {
    const resolution = await executeEvent({
      orgId, contact, formName: effectiveForm, occurredAt: occurredAtDate, settings,
    });
    await pool.query(
      `UPDATE activity_inflow_events
          SET status = 'processed', resolution = $3, updated_at = NOW()
        WHERE org_id = $1 AND provider = 'hubspot' AND dedupe_key = $2`,
      [orgId, dedupeKey, JSON.stringify(resolution)]
    );
    return { bucket: 'processed', recorded: true };
  } catch (err) {
    await pool.query(
      `UPDATE activity_inflow_events
          SET status = 'error', error_detail = $3, updated_at = NOW()
        WHERE org_id = $1 AND provider = 'hubspot' AND dedupe_key = $2`,
      [orgId, dedupeKey, String(err.message).slice(0, 2000)]
    );
    throw err;
  }
}

/** Insert the event row; false when the dedupe key already exists (retry). */
async function recordEvent({ orgId, dedupeKey, formName, occurredAt, contactId, snapshot, status, resolution }) {
  const { rows } = await pool.query(
    `INSERT INTO activity_inflow_events
       (org_id, provider, dedupe_key, event_type, form_name, occurred_at,
        external_id, contact_snapshot, status, resolution)
     VALUES ($1, 'hubspot', $2, 'form_submission', $3, $4, $5, $6, $7, $8)
     ON CONFLICT (org_id, provider, dedupe_key) DO NOTHING
     RETURNING id`,
    [orgId, dedupeKey, formName || null, occurredAt, String(contactId),
     JSON.stringify(snapshot || {}), status, JSON.stringify(resolution || {})]
  );
  return rows.length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Review actions (admin panel)
// ─────────────────────────────────────────────────────────────────────────────

/** Approve a parked event: execute the standard pipeline now. */
async function approveEvent({ orgId, eventId, userId }) {
  const { rows } = await pool.query(
    `SELECT * FROM activity_inflow_events
      WHERE id = $1 AND org_id = $2 AND status = 'pending_review'`,
    [eventId, orgId]
  );
  const ev = rows[0];
  if (!ev) {
    throw Object.assign(new Error('Pending event not found'), { statusCode: 404 });
  }

  const settings = await getInflowSettings(orgId);
  // Re-read the contact — days may have passed since it parked.
  const contact = (await _hs.fetchContact(orgId, ev.external_id)) || ev.contact_snapshot;
  if (!contact || !contact.id) {
    await pool.query(
      `UPDATE activity_inflow_events
          SET status = 'skipped',
              resolution = resolution || '{"skip_reason":"contact_not_found"}'::jsonb,
              reviewed_by = $3, reviewed_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND org_id = $2`,
      [eventId, orgId, userId]
    );
    return { status: 'skipped', reason: 'contact_not_found' };
  }

  try {
    const resolution = await executeEvent({
      orgId, contact,
      formName: ev.form_name,
      occurredAt: new Date(ev.occurred_at),
      settings,
    });
    await pool.query(
      `UPDATE activity_inflow_events
          SET status = 'processed', resolution = $3,
              reviewed_by = $4, reviewed_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND org_id = $2`,
      [eventId, orgId, JSON.stringify(resolution), userId]
    );
    return { status: 'processed', resolution };
  } catch (err) {
    await pool.query(
      `UPDATE activity_inflow_events
          SET status = 'error', error_detail = $3, updated_at = NOW()
        WHERE id = $1 AND org_id = $2`,
      [eventId, orgId, String(err.message).slice(0, 2000)]
    );
    throw err;
  }
}

/** Dismiss a parked event: mark skipped, nothing executes. */
async function dismissEvent({ orgId, eventId, userId }) {
  const { rows } = await pool.query(
    `UPDATE activity_inflow_events
        SET status = 'skipped',
            resolution = resolution || '{"skip_reason":"dismissed"}'::jsonb,
            reviewed_by = $3, reviewed_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND org_id = $2 AND status = 'pending_review'
      RETURNING id`,
    [eventId, orgId, userId]
  );
  if (rows.length === 0) {
    throw Object.assign(new Error('Pending event not found'), { statusCode: 404 });
  }
  return { status: 'skipped' };
}

/** Recent inflow events for the admin panel. */
async function listEvents({ orgId, status = null, limit = 50 }) {
  const params = [orgId];
  let where = 'org_id = $1';
  if (status) {
    params.push(status);
    where += ` AND status = $${params.length}`;
  }
  params.push(Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200));
  const { rows } = await pool.query(
    `SELECT id, provider, event_type, form_name, occurred_at, external_id,
            contact_snapshot, status, resolution, error_detail,
            reviewed_by, reviewed_at, created_at
       FROM activity_inflow_events
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length}`,
    params
  );
  return rows;
}

module.exports = {
  SUBMITTED_FORM_KEY,
  FRESHNESS_HOURS,
  DEFAULT_SETTINGS,
  getInflowSettings,
  resolveOrgByPortal,
  fetchContact,
  ensureSubmittedFormDef,
  ensureActivityTrackingCampaign,
  planEvent,
  executeEvent,
  handleWebhookEvents,
  processContactEvent,
  approveEvent,
  dismissEvent,
  listEvents,
  // exported for tests
  _hs,
  _internal: { dedupeKeyFor, formAllowed, conversionFresh, findAccountCampaign, findExistingProspect },
};
