/**
 * baseline/BaselineCaptureService.js
 *
 * DROP-IN LOCATION: backend/services/baseline/BaselineCaptureService.js
 *
 * Orchestrates the assessment sequence:
 *
 *   discover → map (human-approved stage mapping) → pull history → compute
 *   → freeze
 *
 * Public API:
 *   runDiscovery({ connectionId, orgId, userId })
 *       → { schemaSnapshotId, warnings }
 *     Runs schemaDiscovery, freezes a crm_schema_snapshots row. Idempotent
 *     per connection per day — re-running creates a new snapshot; old ones
 *     stay frozen (config-debt history is content).
 *
 *   captureBaseline({ connectionId, orgId, userId })
 *       → { snapshotId, status, warnings }
 *     Requires: a frozen schema snapshot AND an approved stage_map on the
 *     connection. Pulls stage history + open deals + activity counts through
 *     the CRM adapter, computes all six metric families via metricDefs,
 *     writes crm_history_import rows into deal_stage_history, and freezes
 *     the baseline_snapshots row. Fails loudly into status='failed' with
 *     error_detail; failed rows stay mutable so retries work.
 *
 * Design invariants:
 *   - Computes WITHOUT hydrating deals into the working tables (assessment
 *     orgs stay clean). deal_stage_history rows carry crm_deal_id.
 *   - baseline_config resolved from crm_connections.settings at capture time
 *     and COPIED onto the snapshot (audit trail — connection config may
 *     change later; the snapshot's config may not).
 *   - Every write carries org_id. Keep it that way.
 *
 * Week-2 TODO markers (agreed skeleton scope): activity-count pull and
 * contact-role pull are stubbed with explicit warnings so a week-1 capture
 * still freezes an honest snapshot (metrics 4 and 6 report their data gaps
 * through the hygiene notes rather than fake zeros).
 */

const { pool } = require('../../config/database');

const { createClient }         = require('../salesforce.client');
const { createHubSpotAdapter } = require('../crm/adapters/hubspot.adapter');
const { discoverSalesforce, discoverHubSpot } = require('../crm/schemaDiscovery');
const { getSalesforceStageHistory, getHubSpotStageHistory } = require('../crm/stageHistory');
const defs = require('./metricDefs');

const DEFAULT_BASELINE_CONFIG = {
  history_months: 18,          // decision 2
  cycle_calc: 'sum_dwell',     // decision 1
  segment_axes: [              // decision 3 — extensible per connection
    { object: 'Opportunity', field: 'Amount', banding: 'auto' },
    { object: 'Opportunity', field: 'Industry' },
  ],
  min_cell_n: 5,
  max_cycle_days: 270,
  report: { branding: 'gowarm' },  // decision 5
};

// ─────────────────────────────────────────────────────────────────────────────
// Connection + CRM handle resolution
// ─────────────────────────────────────────────────────────────────────────────

async function _loadConnection(connectionId, orgId) {
  const res = await pool.query(
    `SELECT * FROM crm_connections WHERE id = $1 AND org_id = $2`,
    [connectionId, orgId]
  );
  if (!res.rows.length) throw new Error(`crm_connection ${connectionId} not found for org ${orgId}`);
  return res.rows[0];
}

/**
 * Credential resolution rule (2026_60): integration_id set → pointer mode,
 * auth through the existing org-level machinery (sfAuth/hsAuth refresh stays
 * the single writer). integration_id NULL → self-contained client-scoped
 * credentials (Phase 3; not reachable until the client-connect flow lands).
 */
async function _crmHandle(conn) {
  if (conn.integration_id == null) {
    // Phase 3 path — client-scoped credentials. Explicit until built.
    throw new Error(
      `Connection ${conn.id} is self-contained (client-scoped); ` +
      `client-credential resolution lands in Phase 3a.`
    );
  }
  if (conn.crm_type === 'salesforce') {
    const sf = await createClient(conn.org_id);
    return { type: 'salesforce', sf };
  }
  if (conn.crm_type === 'hubspot') {
    const hs = await createHubSpotAdapter(conn.org_id);
    return { type: 'hubspot', hs };
  }
  throw new Error(`Unsupported crm_type ${conn.crm_type}`);
}

