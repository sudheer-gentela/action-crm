// ─────────────────────────────────────────────────────────────────────────────
// routes/msteamsDebug.routes.js  — VERSION 2
//
// DROP-IN REPLACEMENT for backend/routes/msteamsDebug.routes.js
//
// ⚠ STILL TEMPORARY. Delete the file and the mount line once shapes are
//   captured. Every route is inert unless MSTEAMS_DEBUG=1.
//
// TWO CHANGES FROM V1
//
// 1. REDACTION IS NOW VALUE-BASED, NOT KEY-BASED.
//    V1 redacted a fixed list of key NAMES, so anything not on the list passed
//    through untouched. Two fields did exactly that against the live tenant —
//    onlineMeetingInfo.joinWebUrl and lastMessagePreview@odata.context — each
//    carrying an unmasked tenant id and user object id inside a query string.
//    The list approach cannot work: Graph has hundreds of keys and adds more.
//    Every string is now swept for GUIDs and URLs regardless of which key it
//    arrived under; key rules are kept only as a second pass for names.
//
// 2. IT HUNTS FOR MESSAGES A HUMAN WROTE.
//    V1 took $top=3 from the first chat and the first channel, which returns
//    the most RECENT messages. In a quiet conversation the most recent thing is
//    "member removed" from nine months ago — so both v1 runs came back with
//    nothing but system events, and the fields the ingest normalizer actually
//    depends on were never observed. V2 walks several conversations, pulls a
//    larger window, and reports the first messages that have a real sender.
//
//    A message is REAL when `from` is non-null AND `eventDetail` is absent.
//    That pair is the discriminator — NOT messageType, which the live tenant
//    returns as 'unknownFutureValue' for every system message. That string is
//    OData's signal for an open enum and is therefore useless as a test.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router  = express.Router();

const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');
const msteams = require('../services/msteams.service');
const graph   = require('../services/msteamsGraph.service');

router.use((req, res, next) => {
  if (process.env.MSTEAMS_DEBUG !== '1') return res.status(404).end();
  next();
});

router.use(authenticateToken, orgContext);

// ─────────────────────────────────────────────────────────────────────────────
// Redaction
// ─────────────────────────────────────────────────────────────────────────────

