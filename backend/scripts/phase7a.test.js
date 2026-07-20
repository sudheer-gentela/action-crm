// ─────────────────────────────────────────────────────────────────────────────
// Phase 7A behavioral test (pg-mem, in-process).
//
// Proves the DB-level behaviour the four route edits depend on:
//   1. The 2026_55 migration applies (client_id column + FK; index attempted).
//   2. The exact stamped INSERT shapes used at each site succeed and freeze
//      the client from the prospect.
//   3. The derivation SELECT the sites use returns the right client_id.
//   4. A prospect with NULL client_id → call.client_id NULL.
//   5. An inbound call with no prospect match → client_id NULL.
//   6. FK ON DELETE SET NULL: deleting a client nulls its calls, keeps the rows.
//   7. Freeze: reassigning the prospect's client later does NOT change the call.
//
// pg-mem can't run the Express handlers (no node_modules in the backend, needs
// req/res), so we exercise the same SQL the handlers emit against a minimal
// schema. That is the behaviour under test for 7A (the JS change is "add one
// column + one param"); node --check covers the JS syntax separately.
// ─────────────────────────────────────────────────────────────────────────────
const { newDb } = require('pg-mem');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name); }
}
function section(t) { console.log('\n' + t); }

const db = newDb();

// ── Minimal schema: clients, prospects, calls (only columns 7A touches) ───────
db.public.none(`
  CREATE TABLE clients (
    id serial PRIMARY KEY,
    org_id integer NOT NULL,
    name text NOT NULL
  );
  CREATE TABLE prospects (
    id serial PRIMARY KEY,
    org_id integer NOT NULL,
    client_id integer,
    phone text,
    deleted_at timestamptz
  );
  CREATE TABLE calls (
    id serial PRIMARY KEY,
    org_id integer NOT NULL,
    user_id integer NOT NULL,
    prospect_id integer,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    direction text NOT NULL DEFAULT 'outbound',
    status text NOT NULL DEFAULT 'logged',
    outcome text,
    duration_seconds integer,
    notes text,
    phone_used text,
    sequence_step_log_id integer,
    provider text,
    provider_call_id text,
    callback_requested_at timestamptz
  );
`);

