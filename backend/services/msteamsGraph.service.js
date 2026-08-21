// ─────────────────────────────────────────────────────────────────────────────
// services/msteamsGraph.service.js
//
// DROP-IN LOCATION: backend/services/msteamsGraph.service.js
//
// The Microsoft Graph HTTP layer for Teams. Talks to Graph and Entra; touches
// no table and knows nothing about orgs, projects or triage. Everything with a
// database in it lives in msteams.service.js.
//
// The split matters because Graph is the part that fails in interesting ways —
// throttling, consent withdrawal, paged collections, an enum Microsoft extends
// without telling anyone — and none of that should be interleaved with SQL.
//
// WHY NOT MSAL
//   oauthTokenService.js builds a ConfidentialClientApplication from the
//   MICROSOFT_* Outlook credentials at module load. Teams uses a DIFFERENT app
//   registration, so reusing that client would silently authenticate against
//   the wrong application. A second MSAL instance is possible but buys nothing
//   here: authorization-code and refresh-token grants against v2 are two form
//   posts, and doing them directly keeps the Teams credentials from ever
//   touching the Outlook code path.
//
// READ-ONLY BY DESIGN
//   There is no send function in this file and there is not meant to be. The
//   scopes in config/teamsScopes.js cannot send even if someone added one.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const axios = require('axios');
const {
  TEAMS_SCOPES,
  refreshTeamsToken,
  assertTeamsConfigured,
} = require('../config/teamsScopes');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

function authority() {
  return process.env.MICROSOFT_TEAMS_AUTHORITY || 'organizations';
}

