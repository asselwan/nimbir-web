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

export function createApp({ store, authenticate, signIn }) {
  return createServer(async (request, response) => {
    const send = (status, data) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(data));
    };
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (request.method === 'GET' && assets.has(path)) {
        const [file, type] = assets.get(path);
        response.writeHead(200, { 'content-type': type, 'content-security-policy': "default-src 'self'; connect-src 'self' https:; script-src 'self'; style-src 'self'; base-uri 'none'" });
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
        const accessToken = await signIn(credentials.email, credentials.password);
        if (!accessToken) throw new HttpError(401, 'Sign-in failed');
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
