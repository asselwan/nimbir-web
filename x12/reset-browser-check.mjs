import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.NIMBIR_STATIC_ROOT || fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
  ({ chromium } = require('/home/ainur/Apps/twothumbs/node_modules/playwright-core'));
}

const fixture = await readFile(join(root, 'x12/fixtures/synthetic-cardio-modifier-co4.835'));
assert.ok(fixture.includes('SYNTHETICNIMBIR'));
const server = spawn('python3', ['-u', '-m', 'http.server', '0', '--bind', '127.0.0.1'], {
  cwd: root, stdio: ['ignore', 'pipe', 'ignore']
});
const results = [];
const input = '#x12-file-input';
let browser;
let origin;

function serverAddress() {
  return new Promise((resolve, reject) => {
    let output = '';
    server.stdout.on('data', chunk => {
      output += chunk;
      const port = output.match(/port (\d+)/);
      if (port) resolve('http://127.0.0.1:' + port[1]);
    });
    server.once('error', reject);
    server.once('exit', code => reject(new Error('Static server exited with code ' + code)));
  });
}

async function waitForInput(page) {
  const session = await page.context().newCDPSession(page);
  try {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const node = await session.send('Runtime.evaluate', { expression: "document.querySelector('#x12-file-input')" });
      if (node.result.objectId) {
        const events = await session.send('DOMDebugger.getEventListeners', {objectId: node.result.objectId});
        if (events.listeners.some(event => event.type === 'change')) return;
      }
      await page.waitForTimeout(60);
    }
    throw new Error('File input did not become ready');
  } finally {
    await session.detach();
  }
}

async function scenario(name, run, setup) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    await context.route(url => url.origin !== origin, route => route.abort());
    if (setup) await setup(page);
    await page.goto(origin, {waitUntil: 'domcontentloaded'});
    await waitForInput(page);
    await run(page, context);
    results.push({name, passed: true});
  } catch (error) {
    results.push({name, passed: false, error: error.name, detail: error.message.split('\n')[0].slice(0, 160)});
  } finally {
    await context.close();
  }
}

async function upload(page, name = 'synthetic-test.835') {
  await page.locator(input).setInputFiles({name, mimeType: 'text/plain', buffer: fixture});
  await page.waitForFunction(file => {
    const status = document.querySelector('#x12-drop-status').textContent;
    return status.includes('1 claim line(s) from "' + file + '"');
  }, name);
  assert.equal(await page.locator('#rows tr').count(), 1);
}

async function snapshot(page) {
  return {
    ids: await page.locator('#rows .claim-id').allTextContents(),
    source: await page.locator('[data-source-label]').allTextContents()
  };
}

async function defaultReady(page) {
  await page.waitForFunction(() =>
    document.querySelectorAll('#rows .claim-id').length > 1 &&
    Array.from(document.querySelectorAll('[data-source-label]')).some(el => /demo purposes/i.test(el.textContent))
  );
}

try {
  origin = await serverAddress();
  browser = await chromium.launch({headless: true, executablePath: process.env.TEST_CHROME || '/usr/bin/google-chrome'});

  await scenario('cached default restores the original rows and source label offline', async (page, context) => {
    await defaultReady(page);
    const original = await snapshot(page);
    await context.setOffline(true);
    await upload(page);
    await page.locator('#x12-drop-reset').click();
    await defaultReady(page);
    assert.deepEqual(await snapshot(page), original);
  });

  let pendingDefault;
  await scenario('delayed default leaves a newer remittance selected', async page => {
    await page.locator('#queue').scrollIntoViewIfNeeded();
    const deadline = Date.now() + 7000;
    while (!pendingDefault && Date.now() < deadline) await page.waitForTimeout(30);
    assert.ok(pendingDefault, 'The page requested the default dataset');
    await upload(page);
    const uploaded = await snapshot(page);
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/claim-lines.json');
    await pendingDefault.continue();
    await (await response).finished();
    await page.waitForTimeout(200);
    assert.deepEqual(await snapshot(page), uploaded);
    await page.locator('#x12-drop-reset').click();
    await defaultReady(page);
  }, page => page.route('**/claim-lines.json', route => { pendingDefault = route; }));

  let attempts = 0;
  await scenario('retry requests a fresh default after a 503', async page => {
    await page.locator('#retry-load').click();
    await defaultReady(page);
    assert.equal(attempts, 2);
  }, page => page.route('**/claim-lines.json', route => {
    attempts++;
    if (attempts === 1) return route.fulfill({status: 503, body: 'temporarily unavailable'});
    return route.continue();
  }));

  await scenario('an older file read cannot overwrite the newest selection', async page => {
    await defaultReady(page);
    await page.locator(input).setInputFiles({name: 'slow.835', mimeType: 'text/plain', buffer: fixture});
    await upload(page, 'newer.835');
    await page.waitForTimeout(750);
    assert.match(await page.locator('#x12-drop-status').innerText(), /newer\.835/);
    assert.ok((await snapshot(page)).source.every(label => label.includes('newer.835')));
  }, page => page.addInitScript(() => {
    const read = FileReader.prototype.readAsText;
    FileReader.prototype.readAsText = function (file, ...args) {
      if (file.name === 'slow.835') {
        setTimeout(() => read.call(this, file, ...args), 450);
      } else {
        read.call(this, file, ...args);
      }
    };
  }));
} finally {
  try { await browser?.close(); } finally { server.kill(); }
}
const passed = results.filter(result => result.passed).length;
console.log(JSON.stringify({runs: results, passed, total: results.length}));
if (passed !== results.length) process.exitCode = 1;