function _resolveBaselineConfig(conn) {
  const stored = (conn.settings && conn.settings.baseline_config) || {};
  return { ...DEFAULT_BASELINE_CONFIG, ...stored };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage resolver: connection stage_map + schema snapshot stage_defs
// ─────────────────────────────────────────────────────────────────────────────
//
// Canonical stage keys come from the APPROVED stage_map; closed/won semantics
// come from the CRM's OWN stage metadata (OpportunityStage / pipeline stage
// metadata) in the frozen schema snapshot — never guessed from names.

function _buildStageResolver(stageMap, schemaPayload) {
  const rawMeta = new Map(); // raw label → { isClosed, isWon, sortOrder }
  for (const s of (schemaPayload.stage_defs || [])) {
    rawMeta.set(s.label, {
      isClosed: !!s.isClosed, isWon: !!s.isWon,
      sortOrder: s.sortOrder != null ? s.sortOrder : null,
    });
    // HubSpot stage_defs also carry internal ids as `id`
    if (s.id) rawMeta.set(s.id, {
      isClosed: !!s.isClosed, isWon: !!s.isWon,
      sortOrder: s.sortOrder != null ? s.sortOrder : null,
    });
  }

  const activeOrdered = [];
  const seen = new Set();
  for (const [raw, key] of Object.entries(stageMap || {})) {
    const meta = rawMeta.get(raw);
    if (meta && !meta.isClosed && !seen.has(key)) {
      activeOrdered.push({ key, sortOrder: meta.sortOrder ?? 999 });
      seen.add(key);
    }
  }
  activeOrdered.sort((a, b) => a.sortOrder - b.sortOrder);

  return {
    resolve(rawLabel) {
      if (rawLabel == null) return null;
      const key = (stageMap || {})[rawLabel];
      if (!key) return null;                       // unmapped → warning upstream
      const meta = rawMeta.get(rawLabel) || {};
      return {
        key,
        isClosed: !!meta.isClosed,
        isWon: !!meta.isWon,
        sortOrder: meta.sortOrder ?? null,
      };
    },
    activeStagesInOrder() { return activeOrdered.map(x => x.key); },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: runDiscovery
// ─────────────────────────────────────────────────────────────────────────────

async function runDiscovery({ connectionId, orgId, userId }) {
  const conn = await _loadConnection(connectionId, orgId);
  const cfg = _resolveBaselineConfig(conn);

  const ins = await pool.query(
    `INSERT INTO crm_schema_snapshots
       (org_id, client_id, connection_id, crm_type, status)
     VALUES ($1, $2, $3, $4, 'computing') RETURNING id`,
    [orgId, conn.client_id, conn.id, conn.crm_type]
  );
  const snapId = ins.rows[0].id;

  try {
    const handle = await _crmHandle(conn);
    if (handle.type === 'salesforce') await handle.sf.init();

    const payload = handle.type === 'salesforce'
      ? await discoverSalesforce(handle.sf, { historyMonths: cfg.history_months })
      : await discoverHubSpot(handle.hs, { historyMonths: cfg.history_months });

    await pool.query(
      `UPDATE crm_schema_snapshots
          SET schema = $1, warnings = $2, status = 'frozen'
        WHERE id = $3 AND org_id = $4`,
      [JSON.stringify(payload), JSON.stringify(payload.warnings || []), snapId, orgId]
    );
    return { schemaSnapshotId: snapId, warnings: payload.warnings || [] };
  } catch (err) {
    await pool.query(
      `UPDATE crm_schema_snapshots
          SET status = 'failed', error_detail = $1
        WHERE id = $2 AND org_id = $3`,
      [err.message, snapId, orgId]
    );
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: captureBaseline
// ─────────────────────────────────────────────────────────────────────────────

async function captureBaseline({ connectionId, orgId, userId }) {
  const conn = await _loadConnection(connectionId, orgId);
  const cfg = _resolveBaselineConfig(conn);
  const stageMap = (conn.settings && conn.settings.stage_map) || {};
  if (!Object.keys(stageMap).length) {
    throw new Error(
      `Connection ${conn.id} has no approved stage_map — run discovery, ` +
      `approve the mapping, then capture.`
    );
  }

  // Latest frozen schema snapshot is a hard prerequisite (stage semantics).
  const schemaRes = await pool.query(
    `SELECT id, schema FROM crm_schema_snapshots
      WHERE connection_id = $1 AND org_id = $2 AND status = 'frozen'
      ORDER BY captured_at DESC LIMIT 1`,
    [conn.id, orgId]
  );
  if (!schemaRes.rows.length) {
    throw new Error(`No frozen schema snapshot for connection ${conn.id} — run discovery first.`);
  }
  const schemaPayload = schemaRes.rows[0].schema;

  const captureAt = new Date();
  const historyFrom = new Date(captureAt);
  historyFrom.setMonth(historyFrom.getMonth() - cfg.history_months);

  const ins = await pool.query(
    `INSERT INTO baseline_snapshots
       (org_id, client_id, connection_id, crm_type, metric_defs_version,
        baseline_config, status, history_from, history_to, computed_by)
     VALUES ($1,$2,$3,$4,$5,$6,'computing',$7,$8,$9) RETURNING id`,
    [orgId, conn.client_id, conn.id, conn.crm_type, defs.METRIC_DEFS_VERSION,
     JSON.stringify(cfg), historyFrom, captureAt, userId || null]
  );
  const snapshotId = ins.rows[0].id;
  const warnings = [];

  try {
    const handle = await _crmHandle(conn);
    if (handle.type === 'salesforce') await handle.sf.init();

    // ── Pull stage history ───────────────────────────────────────────────────
    const { events, truncated } = handle.type === 'salesforce'
      ? await getSalesforceStageHistory(handle.sf, { historyMonths: cfg.history_months })
      : await getHubSpotStageHistory(handle.hs, { historyMonths: cfg.history_months });
    if (truncated) warnings.push({ kind: 'history_truncated', detail: 'record ceiling reached; window partially covered' });

    // ── Pull open deals (+ segment axis values) ──────────────────────────────
    const openDeals = handle.type === 'salesforce'
      ? await _sfOpenDeals(handle.sf, cfg, warnings)
      : await _hsOpenDeals(handle.hs, cfg, warnings);

    // TODO(week 2): activity counts (SF Task/Event grouped by WhatId; HubSpot
    // engagements) and contact roles (OpportunityContactRole / associations).
    // Until then metrics 4 & 6 self-report their gap via hygiene notes.
    warnings.push({ kind: 'partial_inputs', detail: 'activity coverage and threading pulled in week-2 build; hygiene notes reflect the gap' });

    // ── Compute ──────────────────────────────────────────────────────────────
    const resolver = _buildStageResolver(stageMap, schemaPayload);
    const { timelines, unmappedStages } = defs.buildTimelines(events, resolver, captureAt);
    if (unmappedStages.size) {
      warnings.push({
        kind: 'unmapped_historical_stages',
        detail: Object.fromEntries(unmappedStages),   // raw label → event count
      });
    }

    const cycle      = defs.computeCycleTime({ timelines }, cfg);
    const conversion = defs.computeConversion({ timelines }, resolver, cfg, captureAt);
    const stall      = defs.computeStall(openDeals, cycle.metrics.byStage, resolver, captureAt);
    const activity   = defs.computeActivityCoverage(openDeals);
    const threading  = defs.computeThreading(openDeals);

    const closedMeta = new Map();
    for (const d of openDeals) { /* open deals irrelevant for win rate */ }
    // Win-rate meta comes from terminal-event amounts + segment values pulled
    // with the closed-deal query below.
    const closedDeals = handle.type === 'salesforce'
      ? await _sfClosedDealMeta(handle.sf, cfg, warnings)
      : await _hsClosedDealMeta(handle.hs, cfg, warnings);
    for (const d of closedDeals) closedMeta.set(d.crmId, d);
    const winRates = defs.computeWinRates({ timelines }, closedMeta, cfg);

    // ── Persist stage ledger backfill ────────────────────────────────────────
    await _writeHistoryImport(orgId, events, resolver);

    // ── Freeze ───────────────────────────────────────────────────────────────
    const metrics = {
      cycleTime: cycle.metrics,
      conversion: conversion.metrics,
      stall: stall.metrics,
      activityCoverage: activity.metrics,
      winRates: winRates.metrics,
      threading: threading.metrics,
    };
    const evidence = {
      cycleTime: cycle.evidence,
      stall: stall.evidence,
    };

    await pool.query(
      `UPDATE baseline_snapshots
          SET metrics = $1, evidence = $2, warnings = $3, status = 'frozen'
        WHERE id = $4 AND org_id = $5`,
      [JSON.stringify(metrics), JSON.stringify(evidence),
       JSON.stringify(warnings), snapshotId, orgId]
    );
    return { snapshotId, status: 'frozen', warnings };
  } catch (err) {
    await pool.query(
      `UPDATE baseline_snapshots
          SET status = 'failed', error_detail = $1
        WHERE id = $2 AND org_id = $3`,
      [err.message, snapshotId, orgId]
    );
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Open / closed deal pulls (no hydration into working tables)
// ─────────────────────────────────────────────────────────────────────────────

function _segmentFieldList(cfg) {
  return (cfg.segment_axes || [])
    .filter(a => a.object === 'Opportunity' || a.object === 'deals')
    .map(a => a.field);
}

async function _sfOpenDeals(sfClient, cfg, warnings) {
  const segFields = _segmentFieldList(cfg).filter(f => f !== 'Amount');
  const fieldSel = ['Id', 'StageName', 'Amount', 'CreatedDate', 'LastStageChangeDate',
    'OwnerId', 'Owner.Name', ...segFields];
  let soql =
    `SELECT ${[...new Set(fieldSel)].join(', ')} FROM Opportunity ` +
    `WHERE IsClosed = false`;
  const rows = [];
  try {
    let page = await sfClient.query(soql);
    rows.push(...page.records);
    while (!page.done && page.nextRecordsUrl) {
      const raw = await sfClient._request('GET', `${sfClient.instanceUrl}${page.nextRecordsUrl}`);
      page = { records: raw.records || [], done: raw.done ?? true, nextRecordsUrl: raw.nextRecordsUrl || null };
      rows.push(...page.records);
    }
  } catch (err) {
    // LastStageChangeDate needs API v52+; some orgs restrict it. Degrade once.
    warnings.push({ kind: 'open_deal_pull_degraded', detail: err.message });
    const res = await sfClient.query(
      'SELECT Id, StageName, Amount, CreatedDate, OwnerId FROM Opportunity WHERE IsClosed = false');
    rows.push(...res.records);
  }
  return rows.map(r => ({
    crmId: r.Id,
    stage: r.StageName,
    amount: r.Amount != null ? Number(r.Amount) : null,
    createdAt: r.CreatedDate,
    stageChangedAt: r.LastStageChangeDate || null,
    ownerName: r.Owner ? r.Owner.Name : null,
    segmentValues: Object.fromEntries(segFields.map(f => [f, r[f] ?? null])),
    contactRoleCount: null,   // week 2
    activityLast14: null,     // week 2
    activityLast30: null,     // week 2
  }));
}

async function _sfClosedDealMeta(sfClient, cfg, warnings) {
  const segFields = _segmentFieldList(cfg).filter(f => f !== 'Amount');
  const fieldSel = ['Id', 'Amount', 'Owner.Name', ...segFields];
  const soql =
    `SELECT ${[...new Set(fieldSel)].join(', ')} FROM Opportunity ` +
    `WHERE IsClosed = true AND CloseDate = LAST_N_MONTHS:${cfg.history_months}`;
  const out = [];
  try {
    let page = await sfClient.query(soql);
    const collect = (records) => {
      for (const r of records) {
        const segmentValues = Object.fromEntries(segFields.map(f => [f, r[f] ?? null]));
        if ((cfg.segment_axes || []).some(a => a.field === 'Amount')) {
          segmentValues.Amount = _amountBand(r.Amount);
        }
        out.push({ crmId: r.Id, ownerName: r.Owner ? r.Owner.Name : null, segmentValues });
      }
    };
    collect(page.records);
    while (!page.done && page.nextRecordsUrl) {
      const raw = await sfClient._request('GET', `${sfClient.instanceUrl}${page.nextRecordsUrl}`);
      page = { records: raw.records || [], done: raw.done ?? true, nextRecordsUrl: raw.nextRecordsUrl || null };
      collect(page.records);
    }
  } catch (err) {
    warnings.push({ kind: 'closed_deal_meta_failed', detail: err.message });
  }
  return out;
}

async function _hsOpenDeals(hsAdapter, cfg, warnings) {
  const segFields = _segmentFieldList(cfg).filter(f => f.toLowerCase() !== 'amount');
  const props = ['dealstage', 'amount', 'createdate', 'hs_lastmodifieddate',
    'hubspot_owner_id', 'hs_date_entered_current_stage', ...segFields];
  const out = [];
  let after;
  try {
    for (;;) {
      const params = { limit: 100, properties: [...new Set(props)].join(',') };
      if (after) params.after = after;
      const data = await hsAdapter._get('/crm/v3/objects/deals', params);
      for (const r of (data.results || [])) {
        const p = r.properties || {};
        // Closed-ness resolves downstream through the stage resolver; pull all.
        out.push({
          crmId: r.id,
          stage: p.dealstage,
          amount: p.amount != null && p.amount !== '' ? Number(p.amount) : null,
          createdAt: p.createdate || null,
          stageChangedAt: p.hs_date_entered_current_stage || null,
          ownerName: p.hubspot_owner_id || null,   // id → name resolution week 2
          segmentValues: Object.fromEntries(segFields.map(f => [f, p[f] ?? null])),
          contactRoleCount: null,
          activityLast14: null,
          activityLast30: null,
        });
      }
      const next = data.paging && data.paging.next && data.paging.next.after;
      if (!next) break;
      after = next;
    }
  } catch (err) {
    warnings.push({ kind: 'open_deal_pull_degraded', detail: err.message });
  }
  return out;
}

async function _hsClosedDealMeta(hsAdapter, cfg, warnings) {
  // HubSpot closed-deal meta rides the same pull as open deals in v1 (the
  // timelines decide terminality); segment values already collected there.
  // Kept separate for interface symmetry; week 2 folds owner-name resolution in.
  return [];
}

function _amountBand(amount) {
  const a = Number(amount);
  if (!Number.isFinite(a)) return '(blank)';
  if (a < 10000)   return '<10k';
  if (a < 50000)   return '10k–50k';
  if (a < 250000)  return '50k–250k';
  if (a < 1000000) return '250k–1M';
  return '1M+';
}

// ─────────────────────────────────────────────────────────────────────────────
// deal_stage_history backfill (source = crm_history_import)
// ─────────────────────────────────────────────────────────────────────────────

async function _writeHistoryImport(orgId, events, resolver) {
  if (!events.length) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Idempotent per capture: replace previous import rows for this org.
    await client.query(
      `DELETE FROM deal_stage_history
        WHERE org_id = $1 AND source = 'crm_history_import'`,
      [orgId]
    );
    const CHUNK = 500;
    for (let i = 0; i < events.length; i += CHUNK) {
      const chunk = events.slice(i, i + CHUNK);
      const values = [];
      const params = [];
      chunk.forEach((ev, j) => {
        const base = j * 5;
        values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, 'crm_history_import')`);
        params.push(orgId, ev.dealCrmId, ev.fromStage, ev.toStage, ev.changedAt);
      });
      await client.query(
        `INSERT INTO deal_stage_history
           (org_id, crm_deal_id, from_stage, to_stage, changed_at, source)
         VALUES ${values.join(', ')}`,
        params
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  runDiscovery,
  captureBaseline,
  DEFAULT_BASELINE_CONFIG,
};
