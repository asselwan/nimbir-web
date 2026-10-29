import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createStore, HttpError, kinds, statuses } from './store.js';
import { createApp } from './server.js';
import { assertSyntheticTarget } from './synthetic-target.js';

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.SEED_DATABASE_URL;
const hospitalAlpha = '11111111-1111-4111-8111-111111111111';
const hospitalBeta = '22222222-2222-4222-8222-222222222222';
const userAlpha = '33333333-3333-4333-8333-333333333333';
const userBeta = '44444444-4444-4444-8444-444444444444';
const userOutsider = '55555555-5555-4555-8555-555555555555';

// Fail closed: these tests truncate tables, so they refuse to run unless the
// explicit harness flag is set AND both URLs are pinned to the exact local
// disposable staging database (checked per destructive run by the shared guard).
const skip = runtimeUrl && ownerUrl && process.env.NIMBIR_SYNTHETIC_HARNESS === '1'
  ? false
  : 'set NIMBIR_SYNTHETIC_HARNESS=1, DATABASE_URL and SEED_DATABASE_URL to the local disposable staging database';

// One pool per role, reused for the whole run: a fresh pool per call leaks sockets
// and, worse, hides stale session state that a reused connection would expose.
const runtimePool = runtimeUrl ? new pg.Pool({ connectionString: runtimeUrl, max: 4 }) : null;
const ownerPool = ownerUrl ? new pg.Pool({ connectionString: ownerUrl, max: 4 }) : null;
after(async () => { await runtimePool?.end(); await ownerPool?.end(); });

function poolFor(url) {
  if (url === runtimeUrl) return runtimePool;
  if (url === ownerUrl) return ownerPool;
  throw new Error('unexpected connection string');
}

async function withClient(url, fn) {
  const client = await poolFor(url).connect();
  try { return await fn(client); } finally { client.release(); }
}

// The destructive-target guard lives in ./synthetic-target.js and is shared
// with the browser smoke harness. It requires the explicit harness flag, exact
// host/port/database match against the allowlisted disposable local target, and
// the absence of URL query parameters and libpq override variables.
async function reset() {
  assertSyntheticTarget({ harness: process.env.NIMBIR_SYNTHETIC_HARNESS === '1', runtimeUrl, ownerUrl });
  await withClient(ownerUrl, async (db) => {
    await db.query('TRUNCATE nimbir.work_item_audit, nimbir.work_item RESTART IDENTITY CASCADE');
    await db.query('TRUNCATE nimbir.hospital_member, nimbir.hospital CASCADE');
    await db.query(`INSERT INTO nimbir.hospital (id, name) VALUES ($1, $2), ($3, $4)`, [hospitalAlpha, 'Synthetic Hospital Alpha', hospitalBeta, 'Synthetic Hospital Beta']);
    await db.query(`INSERT INTO nimbir.hospital_member (hospital_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'agent'), ($4, $3, 'admin')`, [hospitalAlpha, userAlpha, userBeta, hospitalBeta]);
  });
}

