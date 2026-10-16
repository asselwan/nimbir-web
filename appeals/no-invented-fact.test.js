'use strict';
/*
 * Dedicated no-invented-fact test: proves compose() cannot smuggle in a fact
 * (a date, a code description, a clinical detail) that the caller did not
 * supply and that is not a fixed, inspectable boilerplate string. It attacks
 * this from both directions:
 *   1. Deliberately starve the input of every optional field and check that
 *      every resulting gap renders as a [NEEDS: ...] placeholder, never a
 *      guess.
 *   2. Corrupt codes.json's own text for one CARC at a time and confirm the
 *      letter's quoted text changes in lock-step (i.e. the letter is really
 *      re-quoting codes.json at call time, not a hard-coded string that
 *      happens to currently match it).
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var { compose, loadDefaultCodes, ROUTES } = require('./compose.js');
var { assertGrounded } = require('./grounding-helper.js');

var codes = loadDefaultCodes();

var MINIMAL_FIXTURES = [
  { denial: { group: 'CO', carc: '97' } },
  { denial: { group: 'CO', carc: '236' } },
  { denial: { group: 'CO', carc: '4' } },
  { denial: { group: 'CO', carc: '15' } },
  { denial: { group: 'CO', carc: '18' } },
  { denial: { group: 'CO', carc: '119' } },
  { denial: { group: 'CO', carc: '29' } },
  { denial: { group: 'CO', carc: '50', rarc: 'N115' } },
  { denial: { group: 'CO', carc: '151', rarc: 'N362' } },
  { denial: { group: 'CO', carc: '197' } }
];

test('no-invented-fact: a bare-minimum input (no payer, no lines, no citation, no narrative) never fabricates content', function () {
  MINIMAL_FIXTURES.forEach(function (fx) {
    var input = { claim: {}, denial: fx.denial };
    var r = compose(input, codes);
    assert.ok(r.route, 'carc ' + fx.denial.carc + ' must still resolve to a route');
    assertGrounded(r, input, codes);
    // Every claim-dependent fact must show up as a NEEDS placeholder, not a value.
    assert.ok(r.missing_inputs.indexOf('payer name') !== -1, 'carc ' + fx.denial.carc + ' must flag missing payer');
    assert.ok(r.missing_inputs.indexOf('the billed CPT/HCPCS line(s) under review') !== -1, 'carc ' + fx.denial.carc + ' must flag missing lines');
    // No digit that looks like a fabricated CPT/date should appear outside the known CARC/RARC/boilerplate text.
    assert.ok(r.letter_markdown.indexOf('NEEDS') !== -1, 'carc ' + fx.denial.carc + ' letter must contain at least one NEEDS placeholder');
  });
});

test('no-invented-fact: changing codes.json text changes the letter (quoted live, not hard-coded)', function () {
  var patchedCodes = JSON.parse(JSON.stringify(codes));
  patchedCodes.carc['97'] = Object.assign({}, patchedCodes.carc['97'], { text: 'TEST-SENTINEL-CARC-97-TEXT-1234' });
  var input = { claim: { payer: 'Medicare', lines: [{ cpt: '93306', dos: '2026-08-01', icd10: ['R01.1'] }], ptp_indicator: 0, ptp_column2_cpt: '93320' }, denial: { group: 'CO', carc: '97' } };
  var r = compose(input, patchedCodes);
  assert.ok(r.letter_markdown.indexOf('TEST-SENTINEL-CARC-97-TEXT-1234') !== -1, 'the letter must re-quote codes.json at call time');
  assertGrounded(r, input, patchedCodes);

  var r2 = compose(input, codes);
  assert.ok(r2.letter_markdown.indexOf('TEST-SENTINEL-CARC-97-TEXT-1234') === -1, 'the unpatched codes.json must not leak the sentinel text');
  assertGrounded(r2, input, codes);
});

test('no-invented-fact: compose() throws rather than silently falling back when codes data is missing', function () {
  assert.throws(function () {
    compose({ claim: {}, denial: { carc: '97' } }, null);
  }, /requires parsed codes\.json/);
});

test('no-invented-fact: an unknown boilerplate id would throw, not silently render blank (defends the allowlist)', function () {
  var brokenCodes = JSON.parse(JSON.stringify(codes));
  delete brokenCodes.boilerplate.not_an_appeal_notice;
  assert.throws(function () {
    compose({ claim: { payer: 'Medicare', lines: [{ cpt: '93306' }] }, denial: { carc: '97' } }, brokenCodes);
  }, /unknown boilerplate id/);
});

test('no-invented-fact: a medical-necessity narrative is quoted verbatim, never paraphrased or embellished', function () {
  var narrative = 'Exam on 2026-07-28 documents new exertional dyspnea and a grade 3/6 systolic murmur, prompting repeat evaluation.';
  var input = {
    claim: { payer: 'Medicare', lines: [{ cpt: '93306', icd10: ['I35.0'], dos: '2026-08-01' }], medical_necessity_narrative: narrative, remit_date: '2026-08-10' },
    denial: { group: 'CO', carc: '50', rarc: 'N115' },
    citation: { source: 'Wellpoint Federal LCD L33577', excerpt: 'Routine (yearly) re-evaluation of an asymptomatic patient with mild native aortic stenosis without change is not covered.' }
  };
  var r = compose(input, codes);
  assert.equal(r.route, ROUTES.REDETERMINATION);
  assert.ok(r.letter_markdown.indexOf(narrative) !== -1, 'the exact narrative string must appear verbatim');
  var narrativeSentence = r.sentences.find(function (s) { return s.source_ref === 'claim.medical_necessity_narrative'; });
  assert.ok(narrativeSentence, 'narrative sentence must be present and tracked');
  assert.equal(narrativeSentence.text, narrative, 'tracked text must equal the input verbatim, with no additions');
  assertGrounded(r, input, codes);
});