const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const URL_RE  = /https?:\/\/[^\s"'<>]+/gi;

function makePseudonymiser() {
  const seen = new Map();
  return (name) => {
    if (!name) return name;
    if (!seen.has(name)) {
      const i = seen.size;
      seen.set(name, `Person ${String.fromCharCode(65 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ''}`);
    }
    return seen.get(name);
  };
}

/** Stable per-response GUID aliases, so the same id reads the same throughout. */
function makeGuidAliaser() {
  const seen = new Map();
  return (guid) => {
    const k = guid.toLowerCase();
    if (!seen.has(k)) seen.set(k, `<guid-${seen.size + 1}>`);
    return seen.get(k);
  };
}

function maskId(id) {
  if (typeof id !== 'string' || id.length < 20) return id;
  return `${id.slice(0, 3)}...[${id.length - 21} chars]...${id.slice(-18)}`;
}

function describeBody(html) {
  if (typeof html !== 'string') return html;
  const tags = [...new Set([...html.matchAll(/<(\w+)/g)].map(m => m[1].toLowerCase()))];
  return {
    __redacted:  true,
    length:      html.length,
    tagsPresent: tags,
    atMentionCount: (html.match(/<at\b/gi)  || []).length,
    imgCount:       (html.match(/<img\b/gi) || []).length,
    linkCount:      (html.match(/<a\b/gi)   || []).length,
    // Tag structure with every text node and attribute VALUE stripped. Shows
    // how Teams nests mentions and inline images without carrying a character
    // of what anybody wrote.
    tagSkeleton: (html.match(/<\/?\w+[^>]*>/g) || [])
      .slice(0, 12)
      .map(t => t.replace(/\s+[\w-]+="[^"]*"/g, ' ...'))
      .join(''),
    // Attribute NAMES only. The normalizer needs to know whether <at> carries
    // id, itemid, or both — not what those values are.
    attrNames: [...new Set([...html.matchAll(/\s([\w-]+)="/g)].map(m => m[1]))],
  };
}

const NAME_KEYS = new Set(['displayName', 'userPrincipalName', 'mail', 'email', 'topic', 'name',
                           'mentionText', 'subject', 'givenName', 'surname', 'description']);
const ID_KEYS   = new Set(['id', 'chatId', 'teamId', 'channelId', 'replyToId', 'messageId',
                           'tenantId', 'userId', 'etag', 'eTag', 'callId', 'internalId']);

/** The value-level sweep. Runs on EVERY string — the part v1 got wrong. */
function scrubValue(s, guidAlias) {
  let out = s;
  URL_RE.lastIndex = 0;
  if (URL_RE.test(out)) { URL_RE.lastIndex = 0; out = out.replace(URL_RE, '<url>'); }
  GUID_RE.lastIndex = 0;
  out = out.replace(GUID_RE, m => guidAlias(m));
  return out;
}

function redact(value, pseudo, guidAlias, key = null) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(v => redact(v, pseudo, guidAlias));

  if (typeof value === 'object') {
    // A message BODY is { contentType: 'html'|'text', content: '<p>...' }.
    // An ATTACHMENT is { id, contentType: 'reference'|'application/vnd...',
    // content, contentUrl, name } — same two key names, completely different
    // thing. v2 treated both as bodies, so adaptive-card JSON came back
    // described as HTML ("tagSkeleton: <notifications@github.com>") and the
    // contentUrl of a real file reference would have been hidden by the very
    // redactor meant to preserve it. Only html/text is a body.
    const looksLikeBody = typeof value.content === 'string'
      && (value.contentType === 'html' || value.contentType === 'text');

    if (looksLikeBody) {
      return { contentType: value.contentType, content: describeBody(value.content) };
    }

    // An attachment's `content` is a JSON blob (adaptive card) or null. Describe
    // its shape; never reproduce it. contentType and contentUrl are the fields
    // that actually matter and they pass through the normal string rules —
    // contentUrl hits the /url$/i test and becomes '<url>', which still tells
    // us it was present.
    if (typeof value.content === 'string' && 'contentType' in value) {
      let keys = null;
      try { keys = Object.keys(JSON.parse(value.content)).slice(0, 12); } catch { /* not JSON */ }
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = k === 'content'
          ? { __redacted: true, length: v.length, jsonTopLevelKeys: keys }
          : redact(v, pseudo, guidAlias, k);
      }
      return out;
    }

    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // Metadata URLs are long, carry ids, and say nothing about payload shape.
      if (k.includes('@odata.context') || k.includes('@odata.nextLink')) {
        out[k] = '<dropped>';
        continue;
      }
      out[k] = redact(v, pseudo, guidAlias, k);
    }
    return out;
  }

  if (typeof value === 'string') {
    if (key && ID_KEYS.has(key)) {
      // A value that IS a bare GUID gets aliased whole. Middle-masking it would
      // preserve 18 real characters of the id, and unlike a Teams thread id
      // there is nothing informative about a GUID's shape — the ends of
      // '19:...@thread.tacv2' distinguish a channel from a chat; the ends of a
      // GUID distinguish nothing.
      if (/^[0-9a-f-]{36}$/i.test(value)) return guidAlias(value);
      return scrubValue(maskId(value), guidAlias);
    }
    if (key && NAME_KEYS.has(key)) {
      return /@/.test(value)
        ? `${pseudo(value).toLowerCase().replace(/\s+/g, '-')}@example.com`
        : pseudo(value);
    }
    if (key && /url$/i.test(key))  return '<url>';
    return scrubValue(value, guidAlias);
  }

  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** A message somebody actually wrote, as opposed to Teams machinery. */
function isRealMessage(m) {
  return !!m && m.from != null && !m.eventDetail;
}

async function attempt(label, fn) {
  try { return { step: label, ok: true, data: await fn() }; }
  catch (err) {
    return {
      step: label, ok: false,
      status: err.status ?? err.response?.status ?? null,
      kind:   err.kind ?? null,
      code:   err.code ?? err.response?.data?.error?.code ?? null,
      message: (err.message || '').slice(0, 300),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/msteams-debug/probe
// ─────────────────────────────────────────────────────────────────────────────

router.get('/probe', async (req, res) => {
  const rawMode   = req.query.raw === '1';
  const pseudo    = makePseudonymiser();
  const guidAlias = makeGuidAliaser();
  const clean = (v) => (rawMode ? v : redact(v, pseudo, guidAlias));

  // How many conversations to look through before giving up. Bounded because
  // each is a Graph call and Teams throttles per user as well as per app.
  const SCAN   = Math.min(parseInt(req.query.scan, 10) || 8, 25);
  const WINDOW = 20;

  try {
    const conn = await msteams.getConnection(req.orgId, req.userId);
    if (!conn) return res.status(404).json({ error: 'Teams is not connected for this user.' });

    const tok = await msteams.accessTokenFor(conn);
    if (!tok.ok) return res.status(400).json({ error: 'No usable token', code: tok.code });

    const at = tok.accessToken;
    const report = {
      redacted: !rawMode,
      generatedAt: new Date().toISOString(),
      note: 'v2 - hunts for messages with a real sender rather than taking the most recent.',
      steps: [],
    };

    // ── Chats ────────────────────────────────────────────────────────────
    const chats = await attempt('GET /me/chats  [Chat.Read]', () => graph.listChats(at));
    let chatList = [];
    if (chats.ok) {
      chatList = chats.data.chats || [];
      report.steps.push({
        step: chats.step, ok: true,
        summary: {
          total: chatList.length,
          byChatType: chatList.reduce((a, c) => {
            a[c.chatType || 'undefined'] = (a[c.chatType || 'undefined'] || 0) + 1; return a;
          }, {}),
        },
      });
    } else {
      report.steps.push(chats);
    }

    // Real conversations first: group and one-to-one before meeting chats,
    // which are auto-created per call and mostly hold nothing but call
    // start/end events. Most recently active first, because a live conversation
    // is far likelier to contain a human message with a mention or a file.
    const candidates = chatList
      .filter(c => c.chatType === 'group' || c.chatType === 'oneOnOne')
      .sort((a, b) =>
        new Date(b.lastMessagePreview?.createdDateTime || b.lastUpdatedDateTime || 0) -
        new Date(a.lastMessagePreview?.createdDateTime || a.lastUpdatedDateTime || 0))
      .slice(0, SCAN);

    const chatHunt = {
      step: `Scan up to ${SCAN} group/1:1 chats for real messages`,
      scanned: 0, systemSeen: 0, realSeen: 0, samples: [], errors: [],
    };

    for (const c of candidates) {
      if (chatHunt.samples.length >= 3) break;
      try {
        const page = await graph.graphGet(
          at, `/chats/${encodeURIComponent(c.id)}/messages?$top=${WINDOW}`);
        const msgs = page.value || [];
        chatHunt.scanned   += 1;
        chatHunt.systemSeen += msgs.filter(m => !isRealMessage(m)).length;
        for (const m of msgs.filter(isRealMessage)) {
          chatHunt.realSeen += 1;
          if (chatHunt.samples.length < 3) chatHunt.samples.push(clean(m));
        }
      } catch (err) {
        chatHunt.errors.push((err.message || '').slice(0, 160));
      }
    }

    chatHunt.observed = {
      anyWithMentions:    chatHunt.samples.some(m => (m.mentions || []).length),
      anyWithAttachments: chatHunt.samples.some(m => (m.attachments || []).length),
      anyEdited:          chatHunt.samples.some(m => m.lastEditedDateTime),
      fieldsSeen: [...new Set(chatHunt.samples.flatMap(m => Object.keys(m)))].sort(),
    };
    report.steps.push(chatHunt);

    // ── Teams and channels ───────────────────────────────────────────────
    const teams = await attempt('GET /me/joinedTeams  [Team.ReadBasic.All]',
      () => graph.listJoinedTeams(at));
    report.steps.push(teams.ok
      ? { step: teams.step, ok: true, summary: { total: teams.data.length } }
      : teams);

    const chanHunt = {
      step: 'Scan every channel for real messages and replies',
      channelsScanned: 0, systemSeen: 0, realSeen: 0,
      samples: [], replySamples: [], errors: [],
    };

    if (teams.ok) {
      for (const team of teams.data) {
        if (chanHunt.samples.length >= 3 && chanHunt.replySamples.length >= 2) break;

        let channels = [];
        try {
          channels = await graph.listChannels(at, team.id);
        } catch (err) {
          chanHunt.errors.push(`channels: ${(err.message || '').slice(0, 120)}`);
          continue;
        }

        // v2 reported three bare "UnknownError"s with no way to tell which
        // channels they came from. Private and shared channels are the likely
        // culprits — delegated ChannelMessage.Read.All does not reach them —
        // and that is a Phase 1 scoping fact, not a transient error, so the
        // membershipType is recorded alongside every failure.
        chanHunt.membershipTypes = chanHunt.membershipTypes || {};
        for (const ch of channels) {
          const t = ch.membershipType || 'unknown';
          chanHunt.membershipTypes[t] = (chanHunt.membershipTypes[t] || 0) + 1;
        }

        for (const ch of channels) {
          if (chanHunt.samples.length >= 3 && chanHunt.replySamples.length >= 2) break;
          try {
            const page = await graph.graphGet(at,
              `/teams/${encodeURIComponent(team.id)}/channels/${encodeURIComponent(ch.id)}` +
              `/messages?$top=${WINDOW}`);
            const msgs = page.value || [];
            chanHunt.channelsScanned += 1;
            chanHunt.systemSeen += msgs.filter(m => !isRealMessage(m)).length;

            for (const m of msgs.filter(isRealMessage)) {
              chanHunt.realSeen += 1;
              if (chanHunt.samples.length < 3) chanHunt.samples.push(clean(m));

              // Replies are the entire attribution mechanism for channels, so a
              // root WITH replies is the single most valuable sample here.
              if (chanHunt.replySamples.length < 2) {
                try {
                  const r = await graph.graphGet(at,
                    `/teams/${encodeURIComponent(team.id)}/channels/${encodeURIComponent(ch.id)}` +
                    `/messages/${encodeURIComponent(m.id)}/replies?$top=5`);
                  const reps = (r.value || []).filter(isRealMessage);
                  if (reps.length) chanHunt.replySamples.push(clean(reps[0]));
                } catch { /* a root with no replies is normal, not an error */ }
              }
            }
          } catch (err) {
            chanHunt.errors.push({
              membershipType: ch.membershipType || 'unknown',
              status:  err.status ?? null,
              code:    err.code ?? null,
              message: (err.message || '').slice(0, 160),
            });
          }
        }
      }
    }

    chanHunt.observed = {
      anyWithSubject:     chanHunt.samples.some(m => m.subject),
      anyWithMentions:    chanHunt.samples.some(m => (m.mentions || []).length),
      anyWithAttachments: chanHunt.samples.some(m => (m.attachments || []).length),
      repliesAllCarryReplyToId:
        chanHunt.replySamples.length > 0 && chanHunt.replySamples.every(m => m.replyToId),
      fieldsSeen: [...new Set(chanHunt.samples.flatMap(m => Object.keys(m)))].sort(),
    };
    report.steps.push(chanHunt);

    report.verdict = {
      chatsReadable:            chats.ok,
      channelsReadable:         teams.ok && chanHunt.channelsScanned > 0,
      realChatMessagesFound:    chatHunt.realSeen,
      realChannelMessagesFound: chanHunt.realSeen,
      channelRepliesFound:      chanHunt.replySamples.length,
      // The three shapes the ingest normalizer is built on. All false means
      // seed a test message — see the instructions that came with this file.
      sawMentions:    chatHunt.observed.anyWithMentions    || chanHunt.observed.anyWithMentions,
      sawAttachments: chatHunt.observed.anyWithAttachments || chanHunt.observed.anyWithAttachments,
      sawReplies:     chanHunt.replySamples.length > 0,
    };

    res.json(report);
  } catch (err) {
    console.error('[msteams-debug] probe failed:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
