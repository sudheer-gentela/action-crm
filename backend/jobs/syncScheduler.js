/**
 * syncScheduler.js (REPLACEMENT)
 *
 * DROP-IN LOCATION: backend/jobs/syncScheduler.js
 *
 * Key changes from previous version:
 *   - findEmailAssociations now scans ALL addresses (from, all tos, all ccs)
 *   - Deal matching queries deal_contacts first, falls back to account-level
 *   - Terminal-stage filter uses pipeline_stages.is_terminal
 *   - storeEmailToDatabase stamps tag_source = 'auto' on auto-matched deals
 *
 * Changes in this version (smart email filter):
 *   - getOrgInternalDomains() derives the org's own domain(s) at runtime from
 *     the users table — no hardcoding, works for every customer
 *   - getOrgEmailFilter() reads blocked_domains + blocked_local_patterns from
 *     organizations.settings.email_filter, merged with PLATFORM_DEFAULTS
 *   - shouldStoreEmail() — Gate 1: drops provably-automated senders
 *   - storeEmailToDatabase — Gate 2: internal-only emails kept only if subject
 *     mentions a known deal or account name
 *   - storeEmailToDatabase — Gate 3: external emails matched against contacts,
 *     prospects, and account domains; unmatched externals are dropped
 *   - prospect_id written to emails.prospect_id when matched via prospect
 *   - account_id written to emails when matched via account domain only
 *   - prospecting_activities row created for prospect-matched emails
 */

const cron      = require('node-cron');
const { pool }  = require('../config/database');
const UnifiedEmailProvider = require('../services/UnifiedEmailProvider');
const { emailQueue }       = require('./emailProcessor');
const config               = require('../config/config');
const ActionsGenerator             = require('../services/actionsGenerator');
const ContractActionsGenerator     = require('../services/ContractActionsGenerator');
const { runNightlyAudit } = require('../services/auditWorker.service');
const SupportService  = require('../services/supportService');
const HandoverService = require('../services/handover.service');



// ─────────────────────────────────────────────────────────────────────────────
// Email filter — platform defaults + org-specific overrides
// ─────────────────────────────────────────────────────────────────────────────

// Hardcoded fallback — used only if the platform_settings table row is missing.
// Super admins manage the live version via SuperAdminView → Platform Settings.
const PLATFORM_DEFAULTS_FALLBACK = {
  blocked_domains: [
    'accountprotection.microsoft.com',
    'communication.microsoft.com',
    'promomail.microsoft.com',
    'infoemails.microsoft.com',
    'engage.microsoft.com',
    'account.microsoft.com',
    'mail.onedrive.com',
    'microsoft.com',
    'googlemail.com',
  ],
  blocked_local_patterns: [
    'noreply', 'no-reply', 'donotreply', 'do-not-reply',
    'mailer-daemon', 'postmaster', 'bounce', 'notifications', 'unsubscribe',
  ],
};

/**
 * Load platform-level email filter defaults from the platform_settings table.
 * Falls back to PLATFORM_DEFAULTS_FALLBACK if the row doesn't exist yet.
 * Called once per triggerSync run — result cached in filterCache.
 *
 * @param {object} client  - pg client
 * @returns {{ blocked_domains: string[], blocked_local_patterns: string[] }}
 */
async function getPlatformEmailFilter(client) {
  try {
    const result = await client.query(
      `SELECT value FROM platform_settings WHERE key = 'email_filter'`
    );
    if (result.rows.length > 0) {
      const val = result.rows[0].value || {};
      return {
        blocked_domains:        (val.blocked_domains        || []).map(d => d.toLowerCase()),
        blocked_local_patterns: (val.blocked_local_patterns || []).map(p => p.toLowerCase()),
      };
    }
  } catch (err) {
    // platform_settings table may not exist yet (pre-migration) — use fallback
    console.warn('[emailFilter] platform_settings unavailable, using fallback:', err.message);
  }
  return {
    blocked_domains:        PLATFORM_DEFAULTS_FALLBACK.blocked_domains.map(d => d.toLowerCase()),
    blocked_local_patterns: PLATFORM_DEFAULTS_FALLBACK.blocked_local_patterns.map(p => p.toLowerCase()),
  };
}

/**
 * Load the effective email filter for an org.
 * Merges platform defaults (from platform_settings table) with
 * org-specific additions (from organizations.settings.email_filter).
 * Called once per triggerSync run — result cached in filterCache.
 *
 * If super admin leaves platform defaults empty, org admins configure everything.
 * If org has no additions, only platform defaults apply.
 *
 * @param {object} client         - pg client
 * @param {number} orgId
 * @param {{ blocked_domains, blocked_local_patterns }} platformFilter
 *   Pass in the already-loaded platform filter to avoid a second DB read.
 * @returns {{ blocked_domains: string[], blocked_local_patterns: string[] }}
 */
async function getOrgEmailFilter(client, orgId, platformFilter) {
  const result = await client.query(
    `SELECT settings->'email_filter' AS email_filter FROM organizations WHERE id = $1`,
    [orgId]
  );
  const orgFilter = result.rows[0]?.email_filter || {};

  return {
    blocked_domains: [
      ...(platformFilter.blocked_domains        || []),
      ...(orgFilter.blocked_domains             || []).map(d => d.toLowerCase()),
    ].filter((d, i, arr) => arr.indexOf(d) === i),  // dedupe
    blocked_local_patterns: [
      ...(platformFilter.blocked_local_patterns || []),
      ...(orgFilter.blocked_local_patterns      || []).map(p => p.toLowerCase()),
    ].filter((p, i, arr) => arr.indexOf(p) === i),
  };
}

