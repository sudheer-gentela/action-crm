/**
 * verify_whatsapp_group_live.js — judges the LIVE WhatsApp group test, stage by
 * stage, against the real database.
 *
 * STANDALONE. Imports nothing from the application repo, so it runs from
 * C:\Projects\dw-verify with that folder's own node_modules (pg, dotenv).
 *
 *   node verify_whatsapp_group_live.js --stage 0
 *   node verify_whatsapp_group_live.js --stage 2
 *   node verify_whatsapp_group_live.js --stage 5
 *
 * READ-ONLY, ENFORCED BY THE DATABASE. Every query runs inside one
 * BEGIN READ ONLY transaction that is rolled back at the end, so a mistake in
 * this file cannot write to production — Postgres refuses the statement.
 *
 * WHY STAGES AND NOT ONE RUN
 *   The live test moves the data through states that contradict each other:
 *   after stage 2 every message must be UNASSIGNED; after stage 3 the project
 *   group must have NONE unassigned. One pass over "the end state" cannot tell
 *   a correct history from a lucky one, which is how the earlier smoke-test
 *   plan would have passed without capturing anything. Run the stage you have
 *   just finished, and do not move on until it passes.
 *
 * WHAT IT DOES NOT DO
 *   The capture-path harness (backend/scripts/test_whatsapp_group_capture.js)
 *   already proves the rules against synthetic traffic. This file answers the
 *   questions only real WhatsApp can: did the traffic arrive, with whose
 *   number on it, and did it land where the rules say. The scoping check in
 *   stage 5 mirrors listTriage's SQL rule — it confirms the DATA grants the
 *   right access; the screens still need a look with your own eyes.
 *
 * CONFIGURATION
 *   Edit CONFIG below, or point WA_LIVE_CONFIG at a JSON file with the same
 *   shape. Names are matched EXACTLY (after trimming), so use the plain-ASCII
 *   GWTEST names from the plan — an en dash typed on one phone and a hyphen on
 *   another is two different group names.
 */

try { require('dotenv').config(); } catch { /* fine — env may be set inline */ }

let Pool;
try {
  ({ Pool } = require('pg'));
} catch {
  console.error('\nThe pg module is not installed in this folder. Run: npm install\n');
  process.exit(2);
}

const fs = require('fs');

const CONFIG = {
  orgId: 112,
  // Digits only, with country code, exactly as WhatsApp reports them.
  phones: { u1: '', u2: '', u3: '', u4: '', u5: '' },
  // Login emails of the CRM users. u6 is the scoping negative.
  users: { u2: '', u3: '', u6: '' },
  groups: {
    G1: 'GWTEST G1 Acme Migration',
    G2: 'GWTEST G2 Cloudsmith',
    G3: 'GWTEST G3 Delivery Internal',
    G4: 'GWTEST G4 Football',
    G5: 'GWTEST G5 Initiative',
  },
  projects: {
    P1:   'GWTEST P1 Acme Migration',
    P2:   'GWTEST P2 Cutover',
    INIT: 'GWTEST Initiative',
  },
  accounts: { vendor: 'GWTEST Cloudsmith', customer: 'GWTEST Meridian' },
};

if (process.env.WA_LIVE_CONFIG) {
  Object.assign(CONFIG, JSON.parse(fs.readFileSync(process.env.WA_LIVE_CONFIG, 'utf8')));
}

const stageArg = process.argv.indexOf('--stage');
const STAGE = stageArg > 0 ? Number(process.argv[stageArg + 1]) : NaN;
if (![0, 1, 2, 3, 4, 5].includes(STAGE)) {
  console.error('Usage: node verify_whatsapp_group_live.js --stage <0|1|2|3|4|5>');
  process.exit(2);
}

const needs = {
  0: ['phones.u1', 'phones.u2'],
  1: ['phones.u1', 'phones.u2', 'phones.u3', 'phones.u4', 'phones.u5', 'users.u2', 'users.u3', 'users.u6'],
};
const required = needs[Math.min(STAGE, 1)];
const missing = required.filter(k => { const [a, b] = k.split('.'); return !String(CONFIG[a][b] || '').trim(); });
if (missing.length) {
  console.error(`\nFill in CONFIG before running stage ${STAGE}: ${missing.join(', ')}\n`);
  process.exit(2);
}

