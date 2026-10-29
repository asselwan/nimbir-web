// Synthetic local browser smoke for the hospital workspace.
//
// WHAT THIS IS: a test double for Supabase Auth only. It boots the real
// createApp() HTTP service and the real store against the migrated staging
// database, but replaces the identity provider with a fixed synthetic user so
// the browser flow can be driven without a Supabase account.
//
// GUARD: it refuses to run unless NIMBIR_SYNTHETIC_HARNESS=1 is set, it binds
// loopback only, and it lives under workspace/ which the Docker build
// (.dockerignore) never publishes. It must never be wired into a deployment.
//
// Usage:
//   NIMBIR_SYNTHETIC_HARNESS=1 \
//   DATABASE_URL=postgresql://nimbir_workspace_runtime:...@127.0.0.1:55433/nimbir_workspace_staging \
//   SEED_DATABASE_URL=postgresql://postgres:...@127.0.0.1:55433/nimbir_workspace_staging \
//   node workspace/browser-smoke.mjs

import pg from 'pg';
import { createStore } from './store.js';
import { createApp } from './server.js';

const HARNESS = '1';
const hospitalId = '11111111-1111-4111-8111-111111111111';
const userId = '33333333-3333-4333-8333-333333333333';
const email = 'pilot@example.test';
const password = 'synthetic-pass';

function fail(message) { console.error(`FAIL ${message}`); process.exitCode = 1; }
function pass(message) { console.log(`ok ${message}`); }

function databaseName(url) {
  try { return decodeURIComponent(new URL(url).pathname.replace(/^\//, '')); } catch { return ''; }
}

// This harness truncates the workspace tables, so it refuses to touch anything
// that is not recognisably a disposable synthetic database.
function assertSyntheticTarget(runtime, owner) {
  const name = databaseName(runtime);
  if (!name || name !== databaseName(owner)) throw new Error(`refusing to truncate: runtime database ${name || 'unknown'} and owner database ${databaseName(owner) || 'unknown'} differ`);
  if (!/(synthetic|staging|test)/i.test(name)) throw new Error(`refusing to truncate database "${name}": the name does not look like a disposable synthetic database`);
  return name;
}

// Playwright is a harness-only dependency and is deliberately not in package.json.
// Look for it in the usual places instead of assuming one machine's layout.
async function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright', '/home/ainur/Apps/twothumbs/node_modules/playwright/index.mjs'].filter(Boolean);
  for (const candidate of candidates) {
    try { return await import(candidate); } catch { /* try the next location */ }
  }
  throw new Error('playwright not found: install it or set PLAYWRIGHT_MODULE to an importable module path');
}

async function main() {
  if (process.env.NIMBIR_SYNTHETIC_HARNESS !== HARNESS) throw new Error('refusing to run without NIMBIR_SYNTHETIC_HARNESS=1');
  const runtimeUrl = process.env.DATABASE_URL;
  const ownerUrl = process.env.SEED_DATABASE_URL;
  if (!runtimeUrl || !ownerUrl) throw new Error('DATABASE_URL and SEED_DATABASE_URL are required');

  const owner = new pg.Pool({ connectionString: ownerUrl, max: 2 });
  assertSyntheticTarget(runtimeUrl, ownerUrl);
  await owner.query(`INSERT INTO nimbir.hospital (id, name) VALUES ($1, 'Synthetic Hospital Alpha') ON CONFLICT (id) DO NOTHING`, [hospitalId]);
  await owner.query(`INSERT INTO nimbir.hospital_member (hospital_id, user_id, role) VALUES ($1, $2, 'admin') ON CONFLICT DO NOTHING`, [hospitalId, userId]);
  await owner.query('TRUNCATE nimbir.work_item_audit, nimbir.work_item RESTART IDENTITY CASCADE');

  const app = createApp({
    store: createStore(new pg.Pool({ connectionString: runtimeUrl, max: 4 })),
    authenticate: async (token) => (token === 'synthetic-harness-token' ? userId : null),
    signIn: async (givenEmail, givenPassword) => (givenEmail === email && givenPassword === password ? 'synthetic-harness-token' : null),
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(`${base}/workspace`, { waitUntil: 'load' });
    pass('workspace page loaded');

    await page.fill('#email', email);
    await page.fill('#password', password);
    await page.click('#connect button');
    await page.waitForFunction(() => document.querySelector('#hospital')?.options.length > 0, null, { timeout: 15000 });
    const hospitalName = await page.$eval('#hospital', (node) => node.options[0].textContent);
    if (hospitalName !== 'Synthetic Hospital Alpha') fail(`hospital option was ${hospitalName}`);
    else pass(`signed in and loaded membership: ${hospitalName}`);

    await page.waitForSelector('#items tr', { timeout: 15000 }).catch(() => {});
    // Create one synthetic item through the API the page uses.
    await page.evaluate(async ([hospital]) => {
      await fetch(`/api/workspace/${hospital}/items`, {
        method: 'POST',
        headers: { authorization: 'Bearer synthetic-harness-token', 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'denial', source_ref: 'SYN-BROWSER-1', title: 'Synthetic browser item', sla_due_at: '2026-12-01T09:00:00Z' }),
      });
    }, [hospitalId]);
    await page.click('#refresh');
    await page.waitForFunction(() => document.querySelectorAll('#items tr').length === 1, null, { timeout: 15000 });
    pass('created one synthetic item and the queue rendered one row');

    await page.selectOption('#items tr select', 'in_progress');
    await page.waitForFunction(() => document.querySelector('#items tr select')?.value === 'in_progress', null, { timeout: 15000 });
    pass('status change persisted through the API');

    await page.click('#items tr button');
    await page.waitForSelector('dialog[open] pre', { timeout: 15000 });
    const history = await page.$eval('dialog[open] pre', (node) => node.textContent);
    const actions = JSON.parse(history).map((row) => row.action);
    if (actions.join(',') !== 'created,updated') fail(`audit history was ${actions.join(',')}`);
    else pass(`audit history shows ${actions.join(',')}`);

    await page.reload({ waitUntil: 'load' });
    const signedOut = await page.$eval('#workspace', (node) => node.hasAttribute('hidden'));
    if (!signedOut) fail('page kept the session after reload');
    else pass('reload requires sign-in again (token is memory only)');

    if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
    else pass('no page errors');
  } finally {
    await browser.close();
    await new Promise((resolve) => app.close(resolve));
    await owner.end();
  }
}

await main();
if (process.exitCode) console.error('browser smoke failed');
else console.log('browser smoke passed');
