/**
 * services/EnrichmentSignalIngestService.js
 *
 * DROP-IN LOCATION: backend/services/EnrichmentSignalIngestService.js
 *
 * Motion-1 adapter, second half (Phase 9) — BYOK ENRICHMENT → normalized
 * signals. The BYOK machinery itself (per-org keys in CredentialsStore,
 * Apollo/CoreSignal providers, chains, monthly caps, credit log) predates
 * this phase and is reused untouched; what P9 adds is the missing bridge:
 * enrichment results were landing on account/prospect FIELDS only, invisible
 * to campaign targeting, verdicts and the Work queue. This service writes
 * them into the signal layer.
 *
 * THE ADAPTER CONTRACT (§5, same as P6/P7/P8):
 *   normalize → SignalService.writeSignal({ source:'enrichment', observedAt,
 *   confidence:'high' }) per key → THEN SignalActionSurfacer.reevalOnCapture.
 *   Blank/absent fields NEVER write (unknown-never-false starts at ingest,
 *   the P6 rule) — so an Apollo run after a CoreSignal run refreshes shared
 *   keys and leaves CoreSignal-only keys (competitors/news/hiring) intact.
 *   Reconciliation upstream guarantees rep-edited values are never clobbered
 *   (rep_override) and stale payloads lose to fresher ones — per key.
 *
 * THE v1 SIGNAL SET (decided in-session; all company-scoped,
 * source_kind='enrich' ⇒ reliability HIGH ⇒ may legitimately Filter):
 *
 *   key                  type     from                        providers
 *   industry             set      data.industry               both
 *   headcount            number   data.headcount|employees_count  both
 *   hq_country           set      data.hq_country | raw.*     apollo (+CS raw)
 *   hq_city              set      data.hq_city    | raw.*     apollo (+CS raw)
 *   tech_stack           set      data.technologies|tech_stack both
 *   founded_year         number   data.founded_year           both
 *   company_about        set      data.description (≤5000ch)  both
 *   competitors          set      raw.competitors (≤25)       coresignal only
 *   active_job_postings  number   raw.active_job_postings_count coresignal only
 *   recent_news          recency  raw news/updates (dated)    coresignal only,
 *                                                             tier-dependent
 *
 * The last three are written best-effort: when the payload carries them
 * they're written, otherwise the key stays unknown — never fabricated, never
 * false (degrade gracefully, D14). recent_news is only written when a DATED
 * item exists; its observed_at is the item's date so `within_days`
 * prioritizers run off real news recency, not enrichment time.
 * active_job_postings=0 IS written — a stated zero is a known fact
 * ("not hiring"), not an unknown.
 *
 * ONE CREDIT, TWO APPLICATIONS: enrichForWorkPanel delegates the provider
 * call to the EXISTING enrichmentService.enrichAccountForProspect (fields
 * applied under its fill-if-empty rules, raw stamped into research_meta,
 * credit logged, caps enforced) and ingests signals from the SAME response —
 * it never calls providers itself.
 *
 * Never reads or writes prospect.stage.
 */

const { pool } = require('../config/database');
const SignalService        = require('./SignalService');
const SignalRegistry       = require('./SignalRegistryService');
const SignalActionSurfacer = require('./SignalActionSurfacer');

// Injectable seam (tests stub this; production uses the real service).
// Lazy-required to avoid a load-order cycle risk with the pool.
const _deps = {
  enrichAccountForProspect: (args) =>
    require('./enrichmentService').enrichAccountForProspect(args),
};

// Value bounds — payload sanity, not truncation of meaning.
const ABOUT_MAX_CHARS   = 5000;
const NEWS_MAX_CHARS    = 300;
const COMPETITORS_MAX   = 25;
const TECH_STACK_MAX    = 50;

