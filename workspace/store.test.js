import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, HttpError } from './store.js';

const hospital = '11111111-1111-4111-8111-111111111111';
const otherHospital = '22222222-2222-4222-8222-222222222222';
const user = '33333333-3333-4333-8333-333333333333';
const item = '44444444-4444-4444-8444-444444444444';
const draft = { kind: 'denial', source_ref: 'SYN-CLAIM-1', title: 'Synthetic denial', sla_due_at: '2026-11-01T12:00:00Z' };

function fakePool({ authorized = true, failWrite = false } = {}) {
  const calls = [];
  const client = {
    async query(sql, args = []) {
      calls.push({ sql, args });
      if (sql.includes('hospital_member WHERE')) return { rowCount: authorized ? 1 : 0, rows: authorized ? [{ '?column?': 1 }] : [] };
      if (sql.startsWith('INSERT') || sql.startsWith('UPDATE')) {
        if (failWrite) throw new Error('write failure');
        return { rowCount: 1, rows: [{ id: item, hospital_id: args[0] }] };
      }
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
