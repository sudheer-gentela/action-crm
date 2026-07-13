// scripts/test_linkedin_message_events.js
//
// P2 exit-criterion test (design doc): applying the same reply_received
// message URN twice bumps reply_count exactly once; two different URNs bump
// it twice; a pre-acceptance message (F14 — the Ashraf connection-note case)
// is ledgered but never counted. Self-contained: fake pg client + in-memory
// ledger with ON CONFLICT semantics. Run: node scripts/test_linkedin_message_events.js

const Sync = require('../services/LinkedInConnectionSyncService.js');

// ── In-memory ledger: UNIQUE (org_id, message_urn), ON CONFLICT DO NOTHING ──
class LedgerSim {
  constructor() { this.rows = new Map(); }
  insert({ orgId, prospectId, urn, direction, occurredAt, counted }) {
    const key = orgId + '|' + urn;
    if (this.rows.has(key)) return { inserted: false };
    this.rows.set(key, { prospectId, direction, occurredAt, counted });
    return { inserted: true };
  }
}

// ── Fake pg client: interprets the two UPDATE shapes + activity INSERTs ─────
class FakeClient {
  constructor(prospect) { this.prospect = prospect; this.activities = []; }
  async query(sql, params) {
    if (/UPDATE prospects SET\s+stage = 'outreach'/.test(sql)) {
      this.prospect.stage = 'outreach'; return { rows: [] };
    }
    if (/UPDATE prospects SET\s+channel_data/.test(sql)) {
      this.prospect.channel_data = JSON.parse(params[0]);
      const countOutreach = params[1], countResponse = params[5];
      if (countOutreach) this.prospect.outreach_count = (this.prospect.outreach_count || 0) + 1;
      if (countResponse) this.prospect.response_count = (this.prospect.response_count || 0) + 1;
      return { rows: [] };
    }
    if (/INSERT INTO prospecting_activities/.test(sql)) {
      this.activities.push({ desc: params[3], meta: params[4] ? JSON.parse(params[4]) : null });
      return { rows: [] };
    }
    throw new Error('FakeClient: unrecognized SQL: ' + sql.slice(0, 60));
  }
}

// ── Harvest-side flow under test: ledger → gate → apply (mirrors P3 route) ──
async function ingestMessage(client, ledger, prospect, msg) {
  const li = (prospect.channel_data || {}).linkedin || {};
  const counted = Sync.passesPostAcceptanceGate(li, msg.occurredAtIso);
  const { inserted } = ledger.insert({
    orgId: 1, prospectId: prospect.id, urn: msg.urn,
    direction: msg.direction, occurredAt: msg.occurredAtIso, counted,
  });
  if (!inserted) return { inserted, counted: false, applied: false };
  if (!counted)  return { inserted, counted, applied: false };   // ledgered, not counted (F14)
  await Sync.applyConnectionEvent(client, {
    orgId: 1, userId: 15, prospect,
    event: msg.direction === 'inbound' ? 'reply_received' : 'message_sent',
    viewerSlug: 'sudheer', message: msg,
  });
  return { inserted, counted, applied: true };
}

