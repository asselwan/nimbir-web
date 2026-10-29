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