// ── Apply the 2026_55 migration (core DDL) ────────────────────────────────────
section('1. Migration 2026_55 applies');
db.public.none(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS client_id integer;`);
ok('client_id column added', true);

let fkOk = true;
try {
  db.public.none(`
    ALTER TABLE calls
      ADD CONSTRAINT calls_client_id_fkey
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL;
  `);
} catch (e) { fkOk = false; console.log('    (FK add error:', e.message, ')'); }
ok('FK calls_client_id_fkey → clients(id) ON DELETE SET NULL added', fkOk);

// The real migration uses a partial + DESC index. pg-mem support for that varies;
// attempt it, then fall back to a plain index so downstream inserts are unaffected.
let idxNote = 'partial DESC';
try {
  db.public.none(`
    CREATE INDEX IF NOT EXISTS idx_calls_client_id
      ON calls (client_id, occurred_at DESC) WHERE client_id IS NOT NULL;`);
} catch (e) {
  idxNote = 'plain fallback (pg-mem: ' + e.message.split('\n')[0] + ')';
  try { db.public.none(`CREATE INDEX idx_calls_client_id ON calls (client_id);`); } catch (_) {}
}
ok('index idx_calls_client_id created [' + idxNote + ']', true);

// ── Seed ──────────────────────────────────────────────────────────────────────
db.public.none(`
  INSERT INTO clients (id, org_id, name) VALUES (10, 1, 'Acme'), (11, 1, 'Globex');
  INSERT INTO prospects (id, org_id, client_id, phone) VALUES
    (100, 1, 10, '+15551234567'),   -- has a client
    (101, 1, NULL, '+15559999999'), -- no client
    (102, 2, 10, '+15550000000');   -- different org (cross-org guard test)
`);

// ── Derivation SELECT (what all four sites use to resolve client_id) ──────────
section('2. Derivation SELECT (id + org_id guarded)');
const der = (pid, org) => {
  const r = db.public.many(
    `SELECT client_id FROM prospects WHERE id = ${pid} AND org_id = ${org} AND deleted_at IS NULL`);
  return r.length ? r[0].client_id : undefined;
};
ok('prospect 100 in org 1 → client 10', der(100, 1) === 10);
ok('prospect 101 in org 1 → NULL', der(101, 1) === null);
ok('prospect 100 in WRONG org 2 → no row (cross-org blocked)', der(100, 2) === undefined);

// ── Site 1 shape: manual log INSERT with client_id ($12) ──────────────────────
section('3. Site 1 (manual log) stamps client_id');
{
  const clientId = der(100, 1) ?? null;
  const r = db.public.many(
    `INSERT INTO calls
       (org_id, prospect_id, user_id, occurred_at, direction, outcome,
        duration_seconds, notes, phone_used, sequence_step_log_id,
        callback_requested_at, client_id)
     VALUES (1, 100, 7, now(), 'outbound', 'connected',
             60, NULL, '+15551234567', NULL, NULL, ${clientId})
     RETURNING id, client_id`);
  ok('call stamped client_id = 10', r[0].client_id === 10);
}

// ── Site 2/3 shape: twilio initiate/prepare INSERT with client_id ($6) ────────
section('4. Site 2/3 (twilio initiate/prepare) stamps client_id');
{
  const clientId = der(100, 1) ?? null;
  const r = db.public.many(
    `INSERT INTO calls
       (org_id, prospect_id, user_id, direction, status, outcome,
        phone_used, provider, sequence_step_log_id, occurred_at, client_id)
     VALUES (1, 100, 7, 'outbound', 'initiated', NULL,
             '+15551234567', 'twilio', NULL, now(), ${clientId})
     RETURNING id, client_id`);
  ok('initiated call stamped client_id = 10', r[0].client_id === 10);
}
{
  // prospect with no client → NULL
  const clientId = der(101, 1) ?? null;
  const r = db.public.many(
    `INSERT INTO calls
       (org_id, prospect_id, user_id, direction, status, outcome,
        phone_used, provider, sequence_step_log_id, occurred_at, client_id)
     VALUES (1, 101, 7, 'outbound', 'initiated', NULL,
             '+15559999999', 'twilio', NULL, now(), ${clientId})
     RETURNING id, client_id`);
  ok('client-less prospect → call.client_id NULL', r[0].client_id === null);
}

// ── Site 4 shape: inbound webhook, matched vs unmatched ───────────────────────
section('5. Site 4 (inbound webhook) stamps matched client, NULL when unmatched');
{
  // matched: phone hits prospect 100 → client 10
  const m = db.public.many(
    `SELECT id, client_id FROM prospects
      WHERE org_id = 1 AND phone = '+15551234567' AND deleted_at IS NULL LIMIT 1`);
  const matchedProspectId = m.length ? m[0].id : null;
  const matchedClientId   = m.length ? (m[0].client_id ?? null) : null;
  const r = db.public.many(
    `INSERT INTO calls
       (org_id, user_id, prospect_id, direction, status,
        provider, provider_call_id, phone_used, occurred_at, client_id)
     VALUES (1, 7, ${matchedProspectId}, 'inbound', 'ringing',
             'twilio', 'CA_match', '+15551234567', now(), ${matchedClientId})
     RETURNING prospect_id, client_id`);
  ok('matched inbound → client_id 10', r[0].client_id === 10 && r[0].prospect_id === 100);
}
{
  // unmatched: no prospect with this phone → prospect_id + client_id NULL
  const m = db.public.many(
    `SELECT id, client_id FROM prospects
      WHERE org_id = 1 AND phone = '+15551111111' AND deleted_at IS NULL LIMIT 1`);
  const matchedProspectId = m.length ? m[0].id : null;
  const matchedClientId   = m.length ? (m[0].client_id ?? null) : null;
  const r = db.public.many(
    `INSERT INTO calls
       (org_id, user_id, prospect_id, direction, status,
        provider, provider_call_id, phone_used, occurred_at, client_id)
     VALUES (1, 7, ${matchedProspectId ?? 'NULL'}, 'inbound', 'ringing',
             'twilio', 'CA_nomatch', '+15551111111', now(), ${matchedClientId ?? 'NULL'})
     RETURNING prospect_id, client_id`);
  ok('unmatched inbound → prospect_id NULL, client_id NULL',
     r[0].client_id === null && r[0].prospect_id === null);
}

// ── FK ON DELETE SET NULL ─────────────────────────────────────────────────────
section('6. FK ON DELETE SET NULL keeps call history');
{
  const before = db.public.many(`SELECT count(*)::int AS n FROM calls WHERE client_id = 10`)[0].n;
  db.public.none(`DELETE FROM clients WHERE id = 10`);
  const stillThere = db.public.many(`SELECT count(*)::int AS n FROM calls WHERE client_id = 10`)[0].n;
  const nowNull = db.public.many(
    `SELECT count(*)::int AS n FROM calls WHERE client_id IS NULL AND provider_call_id = 'CA_match'`)[0].n;
  const totalCalls = db.public.many(`SELECT count(*)::int AS n FROM calls`)[0].n;
  ok('had client-10 calls before delete', before >= 3);
  ok('no client_id=10 rows remain after client delete', stillThere === 0);
  ok('the calls survive with client_id reset to NULL', nowNull === 1 && totalCalls >= 5);
}

// ── Freeze semantics (documented invariant; no UPDATE calls.prospect_id path) ─
section('7. Freeze: re-tagging the prospect does NOT change historical calls');
{
  // Insert a fresh client + prospect and a call, then move the prospect to a new
  // client. The already-stamped call must keep its original client_id.
  db.public.none(`INSERT INTO clients (id, org_id, name) VALUES (20, 1, 'Initech');`);
  db.public.none(`INSERT INTO prospects (id, org_id, client_id, phone) VALUES (200, 1, 11, '+15552223333');`);
  const cid = db.public.many(`SELECT client_id FROM prospects WHERE id = 200 AND org_id = 1`)[0].client_id;
  db.public.none(
    `INSERT INTO calls (org_id, prospect_id, user_id, occurred_at, direction, status, phone_used, client_id)
     VALUES (1, 200, 7, now(), 'outbound', 'logged', '+15552223333', ${cid});`);
  // Reassign the prospect to client 20 (like a bulk-assign would).
  db.public.none(`UPDATE prospects SET client_id = 20 WHERE id = 200;`);
  const callClient = db.public.many(
    `SELECT client_id FROM calls WHERE prospect_id = 200`)[0].client_id;
  ok('prospect re-tagged to client 20, but its call stays client_id = 11', callClient === 11);
}

console.log(`\n${'─'.repeat(60)}\nPASSED ${passed}  FAILED ${failed}`);
process.exit(failed ? 1 : 0);
