/**
 * crm/stageHistory.js
 *
 * DROP-IN LOCATION: backend/services/crm/stageHistory.js
 *
 * getDealStageHistory for both CRMs → NormalizedStageEvent[]:
 *
 *   { dealCrmId, fromStage, toStage, changedAt (ISO), amount?, closeDate?,
 *     isDealCreation }
 *
 * Stage names are RAW CRM labels. Resolution to canonical GoWarm stages
 * happens downstream against the connection's approved stage_map — this layer
 * deliberately does not map, so that unmapped HISTORICAL stages (renamed
 * pipelines, retired stages — invisible to the live sync, common in old data)
 * surface as explicit baseline warnings instead of being dropped here.
 *
 * SALESFORCE — OpportunityHistory. Always on, no field-history-tracking
 * configuration required: the core baseline never depends on how well the
 * customer configured their org. One row per stage/amount/closedate change;
 * consecutive rows per opportunity yield from→to transitions. Pagination
 * follows nextRecordsUrl through the client's own _request (absolute-URL
 * branch), so auth refresh and the per-run API budget both apply.
 *
 * HUBSPOT — GET /crm/v3/objects/deals?propertiesWithHistory=dealstage.
 * Each deal returns its dealstage version list (value + timestamp), the
 * OpportunityHistory analog. Paged with the standard `after` token.
 */

// ─────────────────────────────────────────────────────────────────────────────
// SALESFORCE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} sfClient       initialised salesforce.client.js instance
 * @param {object} opts
 * @param {number} opts.historyMonths   trailing window (default 18)
 * @param {number} [opts.maxRecords]    safety ceiling (default 200000)
 * @returns {Promise<{events: object[], truncated: boolean}>}
 */
async function getSalesforceStageHistory(sfClient, opts = {}) {
  const historyMonths = opts.historyMonths || 18;
  const maxRecords    = opts.maxRecords || 200000;

  const soql =
    'SELECT OpportunityId, StageName, Amount, CloseDate, CreatedDate ' +
    'FROM OpportunityHistory ' +
    `WHERE CreatedDate = LAST_N_MONTHS:${historyMonths} ` +
    'ORDER BY OpportunityId, CreatedDate ASC';

  const rows = [];
  let page = await sfClient.query(soql);
  rows.push(...page.records);

  while (!page.done && page.nextRecordsUrl && rows.length < maxRecords) {
    // nextRecordsUrl is instance-relative ("/services/data/vXX/query/01g...").
    // Passing it absolute routes it through _request's startsWith('http')
    // branch — same auth, same refresh, same API-call budget.
    const raw = await sfClient._request('GET', `${sfClient.instanceUrl}${page.nextRecordsUrl}`);
    page = {
      records:        raw.records || [],
      done:           raw.done ?? true,
      nextRecordsUrl: raw.nextRecordsUrl || null,
    };
    rows.push(...page.records);
  }
  const truncated = rows.length >= maxRecords;

  // Consecutive-row diff per opportunity → transitions. The FIRST history row
  // for an opportunity inside the window has no observed predecessor:
  // fromStage=null, isDealCreation=true only if it plausibly IS creation
  // (callers treat null-from rows as window-entry, not necessarily creation).
  const events = [];
  let prevOpp = null;
  let prevStage = null;
  for (const r of rows) {
    if (r.OpportunityId !== prevOpp) {
      prevOpp = r.OpportunityId;
      prevStage = null;
    }
    if (r.StageName !== prevStage) {
      events.push({
        dealCrmId:      r.OpportunityId,
        fromStage:      prevStage,
        toStage:        r.StageName,
        changedAt:      r.CreatedDate,
        amount:         r.Amount != null ? Number(r.Amount) : null,
        closeDate:      r.CloseDate || null,
        isDealCreation: prevStage === null,
      });
      prevStage = r.StageName;
    }
    // Amount/CloseDate-only history rows (same stage) are skipped: stage
    // ledger only. Amount trajectory is a v2 metric.
  }

  return { events, truncated };
}

// ─────────────────────────────────────────────────────────────────────────────
// HUBSPOT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} hsAdapter      initialised hubspot.adapter.js instance
 * @param {object} opts
 * @param {number} opts.historyMonths
 * @param {number} [opts.maxDeals]      safety ceiling (default 50000)
 * @returns {Promise<{events: object[], truncated: boolean}>}
 */
async function getHubSpotStageHistory(hsAdapter, opts = {}) {
  const historyMonths = opts.historyMonths || 18;
  const maxDeals      = opts.maxDeals || 50000;
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - historyMonths);
  const cutoffMs = cutoff.getTime();

  const events = [];
  let after = undefined;
  let dealCount = 0;
  let truncated = false;

  for (;;) {
    const params = {
      limit: 100,
      propertiesWithHistory: 'dealstage',
      properties: 'dealstage,amount,closedate,pipeline,createdate',
    };
    if (after) params.after = after;

    const data = await hsAdapter._get('/crm/v3/objects/deals', params);
    const results = data.results || [];

    for (const deal of results) {
      dealCount++;
      const versions = deal.propertiesWithHistory
        && deal.propertiesWithHistory.dealstage
        ? [...deal.propertiesWithHistory.dealstage] : [];
      // HubSpot returns newest-first; sort ascending for the diff walk.
      versions.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

      const props = deal.properties || {};
      let prevStage = null;
      for (const v of versions) {
        const ts = new Date(v.timestamp).getTime();
        if (Number.isNaN(ts)) continue;
        if (ts < cutoffMs) {
          // Pre-window transition: remember as predecessor, don't emit.
          prevStage = v.value;
          continue;
        }
        if (v.value !== prevStage) {
          events.push({
            dealCrmId:      deal.id,
            fromStage:      prevStage,
            toStage:        v.value,
            changedAt:      v.timestamp,
            amount:         props.amount != null && props.amount !== '' ? Number(props.amount) : null,
            closeDate:      props.closedate || null,
            pipelineId:     props.pipeline || null,
            isDealCreation: prevStage === null
              && props.createdate
              && new Date(props.createdate).getTime() >= cutoffMs,
          });
          prevStage = v.value;
        }
      }
    }

    if (dealCount >= maxDeals) { truncated = true; break; }
    const next = data.paging && data.paging.next && data.paging.next.after;
    if (!next) break;
    after = next;
  }

  return { events, truncated };
}

module.exports = { getSalesforceStageHistory, getHubSpotStageHistory };