const CONN = process.env.DATABASE_URL;
if (!CONN) { console.error('\nNo DATABASE_URL (put it in .env next to this script).\n'); process.exit(2); }
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(CONN);
const pool = new Pool({ connectionString: CONN, ssl: isLocal ? false : { rejectUnauthorized: false }, max: 1, connectionTimeoutMillis: 10000 });

// ─────────────────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`); }
  return !!ok;
}
function info(name, detail = '') { console.log(`  INFO  ${name}${detail ? `\n          ${detail}` : ''}`); }
function heading(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 70 - t.length))}`); }

const digits = (s) => String(s || '').replace(/[^0-9]/g, '');
const KNOWN = () => new Set(Object.values(CONFIG.phones).map(digits).filter(Boolean));
const sameSet = (a, b) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

let db;
const q  = async (sql, p = []) => (await db.query(sql, p)).rows;
const q1 = async (sql, p = []) => (await db.query(sql, p)).rows[0];

// ─────────────────────────────────────────────────────────────────────────────
// Lookups by name. Each insists on exactly one match: two groups called the
// same thing in org 112 would make every downstream check about the wrong one.
// ─────────────────────────────────────────────────────────────────────────────

async function group(key) {
  const rows = await q(
    `SELECT g.id, g.subject, g.is_watched, g.binding_status, g.thread_id, g.message_count,
            g.bound_at, g.media_policy, t.handover_id AS thread_handover_id, t.wa_group_id
       FROM whatsapp_session_groups g
       LEFT JOIN whatsapp_threads t ON t.id = g.thread_id
      WHERE g.org_id = $1 AND btrim(g.subject) = $2`,
    [CONFIG.orgId, CONFIG.groups[key]]);
  if (rows.length > 1) throw new Error(`${rows.length} groups are named "${CONFIG.groups[key]}" — rename so each is unique`);
  return rows[0] || null;
}
async function project(key) {
  const rows = await q(
    `SELECT id, name, status, project_kind, tracking_mode, retired_at, account_id, deal_id
       FROM sales_handovers WHERE org_id = $1 AND btrim(name) = $2`, [CONFIG.orgId, CONFIG.projects[key]]);
  if (rows.length > 1) throw new Error(`${rows.length} projects are named "${CONFIG.projects[key]}"`);
  return rows[0] || null;
}
async function account(key) {
  const rows = await q(`SELECT id, name FROM accounts WHERE org_id = $1 AND btrim(name) = $2`, [CONFIG.orgId, CONFIG.accounts[key]]);
  if (rows.length > 1) throw new Error(`${rows.length} accounts are named "${CONFIG.accounts[key]}"`);
  return rows[0] || null;
}
async function user(key) {
  return q1(`SELECT id, email, role, whatsapp_phone, whatsapp_phone_verified_at, whatsapp_phone_source
               FROM users WHERE org_id = $1 AND lower(email) = lower($2)`, [CONFIG.orgId, CONFIG.users[key]]);
}
async function messages(g, extra = '', params = []) {
  if (!g?.thread_id) return [];
  return q(
    `SELECT id, wa_message_id, direction, message_type, from_phone, handover_id, handover_source,
            handover_tagged_by, reply_to_wa_message_id, media_source, media_status, media_error,
            capture_source, created_at, excluded_at
       FROM whatsapp_messages WHERE org_id = $1 AND thread_id = $2 ${extra}
      ORDER BY created_at, id`, [CONFIG.orgId, g.thread_id, ...params]);
}
async function linkedUsers(g) {
  if (!g?.thread_id) return [];
  return (await q(`SELECT DISTINCT user_id FROM whatsapp_thread_participants
                    WHERE org_id = $1 AND thread_id = $2 AND user_id IS NOT NULL`, [CONFIG.orgId, g.thread_id]))
    .map(r => r.user_id);
}
async function candidates(g) {
  if (!g?.wa_group_id) return [];
  return (await q(
    `SELECT cc.handover_id FROM conversation_bindings b
       JOIN conversation_project_candidates cc ON cc.binding_id = b.id
      WHERE b.org_id = $1 AND b.channel = 'whatsapp' AND b.thread_ref = $2`, [CONFIG.orgId, g.wa_group_id]))
    .map(r => r.handover_id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Invariants — every stage
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The single most important live question: does WhatsApp hand us PHONE NUMBERS
 * for group senders, or LIDs? The pinned Baileys puts a LID in key.participant
 * on LID-addressed groups and the worker stores that. If this fails, stop the
 * test — every identity-dependent step after it (linking, scoping, the vendor
 * panel's phone matching) would fail for this one reason and look like many.
 */
async function identityInvariant(keys) {
  const known = KNOWN();
  const bad = [];
  for (const k of keys) {
    const g = await group(k);
    for (const m of await messages(g)) {
      if (m.direction === 'outbound' && !m.from_phone) continue;
      if (!known.has(digits(m.from_phone))) bad.push({ group: k, id: m.id, from_phone: m.from_phone });
    }
  }
  const lidLike = bad.filter(b => digits(b.from_phone).length >= 14);
  check('IDENTITY every captured sender is one of the configured phone numbers', bad.length === 0,
        bad.length ? `${bad.length} unknown sender(s), ${lidLike.length} look like LIDs (14+ digits): ${JSON.stringify(bad.slice(0, 5))}` : '');
  if (lidLike.length) {
    console.log('\n  >>> STOP. Senders are arriving as WhatsApp LIDs, not phone numbers.');
    console.log('  >>> The worker must read key.participantPn / participant.jid before this test can mean anything.\n');
  }
}

async function footballInvariant() {
  const g = await group('G4');
  const t = await q1(`SELECT count(*)::int AS n FROM whatsapp_threads WHERE org_id = $1 AND btrim(group_subject) = $2`,
                     [CONFIG.orgId, CONFIG.groups.G4]);
  check('NEGATIVE G4 has no group row, no thread, and therefore no messages', !g && t.n === 0,
        `group row=${!!g} threads=${t.n}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stages
