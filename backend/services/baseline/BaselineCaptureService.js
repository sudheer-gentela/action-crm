/**
 * baseline/BaselineCaptureService.js
 *
 * DROP-IN LOCATION: backend/services/baseline/BaselineCaptureService.js
 *
 * Orchestrates the assessment sequence:
 *   discover → map (human-approved stage mapping) → pull history → compute
 *   → freeze
 *
 * Public API:
 *   runDiscovery({ connectionId, orgId, userId })
 *       → { schemaSnapshotId, warnings }
 *
 *   captureBaseline({ connectionId, orgId, userId })
 *       → { snapshotId, status, warnings }        (awaits full run)
 *
 *   startBaselineCapture({ connectionId, orgId, userId })
 *       → { snapshotId, status: 'computing' }     (returns immediately;
 *         capture continues in background; poll GET /api/baseline/snapshots/:id)
 *
 * WEEK-2 INPUTS (complete in this version):
 *   - Activity recency: Salesforce Opportunity.LastActivityDate (standard
 *     roll-up of latest Task/Event); HubSpot notes_last_contacted deal
 *     property. Cheap single-field pulls — no Task aggregation needed.
 *     Directionality (two-way vs logged-at-all) is NOT observable from these
 *     fields; the activity metric self-describes as "logged activity" via its
 *     hygiene note rather than claiming two-way precision it doesn't have.
 *   - Threading: Salesforce OpportunityContactRole GROUP BY OpportunityId
 *     (aggregate-row ceiling 2000 → warning when hit); HubSpot
 *     num_associated_contacts standard property.
 *   - HubSpot owner names: /crm/v3/owners paged map (id → name).
 *   - HubSpot closed-deal meta now derives from the SAME deals pull as open
 *     deals (one pass, no second pull).
 *
 * Design invariants (unchanged from v1):
 *   - Computes WITHOUT hydrating deals into the working tables.
 *   - baseline_config resolved at capture time and COPIED onto the snapshot.
 *   - Frozen rows are immutable at the DB level (2026_61 trigger); failed
 *     rows stay mutable so retries work.
 *   - Every write carries org_id.
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
    // Industry is an ACCOUNT field in Salesforce (not Opportunity) — pulled
    // via relationship traversal. Dropped automatically for HubSpot.
    { object: 'Opportunity', field: 'Account.Industry' },
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
 * auth through the existing org-level machinery. integration_id NULL →
 * self-contained client-scoped credentials (Phase 3a; explicit until built).
 */