// ─────────────────────────────────────────────────────────────────────────────
// The seeded def set (lazily ensured per org, like P8's submitted_form).
// capability 'both' where a testable current state exists; company_about is
// context (shown on the Work panel, not predicate-able free text) and
// recent_news is a dated event → Prioritize.
// ─────────────────────────────────────────────────────────────────────────────
const ENRICH_SIGNAL_DEFS = [
  { key: 'industry',            label: 'Industry',                predicateType: 'set',     capability: 'both',       ttlDays: 365,  description: 'Company industry, as reported by the enrichment provider.' },
  { key: 'headcount',           label: 'Headcount',               predicateType: 'number',  capability: 'both',       ttlDays: 180,  description: 'Employee count from the enrichment provider.' },
  { key: 'hq_country',          label: 'HQ country',              predicateType: 'set',     capability: 'both',       ttlDays: null, description: 'Headquarters country.' },
  { key: 'hq_city',             label: 'HQ city',                 predicateType: 'set',     capability: 'both',       ttlDays: null, description: 'Headquarters city.' },
  { key: 'tech_stack',          label: 'Tech stack',              predicateType: 'set',     capability: 'both',       ttlDays: 365,  description: 'Technologies in use, per the enrichment provider.' },
  { key: 'founded_year',        label: 'Founded year',            predicateType: 'number',  capability: 'both',       ttlDays: null, description: 'Year the company was founded.' },
  { key: 'company_about',       label: 'About the company',       predicateType: 'set',     capability: 'prioritize', ttlDays: 365,  description: 'Company description from the enrichment provider. Context for the rep — not a targeting predicate.' },
  { key: 'competitors',         label: 'Competitors',             predicateType: 'set',     capability: 'both',       ttlDays: 365,  description: 'Named competitors from the company listing (CoreSignal).' },
  { key: 'active_job_postings', label: 'Active job postings',     predicateType: 'number',  capability: 'both',       ttlDays: 180,  description: 'Open roles count from the company listing (CoreSignal).', defaultHook: 'actively hiring right now' },
  { key: 'recent_news',         label: 'Recent company news',     predicateType: 'recency', capability: 'prioritize', ttlDays: 30,   description: 'Latest dated news / company update (CoreSignal; availability depends on plan tier).', defaultHook: 'just made the news' },
];

const ENRICH_SIGNAL_KEYS = ENRICH_SIGNAL_DEFS.map((d) => d.key);

/**
 * Ensure the org catalog carries all enrichment defs. Idempotent; existing
 * defs (including org-customized ones under the same key) are left alone.
 */
