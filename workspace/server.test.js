import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createApp } from './server.js';

const hospital = '11111111-1111-4111-8111-111111111111';
const user = '33333333-3333-4333-8333-333333333333';

test('API requires verified bearer identity and passes it to tenant-scoped store', async () => {
  const calls = [];
  const app = createApp({
    authenticate: async (token) => token === 'verified' ? user : null,
    signIn: async (email, password) => email === 'user@example.test' && password === 'correct' ? 'verified' : null,
    store: {
      hospitals: async (who) => { calls.push(who); return [{ id: hospital, name: 'Synthetic Hospital' }]; },
      queue: async (tenant, who) => { calls.push([tenant, who]); return []; },
    },
  });
  function request(path, authorization, body) {
    return new Promise((resolve) => {
      const incoming = Readable.from(body ? [JSON.stringify(body)] : []);
      incoming.method = body ? 'POST' : 'GET'; incoming.url = path; incoming.headers = authorization ? { authorization } : {};
      const outgoing = { writeHead(status) { this.status = status; }, end(body) { resolve({ status: this.status, body: JSON.parse(body) }); } };
      app.emit('request', incoming, outgoing);
    });
  }
  assert.equal((await request('/api/workspace/hospitals')).status, 401);
  assert.equal((await request('/api/workspace/hospitals', 'Bearer fake')).status, 401);
  assert.equal((await request('/api/workspace/sign-in', null, { email: 'user@example.test', password: 'wrong' })).status, 401);
  assert.deepEqual((await request('/api/workspace/sign-in', null, { email: 'user@example.test', password: 'correct' })).body, { access_token: 'verified' });
  const response = await request(`/api/workspace/${hospital}/items`, 'Bearer verified');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, []);
  assert.deepEqual(calls, [[hospital, user]]);
});

test('workspace serves only the fixed synthetic 835 and its browser import modules', async () => {
  const app = createApp({ authenticate: async () => null, signIn: async () => null, store: {} });
  function request(path) {
    return new Promise((resolve) => {
      const incoming = Readable.from([]);
      incoming.method = 'GET'; incoming.url = path; incoming.headers = {};
      const outgoing = {
        writeHead(status, headers) { this.status = status; this.headers = headers; },
        end(body) { resolve({ status: this.status, headers: this.headers, body: String(body) }); },
      };
      app.emit('request', incoming, outgoing);
    });
  }
  const sample = await request('/workspace/sample.835');
  assert.equal(sample.status, 200);
  assert.match(sample.headers['content-type'], /^text\/plain/);
  assert.match(sample.body, /SYNTHETICNIMBIR/);
  assert.match(sample.body, /CAS\*CO\*97\*450\.00/);
  for (const path of ['/workspace/x12/parse835.js', '/workspace/x12/carc-rarc.js', '/workspace/x12/to-nimbir.js', '/workspace/x12/to-work-item.js']) {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers['content-type'], /^text\/javascript/);
  }
});

test('repeated failed sign-ins are throttled', async () => {
  const app = createApp({
    authenticate: async () => null,
    signIn: async () => null,
    store: {},
  });
  function signIn() {
    return new Promise((resolve) => {
      const incoming = Readable.from([JSON.stringify({ email: 'user@example.test', password: 'wrong' })]);
      incoming.method = 'POST'; incoming.url = '/api/workspace/sign-in'; incoming.headers = {};
      const outgoing = { writeHead(status) { this.status = status; }, end(body) { resolve({ status: this.status, body: JSON.parse(body) }); } };
      app.emit('request', incoming, outgoing);
    });
  }
  const codes = [];
  for (let attempt = 0; attempt < 7; attempt += 1) codes.push((await signIn()).status);
  assert.deepEqual(codes.slice(0, 5), [401, 401, 401, 401, 401]);
  assert.deepEqual(codes.slice(5), [429, 429]);
});

