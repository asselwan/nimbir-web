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

test('flooding with distinct emails does not lock out a legitimate account', async () => {
  const app = createApp({
    authenticate: async () => null,
    signIn: async () => null,
    store: {},
  });
  function signIn(email) {
    return new Promise((resolve) => {
      const incoming = Readable.from([JSON.stringify({ email, password: 'wrong' })]);
      incoming.method = 'POST'; incoming.url = '/api/workspace/sign-in'; incoming.headers = {};
      const outgoing = { writeHead(status) { this.status = status; }, end(body) { resolve({ status: this.status, body: JSON.parse(body) }); } };
      app.emit('request', incoming, outgoing);
    });
  }
  for (let index = 0; index < 5200; index += 1) {
    assert.equal((await signIn(`flood-${index}@example.test`)).status, 401);
  }
  // A real account signing in after the flood must still be throttled on its own
  // failures, not because the flood filled the throttle table.
  const codes = [];
  for (let attempt = 0; attempt < 6; attempt += 1) codes.push((await signIn('real@example.test')).status);
  assert.deepEqual(codes.slice(0, 5), [401, 401, 401, 401, 401]);
  assert.equal(codes[5], 429);
});
