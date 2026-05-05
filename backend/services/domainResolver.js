// ============================================================================
// services/domainResolver.js
//
// Domain normalization + account resolve-or-create logic for the prospect
// creation paths (CSV bulk import, single-prospect create, extension
// "Add as Prospect").
//
// Three responsibilities:
//   1. normalizeDomain  — clean a domain string, drop junk inputs.
//   2. deriveDomain     — given the various inputs a writer might supply,
//                          return the best non-junk domain we can resolve.
//   3. resolveAccountId — given a writer's payload + a DB client, return
//                          an account_id, creating the account if needed.
//                          ALWAYS returns an id when companyName is present.
//
// Design rules:
//   - If a real domain resolves: account is matched-or-created with that
//     domain and needs_domain_review = FALSE.
//   - If no real domain resolves and companyName is present: account is
//     matched-or-created with domain = CATCHALL_DOMAIN and
//     needs_domain_review = TRUE.
//   - If neither domain nor companyName is present: returns null. The caller
//     must decide whether that's an error (it usually is for prospects).
//
// What we never do:
//   - Accept linkedin.com (or any LinkedIn variant) as a domain.
//   - Accept a personal-email host (gmail.com, yahoo.com, etc.) as a domain.
//   - Backfill or modify existing data — this module only handles new writes.
// ============================================================================

const CATCHALL_DOMAIN = 'catchalldomain.com';

// LinkedIn hosts — anything matching is junk-as-a-domain.
const LINKEDIN_HOSTS = new Set([
  'linkedin.com',
  'www.linkedin.com',
  'linkedin.cn',
  'lnkd.in',
]);

// Personal email hosts. Lowercased, exact match. Listed by usage shape so
// the regional ones (yahoo.co.in etc.) aren't missed in IN/UK/AU contexts.
const PERSONAL_EMAIL_HOSTS = new Set([
  // Google
  'gmail.com', 'googlemail.com',
  // Yahoo (incl. regional)
  'yahoo.com', 'yahoo.co.in', 'yahoo.co.uk', 'yahoo.in',
  'yahoo.ca', 'yahoo.com.au', 'ymail.com', 'rocketmail.com',
  // Microsoft
  'outlook.com', 'outlook.in', 'hotmail.com', 'hotmail.co.uk',
  'live.com', 'msn.com',
  // Apple
  'icloud.com', 'me.com', 'mac.com',
  // Other big consumer hosts
  'aol.com', 'gmx.com', 'gmx.de', 'mail.com',
  'yandex.com', 'yandex.ru', 'fastmail.com', 'tutanota.com',
  // Privacy-focused
  'proton.me', 'protonmail.com', 'pm.me',
  // Indian consumer hosts
  'rediffmail.com', 'rediff.com',
]);

