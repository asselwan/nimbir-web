'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fromX12Text, computeTotals } = require('./to-nimbir.js');

const FIX = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const SCHEMA_KEYS = ['claim_id', 'line_id', 'payer', 'payer_response', 'amount', 'currency',
  'denial_category', 'rcm_jev_classification', 'review_reason', 'review_drivers',
  'evidence_source', 'owner', 'last_update', 'state', 'next_action'];

test('fromX12Text() output matches the claim-lines.json row shape the UI already renders', () => {
  const result = fromX12Text(FIX('synthetic-cardio-paid-eval.835'), { fileName: 'paid-eval.835' });
  assert.equal(result.data_kind, 'uploaded_835');
  assert.ok(Array.isArray(result.claim_lines));
  for (const key of SCHEMA_KEYS) assert.ok(key in result.claim_lines[0], `missing key ${key}`);
  assert.match(result.source_note, /Nothing was uploaded to a server/);
});

test('93306+93320 and 93351+93015 CO-97 bundling denials land in Needs approval with the verified CARC text', () => {
  const rows = fromX12Text(FIX('synthetic-cardio-bundling-co97.835'), { fileName: 'bundling.835' }).claim_lines;
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.state, 'Needs approval');
    assert.equal(row.denial_category, 'CO-97');
    assert.match(row.review_reason, /benefit for this service is included in the payment\/allowance for another service/);
  }
  assert.deepEqual(rows.map(r => r.line_id), ['93306-26', '93320', '93351', '93015']);
});

test('93224-26 CO-4 modifier denial is Needs approval with the verified CARC text', () => {
  const rows = fromX12Text(FIX('synthetic-cardio-modifier-co4.835'), { fileName: 'co4.835' }).claim_lines;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'Needs approval');
  assert.equal(rows[0].line_id, '93224-26');
  assert.equal(rows[0].denial_category, 'CO-4');
  assert.match(rows[0].review_reason, /procedure code is inconsistent with the modifier used/);
});

test('99214-25 paid in full is Ready', () => {
  const rows = fromX12Text(FIX('synthetic-cardio-paid-eval.835'), { fileName: 'paid.835' }).claim_lines;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'Ready');
  assert.equal(rows[0].line_id, '99214-25');
  assert.equal(rows[0].amount, 150.00);
});

test('PR-1 deductible is Ready (patient responsibility, not a provider denial)', () => {
  const rows = fromX12Text(FIX('synthetic-cardio-deductible-pr1.835'), { fileName: 'pr1.835' }).claim_lines;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'Ready');
  assert.equal(rows[0].denial_category, 'PR-1');
});

test('a routine CO-45 partial payment is Needs review, distinct from a flagged denial', () => {
  const rows = fromX12Text(FIX('synthetic-cardio-partial-payment.835'), { fileName: 'partial.835' }).claim_lines;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'Needs review');
  assert.equal(rows[0].denial_category, 'CO-45');
});

test('a CLP02=22 reversal is Needs review and its PLB recoupment is cited in the review drivers', () => {
  const rows = fromX12Text(FIX('synthetic-cardio-reversal.835'), { fileName: 'reversal.835' }).claim_lines;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'Needs review');
  assert.match(rows[0].next_action, /reconcile this reversal/i);
});

test('echo CO-50 with RARC N115 denial is Needs approval and the remark code is explained in review_drivers', () => {
  const rows = fromX12Text(FIX('synthetic-cardio-lcd-co50.835'), { fileName: 'lcd.835' }).claim_lines;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'Needs approval');
  assert.equal(rows[0].denial_category, 'CO-50');
  assert.ok(rows[0].review_drivers.some(d => d.includes('N115') && d.includes('Local Coverage Determination')));
});

test('multi-ST file produces rows from both transaction sets', () => {
  const rows = fromX12Text(FIX('synthetic-cardio-multi-st.835'), { fileName: 'multi.835' }).claim_lines;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].claim_id, 'x12-CARDIO-0009');
  assert.equal(rows[0].state, 'Ready');
  assert.equal(rows[1].claim_id, 'x12-CARDIO-0010');
  assert.equal(rows[1].state, 'Needs approval');
});

test('a CARC code outside the verified list never gets an invented description', () => {
  // 59-row synthetic text reusing the paid fixture's envelope but with an unverified CARC.
  const text = FIX('synthetic-cardio-modifier-co4.835').replace('CAS*CO*4*180.00*~', 'CAS*CO*999*180.00*~');
  const rows = fromX12Text(text, { fileName: 'unverified.835' }).claim_lines;
  assert.equal(rows[0].denial_category, 'CO-999');
  assert.doesNotMatch(rows[0].review_reason, /:/); // no " — <description>" was appended for an unverified code
  assert.ok(rows[0].review_drivers.some(d => d.includes('not independently verified against x12.org')));
});

test('computeTotals(): denied $ sums only CO adjustments, grouped by CARC and by CPT', () => {
  const rows = fromX12Text(FIX('synthetic-cardio-bundling-co97.835'), { fileName: 'bundling.835' }).claim_lines;
  const totals = computeTotals(rows);
  assert.equal(totals.deniedTotal, 450 + 300 + 380 + 240);
  assert.equal(totals.byCARC['CO-97'], 450 + 300 + 380 + 240);
  assert.equal(totals.byCPT['93306'], 450);
  assert.equal(totals.byCPT['93320'], 300);
  assert.equal(totals.byCPT['93351'], 380);
  assert.equal(totals.byCPT['93015'], 240);
});

test('computeTotals(): a Ready (paid-in-full) line and a PR-only line contribute nothing to denied $', () => {
  const paid = fromX12Text(FIX('synthetic-cardio-paid-eval.835'), { fileName: 'paid.835' }).claim_lines;
  const pr = fromX12Text(FIX('synthetic-cardio-deductible-pr1.835'), { fileName: 'pr.835' }).claim_lines;
  assert.equal(computeTotals(paid).deniedTotal, 0);
  assert.equal(computeTotals(pr).deniedTotal, 0);
});

test('a payer-less 835 renders Blocked, matching app.js statusContract() payer-missing text', () => {
  const text = FIX('synthetic-cardio-paid-eval.835').replace('N1*PR*SYNTHETIC CARDIOLOGY PAYER CO~\n', '');
  const rows = fromX12Text(text, { fileName: 'no-payer.835' }).claim_lines;
  assert.equal(rows[0].payer, 'Not present in source');
  assert.equal(rows[0].state, 'Blocked');
});
