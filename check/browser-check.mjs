import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/home/ainur/Apps/twothumbs/node_modules/playwright/index.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const shotDir = process.env.SHOT_DIR ?? '/home/ainur/Apps/.ainur/review/UV_NIMBIR_prm_d6f2caa2/after';
const stripe = 'https://buy.nomoi.ai/nimbir/revenue_floor';
const result = '#denial-check-result';
const lcd = join(root, 'x12/fixtures/synthetic-cardio-lcd-co50.835');

function serverUrl(server) {
  return new Promise((resolve, reject) => {
    let output = '';
    server.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/port (\d+)/);
      if (match) resolve('http://127.0.0.1:' + match[1] + '/');
    });
    server.on('error', reject);
    server.on('exit', code => reject(new Error('Static server exited with code ' + code)));
  });
}

async function assertWidth(page, width) {
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(scrollWidth <= width, 'Page scroll width ' + scrollWidth + ' exceeds viewport ' + width);
}

async function checkViewport(browser, url, width) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
  try {
    const featureRequests = [];
    page.on('request', request => {
      const pathname = new URL(request.url()).pathname;
      if (pathname === '/appeals/codes.json' || pathname.startsWith('/x12/fixtures/')) {
        featureRequests.push(pathname);
      }
    });
    await page.goto(url, { waitUntil: 'load' });
    const bundling = page.locator('#denial-check button[data-scenario="bundling-co97"]');
    assert.equal(await page.locator(result).innerHTML(), '');
    await assertWidth(page, width);
    await page.screenshot({ path: join(shotDir, 'denial-check-' + width + '-fold.png') });

    await bundling.scrollIntoViewIfNeeded();
    const start = performance.now();
    await bundling.click();
    const cards = page.locator(result + ' .dc-card');
    await cards.first().waitFor();
    console.log('TTFV_MS ' + Math.round(performance.now() - start) + ' viewport=' + width);
    assert.equal(await cards.count(), 4);
    assert.match(await page.locator(result + ' h3').textContent(), /\$1,370\.00 denied across 4 lines/);
    assert.equal(await page.locator(result + ' h3').evaluate(el => el === document.activeElement), true);
    assert.equal(await page.locator(result + ' .dc-badge').textContent(), 'Synthetic data. No real patient.');
    assert.equal(await page.getByRole('link', { name: 'Start Revenue Floor, USD 199/month' }).getAttribute('href'), stripe);
    assert.equal(await bundling.getAttribute('aria-pressed'), 'true');
    assert.ok((await bundling.boundingBox()).height >= 44);
    await assertWidth(page, width);
    await page.locator(result).screenshot({ path: join(shotDir, 'denial-check-' + width + '-result.png') });

    const summary = cards.first().locator('summary');
    await summary.focus();
    await summary.press('Space');
    await cards.first().locator('pre mark').first().waitFor();
    await assertWidth(page, width);
    await page.getByRole('link', { name: 'Run it on your own 835' }).click();
    const input = page.locator('#denial-check-file');
    assert.equal(await input.evaluate(el => el === document.activeElement), true);

    const requestsBeforeOwnFile = featureRequests.length;
    await input.setInputFiles(lcd);
    await cards.first().getByText('CO-50', { exact: true }).waitFor();
    assert.equal(await cards.count(), 1);
    assert.match(await cards.first().textContent(), /RARC N115/);
    assert.match(await cards.first().textContent(), /chart-sourced medical necessity narrative/);
    assert.equal(await page.locator(result + ' .dc-badge').count(), 0);
    assert.equal(await bundling.getAttribute('aria-pressed'), 'false');
    assert.equal(featureRequests.length, requestsBeforeOwnFile);
    await assertWidth(page, width);

    const unknown = page.getByRole('button', { name: 'Contractual write-off (CO-45)' });
    await unknown.focus();
    await unknown.press('Enter');
    await cards.first().getByText('CO-45', { exact: true }).waitFor();
    assert.match(await cards.first().textContent(), /not in the verified rule set/);
    assert.equal(await cards.first().locator('details').count(), 0);

    await page.getByRole('button', { name: 'Payment reversal' }).click();
    await page.getByRole('heading', { name: 'No provider denials in this file.' }).waitFor();
    assert.equal(await cards.count(), 0);

    await input.setInputFiles({ name: 'malformed.835', mimeType: 'text/plain', buffer: Buffer.from('bad input') });
    await page.getByText(/Could not check “malformed\.835”/).waitFor();
    await page.locator('[data-dc-run]').click();
    await cards.first().getByText('CO-97', { exact: true }).waitFor();
    assert.equal(await cards.count(), 4);
    assert.equal(featureRequests.filter(path => path === '/appeals/codes.json').length, 1);
    await assertWidth(page, width);
  } finally {
    await page.close();
  }
}

await mkdir(shotDir, { recursive: true });
const server = spawn('python3', ['-u', '-m', 'http.server', '0', '--bind', '127.0.0.1'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'ignore']
});
let browser;
try {
  const url = await serverUrl(server);
  browser = await chromium.launch();
  for (const width of [390, 1440]) await checkViewport(browser, url, width);
  console.log('DC_BROWSER_OK');
} finally {
  server.kill();
  await browser?.close();
}