// ─────────────────────────────────────────────────────────────────────────────
// normalizeDomain
//
// Takes any string the writer might have sent (URL, bare domain, with or
// without protocol/path/port) and returns a clean lowercase domain — or
// null if the input doesn't yield a usable real-world domain.
//
// Returns null for: empty, LinkedIn variants, personal email hosts, IP
// addresses, single-label hostnames (no TLD), and the catchall itself.
// ─────────────────────────────────────────────────────────────────────────────
function normalizeDomain(input) {
  if (input == null) return null;
  let s = String(input).trim().toLowerCase();
  if (!s) return null;

  // Strip protocol.
  s = s.replace(/^https?:\/\//, '');
  // Strip path / query / fragment.
  s = s.split(/[/?#]/)[0];
  // Strip port.
  s = s.split(':')[0];
  // Strip leading "www." (common in user input; not meaningful for matching).
  s = s.replace(/^www\./, '');
  // Trim trailing dot.
  s = s.replace(/\.$/, '');

  if (!s) return null;

  // Reject obvious junk.
  if (LINKEDIN_HOSTS.has(s)) return null;
  if (PERSONAL_EMAIL_HOSTS.has(s)) return null;
  if (s === CATCHALL_DOMAIN) return null;

  // Reject IP addresses (literal v4; rough check is sufficient).
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return null;

  // Reject hostnames without a TLD (e.g. "vitaledge").
  if (!s.includes('.')) return null;

  // Reject hostnames with whitespace or characters that shouldn't appear.
  // ampersands, spaces — Bucket B has rows like "expressl&t.net" which
  // technically *would* normalize but is almost certainly a bad scrape.
  // We keep & as legal but strip whitespace.
  if (/\s/.test(s)) return null;

  // Basic shape: must have at least one dot and end in a 2+ char TLD.
  if (!/\.[a-z]{2,}$/i.test(s)) return null;

  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// extractDomainFromEmail
//
// "alice@vitaledge.com" -> "vitaledge.com" (after normalization rules).
// Returns null when the email's host is a personal/junk host.
// ─────────────────────────────────────────────────────────────────────────────
function extractDomainFromEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  const host = email.slice(at + 1);
  return normalizeDomain(host);
}

// ─────────────────────────────────────────────────────────────────────────────
// deriveDomain
//
// Given the various inputs a writer might supply, return the best real
// domain we can resolve. Priority:
//   1. The domain field they explicitly provided (after normalization).
//   2. The host of the email they provided (if not personal).
// Returns null when neither yields a real domain — caller falls back to
// catchall.
// ─────────────────────────────────────────────────────────────────────────────
function deriveDomain({ companyDomain, email }) {
  const fromField = normalizeDomain(companyDomain);
  if (fromField) return fromField;

  const fromEmail = extractDomainFromEmail(email);
  if (fromEmail) return fromEmail;

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// normalizeLinkedInCompanyUrl
//
// LinkedIn's company URLs come in many shapes:
//   https://www.linkedin.com/company/vitaledge-technologies/
//   linkedin.com/company/vitaledge-technologies/people/
//   /company/vitaledge-technologies?utm_source=...
// Normalize to the canonical form so writes and comparisons are stable:
//   https://www.linkedin.com/company/<slug>
//
// Returns null for input that doesn't contain /company/<slug> at all,
// for non-LinkedIn hosts, or for the literal /company/ followed by an
// admin/aggregate path (e.g. /company/setup/new). The slug must look
// like a slug — alphanumerics, dashes, underscores, dots.
// ─────────────────────────────────────────────────────────────────────────────
function normalizeLinkedInCompanyUrl(input) {
  if (input == null) return null;
  const s = String(input).trim();
  if (!s) return null;
  const m = s.match(/(?:linkedin\.com)?\/company\/([A-Za-z0-9._-]+)/i);
  if (!m) return null;
  const slug = m[1].toLowerCase();
  // Reject obvious LinkedIn admin paths that aren't real companies.
  if (slug === 'setup' || slug === 'new' || slug === 'admin') return null;
  return `https://www.linkedin.com/company/${slug}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveAccountId
//
// Given a payload + a pg client (or pool) + orgId/ownerId, return an
// account_id. NEVER throws on missing-domain. Behavior:
//
//   - If the writer passed an explicit accountId → trust it. Backfill the
//     account's linkedin_company_url if missing and the writer provided one.
//   - If a real domain resolves:
//       a. Match by (org_id, LOWER(domain)) — return existing account id.
//          Backfill linkedin_company_url if missing.
//       b. If no match, also try matching by (org_id, LOWER(TRIM(name))) —
//          if a catchall account already exists for this name, ADOPT it
//          and upgrade it: set its domain to the real one, clear the flag,
//          fill linkedin_company_url if provided.
//       c. Otherwise INSERT a new account with the real domain and URL.
//   - If no real domain resolves and companyName is present:
//       a. Match by (org_id, LOWER(TRIM(name))) — return existing.
//          Backfill linkedin_company_url if missing.
//       b. Otherwise INSERT a new account with domain = catchall and
//          needs_domain_review = TRUE, including the URL.
//   - If neither domain nor companyName is present → return null. Caller
//     decides whether that's an error.
//
// Backfill rule for linkedin_company_url:
//   If the writer provided a URL AND the existing account row has it
//   empty/null, set it. We never overwrite a populated URL — that would
//   risk replacing a user-corrected value with whatever the next scrape
//   returned.
//
// Returns: { accountId: number | null, status: string }
//   status is one of:
//     'caller_provided', 'matched_by_domain', 'upgraded_catchall',
//     'matched_by_name', 'created_real_domain', 'created_catchall',
//     'no_company_info'
// ─────────────────────────────────────────────────────────────────────────────
async function resolveAccountId({
  client,
  orgId,
  ownerId,
  accountId,
  companyName,
  companyDomain,
  companyIndustry,
  companySize,
  companyLinkedInUrl,
  email,
}) {
  // Helper: backfill linkedin_company_url on an existing row when missing.
  // No-op if writer didn't provide one. Never overwrites a populated value.
  async function maybeBackfillLinkedInUrl(existingAccountId) {
    if (!companyLinkedInUrl) return;
    await client.query(
      `UPDATE accounts
          SET linkedin_company_url = $2,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
          AND (linkedin_company_url IS NULL OR linkedin_company_url = '')`,
      [existingAccountId, companyLinkedInUrl]
    );
  }

  // 1. Caller provided an account id directly — trust them, but fill URL if missing.
  if (accountId) {
    await maybeBackfillLinkedInUrl(Number(accountId));
    return { accountId: Number(accountId), status: 'caller_provided' };
  }

  const trimmedName = companyName ? String(companyName).trim() : '';
  const realDomain  = deriveDomain({ companyDomain, email });

  // No domain AND no company name → nothing to do.
  if (!realDomain && !trimmedName) {
    return { accountId: null, status: 'no_company_info' };
  }

  // ── Path A: real domain available ────────────────────────────────────
  if (realDomain) {
    // a. Match by domain.
    const byDomain = await client.query(
      `SELECT id FROM accounts
        WHERE org_id = $1 AND LOWER(domain) = LOWER($2) AND deleted_at IS NULL
        LIMIT 1`,
      [orgId, realDomain]
    );
    if (byDomain.rows.length > 0) {
      await maybeBackfillLinkedInUrl(byDomain.rows[0].id);
      return { accountId: byDomain.rows[0].id, status: 'matched_by_domain' };
    }

    // b. Match by name — if a catchall account exists for this name,
    //    upgrade it with the real domain rather than creating a duplicate.
    if (trimmedName) {
      const byName = await client.query(
        `SELECT id, domain, needs_domain_review, linkedin_company_url FROM accounts
          WHERE org_id = $1 AND LOWER(TRIM(name)) = LOWER($2) AND deleted_at IS NULL
          LIMIT 1`,
        [orgId, trimmedName.toLowerCase()]
      );
      if (byName.rows.length > 0) {
        const existing = byName.rows[0];
        // Only upgrade if the existing row was a catchall placeholder.
        // A user-curated row with a real domain we don't match on shouldn't
        // be silently overwritten — leave it and use it.
        if (existing.needs_domain_review === true) {
          // Fold the LinkedIn URL backfill into this same UPDATE so we
          // don't issue two writes for the same row.
          const shouldFillUrl = companyLinkedInUrl &&
            (existing.linkedin_company_url == null ||
             existing.linkedin_company_url === '');
          await client.query(
            `UPDATE accounts
                SET domain = $2,
                    needs_domain_review = FALSE,
                    industry = COALESCE(industry, $3),
                    size     = COALESCE(size, $4),
                    linkedin_company_url = CASE WHEN $5 THEN $6 ELSE linkedin_company_url END,
                    updated_at = CURRENT_TIMESTAMP
              WHERE id = $1`,
            [existing.id, realDomain, companyIndustry || null, companySize || null,
             shouldFillUrl, companyLinkedInUrl || null]
          );
          return { accountId: existing.id, status: 'upgraded_catchall' };
        }
        await maybeBackfillLinkedInUrl(existing.id);
        return { accountId: existing.id, status: 'matched_by_name' };
      }
    }

    // c. Create with real domain.
    const ins = await client.query(
      `INSERT INTO accounts
         (org_id, owner_id, name, domain, industry, size,
          needs_domain_review, linkedin_company_url)
       VALUES ($1, $2, $3, $4, $5, $6, FALSE, $7)
       RETURNING id`,
      [orgId, ownerId, trimmedName || realDomain, realDomain,
       companyIndustry || null, companySize || null,
       companyLinkedInUrl || null]
    );
    return { accountId: ins.rows[0].id, status: 'created_real_domain' };
  }

  // ── Path B: no real domain — catchall flow ──────────────────────────
  // (We know trimmedName is non-empty because of the early return above.)

  // a. Match by name — if any account exists for this name (catchall OR real),
  //    use it. The user might have created a real-domain account for this
  //    company yesterday; we don't want a new prospect to bypass it just
  //    because we couldn't derive the domain this time.
  const byNameOnly = await client.query(
    `SELECT id FROM accounts
      WHERE org_id = $1 AND LOWER(TRIM(name)) = LOWER($2) AND deleted_at IS NULL
      LIMIT 1`,
    [orgId, trimmedName.toLowerCase()]
  );
  if (byNameOnly.rows.length > 0) {
    await maybeBackfillLinkedInUrl(byNameOnly.rows[0].id);
    return { accountId: byNameOnly.rows[0].id, status: 'matched_by_name' };
  }

  // b. Create catchall account.
  const insCatch = await client.query(
    `INSERT INTO accounts
       (org_id, owner_id, name, domain, industry, size,
        needs_domain_review, linkedin_company_url)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7)
     RETURNING id`,
    [orgId, ownerId, trimmedName, CATCHALL_DOMAIN,
     companyIndustry || null, companySize || null,
     companyLinkedInUrl || null]
  );
  return { accountId: insCatch.rows[0].id, status: 'created_catchall' };
}

module.exports = {
  CATCHALL_DOMAIN,
  normalizeDomain,
  normalizeLinkedInCompanyUrl,
  extractDomainFromEmail,
  deriveDomain,
  resolveAccountId,
};
