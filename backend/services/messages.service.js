/**
 * messages.service.js
 *
 * DROP-IN LOCATION: backend/services/messages.service.js
 *
 * Channel-agnostic message retrieval for Communication → Messages.
 *
 * WHY A REGISTRY RATHER THAN A UNIFIED TABLE
 *   The obvious move is one `messages` table every channel writes into. It is
 *   also the expensive one: WhatsApp messages already carry a 24-hour service
 *   window, media ids, delivery receipts and per-message billing that Slack has
 *   no concept of. Collapsing them costs the specifics and gains a JOIN.
 *
 *   So each channel keeps its own table, and this file owns the two things that
 *   genuinely must be shared: a NORMALISED result shape, and a single place
 *   that decides which channels to ask. Adding Slack means writing one provider
 *   and registering it — no schema change, no UI change, no change to any
 *   existing channel.
 *
 * WHAT A PROVIDER MUST GUARANTEE
 *   Its own authorisation. There is no shared permission model across channels
 *   because the entitlements genuinely differ: WhatsApp is scoped by group
 *   participation, Slack would be scoped by channel membership. A provider that
 *   returns rows the caller may not see is a security bug in that provider, and
 *   this file cannot catch it for them.
 */

'use strict';

const whatsappSearch = require('./whatsappSearch.service');

const DEFAULT_LIMIT = 50;

// ─────────────────────────────────────────────────────────────────────────────
// Providers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalise a whatsapp_messages row into the shared shape.
 *
 * `channel` and `channelLabel` travel with every row rather than being implied
 * by which list it came from — the All tab interleaves channels, and a row that
 * cannot say where it came from is not renderable there.
 */
function fromWhatsApp(m) {
  return {
    id:            `whatsapp:${m.id}`,
    channel:       'whatsapp',
    channelLabel:  'WhatsApp',
    nativeId:      m.id,

    body:          m.body,
    messageType:   m.message_type,
    direction:     m.direction,

    senderName:    m.from_name || m.from_phone || null,
    senderHandle:  m.from_phone || null,

    conversationName: m.group_subject || (m.kind === 'group' ? m.wa_group_id : null),
    conversationId:   m.wa_group_id || String(m.thread_id),

    at:            m.sent_at || m.created_at,

    handoverId:    m.handover_id,
    projectName:   m.project_name,
    attribution:   m.handover_source,

    // Which actions the UI may offer. Per-channel because they are not
    // universal: a Slack message routed into a project is the same idea, but a
    // channel with no capture concept has nothing to request.
    can: { file: true, exclude: true },
  };
}

const PROVIDERS = {
  whatsapp: {
    label: 'WhatsApp',
    /** @returns {{ok:boolean, messages?:Array, code?:string}} */
    async search(orgId, userId, opts) {
      const res = await whatsappSearch.searchMessages(orgId, userId, opts);
      if (!res.ok) return res;
      return { ok: true, messages: (res.messages || []).map(fromWhatsApp) };
    },
    async available() { return true; },
  },

  // Registered but not implemented. Declaring them here rather than omitting
  // them is deliberate: the UI can show an honest "not connected yet" tab
  // instead of leaving people to wonder whether Slack history exists somewhere
  // they have not found.
  slack: {
    label: 'Slack',
    async search() { return { ok: true, messages: [], notImplemented: true }; },
    async available() { return false; },
  },
  teams: {
    label: 'Teams',
    async search() { return { ok: true, messages: [], notImplemented: true }; },
    async available() { return false; },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 *   channel  'all' | 'whatsapp' | 'slack' | 'teams'
 *   plus the per-channel filters (q, from, dateFrom, dateTo, scope, limit…)
 *
 * With no filters at all this returns the most recent messages — the default
 * view. Someone opening Messages should see their recent traffic, not an empty
 * page demanding a search term before it will show them anything.
 */
async function search(orgId, userId, opts = {}) {
  const { channel = 'all', limit = DEFAULT_LIMIT } = opts;

  const names = channel === 'all'
    ? Object.keys(PROVIDERS)
    : [channel];

  const unknown = names.filter(n => !PROVIDERS[n]);
  if (unknown.length) {
    return { ok: false, code: 'UNKNOWN_CHANNEL', error: `Unknown channel: ${unknown.join(', ')}` };
  }

  // Each channel is asked for the full limit, then the merged list is trimmed.
  // Dividing the limit between channels would mean a quiet Slack starving an
  // active WhatsApp of rows it should have shown.
  const results = await Promise.all(
    names.map(async (n) => {
      try {
        const r = await PROVIDERS[n].search(orgId, userId, { ...opts, limit });
        return { name: n, ...r };
      } catch (err) {
        // One channel failing must not blank the whole view — report it
        // alongside the channels that did work.
        console.error(`[messages] ${n} provider failed: ${err.message}`);
        return { name: n, ok: false, code: 'PROVIDER_ERROR', error: err.message };
      }
    })
  );

  const messages = [];
  const channels = {};

  for (const r of results) {
    channels[r.name] = {
      label: PROVIDERS[r.name].label,
      ok: !!r.ok,
      count: r.messages?.length || 0,
      notImplemented: !!r.notImplemented,
      error: r.ok ? null : (r.error || r.code || null),
    };
    if (r.ok && r.messages) messages.push(...r.messages);
  }

  // A single request asking for one channel that refused (e.g. the unassigned
  // queue without a steward grant) should surface that refusal, not an empty list.
  if (names.length === 1 && !results[0].ok) {
    return { ok: false, ...results[0] };
  }

  messages.sort((a, b) => new Date(b.at) - new Date(a.at));

  return {
    ok: true,
    messages: messages.slice(0, Math.min(parseInt(limit, 10) || DEFAULT_LIMIT, 200)),
    channels,
    // True when the caller supplied no filters — the UI says "recent messages"
    // rather than "search results", which are different claims.
    isDefaultView: !opts.q && !opts.from && !opts.dateFrom && !opts.dateTo,
  };
}

/** Which channels exist and which are live, for rendering the tab bar. */
async function listChannels(orgId) {
  const out = [];
  for (const [name, p] of Object.entries(PROVIDERS)) {
    let live = false;
    try { live = await p.available(orgId); } catch { live = false; }
    out.push({ channel: name, label: p.label, available: live });
  }
  return out;
}

module.exports = { search, listChannels, PROVIDERS };
