/**
 * StrapNightlySweep.js
 *
 * Nightly validity sweep for active STRAPs across all orgs.
 *
 * DROP-IN LOCATION: backend/services/StrapNightlySweep.js
 *
 * ── What this sweep does ─────────────────────────────────────────────────────
 *
 * Part A — Validate active STRAPs (run for every entity with an active STRAP)
 *   1. Re-identify the top hurdle with fresh context.
 *   2. If the STRAP's hurdle_type no longer matches the top hurdle (or no
 *      hurdle remains), auto-resolve the STRAP and regenerate if a new hurdle
 *      is detected. This mirrors StrapResolutionDetector._checkAndResolve()
 *      but runs on schedule rather than on event.
 *   3. If the hurdle is unchanged, leave the STRAP alone — do NOT supersede
 *      or touch it. The rep's work-in-progress is preserved.
 *
 * Part B — Generate for eligible entities with NO active STRAP
 *   For each entity type (deal, account, prospect, implementation), query
 *   entities that are:
 *     - Active / non-terminal
 *     - Have NO active STRAP
 *   Run hurdle identification. If a hurdle is found, auto-generate a STRAP.
 *
 * ── Critical architectural note ──────────────────────────────────────────────
 *
 * This sweep MUST NOT use upsert/resolve pattern (Phase 1 pattern for
 * Type A diagnostic alerts). STRAPs use supersede/regenerate because:
 *   - One-active-STRAP-per-entity is enforced by a DB partial unique index
 *     UNIQUE (entity_type, entity_id) WHERE status = 'active'
 *   - STRAP actions (Type C) are plan steps, not re-evaluated diagnostics
 *   - Superseding writes audit trail via resolution_type = 'auto_detected'
 *
 * ── Relationship to StrapResolutionDetector ──────────────────────────────────
 *
 * StrapResolutionDetector handles event-based resolution (email, health
 * change, stage change, action completed). This sweep is the safety net:
 * it catches entities that have had no events but whose hurdle has silently
 * cleared, and generates STRAPs for entities that should have one but don't.
 *
 * ── Public API ───────────────────────────────────────────────────────────────
 *
 *   runForOrg(orgId)
 *     → { validated, resolved, regenerated, generated, errors }
 *
 * ── Cron ─────────────────────────────────────────────────────────────────────
 *   03:00 UTC daily (registered in syncScheduler.js)
 *   Workflow audit shifted to 03:15 UTC, purge shifted to 03:45 UTC.
 */

const db                    = require('../config/database');
const { getDiagnosticRulesConfig } = require('../routes/orgAdmin.routes');
const StrapContextResolver  = require('./StrapContextResolver');
const StrapHurdleIdentifier = require('./StrapHurdleIdentifier');
const StrapStrategyBuilder  = require('./StrapStrategyBuilder');
const StrapActionGenerator  = require('./StrapActionGenerator');

// ── Terminal / excluded stages — entities where STRAP generation is pointless ─

const DEAL_TERMINAL_STAGES = new Set(['closed_won', 'closed_lost']);
// implementation STRAPs attach to closed_won deals — keep them in scope
// so they are specifically queried below rather than filtered here.

const PROSPECT_TERMINAL_STAGES = new Set(['converted', 'disqualified', 'archived']);

// ── How long a STRAP must be active before the sweep re-validates it ──────────
// Prevents the sweep from immediately challenging a brand-new STRAP that was
// just confirmed by a rep minutes before the 03:00 cron fires.
// MIN_STRAP_AGE_HOURS default — now loaded from org diagnostic_rules config
const DEFAULT_MIN_STRAP_AGE_HOURS = 12;

// ─────────────────────────────────────────────────────────────────────────────

class StrapNightlySweep {

