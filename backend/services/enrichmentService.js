// ============================================================================
// services/enrichmentService.js
//
// Orchestrates account enrichment: looks up the prospect → account, calls
// the enrichment provider, applies the result to the account row, and
// stamps the raw response into research_meta.coresignal.
//
// Callers don't need to care which provider is being used — that's
// configured via env (ENRICHMENT_PROVIDER), defaulting to coresignal.
//
// Failure model:
//   - Provider errors are surfaced as { ok: false, reason } with no DB
//     mutation. The catchall + flag stays as-is. The route can return
//     this verbatim to the caller for display.
//   - "Not found" (provider had no record for this company) is a normal
//     outcome, not an error. We surface it as ok:false reason:'not_found'.
//   - DB write errors throw. The route should 500.
//
// Apply rules (account row is the destination):
//   - domain: only set when provider returned a real domain AND the row
//     currently has catchall (or empty). Never overwrite a real domain.
//   - industry: fill if currently null/empty. Never overwrite.
//   - size: fill if currently null/empty. Never overwrite.
//   - location: fill if currently null/empty. Never overwrite.
//   - description: fill if currently null/empty. Never overwrite.
//   - needs_domain_review: cleared only when a real domain was set.
//   - research_meta.coresignal: always written (raw payload + timestamp +
//     enrichment status), even on partial successes.
// ============================================================================

const { pool } = require('../config/database');
const enrichmentProvider = require('./enrichment');
const { CATCHALL_DOMAIN } = require('./domainResolver');

