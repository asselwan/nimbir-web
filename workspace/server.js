import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createStore, HttpError } from './store.js';

const dir = fileURLToPath(new URL('.', import.meta.url));
const assets = new Map([
  ['/workspace', ['index.html', 'text/html; charset=utf-8']],
  ['/workspace/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/workspace/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

export function createApp({ store, authenticate, signIn, now = () => Date.now() }) {
  // Failed sign-in attempts are throttled per account+client and, separately,
  // per client address. Without this the sign-in endpoint is an unthrottled
  // password oracle.
  const failures = new Map();
  const clientFailures = new Map();
  const windowMs = 10 * 60 * 1000;
  const maxFailures = 5;
  // A client-wide budget that key churn (varying the email) cannot reset: the
  // per-key table may evict, but a single address cannot buy fresh budget by
  // inventing account names.
  const maxClientFailures = 100;
  // The throttle must not become the attack surface: an attacker who varies the
  // email would otherwise grow this map without limit.
  const maxTrackedKeys = 5000;
  function expire(map, at) {
    for (const [other, record] of map) if (at - record.first >= windowMs) map.delete(other);
  }
  function bump(map, key, at) {
    const record = map.get(key);
    if (!record || at - record.first >= windowMs) map.set(key, { count: 1, first: at });
    else record.count += 1;
    while (map.size > maxTrackedKeys) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [other, entry] of map) if (entry.first < oldestAt) { oldestAt = entry.first; oldestKey = other; }
      if (oldestKey === null) break;
      map.delete(oldestKey);
    }
  }
  // Reserving BEFORE the credential check is what closes the concurrent bypass:
  // every in-flight attempt is counted the moment it arrives, so ten parallel
  // wrong passwords cannot all pass a check that only sees recorded failures.
  function reserveAttempt(key, client) {
    const at = now();
    expire(failures, at);
    expire(clientFailures, at);
    if ((clientFailures.get(client)?.count || 0) >= maxClientFailures) throw new HttpError(429, 'Too many sign-in attempts');
    if ((failures.get(key)?.count || 0) >= maxFailures) throw new HttpError(429, 'Too many sign-in attempts');
    bump(failures, key, at);
    bump(clientFailures, client, at);
  }
  function releaseAttempt(key, client) {
    const clientRecord = clientFailures.get(client);
    if (clientRecord && (clientRecord.count -= 1) <= 0) clientFailures.delete(client);
    const keyRecord = failures.get(key);
    if (keyRecord && (keyRecord.count -= 1) <= 0) failures.delete(key);
  }
  return createServer(async (request, response) => {
    const send = (status, data) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(data));
    };
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (request.method === 'GET' && assets.has(path)) {
        const [file, type] = assets.get(path);
        response.writeHead(200, { 'content-type': type, 'content-security-policy': "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'" });
        response.end(await readFile(new URL(file, `file://${dir}`)));
        return;
      }
      if (!path.startsWith('/api/workspace/')) throw new HttpError(404, 'Not found');
      if (path === '/api/workspace/sign-in' && request.method === 'POST') {
        let raw = '';
        for await (const chunk of request) {
          raw += chunk;
          if (raw.length > 4096) throw new HttpError(413, 'Request too large');
        }
        let credentials;
        try { credentials = JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON'); }
        if (!credentials || typeof credentials.email !== 'string' || typeof credentials.password !== 'string' || credentials.email.length > 320 || credentials.password.length > 1024) throw new HttpError(400, 'Email and password required');
        const client = request.socket?.remoteAddress || '';
        const key = `${credentials.email.toLowerCase()}|${client}`;
        reserveAttempt(key, client);
        const accessToken = await signIn(credentials.email, credentials.password);
        if (!accessToken) throw new HttpError(401, 'Sign-in failed');
        releaseAttempt(key, client);
        return send(200, { access_token: accessToken });
      }
      const token = /^Bearer (\S+)$/.exec(request.headers.authorization || '')?.[1];
      if (!token) throw new HttpError(401, 'Bearer token required');
      const userId = await authenticate(token);
      if (!userId) throw new HttpError(401, 'Invalid token');
      const parts = path.slice('/api/workspace/'.length).split('/');
      if (request.method === 'GET' && parts[0] === 'hospitals' && parts.length === 1) return send(200, await store.hospitals(userId));
      const hospitalId = parts[0];
      if (parts[1] !== 'items') throw new HttpError(404, 'Not found');
      if (request.method === 'GET' && parts.length === 2) return send(200, await store.queue(hospitalId, userId));
      if (request.method === 'GET' && parts.length === 4 && parts[3] === 'audit') return send(200, await store.audit(hospitalId, userId, parts[2]));
      let body;
      if (request.method === 'POST' || request.method === 'PATCH') {
        let raw = '';
        for await (const chunk of request) {
          raw += chunk;
          if (raw.length > 16384) throw new HttpError(413, 'Request too large');
        }
        try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON'); }
      }
      if (request.method === 'POST' && parts.length === 2) return send(201, await store.create(hospitalId, userId, body));
      if (request.method === 'PATCH' && parts.length === 3) return send(200, await store.update(hospitalId, userId, parts[2], body));
      throw new HttpError(404, 'Not found');
    } catch (error) {
      send(error.status || 500, { error: error.status ? error.message : 'Internal error' });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  const [{ createClient }, { default: pg }] = await Promise.all([import('@supabase/supabase-js'), import('pg')]);
  for (const key of ['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY']) {
    if (!process.env[key]) throw new Error(`${key} required`);
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const app = createApp({
    store: createStore(pool),
    authenticate: async (token) => {
      const { data, error } = await supabase.auth.getUser(token);
      return error ? null : data.user?.id;
    },
    signIn: async (email, password) => {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      return error ? null : data.session?.access_token;
    },
  });
  app.listen(Number(process.env.PORT || 3001), '0.0.0.0');
}