/**
 * Derive the org's internal email domain(s) at runtime from the users table.
 * Excludes personal/public email providers.
 * Called once per sync run and cached in the calling scope.
 *
 * @param {object} client
 * @param {number} orgId
 * @returns {string[]}  e.g. ['gowarm.ai'] or ['company.com', 'company.co.in']
 */
async function getOrgInternalDomains(client, orgId) {
  const PERSONAL_PROVIDERS = [
    'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk',
    'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com',
    'icloud.com', 'me.com', 'aol.com', 'protonmail.com',
  ];

  const result = await client.query(
    `SELECT DISTINCT LOWER(split_part(email, '@', 2)) AS domain
     FROM users
     WHERE org_id = $1
       AND email IS NOT NULL
       AND deleted_at IS NULL`,
    [orgId]
  );

  return result.rows
    .map(r => r.domain)
    .filter(d => d && d.includes('.') && !PERSONAL_PROVIDERS.includes(d));
}

/**
 * Gate 1 — Is this email from a provably-automated sender?
 * Checks the effective sender address (from for received, to[0] for sent)
 * against the org's merged blocklist.
 *
 * Returns true  = should store (not blocked)
 * Returns false = drop immediately, no DB work needed
 *
 * @param {string}   fromAddress
 * @param {string[]} toAddresses
 * @param {string}   direction       'sent' | 'received'
 * @param {{ blocked_domains, blocked_local_patterns }} filter
 */
function shouldStoreEmail(fromAddress, toAddresses, direction, filter) {
  const checkAddress = direction === 'sent'
    ? (toAddresses[0] || '')
    : (fromAddress    || '');

  if (!checkAddress) return false;

  const lower  = checkAddress.toLowerCase();
  const atIdx  = lower.indexOf('@');
  const local  = atIdx >= 0 ? lower.slice(0, atIdx)  : lower;
  const domain = atIdx >= 0 ? lower.slice(atIdx + 1) : '';

  if (filter.blocked_domains.some(d => domain === d || domain.endsWith('.' + d))) return false;
  if (filter.blocked_local_patterns.some(p => local.includes(p)))                  return false;

  return true;
}

/**
 * Gate 2 helper — Does the email subject mention a known deal or account name?
 * Used to decide whether to keep internal-only emails.
 *
 * @param {object} client
 * @param {number} orgId
 * @param {string} subject
 * @returns {Promise<{ dealId: number|null, accountId: number|null }>}
 */
async function matchSubjectToCrmRecord(client, orgId, subject) {
  if (!subject) return { dealId: null, accountId: null };

  const subjectLower = subject.toLowerCase();

  // Check deals
  const dealResult = await client.query(
    `SELECT id FROM deals
     WHERE org_id = $1
       AND deleted_at IS NULL
       AND $2 ILIKE '%' || name || '%'
     ORDER BY created_at DESC
     LIMIT 1`,
    [orgId, subjectLower]
  );
  if (dealResult.rows.length > 0) {
    return { dealId: dealResult.rows[0].id, accountId: null };
  }

  // Check accounts
  const accountResult = await client.query(
    `SELECT id FROM accounts
     WHERE org_id = $1
       AND deleted_at IS NULL
       AND $2 ILIKE '%' || LOWER(name) || '%'
     ORDER BY created_at DESC
     LIMIT 1`,
    [orgId, subjectLower]
  );
  if (accountResult.rows.length > 0) {
    return { dealId: null, accountId: accountResult.rows[0].id };
  }

  return { dealId: null, accountId: null };
}

/**
 * Gate 3 helper — Match external addresses against accounts by domain.
 * Only matches accounts with a valid domain (not null, not empty, contains '.').
 * Skips accounts whose domain is also an internal org domain to prevent
 * self-referential accounts (e.g. Account "DeepConnect" with domain gowarm.ai)
 * from matching internal emails.
 *
 * @param {object}   client
 * @param {number}   orgId
 * @param {string[]} externalAddresses  addresses already confirmed to be external
 * @param {string[]} internalDomains    org's own domains to exclude
 * @returns {Promise<number|null>}      account id or null
 */
async function matchAddressToAccount(client, orgId, externalAddresses, internalDomains) {
  if (!externalAddresses.length) return null;

  const domains = externalAddresses
    .map(a => a.split('@')[1]?.toLowerCase())
    .filter(d => d && d.includes('.') && !internalDomains.includes(d));

  if (!domains.length) return null;

  const result = await client.query(
    `SELECT id FROM accounts
     WHERE org_id = $1
       AND deleted_at IS NULL
       AND domain IS NOT NULL
       AND domain != ''
       AND domain LIKE '%.%'
       AND LENGTH(TRIM(domain)) > 3
       AND LOWER(domain) = ANY($2::text[])
     ORDER BY id ASC
     LIMIT 1`,
    [orgId, domains]
  );

  return result.rows[0]?.id || null;
}

/**
 * Find prospect association for an email.
 *
 * @param {object}   client
 * @param {number}   orgId
 * @param {string[]} allAddresses
 * @returns {Promise<number|null>}
 */