// ─────────────────────────────────────────────────────────────────────────────

async function stage0() {
  heading('Stage 0 — two-phone probe: is the pipe connected, and are senders phone numbers?');
  const s = await q1(
    `SELECT id, status, capture_enabled, capture_mode, wa_phone, last_seen_at, heartbeat_at, created_by
       FROM whatsapp_sessions WHERE org_id = $1 AND status <> 'disabled' LIMIT 1`, [CONFIG.orgId]);
  if (!check('session exists for the org', !!s)) return;
  check("session status 'connected'", s.status === 'connected', s.status);
  check('session is the capture handset (wa_phone = u1)', digits(s.wa_phone) === digits(CONFIG.phones.u1), s.wa_phone);
  check('capture enabled, allowlist mode', s.capture_enabled && s.capture_mode === 'allowlist', `${s.capture_enabled}/${s.capture_mode}`);
  const age = await q1(`SELECT extract(epoch FROM now() - greatest(last_seen_at, heartbeat_at))::int AS s FROM whatsapp_sessions WHERE id = $1`, [s.id]);
  check('worker seen within the last 5 minutes (heartbeat or traffic)', age.s != null && age.s < 300, `${age.s}s ago`);

  const g1 = await group('G1');
  if (!check('G1 has been switched on (row exists, watched)', g1 && g1.is_watched)) return;
  const ms = await messages(g1);
  check('G1 has captured messages', ms.length > 0, 'send a message from u2 AFTER switching capture on');
  const fromU2 = ms.filter(m => digits(m.from_phone) === digits(CONFIG.phones.u2));
  check("at least one message carries u2's phone number", fromU2.length > 0,
        `from_phone values seen: ${JSON.stringify([...new Set(ms.map(m => m.from_phone))])}`);
  await identityInvariant(['G1']);
}