function tokenUrl() {
  return `https://login.microsoftonline.com/${authority()}/oauth2/v2.0/token`;
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuth
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The URL a REP visits to connect their own Teams account.
 *
 * prompt=select_account rather than the default: a rep signed into a personal
 * Microsoft account in the same browser — which is common, and is exactly the
 * situation on the machine this was built on — would otherwise be silently
 * carried into the flow, consent successfully, and end up with an empty chat
 * list. Making the account picker unavoidable turns a confusing empty state
 * into a visible choice.
 */
function buildAuthUrl(state) {
  assertTeamsConfigured();

  const params = new URLSearchParams({
    client_id:     process.env.MICROSOFT_TEAMS_CLIENT_ID,
    response_type: 'code',
    redirect_uri:  process.env.MICROSOFT_TEAMS_REDIRECT_URI,
    response_mode: 'query',
    scope:         TEAMS_SCOPES.join(' '),
    state:         state || '',
    prompt:        'select_account',
  });

  return `https://login.microsoftonline.com/${authority()}/oauth2/v2.0/authorize?${params.toString()}`;
}

/** Exchange an authorization code for tokens. */
async function exchangeCode(code) {
  assertTeamsConfigured();

  const params = new URLSearchParams({
    client_id:     process.env.MICROSOFT_TEAMS_CLIENT_ID,
    client_secret: process.env.MICROSOFT_TEAMS_CLIENT_SECRET,
    code,
    redirect_uri:  process.env.MICROSOFT_TEAMS_REDIRECT_URI,
    grant_type:    'authorization_code',
    scope:         TEAMS_SCOPES.join(' '),
  });

  const { data } = await axios.post(tokenUrl(), params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return data;
}

/** Refresh. Delegates so the scope list stays in exactly one place. */
async function refresh(refreshToken) {
  assertTeamsConfigured();
  return refreshTeamsToken(axios, refreshToken);
}

/**
 * Read the tenant id out of an access token.
 *
 * This DECODES and does not VALIDATE, which is normally a mistake — but the
 * token was just handed to us over TLS by the Entra token endpoint in response
 * to our own client_secret, so there is no untrusted party in the path, and the
 * value is used for display and support only. Nothing authorises off it.
 *
 * Wrapped in a total try/catch because the one behaviour that would be
 * unacceptable is a connect flow failing because a claim moved.
 */
function tenantIdFromToken(accessToken) {
  try {
    const payload = accessToken.split('.')[1];
    if (!payload) return null;
    const json = Buffer.from(
      payload.replace(/-/g, '+').replace(/_/g, '/'),
      'base64'
    ).toString('utf8');
    return JSON.parse(json).tid || null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Graph calls
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A classified Graph error. The caller needs to tell three cases apart and the
 * HTTP status alone does not: 403 is consent withdrawn OR a licence problem OR
 * an unapproved protected API, and treating all of them as "revoked" would send
 * reps to re-consent for something re-consenting cannot fix.
 */
class GraphError extends Error {
  constructor(message, { status = null, code = null, kind = 'unknown' } = {}) {
    super(message);
    this.name   = 'GraphError';
    this.status = status;
    this.code   = code;
    this.kind   = kind;   // 'auth' | 'consent' | 'throttled' | 'notfound' | 'unknown'
  }
}

function classify(err) {
  const status = err.response?.status ?? null;
  const body   = err.response?.data?.error || {};
  const code   = body.code || null;
  const text   = `${code || ''} ${body.message || ''} ${err.message || ''}`;

  let kind = 'unknown';
  if (status === 401) kind = 'auth';
  else if (status === 403) kind = /consent|Authorization_RequestDenied/i.test(text) ? 'consent' : 'auth';
  else if (status === 404) kind = 'notfound';
  else if (status === 429 || status === 503) kind = 'throttled';
  // Confirmed against a real tenant: /me/joinedTeams answers a $top with
  // 400 "Query option 'Top' is not allowed". Classified separately from a
  // generic 400 so the caller can strip the parameter and retry rather than
  // treating a fixable request as a dead end.
  else if (status === 400 && /Query option '?\w+'? is not allowed|AllowedQueryOptions/i.test(text)) {
    kind = 'unsupported_query';
  }

  return new GraphError(body.message || err.message, { status, code, kind });
}

/**
 * GET with one retry on throttling.
 *
 * Graph returns Retry-After on 429 and honouring it is not optional — Teams
 * endpoints throttle per app AND per user, and a discovery pass across a few
 * hundred conversations will hit it. One retry, because the caller is a
 * scheduled poll that will simply come round again rather than a user waiting.
 */
async function graphGet(accessToken, url, { retried = false, stripped = false } = {}) {
  const full = url.startsWith('http') ? url : `${GRAPH_BASE}${url}`;
  try {
    const { data } = await axios.get(full, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 20000,
    });
    return data;
  } catch (err) {
    const e = classify(err);

    if (e.kind === 'throttled' && !retried) {
      const wait = parseInt(err.response?.headers?.['retry-after'], 10);
      await new Promise(r => setTimeout(r, (Number.isFinite(wait) ? wait : 5) * 1000));
      return graphGet(accessToken, url, { retried: true, stripped });
    }

    // Not every Graph collection accepts $top. /me/joinedTeams rejects it
    // outright with a 400 — "Query option 'Top' is not allowed" — and there is
    // no way to know which endpoints do from the schema. Rather than maintain a
    // list that goes stale the next time Microsoft adds a collection, strip the
    // offending parameter once and retry. Costs one wasted call the first time
    // an endpoint is touched, and never fails for this reason again.
    if (e.kind === 'unsupported_query' && !stripped) {
      const cleaned = full.replace(/[?&]\$top=\d+/, m => (m[0] === '?' ? '?' : ''))
                          .replace(/\?&/, '?')
                          .replace(/[?&]$/, '');
      if (cleaned !== full) {
        console.warn(`[msteams] endpoint rejected $top, retrying without it: ${url}`);
        return graphGet(accessToken, cleaned, { retried, stripped: true });
      }
    }

    throw e;
  }
}

/**
 * Follow @odata.nextLink to the end of a collection.
 *
 * maxPages is a guard, not a limit anybody should hit: a rep in more than
 * 50 pages of chats is a signal that something is wrong with the query, and
 * looping forever inside a scheduled job is how a worker quietly stops doing
 * everything else.
 */
async function graphGetAll(accessToken, url, { maxPages = 50 } = {}) {
  const out = [];
  let next = url;
  let pages = 0;

  while (next && pages < maxPages) {
    const page = await graphGet(accessToken, next);
    if (Array.isArray(page.value)) out.push(...page.value);
    next = page['@odata.nextLink'] || null;
    pages += 1;
  }

  return { items: out, truncated: !!next };
}

/** The signed-in user. Source of entra_object_id. */
async function getMe(accessToken) {
  return graphGet(accessToken, '/me?$select=id,displayName,userPrincipalName,mail');
}

/**
 * Every chat the signed-in user is in.
 *
 * lastMessagePreview is expanded because it carries createdDateTime, the only
 * real activity signal available before capture exists — a chat's own
 * lastUpdatedDateTime moves when the TOPIC or membership changes, not when
 * somebody speaks. The preview body is deliberately never read or stored:
 * phase 0 captures nothing, and a message preview is a message.
 *
 * WHAT A REAL TENANT ACTUALLY RETURNS (measured, one rep, Aug 2026):
 *   475 chats — 405 meeting, 38 group, 28 oneOnOne, 4 unknownFutureValue.
 *
 * Two consequences the documentation does not prepare you for. Meeting chats,
 * auto-created one per Teams call, outnumber real conversations by better than
 * ten to one, so anything rendering this list unfiltered is unusable. And
 * lastMessagePreview came back populated for only 296 of the 475, so ordering
 * has to fall back rather than assume it — see chatActivityAt.
 */
async function listChats(accessToken) {
  const { items, truncated } = await graphGetAll(
    accessToken,
    '/me/chats?$top=50&$expand=lastMessagePreview'
  );
  return { chats: items, truncated };
}

/** Members of one chat — used only for a display name when topic is null. */
async function listChatMembers(accessToken, chatId) {
  const { items } = await graphGetAll(
    accessToken,
    `/chats/${encodeURIComponent(chatId)}/members?$top=50`,
    { maxPages: 3 }
  );
  return items;
}

/**
 * Teams the signed-in user has joined.
 *
 * No $top. This endpoint rejects it with a 400 — confirmed against a real
 * tenant, where it was the reason channel discovery silently produced nothing.
 * graphGet would now strip it and retry, but sending it at all costs a wasted
 * round trip on every discovery pass.
 */
async function listJoinedTeams(accessToken) {
  const { items } = await graphGetAll(accessToken, '/me/joinedTeams');
  return items;
}

/**
 * Channels within a team.
 *
 * Private and shared channels come back here too, but a rep only sees the ones
 * they are actually a member of — the delegated guarantee this whole design
 * rests on, and the reason we never call the tenant-wide equivalent.
 *
 * Also no $top: this sits behind the same Teams query-option restriction as
 * joinedTeams, and a team with more channels than one page is not a thing.
 */
async function listChannels(accessToken, teamId) {
  const { items } = await graphGetAll(
    accessToken,
    `/teams/${encodeURIComponent(teamId)}/channels`,
    { maxPages: 10 }
  );
  return items;
}

module.exports = {
  GraphError,
  buildAuthUrl,
  exchangeCode,
  refresh,
  tenantIdFromToken,
  graphGet,
  graphGetAll,
  getMe,
  listChats,
  listChatMembers,
  listJoinedTeams,
  listChannels,
};
