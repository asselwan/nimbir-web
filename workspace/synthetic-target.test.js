import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { assertSyntheticTarget } from './synthetic-target.js';

const good = 'postgresql://user:secret@127.0.0.1:55433/nimbir_workspace_staging';
const pgVars = ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGOPTIONS', 'PGSERVICE', 'PGSERVICEFILE', 'PGPASSFILE', 'PGSSLMODE', 'PGREQUIRESSL', 'PGTARGETSESSIONATTRS'];

// The guard reads PG* environment variables, so the tests pin a clean view.
const saved = {};
beforeEach(() => { for (const name of pgVars) { saved[name] = process.env[name]; delete process.env[name]; } });
afterEach(() => { for (const name of pgVars) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } });

function refuses(options, message) {
  assert.throws(() => assertSyntheticTarget(options), (error) => error instanceof Error && (message ? error.message.includes(message) : true));
}

test('the exact allowlisted local target passes with the harness flag', () => {
  assert.equal(assertSyntheticTarget({ harness: true, runtimeUrl: good, ownerUrl: good }), 'nimbir_workspace_staging');
});

test('refuses to run without the explicit harness flag', () => {
  refuses({ harness: false, runtimeUrl: good, ownerUrl: good }, 'NIMBIR_SYNTHETIC_HARNESS');
  refuses({ runtimeUrl: good, ownerUrl: good }, 'NIMBIR_SYNTHETIC_HARNESS');
  refuses({ harness: '1', runtimeUrl: good, ownerUrl: good }, 'NIMBIR_SYNTHETIC_HARNESS');
});

test('refuses a runtime URL pointing at a different host or port than the owner URL', () => {
  const remoteOwner = 'postgresql://user:secret@10.9.8.7:5432/nimbir_workspace_staging';
  refuses({ harness: true, runtimeUrl: good, ownerUrl: remoteOwner }, 'host');
  const remoteRuntime = 'postgresql://user:secret@127.0.0.1:5433/nimbir_workspace_staging';
  refuses({ harness: true, runtimeUrl: remoteRuntime, ownerUrl: good }, 'port');
  // The old guard passed this pair: same database name, different server.
  refuses({ harness: true, runtimeUrl: 'postgresql://u:s@localhost:5432/nimbir_workspace_staging', ownerUrl: remoteOwner }, 'host');
});

test('refuses any database other than the exact allowlisted name, including pattern lookalikes', () => {
  for (const database of ['contest', 'latest', 'nimbir_workspace_staging2', 'production', 'workspace_test', 'nimbir_workspace_staging/x']) {
    refuses({ harness: true, runtimeUrl: `postgresql://user:secret@127.0.0.1:55433/${database}`, ownerUrl: `postgresql://user:secret@127.0.0.1:55433/${database}` }, 'not the exact allowlisted');
  }
});

test('refuses URL query parameters that could redirect the connection', () => {
  for (const query of ['?host=evil.example', '?port=5433', '?dbname=production', '?sslmode=require']) {
    refuses({ harness: true, runtimeUrl: good + query, ownerUrl: good }, 'query parameters');
    refuses({ harness: true, runtimeUrl: good, ownerUrl: good + query }, 'query parameters');
  }
});

test('refuses unset, malformed or non-postgres URLs', () => {
  refuses({ harness: true, runtimeUrl: '', ownerUrl: good }, 'DATABASE_URL');
  refuses({ harness: true, runtimeUrl: good, ownerUrl: undefined }, 'SEED_DATABASE_URL');
  refuses({ harness: true, runtimeUrl: 'not a url', ownerUrl: good });
  refuses({ harness: true, runtimeUrl: 'http://127.0.0.1:55433/nimbir_workspace_staging', ownerUrl: good }, 'protocol');
});

test('refuses libpq environment variables that could override the validated target', () => {
  for (const [name, value] of [['PGHOST', 'db.internal'], ['PGPORT', '5433'], ['PGDATABASE', 'production']]) {
    process.env[name] = value;
    refuses({ harness: true, runtimeUrl: good, ownerUrl: good }, name);
    delete process.env[name];
  }
  for (const name of ['PGOPTIONS', 'PGSERVICE', 'PGSERVICEFILE', 'PGTARGETSESSIONATTRS']) {
    process.env[name] = 'anything';
    refuses({ harness: true, runtimeUrl: good, ownerUrl: good }, name);
    delete process.env[name];
  }
});

test('tolerates override variables only when they name the exact allowlisted target', () => {
  process.env.PGHOST = '127.0.0.1';
  process.env.PGPORT = '55433';
  process.env.PGDATABASE = 'nimbir_workspace_staging';
  assert.equal(assertSyntheticTarget({ harness: true, runtimeUrl: good, ownerUrl: good }), 'nimbir_workspace_staging');
});