async function auditRows(client, itemId, actor = userAlpha) {
  // The audit table is under row level security: a reader must carry an actor context.
  // The context is transaction local, so it dies with the transaction and cannot leak
  // to the next borrower of this pooled connection.
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('nimbir.actor_id', $1, true)", [actor]);
    const result = await client.query('SELECT actor_id, action, before_state, after_state FROM nimbir.work_item_audit WHERE work_item_id = $1 ORDER BY id', [itemId]);
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

test('migration installs the workspace objects, grants and policies', { skip }, async () => {
  await reset();
  const tables = await withClient(ownerUrl, async (db) => (await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'nimbir' ORDER BY table_name")).rows.map((row) => row.table_name));
  assert.deepEqual(tables, ['hospital', 'hospital_member', 'work_item', 'work_item_audit']);
  const policies = await withClient(ownerUrl, async (db) => (await db.query('SELECT policyname, cmd FROM pg_policies WHERE schemaname = $1 ORDER BY policyname', ['nimbir'])).rows);
  assert.deepEqual(policies.map((row) => row.policyname).sort(), ['audit_read', 'hospital_read', 'item_insert', 'item_read', 'item_update', 'member_read']);
  const rls = await withClient(ownerUrl, async (db) => (await db.query("SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = $1::regnamespace AND relkind = 'r'", ['nimbir'])).rows);
  assert.equal(rls.every((row) => row.relrowsecurity), true);
});

test('the runtime login is not privileged and inherits the no-login role', { skip }, async () => {
  const role = await withClient(ownerUrl, async (db) => (await db.query("SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = 'nimbir_workspace_runtime'")).rows[0]);
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false, rolcreaterole: false });
  const member = await withClient(ownerUrl, async (db) => (await db.query("SELECT pg_has_role('nimbir_workspace_runtime', 'nimbir_workspace_app', 'MEMBER') AS m")).rows[0]);
  assert.equal(member.m, true);
  const canAudit = await withClient(runtimeUrl, async (db) => (await db.query("SELECT has_table_privilege('nimbir_workspace_runtime', 'nimbir.work_item_audit', 'INSERT') AS i, has_table_privilege('nimbir_workspace_runtime', 'nimbir.work_item_audit', 'SELECT') AS s")).rows[0]);
  assert.deepEqual(canAudit, { i: false, s: true });
});

test('the database constraints match the code validation, so no valid input can trip a check', { skip }, async () => {
  await reset();
  const checks = await withClient(ownerUrl, async (db) => (await db.query(`
    SELECT c.conname, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'nimbir' AND c.contype = 'c' AND t.relname = 'work_item'`)).rows);
  const byName = Object.fromEntries(checks.map((row) => [row.conname, row.def]));
  const kindCheck = checks.find((row) => row.def.includes('kind'));
  const statusCheck = checks.find((row) => row.def.includes('status'));
  const sourceCheck = checks.find((row) => row.def.includes('source_ref'));
  const titleCheck = checks.find((row) => row.def.includes('title'));
  assert.ok(kindCheck && statusCheck && sourceCheck && titleCheck, `expected four check constraints, got ${Object.keys(byName).join(',')}`);
  for (const kind of kinds) assert.ok(kindCheck.def.includes(`'${kind}'`), `kind ${kind} is accepted by code but not by ${kindCheck.conname}`);
  for (const status of statuses) assert.ok(statusCheck.def.includes(`'${status}'`), `status ${status} is accepted by code but not by ${statusCheck.conname}`);
  assert.match(sourceCheck.def, /\^SYN-/);
  assert.match(titleCheck.def, /length\(title\) >= 11/);
  assert.match(titleCheck.def, /length\(title\) <= 200/);
  assert.match(titleCheck.def, /Synthetic/);
});

test('row level security returns nothing without an actor context', { skip }, async () => {
  await reset();
  const rows = await withClient(runtimeUrl, async (db) => (await db.query('SELECT count(*)::int AS n FROM nimbir.work_item')).rows[0]);
  assert.equal(rows.n, 0);
  const members = await withClient(runtimeUrl, async (db) => (await db.query('SELECT count(*)::int AS n FROM nimbir.hospital_member')).rows[0]);
  assert.equal(members.n, 0);
});

test('create writes one item and one audit row in the same transaction', { skip }, async () => {
  await reset();
  const store = createStore(poolFor(runtimeUrl));
  const created = await store.create(hospitalAlpha, userAlpha, { kind: 'denial', source_ref: 'SYN-CLAIM-A1', title: 'Synthetic denial one', sla_due_at: '2026-11-01T12:00:00Z' });
  assert.equal(created.hospital_id, hospitalAlpha);
  const rows = await withClient(runtimeUrl, async (db) => auditRows(db, created.id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'created');
  assert.equal(rows[0].actor_id, userAlpha);
  assert.equal(rows[0].before_state, null);
  assert.equal(rows[0].after_state.status, 'open');
});

test('update appends a second ordered audit row with before and after state', { skip }, async () => {
  await reset();
  const store = createStore(poolFor(runtimeUrl));
  const created = await store.create(hospitalAlpha, userAlpha, { kind: 'denial', source_ref: 'SYN-CLAIM-A2', title: 'Synthetic denial two', sla_due_at: '2026-11-01T12:00:00Z' });
  await store.update(hospitalAlpha, userAlpha, created.id, { status: 'in_progress' });
  const rows = await withClient(runtimeUrl, async (db) => auditRows(db, created.id));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.action), ['created', 'updated']);
  assert.equal(rows[1].before_state.status, 'open');
  assert.equal(rows[1].after_state.status, 'in_progress');
  assert.equal(rows[1].actor_id, userAlpha);
});