async function stage1() {
  heading('Stage 1 — CRM setup, before any phone is touched');
  const u2 = await user('u2'), u3 = await user('u3'), u6 = await user('u6');
  check('u2, u3, u6 exist in the org', u2 && u3 && u6);
  if (!(u2 && u3 && u6)) return;
  check('u2 is an org admin (steward by role)', ['admin', 'owner'].includes(u2.role), u2.role);
  check('u3 is NOT an admin', !['admin', 'owner'].includes(u3.role), u3.role);
  check('u6 is NOT an admin', !['admin', 'owner'].includes(u6.role), u6.role);
  check("u2's WhatsApp number set AND verified", digits(u2.whatsapp_phone) === digits(CONFIG.phones.u2) && u2.whatsapp_phone_verified_at);
  check("u3's WhatsApp number set AND verified — otherwise the scoping test passes for the wrong reason",
        digits(u3.whatsapp_phone) === digits(CONFIG.phones.u3) && u3.whatsapp_phone_verified_at,
        `${u3.whatsapp_phone} verified_at=${u3.whatsapp_phone_verified_at}`);
  check("u6 has no verified WhatsApp number", !u6.whatsapp_phone_verified_at);
  const stewards = (await q(`SELECT user_id FROM communication_stewards WHERE org_id = $1 AND revoked_at IS NULL`, [CONFIG.orgId])).map(r => r.user_id);
  check('neither u3 nor u6 holds an explicit steward grant', !stewards.includes(u3.id) && !stewards.includes(u6.id));
  const sessOwner = await q1(`SELECT created_by FROM whatsapp_sessions WHERE org_id = $1 AND status <> 'disabled' LIMIT 1`, [CONFIG.orgId]);
  check('neither u3 nor u6 connected the session (that makes a steward)',
        !sessOwner || ![u3.id, u6.id].includes(sessOwner.created_by));

  const vendor = await account('vendor'), customer = await account('customer');
  check('vendor and customer accounts exist', vendor && customer);
  if (vendor) {
    const rel = await q1(`SELECT status FROM account_relationships WHERE org_id = $1 AND account_id = $2 AND relationship IN ('vendor','partner') ORDER BY (status='active') DESC LIMIT 1`, [CONFIG.orgId, vendor.id]);
    check('vendor relationship is ACTIVE', rel?.status === 'active', rel?.status);
  }

  const P1 = await project('P1'), P2 = await project('P2'), INIT = await project('INIT');
  check('P1, P2 and the initiative exist', P1 && P2 && INIT);
  if (!(P1 && P2 && INIT)) return;
  for (const [k, p] of [['P1', P1], ['P2', P2]]) {
    check(`${k} is a live customer project`, p.project_kind === 'customer' && !['draft', 'completed', 'cancelled'].includes(p.status),
          `${p.project_kind}/${p.status}`);
  }
  check('the initiative is standing, internal, not retired, not draft',
        INIT.tracking_mode === 'standing' && INIT.project_kind === 'internal' && !INIT.retired_at && INIT.status !== 'draft',
        `${INIT.tracking_mode}/${INIT.project_kind}/${INIT.status}/retired=${!!INIT.retired_at}`);

  const onProject = async (h, phone, side) => q1(
    `SELECT 1 AS ok FROM project_contacts pc JOIN contacts c ON c.id = pc.contact_id
      WHERE pc.org_id = $1 AND pc.context_type = 'handover' AND pc.context_id = $2 AND pc.side = $3
        AND regexp_replace(coalesce(c.phone,''), '[^0-9]', '', 'g') = $4
        AND ($5::int IS NULL OR c.account_id = $5)`, [CONFIG.orgId, h, side, digits(phone), side === 'vendor' ? vendor?.id ?? null : null]);
  check('u5 is a VENDOR-side contact at the vendor account on P1', !!(await onProject(P1.id, CONFIG.phones.u5, 'vendor')));
  check('u5 is a VENDOR-side contact at the vendor account on P2', !!(await onProject(P2.id, CONFIG.phones.u5, 'vendor')));
  check('u4 is a CUSTOMER-side contact on P1', !!(await onProject(P1.id, CONFIG.phones.u4, 'customer')));

  if (vendor) {
    const derived = await q(
      `SELECT DISTINCT h.id, h.name, h.retired_at FROM project_contacts pc
         JOIN contacts c ON c.id = pc.contact_id AND c.org_id = pc.org_id
         JOIN sales_handovers h ON h.id = pc.context_id AND h.org_id = pc.org_id
        WHERE pc.org_id = $1 AND pc.context_type = 'handover' AND c.account_id = $2
          AND pc.side IN ('vendor','partner') AND h.status NOT IN ('draft','completed','cancelled')
          AND (h.account_id IS NULL OR h.account_id <> $2)`, [CONFIG.orgId, vendor.id]);
    check('the vendor derives EXACTLY P1 and P2 as candidates (the stage 3 expectation)',
          sameSet(derived.map(d => d.id), [P1.id, P2.id]),
          `would derive: ${JSON.stringify(derived.map(d => d.name))}${derived.some(d => d.retired_at) ? ' — includes a RETIRED initiative (known defect)' : ''}`);
  }

  const member = async (h, u) => q1(`SELECT status FROM project_members WHERE org_id = $1 AND context_type = 'handover' AND context_id = $2 AND user_id = $3`, [CONFIG.orgId, h, u]);
  for (const [pk, p] of [['P1', P1], ['P2', P2], ['INIT', INIT]]) {
    check(`u2 and u3 are APPROVED members of ${pk}`,
          (await member(p.id, u2.id))?.status === 'approved' && (await member(p.id, u3.id))?.status === 'approved');
    check(`u6 is NOT a member of ${pk}`, (await member(p.id, u6.id))?.status !== 'approved');
  }

  for (const k of ['G1', 'G2', 'G3', 'G4', 'G5']) {
    const g = await group(k);
    check(`no stored group named "${CONFIG.groups[k]}" yet${k === 'G1' ? ' (or only the stage 0 probe)' : ''}`, !g || k === 'G1');
  }
}

