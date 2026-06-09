// mcp-server.mjs
// GoWarmCRM MCP server — mounts into your existing Express backend on Railway.
// Reachable by agents at https://gowarmcrm.com/mcp via a Vercel rewrite to api.gowarmcrm.com.
//
// Install deps:
//   npm install @modelcontextprotocol/sdk jose zod
//
// Env vars (Railway):
//   AUTHKIT_DOMAIN    https://welcoming-phrase-84-staging.authkit.app   (NO trailing slash; swap to prod later)
//   MCP_RESOURCE_URL  https://gowarmcrm.com/mcp                          (must match your WorkOS Resource Indicator)
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

const AUTHKIT_DOMAIN = (process.env.AUTHKIT_DOMAIN || '').replace(/\/$/, '');
const MCP_RESOURCE_URL = process.env.MCP_RESOURCE_URL || 'https://gowarmcrm.com/mcp';

if (!AUTHKIT_DOMAIN) {
  throw new Error('AUTHKIT_DOMAIN env var is required, e.g. https://your-env.authkit.app');
}

const PUBLIC_ORIGIN = new URL(MCP_RESOURCE_URL).origin; // https://gowarmcrm.com
const PRM_URL = `${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource`;
const JWKS = createRemoteJWKSet(new URL(`${AUTHKIT_DOMAIN}/oauth2/jwks`));

const WWW_AUTHENTICATE = [
  'Bearer error="unauthorized"',
  'error_description="Authorization needed to access the GoWarmCRM MCP server"',
  `resource_metadata="${PRM_URL}"`,
].join(', ');

// ── Tool result helpers ──────────────────────────────────────────────────────
const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj });
const fail = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });

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
    return res.set('WWW-Authenticate', WWW_AUTHENTICATE).status(401).json({ error: 'missing_token' });
  }
  try {
    const { payload } = await jwtVerify(token, JWKS, { issuer: AUTHKIT_DOMAIN, audience: MCP_RESOURCE_URL });
    req.auth = payload;
    next();
  } catch {
    return res.set('WWW-Authenticate', WWW_AUTHENTICATE).status(401).json({ error: 'invalid_token' });
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
  const server = new McpServer({ name: 'gowarmcrm', version: '0.2.0' });
  const actor = await getActor(auth);

  // ── whoami (read) ───────────────────────────────────────────────────────────
  server.registerTool(
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
  server.registerTool(
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
  server.registerTool(
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
                  (SELECT COUNT(*) FROM prospects p WHERE p.campaign_id = c.id AND p.deleted_at IS NULL) AS prospect_count
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
  server.registerTool(
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
  server.registerTool(
    'list_sequences',
    {
      title: 'List outreach sequences',
      description:
        'Lists the org\'s outreach sequences (the multi-step cadences a campaign enrolls prospects into) with step counts. Use to choose a default_sequence_id when creating a campaign.',
      inputSchema: {
        status: z.enum(['active', 'all']).default('active')
          .describe("'active' (default — the ones you can enroll into) or 'all'."),
        limit: z.number().int().min(1).max(100).default(50),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ status, limit }) => {
      if (!actor) return fail('No GoWarmCRM user found for this session.');
      try {
        const params = [actor.orgId];
        let statusFilter = '';
        if (status === 'active') { statusFilter = `AND s.status = 'active'`; }
        params.push(limit);
        const r = await db.query(
          `SELECT s.id, s.name, s.status,
                  (SELECT COUNT(*)::int FROM sequence_steps ss WHERE ss.sequence_id = s.id) AS step_count
             FROM sequences s
            WHERE s.org_id = $1 ${statusFilter}
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

  // --- WRITE TIER (next pass): create_prospecting_campaign, add_prospects,
  //     generate_drafts, execute_prospecting_campaign (preview-first). ---

  return server;
}

export function registerMcp(app) {
  // Discovery — OAuth Protected Resource Metadata (RFC 9728), public.
  app.options('/.well-known/oauth-protected-resource', (_req, res) => { setCors(res); res.status(204).end(); });
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    setCors(res);
    res.json({
      resource: MCP_RESOURCE_URL,
      authorization_servers: [AUTHKIT_DOMAIN],
      bearer_methods_supported: ['header'],
      resource_documentation: `${PUBLIC_ORIGIN}/auth.md`,
    });
  });

  // Discovery — proxy AuthKit's Authorization Server Metadata (RFC 8414).
  app.options('/.well-known/oauth-authorization-server', (_req, res) => { setCors(res); res.status(204).end(); });
  app.get('/.well-known/oauth-authorization-server', async (_req, res) => {
    setCors(res);
    try {
      const upstream = await fetch(`${AUTHKIT_DOMAIN}/.well-known/oauth-authorization-server`);
      res.status(upstream.status).json(await upstream.json());
    } catch {
      res.status(502).json({ error: 'upstream_metadata_unavailable' });
    }
  });

  // MCP endpoint — stateless Streamable HTTP, gated by AuthKit tokens.
  app.options('/mcp', (_req, res) => { setCors(res); res.status(204).end(); });
  app.post('/mcp', express.json(), requireAuth, async (req, res) => {
    setCors(res);
    const server = await buildServer(req.auth);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
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