  /**
   * Run the full STRAP nightly sweep for a single org.
   *
   * @param {number} orgId
   * @returns {Promise<{
   *   validated:    number,   — active STRAPs checked
   *   resolved:     number,   — STRAPs auto-resolved (hurdle cleared or shifted)
   *   regenerated:  number,   — new STRAPs created after a resolved one (hurdle shifted)
   *   generated:    number,   — new STRAPs created for entities with no active STRAP
   *   errors:       number,
   * }>}
   */
  static async runForOrg(orgId) {
    const startTime = Date.now();
    console.log(`[StrapNightlySweep] Starting for org ${orgId}`);

    const systemUserId = await this._resolveSystemUser(orgId);

    // Load org diagnostic rules config — used for min_age_hours
    let minStrapAgeHours = DEFAULT_MIN_STRAP_AGE_HOURS;
    try {
      const rulesConfig = await getDiagnosticRulesConfig(orgId);
      minStrapAgeHours  = rulesConfig.strap?.min_age_hours ?? DEFAULT_MIN_STRAP_AGE_HOURS;
    } catch (_) { /* use default */ }

    let validated   = 0;
    let resolved    = 0;
    let regenerated = 0;
    let generated   = 0;
    let errors      = 0;

    // ── Part A: Validate existing active STRAPs ───────────────────────────────

    const activeStraps = await this._loadActiveStraps(orgId, minStrapAgeHours);
    console.log(`[StrapNightlySweep] org=${orgId} active_straps=${activeStraps.length}`);

    for (const strap of activeStraps) {
      try {
        const result = await this._validateStrap(strap, orgId, systemUserId);
        validated++;
        if (result.resolved) {
          resolved++;
          if (result.regenerated) regenerated++;
        }
      } catch (err) {
        errors++;
        console.error(
          `[StrapNightlySweep] org=${orgId} validate strap=${strap.id} ` +
          `(${strap.entity_type}/${strap.entity_id}) error:`,
          err.message
        );
      }
    }

    // ── Part B: Generate STRAPs for eligible entities with none ───────────────

    const entitiesWithoutStrap = await this._loadEntitiesWithoutStrap(orgId);
    console.log(`[StrapNightlySweep] org=${orgId} entities_without_strap=${entitiesWithoutStrap.length}`);

    for (const entity of entitiesWithoutStrap) {
      try {
        const didGenerate = await this._generateForEntity(entity, orgId, systemUserId);
        if (didGenerate) generated++;
      } catch (err) {
        errors++;
        console.error(
          `[StrapNightlySweep] org=${orgId} generate ${entity.entityType}/${entity.entityId} error:`,
          err.message
        );
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `[StrapNightlySweep] org=${orgId} done in ${duration}s — ` +
      `validated=${validated} resolved=${resolved} regenerated=${regenerated} ` +
      `generated=${generated} errors=${errors}`
    );

    return { validated, resolved, regenerated, generated, errors };
  }

  // ── Part A helpers ────────────────────────────────────────────────────────

  /**
   * Load all active STRAPs for an org that are old enough to re-validate.
   * STRAPs created in the last MIN_STRAP_AGE_HOURS hours are skipped so the
   * sweep doesn't immediately challenge a freshly confirmed STRAP.
   */
  static async _loadActiveStraps(orgId, minAgeHours = DEFAULT_MIN_STRAP_AGE_HOURS) {
    const result = await db.query(
      `SELECT id, entity_type, entity_id, hurdle_type, created_by, created_at
       FROM straps
       WHERE org_id = $1
         AND status = 'active'
         AND created_at < NOW() - ($2 || ' hours')::interval
       ORDER BY entity_type, entity_id`,
      [orgId, minAgeHours]
    );
    return result.rows;
  }

  /**
   * Re-identify the hurdle for a single active STRAP and resolve/regenerate
   * if the hurdle has cleared or shifted.
   *
   * Mirrors the logic in StrapResolutionDetector._checkAndResolve() but is
   * called on schedule rather than on an event trigger.
   *
   * @returns {{ resolved: boolean, regenerated: boolean }}
   */
  static async _validateStrap(strap, orgId, systemUserId) {
    // Build fresh context — if context fails (entity deleted, etc.), skip safely
    let context;
    try {
      context = await StrapContextResolver.resolve(
        strap.entity_type, strap.entity_id, strap.created_by, orgId
      );
    } catch (err) {
      console.warn(
        `[StrapNightlySweep] Context build failed for ${strap.entity_type}/${strap.entity_id} ` +
        `(strap=${strap.id}), skipping: ${err.message}`
      );
      return { resolved: false, regenerated: false };
    }

    // Re-identify the top hurdle with current data
    const currentHurdle = StrapHurdleIdentifier.identify(strap.entity_type, context);

    // Determine if the active STRAP is still valid
    const hurdleCleared = !currentHurdle;
    const hurdleShifted = currentHurdle && currentHurdle.hurdleType !== strap.hurdle_type;
    const shouldResolve = hurdleCleared || hurdleShifted;

    if (!shouldResolve) {
      // Hurdle still matches — STRAP is valid. Leave it untouched.
      return { resolved: false, regenerated: false };
    }

    // Auto-resolve the stale STRAP
    const note = hurdleCleared
      ? `[Nightly sweep] Auto-resolved: hurdle "${strap.hurdle_type}" no longer detected`
      : `[Nightly sweep] Auto-resolved: hurdle shifted from "${strap.hurdle_type}" to "${currentHurdle.hurdleType}"`;

    await db.query(
      `UPDATE straps SET
         status          = 'resolved',
         resolved_by     = $1,
         resolved_at     = NOW(),
         resolution_type = 'auto_detected',
         resolution_note = $2
       WHERE id = $3`,
      [systemUserId, note, strap.id]
    );

    console.log(
      `[StrapNightlySweep] STRAP #${strap.id} auto-resolved ` +
      `(${strap.entity_type}/${strap.entity_id}): ${hurdleCleared ? 'hurdle cleared' : `shifted to ${currentHurdle.hurdleType}`}`
    );

    // If a new hurdle was detected, auto-generate a replacement STRAP immediately
    if (currentHurdle) {
      await this._autoGenerateStrap(
        strap.entity_type, strap.entity_id, strap.created_by, orgId, currentHurdle, context
      );
      return { resolved: true, regenerated: true };
    }

    return { resolved: true, regenerated: false };
  }

  // ── Part B helpers ────────────────────────────────────────────────────────

  /**
   * Load all eligible entities that have NO active STRAP.
   *
   * Returns a unified list of { entityType, entityId, ownerId } objects
   * covering all four supported entity types.
   *
   * Entity type selection criteria:
   *   deal           — active deals (not terminal stage)
   *   account        — accounts with at least one active deal
   *   prospect       — non-terminal prospects
   *   implementation — closed_won deals (implementation STRAP uses deal_id)
   *
   * We LEFT JOIN straps and filter WHERE straps.id IS NULL to find those
   * without an active STRAP in a single query per entity type.
   */
  static async _loadEntitiesWithoutStrap(orgId) {
    const entities = [];

    // ── Deals ──────────────────────────────────────────────────────────────
    const dealsRes = await db.query(
      `SELECT d.id AS entity_id, d.owner_id AS owner_id
       FROM deals d
       LEFT JOIN straps s
         ON s.entity_type = 'deal'
         AND s.entity_id  = d.id
         AND s.status     = 'active'
       LEFT JOIN pipeline_stages ps
         ON ps.id = d.pipeline_stage_id
       WHERE d.org_id  = $1
         AND s.id IS NULL
         AND (ps.is_terminal IS NULL OR ps.is_terminal = false)
         AND d.stage NOT IN ('closed_won', 'closed_lost')
       ORDER BY d.id`,
      [orgId]
    );
    for (const row of dealsRes.rows) {
      entities.push({ entityType: 'deal', entityId: row.entity_id, ownerId: row.owner_id });
    }

    // ── Accounts ───────────────────────────────────────────────────────────
    // Only sweep accounts that have at least one active (non-terminal) deal —
    // avoids generating STRAPs for dormant accounts with no pipeline activity.
    const accountsRes = await db.query(
      `SELECT DISTINCT a.id AS entity_id, a.owner_id AS owner_id
       FROM accounts a
       INNER JOIN deals d
         ON d.account_id = a.id
         AND d.org_id    = $1
         AND d.stage NOT IN ('closed_won', 'closed_lost')
       LEFT JOIN straps s
         ON s.entity_type = 'account'
         AND s.entity_id  = a.id
         AND s.status     = 'active'
       WHERE a.org_id = $1
         AND s.id IS NULL
       ORDER BY a.id`,
      [orgId]
    );
    for (const row of accountsRes.rows) {
      entities.push({ entityType: 'account', entityId: row.entity_id, ownerId: row.owner_id });
    }

    // ── Prospects ──────────────────────────────────────────────────────────
    const prospectsRes = await db.query(
      `SELECT p.id AS entity_id, p.owner_id AS owner_id
       FROM prospects p
       LEFT JOIN straps s
         ON s.entity_type = 'prospect'
         AND s.entity_id  = p.id
         AND s.status     = 'active'
       WHERE p.org_id      = $1
         AND p.deleted_at IS NULL
         AND p.stage NOT IN ('converted', 'disqualified', 'archived')
         AND s.id IS NULL
       ORDER BY p.id`,
      [orgId]
    );
    for (const row of prospectsRes.rows) {
      entities.push({ entityType: 'prospect', entityId: row.entity_id, ownerId: row.owner_id });
    }

    // ── Implementations (closed_won deals) ────────────────────────────────
    // Implementation STRAPs attach to the deal_id of the closed_won deal.
    // We look for closed_won deals with no active implementation STRAP.
    const implRes = await db.query(
      `SELECT d.id AS entity_id, d.owner_id AS owner_id
       FROM deals d
       LEFT JOIN straps s
         ON s.entity_type = 'implementation'
         AND s.entity_id  = d.id
         AND s.status     = 'active'
       WHERE d.org_id = $1
         AND d.stage  = 'closed_won'
         AND s.id IS NULL
       ORDER BY d.id`,
      [orgId]
    );
    for (const row of implRes.rows) {
      entities.push({ entityType: 'implementation', entityId: row.entity_id, ownerId: row.owner_id });
    }

    return entities;
  }

  /**
   * Attempt to generate a STRAP for a single entity with no active STRAP.
   * Builds context, identifies the top hurdle, and if found, auto-generates.
   *
   * Uses the entity owner's config for AI provider preference.
   * Falls back silently to playbook (template) mode if AI is unavailable.
   *
   * @returns {boolean} true if a STRAP was successfully created
   */
  static async _generateForEntity(entity, orgId, systemUserId) {
    const { entityType, entityId, ownerId } = entity;

    // Use entity owner as the acting user for context + access checks.
    // Fall back to systemUserId if owner is null (edge case).
    const actingUserId = ownerId || systemUserId;
    if (!actingUserId) return false;

    // Build context
    let context;
    try {
      context = await StrapContextResolver.resolve(entityType, entityId, actingUserId, orgId);
    } catch (err) {
      // Entity may have been deleted between query and now — skip silently
      return false;
    }

    // Identify top hurdle
    const hurdle = StrapHurdleIdentifier.identify(entityType, context);
    if (!hurdle) return false; // No hurdle — entity is healthy, no STRAP needed

    // Auto-generate the STRAP
    await this._autoGenerateStrap(entityType, entityId, actingUserId, orgId, hurdle, context);
    return true;
  }

  // ── Core STRAP generation ─────────────────────────────────────────────────

  /**
   * Build a strategy, insert a STRAP row, and generate its actions.
   * Reads the acting user's action_config for AI provider preference.
   * Silently falls back to playbook mode if AI is unavailable.
   *
   * This is the auto-generation path (no user selection, no preview).
   * Uses source = 'auto'. The created_by is the entity owner / system user.
   *
   * @param {string} entityType
   * @param {number} entityId
   * @param {number} actingUserId  — entity owner or system user
   * @param {number} orgId
   * @param {object} hurdle        — { hurdleType, title, priority, evidence }
   * @param {object} context       — entity-specific context
   */
  static async _autoGenerateStrap(entityType, entityId, actingUserId, orgId, hurdle, context) {
    // Resolve AI mode + provider from user's config (non-blocking, falls back)
    const { mode, provider } = await this._loadStrapConfig(actingUserId, orgId);

    // Build strategy — falls back to template internally if AI fails
    const strategy = await StrapStrategyBuilder.build(entityType, hurdle, context, mode, provider);

    // Supersede any active STRAP that might have appeared since we last checked
    // (race condition guard — the DB partial unique index enforces the invariant
    //  but the supersede prevents a constraint violation mid-sweep)
    await db.query(
      `UPDATE straps SET
         status          = 'superseded',
         resolved_at     = NOW(),
         resolution_type = 'superseded'
       WHERE entity_type = $1
         AND entity_id   = $2
         AND org_id      = $3
         AND status      = 'active'`,
      [entityType, entityId, orgId]
    );

    const aiModel      = strategy.aiModel      || null;
    const aiTokensUsed = strategy.aiTokensUsed || null;

    const result = await db.query(
      `INSERT INTO straps (
         org_id, entity_type, entity_id,
         hurdle_type, hurdle_title,
         situation, target, response, action_plan,
         priority, source,
         auto_hurdle_type, auto_hurdle_title,
         ai_model, ai_tokens_used,
         created_by, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'auto',$4,$5,$11,$12,$13,'active')
       RETURNING *`,
      [
        orgId, entityType, entityId,
        hurdle.hurdleType, hurdle.title,
        strategy.situation, strategy.target, strategy.response, strategy.actionPlan,
        hurdle.priority,
        aiModel,
        aiTokensUsed,
        actingUserId,
      ]
    );

    const strap = result.rows[0];
    if (!strap) return; // Defensive — shouldn't happen

    console.log(
      `[StrapNightlySweep] STRAP created: #${strap.id} ${entityType}/${entityId} → ` +
      `${hurdle.hurdleType} (${hurdle.priority}) via ${strategy.aiModel ? 'ai' : 'playbook'}`
    );

    // Generate actions from the action_plan (non-blocking failure)
    try {
      const actionResult = await StrapActionGenerator.generate(strap, context, actingUserId, orgId);
      if (actionResult.count > 0) {
        console.log(`[StrapNightlySweep]   → Generated ${actionResult.count} action(s) for STRAP #${strap.id}`);
      }
    } catch (err) {
      console.error(
        `[StrapNightlySweep] Action generation failed for STRAP #${strap.id} (non-blocking):`,
        err.message
      );
    }
  }

  // ── Config + user helpers ─────────────────────────────────────────────────

  /**
   * Load AI mode + provider from the acting user's action_config.
   * Mirrors the loadStrapConfig() private function in StrapEngine.js.
   * Defaults to playbook mode if config is unavailable (safe for nightly sweep —
   * avoids unexpected AI spend on entities the user hasn't opted into AI for).
   *
   * @returns {{ mode: 'ai'|'playbook', provider: string }}
   */
  static async _loadStrapConfig(userId, orgId) {
    try {
      const res = await db.query(
        `SELECT ai_settings FROM action_config WHERE user_id = $1 AND org_id = $2`,
        [userId, orgId]
      );
      const raw           = res.rows[0]?.ai_settings || {};
      const masterEnabled = raw.master_enabled ?? true;
      const rawMode       = raw.strap_generation_mode || 'both';
      const provider      = raw.strap_ai_provider     || 'anthropic';

      if (!masterEnabled) return { mode: 'playbook', provider };

      // For auto-generation, resolve 'both' as 'ai' (same as StrapEngine.generate)
      const mode = rawMode === 'playbook' ? 'playbook' : 'ai';
      return { mode, provider };
    } catch {
      // Config unavailable — default to playbook to avoid silent AI spend
      return { mode: 'playbook', provider: 'anthropic' };
    }
  }

  /**
   * Resolve the org's owner or first admin user id.
   * Used as fallback user_id when the entity owner is unknown.
   */
  static async _resolveSystemUser(orgId) {
    try {
      const r = await db.query(
        `SELECT user_id FROM org_users
         WHERE org_id = $1 AND role IN ('owner', 'admin')
         ORDER BY
           CASE role WHEN 'owner' THEN 0 ELSE 1 END,
           created_at ASC
         LIMIT 1`,
        [orgId]
      );
      return r.rows[0]?.user_id || null;
    } catch {
      return null;
    }
  }
}

module.exports = StrapNightlySweep;