test('audit rows are append only for the runtime role', { skip }, async () => {
  await reset();
  const store = createStore(poolFor(runtimeUrl));
  const created = await store.create(hospitalAlpha, userAlpha, { kind: 'denial', source_ref: 'SYN-CLAIM-A3', title: 'Synthetic denial three', sla_due_at: '2026-11-01T12:00:00Z' });
  await assert.rejects(withClient(runtimeUrl, (db) => db.query('UPDATE nimbir.work_item_audit SET action = $1 WHERE work_item_id = $2', ['deleted', created.id])), (error) => error.code === '42501');
  await assert.rejects(withClient(runtimeUrl, (db) => db.query('DELETE FROM nimbir.work_item_audit WHERE work_item_id = $1', [created.id])), (error) => error.code === '42501');
  await assert.rejects(withClient(runtimeUrl, (db) => db.query('INSERT INTO nimbir.work_item_audit (hospital_id, work_item_id, actor_id, action) VALUES ($1, $2, $3, $4)', [hospitalAlpha, created.id, userAlpha, 'updated'])), (error) => error.code === '42501');
  const rows = await withClient(runtimeUrl, async (db) => auditRows(db, created.id));
  assert.equal(rows.length, 1);
});

test('a write without an actor context is refused by the audit trigger', { skip }, async () => {
  await reset();
  await assert.rejects(withClient(runtimeUrl, (db) => db.query(`INSERT INTO nimbir.work_item (hospital_id, kind, source_ref, title, sla_due_at) VALUES ($1, 'denial', 'SYN-NO-ACTOR', 'Synthetic no actor', '2026-11-01T12:00:00Z')`, [hospitalAlpha])), (error) => /actor_id required/.test(error.message));
  const count = await withClient(ownerUrl, async (db) => (await db.query('SELECT count(*)::int AS n FROM nimbir.work_item')).rows[0]);
  assert.equal(count.n, 0);
});

test('a member of another hospital cannot read or write this queue', { skip }, async () => {
  await reset();
  const store = createStore(poolFor(runtimeUrl));
  await store.create(hospitalAlpha, userAlpha, { kind: 'denial', source_ref: 'SYN-CLAIM-A4', title: 'Synthetic denial four', sla_due_at: '2026-11-01T12:00:00Z' });
  await assert.rejects(store.queue(hospitalBeta, userAlpha), (error) => error instanceof HttpError && error.status === 404);
  await assert.rejects(store.create(hospitalBeta, userAlpha, { kind: 'denial', source_ref: 'SYN-CLAIM-A5', title: 'Synthetic denial five', sla_due_at: '2026-11-01T12:00:00Z' }), (error) => error instanceof HttpError && error.status === 404);
  // The audit trail of another hospital's queue is invisible to this actor, even
  // when the item id is known.
  const created = await store.create(hospitalAlpha, userAlpha, { kind: 'denial', source_ref: 'SYN-CLAIM-A4B', title: 'Synthetic denial four b', sla_due_at: '2026-11-01T12:00:00Z' });
  const foreignRows = await withClient(runtimeUrl, async (db) => auditRows(db, created.id, userOutsider));
  assert.equal(foreignRows.length, 0);
  const ownRows = await withClient(runtimeUrl, async (db) => auditRows(db, created.id, userAlpha));
  assert.equal(ownRows.length, 1);
});

test('a rejected write leaves neither an item change nor an audit row', { skip }, async () => {
  await reset();
  const store = createStore(poolFor(runtimeUrl));
  const created = await store.create(hospitalAlpha, userAlpha, { kind: 'denial', source_ref: 'SYN-CLAIM-A6', title: 'Synthetic denial six', sla_due_at: '2026-11-01T12:00:00Z' });
  await assert.rejects(store.update(hospitalAlpha, userAlpha, created.id, { owner_id: userOutsider }), (error) => error instanceof HttpError && error.status === 400);
  const item = await withClient(runtimeUrl, async (db) => {
    await db.query('BEGIN');
    await db.query("SELECT set_config('nimbir.actor_id', $1, true)", [userAlpha]);
    const found = (await db.query('SELECT status, owner_id FROM nimbir.work_item WHERE id = $1', [created.id])).rows[0];
    await db.query('COMMIT');
    return found;
  });
  assert.equal(item.status, 'open');
  assert.equal(item.owner_id, null);
  const rows = await withClient(runtimeUrl, async (db) => auditRows(db, created.id));
  assert.equal(rows.length, 1);
});