async function findProspectAssociation(client, orgId, allAddresses) {
  if (!allAddresses.length) return null;

  const result = await client.query(
    `SELECT id FROM prospects
     WHERE org_id = $1
       AND LOWER(email) = ANY($2::text[])
       AND stage NOT IN ('converted', 'disqualified')
     ORDER BY id ASC
     LIMIT 1`,
    [orgId, allAddresses]
  );

  return result.rows[0]?.id || null;
}

/**
 * Store email to database with deduplication.
 * Accepts normalized email shape from UnifiedEmailProvider.
 */

/**
 * Log a filtered (dropped) email to email_filter_log for audit visibility.
 * Non-fatal — a logging failure never blocks the sync.
 *
 * @param {object} client
 * @param {number} orgId
 * @param {number} userId
 * @param {object} email     normalized email shape
 * @param {string} reason    'automated_sender' | 'internal_no_crm_reference' | 'no_crm_match'
 * @param {string} provider  'outlook' | 'gmail'
 */
async function logFilteredEmail(client, orgId, userId, email, reason, provider) {
  try {
    const fromAddress = email.from?.address || null;
    const toAddress   = (email.toRecipients?.[0]?.address) || null;
    const subject     = email.subject     || null;
    const externalId  = email.id          || null;

    await client.query(
      `INSERT INTO email_filter_log
         (org_id, user_id, sync_date, from_address, to_address, subject, reason, provider, external_id)
       VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8)
       ON CONFLICT DO NOTHING`,
      [orgId, userId, fromAddress, toAddress, subject, reason, provider, externalId]
    );
  } catch (err) {
    // Non-fatal — log failure must never crash the sync
    console.warn('[emailFilter] Failed to write filter log:', err.message);
  }
}

async function storeEmailToDatabase(client, userId, orgId, email, userEmail, provider, filterCache) {
  // filterCache = { filter, internalDomains } — loaded once per triggerSync call
  // and passed in to avoid repeated DB reads per email.

  // ── Derive direction + addresses ──────────────────────────────────────────
  const fromAddress = email.from?.address || null;
  const direction   = fromAddress?.toLowerCase() === userEmail?.toLowerCase() ? 'sent' : 'received';
  const toAddresses = email.toRecipients?.map(r => r.address) || [];
  const ccAddresses = email.ccRecipients?.map(r => r.address) || [];

  // ── Gate 1: Automated sender check ───────────────────────────────────────
  // Drop provably-automated senders (noreply, system domains, etc.) before
  // any DB work. Uses org-specific blocklist merged with platform defaults.
  if (!shouldStoreEmail(fromAddress, toAddresses, direction, filterCache.filter)) {
    if (config.system.debug) console.log('Gate1-drop (automated sender):', fromAddress, email.subject);
    await logFilteredEmail(client, orgId, userId, email, 'automated_sender', provider);
    return { skipped: true, reason: 'automated_sender' };
  }

  // ── Dedup ─────────────────────────────────────────────────────────────────
  if (config.emailSync.deduplication.useMessageId) {
    const existingCheck = await client.query(
      'SELECT id FROM emails WHERE user_id = $1 AND org_id = $2 AND external_id = $3',
      [userId, orgId, email.id]
    );
    if (existingCheck.rows.length > 0) {
      if (config.system.debug) console.log('Skip duplicate email:', email.id);
      return { skipped: true, emailId: existingCheck.rows[0].id };
    }
  }

  // ── Build deduplicated address list (external addresses only) ─────────────
  const allAddresses = [
    ...(direction === 'received' ? [fromAddress] : []),
    ...toAddresses,
    ...ccAddresses,
  ]
    .filter(Boolean)
    .map(a => a.toLowerCase().trim())
    .filter((a, idx, arr) => arr.indexOf(a) === idx);

  // Separate internal vs external addresses using the org's known domains
  const externalAddresses = allAddresses.filter(addr => {
    const domain = addr.split('@')[1] || '';
    return !filterCache.internalDomains.includes(domain);
  });

  const isInternalOnly = externalAddresses.length === 0;

  // ── Gate 2: Internal-only email ───────────────────────────────────────────
  // All addresses are on the org's own domain(s). Keep only if the subject
  // mentions a known deal or account name.
  if (isInternalOnly) {
    const match = await matchSubjectToCrmRecord(client, orgId, email.subject);
    if (!match.dealId && !match.accountId) {
      if (config.system.debug) console.log('Gate2-drop (internal, no CRM reference):', email.subject);
      await logFilteredEmail(client, orgId, userId, email, 'internal_no_crm_reference', provider);
      return { skipped: true, reason: 'internal_no_crm_reference' };
    }
    // Store with the matched deal/account, no contact
    return storeEmailRow(client, {
      orgId, userId, provider, direction, email,
      fromAddress, toAddresses, ccAddresses,
      dealId: match.dealId, contactId: null,
      prospectId: null, accountId: match.accountId,
      tagSource: match.dealId ? 'auto' : null,
      taggedAt: match.dealId ? new Date() : null,
      taggedBy: match.dealId ? userId : null,
    });
  }

  // ── Gate 3: External address matching ────────────────────────────────────
  // Priority: contact → prospect → account domain
  const associations = await findEmailAssociations(
    client, userId, orgId, fromAddress, toAddresses, ccAddresses, direction
  );

  if (associations.contactId || associations.dealId) {
    // Find secondary matches — other deals that also involve these contacts
    const secondaryMatches = await findSecondaryMatches(
      client, userId, orgId,
      // Re-derive all matched contactIds from the full address list
      (await client.query(
        `SELECT id FROM contacts WHERE org_id = $1 AND LOWER(email) = ANY($2::text[]) AND deleted_at IS NULL`,
        [orgId, externalAddresses]
      )).rows.map(r => r.id),
      associations.dealId
    );

    return storeEmailRow(client, {
      orgId, userId, provider, direction, email,
      fromAddress, toAddresses, ccAddresses,
      dealId: associations.dealId, contactId: associations.contactId,
      prospectId: null, accountId: null,
      secondaryMatches,
      tagSource: associations.dealId ? 'auto' : null,
      taggedAt: associations.dealId ? new Date() : null,
      taggedBy: associations.dealId ? userId : null,
    });
  }

  // Check prospects
  const prospectId = await findProspectAssociation(client, orgId, externalAddresses);
  if (prospectId) {
    return storeEmailRow(client, {
      orgId, userId, provider, direction, email,
      fromAddress, toAddresses, ccAddresses,
      dealId: null, contactId: null,
      prospectId, accountId: null,
      tagSource: null, taggedAt: null, taggedBy: null,
    });
  }

  // Check account domain match (last resort — no contact or prospect found)
  const accountId = await matchAddressToAccount(client, orgId, externalAddresses, filterCache.internalDomains);
  if (accountId) {
    return storeEmailRow(client, {
      orgId, userId, provider, direction, email,
      fromAddress, toAddresses, ccAddresses,
      dealId: null, contactId: null,
      prospectId: null, accountId,
      tagSource: null, taggedAt: null, taggedBy: null,
    });
  }

  // No match found — drop
  if (config.system.debug) console.log('Gate3-drop (no CRM match):', fromAddress, email.subject);
  await logFilteredEmail(client, orgId, userId, email, 'no_crm_match', provider);
  return { skipped: true, reason: 'no_crm_match' };
}

