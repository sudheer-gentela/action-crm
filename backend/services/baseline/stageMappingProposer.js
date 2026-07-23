/**
 * baseline/stageMappingProposer.js
 *
 * DROP-IN LOCATION: backend/services/baseline/stageMappingProposer.js
 *
 * Proposes a stage_map ({ raw CRM stage label → GoWarm deal_stages.key })
 * from the frozen schema snapshot's stage_defs + the org's own deal_stages.
 *
 * Deliberately DETERMINISTIC (no LLM in v1): every proposal carries a
 * rationale string a human can check in the approval UI, and the human
 * approves before anything is computed. Signals, in precedence order:
 *
 *   1. exact  — normalized name equality ("Closed Won" ≡ closed_won)
 *   2. terminal-flag — CRM isWon → the org's won-type stage; isClosed&&!isWon
 *      → lost-type stage. Uses the CRM's OWN OpportunityStage / pipeline
 *      metadata, never name guessing, so "Signed 🎉" still maps to closed_won.
 *   3. token — token-overlap similarity ≥ 0.5 between names
 *   4. ordinal — remaining active CRM stages assigned to remaining active
 *      GoWarm stages by relative position (CRM sortOrder vs stage sort_order),
 *      confidence 'low'
 *
 * Output:
 *   { proposals: [{ crmStage, proposedKey|null, confidence, rationale }],
 *     unmatchedCrmStages, unusedGowarmStages }
 *
 * HubSpot stage_defs carry internal stage ids alongside labels; when an `id`
 * is present the proposal keys on the id (that's what dealstage history
 * events contain) and shows the label in the rationale.
 */

function _norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function _tokens(s) { return new Set(_norm(s).split(' ').filter(Boolean)); }

function _tokenSim(a, b) {
  const ta = _tokens(a), tb = _tokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.max(ta.size, tb.size);
}

/**
 * @param {Array} stageDefs      schema snapshot stage_defs
 *                               [{ label, id?, isActive?, isClosed, isWon, sortOrder,
 *                                  pipelineId?, pipelineLabel? }]
 * @param {Array} gowarmStages   deal_stages rows for the org
 *                               [{ key, name, stage_type, sort_order, is_terminal }]
 */
function _slug(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'stage';
}

/**
 * Identity proposal for orgs with NO deal_stages (assessment orgs are
 * unseeded by design). Canonical keys are slugs of the CRM's own stage
 * labels; won/lost semantics come from the CRM's own metadata. The baseline
 * then measures the org in its OWN stage language — which is exactly right
 * for an assessment: no GoWarm playbook exists to map onto.
 */
function proposeIdentityMap(stageDefs) {
  const defs = (stageDefs || []).filter(s => s.isActive !== false);
  const used = new Set();
  const proposals = defs.map(def => {
    let key = _slug(def.label);
    while (used.has(key)) key = `${key}_2`;
    used.add(key);
    const mapKey = def.id || def.label;
    const display = def.pipelineLabel ? `${def.label} [${def.pipelineLabel}]` : def.label;
    return {
      crmStage: mapKey, crmLabel: display, proposedKey: key,
      confidence: 'high',
      rationale: def.isWon ? `Identity mapping (CRM marks IsWon)`
        : def.isClosed ? `Identity mapping (CRM marks Closed/Lost)`
        : `Identity mapping — org has no playbook stages, so the assessment uses the CRM's own stage names`,
    };
  });
  return {
    mode: 'identity',
    proposals,
    unmatchedCrmStages: [],
    unusedGowarmStages: [],
  };
}

