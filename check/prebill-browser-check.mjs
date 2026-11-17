import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/home/ainur/Apps/twothumbs/node_modules/playwright/index.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const shotDir = process.env.SHOT_DIR ?? '/home/ainur/Apps/.ainur/review/UV_NIMBIR_prm_d6f2caa2/after';
const result = '#prebill-result';
const resultTitle = result + ' .pb-result-title';

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
  const requests = [];
  page.on('request', request => requests.push({ method: request.method(), url: request.url() }));

  try {
    await page.goto(url, { waitUntil: 'load' });
    assert.equal(await page.locator(result).innerHTML(), '');

    await page.locator('#prebill-check [data-example="ecg-holter"]').click();
    const cards = page.locator(result + ' .pb-card');
    await cards.first().waitFor();
    assert.equal(await cards.count(), 1);
    const card = await cards.first().textContent();
    assert.match(card, /93000/);
    assert.match(card, /93224/);
    assert.equal(await cards.first().locator('.pb-indicator-details').evaluate(el => el.open), width > 480);

    const miss = page.locator(result + ' details.pb-miss');
    const heading = page.locator(resultTitle);
    assert.equal(await miss.count(), 0);
    assert.equal(await heading.evaluate(el => el === document.activeElement), true);
    await assertWidth(page, width);

    const ecgTitle = await heading.textContent();
    await page.locator('#prebill-check [data-example="echo-doppler"]').click();
    await page.waitForFunction(({ selector, previous }) => {
      const title = document.querySelector(selector);
      return Boolean(title && title.textContent !== previous);
    }, { selector: resultTitle, previous: ecgTitle });
    await miss.waitFor();
    assert.equal(await cards.count(), 1, 'echo example: one pair (93350/93306) is in the table');
    assert.match(await miss.textContent(), /not the same as clean/);
    assert.match(await miss.textContent(), /93306 \/ 93325/);
    assert.equal(await miss.evaluate(el => el.open), width >= 700);
    await assertWidth(page, width);

    await page.locator('#prebill-check').screenshot({ path: join(shotDir, 'prebill-' + width + '.png') });
  } finally {
    await page.close();
  }

  const tableUrl = new URL('data/ptp-table.json', url).href;
  assert.equal(requests.filter(request => request.method === 'GET' && request.url === tableUrl).length, 1);
  for (const request of requests) {
    if (request.method !== 'GET') {
      assert.equal(new URL(request.url).hostname, 'ingest.atlas.nomoi.ai', 'Unexpected ' + request.method + ' ' + request.url);
    }
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
  console.log('PB_BROWSER_OK');
} finally {
  server.kill();
  await browser?.close();
}