async function stage2() {
  heading('Stage 2 — capture on for G1 G2 G3 G5, history sent, NOTHING bound yet');
  const want = { G1: 3, G2: 5, G3: 3, G5: 2 };
  const u2 = await user('u2'), u3 = await user('u3'), u6 = await user('u6');
  for (const [k, min] of Object.entries(want)) {
    const g = await group(k);
    if (!check(`${k} stored, watched, and has a thread`, g && g.is_watched && g.thread_id,
               g ? `watched=${g.is_watched} thread=${g.thread_id}` : 'no row — capture was never switched on')) continue;
    const ms = await messages(g);
    check(`${k} captured at least ${min} messages`, ms.length >= min, `${ms.length}`);
    check(`${k} is still unbound`, g.binding_status === 'unbound' && g.thread_handover_id == null, g.binding_status);
    check(`${k} has no attributed messages yet`, ms.every(m => m.handover_id == null),
          `${ms.filter(m => m.handover_id != null).length} attributed`);
    check(`${k} every row is capture_source=session`, ms.every(m => m.capture_source === 'session'));
  }
  const g2 = await group('G2');
  const docs = (await messages(g2)).filter(m => m.message_type === 'document');
  check('G2 recorded the PDF with a session media descriptor', docs.some(d => d.media_source === 'session'),
        `documents seen: ${JSON.stringify(docs.map(d => ({ s: d.media_status, e: d.media_error })))}`);

  const links = {};
  for (const k of ['G1', 'G2', 'G3', 'G5']) links[k] = await linkedUsers(await group(k));
  check('u2 is linked as a participant in G1, G2, G3 and G5',
        ['G1', 'G2', 'G3', 'G5'].every(k => links[k].includes(u2?.id)), JSON.stringify(links));
  check('u3 is linked in G3 and G5 and nowhere else among the test groups',
        links.G3.includes(u3?.id) && links.G5.includes(u3?.id) && !links.G1.includes(u3?.id) && !links.G2.includes(u3?.id));
  check('u6 is linked nowhere', !Object.values(links).some(l => l.includes(u6?.id)));
  const hs = await q1(`SELECT count(*) FILTER (WHERE side <> 'internal')::int AS wrong FROM whatsapp_thread_participants p
                        JOIN whatsapp_session_groups g ON g.thread_id = p.thread_id
                       WHERE p.org_id = $1 AND btrim(g.subject) = ANY($2) AND p.wa_phone = $3`,
                      [CONFIG.orgId, ['G1', 'G2', 'G3', 'G5'].map(k => CONFIG.groups[k]), digits(CONFIG.phones.u1)]);
  check('the handset is recorded as internal wherever it appears', hs.wrong === 0);
  await identityInvariant(['G1', 'G2', 'G3', 'G5']);
}

