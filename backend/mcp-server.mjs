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
//   import { registerMcp } from './mcp-server.js';
//   registerMcp(app);
//
// NOTE: this is ESM. The MCP SDK is ESM-only — if your backend is CommonJS,
// load it via dynamic import() or convert the entry file to ESM.

import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { jwtVerify, createRemoteJWKSet } from 'jose';
// import { z } from 'zod'; // uncomment when you add tools that take inputs

const AUTHKIT_DOMAIN = (process.env.AUTHKIT_DOMAIN || '').replace(/\/$/, '');
const MCP_RESOURCE_URL = process.env.MCP_RESOURCE_URL || 'https://gowarmcrm.com/mcp';

if (!AUTHKIT_DOMAIN) {
  throw new Error('AUTHKIT_DOMAIN env var is required, e.g. https://your-env.authkit.app');
}

// The public apex origin that serves the discovery docs (where the scanner looks).
const PUBLIC_ORIGIN = new URL(MCP_RESOURCE_URL).origin; // https://gowarmcrm.com
const PRM_URL = `${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource`;

const JWKS = createRemoteJWKSet(new URL(`${AUTHKIT_DOMAIN}/oauth2/jwks`));

const WWW_AUTHENTICATE = [
  'Bearer error="unauthorized"',
  'error_description="Authorization needed to access the GoWarmCRM MCP server"',
  `resource_metadata="${PRM_URL}"`,
].join(', ');

// --- CORS: browser-based MCP clients need it; harmless for native clients ---
function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version');
  res.set('Access-Control-Expose-Headers', 'Mcp-Session-Id, WWW-Authenticate');
}

// --- Verify AuthKit-issued access tokens, audience-bound to this MCP server ---
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) {
    return res.set('WWW-Authenticate', WWW_AUTHENTICATE).status(401).json({ error: 'missing_token' });
  }
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: AUTHKIT_DOMAIN,
      audience: MCP_RESOURCE_URL,
    });
    req.auth = payload; // { sub, ... }
    next();
  } catch {
    return res.set('WWW-Authenticate', WWW_AUTHENTICATE).status(401).json({ error: 'invalid_token' });
  }
}

// --- Build a fresh MCP server per request (stateless mode) ---
function buildServer(auth) {
  const server = new McpServer({ name: 'gowarmcrm', version: '0.1.0' });

  server.registerTool(
    'whoami',
    {
      title: 'Who am I',
      description:
        'Returns the identity of the authenticated GoWarmCRM user behind the current agent session. Use to confirm which account the agent is acting on behalf of.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const out = {
        user_id: auth?.sub ?? null,
        email: auth?.email ?? null,
        issuer: auth?.iss ?? null,
        scopes: auth?.scope ?? null,
      };
      return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
    },
  );

  // --- Add real GoWarmCRM tools here as Track B firms up (read-only first). Example:
  // server.registerTool('get_action_queue', {
  //   title: 'Get action queue',
  //   description: 'Returns the prioritized next actions for the authenticated rep.',
  //   inputSchema: { limit: z.number().int().min(1).max(50).default(10) },
  //   annotations: { readOnlyHint: true },
  // }, async ({ limit }) => { /* query Postgres using auth.sub */ });

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

  // Discovery — proxy AuthKit's Authorization Server Metadata (RFC 8414) for
  // clients that fetch it from the resource origin instead of following PRM.
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
    const server = buildServer(req.auth);
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

  // Streamable HTTP is POST-only in stateless mode.
  app.get('/mcp', (_req, res) => {
    setCors(res);
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed; use POST.' }, id: null });
  });
}