async function ensureEnrichDefs(orgId, client) {
  const out = [];
  for (const def of ENRICH_SIGNAL_DEFS) {
    const existing = await SignalRegistry.getDef({ orgId, key: def.key, client });
    if (existing) { out.push(existing); continue; }
    try {
      out.push(await SignalRegistry.createDef({
        orgId,
        key: def.key,
        label: def.label,
        description: def.description,
        capability: def.capability,
        scope: 'company',
        predicateType: def.predicateType,
        sourceKind: 'enrich',
        ttlDays: def.ttlDays,
        defaultHook: def.defaultHook || null,
        client,
      }));
    } catch (err) {
      if (/already exists/i.test(err.message)) {
        out.push(await SignalRegistry.getDef({ orgId, key: def.key, client }));
      } else {
        throw err;
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extraction: normalized data + raw payload → [{ key, value, observedAt? }]
// Blank/absent → no entry (never a false/empty write).
// ─────────────────────────────────────────────────────────────────────────────

function _str(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return max && s.length > max ? s.slice(0, max) + '…' : s;
}

function _num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function _strArray(v, max) {
  if (!Array.isArray(v)) return null;
  const arr = v
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (item && typeof item === 'object') {
        return _str(item.name || item.company_name || item.title || item.technology, 200);
      }
      return null;
    })
    .filter(Boolean);
  const uniq = [...new Set(arr)].slice(0, max || arr.length);
  return uniq.length ? uniq : null;
}

function _date(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Pull the most recent DATED news-ish item out of a CoreSignal raw payload.
 * Shapes vary by plan tier; we accept a few observed forms and stay
 * conservative: no dated item with a headline/snippet → null (unknown).
 */
function _latestNews(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const candidates = [];
  for (const field of ['news_articles', 'news', 'company_updates', 'updates']) {
    const arr = raw[field];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const date = _date(item.date || item.published_at || item.published_date || item.created || item.last_updated);
      const text = _str(item.title || item.headline || item.description || item.summary, NEWS_MAX_CHARS);
      if (date && text) candidates.push({ date, text });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.date - a.date);
  return candidates[0];
}

/**
 * Map one enrichment response (normalized `data` + provider `raw`) to signal
 * writes. Pure — no I/O. Exported for tests.
 *
 * @returns {Array<{key:string, value:*, observedAt?:Date}>}
 */
function extractSignals({ data, raw }) {
  const d = data || {};
  const r = raw || {};
  const out = [];
  const push = (key, value, observedAt) => {
    if (value === null || value === undefined) return;
    out.push({ key, value, ...(observedAt ? { observedAt } : {}) });
  };

  push('industry',     _str(d.industry, 200));
  push('headcount',    _num(d.headcount ?? d.employees_count));
  push('hq_country',   _str(d.hq_country || r.hq_country || r.headquarters_country || r.headquarters_new_country, 120));
  push('hq_city',      _str(d.hq_city || r.hq_city || r.headquarters_city || r.headquarters_new_city, 120));
  push('tech_stack',   _strArray(d.technologies || d.tech_stack, TECH_STACK_MAX));
  push('founded_year', _num(d.founded_year));
  push('company_about', _str(d.description, ABOUT_MAX_CHARS));

  // ── CoreSignal-only, best-effort (unknown when absent — never fabricated) ──
  push('competitors', _strArray(r.competitors, COMPETITORS_MAX));

  // A stated zero is a known fact ("not hiring"), so ?? not ||.
  const postings = _num(r.active_job_postings_count ?? r.total_job_postings_count);
  if (postings !== null) push('active_job_postings', postings);

  const news = _latestNews(r);
  if (news) push('recent_news', news.text, news.date);

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ingest: write-then-reeval (the adapter contract)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write extracted signals onto the ACCOUNT (all v1 keys are company-scoped),
 * then reeval every prospect the account touches. Per-key reconciliation:
 * rep values survive (rep_override), stale payloads lose (stale_incoming).
 *
 * @returns {Promise<{written:string[], skipped:Array<{key,reason}>}>}
 */
async function ingestEnrichment({ orgId, accountId, data, raw, observedAt, client, skipReeval = false }) {
  if (!orgId || !accountId) {
    throw new Error('EnrichmentSignalIngest.ingestEnrichment: orgId and accountId are required');
  }
  await ensureEnrichDefs(orgId, client);

  const items = extractSignals({ data, raw });
  const now = observedAt || new Date();
  const written = [];
  const skipped = [];

  for (const item of items) {
    const res = await SignalService.writeSignal({
      orgId,
      entityType: 'account',
      entityId: accountId,
      key: item.key,
      value: item.value,
      source: 'enrichment',
      observedAt: item.observedAt || now,
      confidence: 'high',
      client,
    });
    if (res.written) written.push(item.key);
    else skipped.push({ key: item.key, reason: res.reason });
  }

  // Keys the payload didn't carry are neither written nor "skipped" — they
  // simply stay as they were (unknown, or whatever an earlier source wrote).
  if (written.length && !skipReeval) {
    await SignalActionSurfacer.reevalOnCapture({
      orgId, entityType: 'account', entityId: accountId, client,
    });
  }

  return { written, skipped };
}

// ─────────────────────────────────────────────────────────────────────────────
// The Work-panel entry point (POST /prospect-work/:id/enrich)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One rep tap: provider call via the EXISTING enrichAccountForProspect
 * (fields applied, raw stamped, credit logged, chain + caps respected) →
 * signal ingest from the same response → account-level reeval.
 *
 * Soft-failure model: no key configured / cap reached / not found / no
 * account all return { ok:false, reason } — the panel shows a notice, never
 * an error state that blocks the rep (degrade gracefully, never fail
 * silently: the reason is always surfaced).
 *
 * @returns {Promise<{ok:boolean, provider?:string, reason?:string,
 *                    fieldsApplied?:object, signals?:{written,skipped}}>}
 */
async function enrichForWorkPanel({ orgId, prospectId }) {
  const result = await _deps.enrichAccountForProspect({ prospectId, orgId });

  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason || 'enrichment_failed',
      provider: result.provider || null,
      ...(result.cap != null ? { cap: result.cap, used: result.used } : {}),
    };
  }

  const signals = await ingestEnrichment({
    orgId,
    accountId: result.accountId,
    data: result.data,
    raw:  result.raw,
  });

  return {
    ok: true,
    provider: result.provider,
    accountId: result.accountId,
    fieldsApplied: result.enriched || {},
    signals,
  };
}

module.exports = {
  ENRICH_SIGNAL_DEFS,
  ENRICH_SIGNAL_KEYS,
  ensureEnrichDefs,
  extractSignals,
  ingestEnrichment,
  enrichForWorkPanel,
  // test seam
  _deps,
};