test('flooding with distinct emails hits a client-wide budget but another client is unaffected', async () => {
  const app = createApp({
    authenticate: async () => null,
    signIn: async () => null,
    store: {},
  });
  function signIn(email, remoteAddress) {
    return new Promise((resolve) => {
      const incoming = Readable.from([JSON.stringify({ email, password: 'wrong' })]);
      incoming.method = 'POST'; incoming.url = '/api/workspace/sign-in'; incoming.headers = {};
      if (remoteAddress) incoming.socket = { remoteAddress };
      const outgoing = { writeHead(status) { this.status = status; }, end(body) { resolve({ status: this.status, body: JSON.parse(body) }); } };
      app.emit('request', incoming, outgoing);
    });
  }
  // Key churn (varying the email) used to reset the throttle per key; the
  // client-wide budget caps the flood itself.
  const codes = [];
  for (let index = 0; index < 120; index += 1) codes.push((await signIn(`flood-${index}@example.test`, '10.0.0.1')).status);
  assert.equal(codes.slice(0, 100).every((code) => code === 401), true);
  assert.equal(codes.slice(100).every((code) => code === 429), true, `expected the client budget to refuse the flood after 100 failures, got ${codes.slice(100).join(',')}`);
  // A different client address still gets its own full budget: five failures of
  // a real account, then the per-key refusal — not the flood's shadow.
  const other = [];
  for (let attempt = 0; attempt < 6; attempt += 1) other.push((await signIn('real@example.test', '10.0.0.2')).status);
  assert.deepEqual(other, [401, 401, 401, 401, 401, 429]);
});

test('concurrent failed sign-ins cannot bypass the throttle while authentication is in flight', async () => {
  let started = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const app = createApp({
    authenticate: async () => null,
    // Slow enough that every request below is in flight at once.
    signIn: async () => { started += 1; await gate; return null; },
    store: {},
  });
  const attempts = Array.from({ length: 10 }, (_, index) => new Promise((resolve) => {
    const incoming = Readable.from([JSON.stringify({ email: 'race@example.test', password: 'wrong' })]);
    incoming.method = 'POST'; incoming.url = '/api/workspace/sign-in'; incoming.headers = {}; incoming.socket = { remoteAddress: '10.1.0.9' };
    const outgoing = { writeHead(status) { this.status = status; }, end(body) { resolve({ status: this.status, body: JSON.parse(body) }); } };
    app.emit('request', incoming, outgoing);
  }));
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const codes = (await Promise.all(attempts)).map((response) => response.status);
  // The per-account limit must hold even with ten credentials checks in
  // flight simultaneously: at most five reach signIn, the rest are refused.
  assert.equal(started, 5, `expected exactly 5 in-flight checks, got ${started}`);
  assert.equal(codes.filter((code) => code === 401).length, 5);
  assert.equal(codes.filter((code) => code === 429).length, 5);
});

test('triage filters reach the store and the triage summary is served separately', async () => {
  const calls = [];
  const app = createApp({
    authenticate: async () => user,
    signIn: async () => null,
    store: {
      hospitals: async () => [],
      queue: async (tenant, who, filters) => { calls.push({ call: 'queue', tenant, who, filters }); return []; },
      triage: async (tenant, who) => { calls.push({ call: 'triage', tenant, who }); return { total: 3, open: 3, overdue: 0 }; },
    },
  });
  function request(path) {
    return new Promise((resolve) => {
      const incoming = Readable.from([]);
      incoming.method = 'GET'; incoming.url = path; incoming.headers = { authorization: 'Bearer verified' };
      const outgoing = { writeHead(status) { this.status = status; }, end(body) { resolve({ status: this.status, body: JSON.parse(body) }); } };
      app.emit('request', incoming, outgoing);
    });
  }
  const filtered = await request(`/api/workspace/${hospital}/items?status=open&kind=denial&needs_owner=1&overdue=1`);
  assert.equal(filtered.status, 200);
  assert.deepEqual(calls[0], { call: 'queue', tenant: hospital, who: user, filters: { status: 'open', kind: 'denial', needs_owner: true, overdue: true } });
  const summary = await request(`/api/workspace/${hospital}/triage`);
  assert.equal(summary.status, 200);
  assert.deepEqual(summary.body, { total: 3, open: 3, overdue: 0 });
  // An unfiltered queue read carries no filter object at all.
  await request(`/api/workspace/${hospital}/items`);
  assert.deepEqual(calls[2].filters, {});
});
