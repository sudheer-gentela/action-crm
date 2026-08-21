// ─────────────────────────────────────────────────────────────────────────────
// routes/msteamsDebug.routes.js
//
// DROP-IN LOCATION: backend/routes/msteamsDebug.routes.js
//
// ⚠ TEMPORARY. Deploy it, run the probe once, send the output, DELETE THE FILE
//   and remove the mount line. It exists to answer questions about real Graph
//   payload shapes that documentation cannot answer, and it should not outlive
//   those answers.
//
// MOUNT in server.js beside the other routes:
//     app.use('/api/msteams-debug', require('./routes/msteamsDebug.routes'));
//
// AND set MSTEAMS_DEBUG=1 in Railway. Without it every route here returns 404,
// so an accidentally-left-behind file is inert rather than an open window onto
// message content.
//
// WHY THIS AND NOT GRAPH EXPLORER
//   Graph Explorer runs under Microsoft's own app registration with its own
//   consent. It proves what GRAPH can do. It cannot prove what OUR scopes
//   allow, and that distinction is the whole question: Channel.ReadBasic.All
//   lists channels while ChannelMessage.Read.All reads their messages, so
//   channels can appear in triage while every message read 403s. This route
//   uses the token actually stored for the calling rep, which answers it.
//
// REDACTION IS THE DEFAULT
//   These are real project conversations. The probe returns SHAPE — field
//   names, types, id formats, which optional fields are populated — with
//   message bodies replaced by a structural summary and people replaced by
//   stable pseudonyms. That is everything needed to write an ingest normalizer
//   and none of the content. ?raw=1 disables it, for your own eyes only.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router  = express.Router();

const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');
const msteams = require('../services/msteams.service');
const graph   = require('../services/msteamsGraph.service');

// Hard gate. Everything below is unreachable unless explicitly switched on.
router.use((req, res, next) => {
  if (process.env.MSTEAMS_DEBUG !== '1') return res.status(404).end();
  next();
});

router.use(authenticateToken, orgContext);

// ─────────────────────────────────────────────────────────────────────────────
// Redaction
// ─────────────────────────────────────────────────────────────────────────────

/** Stable pseudonyms within one response, so A is the same person throughout. */
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

/**
 * Mask the middle of an id, keep the ends.
 *
 * The ends are the informative part — '19:' at the front and '@thread.tacv2'
 * or '@unq.gbl.spaces' at the back are what distinguish a channel from a chat,
 * and the ingest code branches on exactly that. The middle is the unique
 * portion and carries nothing I need.
 */
function maskId(id) {
  if (typeof id !== 'string' || id.length < 20) return id;
  const head = id.slice(0, 3);
  const tail = id.slice(-18);
  return `${head}…[${id.length - 21} chars]…${tail}`;
}

/**
 * Describe an HTML body without reproducing it.
 *
 * Which tags appear is the thing that matters: whether mentions arrive as <at>,
 * whether inline images are <img src="../hostedContents/...">, whether Teams
 * wraps everything in a <div>. That drives the normalizer. The prose does not.
 */