let failures = 0;
function assertEq(label, actual, expected) {
  const ok = actual === expected;
  console.log((ok ? '  PASS ' : '  FAIL ') + label + ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
  if (!ok) failures++;
}

(async () => {
  // Prospect modeled on the Wigglesworth row: attributed, accepted 2026-06-04.
  const prospect = {
    id: 1242, org_id: 1, owner_id: 15, stage: 'outreach', outreach_count: 2,
    channel_data: { linkedin: {
      connection_status: 'connection_accepted',
      request_sent_at: '2026-06-03T17:10:26.743Z',
      connected_at:    '2026-06-04T03:09:11.008Z',
    } },
  };
  const client = new FakeClient(prospect);
  const ledger = new LedgerSim();
  const li = () => prospect.channel_data.linkedin;

  console.log('T1: first inbound reply R1 → counts once, status advances');
  let r = await ingestMessage(client, ledger, prospect, {
    urn: 'urn:li:messagingMessage:R1', threadUrn: 'urn:li:messagingThread:T1',
    direction: 'inbound', occurredAtIso: '2026-06-10T09:00:00.000Z',
  });
  assertEq('inserted', r.inserted, true);
  assertEq('applied',  r.applied,  true);
  assertEq('reply_count', li().reply_count, 1);
  assertEq('response_count', prospect.response_count, 1);
  assertEq('status', li().connection_status, 'reply_received');

  console.log('T2: SAME URN R1 again → ledger conflict, nothing bumps (exit criterion a)');
  r = await ingestMessage(client, ledger, prospect, {
    urn: 'urn:li:messagingMessage:R1', threadUrn: 'urn:li:messagingThread:T1',
    direction: 'inbound', occurredAtIso: '2026-06-10T09:00:00.000Z',
  });
  assertEq('inserted', r.inserted, false);
  assertEq('reply_count still', li().reply_count, 1);
  assertEq('response_count still', prospect.response_count, 1);

  console.log('T3: DIFFERENT URN R2 → counts again (exit criterion b)');
  r = await ingestMessage(client, ledger, prospect, {
    urn: 'urn:li:messagingMessage:R2', threadUrn: 'urn:li:messagingThread:T1',
    direction: 'inbound', occurredAtIso: '2026-06-11T09:00:00.000Z',
  });
  assertEq('reply_count', li().reply_count, 2);

  console.log('T4: outbound OLDER than last (pagination) → count bumps, last_message_at only moves forward');
  await ingestMessage(client, ledger, prospect, {
    urn: 'urn:li:messagingMessage:M2', threadUrn: 'urn:li:messagingThread:T1',
    direction: 'outbound', occurredAtIso: '2026-06-09T10:00:00.000Z',
  });
  await ingestMessage(client, ledger, prospect, {
    urn: 'urn:li:messagingMessage:M1', threadUrn: 'urn:li:messagingThread:T1',
    direction: 'outbound', occurredAtIso: '2026-06-05T10:00:00.000Z', // older
  });
  assertEq('message_count', li().message_count, 2);
  assertEq('last_message_at (forward only)', li().last_message_at, '2026-06-09T10:00:00.000Z');

  console.log('T5: F14 Ashraf vector — pre-acceptance connection note: ledgered, NOT counted');
  const ashraf = {
    id: 1199, org_id: 1, owner_id: 15, stage: 'outreach',
    channel_data: { linkedin: {
      connection_status: 'connection_accepted',
      request_sent_at: '2026-06-01T16:46:02.092Z',
      connected_at:    '2026-06-23T09:18:32.708Z',
    } },
  };
  const c2 = new FakeClient(ashraf);
  r = await ingestMessage(c2, ledger, ashraf, {
    urn: 'urn:li:messagingMessage:NOTE1', threadUrn: 'urn:li:messagingThread:T9',
    direction: 'outbound', occurredAtIso: '2026-06-15T19:13:00.000Z', // note sent Jun 15 < accepted Jun 23
  });
  assertEq('inserted (ledgered)', r.inserted, true);
  assertEq('counted', r.counted, false);
  assertEq('message_count untouched', ashraf.channel_data.linkedin.message_count, undefined);
  assertEq('status untouched', ashraf.channel_data.linkedin.connection_status, 'connection_accepted');

  console.log('T6: gate tolerance (F11) — 24h before connected_at passes, 72h before fails, unattributed fails');
  const gLi = { request_sent_at: '2026-06-01T00:00:00Z', connected_at: '2026-06-10T00:00:00Z' };
  assertEq('−24h passes', Sync.passesPostAcceptanceGate(gLi, '2026-06-09T00:00:00Z'), true);
  assertEq('−72h fails',  Sync.passesPostAcceptanceGate(gLi, '2026-06-07T00:00:00Z'), false);
  assertEq('no request_sent_at fails (D5)',
    Sync.passesPostAcceptanceGate({ connected_at: '2026-06-10T00:00:00Z' }, '2026-06-11T00:00:00Z'), false);

  console.log('T7: existing connection-event behavior unchanged (regression)');
  const fresh = { id: 9, org_id: 1, owner_id: 15, stage: 'target', channel_data: {} };
  const c3 = new FakeClient(fresh);
  await Sync.applyConnectionEvent(c3, {
    orgId: 1, userId: 15, prospect: fresh, event: 'connection_request_sent',
    person: { name: 'X', url: 'https://linkedin.com/in/x', timeText: '2 days ago' }, viewerSlug: 'sudheer',
  });
  assertEq('status', fresh.channel_data.linkedin.connection_status, 'connection_request_sent');
  assertEq('stage auto-advanced', fresh.stage, 'outreach');
  assertEq('outreach_count', fresh.outreach_count, 1);

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