/**
 * Insert a matched email row into the database.
 * Extracted so the four Gate 3 branches share one INSERT.
 */
async function storeEmailRow(client, {
  orgId, userId, provider, direction, email,
  fromAddress, toAddresses, ccAddresses,
  dealId, contactId, prospectId, accountId,
  secondaryMatches = [],
  tagSource, taggedAt, taggedBy,
}) {
  const insertResult = await client.query(
    `INSERT INTO emails (
      org_id, user_id, deal_id, contact_id, prospect_id, direction,
      subject, body,
      to_address, from_address, cc_addresses,
      sent_at, external_id, external_data,
      conversation_id, provider,
      tag_source, tagged_at, tagged_by,
      created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW())
    RETURNING id`,
    [
      orgId, userId, dealId, contactId, prospectId, direction,
      email.subject,
      email.body?.content || email.bodyPreview || '',
      toAddresses.join(', '),
      fromAddress,
      ccAddresses.join(', '),
      email.receivedDateTime,
      email.id,
      JSON.stringify({
        conversationId:    email.conversationId,
        importance:        email.importance,
        hasAttachments:    email.hasAttachments,
        isRead:            email.isRead,
        categories:        email.categories,
        matched_account_id: accountId || undefined,
        // Secondary deals/contacts that also match this email.
        // Used by DealEmailHistory to show this email on multiple deal timelines.
        secondary_matches: secondaryMatches.length > 0 ? secondaryMatches : undefined,
      }),
      email.conversationId || null,
      provider,
      tagSource, taggedAt, taggedBy,
    ]
  );

  const newEmailId = insertResult.rows[0].id;

  if (config.system.debug) {
    const tag = dealId      ? ' [deal '    + dealId    + ']'
              : contactId   ? ' [contact ' + contactId + ']'
              : prospectId  ? ' [prospect '+ prospectId+ ']'
              : accountId   ? ' [account ' + accountId + ']'
              : '';
    console.log('Stored', provider, 'email', newEmailId + ':', email.subject + tag);
  }

  // Contact activity
  if (contactId) {
    await client.query(
      `INSERT INTO contact_activities (contact_id, user_id, activity_type, description, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [contactId, userId, 'email_' + direction, email.subject]
    );
  }

  // Prospect activity
  if (prospectId) {
    await client.query(
      `INSERT INTO prospecting_activities (prospect_id, user_id, org_id, activity_type, description, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [prospectId, userId, orgId, 'email_' + direction, email.subject]
    ).catch(err => console.warn('Failed to log prospect email activity:', err.message));
  }

  return { stored: true, emailId: newEmailId, dealId, prospectId, accountId };
}

/**
 * Find contact and deal associations for an email.
 *
 * Strategy (in priority order):
 *
 * 1. Collect all unique non-self addresses across from, to, and cc fields.
 *    "Self" means the syncing user's own email — we skip it so we don't
 *    accidentally resolve our own address as a contact.
 *
 * 2. For each candidate address, look up the contact in this org.
 *    Take the first match as contactId.
 *
 * 3. For each matched contact, check deal_contacts for a direct link to an
 *    active deal the syncing user owns or is a team member of.
 *    This is more precise than account-level matching when one account has
 *    multiple concurrent deals.
 *
 * 4. If no deal_contacts row exists for any matched contact, fall back to the
 *    original account-level query: contact.account_id → deals WHERE owner or
 *    team member.
 *
 * 5. Terminal deals are excluded using pipeline_stages.is_terminal = true,
 *    with a hardcoded fallback for orgs that haven't migrated yet.
 *
 * @param {object} client       - pg transaction client
 * @param {number} userId       - syncing user's id
 * @param {number} orgId
 * @param {string} fromAddress
 * @param {string[]} toAddresses
 * @param {string[]} ccAddresses
 * @param {string} direction    - 'sent' | 'received'
 * @returns {{ contactId: number|null, dealId: number|null }}
 */
async function findEmailAssociations(client, userId, orgId, fromAddress, toAddresses, ccAddresses, direction) {
  let contactId = null;
  let dealId    = null;

  // Build a deduplicated list of all external addresses on this email.
  // For sent emails we skip our own fromAddress (it's us).
  // For received emails we skip our own address wherever it appears in to/cc.
  const allAddresses = [
    ...(direction === 'received' ? [fromAddress] : []),
    ...toAddresses,
    ...ccAddresses,
  ]
    .filter(Boolean)
    .map(a => a.toLowerCase().trim())
    .filter((a, idx, arr) => arr.indexOf(a) === idx); // dedupe

  if (allAddresses.length === 0) return { contactId, dealId };

  // ── Step 1: resolve contacts ──────────────────────────────────────────────
  // Look up all addresses in one query and take the first match.
  const contactResult = await client.query(
    `SELECT id, account_id, email
     FROM contacts
     WHERE org_id    = $1
       AND LOWER(email) = ANY($2::text[])
       AND deleted_at IS NULL
     ORDER BY id ASC`,
    [orgId, allAddresses]
  );

  if (contactResult.rows.length === 0) return { contactId, dealId };

  // Use the first matched contact as the primary contact for this email.
  // If multiple contacts match (e.g. a thread with several deal contacts),
  // subsequent contacts still contribute to deal matching below.
  contactId = contactResult.rows[0].id;
  const contactIds  = contactResult.rows.map(r => r.id);
  const accountIds  = [...new Set(contactResult.rows.map(r => r.account_id).filter(Boolean))];

  // ── Step 2: deal_contacts match (preferred) ───────────────────────────────
  // Check if any matched contact is directly linked to a deal the syncing
  // user owns or is a team member of, and the deal is still active.
  if (contactIds.length > 0) {
    const dealContactsResult = await client.query(
      `SELECT d.id AS deal_id
       FROM deal_contacts dc
       JOIN deals d ON d.id = dc.deal_id
       LEFT JOIN pipeline_stages ps
         ON ps.org_id = d.org_id AND ps.pipeline = 'sales' AND ps.key = d.stage
       WHERE dc.contact_id = ANY($1::int[])
         AND d.org_id  = $2
         AND d.deleted_at IS NULL
         AND (
           -- Exclude terminal stages: use pipeline_stages if available,
           -- fall back to hardcoded keys for pre-migration orgs
           CASE
             WHEN ps.id IS NOT NULL THEN ps.is_terminal = false
             ELSE d.stage NOT IN ('closed_won', 'closed_lost')
           END
         )
         AND (
           d.owner_id = $3
           OR d.id IN (
             SELECT deal_id FROM deal_team_members
             WHERE user_id = $3 AND org_id = $2
           )
         )
       ORDER BY
         CASE WHEN d.owner_id = $3 THEN 0 ELSE 1 END,
         d.updated_at DESC
       LIMIT 1`,
      [contactIds, orgId, userId]
    );

    if (dealContactsResult.rows.length > 0) {
      dealId = dealContactsResult.rows[0].deal_id;
      return { contactId, dealId };
    }
  }

  // ── Step 3: account-level fallback ───────────────────────────────────────
  // No direct deal_contacts link found. Fall back to: contact.account_id →
  // deals on that account. This preserves behaviour for deals where contacts
  // haven't been explicitly linked yet.
  if (accountIds.length > 0) {
    const dealResult = await client.query(
      `SELECT d.id AS deal_id
       FROM deals d
       LEFT JOIN pipeline_stages ps
         ON ps.org_id = d.org_id AND ps.pipeline = 'sales' AND ps.key = d.stage
       WHERE d.org_id     = $1
         AND d.account_id = ANY($2::int[])
         AND d.deleted_at IS NULL
         AND (
           CASE
             WHEN ps.id IS NOT NULL THEN ps.is_terminal = false
             ELSE d.stage NOT IN ('closed_won', 'closed_lost')
           END
         )
         AND (
           d.owner_id = $3
           OR d.id IN (
             SELECT deal_id FROM deal_team_members
             WHERE user_id = $3 AND org_id = $1
           )
         )
       ORDER BY
         CASE WHEN d.owner_id = $3 THEN 0 ELSE 1 END,
         d.updated_at DESC
       LIMIT 1`,
      [orgId, accountIds, userId]
    );

    if (dealResult.rows.length > 0) {
      dealId = dealResult.rows[0].deal_id;
    }
  }

  return { contactId, dealId };
}

/**
 * Find secondary deal/contact matches for an email.
 * Called after the primary match is found to identify additional deals
 * that should also see this email. Results stored in external_data.secondary_matches.
 *
 * Finds all active deals linked to any of the matched contacts, excluding
 * the primary dealId already assigned.
 *
 * @param {object}   client
 * @param {number}   userId
 * @param {number}   orgId
 * @param {number[]} contactIds   all matched contact ids (not just the primary)
 * @param {number|null} primaryDealId  exclude this from secondary results
 * @returns {Promise<Array<{ dealId, contactId, dealName }>>}
 */
async function findSecondaryMatches(client, userId, orgId, contactIds, primaryDealId) {
  if (!contactIds.length) return [];

  const result = await client.query(
    `SELECT DISTINCT
       d.id                                       AS deal_id,
       d.name                                     AS deal_name,
       dc.contact_id,
       c.email                                    AS contact_email,
       c.first_name || ' ' || c.last_name         AS contact_name
     FROM deal_contacts dc
     JOIN deals d   ON d.id  = dc.deal_id
     JOIN contacts c ON c.id = dc.contact_id
     LEFT JOIN pipeline_stages ps
       ON ps.org_id = d.org_id AND ps.pipeline = 'sales' AND ps.key = d.stage
     WHERE dc.contact_id = ANY($1::int[])
       AND d.org_id      = $2
       AND d.deleted_at  IS NULL
       AND ($3::int IS NULL OR d.id != $3)
       AND (
         CASE
           WHEN ps.id IS NOT NULL THEN ps.is_terminal = false
           ELSE d.stage NOT IN ('closed_won', 'closed_lost')
         END
       )
       AND (
         d.owner_id = $4
         OR d.id IN (
           SELECT deal_id FROM deal_team_members
           WHERE user_id = $4 AND org_id = $2
         )
       )
     ORDER BY d.updated_at DESC
     LIMIT 10`,
    [contactIds, orgId, primaryDealId, userId]
  );

  return result.rows.map(r => ({
    dealId:       r.deal_id,
    dealName:     r.deal_name,
    contactId:    r.contact_id,
    contactEmail: r.contact_email,
    contactName:  r.contact_name,
  }));
}


/**
 * Trigger sync for a user.
 * @param {number} userId
 * @param {number} orgId
 * @param {string} type     - 'email' (default)
 * @param {string} provider - 'outlook' | 'gmail'
 */
async function triggerSync(userId, orgId, type, provider) {
  // Support old 3-arg call: triggerSync(userId, orgId, 'email')
  if (typeof type === 'string' && !provider) {
    if (type === 'outlook' || type === 'gmail') {
      provider = type;
      type = 'email';
    } else {
      provider = 'outlook'; // default for backward compat
    }
  }
  if (!type) type = 'email';
  if (!provider) provider = 'outlook';

  const client = await pool.connect();

  try {
    console.log('Triggering ' + type + ' sync (' + provider + ') for user ' + userId + ' org ' + orgId);

    if (!config.emailSync.enabled) {
      console.log('Email sync is disabled in config');
      return { success: false, message: 'Email sync disabled' };
    }

    await client.query('BEGIN');

    // Create sync history record
    const syncHistoryResult = await client.query(
      'INSERT INTO email_sync_history (user_id, org_id, sync_type, status, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id',
      [userId, orgId, type + '_' + provider, 'in_progress']
    );
    const syncHistoryId = syncHistoryResult.rows[0].id;

    // Get last sync date
    const lastSyncResult = await client.query(
      "SELECT last_sync_date FROM email_sync_history WHERE user_id = $1 AND org_id = $2 AND sync_type = $3 AND status = 'completed' ORDER BY created_at DESC LIMIT 1",
      [userId, orgId, type + '_' + provider]
    );
    const lastSyncDate = lastSyncResult.rows[0]?.last_sync_date;

    // Get user's email address for direction detection
    const userEmail = await UnifiedEmailProvider.getUserEmail(userId, provider);

    // Fetch emails via unified provider
    const fetchOptions = {
      top:     config.emailSync.scope.batchSize || 100,
      orderBy: 'receivedDateTime DESC',
    };
    if (lastSyncDate) fetchOptions.since = lastSyncDate;

    const result = await UnifiedEmailProvider.fetchEmails(userId, provider, fetchOptions);
    console.log('Found ' + result.emails.length + ' ' + provider + ' emails for user ' + userId);

    // Load platform defaults + org overrides + internal domains once per sync run.
    // platformFilter is loaded first so getOrgEmailFilter can merge without
    // a second DB call to platform_settings.
    const platformFilter = await getPlatformEmailFilter(client);
    const filterCache = {
      filter:          await getOrgEmailFilter(client, orgId, platformFilter),
      internalDomains: await getOrgInternalDomains(client, orgId),
    };
    if (config.system.debug) {
      console.log('Org', orgId, 'internal domains:', filterCache.internalDomains);
    }

    let stored  = 0;
    let skipped = 0;
    let failed  = 0;
    const queuedJobs = [];

    for (const email of result.emails) {
      try {
        const storeResult = await storeEmailToDatabase(
          client, userId, orgId, email, userEmail, provider, filterCache
        );

        if (storeResult.skipped) {
          skipped++;
          continue;
        }

        if (storeResult.stored) {
          stored++;

          if (config.emailSync.autoGenerateRuleBasedActions && storeResult.dealId) {
            ActionsGenerator.generateForEmail(storeResult.emailId)
              .catch(err => console.error('Error generating rule-based actions:', err));
          }

          if (config.emailSync.autoGenerateAIActions) {
            const job = await emailQueue.add({
              userId,
              orgId,
              emailId:   email.id,
              dbEmailId: storeResult.emailId,
              dealId:    storeResult.dealId,
              provider,
            });
            queuedJobs.push(job.id);
          }
        }
      } catch (error) {
        console.error('Error processing ' + provider + ' email "' + email.subject + '":', error.message);
        failed++;
      }
    }

    await client.query(
      'UPDATE email_sync_history SET status = $2, items_processed = $3, items_failed = $4, last_sync_date = NOW() WHERE id = $1',
      [syncHistoryId, 'completed', stored, failed]
    );

    await client.query('COMMIT');

    console.log(provider + ' sync completed: ' + stored + ' stored, ' + skipped + ' skipped, ' + failed + ' failed');
    console.log('Queued ' + queuedJobs.length + ' emails for AI analysis');

    return {
      success: true, provider,
      emailsFound: result.emails.length,
      stored, skipped, failed,
      jobsQueued: queuedJobs.length,
      jobIds: queuedJobs,
    };

  } catch (error) {
    await client.query('ROLLBACK');
    console.error(provider + ' sync failed for user ' + userId + ':', error);

    try {
      await client.query(
        "UPDATE email_sync_history SET status = 'failed', error_message = $2 WHERE id = (SELECT id FROM email_sync_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1)",
        [userId, error.message]
      );
    } catch (updateError) {
      console.error('Failed to update sync history:', updateError);
    }

    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get sync status for a user, scoped to their current org.
 */
async function getSyncStatus(userId, orgId) {
  const result = await pool.query(
    'SELECT * FROM email_sync_history WHERE user_id = $1 AND org_id = $2 ORDER BY created_at DESC LIMIT 10',
    [userId, orgId]
  );
  return result.rows;
}

/**
 * Sync all connected users across all orgs.
 * Iterates BOTH Outlook and Gmail connected users.
 */
async function syncAllUsers() {
  try {
    console.log('Starting scheduled sync for all users...');

    // Outlook users
    const outlookUsers = await pool.query(
      "SELECT ou.user_id, ou.org_id FROM org_users ou JOIN users u ON u.id = ou.user_id WHERE u.outlook_connected = true AND u.deleted_at IS NULL AND ou.is_active = true"
    );

    // Gmail users
    const gmailUsers = await pool.query(
      "SELECT ou.user_id, ou.org_id FROM org_users ou JOIN users u ON u.id = ou.user_id WHERE u.gmail_connected = true AND u.deleted_at IS NULL AND ou.is_active = true"
    );

    const allSyncJobs = [
      ...outlookUsers.rows.map(r => ({ ...r, provider: 'outlook' })),
      ...gmailUsers.rows.map(r => ({ ...r, provider: 'gmail' })),
    ];

    console.log('Found ' + allSyncJobs.length + ' user-org-provider combinations to sync');

    const results = [];

    for (const { user_id, org_id, provider } of allSyncJobs) {
      try {
        const result = await triggerSync(user_id, org_id, 'email', provider);
        results.push({ userId: user_id, orgId: org_id, provider, ...result });
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        console.error('Error syncing user ' + user_id + ' org ' + org_id + ' ' + provider + ':', error);
        results.push({ userId: user_id, orgId: org_id, provider, success: false, error: error.message });
      }
    }

    console.log('Scheduled sync completed');
    return { success: true, usersProcessed: allSyncJobs.length, results };
  } catch (error) {
    console.error('Error in scheduled sync:', error);
    throw error;
  }
}

/**
 * Schedule automatic syncs based on config.
 */
function startScheduler() {
  if (config.emailSync.frequency !== 'scheduled') {
    console.log('Email sync scheduler: Manual mode');
    return;
  }
  if (!config.emailSync.enabled) {
    console.log('Email sync scheduler: Disabled');
    return;
  }

  const intervalMinutes = config.emailSync.intervalMinutes;
  const cronMap = {
    1: '* * * * *', 5: '*/5 * * * *', 10: '*/10 * * * *',
    15: '*/15 * * * *', 30: '*/30 * * * *', 60: '0 * * * *',
  };
  const cronExpression = cronMap[intervalMinutes] || '*/15 * * * *';

  console.log('Email sync scheduler started: Every ' + intervalMinutes + ' minutes');
  cron.schedule(cronExpression, () => {
    console.log('Running scheduled sync...');
    syncAllUsers();
  }, { timezone: config.system.timezone || 'UTC' });

  // ── Deal actions — nightly sweep ─────────────────────────────────────────
  // Runs at 01:00 UTC every day. Upserts diagnostic alerts for all active
  // deals and resolves stale alerts whose conditions have cleared.
  // NOTE: This sweep was previously missing — deals only regenerated on
  // email sync events. Now runs nightly for full consistency.
  cron.schedule('0 1 * * *', () => {
    console.log('🌙 Running nightly deal action sweep...');
    ActionsGenerator.generateAll()
      .then(r => console.log(`✅ Deal sweep done — generated: ${r.generated}, upserted: ${r.upserted}, resolved: ${r.resolved}`))
      .catch(err => console.error('❌ Deal sweep error:', err.message));
  }, { timezone: 'UTC' });

  // ── CLM contract actions — nightly sweep ──────────────────────────────────
  // Runs at 02:00 UTC every day. Catches stagnation rules (contracts sitting in
  // a status for N days) and time-based rules (expiry warnings, expired with no
  // renewal) that are never triggered by status-change events.
  cron.schedule('0 2 * * *', () => {
    console.log('🌙 Running nightly CLM action sweep...');
    ContractActionsGenerator.generateAll()
      .then(r => console.log(`✅ CLM sweep done — upserted: ${r.upserted}, resolved: ${r.resolved}`))
      .catch(err => console.error('❌ CLM sweep error:', err.message));
  }, { timezone: 'UTC' });

  // ── Cases diagnostic sweep — nightly at 02:15 UTC ────────────────────────
  // Runs CasesRulesEngine for every non-terminal case in every active org.
  // Upserts Type A diagnostic alerts (unassigned, SLA breach, stale, etc.)
  // and resolves alerts whose conditions have cleared.
  // Staggered 15 min after CLM sweep to avoid DB contention.
  cron.schedule('15 2 * * *', async () => {
    console.log('🌙 Running nightly Cases diagnostic sweep...');
    try {
      const orgs = await pool.query(
        `SELECT DISTINCT org_id FROM cases
         WHERE status NOT IN ('resolved', 'closed')`
      );
      let totalProcessed = 0, totalAlerts = 0, totalResolved = 0, totalErrors = 0;
      for (const { org_id } of orgs.rows) {
        const r = await SupportService.runNightlySweep(org_id);
        totalProcessed += r.processed;
        totalAlerts    += r.alerts;
        totalResolved  += r.resolved;
        totalErrors    += r.errors;
      }
      console.log(`✅ Cases sweep done — orgs: ${orgs.rows.length}, processed: ${totalProcessed}, alerts: ${totalAlerts}, resolved: ${totalResolved}, errors: ${totalErrors}`);
    } catch (err) {
      console.error('❌ Cases sweep error:', err.message);
    }
  }, { timezone: 'UTC' });

  // ── Handovers diagnostic sweep — nightly at 02:30 UTC ────────────────────
  // Runs HandoverRulesEngine for every non-draft handover in every active org.
  // Upserts Type A diagnostic alerts (no kickoff, overdue commitments, stalled,
  // stakeholder gaps, incomplete brief) and resolves cleared alerts.
  // Actions written to `actions` table using deal_id FK (see architectural
  // decision #7 in handover doc — no handover_id FK exists on actions).
  cron.schedule('30 2 * * *', async () => {
    console.log('🌙 Running nightly Handovers diagnostic sweep...');
    try {
      const orgs = await pool.query(
        `SELECT DISTINCT org_id FROM sales_handovers
         WHERE status != 'draft'`
      );
      let totalProcessed = 0, totalAlerts = 0, totalResolved = 0, totalErrors = 0;
      for (const { org_id } of orgs.rows) {
        const r = await HandoverService.runNightlySweep(org_id);
        totalProcessed += r.processed;
        totalAlerts    += r.alerts;
        totalResolved  += r.resolved;
        totalErrors    += r.errors;
      }
      console.log(`✅ Handovers sweep done — orgs: ${orgs.rows.length}, processed: ${totalProcessed}, alerts: ${totalAlerts}, resolved: ${totalResolved}, errors: ${totalErrors}`);
    } catch (err) {
      console.error('❌ Handovers sweep error:', err.message);
    }
  }, { timezone: 'UTC' });

  // ── Workflow audit — nightly sweep ────────────────────────────────────────
  // Runs at 03:00 UTC every day. Scans all entity records for all active orgs
  // against audit-trigger workflow rules, writing new violations and resolving
  // cleared ones in rule_violations.
  cron.schedule('0 3 * * *', () => {
    console.log('🔍 Running nightly workflow audit...');
    runNightlyAudit()
      .then(r => console.log(
        `✅ Workflow audit done — orgs: ${r.orgsScanned}, ` +
        `scanned: ${r.totalScanned}, new violations: ${r.totalNewViolations}, resolved: ${r.totalResolved}`
      ))
      .catch(err => console.error('❌ Workflow audit error:', err.message));
  }, { timezone: 'UTC' });

  // ── Email filter log purge — nightly at 03:30 UTC ─────────────────────────
  // Deletes email_filter_log rows older than 30 days to keep the table lean.
  // Offset 30 min from the audit run to avoid DB contention.
  cron.schedule('30 3 * * *', async () => {
    try {
      const result = await pool.query(
        `DELETE FROM email_filter_log WHERE sync_date < NOW() - INTERVAL '30 days'`
      );
      if (result.rowCount > 0) {
        console.log(`🧹 Email filter log purged: ${result.rowCount} rows older than 30 days`);
      }
    } catch (err) {
      console.error('❌ Email filter log purge error:', err.message);
    }
  }, { timezone: 'UTC' });

  console.log('✅ Deal action scheduler started (nightly 01:00 UTC)');
  console.log('✅ CLM action scheduler started (nightly 02:00 UTC)');
  console.log('✅ Cases diagnostic scheduler started (nightly 02:15 UTC)');
  console.log('✅ Handovers diagnostic scheduler started (nightly 02:30 UTC)');
  console.log('✅ Workflow audit scheduler started (nightly 03:00 UTC)');
  console.log('✅ Email filter log purge started (nightly 03:30 UTC)');
}

module.exports = {
  triggerSync,
  getSyncStatus,
  syncAllUsers,
  startScheduler,
};