test('a duplicate synthetic source ref in the same hospital is a conflict', { skip }, async () => {
  await reset();
  const store = createStore(poolFor(runtimeUrl));
  const body = { kind: 'denial', source_ref: 'SYN-CLAIM-A7', title: 'Synthetic denial seven', sla_due_at: '2026-11-01T12:00:00Z' };
  await store.create(hospitalAlpha, userAlpha, body);
  await assert.rejects(store.create(hospitalAlpha, userAlpha, body), (error) => error instanceof HttpError && error.status === 409);
});

test('a title the database would reject is reported as bad input, not a server error', { skip }, async () => {
  await reset();
  const store = createStore(poolFor(runtimeUrl));
  await assert.rejects(store.create(hospitalAlpha, userAlpha, { kind: 'denial', source_ref: 'SYN-CLAIM-A8', title: 'Synthetic ', sla_due_at: '2026-11-01T12:00:00Z' }), (error) => error instanceof HttpError && error.status === 400);
  await assert.rejects(store.create(hospitalAlpha, userAlpha, { kind: 'denial', source_ref: 'SYN-CLAIM-A9', title: 'Not synthetic at all', sla_due_at: '2026-11-01T12:00:00Z' }), (error) => error instanceof HttpError && error.status === 400);
});

test('actor context does not survive commit or rollback on a pooled connection', { skip }, async () => {
  await reset();
  const seen = await withClient(runtimeUrl, async (db) => {
    const afterCommit = await (async () => {
      await db.query('BEGIN');
      await db.query("SELECT set_config('nimbir.actor_id', $1, true)", [userAlpha]);
      const inside = (await db.query("SELECT current_setting('nimbir.actor_id', true) AS v")).rows[0].v;
      await db.query('COMMIT');
      return { inside, after: (await db.query("SELECT current_setting('nimbir.actor_id', true) AS v")).rows[0].v };
    })();
    const afterRollback = await (async () => {
      await db.query('BEGIN');
      await db.query("SELECT set_config('nimbir.actor_id', $1, true)", [userBeta]);
      // A failed statement inside the transaction forces the rollback path the
      // store takes when a write is rejected.
      await db.query('SELECT 1/0').catch(() => {});
      await db.query('ROLLBACK');
      return (await db.query("SELECT current_setting('nimbir.actor_id', true) AS v")).rows[0].v;
    })();
    return { afterCommit, afterRollback };
  });
  assert.equal(seen.afterCommit.inside, userAlpha);
  assert.equal(seen.afterCommit.after, '');
  assert.equal(seen.afterRollback, '');
  // And the same connection now sees no rows without a fresh actor context.
  const rows = await withClient(runtimeUrl, async (db) => (await db.query('SELECT count(*)::int AS n FROM nimbir.work_item')).rows[0]);
  assert.equal(rows.n, 0);
});

