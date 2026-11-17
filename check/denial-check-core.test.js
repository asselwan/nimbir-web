const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { parse835 } = require('../x12/parse835.js');
const { compose } = require('../appeals/compose.js');
const { assertGrounded } = require('../appeals/grounding-helper.js');
const codes = require('../appeals/codes.json');
const { analyze } = require('./denial-check-core.js');

const fixtures = path.join(__dirname, '../x12/fixtures');
const readFixture = slug => readFileSync(path.join(fixtures, 'synthetic-cardio-' + slug + '.835'), 'utf8');
const check = text => analyze(parse835(text), codes);
const fixture = slug => check(readFixture(slug));

test('bundled echo denies four lines and requires the PTP indicator', () => {
  const result = fixture('bundling-co97');
  assert.equal(result.findings.length, 4);
  assert.equal(result.deniedTotal, 1370);
  assert.deepEqual(result.byRoute.corrected_claim, { count: 4, amount: 1370 });
  assert.equal(result.needsCount, 4);
  assert.equal(result.payer, 'SYNTHETIC CARDIOLOGY PAYER CO');
  assert.equal(result.payee, 'SYNTHETIC CARDIOLOGY ASSOCIATES');
  for (const finding of result.findings) {
    assert.equal(finding.route, 'corrected_claim');
    assert.ok(finding.preflight.some(row => row.check === 'ptp_modifier_indicator_known' && !row.pass));
    assert.equal(finding.carcText, codes.carc['97'].text);
  }
  assert.deepEqual(result.findings[1].composeInput, {
    claim: {
      payer: result.payer,
      lines: [{ cpt: '93306', dos: '2026-08-15' }, { cpt: '93320', dos: '2026-08-15' }]
    },
    denial: { group: 'CO', carc: '97', rarc: null }
  });
});

test('modifier mismatch routes to reopening', () => {
  const [finding] = fixture('modifier-co4').findings;
  assert.equal(finding.route, 'reopening');
  assert.ok(finding.modifiers.length);
});

test('LCD routes to the clinician with N115 and a request for the missing narrative', () => {
  const [finding] = fixture('lcd-co50').findings;
  assert.equal(finding.route, 'documentation_query');
  assert.equal(finding.rarc, 'N115');
  assert.equal(finding.rarcText, codes.rarc.N115.text);
  assert.ok(finding.missing.some(item => /medical necessity narrative/i.test(item)));
  assert.ok(!Object.hasOwn(finding.composeInput.claim, 'medical_necessity_narrative'));
  assert.ok(!Object.hasOwn(finding.composeInput, 'citation'));
});

test('the CO-45 adjustment has no verified description or draft', () => {
  assert.ok(!Object.hasOwn(codes.carc, '45'));
  const [finding] = fixture('partial-payment').findings;
  assert.equal(finding.route, 'human_triage');
  assert.equal(finding.letter, null);
  assert.equal(finding.carcText, null);
  assert.equal(finding.composeInput, null);
});

for (const slug of ['paid-eval', 'deductible-pr1']) {
  test(slug + ' has zero provider denial findings', () => {
    const result = fixture(slug);
    assert.equal(result.findings.length, 0);
    assert.equal(result.deniedTotal, 0);
    assert.deepEqual(result.unmatched, []);
  });
}

test('multi-ST counts both claims but only reports the denied transaction', () => {
  const result = fixture('multi-st');
  assert.equal(result.claims, 2);
  assert.equal(result.lines, 2);
  assert.deepEqual(result.findings.map(finding => finding.claimRef), ['CARDIO-0010']);
  assert.equal(result.deniedTotal, 180);
});

test('the reversal has no CO adjustment and status 22, so both lists are empty', () => {
  const result = fixture('reversal');
  assert.equal(result.claims, 1);
  assert.equal(result.findings.length, 0);
  assert.deepEqual(result.unmatched, []);
  assert.equal(result.deniedTotal, 0);
});

for (const name of readdirSync(fixtures).filter(name => name.endsWith('.835'))) {
  test(name + ' conserves amounts and contains only grounded drafts', () => {
    const result = check(readFileSync(path.join(fixtures, name), 'utf8'));
    assert.equal(result.findings.reduce((sum, finding) => sum + finding.amount, 0), result.deniedTotal);
    for (const finding of result.findings) {
      assert.doesNotMatch(JSON.stringify(finding), /recal[l]|probability|recover/i);
      if (!finding.letter) continue;
      const composed = compose(finding.composeInput, codes);
      assertGrounded({ sentences: composed.sentences, letter_markdown: finding.letter }, finding.composeInput, codes);
      assert.equal(finding.letter, composed.letter_markdown);
      assert.equal(finding.sentenceCount, composed.sentences.length);
      assert.equal(finding.citedCount, composed.sentences.filter(sentence => sentence.source_ref !== 'missing_input').length);
    }
  });
}

test('claim-level CO is reported once when there is no SVC, and PR-only denials are unmatched', () => {
  const original = readFixture('lcd-co50');
  const claimLevel = original.replace(/^SVC.*~\nDTM\*472.*~\n/m, '');
  const result = check(claimLevel);
  assert.equal(result.lines, 0);
  assert.equal(result.totals.deniedLines, 1);
  assert.equal(result.findings.length, 1);
  const [finding] = result.findings;
  assert.equal(finding.cpt, null);
  assert.equal(finding.dos, '2026-09-05');
  assert.equal(finding.rarc, 'N115');
  assert.deepEqual(finding.composeInput.claim.lines, []);
  const unmatched = check(claimLevel.replace('CAS*CO*50', 'CAS*PR*50'));
  assert.equal(unmatched.findings.length, 0);
  assert.deepEqual(unmatched.unmatched, [{ claimRef: 'CARDIO-0008' }]);
});

test('multiple CO codes on one line count as one denied line and repeated CARCs sum in cents', () => {
  const result = check(readFixture('lcd-co50').replace('CAS*CO*50*300.00*~',
    'CAS*CO*50*0.10**50*0.20**45*0.11*~'));
  assert.deepEqual(result.findings.map(finding => [finding.carc, finding.amount]), [['50', 0.30], ['45', 0.11]]);
  assert.equal(result.deniedTotal, 0.41);
  assert.equal(result.totals.deniedLines, 1);
  assert.equal(result.needsCount, 1);
});

test('deadlines use BPR16 only, even when other dates are present', () => {
  const original = readFixture('lcd-co50').replace('CAS*CO*50', 'CAS*CO*29');
  const [undated] = check(original).findings;
  assert.ok(!Object.hasOwn(undated.composeInput.claim, 'remit_date'));
  assert.match(undated.letter, /\[NEEDS: the remittance date/);

  const bpr = ['BPR', 'H', '0.00', '', 'NON', ...Array(11).fill(''), '20261009'].join('*');
  const [dated] = check(original.replace(/^BPR[^~]+/m, bpr)).findings;
  assert.equal(dated.composeInput.claim.remit_date, '2026-10-09');
  assert.match(dated.letter, /due no later than 2027-02-06/);
  assert.ok(dated.preflight.some(row => row.check === 'within_120_day_redetermination_window' &&
    row.detail.includes('Deadline 2027-02-06')));
});