function describeBody(html) {
  if (typeof html !== 'string') return html;
  const tags = [...new Set([...html.matchAll(/<(\w+)/g)].map(m => m[1].toLowerCase()))];
  return {
    __redacted:   true,
    length:       html.length,
    tagsPresent:  tags,
    atMentionCount:  (html.match(/<at\b/gi)  || []).length,
    imgCount:        (html.match(/<img\b/gi) || []).length,
    linkCount:       (html.match(/<a\b/gi)   || []).length,
    // The opening tag sequence with all text nodes stripped. Shows how Teams
    // nests things — <div><at>…</at></div> vs <p><span>… — without carrying a
    // single character of what anybody wrote.
    tagSkeleton: (html.match(/<\/?\w+[^>]*>/g) || [])
      .slice(0, 8)
      .map(t => t.replace(/\s+(?:id|itemid|itemtype|src|href)="[^"]*"/gi, ' …'))
      .join(''),
  };
}

const NAME_KEYS  = new Set(['displayName', 'userPrincipalName', 'mail', 'email', 'topic', 'name',
                            'mentionText', 'subject', 'givenName', 'surname']);
const ID_KEYS    = new Set(['id', 'chatId', 'teamId', 'channelId', 'replyToId', 'messageId',
                            'tenantId', 'userId', 'etag', 'eTag']);

function redact(value, pseudo, key = null) {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) return value.map(v => redact(v, pseudo));

  if (typeof value === 'object') {
    // A body object is { contentType, content } — describe rather than descend.
    if (typeof value.content === 'string' && 'contentType' in value) {
      return { contentType: value.contentType, content: describeBody(value.content) };
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, pseudo, k);
    return out;
  }

  if (typeof value === 'string') {
    if (key && ID_KEYS.has(key))   return maskId(value);
    if (key && NAME_KEYS.has(key)) {
      return /@/.test(value) ? `${pseudo(value).toLowerCase().replace(/\s+/g, '-')}@example.com`
                             : pseudo(value);
    }
    if (key === 'webUrl') return '<url redacted>';
  }

  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Probe
// ─────────────────────────────────────────────────────────────────────────────

/** Run a call, capture success or a classified failure. Never throws. */
async function attempt(label, fn) {
  try {
    return { step: label, ok: true, data: await fn() };
  } catch (err) {
    return {
      step:   label,
      ok:     false,
      status: err.status ?? err.response?.status ?? null,
      kind:   err.kind ?? null,
      code:   err.code ?? err.response?.data?.error?.code ?? null,
      message: (err.message || '').slice(0, 300),
    };
  }
}

/**
 * GET /api/msteams-debug/probe
 *
 * One call that answers everything: whether each scope actually works, what a
 * chat row looks like, what a channel row looks like, and — the question that
 * changes code — whether lastMessagePreview is populated and what a real
 * chatMessage contains.
 */
router.get('/probe', async (req, res) => {
  const rawMode = req.query.raw === '1';
  const pseudo  = makePseudonymiser();
  const clean   = (v) => (rawMode ? v : redact(v, pseudo));

  try {
    const conn = await msteams.getConnection(req.orgId, req.userId);
    if (!conn) return res.status(404).json({ error: 'Teams is not connected for this user.' });

    const tok = await msteams.accessTokenFor(conn);
    if (!tok.ok) return res.status(400).json({ error: 'No usable token', code: tok.code });

    const at = tok.accessToken;
    const report = { redacted: !rawMode, generatedAt: new Date().toISOString(), steps: [] };

    // ── 1. Identity ──────────────────────────────────────────────────────
    const me = await attempt('GET /me  [User.Read]', () => graph.getMe(at));
    report.steps.push({ ...me, data: me.ok ? clean(me.data) : undefined });

    // ── 2. Chats ─────────────────────────────────────────────────────────
    const chats = await attempt('GET /me/chats?$expand=lastMessagePreview  [Chat.Read]',
      () => graph.listChats(at));
    let firstChatId = null;

    if (chats.ok) {
      const list = chats.data.chats || [];
      firstChatId = list[0]?.id || null;

      // THE question. If this is zero, triage ordering has to change.
      const withPreview = list.filter(c => c.lastMessagePreview?.createdDateTime).length;

      report.steps.push({
        step: chats.step,
        ok: true,
        summary: {
          total: list.length,
          truncated: chats.data.truncated,
          byChatType: list.reduce((a, c) => {
            a[c.chatType || 'undefined'] = (a[c.chatType || 'undefined'] || 0) + 1; return a;
          }, {}),
          withTopic: list.filter(c => c.topic).length,
          lastMessagePreviewPopulated: `${withPreview} of ${list.length}`,
          fieldsSeen: [...new Set(list.flatMap(c => Object.keys(c)))].sort(),
        },
        sampleRow: list[0] ? clean(list[0]) : null,
      });
    } else {
      report.steps.push(chats);
    }

    // ── 3. Chat messages ─────────────────────────────────────────────────
    if (firstChatId) {
      const msgs = await attempt('GET /chats/{id}/messages?$top=3  [Chat.Read]',
        () => graph.graphGet(at, `/chats/${encodeURIComponent(firstChatId)}/messages?$top=3`));
      report.steps.push({
        ...msgs,
        summary: msgs.ok ? {
          returned: (msgs.data.value || []).length,
          fieldsSeen: [...new Set((msgs.data.value || []).flatMap(m => Object.keys(m)))].sort(),
          messageTypes: [...new Set((msgs.data.value || []).map(m => m.messageType))],
          anyWithAttachments: (msgs.data.value || []).some(m => (m.attachments || []).length),
          anyWithMentions:    (msgs.data.value || []).some(m => (m.mentions || []).length),
          anyEdited:          (msgs.data.value || []).some(m => m.lastEditedDateTime),
        } : undefined,
        data: msgs.ok ? clean((msgs.data.value || []).slice(0, 2)) : undefined,
      });
    }

    // ── 4. Teams ─────────────────────────────────────────────────────────
    const teams = await attempt('GET /me/joinedTeams  [Team.ReadBasic.All]',
      () => graph.listJoinedTeams(at));
    let firstTeamId = null;
    if (teams.ok) {
      firstTeamId = teams.data[0]?.id || null;
      report.steps.push({
        step: teams.step, ok: true,
        summary: { total: teams.data.length },
        sampleRow: teams.data[0] ? clean(teams.data[0]) : null,
      });
    } else {
      report.steps.push(teams);
    }

    // ── 5. Channels ──────────────────────────────────────────────────────
    let firstChannelId = null;
    if (firstTeamId) {
      const chans = await attempt('GET /teams/{id}/channels  [Channel.ReadBasic.All]',
        () => graph.listChannels(at, firstTeamId));
      if (chans.ok) {
        firstChannelId = chans.data[0]?.id || null;
        report.steps.push({
          step: chans.step, ok: true,
          summary: {
            total: chans.data.length,
            membershipTypes: [...new Set(chans.data.map(c => c.membershipType))],
            fieldsSeen: [...new Set(chans.data.flatMap(c => Object.keys(c)))].sort(),
          },
          sampleRow: chans.data[0] ? clean(chans.data[0]) : null,
        });
      } else {
        report.steps.push(chans);
      }
    }

    // ── 6. Channel messages — the scope that is most likely to fail ──────
    if (firstTeamId && firstChannelId) {
      const cm = await attempt('GET /teams/{id}/channels/{id}/messages?$top=3  [ChannelMessage.Read.All]',
        () => graph.graphGet(at,
          `/teams/${encodeURIComponent(firstTeamId)}/channels/${encodeURIComponent(firstChannelId)}/messages?$top=3`));

      report.steps.push({
        ...cm,
        note: cm.ok
          ? 'ChannelMessage.Read.All is granted — channel capture will work.'
          : 'THIS IS THE ADMIN-CONSENT CHECK. A 403 here means channels list but their messages cannot be read; the tenant admin has not granted ChannelMessage.Read.All.',
        summary: cm.ok ? {
          returned: (cm.data.value || []).length,
          fieldsSeen: [...new Set((cm.data.value || []).flatMap(m => Object.keys(m)))].sort(),
          anyWithReplyTo: (cm.data.value || []).some(m => m.replyToId),
          anyWithSubject: (cm.data.value || []).some(m => m.subject),
        } : undefined,
        data: cm.ok ? clean((cm.data.value || []).slice(0, 2)) : undefined,
      });

      // Replies are the attribution mechanism for channels — worth its own look.
      const rootId = cm.ok ? (cm.data.value || []).find(m => !m.replyToId)?.id : null;
      if (rootId) {
        const replies = await attempt('GET /teams/{id}/channels/{id}/messages/{id}/replies?$top=3',
          () => graph.graphGet(at,
            `/teams/${encodeURIComponent(firstTeamId)}/channels/${encodeURIComponent(firstChannelId)}` +
            `/messages/${encodeURIComponent(rootId)}/replies?$top=3`));
        report.steps.push({
          ...replies,
          summary: replies.ok ? {
            returned: (replies.data.value || []).length,
            allCarryReplyToId: (replies.data.value || []).every(m => m.replyToId),
          } : undefined,
          data: replies.ok ? clean((replies.data.value || []).slice(0, 1)) : undefined,
        });
      }
    }

    report.verdict = {
      chatsReadable:           report.steps.find(s => s.step?.includes('/me/chats'))?.ok ?? false,
      chatMessagesReadable:    report.steps.find(s => s.step?.includes('/chats/{id}/messages'))?.ok ?? false,
      channelsListable:        report.steps.find(s => s.step?.includes('/channels  '))?.ok ?? false,
      channelMessagesReadable: report.steps.find(s => s.step?.includes('ChannelMessage.Read.All'))?.ok ?? false,
    };

    res.json(report);
  } catch (err) {
    console.error('[msteams-debug] probe failed:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