test('the migration policies and grants match the intended tenant and audit boundaries', { skip }, async () => {
  await reset();
  const policies = await withClient(ownerUrl, async (db) => (await db.query(`
    SELECT policyname, cmd, roles, qual, with_check
    FROM pg_policies WHERE schemaname = 'nimbir' ORDER BY policyname`)).rows);
  assert.equal(policies.length, 6);
  // Every policy is scoped to the app role only...
  for (const policy of policies) assert.deepEqual(policy.roles, '{nimbir_workspace_app}');
  // ...and every USING / WITH CHECK clause scopes rows through the
  // transaction-local actor — either via a hospital_member membership probe or,
  // on hospital_member itself, by matching the actor to the member row.
  for (const policy of policies) {
    for (const clause of [policy.qual, policy.with_check]) {
      if (clause) assert.match(clause, /current_setting\('nimbir\.actor_id'[^)]*, true\)/);
    }
  }
  const memberRead = policies.find((policy) => policy.policyname === 'member_read');
  assert.match(memberRead.qual, /user_id =/);
  for (const policy of policies) {
    if (policy.policyname === 'member_read') continue;
    for (const clause of [policy.qual, policy.with_check]) {
      if (clause) assert.match(clause, /hospital_member/);
    }
  }
  // The append-only audit table has no UPDATE/DELETE grant at all, and the
  // runtime role holds exactly the grants the migration intends.
  const grants = await withClient(ownerUrl, async (db) => (await db.query(`
    SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
    FROM information_schema.role_table_grants
    WHERE grantee IN ('nimbir_workspace_app', 'nimbir_workspace_runtime') AND table_schema = 'nimbir'
    GROUP BY table_name ORDER BY table_name`)).rows);
  assert.deepEqual(grants, [
    { table_name: 'hospital', privs: 'SELECT' },
    { table_name: 'hospital_member', privs: 'SELECT' },
    { table_name: 'work_item', privs: 'INSERT,SELECT,UPDATE' },
    { table_name: 'work_item_audit', privs: 'SELECT' },
  ]);
  // The audit trigger refuses UPDATE/DELETE on the audit table even for the
  // table owner, so no grant path can rewrite history.
  const itemId = '66666666-6666-4666-8666-666666666666';
  await withClient(ownerUrl, async (db) => db.query('INSERT INTO nimbir.work_item_audit (hospital_id, work_item_id, actor_id, action) VALUES ($1, $2, $3, $4)', [hospitalAlpha, itemId, userAlpha, 'created']));
  await assert.rejects(withClient(ownerUrl, (db) => db.query('UPDATE nimbir.work_item_audit SET action = $1 WHERE work_item_id = $2', ['updated', itemId])), (error) => /append only/.test(error.message));
  await assert.rejects(withClient(ownerUrl, (db) => db.query('DELETE FROM nimbir.work_item_audit WHERE work_item_id = $1', [itemId])), (error) => /append only/.test(error.message));
});

test('the http api drives the same transaction path end to end', { skip }, async () => {
  await reset();
  const store = createStore(poolFor(runtimeUrl));
  const app = createApp({
    store,
    authenticate: async (token) => token === 'tok-alpha' ? userAlpha : token === 'tok-beta' ? userBeta : null,
    signIn: async (email, password) => email === 'pilot@example.test' && password === 'synthetic-pass' ? 'tok-alpha' : null,
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const call = async (path, options = {}) => {
    const response = await fetch(`${base}${path}`, options);
    return { status: response.status, body: await response.json() };
  };
  try {
    const signIn = await call('/api/workspace/sign-in', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'pilot@example.test', password: 'synthetic-pass' }) });
    assert.equal(signIn.status, 200);
    assert.equal(signIn.body.access_token, 'tok-alpha');

    const noToken = await call('/api/workspace/hospitals');
    assert.equal(noToken.status, 401);

    const hospitals = await call('/api/workspace/hospitals', { headers: { authorization: 'Bearer tok-alpha' } });
    assert.equal(hospitals.status, 200);
    assert.equal(hospitals.body.length, 1);
    assert.equal(hospitals.body[0].id, hospitalAlpha);

    const created = await call(`/api/workspace/${hospitalAlpha}/items`, {
      method: 'POST',
      headers: { authorization: 'Bearer tok-alpha', 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'unpaid_claim', source_ref: 'SYN-HTTP-1', title: 'Synthetic http item', sla_due_at: '2026-11-02T09:00:00Z' }),
    });
    assert.equal(created.status, 201);

    const patched = await call(`/api/workspace/${hospitalAlpha}/items/${created.body.id}`, {
      method: 'PATCH',
      headers: { authorization: 'Bearer tok-alpha', 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.status, 'done');

    const audit = await call(`/api/workspace/${hospitalAlpha}/items/${created.body.id}/audit`, { headers: { authorization: 'Bearer tok-alpha' } });
    assert.equal(audit.status, 200);
    assert.equal(audit.body.length, 2);
    assert.deepEqual(audit.body.map((row) => row.action), ['created', 'updated']);

    const foreign = await call(`/api/workspace/${hospitalBeta}/items`, { headers: { authorization: 'Bearer tok-alpha' } });
    assert.equal(foreign.status, 404);

    const bad = await call(`/api/workspace/${hospitalAlpha}/items`, {
      method: 'POST',
      headers: { authorization: 'Bearer tok-alpha', 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'unpaid_claim', source_ref: 'SYN-HTTP-2', title: 'Synthetic http item', sla_due_at: '2026-11-02T09:00:00Z', patient_name: 'Test' }),
    });
    assert.equal(bad.status, 400);

    const page = await fetch(`${base}/workspace`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /synthetic records only/i);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});