// ─────────────────────────────────────────────────────────────────────────────
// enrichAccountForProspect — prospect-anchored entry point
//
// The extension calls this via /prospects/:id/enrich-from-coresignal: it
// only knows prospect IDs at the time it dispatches. We resolve the
// account from the prospect, then delegate to enrichAccountById.
// ─────────────────────────────────────────────────────────────────────────────
async function enrichAccountForProspect({ prospectId, orgId }) {
  let client;
  try {
    client = await pool.connect();

    await client.query(
      `SELECT set_config('app.current_org_id', $1::text, true)`,
      [String(orgId)]
    );

    // Fetch prospect → account
    const pr = await client.query(
      `SELECT id, account_id, company_name, company_domain
         FROM prospects
        WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
      [prospectId, orgId]
    );
    if (pr.rows.length === 0) {
      return { ok: false, reason: 'prospect_not_found' };
    }
    const prospect = pr.rows[0];
    if (!prospect.account_id) {
      return { ok: false, reason: 'prospect_has_no_account' };
    }

    return await enrichAccountByIdInternal(client, prospect.account_id, orgId);
  } finally {
    if (client) client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// enrichAccountById — account-anchored entry point
//
// The frontend's "Needs Review" tab calls this directly via
// /accounts/:id/enrich-from-coresignal. No prospect lookup needed.
// ─────────────────────────────────────────────────────────────────────────────
async function enrichAccountById({ accountId, orgId }) {
  let client;
  try {
    client = await pool.connect();

    await client.query(
      `SELECT set_config('app.current_org_id', $1::text, true)`,
      [String(orgId)]
    );

    return await enrichAccountByIdInternal(client, accountId, orgId);
  } finally {
    if (client) client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// enrichAccountByIdInternal — shared core, uses the caller's pg client
//
// All the heavy lifting lives here: identifier selection, provider call,
// failure persistence, success apply rules. Both public entry points
// delegate here so the behavior stays consistent.
// ─────────────────────────────────────────────────────────────────────────────
async function enrichAccountByIdInternal(client, accountId, orgId) {
  const ac = await client.query(
    `SELECT id, name, domain, industry, size, location, description,
            needs_domain_review, linkedin_company_url, research_meta
       FROM accounts
      WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
    [accountId, orgId]
  );
  if (ac.rows.length === 0) {
    return { ok: false, reason: 'account_not_found' };
  }
  const account = ac.rows[0];

  // Pick identifier. Prefer LinkedIn URL; fall back to domain (only if
  // it's a real one, not catchall).
  const linkedinCompanyUrl = account.linkedin_company_url || null;
  const realDomain = (account.domain && account.domain !== CATCHALL_DOMAIN)
    ? account.domain
    : null;

  if (!linkedinCompanyUrl && !realDomain) {
    return {
      ok: false,
      accountId: account.id,
      reason: 'no_identifier_on_account',
    };
  }

  // Call the provider.
  const result = await enrichmentProvider.enrich({
    linkedinCompanyUrl,
      domain: realDomain,
    });

    if (!result.ok) {
      // Persist a failed-attempt record so we don't keep retrying the same
      // dead lookup, and so the UI can show "we tried and got X."
      //
      // For 'ambiguous' specifically: also set needs_domain_review = TRUE.
      // Ambiguous means CoreSignal's search returned multiple candidates and
      // we couldn't safely pick one; the user must resolve it. The flag is
      // how this account stays visible in the catchall queue. (For new
      // catchall accounts the flag is already TRUE; this matters when we
      // re-enrich an account that previously had a real domain and now hits
      // ambiguous on a refresh.)
      const isAmbiguous = result.reason === 'ambiguous';
      await client.query(
        `UPDATE accounts
            SET research_meta = COALESCE(research_meta, '{}'::jsonb)
              || jsonb_build_object(
                  $3::text,
                  jsonb_build_object(
                    'status',        'failed',
                    'reason',        $4::text,
                    'http_status',   to_jsonb($5::int),
                    'upstream_body', to_jsonb($6::text),
                    'hit_count',     to_jsonb($7::int),
                    'attempted_at',  to_jsonb(CURRENT_TIMESTAMP)
                  )
                ),
                needs_domain_review = CASE WHEN $8 THEN TRUE ELSE needs_domain_review END,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND org_id = $2`,
        [account.id, orgId, result.provider, result.reason,
         result.status || null, result.upstream_body || null,
         result.hit_count || null, isAmbiguous]
      );
      return {
        ok: false,
        accountId:       account.id,
        reason:          result.reason,
        provider:        result.provider,
        upstream_status: result.status || null,
        upstream_body:   result.upstream_body || null,
        hit_count:       result.hit_count || null,
      };
    }

    const data = result.data;

    // Apply rules. Build the SET clause dynamically so we only touch
    // fields we're actually changing (and so the SQL is auditable in logs).
    //
    // Param numbering: $1 is account.id, $2 is orgId. Field params start at $3.
    // The WHERE clause uses both to keep the UPDATE org-scoped (defense in
    // depth — we already SELECTed by org_id above, but writes get the same
    // explicit check so a future refactor can't accidentally drop it).
    const sets = [];
    const params = [account.id, orgId];
    let p = 3;
    const applied = {};

    // domain — fill only if currently catchall or empty
    const isCatchallOrEmpty = !account.domain ||
                              account.domain === CATCHALL_DOMAIN ||
                              account.domain.trim() === '';
    if (data.domain && isCatchallOrEmpty) {
      sets.push(`domain = $${p}`);          params.push(data.domain);    applied.domain = data.domain;     p++;
      sets.push(`needs_domain_review = FALSE`);                          applied.needs_domain_review_cleared = true;
    }
    // industry — fill if missing
    if (data.industry && (!account.industry || account.industry.trim() === '')) {
      sets.push(`industry = $${p}`);        params.push(data.industry);  applied.industry = data.industry; p++;
    }
    // size — fill if missing
    if (data.size && (!account.size || account.size.trim() === '')) {
      sets.push(`size = $${p}`);            params.push(data.size);      applied.size = data.size;         p++;
    }
    // location — fill if missing
    if (data.location && (!account.location || account.location.trim() === '')) {
      sets.push(`location = $${p}`);        params.push(data.location);  applied.location = data.location; p++;
    }
    // description — fill if missing
    if (data.description && (!account.description || account.description.trim() === '')) {
      sets.push(`description = $${p}`);     params.push(data.description); applied.description_set = true;  p++;
    }

    // research_meta.<provider> always written, on success too. Includes
    // the full raw payload for downstream re-mapping if we ever change
    // our normalization rules without re-paying for the API call.
    sets.push(`research_meta = COALESCE(research_meta, '{}'::jsonb)
      || jsonb_build_object(
           $${p}::text,
           jsonb_build_object(
             'status',         'ok',
             'enriched_at',    to_jsonb(CURRENT_TIMESTAMP),
             'normalized',     $${p + 1}::jsonb,
             'raw',            $${p + 2}::jsonb
           )
         )`);
    params.push(result.provider);
    params.push(JSON.stringify(data));
    params.push(JSON.stringify(result.raw));
    p += 3;

    sets.push(`updated_at = CURRENT_TIMESTAMP`);

    await client.query(
      `UPDATE accounts SET ${sets.join(', ')} WHERE id = $1 AND org_id = $2`,
      params
    );

    return {
      ok: true,
      accountId: account.id,
      status: Object.keys(applied).length > 0 ? 'fields_applied' : 'no_fields_applied',
      enriched: applied,
      provider: result.provider,
    };
}

module.exports = {
  enrichAccountForProspect,
  enrichAccountById,
};
