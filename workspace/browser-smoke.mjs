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
import { assertSyntheticTarget } from './synthetic-target.js';

const HARNESS = '1';
const hospitalId = '11111111-1111-4111-8111-111111111111';
const userId = '33333333-3333-4333-8333-333333333333';
const email = 'pilot@example.test';
const password = 'synthetic-pass';

function fail(message) { console.error(`FAIL ${message}`); process.exitCode = 1; }
function pass(message) { console.log(`ok ${message}`); }

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
  const runtimeUrl = process.env.DATABASE_URL;
  const ownerUrl = process.env.SEED_DATABASE_URL;
  if (!runtimeUrl || !ownerUrl) throw new Error('DATABASE_URL and SEED_DATABASE_URL are required');
  const harness = process.env.NIMBIR_SYNTHETIC_HARNESS === HARNESS;
  // Fail closed before any pool is created or any statement runs: explicit
  // flag plus exact allowlisted local disposable target (see synthetic-target.js).
  assertSyntheticTarget({ harness, runtimeUrl, ownerUrl });

  // Both pools are retained so the finally block can always end them, even
  // when setup itself fails partway.
  const owner = new pg.Pool({ connectionString: ownerUrl, max: 2 });
  const runtime = new pg.Pool({ connectionString: runtimeUrl, max: 4 });
  let app;
  let browser;
  try {
    await owner.query(`INSERT INTO nimbir.hospital (id, name) VALUES ($1, 'Synthetic Hospital Alpha') ON CONFLICT (id) DO NOTHING`, [hospitalId]);
    await owner.query(`INSERT INTO nimbir.hospital_member (hospital_id, user_id, role) VALUES ($1, $2, 'admin') ON CONFLICT DO NOTHING`, [hospitalId, userId]);
    await owner.query('TRUNCATE nimbir.work_item_audit, nimbir.work_item RESTART IDENTITY CASCADE');

    app = createApp({
      store: createStore(runtime),
      authenticate: async (token) => (token === 'synthetic-harness-token' ? userId : null),
      signIn: async (givenEmail, givenPassword) => (givenEmail === email && givenPassword === password ? 'synthetic-harness-token' : null),
    });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.address().port}`;

    const { chromium } = await loadPlaywright();
    browser = await chromium.launch({ args: ['--no-sandbox'] });
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
    if (browser) await browser.close().catch(() => {});
    if (app) await new Promise((resolve) => app.close(resolve));
    await runtime.end();
    await owner.end();
  }
}

await main();
if (process.exitCode) console.error('browser smoke failed');
else console.log('browser smoke passed');
