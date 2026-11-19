// mcp-server.mjs
// GoWarmCRM MCP server — mounts into your existing Express backend on Railway.
// Reachable by agents at https://gowarmcrm.com/mcp via a Vercel rewrite to api.gowarmcrm.com.
//
// Install deps:
//   npm install @modelcontextprotocol/sdk jose zod
//
// Env vars (Railway):
//   AUTHKIT_DOMAIN         https://welcoming-phrase-84-staging.authkit.app   (NO trailing slash; swap to prod later)
//   MCP_RESOURCE_URL       https://gowarmcrm.com/mcp                          (must match your WorkOS Resource Indicator)
//   MCP_SCOPES_SUPPORTED   comma-separated, e.g. "gowarm.read"                (OPTIONAL — see the note below)
//   MCP_WRITE_SCOPE        e.g. "campaigns:write"                             (OPTIONAL — gates write tools, see below)
//
// MCP_WRITE_SCOPE: when SET, every write tool requires that scope in the
// token's `scope` claim and refuses otherwise. When UNSET, write tools are
// allowed for any authenticated user who passes the same permission checks
// the UI applies (module access, org membership). Set it only AFTER the scope
// exists on the GoWarmCRM resource in WorkOS — otherwise no token carries it
// and every write is refused. Add the same name to MCP_SCOPES_SUPPORTED so
// clients know to request it.
//
// MCP_SCOPES_SUPPORTED is advertised in the Protected Resource Metadata as
// `scopes_supported` (RFC 9728 §2). Leave it UNSET until the same scope names
// exist on the GoWarmCRM resource in the WorkOS dashboard: agents read this
// list and request those scopes, and AuthKit rejects a scope it does not know
// with invalid_scope. Unset = field omitted = today's behaviour, unchanged.
//
// Wire it up in your app entrypoint, after `const app = express()`:
//   import('./mcp-server.mjs').then(({ registerMcp }) => registerMcp(app));
//
// NOTE: this is ESM. We bridge to your CommonJS db + services via createRequire.

import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { jwtVerify, createRemoteJWKSet } from 'jose';
import { z } from 'zod';
import { createRequire } from 'module';

// --- Bridge to the existing CommonJS backend (db helper + hierarchy service) ---
const require = createRequire(import.meta.url);
const db = require('./config/database'); // exposes db.query(text, params)
// Shared with POST /api/prospecting-campaigns so agent-created campaigns pass
// exactly the same validation as UI-created ones.
const CampaignCreateService = require('./services/CampaignCreateService');
// Shared with POST /api/sequences — same channel validation and transaction.
const SequenceCreateService = require('./services/SequenceCreateService');
// Same owner-or-admin rule the UI's campaign PUT enforces (requireCanMutate).
const CampaignAccess = require('./services/CampaignAccess');
// Module gating. The REST routes sit behind requireModule('prospecting'); the
// MCP path bypasses that middleware, so write tools re-check it explicitly.
const requireModule = require('./middleware/requireModule.middleware');
const moduleAccess  = require('./services/moduleAccess.service');

const AUTHKIT_DOMAIN = (process.env.AUTHKIT_DOMAIN || '').replace(/\/$/, '');
const MCP_RESOURCE_URL = process.env.MCP_RESOURCE_URL || 'https://gowarmcrm.com/mcp';

if (!AUTHKIT_DOMAIN) {
  throw new Error('AUTHKIT_DOMAIN env var is required, e.g. https://your-env.authkit.app');
}

const PUBLIC_ORIGIN = new URL(MCP_RESOURCE_URL).origin;   // https://gowarmcrm.com
const RESOURCE_PATH  = new URL(MCP_RESOURCE_URL).pathname; // /mcp

// RFC 9728 §3.1 builds the metadata URL by inserting the well-known path
// between the host and the resource's path, so https://gowarmcrm.com/mcp
// resolves to .../.well-known/oauth-protected-resource/mcp. That is the URL we
// name in the challenge. PRM_URL (the bare root) stays served as well, because
// older MCP clients probe it directly instead of following WWW-Authenticate.
const PRM_URL           = `${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource`;
const PRM_URL_CANONICAL = `${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource${RESOURCE_PATH}`;

const JWKS = createRemoteJWKSet(new URL(`${AUTHKIT_DOMAIN}/oauth2/jwks`));

// Advertised scopes. Empty by default — see the env-var note at the top of this
// file. This list is advertisement only; enforcement is MCP_WRITE_SCOPE below
// (read tools need only a valid, audience-bound token). Do not add names here
// as aspiration; an advertised scope that neither WorkOS issues nor this
// server checks is worse than no list at all.
const SCOPES_SUPPORTED = (process.env.MCP_SCOPES_SUPPORTED || '')
  .split(',').map(s => s.trim()).filter(Boolean);

if (!SCOPES_SUPPORTED.length) {
  console.warn(
    '[mcp] MCP_SCOPES_SUPPORTED is unset — scopes_supported will be omitted from ' +
    'the Protected Resource Metadata. Define the scopes on the GoWarmCRM resource ' +
    'in the WorkOS dashboard first, then set this env var to the same names.'
  );
}

const WRITE_SCOPE = (process.env.MCP_WRITE_SCOPE || '').trim();
if (!WRITE_SCOPE) {
  console.warn(
    '[mcp] MCP_WRITE_SCOPE is unset — write tools are allowed for any authenticated ' +
    'user who passes the normal permission checks. Set it once the scope exists in WorkOS.'
  );
}

// OAuth carries scopes as one space-separated `scope` string (RFC 8693 §4.2);
// some issuers use an `scp` array instead. Accept either so a WorkOS format
// change doesn't silently lock every agent out of writes.
function tokenHasScope(auth, wanted) {
  if (typeof auth?.scope === 'string' && auth.scope.split(/\s+/).includes(wanted)) return true;
  if (Array.isArray(auth?.scp) && auth.scp.includes(wanted)) return true;
  return false;
}