function proposeStageMap(stageDefs, gowarmStages) {
  const defs = (stageDefs || []).filter(s => s.isActive !== false);
  const gw   = (gowarmStages || []);

  // Unseeded org (assessment): identity mapping is the only honest proposal.
  if (gw.length === 0) return proposeIdentityMap(stageDefs);

  const gwWon    = gw.find(s => s.stage_type === 'won');
  const gwLost   = gw.find(s => s.stage_type === 'lost');
  const gwActive = gw.filter(s => s.stage_type !== 'won' && s.stage_type !== 'lost')
                     .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  const proposals = [];
  const usedGw = new Set();
  const pending = [];

  for (const def of defs) {
    const mapKey = def.id || def.label;   // HubSpot maps by internal id
    const display = def.pipelineLabel ? `${def.label} [${def.pipelineLabel}]` : def.label;

    // 1. exact normalized name match
    const exact = gw.find(s => _norm(s.name) === _norm(def.label) || _norm(s.key) === _norm(def.label));
    if (exact) {
      proposals.push({
        crmStage: mapKey, crmLabel: display, proposedKey: exact.key,
        confidence: 'high', rationale: `Name match: "${def.label}" ≡ ${exact.key}`,
      });
      usedGw.add(exact.key);
      continue;
    }

    // 2. terminal flags from the CRM's own metadata
    if (def.isWon && gwWon) {
      proposals.push({
        crmStage: mapKey, crmLabel: display, proposedKey: gwWon.key,
        confidence: 'high', rationale: `CRM marks this stage IsWon — mapped to ${gwWon.key}`,
      });
      usedGw.add(gwWon.key);
      continue;
    }
    if (def.isClosed && !def.isWon && gwLost) {
      proposals.push({
        crmStage: mapKey, crmLabel: display, proposedKey: gwLost.key,
        confidence: 'high', rationale: `CRM marks this stage Closed & not Won — mapped to ${gwLost.key}`,
      });
      usedGw.add(gwLost.key);
      continue;
    }

    // 3. token similarity against active stages
    let best = null, bestSim = 0;
    for (const s of gwActive) {
      const sim = Math.max(_tokenSim(def.label, s.name), _tokenSim(def.label, s.key));
      if (sim > bestSim) { bestSim = sim; best = s; }
    }
    if (best && bestSim >= 0.5) {
      proposals.push({
        crmStage: mapKey, crmLabel: display, proposedKey: best.key,
        confidence: bestSim >= 0.75 ? 'high' : 'medium',
        rationale: `Token similarity ${(bestSim * 100).toFixed(0)}%: "${def.label}" ≈ "${best.name}"`,
      });
      usedGw.add(best.key);
      continue;
    }

    pending.push({ def, mapKey, display });
  }

  // 4. ordinal assignment for the remainder (active stages by position)
  const remainingGw = gwActive.filter(s => !usedGw.has(s.key));
  const pendingSorted = pending
    .sort((a, b) => (a.def.sortOrder ?? 0) - (b.def.sortOrder ?? 0));
  pendingSorted.forEach((p, i) => {
    if (remainingGw.length === 0) {
      proposals.push({
        crmStage: p.mapKey, crmLabel: p.display, proposedKey: null,
        confidence: 'none', rationale: 'No unassigned GoWarm stage left — map manually or leave unmapped (events will surface as unmapped-stage warnings)',
      });
      return;
    }
    const idx = Math.min(
      Math.floor((i / Math.max(pendingSorted.length, 1)) * remainingGw.length),
      remainingGw.length - 1
    );
    const target = remainingGw[idx];
    proposals.push({
      crmStage: p.mapKey, crmLabel: p.display, proposedKey: target.key,
      confidence: 'low',
      rationale: `Positional guess: CRM stage #${p.def.sortOrder ?? '?'} → "${target.name}" — review before approving`,
    });
    usedGw.add(target.key);
  });

  return {
    proposals,
    unmatchedCrmStages: proposals.filter(p => !p.proposedKey).map(p => p.crmLabel),
    unusedGowarmStages: gw.filter(s => !usedGw.has(s.key)).map(s => s.key),
  };
}

module.exports = { proposeStageMap, proposeIdentityMap };
