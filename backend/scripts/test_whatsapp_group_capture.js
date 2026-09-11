/**
 * test_whatsapp_group_capture.js
 *
 * The WhatsApp GROUP CAPTURE path, end to end, short of a real handset.
 *
 * WHY THIS EXISTS BESIDE phase1_acceptance.js
 *   phase1_acceptance.js proves the binding rules, and it passes. But its
 *   fixture writes threads and messages straight into the tables, so it never
 *   runs the part a live test depends on first: watch → ingest → thread
 *   creation → sender identity → participant linking → scoping. A live test
 *   with six phones that fails there tells you nothing about binding, and one
 *   that passes there for the wrong reason is worse. This harness covers that
 *   gap so the phone test is only spent on what cannot be simulated.
 *
 * WHAT IS REAL AND WHAT IS NOT
 *   Real:  Baileys 6.7.24's own decodeMessageNode (message keys) and
 *          extractGroupMetadata (rosters), fed synthetic stanzas.
 *          The worker's OWN envelope expression and roster mapper, lifted out
 *          of workers/wa-session-worker.js at run time — not a copy that can
 *          drift from it. If the worker changes, this harness tests the change.
 *          The API's real routers (whatsappSession, whatsappMessages) mounted
 *          on a throwaway express app, with real JWT and worker-secret auth.
 *          The real services and the real database.
 *   Not:   the WhatsApp socket, the Signal layer, the CDN, media upload.
 *          Whether WhatsApp actually sends participant_pn on LID groups is a
 *          property of WhatsApp's servers — only the live test can say.
 *
 * READING THE OUTPUT
 *   PASS / FAIL  — the behaviour the design documents promise.
 *   INFO         — behaviour recorded for a human decision; not pass/fail.
 *   A FAIL tagged [defect] is a finding about the code, not a harness bug.
 *
 * USAGE (a scratch database is strongly preferred)
 *   cd backend
 *   DATABASE_URL=... node scripts/test_whatsapp_group_capture.js
 *   DATABASE_URL=... node scripts/test_whatsapp_group_capture.js --keep       # leave fixture for inspection
 *   DATABASE_URL=... node scripts/test_whatsapp_group_capture.js --teardown   # remove a left-over fixture only
 *
 * SAFETY
 *   Everything hangs off one org named WA_CAPTURE_HARNESS, removed at the end.
 *   Refuses to start if that org already exists. The fixture session is
 *   status 'logged_out' on purpose: the live worker's /internal/claim picks up
 *   pending_qr/connecting/connected/disconnected, and a fixture session in any
 *   of those would make a production worker try to open a socket for it.
 *   (phase1_fixture.sql uses 'connected' and has exactly that exposure.)
 *   Phone numbers use the unassigned +99 prefix so they cannot collide with a
 *   real user's verified number.
 */

'use strict';

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

// Set BEFORE anything loads dotenv: dotenv never overrides an existing value,
// so these win for this process only. Tokens minted here are never valid
// against a running API.
process.env.JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(24).toString('hex');
process.env.WA_SESSION_WORKER_SECRET =
  process.env.WA_SESSION_WORKER_SECRET || crypto.randomBytes(24).toString('hex');

const ROOT = path.join(__dirname, '..');
const { pool } = require(path.join(ROOT, 'config', 'database'));
const express  = require('express');
const jwt      = require('jsonwebtoken');
const baileys  = require('@whiskeysockets/baileys');
// Deep import only after the package index has loaded: groups.js imports
// generics.js, which needs DisconnectReason initialised by the index first.
const { extractGroupMetadata } = require('@whiskeysockets/baileys/lib/Socket/groups.js');

const session     = require(path.join(ROOT, 'services', 'whatsappSession.service'));
const search      = require(path.join(ROOT, 'services', 'whatsappSearch.service'));
const access      = require(path.join(ROOT, 'services', 'whatsappAccess.service'));
const handovers   = require(path.join(ROOT, 'services', 'handover.service'));
const groupCache  = require(path.join(ROOT, 'services', 'whatsapp', 'groupCache'));
const accountRels = require(path.join(ROOT, 'services', 'accountRelationships.service'));

const FIXTURE_ORG = 'WA_CAPTURE_HARNESS';
const ARGS = new Set(process.argv.slice(2));

// ─────────────────────────────────────────────────────────────────────────────
// Reporting
// ─────────────────────────────────────────────────────────────────────────────

let pass = 0, fail = 0;
const lines = [];
const failures = [];
let section = '';