async function _crmHandle(conn) {
  if (conn.integration_id == null) {
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

function _buildStageResolver(stageMap, schemaPayload) {
  const rawMeta = new Map();
  for (const s of (schemaPayload.stage_defs || [])) {
    const meta = {
      isClosed: !!s.isClosed, isWon: !!s.isWon,
      sortOrder: s.sortOrder != null ? s.sortOrder : null,
    };
    rawMeta.set(s.label, meta);
    if (s.id) rawMeta.set(s.id, meta);   // HubSpot internal stage ids
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
      if (!key) return null;
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
// PUBLIC: captureBaseline / startBaselineCapture
// ─────────────────────────────────────────────────────────────────────────────

async function _prepareCapture({ connectionId, orgId, userId }) {
  const conn = await _loadConnection(connectionId, orgId);
  const cfg = _resolveBaselineConfig(conn);
  const stageMap = (conn.settings && conn.settings.stage_map) || {};
  if (!Object.keys(stageMap).length) {
    throw new Error(
      `Connection ${conn.id} has no approved stage_map — run discovery, ` +
      `approve the mapping, then capture.`
    );
  }

  const schemaRes = await pool.query(
    `SELECT id, schema FROM crm_schema_snapshots
      WHERE connection_id = $1 AND org_id = $2 AND status = 'frozen'
      ORDER BY captured_at DESC LIMIT 1`,
    [conn.id, orgId]
  );
  if (!schemaRes.rows.length) {
    throw new Error(`No frozen schema snapshot for connection ${conn.id} — run discovery first.`);
  }

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

  return {
    conn, cfg, stageMap,
    schemaPayload: schemaRes.rows[0].schema,
    captureAt,
    snapshotId: ins.rows[0].id,
  };
}

/** Awaits the full capture run. */
async function captureBaseline({ connectionId, orgId, userId }) {
  const prep = await _prepareCapture({ connectionId, orgId, userId });
  return _executeCapture(orgId, prep);
}

/**
 * Creates the snapshot row, returns immediately, computes in background.
 * Errors land in baseline_snapshots.status='failed' + error_detail; the
 * caller polls the snapshot.
 */
async function startBaselineCapture({ connectionId, orgId, userId }) {
  const prep = await _prepareCapture({ connectionId, orgId, userId });
  setImmediate(async () => {
    try {
      await _executeCapture(orgId, prep);
    } catch (err) {
      console.error(`[baseline] background capture ${prep.snapshotId} failed: ${err.message}`);
    }
  });
  return { snapshotId: prep.snapshotId, status: 'computing' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Capture execution
// ─────────────────────────────────────────────────────────────────────────────

async function _executeCapture(orgId, prep) {
  const { conn, cfg: rawCfg, stageMap, schemaPayload, captureAt, snapshotId } = prep;
  const warnings = [];

  // ── Segment-axis validation against the frozen schema ────────────────────
  // A bad axis must cost ITSELF, not the whole pull: unknown fields are
  // dropped with their own warning instead of poisoning the SOQL with
  // INVALID_FIELD (which degraded the entire open-deal pull before).
  const cfg = { ...rawCfg, segment_axes: [] };
  const sfFields = new Set(((schemaPayload.fields || {}).Opportunity || []).map(f => f.name));
  const sfAcct   = new Set(((schemaPayload.fields || {}).Account || []).map(f => f.name));
  const hsFields = new Set(((schemaPayload.fields || {}).deals || []).map(f => f.name));
  for (const axis of (rawCfg.segment_axes || [])) {
    let ok;
    if (conn.crm_type === 'salesforce') {
      const [head, rel] = String(axis.field).split('.');
      ok = rel ? (head === 'Account' && sfAcct.has(rel)) : sfFields.has(axis.field);
    } else {
      ok = !String(axis.field).includes('.') && hsFields.has(String(axis.field).toLowerCase());
    }
    if (ok || axis.field === 'Amount') cfg.segment_axes.push(axis);
    else warnings.push({
      kind: 'segment_axis_dropped',
      detail: `${axis.object}.${axis.field} is not a discoverable field on this ${conn.crm_type} org — axis skipped`,
    });
  }

  try {
    const handle = await _crmHandle(conn);
    if (handle.type === 'salesforce') await handle.sf.init();

    // ── Stage history ────────────────────────────────────────────────────────
    const { events, truncated } = handle.type === 'salesforce'
      ? await getSalesforceStageHistory(handle.sf, { historyMonths: cfg.history_months })
      : await getHubSpotStageHistory(handle.hs, { historyMonths: cfg.history_months });
    if (truncated) warnings.push({ kind: 'history_truncated', detail: 'record ceiling reached; window partially covered' });

    // ── Deals + week-2 inputs ────────────────────────────────────────────────
    let openDeals, closedMeta;
    if (handle.type === 'salesforce') {
      openDeals = await _sfOpenDeals(handle.sf, captureAt, cfg, warnings);
      await _sfAttachContactRoles(handle.sf, openDeals, warnings);
      const closedDeals = await _sfClosedDealMeta(handle.sf, cfg, warnings);
      closedMeta = new Map(closedDeals.map(d => [d.crmId, d]));
    } else {
      const ownerMap = await _hsOwnerMap(handle.hs, warnings);
      const allDeals = await _hsPullDeals(handle.hs, captureAt, cfg, ownerMap, warnings);
      openDeals = allDeals;               // stall filters closed via resolver
      closedMeta = new Map(allDeals.map(d => [d.crmId, {
        crmId: d.crmId, ownerName: d.ownerName, segmentValues: d.segmentValues,
      }]));
    }

    // ── Compute ──────────────────────────────────────────────────────────────
    const resolver = _buildStageResolver(stageMap, schemaPayload);
    const { timelines, unmappedStages } = defs.buildTimelines(events, resolver, captureAt);
    if (unmappedStages.size) {
      warnings.push({
        kind: 'unmapped_historical_stages',
        detail: Object.fromEntries(unmappedStages),
      });
    }

    const cycle      = defs.computeCycleTime({ timelines }, cfg);
    const conversion = defs.computeConversion({ timelines }, resolver, cfg, captureAt);
    const stall      = defs.computeStall(openDeals, cycle.metrics.byStage, resolver, captureAt);
    const activity   = defs.computeActivityCoverage(openDeals);
    const threading  = defs.computeThreading(openDeals);
    const winRates   = defs.computeWinRates({ timelines }, closedMeta, cfg);

    // ── Stage-ledger backfill ────────────────────────────────────────────────
    await _writeHistoryImport(orgId, events);

    // ── Freeze ───────────────────────────────────────────────────────────────
    const metrics = {
      cycleTime: cycle.metrics,
      conversion: conversion.metrics,
      stall: stall.metrics,
      activityCoverage: activity.metrics,
      winRates: winRates.metrics,
      threading: threading.metrics,
    };
    // ── Deal inventory: every deal the snapshot saw, classified ────────────
    // The drill-through layer: headline numbers must be checkable deal by
    // deal, so the inventory records identity + classification + the values
    // each metric consumed. Capped at 1000 rows (warned beyond).
    const stalledSet = new Set((stall.evidence.stalledDeals || []).map(d => d.crmId));
    const inv = new Map();
    for (const d of openDeals) {
      const resolved = resolver.resolve(d.stage);
      const dwellBasis = d.stageChangedAt || d.createdAt;   // never-moved fallback (1.2.0)
      const dwell = dwellBasis
        ? Number(((new Date(captureAt) - new Date(dwellBasis)) / 86400000).toFixed(1)) : null;
      inv.set(d.crmId, {
        crmId: d.crmId, name: d.name || null,
        rawStage: d.stage, stageKey: resolved ? resolved.key : null,
        status: resolved ? (resolved.isClosed ? (resolved.isWon ? 'won' : 'lost') : 'open') : 'unmapped_stage',
        amount: d.amount, createdAt: d.createdAt || null, closeDate: null,
        dwellDays: dwell, stalled: stalledSet.has(d.crmId),
        activityLast30: d.activityLast30, lastActivityAt: d.lastActivityAt || null,
        contactRoleCount: d.contactRoleCount,
        ownerName: d.ownerName || null,
      });
    }
    for (const [cid, meta] of closedMeta) {
      if (inv.has(cid)) continue;
      const tl = timelines.get(cid);
      inv.set(cid, {
        crmId: cid, name: meta.name || null,
        rawStage: meta.rawStage || null,
        stageKey: meta.rawStage ? (resolver.resolve(meta.rawStage)?.key ?? null) : null,
        status: tl && tl.terminal ? (tl.terminal.isWon ? 'won' : 'lost') : 'closed',
        amount: meta.amount ?? null, createdAt: meta.createdAt || null,
        closeDate: meta.closeDate || null,
        dwellDays: null, stalled: false,
        activityLast30: null, contactRoleCount: null,
        ownerName: meta.ownerName || null,
      });
    }
    for (const [cid, tl] of timelines) {
      if (inv.has(cid) || !tl.entries.length) continue;
      inv.set(cid, {
        crmId: cid, name: null, rawStage: tl.entries[tl.entries.length - 1].rawStage,
        stageKey: tl.entries[tl.entries.length - 1].stageKey,
        status: tl.terminal ? (tl.terminal.isWon ? 'won' : 'lost') : 'history_only',
        amount: null, createdAt: null, closeDate: null,
        dwellDays: null, stalled: false, activityLast30: null,
        contactRoleCount: null, ownerName: null,
      });
    }
    let dealInventory = [...inv.values()];
    if (dealInventory.length > 1000) {
      warnings.push({ kind: 'inventory_truncated', detail: `${dealInventory.length} deals seen; inventory capped at 1000` });
      dealInventory = dealInventory.slice(0, 1000);
    }

    const evidence = {
      cycleTime: cycle.evidence,
      stall: stall.evidence,
      dealInventory,
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
// Salesforce pulls
// ─────────────────────────────────────────────────────────────────────────────

function _segmentFieldList(cfg) {
  return (cfg.segment_axes || [])
    .filter(a => a.object === 'Opportunity' || a.object === 'deals')
    .map(a => a.field);
}

/** Read a possibly-dotted field ('Account.Industry') off a SOQL record. */
function _axisValue(record, field) {
  return String(field).split('.').reduce((o, k) => (o == null ? null : o[k]), record) ?? null;
}

function _daysAgo(dateStr, captureAt) {
  if (!dateStr) return null;
  const t = new Date(dateStr).getTime();
  if (Number.isNaN(t)) return null;
  return (new Date(captureAt).getTime() - t) / 86400000;
}

async function _sfPaged(sfClient, soql, collect) {
  let page = await sfClient.query(soql);
  collect(page.records);
  while (!page.done && page.nextRecordsUrl) {
    const raw = await sfClient._request('GET', `${sfClient.instanceUrl}${page.nextRecordsUrl}`);
    page = { records: raw.records || [], done: raw.done ?? true, nextRecordsUrl: raw.nextRecordsUrl || null };
    collect(page.records);
  }
}

async function _sfOpenDeals(sfClient, captureAt, cfg, warnings) {
  const segFields = _segmentFieldList(cfg).filter(f => f !== 'Amount');
  const fieldSel = ['Id', 'Name', 'StageName', 'Amount', 'CreatedDate', 'LastStageChangeDate',
    'LastActivityDate', 'OwnerId', 'Owner.Name', ...segFields];
  const rows = [];
  try {
    await _sfPaged(sfClient,
      `SELECT ${[...new Set(fieldSel)].join(', ')} FROM Opportunity WHERE IsClosed = false`,
      recs => rows.push(...recs));
  } catch (err) {
    // LastStageChangeDate / LastActivityDate can be restricted — degrade once.
    warnings.push({ kind: 'open_deal_pull_degraded', detail: err.message });
    const res = await sfClient.query(
      'SELECT Id, StageName, Amount, CreatedDate, OwnerId FROM Opportunity WHERE IsClosed = false');
    rows.push(...res.records);
  }
  return rows.map(r => {
    const lastAct = _daysAgo(r.LastActivityDate, captureAt);
    return {
      crmId: r.Id,
      name: r.Name || null,
      stage: r.StageName,
      amount: r.Amount != null ? Number(r.Amount) : null,
      createdAt: r.CreatedDate,
      stageChangedAt: r.LastStageChangeDate || null,
      ownerName: r.Owner ? r.Owner.Name : null,
      lastActivityAt: r.LastActivityDate || null,
      segmentValues: Object.fromEntries(segFields.map(f => [f, _axisValue(r, f)])),
      contactRoleCount: null,                 // attached separately
      activityLast14: lastAct == null ? null : (lastAct <= 14 ? 1 : 0),
      activityLast30: lastAct == null ? null : (lastAct <= 30 ? 1 : 0),
    };
  });
}

const SF_AGG_ROW_CEILING = 2000; // SOQL aggregate result ceiling

async function _sfAttachContactRoles(sfClient, openDeals, warnings) {
  if (!openDeals.length) return;
  try {
    const res = await sfClient.query(
      'SELECT OpportunityId oid, COUNT(Id) c FROM OpportunityContactRole ' +
      'WHERE Opportunity.IsClosed = false GROUP BY OpportunityId'
    );
    const byOpp = new Map(res.records.map(r => [r.oid, Number(r.c)]));
    for (const d of openDeals) {
      // Zero roles is real data: OCR readable but no rows for this deal.
      d.contactRoleCount = byOpp.get(d.crmId) || 0;
    }
    if (res.records.length >= SF_AGG_ROW_CEILING) {
      warnings.push({
        kind: 'contact_roles_truncated',
        detail: `aggregate row ceiling (${SF_AGG_ROW_CEILING}) reached — threading covers the first ${SF_AGG_ROW_CEILING} opportunities only`,
      });
    }
  } catch (err) {
    warnings.push({ kind: 'contact_roles_unavailable', detail: err.message });
    // contactRoleCount stays null → threading metric self-reports the gap.
  }
}

async function _sfClosedDealMeta(sfClient, cfg, warnings) {
  const segFields = _segmentFieldList(cfg).filter(f => f !== 'Amount');
  const wantAmountBand = (cfg.segment_axes || []).some(a => a.field === 'Amount');
  const fieldSel = ['Id', 'Name', 'StageName', 'Amount', 'CreatedDate', 'CloseDate', 'Owner.Name', ...segFields];
  const out = [];
  try {
    await _sfPaged(sfClient,
      `SELECT ${[...new Set(fieldSel)].join(', ')} FROM Opportunity ` +
      `WHERE IsClosed = true AND CloseDate = LAST_N_MONTHS:${cfg.history_months}`,
      recs => {
        for (const r of recs) {
          const segmentValues = Object.fromEntries(segFields.map(f => [f, _axisValue(r, f)]));
          if (wantAmountBand) segmentValues.Amount = _amountBand(r.Amount);
          out.push({
            crmId: r.Id, name: r.Name || null, rawStage: r.StageName,
            amount: r.Amount != null ? Number(r.Amount) : null,
            createdAt: r.CreatedDate || null, closeDate: r.CloseDate || null,
            ownerName: r.Owner ? r.Owner.Name : null, segmentValues });
        }
      });
  } catch (err) {
    warnings.push({ kind: 'closed_deal_meta_failed', detail: err.message });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// HubSpot pulls
// ─────────────────────────────────────────────────────────────────────────────

async function _hsOwnerMap(hsAdapter, warnings) {
  const map = new Map();
  let after;
  try {
    for (;;) {
      const params = { limit: 100 };
      if (after) params.after = after;
      const data = await hsAdapter._get('/crm/v3/owners', params);
      for (const o of (data.results || [])) {
        const name = [o.firstName, o.lastName].filter(Boolean).join(' ') || o.email || String(o.id);
        map.set(String(o.id), name);
      }
      const next = data.paging && data.paging.next && data.paging.next.after;
      if (!next) break;
      after = next;
    }
  } catch (err) {
    warnings.push({ kind: 'owner_map_unavailable', detail: err.message });
  }
  return map;
}

async function _hsPullDeals(hsAdapter, captureAt, cfg, ownerMap, warnings) {
  const segFields = _segmentFieldList(cfg).filter(f => f.toLowerCase() !== 'amount');
  const wantAmountBand = (cfg.segment_axes || []).some(a => a.field === 'Amount');
  const props = ['dealname', 'dealstage', 'amount', 'createdate',
    'hubspot_owner_id', 'hs_date_entered_current_stage',
    'num_associated_contacts', 'notes_last_contacted', ...segFields];
  const out = [];
  let after;
  try {
    for (;;) {
      const params = { limit: 100, properties: [...new Set(props)].join(',') };
      if (after) params.after = after;
      const data = await hsAdapter._get('/crm/v3/objects/deals', params);
      for (const r of (data.results || [])) {
        const p = r.properties || {};
        const lastAct = _daysAgo(p.notes_last_contacted, captureAt);
        const segmentValues = Object.fromEntries(segFields.map(f => [f, p[f] ?? null]));
        if (wantAmountBand) segmentValues.Amount = _amountBand(p.amount);
        out.push({
          crmId: r.id,
          name: p.dealname || null,
          stage: p.dealstage,
          amount: p.amount != null && p.amount !== '' ? Number(p.amount) : null,
          createdAt: p.createdate || null,
          stageChangedAt: p.hs_date_entered_current_stage || null,
          ownerName: ownerMap.get(String(p.hubspot_owner_id)) || p.hubspot_owner_id || null,
          lastActivityAt: p.notes_last_contacted || null,
          segmentValues,
          contactRoleCount: (p.num_associated_contacts != null && p.num_associated_contacts !== '')
            ? Number(p.num_associated_contacts) : null,
          activityLast14: lastAct == null ? null : (lastAct <= 14 ? 1 : 0),
          activityLast30: lastAct == null ? null : (lastAct <= 30 ? 1 : 0),
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

async function _writeHistoryImport(orgId, events) {
  if (!events.length) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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
  startBaselineCapture,
  DEFAULT_BASELINE_CONFIG,
};