// RFC 9728 Protected Resource Metadata. One document, served at both paths.
function protectedResourceMetadata() {
  const doc = {
    resource: MCP_RESOURCE_URL,
    resource_name: 'GoWarmCRM',
    authorization_servers: [AUTHKIT_DOMAIN],
    bearer_methods_supported: ['header'],
    resource_documentation: `${PUBLIC_ORIGIN}/auth.md`,
  };
  if (SCOPES_SUPPORTED.length) doc.scopes_supported = SCOPES_SUPPORTED;
  return doc;
}

// RFC 6750 reserves the `error` parameter for requests that presented a
// credential and failed. A request with no Authorization header at all gets a
// bare challenge; only a rejected token gets error="invalid_token".
const CHALLENGE_MISSING = `Bearer resource_metadata="${PRM_URL_CANONICAL}"`;

const CHALLENGE_INVALID = [
  'Bearer error="invalid_token"',
  'error_description="The access token is expired, revoked, malformed, or bound to a different resource"',
  `resource_metadata="${PRM_URL_CANONICAL}"`,
].join(', ');

// ── Tool result helpers ──────────────────────────────────────────────────────
const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj });
const fail = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });

// Sequence visibility for agents: shared sequences, plus the caller's own
// private ones. Deliberately stricter than the UI for managers/admins (who can
// also see subordinates' private sequences there) — deny-by-default is the
// safer gap for an agent. Appends its param; pass the params array in use.
function sequenceVisibleSql(alias, actor, params) {
  params.push(actor.userId);
  return `(${alias}.visibility = 'shared' OR ${alias}.created_by = $${params.length})`;
}

// Merge tokens SequenceStepFirer.renderTemplate fills in. Anything else in
// {{...}} — a typo, a space inside the braces, an invented field — reaches the
// prospect verbatim, so agent-written templates are checked before saving.
function findBadTokens(text) {
  if (!text) return [];
  const bad = [];
  for (const m of String(text).matchAll(/\{\{([^}]*)\}\}/g)) {
    const inner = m[1];
    if (!/^\w+$/.test(inner) || !SequenceCreateService.TEMPLATE_TOKENS.includes(inner)) bad.push(m[0]);
  }
  return bad;
}

function summariseSequence(s, steps) {
  if (!s) return null;
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    status: s.status,
    visibility: s.visibility,
    ai_enabled: s.ai_enabled,
    require_approval: s.require_approval,
    created_by: s.created_by,
    created_at: s.created_at,
    steps: (steps || []).map(st => ({
      id: st.id,
      step_order: st.step_order,
      channel: st.channel,
      delay_days: st.delay_days,
      delay_hours: st.delay_hours,
      step_intent: st.step_intent,
      subject_template: st.subject_template,
      body_template: st.body_template,
      task_note: st.task_note,
    })),
  };
}

const DRAFT_NOTE =
  'This sequence is a DRAFT: your team can see it in Sequences, but no prospect can be enrolled ' +
  'until someone reviews it and clicks Publish in GoWarmCRM.';

// loadCampaign returns c.* — 30+ columns including the JSONB config override.
// An agent needs the identity and the fields it just set, not internals.
function summariseCampaign(c) {
  if (!c) return null;
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    activity_type: c.activity_type,
    description: c.description,
    solution: c.solution,
    default_sequence_id: c.default_sequence_id,
    default_sequence_name: c.default_sequence_name,
    playbook_id: c.playbook_id,
    playbook_name: c.playbook_name,
    goal_qualified: c.goal_qualified,
    start_date: c.start_date,
    end_date: c.end_date,
    owner_id: c.owner_id,
    created_at: c.created_at,
  };
}

