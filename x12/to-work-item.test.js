'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fromX12Text } = require('./to-nimbir.js');
const { toWorkItems } = require('./to-work-item.js');

const FIX = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('synthetic 835 denial rows become staff work items with deterministic references and a review due time', () => {
  const rows = fromX12Text(FIX('synthetic-cardio-bundling-co97.835'), { fileName: 'synthetic.835' }).claim_lines;
  const items = toWorkItems(rows, { sourceId: 'CARDIO-CO97', now: '2026-11-03T12:00:00Z' });

  assert.equal(items.length, 4);
  assert.deepEqual(items[0], {
    kind: 'denial',
    source_ref: 'SYN-CARDIO-CO97-001',
    title: 'Synthetic 93306-26 · CO-97 — Review the CO-97 denial reason and supporting documentation, then decide whether to appeal.',
    status: 'open',
    sla_due_at: '2026-11-06T12:00:00.000Z',
  });
  assert.deepEqual(items.map((item) => item.source_ref), [
    'SYN-CARDIO-CO97-001',
    'SYN-CARDIO-CO97-002',
    'SYN-CARDIO-CO97-003',
    'SYN-CARDIO-CO97-004',
  ]);
  for (const item of items) {
    assert.equal(item.title.startsWith('Synthetic '), true);
    assert.equal(item.title.length <= 200, true);
    assert.equal('patient_name' in item, false);
    assert.equal('claim_id' in item, false);
  }
});

test('paid lines do not create avoidable staff work', () => {
  const rows = fromX12Text(FIX('synthetic-cardio-paid-eval.835')).claim_lines;
  assert.deepEqual(toWorkItems(rows, { sourceId: 'CARDIO-PAID', now: '2026-11-03T12:00:00Z' }), []);
});
