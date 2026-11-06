import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, HttpError } from './store.js';

const hospital = '11111111-1111-4111-8111-111111111111';
const otherHospital = '22222222-2222-4222-8222-222222222222';
const user = '33333333-3333-4333-8333-333333333333';
const item = '44444444-4444-4444-8444-444444444444';
const draft = { kind: 'denial', source_ref: 'SYN-CLAIM-1', title: 'Synthetic denial', sla_due_at: '2026-11-01T12:00:00Z' };

function fakePool({ authorized = true, failWrite = false, summary = null } = {}) {
  const calls = [];
  const client = {
    async query(sql, args = []) {
      calls.push({ sql, args });
      if (sql.includes('hospital_member WHERE')) return { rowCount: authorized ? 1 : 0, rows: authorized ? [{ '?column?': 1 }] : [] };
      if (sql.startsWith('INSERT') || sql.startsWith('UPDATE')) {
        if (failWrite) throw new Error('write failure');
        return { rowCount: 1, rows: [{ id: item, hospital_id: args[0] }] };
      }
      if (summary && sql.includes('count(*)::int AS total')) return { rowCount: 1, rows: [summary] };
      return { rowCount: 0, rows: [] };
    },
    release() { calls.push({ sql: 'RELEASE' }); },
  };
  return { calls, async connect() { return client; }, query: client.query.bind(client) };
}

test('create checks membership and sets audit actor in the same transaction', async () => {
  const pool = fakePool();
  const result = await createStore(pool).create(hospital, user, draft);
  assert.equal(result.hospital_id, hospital);
  assert.deepEqual(pool.calls.map((call) => call.sql.split(' ')[0]), ['BEGIN', 'SELECT', 'SELECT', 'INSERT', 'COMMIT', 'RELEASE']);
  assert.deepEqual(pool.calls[1].args, [user]);
  assert.equal(pool.calls[3].args[0], hospital);
});

test('non-member cannot write, and transaction rolls back', async () => {
  const pool = fakePool({ authorized: false });
  await assert.rejects(createStore(pool).create(otherHospital, user, draft), (error) => error instanceof HttpError && error.status === 404);
  assert.equal(pool.calls.some((call) => call.sql.startsWith('INSERT')), false);
  assert.equal(pool.calls.some((call) => call.sql === 'ROLLBACK'), true);
});

test('failed write rolls back audit context and mutation', async () => {
  const pool = fakePool({ failWrite: true });
  await assert.rejects(createStore(pool).create(hospital, user, draft), /write failure/);
  assert.equal(pool.calls.some((call) => call.sql === 'COMMIT'), false);
  assert.equal(pool.calls.some((call) => call.sql === 'ROLLBACK'), true);
});

test('update and audit reads are scoped by hospital and item', async () => {
  const pool = fakePool();
  await createStore(pool).update(hospital, user, item, { status: 'in_progress' });
  await createStore(pool).audit(hospital, user, item);
  const update = pool.calls.find((call) => call.sql.startsWith('UPDATE'));
  const audit = pool.calls.find((call) => call.sql.includes('work_item_audit WHERE'));
  assert.match(update.sql, /WHERE hospital_id = \$1 AND id = \$2/);
  assert.deepEqual(update.args.slice(0, 2), [hospital, item]);
  assert.deepEqual(audit.args, [hospital, item]);
  const auditStart = pool.calls.findIndex((call) => call.sql.includes('work_item_audit WHERE'));
  assert.equal(pool.calls[auditStart - 2].sql.startsWith("SELECT set_config('nimbir.actor_id'"), true);
  assert.equal(pool.calls[auditStart - 1].sql.includes('hospital_member WHERE'), true);
});

test('hospital and queue reads set actor before row-level-security queries', async () => {
  const pool = fakePool();
  const store = createStore(pool);
  await store.hospitals(user);
  await store.queue(hospital, user);
  assert.deepEqual(pool.calls.slice(0, 4).map((call) => call.sql.split(' ')[0]), ['BEGIN', 'SELECT', 'SELECT', 'COMMIT']);
  assert.deepEqual(pool.calls.slice(5, 10).map((call) => call.sql.split(' ')[0]), ['BEGIN', 'SELECT', 'SELECT', 'SELECT', 'COMMIT']);
  assert.deepEqual(pool.calls[1].args, [user]);
  assert.deepEqual(pool.calls[6].args, [user]);
});

test('rejects patient-shaped and arbitrary fields, bad statuses, and non-synthetic refs', async () => {
  const store = createStore(fakePool());
  for (const body of [
    { ...draft, patient_name: 'Test' },
    { ...draft, source_ref: 'REAL-123' },
    { ...draft, status: 'paid' },
    { ...draft, sla_due_at: 'tomorrow' },
  ]) await assert.rejects(store.create(hospital, user, body), (error) => error.status === 400);
});

test('queue filters are bound as parameters and unknown filter values are refused', async () => {
  const pool = fakePool();
  const store = createStore(pool);
  await store.queue(hospital, user, { status: 'blocked', needs_owner: true });
  const query = pool.calls.find((call) => call.sql.includes('FROM nimbir.work_item'));
  assert.match(query.sql, /WHERE hospital_id = \$1 AND status = \$2 AND owner_id IS NULL/);
  assert.deepEqual(query.args, [hospital, 'blocked']);
  await store.queue(hospital, user, { kind: 'denial' });
  const byKind = pool.calls.find((call) => call.sql.includes('kind = $2'));
  assert.deepEqual(byKind.args, [hospital, 'denial']);
  await store.queue(hospital, user, { overdue: true });
  const overdue = pool.calls.find((call) => call.sql.includes('sla_due_at < now()'));
  assert.match(overdue.sql, /status <> 'done'/);
  await assert.rejects(store.queue(hospital, user, { status: 'paid' }), (error) => error.status === 400);
  await assert.rejects(store.queue(hospital, user, { kind: 'invoice' }), (error) => error.status === 400);
});

test('triage summarises the whole hospital queue', async () => {
  const pool = fakePool({ summary: { total: '5', open: '3', in_progress: '1', blocked: '1', done: '0', unowned: '2', overdue: '1', denial: '2', unpaid_claim: '2', remittance_line: '1', next_due_at: '2026-11-06T09:00:00.000Z' } });
  const summary = await createStore(pool).triage(hospital, user);
  assert.equal(summary.total, 5);
  assert.equal(summary.open, 3);
  assert.equal(summary.overdue, 1);
  assert.equal(summary.unowned, 2);
  assert.equal(summary.next_due_at, '2026-11-06T09:00:00.000Z');
  const query = pool.calls.find((call) => call.sql.includes('count(*)::int AS total'));
  assert.deepEqual(query.args, [hospital]);
});