function heading(title) { section = title; lines.push('', `── ${title} ${'─'.repeat(Math.max(0, 70 - title.length))}`); }
function check(name, ok, detail = '') {
  if (ok) { pass++; lines.push(`  PASS  ${name}`); return true; }
  fail++;
  lines.push(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`);
  failures.push(`[${section}] ${name}`);
  return false;
}
function info(name, detail) { lines.push(`  INFO  ${name}${detail ? `\n          ${detail}` : ''}`); }

// ─────────────────────────────────────────────────────────────────────────────
// Lifting code out of the worker
//
// The worker cannot be required: loading it starts the supervisor loop. So the
// two expressions that decide what the API receives are extracted from its
// source and evaluated. A scanner rather than a regex for the object literal,
// because the literal contains comments and nested braces.
// ─────────────────────────────────────────────────────────────────────────────

const WORKER_PATH = path.join(ROOT, 'workers', 'wa-session-worker.js');

function scanBalanced(src, openIdx) {
  const open = src[openIdx];
  const close = open === '{' ? '}' : open === '(' ? ')' : ']';
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && n === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return src.slice(openIdx, i + 1);
  }
  throw new Error(`unbalanced ${open} at ${openIdx}`);
}

function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e - 1; continue; }
    if (c === '/' && n === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const s = i;
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      out += src.slice(s, i + 1);
      continue;
    }
    out += c;
  }
  return out;
}

function liftWorker() {
  const src = fs.readFileSync(WORKER_PATH, 'utf8');

  // The WHOLE messages.upsert handler, not just the envelope literal: the
  // literal reads locals the loop declares (jid), and the loop's own filters —
  // notify-only, groups-only, empty stubs — are part of what reaches the API.
  const sig = "sock.ev.on('messages.upsert', async ({ messages, type }) =>";
  const onAt = src.indexOf(sig);
  if (onAt < 0 || src.indexOf(sig, onAt + 1) >= 0) {
    throw new Error('expected exactly one messages.upsert handler in the worker');
  }
  const handlerBody = scanBalanced(src, src.indexOf('{', onAt + sig.length));
  if (!handlerBody.includes('buffer.push({')) throw new Error('messages.upsert handler no longer calls buffer.push');

  const fnAt = src.indexOf('function extractMediaRef(');
  if (fnAt < 0) throw new Error('extractMediaRef not found in the worker');
  const fnSrc = src.slice(fnAt, src.indexOf('{', fnAt)) + scanBalanced(src, src.indexOf('{', fnAt));
  const extractMediaRef = new Function(`${fnSrc}; return extractMediaRef;`)();

  const handler = new Function('buffer', 'touch', 'sessionId', 'version', 'extractMediaRef',
    `return async ({ messages, type }) => ${handlerBody};`);

  /** Run a messages.upsert event through the worker's handler; return what it buffered. */
  async function upsert(messages, type = 'notify') {
    const pushed = [];
    await handler({ push: (e) => pushed.push(e) }, () => {}, 0, [6, 7, 24], extractMediaRef)({ messages, type });
    return pushed;
  }

  const mappers = [...src.matchAll(/participants:\s*\(\s*\w+\.participants\s*\|\|\s*\[\]\s*\)\.map\(\s*(\w+\s*=>\s*\(\{[^}]*\}\))\s*\)/g)]
    .map(x => x[1].replace(/\s+/g, ' '));
  if (!mappers.length) throw new Error('no roster mapper found in the worker');
  const mapParticipant = new Function(`return (${mappers[0]});`)();

  return {
    upsert,
    mapParticipant,
    mapperCount: mappers.length,
    mappersIdentical: new Set(mappers).size === 1,
    codeOnly: stripComments(src),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic WhatsApp
// ─────────────────────────────────────────────────────────────────────────────

const PHONE = {
  u1: '990000000001', u2: '990000000002', u3: '990000000003', u4: '990000000004',
  u5: '990000000005', u7: '990000000007',
};
const LID = {
  u1: '180000000000001', u2: '180000000000002', u3: '180000000000003',
  u4: '180000000000004', u5: '180000000000005',
};
const pnJid  = (k) => `${PHONE[k]}@s.whatsapp.net`;
const lidJid = (k) => `${LID[k]}@lid`;

const GROUPS = {
  G1: { jid: '120363900000000001@g.us', subject: 'Acme Migration – All',  members: ['u1', 'u2', 'u4', 'u5'] },
  G2: { jid: '120363900000000002@g.us', subject: 'Cloudsmith ↔ Us',       members: ['u1', 'u2', 'u5'] },
  G3: { jid: '120363900000000003@g.us', subject: 'Delivery – Internal',   members: ['u1', 'u2', 'u3'] },
  G4: { jid: '120363900000000004@g.us', subject: 'Weekend Football',      members: ['u1', 'u3'] },
  G5: { jid: '120363900000000005@g.us', subject: 'Claude Rollout Initiative', members: ['u1', 'u2', 'u3'] },
  G6: { jid: '120363900000000006@g.us', subject: 'LID-addressed Delivery', members: ['u1', 'u3'], lid: true },
  G7: { jid: '120363900000000007@g.us', subject: 'Retired Initiative Chatter', members: ['u1', 'u2'] },
  G8: { jid: '120363900000000008@g.us', subject: 'Throwaway for authz',   members: ['u1', 'u2'] },
};

// Wall-clock seconds, never behind the previous message. Rule 2 compares a
// manual filing's handover_tagged_at (now()) with the inbound's own timestamp;
// a synthetic clock an hour in the past made every filing look like it came
// AFTER the next message and silently took it out of the 24h window.
let tsCursor = 0;
let idCursor = 0;
const nextTs = () => (tsCursor = Math.max(tsCursor, Math.floor(Date.now() / 1000)));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * One inbound message as Baileys 6.7.24 hands it to messages.upsert.
 * The KEY comes from Baileys' own decoder so participant / participantPn /
 * fromMe are exactly what the library produces for that stanza.
 */
function waMessage(groupKey, senderKey, content, { id = null } = {}) {
  const g = GROUPS[groupKey];
  const attrs = {
    id: id || `HARNESS${String(++idCursor).padStart(6, '0')}`,
    from: g.jid,
    t: String(nextTs()),
    notify: `User ${senderKey.slice(1)}`,
  };
  if (g.lid) {
    attrs.participant = lidJid(senderKey);
    attrs.participant_pn = pnJid(senderKey);   // best case: WhatsApp supplies the phone
  } else {
    attrs.participant = pnJid(senderKey);
  }
  const { fullMessage } = baileys.decodeMessageNode(
    { tag: 'message', attrs, content: [] },
    pnJid('u1'),       // the capture handset
    lidJid('u1')
  );
  return { ...fullMessage, message: content };
}

const text  = (body) => ({ conversation: body });
const reply = (body, quotedId, quotedSender) => ({
  extendedTextMessage: {
    text: body,
    contextInfo: { stanzaId: quotedId, participant: quotedSender, quotedMessage: { conversation: '…' } },
  },
});
const imageReply = (caption, quotedId, quotedSender) => ({
  imageMessage: {
    caption, mimetype: 'image/jpeg', mediaKey: crypto.randomBytes(32), directPath: '/v/t62/harness',
    fileLength: 1234, fileSha256: crypto.randomBytes(32), fileEncSha256: crypto.randomBytes(32),
    contextInfo: { stanzaId: quotedId, participant: quotedSender, quotedMessage: { conversation: '…' } },
  },
});
const documentMsg = (fileName) => ({
  documentMessage: {
    fileName, mimetype: 'application/pdf', mediaKey: crypto.randomBytes(32), directPath: '/v/t62/harness-doc',
    fileLength: 48213, fileSha256: crypto.randomBytes(32), fileEncSha256: crypto.randomBytes(32),
  },
});
const protocolMsg = () => ({ protocolMessage: { type: 0, key: { id: 'x' } } });

/** The roster payload the worker sends to /internal/group-meta for one group. */
function rosterPayload(worker, groupKey) {
  const g = GROUPS[groupKey];
  const node = {
    tag: 'iq', attrs: {},
    content: [{
      tag: 'group',
      attrs: { id: g.jid.split('@')[0], subject: g.subject, creation: '1780000000', ...(g.lid ? { addressing_mode: 'lid' } : {}) },
      content: g.members.map(k => ({
        tag: 'participant',
        attrs: g.lid ? { jid: lidJid(k), phone_number: pnJid(k) } : { jid: pnJid(k) },
      })),
    }],
  };
  const meta = extractGroupMetadata(node);
  return {
    jid: meta.id.includes('@') ? meta.id : `${meta.id}@g.us`,
    subject: meta.subject,
    owner: meta.owner || null,
    creation: meta.creation || null,
    participants: (meta.participants || []).map(worker.mapParticipant),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP: the real routers on a throwaway app
// ─────────────────────────────────────────────────────────────────────────────

async function startApi() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/whatsapp-session',  require(path.join(ROOT, 'routes', 'whatsappSession.routes')));
  app.use('/api/whatsapp-messages', require(path.join(ROOT, 'routes', 'whatsappMessages.routes')));
  const server = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, url, { token = null, worker = false, body = undefined } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (token)  headers.authorization = `Bearer ${token}`;
    if (worker) headers.authorization = `Bearer ${process.env.WA_SESSION_WORKER_SECRET}`;
    const r = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null;
    try { data = await r.json(); } catch { /* empty body */ }
    return { status: r.status, data };
  }
  return { server, call };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture
// ─────────────────────────────────────────────────────────────────────────────

async function teardown() {
  const { rows: [o] } = await pool.query(`SELECT id FROM organizations WHERE name = $1`, [FIXTURE_ORG]);
  if (!o) return false;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // Children first. Several of these reference organizations without
    // ON DELETE CASCADE, which is why phase1_teardown.sql is written out too.
    for (const t of [
      'conversation_project_candidates', 'conversation_bindings',
      'whatsapp_session_group_members', 'whatsapp_messages', 'whatsapp_thread_participants',
      'whatsapp_session_groups', 'whatsapp_threads', 'whatsapp_capture_requests', 'whatsapp_sessions',
      'communication_stewards', 'project_contacts', 'project_members', 'account_relationships',
    ]) {
      await c.query(`DELETE FROM ${t} WHERE org_id = $1`, [o.id]);
    }
    await c.query(`DELETE FROM sales_handovers WHERE org_id = $1`, [o.id]);
    await c.query(`DELETE FROM contacts WHERE org_id = $1`, [o.id]);
    await c.query(`DELETE FROM accounts WHERE org_id = $1`, [o.id]);
    await c.query(`DELETE FROM users WHERE org_id = $1`, [o.id]);
    await c.query(`DELETE FROM organizations WHERE id = $1`, [o.id]);
    await c.query('COMMIT');
    return true;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

async function seed() {
  const c = await pool.connect();
  const ID = {};
  const one = async (sql, params) => (await c.query(sql, params)).rows[0].id;
  try {
    await c.query('BEGIN');
    ID.org = await one(`INSERT INTO organizations (name, slug) VALUES ($1, 'wa-capture-harness') RETURNING id`, [FIXTURE_ORG]);

    const user = (k, first, role) => one(
      `INSERT INTO users (org_id, email, first_name, last_name, role, password_hash)
       VALUES ($1, $2, $3, 'Harness', $4, 'x') RETURNING id`,
      [ID.org, `wa-harness-${k}@example.invalid`, first, role]);
    ID.u1 = await user('u1', 'Handset', 'user');     // connects the session → steward implicitly
    ID.u2 = await user('u2', 'Lead', 'admin');       // delivery lead, does the binding
    ID.u3 = await user('u3', 'Engineer', 'user');    // the scoping test
    ID.u6 = await user('u6', 'Outsider', 'user');    // in no groups, on no projects
    ID.u7 = await user('u7', 'Claimer', 'user');     // self-claimed phone, never verified

    ID.meridian   = await one(`INSERT INTO accounts (org_id, name) VALUES ($1, 'Meridian (harness)') RETURNING id`, [ID.org]);
    ID.cloudsmith = await one(`INSERT INTO accounts (org_id, name) VALUES ($1, 'Cloudsmith (harness)') RETURNING id`, [ID.org]);
    await c.query(
      `INSERT INTO account_relationships (org_id, account_id, relationship, status, approved_by, approved_at)
       VALUES ($1, $2, 'vendor', 'active', $3, now())`, [ID.org, ID.cloudsmith, ID.u2]);

    const project = (name, extra) => one(
      `INSERT INTO sales_handovers (org_id, name, status, created_by, ${Object.keys(extra).join(', ')})
       VALUES ($1, $2, 'in_progress', $3, ${Object.keys(extra).map((_, i) => `$${i + 4}`).join(', ')}) RETURNING id`,
      [ID.org, name, ID.u2, ...Object.values(extra)]);
    ID.p1 = await project('P1 Acme Migration (harness)', { project_kind: 'customer', account_id: ID.meridian });
    ID.p2 = await project('P2 Cutover (harness)',        { project_kind: 'customer', account_id: ID.meridian });
    ID.init = await project('Claude Rollout (harness initiative)', { project_kind: 'internal', tracking_mode: 'standing' });
    ID.initRetired = await project('Old Initiative (harness, retired)', {
      project_kind: 'internal', tracking_mode: 'standing', retired_at: new Date(), retired_by: ID.u2,
    });

    const contact = (acct, first, phone) => one(
      `INSERT INTO contacts (org_id, account_id, first_name, last_name, phone) VALUES ($1,$2,$3,'Harness',$4) RETURNING id`,
      [ID.org, acct, first, phone]);
    ID.c4 = await contact(ID.meridian, 'Customer', PHONE.u4);
    ID.c5 = await contact(ID.cloudsmith, 'Vendor', PHONE.u5);
    const pc = (h, contactId, side) => c.query(
      `INSERT INTO project_contacts (org_id, context_type, context_id, contact_id, side, role)
       VALUES ($1, 'handover', $2, $3, $4, 'other')`, [ID.org, h, contactId, side]);
    await pc(ID.p1, ID.c4, 'customer');
    await pc(ID.p1, ID.c5, 'vendor');
    await pc(ID.p2, ID.c5, 'vendor');
    await pc(ID.initRetired, ID.c5, 'vendor');   // a vendor who was on a now-retired initiative

    for (const h of [ID.p1, ID.p2, ID.init]) {
      for (const u of [ID.u2, ID.u3]) {
        await c.query(
          `INSERT INTO project_members (org_id, context_type, context_id, user_id, status, side)
           VALUES ($1, 'handover', $2, $3, 'approved', 'delivery')`, [ID.org, h, u]);
      }
    }

    ID.session = await one(
      `INSERT INTO whatsapp_sessions (org_id, label, status, capture_enabled, capture_mode, capture_media, wa_phone, created_by)
       VALUES ($1, 'harness session', 'logged_out', true, 'allowlist', false, $2, $3) RETURNING id`,
      [ID.org, PHONE.u1, ID.u1]);

    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }

  // Through the real identity path, after COMMIT, because it opens its own
  // transaction. 'admin' source = verified; 'self_claimed' = not.
  for (const [k, src] of [['u2', 'admin'], ['u3', 'admin'], ['u7', 'self_claimed']]) {
    const r = await access.setUserWhatsAppPhone(ID.org, ID.u2, ID[k], PHONE[k], { source: src });
    if (!r.ok) throw new Error(`could not set phone for ${k}: ${JSON.stringify(r)}`);
  }
  return ID;
}

// ─────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────

const q1 = async (sql, p) => (await pool.query(sql, p)).rows[0];
const qn = async (sql, p) => (await pool.query(sql, p)).rows;

const groupRow = (org, jid) => q1(`SELECT * FROM whatsapp_session_groups WHERE org_id = $1 AND group_jid = $2`, [org, jid]);
const threadRow = (org, jid) => q1(`SELECT * FROM whatsapp_threads WHERE org_id = $1 AND wa_group_id = $2`, [org, jid]);
const msgByWamid = (org, wamid) => q1(`SELECT * FROM whatsapp_messages WHERE org_id = $1 AND wa_message_id = $2`, [org, wamid]);
const countMsgs = async (org, jid, extra = '') => Number((await q1(
  `SELECT count(*) AS n FROM whatsapp_messages m JOIN whatsapp_threads t ON t.id = m.thread_id
    WHERE m.org_id = $1 AND t.wa_group_id = $2 ${extra}`, [org, jid])).n);

// ─────────────────────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────────────────────

async function run() {
  const worker = liftWorker();
  const api = await startApi();
  const { call } = api;
  const ID = await seed();
  const org = ID.org;
  const tok = (k) => jwt.sign({ userId: ID[k], org_id: org }, process.env.JWT_SECRET, { expiresIn: '10m' });

  /** Push messages through the worker's handler and the worker's endpoint. */
  async function send(...msgs) {
    const envelopes = await worker.upsert(msgs);
    if (envelopes.length !== msgs.length) throw new Error(`worker buffered ${envelopes.length} of ${msgs.length}`);
    const r = await call('POST', '/api/whatsapp-session/internal/messages', {
      worker: true, body: { sessionId: ID.session, messages: envelopes },
    });
    if (r.status !== 200) throw new Error(`ingest HTTP ${r.status}: ${JSON.stringify(r.data)}`);
    return r.data.results;
  }
  const sendOne = async (m) => (await send(m))[0];

  try {
    // ── 0. The harness is testing the real worker ──────────────────────────
    heading('0  Harness preconditions');
    check('0a worker messages.upsert handler lifted from wa-session-worker.js', typeof worker.upsert === 'function');
    const probeGroup = waMessage('G1', 'u2', text('probe'));
    const direct = { ...probeGroup, key: { ...probeGroup.key, remoteJid: `${PHONE.u2}@s.whatsapp.net` } };
    check('0a2 worker buffers a live group message', (await worker.upsert([probeGroup])).length === 1);
    check('0a3 worker drops a 1:1 message', (await worker.upsert([direct])).length === 0);
    check("0a4 worker drops history replay (type 'append')", (await worker.upsert([probeGroup], 'append')).length === 0);
    check('0b worker roster mapper lifted', worker.mapperCount >= 1, `found ${worker.mapperCount}`);
    check('0c all roster mappers in the worker are identical', worker.mappersIdentical);
    check('0d worker has no send path (sock.sendMessage absent from code)',
          !/\bsendMessage\s*\(/.test(worker.codeOnly));
    const probeKey = waMessage('G6', 'u3', text('probe')).key;
    info('Baileys 6.7.24 key for a LID-addressed group message',
         JSON.stringify({ participant: probeKey.participant, participantPn: probeKey.participantPn }));
    idCursor = 0;

    // ── A. Capture gate ────────────────────────────────────────────────────
    heading('A  Capture gate (allowlist)');

    // The live snapshot a steward's triage screen would trigger. Names go to
    // memory only; undecided groups must not reach Postgres.
    const snap = Object.keys(GROUPS).map(k => ({ ...rosterPayload(worker, k), via: 'snapshot' }));
    const rs = await call('POST', '/api/whatsapp-session/internal/group-snapshot', {
      worker: true, body: { sessionId: ID.session, groups: snap },
    });
    check('A0 snapshot accepted and cached', rs.status === 200 && rs.data.cached === snap.length, JSON.stringify(rs.data));
    check('A0b snapshot persisted ZERO group rows',
          Number((await q1(`SELECT count(*) n FROM whatsapp_session_groups WHERE org_id = $1`, [org])).n) === 0);

    const r4 = await sendOne(waMessage('G4', 'u3', text('who is in for Sunday?')));
    check('A1 unwatched group is refused', r4.stored === false && r4.reason === 'NOT_WATCHED', JSON.stringify(r4));
    check('A1b no group row, no thread, no message for it',
          !(await groupRow(org, GROUPS.G4.jid)) && !(await threadRow(org, GROUPS.G4.jid)));

    // The old smoke-test plan's Step 1: talk first, switch capture on later.
    const early = await sendOne(waMessage('G1', 'u2', text('Kickoff: migration window agreed')));
    check('A2 a message sent BEFORE capture is switched on is not stored',
          early.stored === false && early.reason === 'NOT_WATCHED');

    const w = await call('POST', '/api/whatsapp-session/triage/watch-jid', {
      token: tok('u2'), body: { jids: [GROUPS.G1.jid, GROUPS.G2.jid, GROUPS.G3.jid, GROUPS.G5.jid, GROUPS.G6.jid, GROUPS.G7.jid, GROUPS.G8.jid], watched: true },
    });
    check('A3 steward switches capture on by JID', w.status === 200 && w.data.updated === 7, JSON.stringify(w.data));
    const g1 = await groupRow(org, GROUPS.G1.jid);
    check('A3b row created, watched, subject taken from the snapshot',
          g1 && g1.is_watched && g1.subject === GROUPS.G1.subject, JSON.stringify(g1 && { w: g1.is_watched, s: g1.subject }));
    check('A3c no thread yet — nothing has been said since', g1 && g1.thread_id === null);

    const b0 = await call('POST', `/api/whatsapp-session/triage/${g1.id}/bind`, {
      token: tok('u2'), body: { mode: 'project', handoverId: ID.p1 },
    });
    check('A4 binding before any captured message is refused (NO_THREAD)',
          b0.status === 400 && b0.data.code === 'NO_THREAD', JSON.stringify(b0.data));

    const m1 = waMessage('G1', 'u2', text('Cutover window for Acme is Thursday'));
    const r1 = await sendOne(m1);
    const t1 = await threadRow(org, GROUPS.G1.jid);
    check('A5 first message after watch is stored', r1.stored === true, JSON.stringify(r1));
    check('A5b thread created as a session group', t1 && t1.kind === 'group' && t1.source === 'session');
    check('A5c group row now points at the thread', (await groupRow(org, GROUPS.G1.jid)).thread_id === t1.id);
    const row1 = await msgByWamid(org, m1.key.id);
    check('A5d row: capture_source session, inbound, received',
          row1.capture_source === 'session' && row1.direction === 'inbound' && row1.status === 'received');

    const dup = await sendOne(m1);
    check('A6 redelivery is a DUPLICATE, not a second row',
          dup.stored === false && dup.reason === 'DUPLICATE' && (await countMsgs(org, GROUPS.G1.jid)) === 1);
    check('A6b message_count not double-counted', (await groupRow(org, GROUPS.G1.jid)).message_count === 1);

    const rp = await sendOne(waMessage('G1', 'u2', protocolMsg()));
    check('A7 protocol message skipped', rp.stored === false && rp.reason === 'PROTOCOL_MESSAGE');

    const mMe = waMessage('G1', 'u1', text('Noted, sharing the runbook shortly'));
    check('A8a Baileys marks the handset\'s own message fromMe', mMe.key.fromMe === true);
    await sendOne(mMe);
    const rowMe = await msgByWamid(org, mMe.key.id);
    check('A8b handset message stored outbound / sent', rowMe.direction === 'outbound' && rowMe.status === 'sent');

    await pool.query(`UPDATE whatsapp_sessions SET capture_enabled = false WHERE id = $1`, [ID.session]);
    const rOff = await sendOne(waMessage('G1', 'u4', text('while capture is off')));
    await pool.query(`UPDATE whatsapp_sessions SET capture_enabled = true WHERE id = $1`, [ID.session]);
    check('A9 session capture switch off → CAPTURE_DISABLED', rOff.reason === 'CAPTURE_DISABLED');

    // ── B. Identity on a phone-addressed group ─────────────────────────────
    heading('B  Sender identity and roster (phone-addressed groups)');
    check('B1 from_phone is the sender\'s real number', row1.from_phone === PHONE.u2, row1.from_phone);
    const part = async (jid, phone) => q1(
      `SELECT p.* FROM whatsapp_thread_participants p JOIN whatsapp_threads t ON t.id = p.thread_id
        WHERE t.org_id = $1 AND t.wa_group_id = $2 AND p.wa_phone = $3`, [org, jid, phone]);
    const pU2 = await part(GROUPS.G1.jid, PHONE.u2);
    check('B2 verified user linked on first message (user_id, side internal)',
          pU2 && pU2.user_id === ID.u2 && pU2.side === 'internal', JSON.stringify(pU2 && { u: pU2.user_id, s: pU2.side }));

    const m4 = waMessage('G1', 'u4', text('Customer side: we need the rollback plan'));
    await sendOne(m4);
    const pU4 = await part(GROUPS.G1.jid, PHONE.u4);
    check('B3 customer contact recorded as a participant, not linked to a user',
          pU4 && pU4.user_id === null && pU4.side === 'customer');

    await sendOne(waMessage('G8', 'u2', text('throwaway opener')));
    await pool.query(
      `INSERT INTO whatsapp_thread_participants (thread_id, org_id, wa_phone, side, joined_at)
       SELECT id, org_id, $2, 'customer', now() FROM whatsapp_threads WHERE org_id = $1 AND wa_group_id = $3`,
      [org, PHONE.u7, GROUPS.G8.jid]);
    await access.linkParticipantIfKnown(org, (await threadRow(org, GROUPS.G8.jid)).id, PHONE.u7);
    const pU7 = await part(GROUPS.G8.jid, PHONE.u7);
    check('B4 a SELF-CLAIMED number is never linked', pU7 && pU7.user_id === null);

    // Roster sync for a watched group whose members have not all spoken.
    await sendOne(waMessage('G5', 'u2', text('Initiative: Claude rollout, week 1 plan')));
    const gm = await call('POST', '/api/whatsapp-session/internal/group-meta', {
      worker: true, body: { sessionId: ID.session, groups: [rosterPayload(worker, 'G5')] },
    });
    check('B5 roster update accepted', gm.status === 200);
    const g5 = await groupRow(org, GROUPS.G5.jid);
    const members5 = (await qn(`SELECT user_id FROM whatsapp_session_group_members WHERE session_group_id = $1 AND left_at IS NULL`, [g5.id])).map(r => r.user_id).sort();
    check('B5b roster links the verified users (u2, u3) and nobody else',
          JSON.stringify(members5) === JSON.stringify([ID.u2, ID.u3].sort()), JSON.stringify(members5));
    const pU3g5 = await part(GROUPS.G5.jid, PHONE.u3);
    check('B5c a silent member gets a linked participant row from the roster',
          pU3g5 && pU3g5.user_id === ID.u3);
    const pSelf = await part(GROUPS.G5.jid, PHONE.u1);
    check('B5d the handset itself is recorded as internal', pSelf && pSelf.side === 'internal');

    // ── C. Attribution — binding shapes and the handover_source paths ──────
    heading('C  Binding shapes and attribution');

    // History in each group BEFORE binding — the ordering the old plan wanted,
    // now possible because capture was switched on first.
    const g2msgs = [
      waMessage('G2', 'u5', text('Cutover window for Acme is Thursday, confirm?')),
      waMessage('G2', 'u2', text('Confirmed for Acme')),
      waMessage('G2', 'u5', text('Separate question on the Cutover project firewall rules')),
      waMessage('G2', 'u2', text('Will check with the network team')),
    ];
    const g2doc = waMessage('G2', 'u5', documentMsg('cloudsmith-sow.pdf'));
    await send(...g2msgs, g2doc);
    const g3early = [
      waMessage('G3', 'u2', text('Acme: runbook v2 uploaded')),
      waMessage('G3', 'u2', text('Cutover: dry run on Saturday')),
      waMessage('G3', 'u2', text('Both: status call moved to 4pm')),
    ];
    await send(...g3early);

    const unassignedG1 = await countMsgs(org, GROUPS.G1.jid, 'AND m.handover_id IS NULL');
    const bG1 = await call('POST', `/api/whatsapp-session/triage/${g1.id}/bind`, {
      token: tok('u2'), body: { mode: 'project', handoverId: ID.p1 },
    });
    check('C1 G1 binds to P1', bG1.status === 200 && bG1.data.ok, JSON.stringify(bG1.data));
    check('C1b back-fill = every previously captured G1 message', bG1.data.backfilled === unassignedG1,
          `backfilled=${bG1.data.backfilled} expected=${unassignedG1}`);
    check('C1c back-filled rows carry handover_source=thread',
          (await countMsgs(org, GROUPS.G1.jid, `AND (m.handover_id <> ${ID.p1} OR m.handover_source <> 'thread')`)) === 0);
    check("C1d binding_status 'bound'", (await groupRow(org, GROUPS.G1.jid)).binding_status === 'bound');

    // recent_outbound: the handset spoke in the last 24h, so rule 2 fires.
    const mOut = waMessage('G1', 'u1', text('Runbook attached above'));
    const mAfterOut = waMessage('G1', 'u4', text('Thanks, reviewing'));
    await send(mOut, mAfterOut);
    const rowAfterOut = await msgByWamid(org, mAfterOut.key.id);
    check('C2 new G1 message lands on P1', rowAfterOut.handover_id === ID.p1);
    check("C2b …via 'recent_outbound' (the handset's own message counts as outbound)",
          rowAfterOut.handover_source === 'recent_outbound', rowAfterOut.handover_source);

    const g2 = await groupRow(org, GROUPS.G2.jid);
    const bG2 = await call('POST', `/api/whatsapp-session/triage/${g2.id}/bind`, {
      token: tok('u2'), body: { mode: 'account', accountId: ID.cloudsmith },
    });
    check('C3 G2 binds to Cloudsmith as an account', bG2.status === 200 && bG2.data.ok, JSON.stringify(bG2.data));
    check('C3b ZERO back-filled', bG2.data.backfilled === 0);
    check('C3c thread carries no project', (await threadRow(org, GROUPS.G2.jid)).handover_id === null);
    const cands = (await qn(
      `SELECT cc.handover_id FROM conversation_project_candidates cc WHERE cc.binding_id = $1`, [bG2.data.bindingId]))
      .map(r => r.handover_id);
    check('C3d candidates include P1 and P2', cands.includes(ID.p1) && cands.includes(ID.p2), JSON.stringify(cands));
    check('C3e [defect] a RETIRED initiative is not a candidate', !cands.includes(ID.initRetired),
          `candidates=${JSON.stringify(cands)} — projectsForRelationship filters status but not retired_at`);
    check('C3f every G2 message still unassigned',
          (await countMsgs(org, GROUPS.G2.jid, 'AND m.handover_id IS NOT NULL')) === 0);

    const g3 = await groupRow(org, GROUPS.G3.jid);
    const bG3 = await call('POST', `/api/whatsapp-session/triage/${g3.id}/bind`, {
      token: tok('u2'), body: { mode: 'pool', candidateIds: [ID.p1, ID.p2] },
    });
    check('C4 G3 binds as a pool of P1 + P2, zero back-filled',
          bG3.status === 200 && bG3.data.candidates === 2 && bG3.data.backfilled === 0, JSON.stringify(bG3.data));

    const mG2new = waMessage('G2', 'u5', text('Also: invoice for March attached next week'));
    await sendOne(mG2new);
    const rowG2new = await msgByWamid(org, mG2new.key.id);
    check('C5 a new plain message in the vendor group lands UNASSIGNED with no source',
          rowG2new.handover_id === null && rowG2new.handover_source === null);

    const firewall = await msgByWamid(org, g2msgs[2].key.id);
    const fl = await call('POST', `/api/whatsapp-messages/${firewall.id}/file`, {
      token: tok('u2'), body: { handoverId: ID.p2 },
    });
    const firewallAfter = await msgByWamid(org, g2msgs[2].key.id);
    check('C6 a steward files a vendor-group message to P2', fl.status === 200 && fl.data.ok, JSON.stringify(fl.data));
    check("C6b …stamped 'manual' with who and when",
          firewallAfter.handover_id === ID.p2 && firewallAfter.handover_source === 'manual'
          && firewallAfter.handover_tagged_by === ID.u2 && firewallAfter.handover_tagged_at);

    const mQuote = waMessage('G2', 'u2', reply('Firewall rules approved', g2msgs[2].key.id, pnJid('u5')));
    await sendOne(mQuote);
    const rowQuote = await msgByWamid(org, mQuote.key.id);
    check("C7 a quoted reply inherits P2 via 'reply_context'",
          rowQuote.handover_id === ID.p2 && rowQuote.handover_source === 'reply_context',
          `${rowQuote.handover_id}/${rowQuote.handover_source}`);

    const mImgQuote = waMessage('G2', 'u5', imageReply('Here is the rule sheet', g2msgs[2].key.id, pnJid('u2')));
    await sendOne(mImgQuote);
    const rowImgQuote = await msgByWamid(org, mImgQuote.key.id);
    check('C7b [defect] a reply carrying an IMAGE also inherits via reply_context',
          rowImgQuote.handover_id === ID.p2,
          `got ${rowImgQuote.handover_id}/${rowImgQuote.handover_source}; worker reads quotedMessageId only from extendedTextMessage.contextInfo`);

    const mAfterManual = waMessage('G2', 'u5', text('Unrelated: Acme access badges'));
    await sendOne(mAfterManual);
    check('C8 in an entity group a manual filing does NOT steer the next message',
          (await msgByWamid(org, mAfterManual.key.id)).handover_id === null);

    // manual_recent inside a PROJECT group: design question, recorded not judged.
    const strayP2 = waMessage('G1', 'u2', text('(for Cutover) firewall change approved'));
    await sendOne(strayP2);
    const strayRow = await msgByWamid(org, strayP2.key.id);
    await sleep(1100);   // the filing happens after the outbound, in wall time
    const fStray = await call('POST', `/api/whatsapp-messages/${strayRow.id}/file`, { token: tok('u2'), body: { handoverId: ID.p2 } });
    check('C9a the stray message is filed to P2', fStray.status === 200 && fStray.data.ok, JSON.stringify(fStray.data));
    await sleep(1100);   // and the next message arrives after the filing
    const nextG1 = waMessage('G1', 'u4', text('Acme: can we get the rollback plan by Friday?'));
    await sendOne(nextG1);
    const nextG1Row = await msgByWamid(org, nextG1.key.id);
    info('C9 project group: one message filed to P2, then an ordinary Acme message arrives',
         `landed on ${nextG1Row.handover_id === ID.p1 ? 'P1' : nextG1Row.handover_id === ID.p2 ? 'P2' : nextG1Row.handover_id} via '${nextG1Row.handover_source}' — rule 2 treats one filed message as steering the whole group for 24h`);

    const sendRows = Number((await q1(
      `SELECT count(*) n FROM whatsapp_messages WHERE org_id = $1 AND handover_source = 'send'`, [org])).n);
    info("C10 handover_source 'send'", `${sendRows} rows — unreachable for session groups: the worker never sends`);

    // Force paths, through the route (409 contract).
    const f1 = await call('POST', `/api/whatsapp-session/triage/${g1.id}/bind`, {
      token: tok('u2'), body: { mode: 'account', accountId: ID.cloudsmith },
    });
    check('C11 project → account without force is refused with 409 NEEDS_FORCE',
          f1.status === 409 && f1.data.code === 'NEEDS_FORCE', JSON.stringify(f1.data));
    const filedBefore = await countMsgs(org, GROUPS.G1.jid, 'AND m.handover_id IS NOT NULL');
    const f2 = await call('POST', `/api/whatsapp-session/triage/${g1.id}/bind`, {
      token: tok('u2'), body: { mode: 'account', accountId: ID.cloudsmith, force: true },
    });
    check('C11b with force: thread project cleared',
          f2.status === 200 && (await threadRow(org, GROUPS.G1.jid)).handover_id === null);
    check('C11c already-filed G1 messages KEEP their project',
          (await countMsgs(org, GROUPS.G1.jid, 'AND m.handover_id IS NOT NULL')) === filedBefore);
    const whileEntity = waMessage('G1', 'u5', text('vendor chatter while G1 is account-bound'));
    await sendOne(whileEntity);
    const f3 = await call('POST', `/api/whatsapp-session/triage/${g1.id}/bind`, {
      token: tok('u2'), body: { mode: 'project', handoverId: ID.p1, force: true },
    });
    check('C11d account → project with force: backfillSuppressed, backfilled 0',
          f3.status === 200 && f3.data.backfillSuppressed === true && f3.data.backfilled === 0, JSON.stringify(f3.data));
    check('C11e the message captured in between stays unassigned',
          (await msgByWamid(org, whileEntity.key.id)).handover_id === null);

    // ── D. Initiatives ─────────────────────────────────────────────────────
    heading('D  Initiatives (standing, internal — no deal, no account)');
    await send(waMessage('G5', 'u3', text('Prompt library draft is in the shared drive')),
               waMessage('G5', 'u2', text('Reviewing it tomorrow')));
    const g5count = await countMsgs(org, GROUPS.G5.jid);
    const bG5 = await session.bindGroup(org, ID.u2, g5.id, { mode: 'project', handoverId: ID.init });
    check('D1 a group binds to a standing initiative', bG5.ok && bG5.backfilled === g5count, JSON.stringify(bG5));
    const g5new = waMessage('G5', 'u3', text('Week 2: rollout to the Data team'));
    await sendOne(g5new);
    check('D2 new initiative-group traffic lands on the initiative',
          (await msgByWamid(org, g5new.key.id)).handover_id === ID.init);
    const commsInit = await handovers.getCommunications(ID.init, org);
    const waInit = commsInit.items.filter(i => i.channel === 'whatsapp').length;
    check('D3 Communications tab of the initiative shows every G5 message (null deal path)',
          waInit === g5count + 1, `tab=${waInit} expected=${g5count + 1}`);

    await sendOne(waMessage('G7', 'u2', text('Anything left on the old initiative?')));
    const g7 = await groupRow(org, GROUPS.G7.jid);
    const bRet = await session.bindGroup(org, ID.u2, g7.id, { mode: 'project', handoverId: ID.initRetired });
    check('D4 [defect] a RETIRED initiative is refused as a bind target', !bRet.ok,
          `bind returned ok=${bRet.ok}; bindGroup checks existence only`);

    // ── H. Attachments at ingest ───────────────────────────────────────────
    heading('H  Attachments (ingest decision only — no upload)');
    const docRow = await msgByWamid(org, g2doc.key.id);
    check('H1 document recorded with a session media descriptor', docRow.media_source === 'session' && !!docRow.session_media_ref);
    check("H1b session media off + policy inherit → 'skipped' with a reason",
          docRow.media_status === 'skipped' && /off for this WhatsApp session/.test(docRow.media_error || ''),
          `${docRow.media_status}: ${docRow.media_error}`);
    const mp = await call('POST', '/api/whatsapp-session/triage/media-policy', {
      token: tok('u2'), body: { groupIds: [g2.id], policy: 'documents' },
    });
    check("H2 switching the group to 'documents' requeues it", mp.status === 200 && mp.data.requeued >= 1, JSON.stringify(mp.data));
    check("H2b …status now 'pending'", (await msgByWamid(org, g2doc.key.id)).media_status === 'pending');

    // ── E. Scoping and authorisation ───────────────────────────────────────
    heading('E  Scoping and authorisation');

    // G3: u2 spoke first (above). Now u3 speaks for the first time.
    const u3first = waMessage('G3', 'u3', text('Picked up the Saturday dry run'));
    await sendOne(u3first);

    const t3 = await session.listTriage(org, { userId: ID.u3 });
    const t3subjects = t3.groups.map(g => g.subject).sort();
    check('E1 plain user sees only the groups they are in (G3, G5)',
          JSON.stringify(t3subjects) === JSON.stringify([GROUPS.G3.subject, GROUPS.G5.subject].sort()),
          JSON.stringify(t3subjects));
    check('E1b header counts match the scoped list', t3.scoped && t3.counts.total === t3.groups.length,
          JSON.stringify(t3.counts));
    const t6 = await session.listTriage(org, { userId: ID.u6 });
    check('E2 a user in no groups sees zero, counts zero', t6.groups.length === 0 && t6.counts.total === 0);
    const stored = Number((await q1(`SELECT count(*) n FROM whatsapp_session_groups WHERE org_id = $1`, [org])).n);
    const t2 = await session.listTriage(org, { userId: ID.u2 });
    check('E3 admin sees every stored group, unscoped', !t2.scoped && t2.groups.length === stored);
    const tOwner = await session.listTriage(org, { userId: ID.u1 });
    check('E4 the user who connected the session is a steward', !tOwner.scoped && tOwner.groups.length === stored);

    const triageU3 = await call('GET', '/api/whatsapp-session/triage', { token: tok('u3') });
    check('E5 non-steward gets no live snapshot and canTriage=false',
          triageU3.status === 200 && triageU3.data.canTriage === false
          && triageU3.data.groups.every(g => g.persisted !== false),
          JSON.stringify({ canTriage: triageU3.data?.canTriage, n: triageU3.data?.groups?.length }));

    const s3 = await search.searchMessages(org, ID.u3, { groupJid: GROUPS.G3.jid, scope: 'participant', limit: 100 });
    const g3total = await countMsgs(org, GROUPS.G3.jid);
    check('E6 [defect] a member sees the group history from before they first spoke',
          s3.ok && s3.messages.length === g3total,
          `u3 sees ${s3.messages?.length} of ${g3total}; joined_at = when GoWarm first saw them, not when they joined`);

    const g8 = await groupRow(org, GROUPS.G8.jid);
    const z1 = await call('POST', `/api/whatsapp-session/triage/${g8.id}/bind`, {
      token: tok('u6'), body: { mode: 'project', handoverId: ID.p1 },
    });
    check('E7 [defect] a user with no steward role and no project cannot bind a group',
          z1.status === 403, `HTTP ${z1.status} ${JSON.stringify(z1.data?.ok)}`);
    const z2 = await call('POST', `/api/whatsapp-session/triage/${g8.id}/ignore`, { token: tok('u6'), body: {} });
    check('E7b [defect] …nor ignore one', z2.status === 403, `HTTP ${z2.status}`);
    const z3 = await call('POST', '/api/whatsapp-session/triage/media-policy', {
      token: tok('u6'), body: { groupIds: [g2.id], policy: 'all' },
    });
    check('E7c [defect] …nor change a group\'s attachment policy', z3.status === 403, `HTTP ${z3.status}`);
    // Restore anything the unauthorised calls changed, so later checks read clean.
    await pool.query(`UPDATE whatsapp_session_groups SET binding_status = 'unbound' WHERE org_id = $1 AND id = $2`, [org, g8.id]);
    await pool.query(`UPDATE whatsapp_session_groups SET binding_status = 'bound_account', media_policy = 'documents' WHERE org_id = $1 AND id = $2`, [org, g2.id]);
    await pool.query(`DELETE FROM conversation_bindings WHERE org_id = $1 AND thread_ref = $2`, [org, GROUPS.G8.jid]);
    await pool.query(`UPDATE whatsapp_threads SET handover_id = NULL WHERE org_id = $1 AND wa_group_id = $2`, [org, GROUPS.G8.jid]);

    // ── F. Read side ───────────────────────────────────────────────────────
    heading('F  What a project shows');
    const commsP1 = await handovers.getCommunications(ID.p1, org);
    const p1ids = new Set(commsP1.items.filter(i => i.channel === 'whatsapp').map(i => Number(i.id.slice(3))));
    const g2rowIds = (await qn(`SELECT m.id FROM whatsapp_messages m JOIN whatsapp_threads t ON t.id = m.thread_id
                                 WHERE m.org_id = $1 AND t.wa_group_id = $2 AND m.handover_id IS NULL`, [org, GROUPS.G2.jid])).map(r => r.id);
    check('F1 P1 shows its G1 messages', (await msgByWamid(org, m1.key.id)) && p1ids.has((await msgByWamid(org, m1.key.id)).id));
    check('F1b P1 shows none of the unassigned vendor-group traffic', g2rowIds.every(id => !p1ids.has(id)));
    const commsP2 = await handovers.getCommunications(ID.p2, org);
    check('F2 the filed vendor message appears on P2',
          commsP2.items.some(i => i.id === `wa-${firewallAfter.id}`));

    const panel = await accountRels.listConversationsForAccount(org, ID.u2, ID.cloudsmith, []);
    const panelG2 = panel.conversations.find(cv => cv.threadRef === GROUPS.G2.jid);
    const g2unassigned = await countMsgs(org, GROUPS.G2.jid, 'AND m.handover_id IS NULL AND m.excluded_at IS NULL');
    check('F4 vendor panel lists the Cloudsmith group', !!panelG2, JSON.stringify(panel.conversations.map(cv => cv.subject)));
    check('F4b …with its unassigned count and a link to the filing queue',
          panelG2 && panelG2.unassignedCount === g2unassigned && /filter=unassigned/.test(panelG2.resolveHref),
          `panel=${panelG2?.unassignedCount} db=${g2unassigned}`);
    check('F4c the project-bound and pool groups are NOT on the vendor panel',
          !panel.conversations.some(cv => [GROUPS.G1.jid, GROUPS.G3.jid].includes(cv.threadRef)));

    const ex = await search.excludeMessage(org, ID.u2, row1.id, 'harness: sensitive');
    const commsP1b = await handovers.getCommunications(ID.p1, org);
    check('F3 excluding a message succeeds', ex.ok, JSON.stringify(ex));
    check('F3b [defect] an EXCLUDED message disappears from the Communications tab',
          !commsP1b.items.some(i => i.id === `wa-${row1.id}`),
          'getCommunications filters excluded_at for Teams but not for WhatsApp');

    // ── G. Lifecycle ───────────────────────────────────────────────────────
    heading('G  Lifecycle');
    const ig = await session.ignoreGroup(org, ID.u2, g8.id);
    const afterIgnore = await sendOne(waMessage('G8', 'u2', text('should not be stored')));
    check('G1 ignore succeeds', ig.ok);
    check('G1b [defect] an IGNORED group stops capturing',
          afterIgnore.stored === false,
          `stored=${afterIgnore.stored}; allowlist gate checks is_watched only and ignoreGroup leaves it true`);

    // ── L. LID-addressed groups ────────────────────────────────────────────
    heading('L  LID-addressed group (WhatsApp supplies participant_pn)');
    const lidMsg = waMessage('G6', 'u3', text('Status from the LID group'));
    const [env] = await worker.upsert([lidMsg]);
    info('L0 what the worker sends as participantJid', `${env.participantJid} (key.participantPn=${lidMsg.key.participantPn})`);
    await sendOne(lidMsg);
    const lidRow = await msgByWamid(org, lidMsg.key.id);
    check('L1 [defect] from_phone is the real number, not the LID', lidRow.from_phone === PHONE.u3,
          `from_phone=${lidRow.from_phone}`);
    const pLid = await q1(`SELECT p.* FROM whatsapp_thread_participants p JOIN whatsapp_threads t ON t.id = p.thread_id
                            WHERE t.org_id = $1 AND t.wa_group_id = $2 AND p.user_id = $3`, [org, GROUPS.G6.jid, ID.u3]);
    check('L2 [defect] the verified sender is linked to their user', !!pLid);
    await call('POST', '/api/whatsapp-session/internal/group-meta', {
      worker: true, body: { sessionId: ID.session, groups: [rosterPayload(worker, 'G6')] },
    });
    const g6 = await groupRow(org, GROUPS.G6.jid);
    const members6 = (await qn(`SELECT user_id FROM whatsapp_session_group_members WHERE session_group_id = $1`, [g6.id])).map(r => r.user_id);
    check('L3 [defect] roster sync links the verified member', members6.includes(ID.u3), JSON.stringify(members6));
    const t3lid = await session.listTriage(org, { userId: ID.u3 });
    check('L4 [defect] …so they can see the group in triage', t3lid.groups.some(g => g.group_jid === GROUPS.G6.jid));
    const selfRow = await q1(`SELECT p.side, p.wa_phone FROM whatsapp_thread_participants p JOIN whatsapp_threads t ON t.id = p.thread_id
                               WHERE t.org_id = $1 AND t.wa_group_id = $2 AND p.side = 'internal' AND p.user_id IS NULL`, [org, GROUPS.G6.jid]);
    check('L5 [defect] the handset is recognised as itself in a LID roster', !!selfRow);

    // ── Z. The negative control, last, after everything else has run ───────
    heading('Z  Negative control');
    check('Z1 Weekend Football produced nothing: no group row, thread or message',
          !(await groupRow(org, GROUPS.G4.jid)) && !(await threadRow(org, GROUPS.G4.jid)));

    groupCache.drop(ID.session);
  } finally {
    await new Promise(res => api.server.close(res));
  }
}

// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  let code = 0;
  try {
    if (ARGS.has('--teardown')) {
      console.log((await teardown()) ? 'Fixture removed.' : 'No fixture to remove.');
      return;
    }
    const { rows: [left] } = await pool.query(`SELECT id FROM organizations WHERE name = $1`, [FIXTURE_ORG]);
    if (left) {
      console.error(`A ${FIXTURE_ORG} org already exists (id ${left.id}). Run with --teardown first.`);
      code = 2;
      return;
    }
    await run();
    console.log(lines.join('\n'));
    console.log(`\n${'='.repeat(72)}\n${pass} passed, ${fail} failed`);
    if (failures.length) console.log(`\nFailures:\n  ${failures.join('\n  ')}`);
    code = fail ? 1 : 0;
  } catch (err) {
    console.log(lines.join('\n'));
    console.error('\nHARNESS ERROR:', err.stack || err.message);
    code = 3;
  } finally {
    if (!ARGS.has('--keep') && !ARGS.has('--teardown')) {
      try { await teardown(); } catch (err) { console.error('teardown failed:', err.message); code = code || 3; }
    }
    await pool.end().catch(() => {});
    process.exit(code);
  }
})();
