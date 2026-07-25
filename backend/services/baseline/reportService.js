/**
 * baseline/reportService.js
 *
 * DROP-IN LOCATION: backend/services/baseline/reportService.js
 *
 * Turns a FROZEN baseline snapshot into the findings report:
 *
 *   generateReport({ snapshotId, orgId, userId })
 *       → { reportId, narrativeStatus, shareToken: null }
 *     1. findingsEngine.computeFindings  — deterministic layer
 *     2. AI executive narrative          — AIClientResolver, callType
 *        'baseline_report'. HARD RULE enforced by prompt + post-check: the
 *        model narrates, it never produces a number. Any digit sequence in
 *        the narrative that is not present in the findings payload fails the
 *        post-check → narrative_status='failed', report ships findings-only.
 *        Resolver denial (no key / entitlement off) → 'unavailable', same
 *        graceful degradation.
 *     3. renderHtml                      — self-contained HTML with print CSS
 *        (@media print + page-break rules). PDF = browser print-to-PDF; no
 *        headless-chromium dependency on Railway. If server-side PDF is ever
 *        needed, puppeteer slots in behind this same HTML.
 *     4. INSERT baseline_reports         — regenerable; newest row wins.
 *
 *   enableShare({ reportId, orgId })  → { shareToken }   (idempotent)
 *   revokeShare({ reportId, orgId })  → { revoked: true }
 *   getSharedHtml(token)              → { html } | null   (public route)
 *
 * Branding (decision 5): baseline_config.report =
 *   { branding: 'gowarm' }                                    (default)
 *   { branding: 'white_label', label_name, label_logo_url? }
 * White-label with no label_name falls back to the client name (client-scoped
 * connections) or the org name.
 */

const crypto   = require('crypto');
const { pool } = require('../../config/database');

const AIClientResolver     = require('../ai/AIClientResolver');
const TokenTrackingService = require('../TokenTrackingService');
const { computeFindings }  = require('./findingsEngine');

const NARRATIVE_MAX_TOKENS = 1400;

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: generateReport
// ─────────────────────────────────────────────────────────────────────────────

async function generateReport({ snapshotId, orgId, userId }) {
  // Load the frozen snapshot + its schema snapshot + naming context.
  const snapRes = await pool.query(`
    SELECT bs.*, cc.crm_type AS conn_crm_type, cc.client_id AS conn_client_id,
           cc.instance_url AS conn_instance_url,
           o.name AS org_name, c.name AS client_name, c.logo_url AS client_logo_url
    FROM baseline_snapshots bs
    JOIN crm_connections cc ON cc.id = bs.connection_id
    JOIN organizations o    ON o.id = bs.org_id
    LEFT JOIN clients c     ON c.id = bs.client_id
    WHERE bs.id = $1 AND bs.org_id = $2
  `, [snapshotId, orgId]);
  if (!snapRes.rows.length) throw Object.assign(new Error('Snapshot not found'), { statusCode: 404 });
  const snap = snapRes.rows[0];
  if (snap.status !== 'frozen') {
    throw Object.assign(new Error(`Snapshot is ${snap.status} — reports render from frozen snapshots only`), { statusCode: 409 });
  }

  const schemaRes = await pool.query(`
    SELECT schema FROM crm_schema_snapshots
    WHERE connection_id = $1 AND org_id = $2 AND status = 'frozen'
    ORDER BY captured_at DESC LIMIT 1
  `, [snap.connection_id, orgId]);
  const schemaPayload = schemaRes.rows.length ? schemaRes.rows[0].schema : null;

  // 1. Deterministic layer.
  const { findings, scoreboard, thresholds } = computeFindings(snap, schemaPayload);

  // 2. AI narrative (graceful on denial/failure).
  const narrativeResult = await _composeNarrative({ orgId, userId, snap, findings, scoreboard });

  // 3. Branding + render.
  const branding = _resolveBranding(snap);
  const html = renderHtml({ snap, findings, scoreboard, thresholds, narrative: narrativeResult.narrative, branding });

  // 4. Persist.
  const ins = await pool.query(`
    INSERT INTO baseline_reports
      (org_id, client_id, snapshot_id, connection_id, branding, label_name,
       label_logo_url, findings, narrative, narrative_model, narrative_status,
       html, generated_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    RETURNING id
  `, [
    orgId, snap.client_id, snap.id, snap.connection_id,
    branding.mode, branding.name, branding.logoUrl,
    JSON.stringify({ findings, scoreboard }),
    narrativeResult.narrative ? JSON.stringify(narrativeResult.narrative) : null,
    narrativeResult.model || null,
    narrativeResult.status,
    html,
    userId || null,
  ]);

  return { reportId: ins.rows[0].id, narrativeStatus: narrativeResult.status, findingsCount: findings.length };
}

