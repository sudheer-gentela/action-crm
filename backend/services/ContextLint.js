// ============================================================================
// services/ContextLint.js
//
// Pure linter over an assembled prospect context payload (+ optional
// provenance). Surfaces the failure modes that bit us this session — polluted
// rep identity, user-layer items merged over a campaign override, empty/oversized
// value-prop sets, no eligible hook material, and fit problems — as a flat list
// of {level, msg} the preview panel renders.
//
// Pure / dependency-free: no DB, no network.
//
// Public API:
//   lint(payload, provenance) -> [{ level: 'warn'|'info', msg }]
//
//   payload    : the object returned by buildProspectSkillContext (the model
//                payload). fit is read from payload.org_context.fit when the
//                runner has stamped it.
//   provenance : optional { value_props, products, target_personas,
//                case_studies, rep } as produced by buildProspectSkillContext
//                in explain mode. Each list item is { value, source } where
//                source is 'org' | 'campaign:<id>' | 'user:<id>'.
// ============================================================================

'use strict';

function firstNameOf(name) {
  if (!name || typeof name !== 'string') return '';
  return name.trim().split(/\s+/)[0].toLowerCase();
}

// Does the signature text plausibly contain the rep's name? Used to flag the
// "rep.name and email_signature are different identities" pollution case
// (e.g. name 'Srujana' but a signature block for someone/something else).
function signatureNamesRep(repName, signature) {
  if (!repName || !signature) return true;            // can't judge -> don't warn
  const sig = String(signature).toLowerCase();
  const full = String(repName).trim().toLowerCase();
  const first = firstNameOf(repName);
  if (full && sig.includes(full)) return true;
  if (first && first.length >= 3 && sig.includes(first)) return true;
  return false;
}

function hasSource(list, prefix) {
  return Array.isArray(list) && list.some(
    it => it && typeof it.source === 'string' && it.source.startsWith(prefix)
  );
}

function lint(payload, provenance) {
  const out = [];
  const p   = payload || {};
  const oc  = p.org_context || {};
  const prov = provenance || {};

  // ── Rule: rep name vs signature identity ──────────────────────────────────
  const rep = oc.rep || {};
  if (rep.name && rep.email_signature && !signatureNamesRep(rep.name, rep.email_signature)) {
    out.push({
      level: 'warn',
      msg: `rep.name ("${rep.name}") does not appear in email_signature — possible cross-identity pollution.`,
    });
  }

  // ── Rule: user-layer items merged over a campaign override ────────────────
  const layeredFields = [
    ['value_props',     prov.value_props],
    ['products',        prov.products],
    ['target_personas', prov.target_personas],
    ['case_studies',    prov.case_studies],
  ];
  for (const [field, list] of layeredFields) {
    if (hasSource(list, 'user:') && hasSource(list, 'campaign:')) {
      out.push({
        level: 'warn',
        msg: `${field}: user-layer items merged over a campaign override.`,
      });
    }
  }

  // ── Rule: value_props empty or oversized ──────────────────────────────────
  const vp = Array.isArray(oc.value_props) ? oc.value_props : [];
  if (vp.length === 0) {
    out.push({ level: 'warn', msg: 'value_props is empty — the draft has no pitch to anchor on.' });
  } else if (vp.length > 6) {
    out.push({ level: 'warn', msg: `value_props has ${vp.length} items (>6) — too many to land cleanly.` });
  }

  // ── Rule: no eligible LinkedIn posts after recency filter ─────────────────
  const posts = p.signals && p.signals.linkedin_activity && Array.isArray(p.signals.linkedin_activity.posts)
    ? p.signals.linkedin_activity.posts : [];
  if (posts.length === 0) {
    out.push({ level: 'info', msg: 'no recent authored posts after recency filter; hook will fall back.' });
  }

  // ── Rule: fit verdict ─────────────────────────────────────────────────────
  const fit = oc.fit || null;
  if (fit && (fit.verdict === 'disqualified' || fit.verdict === 'weak')) {
    const reasons = Array.isArray(fit.reasons) && fit.reasons.length
      ? ' — ' + fit.reasons.join('; ')
      : '';
    out.push({ level: 'warn', msg: `fit.verdict=${fit.verdict}${reasons}` });
  }

  // ── Rule: fit unknown[] fields ────────────────────────────────────────────
  if (fit && Array.isArray(fit.unknown)) {
    for (const field of fit.unknown) {
      out.push({ level: 'info', msg: `enrich ${field} to evaluate fit.` });
    }
  }

  return out;
}

module.exports = { lint };