// ── Identity: resolve the GoWarmCRM user behind the token ──────────────────────
// The token's `sub` is the GoWarmCRM user id (the bridge passes it through at
// completion). We load the user + their active org so every tool runs as that rep.
async function getActor(auth) {
  const userId = parseInt(auth?.sub, 10);
  if (!Number.isFinite(userId)) return null;
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.first_name, u.last_name, ou.org_id, ou.role
       FROM users u
       JOIN org_users ou ON ou.user_id = u.id AND ou.is_active = TRUE
      WHERE u.id = $1
      ORDER BY ou.joined_at ASC
      LIMIT 1`,
    [userId]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return { userId: r.id, orgId: r.org_id, email: r.email, firstName: r.first_name, lastName: r.last_name, role: r.role };
}

// Subordinate ids for scope='team'. Lazy-required + defensive: if the hierarchy
// service can't load, team scope quietly degrades to "just me" rather than 500.
async function safeSubordinates(orgId, userId) {
  try {
    const hs = require('./services/hierarchyService');
    const fn = hs.getSubordinates || (hs.default && hs.default.getSubordinates);
    if (!fn) return [];
    return (await fn(orgId, userId)) || [];
  } catch {
    return [];
  }
}

// Mirrors requireModule('prospecting'): the org must have the module provisioned
// AND enabled, and this user must have been granted it. Unlike the middleware
// (which fails OPEN on a DB error so the UI stays usable), this fails CLOSED —
// getOrgModules returns all-false on error — because it guards writes.
async function hasProspectingModule(actor) {
  const mods = await requireModule.getOrgModules(actor.orgId);
  const p = mods.prospecting || {};
  if (!(p.allowed && p.enabled)) return false;
  return moduleAccess.hasModule(actor.orgId, actor.userId, 'prospecting');
}

// Build the owner filter for the action queue, matching the /unified route.
// `alias` MUST qualify user_id to the action table (e.g. 'a' or 'pa'); both
// queries join a second table that also has user_id, so a bare column is ambiguous.
async function buildOwnerFilter(actor, scope, params, alias) {
  if (scope === 'team') {
    const subs = await safeSubordinates(actor.orgId, actor.userId);
    params.push([actor.userId, ...subs]);
    return `AND ${alias}.user_id = ANY($${params.length}::int[])`;
  }
  if (scope === 'org') return '';
  params.push(actor.userId);
  return `AND ${alias}.user_id = $${params.length}`;
}

// ── Verify AuthKit-issued access tokens, audience-bound to this MCP server ─────
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) {
    return res.set('WWW-Authenticate', CHALLENGE_MISSING).status(401).json({ error: 'missing_token' });
  }
  try {
    const { payload } = await jwtVerify(token, JWKS, { issuer: AUTHKIT_DOMAIN, audience: MCP_RESOURCE_URL });
    req.auth = payload;
    next();
  } catch (err) {
    // Without this line a misconfigured AUTHKIT_DOMAIN / MCP_RESOURCE_URL looks
    // identical to "the client never connected". jose's code + message name the
    // failed check (e.g. ERR_JWT_CLAIM_VALIDATION_FAILED: unexpected "aud" claim
    // value) and never include the token itself. A request with NO token is not
    // logged above — that is the normal first step of every OAuth handshake.
    console.warn('[mcp:auth] token rejected:', err?.code || err?.name || 'unknown', '-', err?.message);
    return res.set('WWW-Authenticate', CHALLENGE_INVALID).status(401).json({ error: 'invalid_token' });
  }
}

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version');
  res.set('Access-Control-Expose-Headers', 'Mcp-Session-Id, WWW-Authenticate');
}

// ── Build a fresh MCP server per request (stateless), scoped to the actor ──────
async function buildServer(auth) {
  const server = new McpServer({ name: 'gowarmcrm', version: '0.4.0' });
  const actor = await getActor(auth);

  // One log line per tool call. /mcp traffic is otherwise invisible in
  // production (morgan only runs in development), so this is the only record
  // of what agents actually invoked. Arguments are deliberately NOT logged —
  // they can carry prospect names and campaign content.
  const tool = (name, config, handler) => server.registerTool(name, config, async (args, extra) => {
    const started = Date.now();
    let outcome = 'threw';
    try {
      const result = await handler(args, extra);
      outcome = result?.isError ? 'error' : 'ok';
      return result;
    } finally {
      console.log(
        `[mcp:call] tool=${name} user=${actor?.userId ?? 'unknown'} org=${actor?.orgId ?? 'unknown'} ` +
        `result=${outcome} ms=${Date.now() - started}`
      );
    }
  });

  // ── whoami (read) ───────────────────────────────────────────────────────────
  tool(
    'whoami',
    {
      title: 'Who am I',
      description:
        'Returns the identity of the authenticated GoWarmCRM user behind the current agent session. Use to confirm which rep the agent is acting on behalf of.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      if (!actor) {
        return ok({ user_id: auth?.sub ?? null, email: auth?.email ?? null, issuer: auth?.iss ?? null,
          note: 'No matching GoWarmCRM user found for this token.' });
      }
      return ok({
        user_id: actor.userId,
        email: actor.email,
        name: `${actor.firstName || ''} ${actor.lastName || ''}`.trim() || null,
        org_id: actor.orgId,
        role: actor.role,
        issuer: auth?.iss ?? null,
        scopes: auth?.scope ?? null,
      });
    },
  );

  // ── get_action_queue (read) — the centerpiece ────────────────────────────────
  tool(
    'get_action_queue',
    {
      title: 'Get action queue',
      description:
        "Returns the authenticated rep's prioritized next actions across deals and prospecting, already sorted by status, priority, then due date — the same queue they see in GoWarmCRM. Use to answer 'what should I work on next?'.",
      inputSchema: {
        scope: z.enum(['mine', 'team', 'org']).default('mine')
          .describe("Whose actions: 'mine' (default), 'team' (you + your direct/indirect reports), or 'org' (whole org)."),
        source: z.enum(['all', 'deals', 'prospecting']).default('all')
          .describe("Which actions: 'all' (default), 'deals' only, or 'prospecting' only."),
        limit: z.number().int().min(1).max(100).default(25).describe('Max actions to return (default 25).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ scope, source, limit }) => {
      if (!actor) return fail('No GoWarmCRM user found for this session.');
      try {
        let dealActions = [];
        let prospectingActions = [];

        if (source === 'all' || source === 'deals') {
          const params = [actor.orgId];
          const ownerFilter = await buildOwnerFilter(actor, scope, params, 'a');
          const r = await db.query(
            `SELECT a.*, d.name AS deal_name, d.stage AS deal_stage, d.value AS deal_value,
                    acc.name AS account_name
               FROM actions a
               LEFT JOIN deals d ON a.deal_id = d.id
               LEFT JOIN accounts acc ON d.account_id = acc.id
              WHERE a.org_id = $1 ${ownerFilter}
                AND a.status IN ('pending','in_progress','snoozed')
              ORDER BY
                CASE a.status WHEN 'pending' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'snoozed' THEN 3 ELSE 4 END,
                CASE a.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
                a.due_date ASC NULLS LAST`,
            params
          );
          dealActions = r.rows.map((row) => {
            const { deal_name, deal_stage, deal_value, account_name, ...rest } = row;
            return {
              ...rest,
              actionSource: 'deal',
              deal: row.deal_id ? { id: row.deal_id, name: deal_name, stage: deal_stage, value: deal_value } : null,
              account: account_name ? { name: account_name } : null,
            };
          });
        }

        if (source === 'all' || source === 'prospecting') {
          const params = [actor.orgId];
          const ownerFilter = await buildOwnerFilter(actor, scope, params, 'pa');
          const r = await db.query(
            `SELECT pa.*, p.first_name AS prospect_first_name, p.last_name AS prospect_last_name,
                    p.email AS prospect_email, p.company_name AS prospect_company_name, p.stage AS prospect_stage
               FROM prospecting_actions pa
               LEFT JOIN prospects p ON pa.prospect_id = p.id
              WHERE pa.org_id = $1 ${ownerFilter}
                AND pa.status IN ('pending','in_progress','snoozed')
              ORDER BY
                CASE pa.status WHEN 'pending' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'snoozed' THEN 3 ELSE 4 END,
                CASE pa.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
                pa.due_date ASC NULLS LAST`,
            params
          );
          prospectingActions = r.rows.map((row) => {
            const { prospect_first_name, prospect_last_name, prospect_email, prospect_company_name, prospect_stage, ...rest } = row;
            return {
              ...rest,
              actionSource: 'prospecting',
              prospect: row.prospect_id ? {
                id: row.prospect_id, firstName: prospect_first_name, lastName: prospect_last_name,
                email: prospect_email, companyName: prospect_company_name, stage: prospect_stage,
              } : null,
            };
          });
        }

        const priorityOrder = { critical: 1, high: 2, medium: 3, low: 4 };
        const merged = [...dealActions, ...prospectingActions].sort((a, b) => {
          const pa = priorityOrder[a.priority] || 99;
          const pb = priorityOrder[b.priority] || 99;
          if (pa !== pb) return pa - pb;
          const da = a.due_date ? new Date(a.due_date) : new Date('2099-01-01');
          const dbb = b.due_date ? new Date(b.due_date) : new Date('2099-01-01');
          return da - dbb;
        }).slice(0, limit);

        return ok({
          scope, source,
          counts: { total: dealActions.length + prospectingActions.length, deals: dealActions.length, prospecting: prospectingActions.length, returned: merged.length },
          actions: merged,
        });
      } catch (err) {
        console.error('[mcp:get_action_queue]', err.message);
        return fail('Failed to load the action queue.');
      }
    },
  );

  // ── list_campaigns (read) ─────────────────────────────────────────────────────
  tool(
    'list_campaigns',
    {
      title: 'List prospecting campaigns',
      description:
        "Lists the rep's prospecting campaigns with status and prospect counts. Use before creating or executing a campaign to see what already exists.",
      inputSchema: {
        scope: z.enum(['mine', 'team', 'org']).default('mine')
          .describe("Whose campaigns: 'mine' (default), 'team', or 'org'."),
        status: z.enum(['active', 'paused', 'archived']).optional()
          .describe('Optional status filter.'),
        limit: z.number().int().min(1).max(100).default(25),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ scope, status, limit }) => {
      if (!actor) return fail('No GoWarmCRM user found for this session.');
      try {
        const params = [actor.orgId];
        let ownerFilter = '';
        if (scope === 'team') {
          const subs = await safeSubordinates(actor.orgId, actor.userId);
          params.push([actor.userId, ...subs]);
          ownerFilter = `AND c.owner_id = ANY($${params.length}::int[])`;
        } else if (scope !== 'org') {
          params.push(actor.userId);
          ownerFilter = `AND c.owner_id = $${params.length}`;
        }
        let statusFilter = '';
        if (status) { params.push(status); statusFilter = `AND c.status = $${params.length}`; }
        params.push(limit);

        const r = await db.query(
          `SELECT c.id, c.name, c.status, c.solution, c.owner_id, c.default_sequence_id,
                  c.goal_qualified, c.start_date, c.end_date, c.created_at,
                  -- ::int: COUNT(*) is bigint, which node-pg returns as a STRING ("113").
                  -- get_campaign already casts; this keeps both tools numeric.
                  (SELECT COUNT(*)::int FROM prospects p WHERE p.campaign_id = c.id AND p.deleted_at IS NULL) AS prospect_count
             FROM prospecting_campaigns c
            WHERE c.org_id = $1 ${ownerFilter} ${statusFilter}
            ORDER BY c.created_at DESC
            LIMIT $${params.length}`,
          params
        );
        return ok({ scope, count: r.rows.length, campaigns: r.rows });
      } catch (err) {
        console.error('[mcp:list_campaigns]', err.message);
        return fail('Failed to list campaigns.');
      }
    },
  );

  // ── get_campaign (read) ───────────────────────────────────────────────────────
  tool(
    'get_campaign',
    {
      title: 'Get campaign detail',
      description:
        'Returns a single prospecting campaign with its sequence, prospect stage breakdown, and active enrollment count. Use to inspect a campaign before executing it.',
      inputSchema: {
        campaign_id: z.number().int().describe('The campaign id (from list_campaigns).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ campaign_id }) => {
      if (!actor) return fail('No GoWarmCRM user found for this session.');
      try {
        const subs = await safeSubordinates(actor.orgId, actor.userId);
        const visible = [actor.userId, ...subs];
        const cr = await db.query(
          `SELECT c.*, s.name AS sequence_name, s.status AS sequence_status
             FROM prospecting_campaigns c
             LEFT JOIN sequences s ON s.id = c.default_sequence_id
            WHERE c.id = $1 AND c.org_id = $2 AND c.owner_id = ANY($3::int[])`,
          [campaign_id, actor.orgId, visible]
        );
        if (!cr.rows.length) return fail('Campaign not found or not within your visibility.');
        const campaign = cr.rows[0];

        const stageRes = await db.query(
          `SELECT stage, COUNT(*)::int AS count
             FROM prospects WHERE campaign_id = $1 AND org_id = $2 AND deleted_at IS NULL
            GROUP BY stage ORDER BY stage`,
          [campaign_id, actor.orgId]
        );
        const enrollRes = await db.query(
          `SELECT COUNT(*)::int AS active_enrollments
             FROM sequence_enrollments se
             JOIN prospects p ON p.id = se.prospect_id
            WHERE p.campaign_id = $1 AND se.org_id = $2 AND se.status = 'active'`,
          [campaign_id, actor.orgId]
        );

        return ok({
          campaign,
          prospects_by_stage: stageRes.rows,
          active_enrollments: enrollRes.rows[0]?.active_enrollments ?? 0,
        });
      } catch (err) {
        console.error('[mcp:get_campaign]', err.message);
        return fail('Failed to load the campaign.');
      }
    },
  );

  // ── list_sequences (read) ─────────────────────────────────────────────────────
  // 0.4.0: now filters by visibility (shared + your own private) — previously it
  // listed every private sequence in the org, which the UI never shows. Adds a
  // 'draft' filter so agents can find sequences awaiting publish.
  tool(
    'list_sequences',
    {
      title: 'List outreach sequences',
      description:
        'Lists the org\'s outreach sequences (the multi-step cadences a campaign enrolls prospects into) with step counts. ' +
        "Use to choose a default_sequence_id when creating a campaign. 'active' sequences can be enrolled into; 'draft' ones are awaiting human review and Publish.",
      inputSchema: {
        status: z.enum(['active', 'draft', 'all']).default('active')
          .describe("'active' (default — the ones you can enroll into), 'draft' (awaiting Publish), or 'all' (including archived)."),
        limit: z.number().int().min(1).max(100).default(50),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ status, limit }) => {
      if (!actor) return fail('No GoWarmCRM user found for this session.');
      try {
        const params = [actor.orgId];
        let statusFilter = '';
        if (status === 'active') statusFilter = `AND s.status = 'active'`;
        if (status === 'draft')  statusFilter = `AND s.status = 'draft'`;
        const vis = sequenceVisibleSql('s', actor, params);
        params.push(limit);
        const r = await db.query(
          `SELECT s.id, s.name, s.status, s.visibility,
                  (SELECT COUNT(*)::int FROM sequence_steps ss WHERE ss.sequence_id = s.id) AS step_count
             FROM sequences s
            WHERE s.org_id = $1 ${statusFilter} AND ${vis}
            ORDER BY s.name
            LIMIT $${params.length}`,
          params
        );
        return ok({ count: r.rows.length, sequences: r.rows });
      } catch (err) {
        console.error('[mcp:list_sequences]', err.message);
        return fail('Failed to list sequences.');
      }
    },
  );

  // ── get_sequence (read) ───────────────────────────────────────────────────────
  tool(
    'get_sequence',
    {
      title: 'Get outreach sequence',
      description:
        'Returns one sequence with its steps in order (channel, delays, intent, subject/body templates, task notes). ' +
        'Use to check a sequence you created, or to inspect an existing one before attaching it to a campaign.',
      inputSchema: {
        sequence_id: z.number().int().positive().describe('The sequence id (from list_sequences).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ sequence_id }) => {
      if (!actor) return fail('No GoWarmCRM user found for this session.');
      try {
        const params = [sequence_id, actor.orgId];
        const vis = sequenceVisibleSql('s', actor, params);
        const sq = await db.query(
          `SELECT s.* FROM sequences s WHERE s.id = $1 AND s.org_id = $2 AND ${vis}`,
          params
        );
        // Same message for "missing" and "someone else's private sequence", so
        // the tool never confirms a private sequence exists.
        if (!sq.rows.length) return fail(`Sequence ${sequence_id} not found.`);
        const steps = await db.query(
          `SELECT * FROM sequence_steps WHERE sequence_id = $1 ORDER BY step_order`,
          [sequence_id]
        );
        const out = summariseSequence(sq.rows[0], steps.rows);
        if (out.status === 'draft') out.note = DRAFT_NOTE;
        return ok(out);
      } catch (err) {
        console.error('[mcp:get_sequence]', err.message);
        return fail('Failed to load the sequence.');
      }
    },
  );

  // ── create_sequence (write) ───────────────────────────────────────────────────
  // Always created as a shared DRAFT with approval forced on:
  //   • draft  — visible to the whole team, but every enrollment path requires
  //              status='active', so nothing can run until a person reviews the
  //              copy and clicks Publish in the UI.
  //   • require_approval=true, and steps never override it — SequenceStepFirer
  //     auto-sends email (and, with the org toggle on, LinkedIn connection
  //     requests) only when effective approval is false. Even once published,
  //     an agent-written sequence produces drafts for a human to approve.
  // Threading, per-step personalisation config and manager-edit rights are not
  // exposed; they keep the builder defaults and can be changed in the UI.
  tool(
    'create_sequence',
    {
      title: 'Create outreach sequence',
      description:
        'Creates a multi-step outreach sequence (email / LinkedIn / call / task steps with delays) as a shared DRAFT that requires approval for every message. ' +
        'Drafts are visible to the team but cannot be enrolled into until a person reviews and publishes them in GoWarmCRM. ' +
        'Call list_sequences first: if you already have a non-archived sequence with the same name, it is returned (already_exists: true) instead of creating a duplicate. ' +
        `Templates may use only these merge tokens: ${SequenceCreateService.TEMPLATE_TOKENS.map(t => `{{${t}}}`).join(', ')}. ` +
        'Email steps need subject_template and body_template unless ai_enabled is true (then AI writes each message per prospect). ' +
        'delay_days/delay_hours are the wait after the previous step (for step 1, after enrollment).',
      inputSchema: {
        name: z.string().trim().min(1).max(200).describe('Sequence name. Must be unique among your non-archived sequences.'),
        description: z.string().max(5000).optional().describe('Purpose, tone or goal of the sequence.'),
        ai_enabled: z.boolean().default(false)
          .describe('If true, AI personalises each email/LinkedIn step per prospect at activation; templates become optional guidance.'),
        steps: z.array(z.object({
          channel: z.enum(['email', 'linkedin', 'call', 'task']),
          delay_days: z.number().int().min(0).max(90).default(0),
          delay_hours: z.number().int().min(0).max(23).default(0),
          subject_template: z.string().max(500).optional().describe('Email subject. Email steps only.'),
          body_template: z.string().max(10000).optional().describe('Email body or LinkedIn message.'),
          task_note: z.string().max(2000).optional().describe('Instructions for call/task steps, or a note on any step.'),
          step_intent: z.enum(['first_touch', 'follow_up', 'breakup', 'connection_request', 'post_accept_message', 'nurture_dm'])
            .optional()
            .describe('Optional. Email: first_touch | follow_up | breakup. LinkedIn: connection_request | post_accept_message | nurture_dm. Omit to auto-infer.'),
        })).min(1).max(15).describe('Steps in send order (1-15).'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true, // same name twice returns the existing sequence
        openWorldHint: false,
      },
    },
    async (args) => {
      if (!actor) return fail('No GoWarmCRM user found for this session.');
      if (WRITE_SCOPE && !tokenHasScope(auth, WRITE_SCOPE)) {
        return fail(`This connection is not authorised to make changes. Reconnect and grant the "${WRITE_SCOPE}" permission.`);
      }

      // Strict, agent-facing checks. The shared service would quietly normalise
      // a cross-channel intent to "auto"; an agent should be told instead.
      const problems = [];
      args.steps.forEach((st, i) => {
        const n = i + 1;
        if (st.step_intent && !SequenceCreateService.INTENTS_BY_CHANNEL[st.channel].includes(st.step_intent)) {
          const allowed = SequenceCreateService.INTENTS_BY_CHANNEL[st.channel];
          problems.push(`Step ${n} (${st.channel}): step_intent "${st.step_intent}" is not valid` +
            (allowed.length ? ` — use one of ${allowed.join(', ')} or omit it.` : ` — ${st.channel} steps take no intent; omit it.`));
        }
        if (st.channel === 'email' && !args.ai_enabled && (!st.subject_template?.trim() || !st.body_template?.trim())) {
          problems.push(`Step ${n} (email): subject_template and body_template are required when ai_enabled is false.`);
        }
        const bad = [
          ...findBadTokens(st.subject_template),
          ...findBadTokens(st.body_template),
          ...findBadTokens(st.task_note),
        ];
        if (bad.length) {
          problems.push(`Step ${n}: unknown merge token(s) ${[...new Set(bad)].join(', ')} — these would be sent to the prospect as-is.`);
        }
      });
      if (problems.length) {
        return fail(
          'The sequence was not created:\n- ' + problems.join('\n- ') +
          `\nAllowed tokens: ${SequenceCreateService.TEMPLATE_TOKENS.map(t => `{{${t}}}`).join(', ')}`
        );
      }

      try {
        // Duplicate guard — agents retry on timeouts. Your own non-archived
        // sequences, case-insensitive; MCP path only (the UI is unchanged).
        const dup = await db.query(
          `SELECT id FROM sequences
            WHERE org_id = $1 AND created_by = $2 AND status <> 'archived'
              AND LOWER(TRIM(name)) = LOWER($3)
            ORDER BY created_at DESC
            LIMIT 1`,
          [actor.orgId, actor.userId, args.name]
        );
        if (dup.rows.length) {
          const seq = await db.query(`SELECT * FROM sequences WHERE id = $1`, [dup.rows[0].id]);
          const steps = await db.query(
            `SELECT * FROM sequence_steps WHERE sequence_id = $1 ORDER BY step_order`, [dup.rows[0].id]
          );
          const existing = summariseSequence(seq.rows[0], steps.rows);
          return ok({
            created: false,
            already_exists: true,
            note: 'You already have a sequence with this name; returning it instead of creating a duplicate.' +
              (existing.status === 'draft' ? ' ' + DRAFT_NOTE : ''),
            sequence: existing,
          });
        }

        const result = await SequenceCreateService.createSequence({
          orgId: actor.orgId,
          userId: actor.userId,
          status: 'draft',
          // Whitelisted — never spread args into the service.
          input: {
            name: args.name,
            description: args.description,
            ai_enabled: args.ai_enabled,
            require_approval: true,
            visibility: 'shared',
            steps: args.steps.map(st => ({
              channel: st.channel,
              delay_days: st.delay_days,
              delay_hours: st.delay_hours,
              subject_template: st.subject_template,
              body_template: st.body_template,
              task_note: st.task_note,
              step_intent: st.step_intent,
              // require_approval deliberately omitted → NULL → inherits the
              // sequence's true. A step can never opt itself into auto-send.
            })),
          },
        });
        if (!result.ok) return fail(result.message);

        return ok({
          created: true,
          already_exists: false,
          note: DRAFT_NOTE,
          sequence: summariseSequence(result.sequence, result.sequence.steps),
        });
      } catch (err) {
        console.error('[mcp:create_sequence]', err.message);
        return fail('Failed to create the sequence.');
      }
    },
  );

  // ── create_prospecting_campaign (write) ───────────────────────────────────────
  // Creates directly (no AgentProposalService round-trip): an empty campaign
  // sends nothing and is archived in one click, and the proposal framework is
  // deal-scoped. Approval gating belongs on the tools that actually send.
  //
  // Deliberately narrower than POST /: no owner_id (the agent always creates as
  // the authenticated rep, so there is no admin-impersonation path to secure),
  // no client_id, schedule overrides, sender selection, share_weight or inline
  // targeting. Omitted fields inherit org defaults, exactly as in the UI.
  tool(
    'create_prospecting_campaign',
    {
      title: 'Create prospecting campaign',
      description:
        'Creates a new prospecting campaign owned by the authenticated rep. It is created PAUSED by default, so nothing runs until the rep activates it in GoWarmCRM. ' +
        'Call list_campaigns first; if a non-archived campaign with the same name already exists for this rep, that campaign is returned (already_exists: true) instead of creating a duplicate. ' +
        'Use list_sequences to pick default_sequence_id.',
      inputSchema: {
        name: z.string().trim().min(1).max(200).describe('Campaign name. Must be unique among your non-archived campaigns.'),
        description: z.string().max(5000).optional().describe('Free-text description.'),
        solution: z.string().max(2000).optional().describe('The solution or offer this campaign prospects for.'),
        default_sequence_id: z.number().int().positive().optional()
          .describe('Outreach sequence prospects are enrolled into (from list_sequences).'),
        playbook_id: z.number().int().positive().optional()
          .describe('A prospecting playbook id in this org.'),
        target_profile_id: z.number().int().positive().optional()
          .describe('Target Profile to seed targeting from (copied, not linked).'),
        goal_qualified: z.number().int().min(1).max(100000).optional()
          .describe('Target number of qualified prospects (SALs).'),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional(),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional(),
        activity_type: z.enum(['outreach', 'field_event', 'digital', 'discovery']).default('outreach'),
        // Only the two "live" states. An agent has no reason to create a
        // campaign that is already completed or archived.
        status: z.enum(['paused', 'active']).default('paused')
          .describe("'paused' (default — rep activates it in GoWarmCRM) or 'active'."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        // Same name twice returns the existing campaign rather than a second one.
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      if (!actor) return fail('No GoWarmCRM user found for this session.');

      if (WRITE_SCOPE && !tokenHasScope(auth, WRITE_SCOPE)) {
        return fail(`This connection is not authorised to make changes. Reconnect and grant the "${WRITE_SCOPE}" permission.`);
      }

      // Agents emit dates freely; catch an inverted range here rather than
      // store a campaign that ends before it starts. (POST / does not check
      // this either — kept agent-side so UI behaviour is unchanged.)
      if (args.start_date && args.end_date && args.end_date < args.start_date) {
        return fail('end_date must be on or after start_date.');
      }

      try {
        if (!(await hasProspectingModule(actor))) {
          return fail('The Prospecting module is not enabled for this user or org.');
        }

        // Duplicate guard. Agents retry on timeouts; without this a retried call
        // creates a second identical campaign. Scoped to the rep's own
        // non-archived campaigns, case-insensitive. Applies to the MCP path only.
        const dup = await db.query(
          `SELECT id FROM prospecting_campaigns
            WHERE org_id = $1 AND owner_id = $2 AND status <> 'archived'
              AND LOWER(TRIM(name)) = LOWER($3)
            ORDER BY created_at DESC
            LIMIT 1`,
          [actor.orgId, actor.userId, args.name]
        );
        if (dup.rows.length) {
          const existing = await CampaignCreateService.loadCampaign(actor.orgId, dup.rows[0].id);
          return ok({
            created: false,
            already_exists: true,
            note: 'A campaign with this name already exists for you; returning it instead of creating a duplicate.',
            campaign: summariseCampaign(existing),
          });
        }

        // Whitelist the fields we pass on. Never spread `args` into the service:
        // it accepts owner_id / client_id / sender ids, which this tool must not.
        const result = await CampaignCreateService.createCampaign({
          orgId: actor.orgId,
          userId: actor.userId,
          input: {
            name: args.name,
            description: args.description,
            solution: args.solution,
            default_sequence_id: args.default_sequence_id,
            playbook_id: args.playbook_id,
            target_profile_id: args.target_profile_id,
            goal_qualified: args.goal_qualified,
            start_date: args.start_date,
            end_date: args.end_date,
            activity_type: args.activity_type,
            status: args.status,
          },
          // owner_id is never passed, so the admin branch is unreachable.
          isAdmin: async () => false,
        });

        if (!result.ok) return fail(result.message);

        return ok({
          created: true,
          already_exists: false,
          note: result.campaign.status === 'paused'
            ? 'Campaign created PAUSED. Activate it in GoWarmCRM when ready.'
            : 'Campaign created ACTIVE.',
          campaign: summariseCampaign(result.campaign),
        });
      } catch (err) {
        console.error('[mcp:create_prospecting_campaign]', err.message);
        return fail('Failed to create the campaign.');
      }
    },
  );

  // ── set_campaign_sequence (write) ─────────────────────────────────────────────
  // Attaches (or detaches) a campaign's default sequence. Campaigns may exist
  // without one for viewing; this is how an agent wires one up afterwards.
  // Mirrors the UI's campaign PUT: owner or admin only (CampaignAccess), and the
  // sequence must be in the org. A DRAFT sequence is allowed — activation stays
  // blocked by the enrollment routes until it is published — and the response
  // says so. Only future enrollments are affected; existing enrollments keep
  // the sequence they were enrolled into.
  tool(
    'set_campaign_sequence',
    {
      title: 'Set campaign sequence',
      description:
        "Sets the default outreach sequence a campaign enrolls prospects into (or clears it with sequence_id: null). " +
        'Only the campaign owner or an admin can change it. Affects future enrollments only; prospects already enrolled stay in their current sequence. ' +
        'A draft sequence can be attached, but the campaign cannot enroll anyone until that sequence is published in GoWarmCRM.',
      inputSchema: {
        campaign_id: z.number().int().positive().describe('The campaign id (from list_campaigns).'),
        sequence_id: z.number().int().positive().nullable()
          .describe('The sequence id (from list_sequences), or null to remove the campaign\'s sequence.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ campaign_id, sequence_id }) => {
      if (!actor) return fail('No GoWarmCRM user found for this session.');
      if (WRITE_SCOPE && !tokenHasScope(auth, WRITE_SCOPE)) {
        return fail(`This connection is not authorised to make changes. Reconnect and grant the "${WRITE_SCOPE}" permission.`);
      }
      try {
        if (!(await hasProspectingModule(actor))) {
          return fail('The Prospecting module is not enabled for this user or org.');
        }

        const campaign = await CampaignCreateService.loadCampaign(actor.orgId, campaign_id);
        if (!campaign) return fail(`Campaign ${campaign_id} not found.`);
        if (campaign.status === 'archived') {
          return fail(`Campaign ${campaign_id} is archived. Restore it in GoWarmCRM before changing its sequence.`);
        }

        // Reuse the UI's exact rule. canMutateCampaign reads userId/orgId off a
        // request-like object (it caches the role lookup on it); subordinateIds
        // only shapes the refusal wording.
        const access = await CampaignAccess.canMutateCampaign(
          { userId: actor.userId, orgId: actor.orgId, subordinateIds: [] },
          campaign
        );
        if (!access.allowed) return fail(access.reason);

        let sequence = null;
        if (sequence_id !== null) {
          const params = [sequence_id, actor.orgId];
          const vis = sequenceVisibleSql('s', actor, params);
          const sq = await db.query(
            `SELECT s.id, s.name, s.status FROM sequences s
              WHERE s.id = $1 AND s.org_id = $2 AND s.status <> 'archived' AND ${vis}`,
            params
          );
          if (!sq.rows.length) return fail(`Sequence ${sequence_id} not found (or archived).`);
          sequence = sq.rows[0];
        }

        if ((campaign.default_sequence_id ?? null) === (sequence?.id ?? null)) {
          return ok({
            changed: false,
            campaign_id: campaign.id,
            campaign_name: campaign.name,
            sequence: sequence,
            note: 'No change — the campaign already uses this sequence.' +
              (sequence?.status === 'draft' ? ' ' + DRAFT_NOTE : ''),
          });
        }

        await db.query(
          `UPDATE prospecting_campaigns
              SET default_sequence_id = $1, updated_at = NOW()
            WHERE id = $2 AND org_id = $3`,
          [sequence?.id ?? null, campaign.id, actor.orgId]
        );

        let note;
        if (!sequence) note = 'Sequence removed. The campaign cannot enroll prospects until a sequence is set.';
        else if (sequence.status === 'draft') note = 'Attached a DRAFT sequence. ' + DRAFT_NOTE;
        else note = 'Sequence attached. New enrollments will use it.';

        return ok({
          changed: true,
          campaign_id: campaign.id,
          campaign_name: campaign.name,
          previous_sequence_id: campaign.default_sequence_id ?? null,
          sequence,
          note,
        });
      } catch (err) {
        console.error('[mcp:set_campaign_sequence]', err.message);
        return fail('Failed to update the campaign\'s sequence.');
      }
    },
  );

  // --- WRITE TIER (next pass): add_prospects, generate_drafts,
  //     execute_prospecting_campaign (preview/approval-first — these send). ---

  return server;
}

export function registerMcp(app) {
  // Discovery — OAuth Protected Resource Metadata (RFC 9728), public.
  // Served at BOTH paths: the RFC-derived one that WWW-Authenticate points at,
  // and the bare root that older MCP clients probe. Same document either way.
  const prmPaths = ['/.well-known/oauth-protected-resource', `/.well-known/oauth-protected-resource${RESOURCE_PATH}`];

  app.options(prmPaths, (_req, res) => { setCors(res); res.status(204).end(); });
  app.get(prmPaths, (_req, res) => {
    setCors(res);
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(protectedResourceMetadata());
  });

  // Discovery — proxy AuthKit's Authorization Server Metadata (RFC 8414).
  // Cached for five minutes so that a slow or flapping AuthKit does not stall
  // every discovery attempt, and so the agent_auth block appears on its own
  // once Agent Registration is enabled in the WorkOS dashboard.
  let asCache = { body: null, at: 0 };
  const AS_TTL_MS = 5 * 60 * 1000;

  app.options('/.well-known/oauth-authorization-server', (_req, res) => { setCors(res); res.status(204).end(); });
  app.get('/.well-known/oauth-authorization-server', async (_req, res) => {
    setCors(res);
    const now = Date.now();

    if (asCache.body && now - asCache.at < AS_TTL_MS) {
      res.set('Cache-Control', 'public, max-age=300');
      return res.json(asCache.body);
    }

    try {
      const upstream = await fetch(`${AUTHKIT_DOMAIN}/.well-known/oauth-authorization-server`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
      const body = await upstream.json();
      asCache = { body, at: now };
      res.set('Cache-Control', 'public, max-age=300');
      return res.json(body);
    } catch (err) {
      console.error('[mcp:as-metadata]', err.message);
      // Serve a stale copy rather than breaking a discovery flow mid-handshake.
      if (asCache.body) {
        res.set('Cache-Control', 'public, max-age=60');
        return res.json(asCache.body);
      }
      res.set('Cache-Control', 'no-store');
      return res.status(502).json({ error: 'upstream_metadata_unavailable' });
    }
  });

  // MCP endpoint — stateless Streamable HTTP, gated by AuthKit tokens.
  app.options('/mcp', (_req, res) => { setCors(res); res.status(204).end(); });
  app.post('/mcp', express.json(), requireAuth, async (req, res) => {
    setCors(res);
    // buildServer runs a DB query (getActor). It must sit INSIDE the try:
    // Express 4 does not catch rejected promises from async handlers, so a DB
    // failure here used to leave the request hanging with no response or log.
    let server;
    let transport;
    res.on('close', () => { transport?.close(); server?.close(); });
    try {
      server = await buildServer(req.auth);
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp:transport]', err?.message || err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });

  app.get('/mcp', (_req, res) => {
    setCors(res);
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed; use POST.' }, id: null });
  });
}