function _resolveBranding(snap) {
  const rc = (snap.baseline_config && snap.baseline_config.report) || {};
  if (rc.branding === 'white_label') {
    return {
      mode: 'white_label',
      name: rc.label_name || snap.client_name || snap.org_name,
      logoUrl: rc.label_logo_url || snap.client_logo_url || null,
    };
  }
  return { mode: 'gowarm', name: 'GoWarmCRM', logoUrl: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// AI narrative
// ─────────────────────────────────────────────────────────────────────────────

const NARRATIVE_SYSTEM = [
  'You write the executive narrative for a sales-execution assessment report.',
  'You are given computed findings. Your ABSOLUTE rules:',
  '1. NEVER write a number, percentage, dollar amount, or count of any kind.',
  '   Refer to magnitudes only through the finding ids you cite.',
  '2. Every claim must trace to a finding id from the input. Cite ids in',
  '   square brackets, e.g. [stalled_pipeline].',
  '3. Plain business English. No hype, no filler, no exclamation marks.',
  'Return ONLY a JSON object, no markdown fences, with this exact shape:',
  '{ "executive_summary": "<2-3 short paragraphs>",',
  '  "key_risks": ["<risk sentence with [finding_id]>", ...max 3],',
  '  "recommended_focus": ["<action sentence with [finding_id]>", ...max 3] }',
].join('\n');

async function _composeNarrative({ orgId, userId, snap, findings, scoreboard }) {
  if (!findings.length) return { status: 'none', narrative: null, model: null };

  let resolved;
  try {
    resolved = await AIClientResolver.resolve(orgId, userId, 'baseline_report');
  } catch (err) {
    console.warn(`[baseline-report] AI unavailable for org ${orgId}: ${err.message}`);
    return { status: 'unavailable', narrative: null, model: null };
  }

  const { adapter, model, provider, keySource } = resolved;
  const userMessage = [
    'Computed findings (narrate these; cite by id; NO numbers in your output):',
    '```json',
    JSON.stringify({ findings: findings.map(f => ({
      id: f.id, category: f.category, severity: f.severity,
      headline: f.headline, detail: f.detail,
    })) }, null, 2),
    '```',
  ].join('\n');

  try {
    const aiResult = await adapter.complete({
      model,
      system: NARRATIVE_SYSTEM,
      messages: [{ role: 'user', content: userMessage }],
      maxTokens: NARRATIVE_MAX_TOKENS,
    });

    await TokenTrackingService.log({
      orgId, userId, callType: 'baseline_report',
      model, provider, keySource,
      usage: aiResult.usage,
    }).catch(() => {});

    const parsed = _extractJson(aiResult.text);
    if (!parsed) return { status: 'failed', narrative: null, model };

    // Post-check: the no-numbers rule, enforced (years in citations excepted
    // nowhere — the rule is absolute; digits only survive inside [ids]).
    const withoutIds = JSON.stringify(parsed).replace(/\[[a-z0-9_]+\]/gi, '');
    if (/\d/.test(withoutIds)) {
      console.warn('[baseline-report] narrative post-check failed: model produced digits');
      return { status: 'failed', narrative: null, model };
    }

    const narrative = {
      executive_summary: String(parsed.executive_summary || '').slice(0, 4000),
      key_risks:         (Array.isArray(parsed.key_risks) ? parsed.key_risks : []).slice(0, 3).map(String),
      recommended_focus: (Array.isArray(parsed.recommended_focus) ? parsed.recommended_focus : []).slice(0, 3).map(String),
    };
    if (!narrative.executive_summary) return { status: 'failed', narrative: null, model };
    return { status: 'ok', narrative, model };
  } catch (err) {
    console.warn(`[baseline-report] narrative failed: ${err.message}`);
    return { status: 'failed', narrative: null, model };
  }
}

function _extractJson(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML render (self-contained, print-optimized)
// ─────────────────────────────────────────────────────────────────────────────

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function _usd(n) {
  return n == null ? 'n/a'
    : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}
function _pc(x) { return x == null ? 'n/a' : `${(x * 100).toFixed(0)}%`; }
function _dt(d) { return d ? new Date(d).toISOString().slice(0, 10) : 'n/a'; }

const SEV_COLOR = { high: '#DC2626', medium: '#D97706', info: '#2563EB' };

function renderHtml({ snap, findings, scoreboard, thresholds, narrative, branding }) {
  const m = snap.metrics || {};
  const subjectName = snap.client_name || snap.org_name;
  const title = `${subjectName} — Sales Execution Assessment`;

  const brandBlock = branding.logoUrl
    ? `<img src="${_esc(branding.logoUrl)}" alt="${_esc(branding.name)}" style="max-height:42px">`
    : `<div class="brand-name">${_esc(branding.name)}</div>`;

  const scoreCells = [
    ['Open deals', scoreboard.openDeals ?? 'n/a'],
    ['Stalled pipeline', _usd(scoreboard.dollarsStalled)],
    ['Stall rate', _pc(scoreboard.stallRate)],
    ['Win rate (cohort)', _pc(scoreboard.overallWinRate)],
    ['Closed deals analyzed', scoreboard.closedAnalyzed ?? 'n/a'],
    ['30-day activity coverage', _pc(scoreboard.activityCoverage30)],
    ['Single-threaded', _pc(scoreboard.singleThreadedRate)],
    ['Stage regression', _pc(scoreboard.regressionRate)],
  ].map(([k, v]) => `<div class="score"><div class="score-v">${_esc(v)}</div><div class="score-k">${_esc(k)}</div></div>`).join('');

  const narrativeBlock = narrative ? `
    <section class="page-break">
      <h2>Executive summary</h2>
      ${narrative.executive_summary.split(/\n\n+/).map(p => `<p>${_esc(p)}</p>`).join('')}
      ${narrative.key_risks.length ? `<h3>Key risks</h3><ul>${narrative.key_risks.map(r => `<li>${_esc(r)}</li>`).join('')}</ul>` : ''}
      ${narrative.recommended_focus.length ? `<h3>Recommended focus</h3><ul>${narrative.recommended_focus.map(r => `<li>${_esc(r)}</li>`).join('')}</ul>` : ''}
      <p class="fine">Narrative composed over the computed findings below; every magnitude appears only in the findings themselves.</p>
    </section>` : `
    <section>
      <p class="fine">This report ships without an executive narrative (AI layer ${_esc(snap._narrativeStatusNote || 'not available')}); all computed findings follow.</p>
    </section>`;

  const findingsBlock = findings.map(f => `
    <div class="finding">
      <div class="finding-head">
        <span class="sev" style="background:${SEV_COLOR[f.severity] || '#6B7280'}">${_esc(f.severity)}</span>
        <span class="finding-title">${_esc(f.headline)}</span>
      </div>
      <p>${_esc(f.detail)}</p>
      ${f.dollars != null ? `<p class="fine">Quantified: ${_usd(f.dollars)} — sum of open amounts on the deals in evidence (<code>${_esc(f.evidenceRef || '')}</code>).</p>` : ''}
    </div>`).join('');

  // ── Drill-through layer ────────────────────────────────────────────────
  const ev = snap.evidence || {};
  const inventory = Array.isArray(ev.dealInventory) ? ev.dealInventory : [];
  const invById = new Map(inventory.map(d => [d.crmId, d]));
  const sfBase = snap.crm_type === 'salesforce' && snap.conn_instance_url
    ? String(snap.conn_instance_url).replace(/\/$/, '') : null;
  const dealLink = (crmId, label) => sfBase
    ? `<a href="${_esc(`${sfBase}/lightning/r/Opportunity/${crmId}/view`)}" target="_blank" rel="noopener">${_esc(label)}</a>`
    : _esc(label);
  const dealLabel = (crmId) => {
    const d = invById.get(crmId);
    return (d && d.name) ? d.name : crmId;
  };

  const stalledRows = (ev.stall && ev.stall.stalledDeals) || [];
  const stalledDetail = stalledRows.length ? `
    <h3>Stalled deals — the ${stalledRows.length} behind the headline</h3>
    <table><thead><tr><th>Deal</th><th>Stage</th><th>Days in stage</th><th>Stage p75</th><th>Amount</th></tr></thead>
    <tbody>${stalledRows.map(d => `<tr>
      <td>${dealLink(d.crmId, dealLabel(d.crmId))}</td>
      <td>${_esc(d.stage)}</td><td>${d.dwellDays}</td><td>${d.thresholdDays}</td>
      <td>${_usd(d.amount)}</td></tr>`).join('')}</tbody></table>
    <p class="fine">Days in stage measured to capture time; p75 is this stage's own historical threshold. Sum of amounts = the stalled-pipeline headline.</p>` : '';

  const STATUS_LABEL = { open: 'Open', won: 'Won', lost: 'Lost', closed: 'Closed', history_only: 'History only', unmapped_stage: 'Unmapped stage' };
  const inventoryBlock = inventory.length ? `
    <section class="page-break">
      <h2>Deal inventory (${inventory.length} deals considered)</h2>
      <p class="fine">Every deal this snapshot saw in the ${_dt(snap.history_from)} → ${_dt(snap.history_to)} window, with the values each metric consumed.
      "History only" = appears in stage history but closed outside the close-date window. "Unmapped stage" = excluded from stage metrics (see caveats).
      ${sfBase ? 'Deal names link to the Salesforce record for verification.' : ''}</p>
      <table><thead><tr><th>Deal</th><th>Stage</th><th>Status</th><th>Amount</th><th>Created</th><th>Days in stage</th><th>Stalled</th><th>Last activity</th><th>Contacts</th><th>Owner</th></tr></thead>
      <tbody>${inventory.map(d => `<tr${d.stalled ? ' style="background:#FEF2F2"' : ''}>
        <td>${dealLink(d.crmId, d.name || d.crmId)}</td>
        <td>${_esc(d.rawStage || '')}</td>
        <td>${_esc(STATUS_LABEL[d.status] || d.status)}</td>
        <td>${d.amount != null ? _usd(d.amount) : ''}</td>
        <td>${d.createdAt ? _dt(d.createdAt) : ''}</td>
        <td>${d.dwellDays != null ? d.dwellDays : ''}</td>
        <td>${d.stalled ? 'yes' : ''}</td>
        <td>${d.lastActivityAt ? _dt(d.lastActivityAt) : (d.activityLast30 == null ? '' : 'none logged')}</td>
        <td>${d.contactRoleCount != null ? d.contactRoleCount : ''}</td>
        <td>${_esc(d.ownerName || '')}</td></tr>`).join('')}</tbody></table>
    </section>` : `
    <section>
      <h2>Deal inventory</h2>
      <p class="fine">Not captured in this snapshot (pre-v1.1.0 capture). Re-run the baseline capture to include the deal-level inventory.</p>
    </section>`;

  const cyc = Object.entries((m.cycleTime || {}).byStage || {});
  const cycleTable = cyc.length ? `
    <table><thead><tr><th>Stage</th><th>Median days</th><th>p75 days</th><th>n</th></tr></thead>
    <tbody>${cyc.map(([s, v]) => `<tr><td>${_esc(s)}</td><td>${v.medianDays ?? 'n/a'}</td><td>${v.p75Days ?? 'n/a'}</td><td>${v.n}</td></tr>`).join('')}</tbody></table>` : '<p class="fine">No stage cycle data.</p>';

  const trs = ((m.conversion || {}).transitions || []);
  const convTable = trs.length ? `
    <table><thead><tr><th>Transition</th><th>Conversion</th><th>Entrants</th></tr></thead>
    <tbody>${trs.map(t => `<tr><td>${_esc(t.from)} → ${_esc(t.to)}</td><td>${_pc(t.rate)}</td><td>${t.n}</td></tr>`).join('')}</tbody></table>` : '<p class="fine">No conversion data.</p>';

  const warnings = Array.isArray(snap.warnings) ? snap.warnings : [];
  const warnBlock = warnings.length
    ? `<ul>${warnings.map(w => `<li><b>${_esc(w.kind)}</b>: ${_esc(typeof w.detail === 'string' ? w.detail : JSON.stringify(w.detail))}</li>`).join('')}</ul>`
    : '<p class="fine">None.</p>';

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${_esc(title)}</title>
<style>
  :root { color-scheme: light; }
  body { font: 14px/1.55 -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
         color: #111827; margin: 0; }
  .sheet { max-width: 820px; margin: 0 auto; padding: 40px 32px; }
  header { display: flex; justify-content: space-between; align-items: center;
           border-bottom: 3px solid #111827; padding-bottom: 16px; }
  .brand-name { font-weight: 700; font-size: 20px; }
  h1 { font-size: 26px; margin: 24px 0 4px; }
  h2 { font-size: 19px; margin: 28px 0 10px; border-bottom: 1px solid #E5E7EB; padding-bottom: 4px; }
  h3 { font-size: 15px; margin: 18px 0 6px; }
  .meta { color: #6B7280; font-size: 13px; }
  .scoreboard { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 22px 0; }
  .score { border: 1px solid #E5E7EB; border-radius: 8px; padding: 12px; text-align: center; }
  .score-v { font-size: 20px; font-weight: 700; }
  .score-k { font-size: 11.5px; color: #6B7280; margin-top: 2px; }
  .finding { border: 1px solid #E5E7EB; border-left-width: 4px; border-radius: 6px;
             padding: 12px 14px; margin: 10px 0; page-break-inside: avoid; }
  .finding-head { display: flex; gap: 10px; align-items: center; }
  .finding-title { font-weight: 600; }
  .sev { color: #fff; font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em;
         border-radius: 4px; padding: 2px 7px; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0 16px; font-size: 13px; }
  th, td { border: 1px solid #E5E7EB; padding: 6px 9px; text-align: left; }
  th { background: #F9FAFB; }
  .fine { color: #6B7280; font-size: 12px; }
  code { background: #F3F4F6; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  footer { margin-top: 36px; border-top: 1px solid #E5E7EB; padding-top: 12px; }
  @media print {
    .sheet { padding: 0; max-width: none; }
    .page-break { page-break-before: always; }
    a { color: inherit; text-decoration: none; }
  }
</style></head>
<body><div class="sheet">
  <header>${brandBlock}<div class="meta">Sales Execution Assessment</div></header>

  <h1>${_esc(subjectName)}</h1>
  <p class="meta">CRM: ${_esc(snap.crm_type)} · History window: ${_dt(snap.history_from)} → ${_dt(snap.history_to)}
     · Captured: ${_dt(snap.captured_at)} · Baseline #${snap.id} (frozen, metric defs v${_esc(snap.metric_defs_version)})</p>

  <div class="scoreboard">${scoreCells}</div>

  ${narrativeBlock}

  <section class="page-break">
    <h2>Findings</h2>
    ${findingsBlock || '<p class="fine">No findings crossed reporting thresholds.</p>'}
    ${stalledDetail}
  </section>

  <section class="page-break">
    <h2>Cycle time by stage</h2>
    ${cycleTable}
    <h2>Stage-to-stage conversion</h2>
    ${convTable}
  </section>

  ${inventoryBlock}

  <section class="page-break">
    <h2>Methodology</h2>
    <p class="fine">
      All metrics computed from ${_esc(snap.crm_type)}'s own historical records at capture time and
      frozen; the stored snapshot is immutable at the database level. Cycle times: dwell per stage
      over closed deals (mode: ${_esc((snap.metrics.cycleTime || {}).mode || 'sum_dwell')}), re-entries included;
      regression reported separately. Conversion: cohort-based over deals closed or older than
      ${(snap.metrics.conversion || {}).maxCycleDays || 'n/a'} days. Stall: open-deal dwell beyond that stage's own
      historical p75. Stalled-pipeline dollars: sum of open amounts on stalled deals. Segment cells
      under n=${(snap.metrics.winRates || {}).minCellN ?? 'n/a'} suppressed. Findings thresholds are fixed editorial
      constants stated in the engine (v: metric defs ${_esc(snap.metric_defs_version)}).
    </p>
    <h2>Data caveats</h2>
    ${warnBlock}
  </section>

  <footer class="fine">
    Prepared with ${branding.mode === 'gowarm' ? 'GoWarmCRM' : _esc(branding.name)} ·
    Generated ${_dt(new Date())} · Baseline snapshot #${snap.id}
  </footer>
</div></body></html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Share tokens
// ─────────────────────────────────────────────────────────────────────────────

async function enableShare({ reportId, orgId }) {
  const existing = await pool.query(
    `SELECT share_token FROM baseline_reports WHERE id = $1 AND org_id = $2`,
    [reportId, orgId]);
  if (!existing.rows.length) throw Object.assign(new Error('Report not found'), { statusCode: 404 });
  if (existing.rows[0].share_token) return { shareToken: existing.rows[0].share_token };

  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    `UPDATE baseline_reports SET share_token = $1 WHERE id = $2 AND org_id = $3`,
    [token, reportId, orgId]);
  return { shareToken: token };
}

async function revokeShare({ reportId, orgId }) {
  const res = await pool.query(
    `UPDATE baseline_reports SET share_token = NULL WHERE id = $1 AND org_id = $2`,
    [reportId, orgId]);
  if (!res.rowCount) throw Object.assign(new Error('Report not found'), { statusCode: 404 });
  return { revoked: true };
}

async function getSharedHtml(token) {
  if (!token || !/^[a-f0-9]{64}$/.test(String(token))) return null;
  const res = await pool.query(
    `SELECT html FROM baseline_reports WHERE share_token = $1`, [token]);
  return res.rows.length ? { html: res.rows[0].html } : null;
}

module.exports = { generateReport, enableShare, revokeShare, getSharedHtml, renderHtml };