async function stage3() {
  heading('Stage 3 — binds done: G1→P1, G2→vendor, G3→pool(P1,P2), G5→initiative');
  const P1 = await project('P1'), P2 = await project('P2'), INIT = await project('INIT');
  const g1 = await group('G1'), g2 = await group('G2'), g3 = await group('G3'), g5 = await group('G5');

  check("G1 'bound', thread on P1", g1?.binding_status === 'bound' && g1.thread_handover_id === P1?.id, `${g1?.binding_status}/${g1?.thread_handover_id}`);
  const m1 = await messages(g1);
  check('G1 back-fill left nothing unassigned', m1.every(m => m.handover_id != null), `${m1.filter(m => m.handover_id == null).length} unassigned`);
  check('G1 back-filled rows are on P1 via the thread', m1.filter(m => m.handover_source === 'thread').every(m => m.handover_id === P1?.id));

  check("G2 'bound_account', thread carries NO project", g2?.binding_status === 'bound_account' && g2.thread_handover_id == null, `${g2?.binding_status}/${g2?.thread_handover_id}`);
  check('G2 candidates are exactly P1 and P2', sameSet(await candidates(g2), [P1?.id, P2?.id]), JSON.stringify(await candidates(g2)));
  // A human filing or a quoted reply may legitimately attribute a G2 message
  // once stage 4 has run. What must NEVER appear in an entity group is an
  // AUTOMATIC attribution — back-fill ('thread') or rule 2.
  //
  // Source AND a project, never source alone: a message captured while the
  // group was still unbound is stored as handover_source='thread' with a NULL
  // handover_id (rule 3 returns the label even when the thread has no project).
  const AUTO = ['thread', 'recent_outbound', 'manual_recent'];
  const isAuto = (m) => m.handover_id != null && AUTO.includes(m.handover_source);
  const m2 = await messages(g2);
  const auto2 = m2.filter(isAuto);
  check('G2 back-filled NOTHING and nothing was attributed automatically — the money check', auto2.length === 0,
        `${auto2.length} automatic attribution(s) — STOP: ${JSON.stringify(auto2.slice(0, 5).map(m => ({ id: m.id, s: m.handover_source })))}`);

  check("G3 'bound_pool', thread carries NO project", g3?.binding_status === 'bound_pool' && g3.thread_handover_id == null);
  check('G3 candidates are exactly P1 and P2', sameSet(await candidates(g3), [P1?.id, P2?.id]));
  check('G3 back-filled NOTHING and nothing was attributed automatically',
        !(await messages(g3)).some(isAuto));

  check("G5 'bound' to the initiative", g5?.binding_status === 'bound' && g5.thread_handover_id === INIT?.id, `${g5?.binding_status}/${g5?.thread_handover_id}`);
  check('G5 back-fill left nothing unassigned', (await messages(g5)).every(m => m.handover_id === INIT?.id));
  await identityInvariant(['G1', 'G2', 'G3', 'G5']);
}

async function stage4() {
  heading('Stage 4 — traffic after binding, one message filed, one quoted reply');
  const P1 = await project('P1'), INIT = await project('INIT');
  const u2 = await user('u2');
  const g1 = await group('G1'), g2 = await group('G2'), g5 = await group('G5');

  const after2 = await messages(g2, 'AND created_at > $3', [g2?.bound_at]);
  check('G2 received messages after it was bound', after2.length > 0);
  const manual = after2.concat(await messages(g2, 'AND created_at <= $3', [g2?.bound_at])).filter(m => m.handover_source === 'manual');
  check('a G2 message was filed by hand, stamped manual, by u2', manual.some(m => m.handover_tagged_by === u2?.id),
        `manual rows: ${manual.length}`);
  const replies = await q(
    `SELECT r.id, r.handover_id, r.handover_source, p.handover_id AS parent_handover
       FROM whatsapp_messages r JOIN whatsapp_messages p ON p.org_id = r.org_id AND p.wa_message_id = r.reply_to_wa_message_id
      WHERE r.org_id = $1 AND r.thread_id = $2 AND r.created_at > $3`, [CONFIG.orgId, g2?.thread_id, g2?.bound_at]);
  const toFiled = replies.filter(r => r.parent_handover != null);
  check('a quoted reply to the filed message inherited its project via reply_context',
        toFiled.some(r => r.handover_source === 'reply_context' && r.handover_id === r.parent_handover),
        `replies to filed messages: ${JSON.stringify(toFiled)}${replies.length && !toFiled.length ? ' — reply was sent before the parent was filed?' : ''}`);
  const plainAfter = after2.filter(m => !m.reply_to_wa_message_id && m.handover_source !== 'manual');
  check('plain G2 messages after the bind landed UNASSIGNED', plainAfter.length > 0 && plainAfter.every(m => m.handover_id == null),
        `${plainAfter.filter(m => m.handover_id != null).length} of ${plainAfter.length} acquired a project`);

  const after1 = (await messages(g1, 'AND created_at > $3', [g1?.bound_at])).filter(m => m.handover_source !== 'manual');
  check('G1 received messages after it was bound', after1.length > 0, 'send at least one G1 message after the bind');
  check('G1 traffic after the bind is on P1', after1.every(m => m.handover_id === P1?.id),
        JSON.stringify(after1.filter(m => m.handover_id !== P1?.id).map(m => ({ id: m.id, h: m.handover_id, s: m.handover_source }))));
  const srcs = {};
  for (const m of after1) srcs[m.handover_source] = (srcs[m.handover_source] || 0) + 1;
  info('G1 attribution sources after the bind', JSON.stringify(srcs));
  if (srcs.manual_recent) info('manual_recent seen in the project group — a filed message is steering later traffic (see findings)');

  const after5 = await messages(g5, 'AND created_at > $3', [g5?.bound_at]);
  check('G5 received messages after it was bound', after5.length > 0, 'send at least one G5 message after the bind');
  check('G5 traffic after the bind is on the initiative', after5.every(m => m.handover_id === INIT?.id));
  await identityInvariant(['G1', 'G2', 'G3', 'G5']);
}

async function stage5() {
  heading('Stage 5 — who can see which group (mirrors listTriage\'s rule)');
  const u2 = await user('u2'), u3 = await user('u3'), u6 = await user('u6');
  const subjects = ['G1', 'G2', 'G3', 'G4', 'G5'].map(k => CONFIG.groups[k]);
  const steward = async (u) => q1(
    `SELECT EXISTS (SELECT 1 FROM communication_stewards WHERE org_id = $1 AND user_id = $2 AND revoked_at IS NULL)
         OR EXISTS (SELECT 1 FROM users WHERE id = $2 AND org_id = $1 AND role IN ('admin','owner'))
         OR EXISTS (SELECT 1 FROM whatsapp_sessions WHERE org_id = $1 AND created_by = $2 AND status <> 'disabled') AS s`,
    [CONFIG.orgId, u.id]);
  const visible = async (u) => (await q(
    `SELECT btrim(g.subject) AS subject FROM whatsapp_session_groups g
      WHERE g.org_id = $1 AND btrim(g.subject) = ANY($2)
        AND EXISTS (SELECT 1 FROM whatsapp_thread_participants wp
                     WHERE wp.thread_id = g.thread_id AND wp.org_id = g.org_id AND wp.user_id = $3)`,
    [CONFIG.orgId, subjects, u.id])).map(r => r.subject);

  check('u2 is a steward (sees every group)', (await steward(u2)).s);
  check('u3 is NOT a steward', !(await steward(u3)).s);
  check('u6 is NOT a steward', !(await steward(u6)).s);
  check('u3 would see exactly G3 and G5', sameSet(await visible(u3), [CONFIG.groups.G3, CONFIG.groups.G5]), JSON.stringify(await visible(u3)));
  check('u6 would see no test group', (await visible(u6)).length === 0, JSON.stringify(await visible(u6)));
  info('now confirm on screen', 'log in as u3 and u6 and open Communication → Messages triage; the lists must match the two lines above');
}

// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  let code = 0;
  try {
    db = await pool.connect();
    await db.query('BEGIN READ ONLY');
    console.log(`verify_whatsapp_group_live — org ${CONFIG.orgId}, stage ${STAGE}`);
    await [stage0, stage1, stage2, stage3, stage4, stage5][STAGE]();
    if (STAGE >= 2) await footballInvariant();
    console.log(`\n${'='.repeat(72)}\n${passed} passed, ${failed} failed`);
    if (failures.length) console.log(`\nFailures:\n  ${failures.join('\n  ')}`);
    code = failed ? 1 : 0;
  } catch (err) {
    console.error('\nERROR:', err.message);
    code = 3;
  } finally {
    if (db) { await db.query('ROLLBACK').catch(() => {}); db.release(); }
    await pool.end().catch(() => {});
    process.exit(code);
  }
})();
