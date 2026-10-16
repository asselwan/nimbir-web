'use strict';
var test = require('node:test');
var assert = require('node:assert/strict');
var { compose, loadDefaultCodes, ROUTES, addDays, daysBetween } = require('./compose.js');
var { assertGrounded } = require('./grounding-helper.js');

var codes = loadDefaultCodes();

test('compose() with no denial returns a null route and does not fabricate a letter', function () {
  var r = compose({ claim: { payer: 'Medicare', lines: [{ cpt: '78452', dos: '2026-09-01' }] } }, codes);
  assert.equal(r.route, null);
  assert.equal(r.letter_markdown, null);
  assert.deepEqual(r.sentences, []);
  assert.deepEqual(r.missing_inputs, ['denial']);
  assert.equal(r.preflight[0].check, 'denial_present');
  assert.equal(r.preflight[0].pass, false);
});

test('route: corrected_claim for a PTP bundling denial with modifier indicator 0', function () {
  var input = {
    claim: { payer: 'Medicare', lines: [{ cpt: '93306', dos: '2026-08-01', icd10: ['R01.1'] }, { cpt: '93320', dos: '2026-08-01', icd10: ['R01.1'] }], ptp_indicator: 0, ptp_column2_cpt: '93320' },
    denial: { group: 'CO', carc: '97' }
  };
  var r = compose(input, codes);
  assert.equal(r.route, ROUTES.CORRECTED_CLAIM);
  assert.ok(r.letter_markdown.indexOf('not an appeal') !== -1);
  assert.ok(r.letter_markdown.indexOf('no modifier, including 59, XE, XS, XP, or XU, may ever be appended') !== -1);
  assert.equal(r.missing_inputs.length, 0);
  assertGrounded(r, input, codes);
});

test('corrected_claim warns the improper-unbundling warning does NOT appear when the PTP indicator is 1', function () {
  var input = {
    claim: { payer: 'Medicare', lines: [{ cpt: '93306', dos: '2026-08-01' }], ptp_indicator: 1, ptp_column2_cpt: '93321' },
    denial: { group: 'CO', carc: '236' }
  };
  var r = compose(input, codes);
  assert.equal(r.route, ROUTES.CORRECTED_CLAIM);
  assert.ok(r.letter_markdown.indexOf('may ever be appended') === -1);
  assert.ok(r.letter_markdown.indexOf('clinically distinct') !== -1);
  assertGrounded(r, input, codes);
});

test('route: reopening for a clerical modifier mismatch (CARC 4)', function () {
  var input = {
    claim: { payer: 'Medicare', lines: [{ cpt: '93224', modifiers: ['26'], dos: '2026-08-01' }] },
    denial: { group: 'CO', carc: '4' }
  };
  var r = compose(input, codes);
  assert.equal(r.route, ROUTES.REOPENING);
  assert.ok(r.letter_markdown.indexOf('clerical errors be processed as reopenings rather than appeals') !== -1);
  assertGrounded(r, input, codes);
});

test('route: redetermination for medical necessity (CARC 50 + N115) when a chart narrative is supplied', function () {
  var input = {
    claim: {
      payer: 'Medicare (Novitas JH/JL)',
      lines: [{ cpt: '78452', icd10: ['Z95.5', 'I25.10'], dos: '2026-07-01' }],
      medical_necessity_narrative: 'The chart documents new exertional chest pressure since the prior visit.',
      remit_date: '2026-07-20',
      today: '2026-08-01'
    },
    denial: { group: 'CO', carc: '50', rarc: 'N115' },
    citation: { source: 'Novitas LCD L35083 / Article A56423', id: 'L35083', url: 'https://example.com/L35083', excerpt: 'Exercise testing within the first 2 years following PCI without specific symptoms is not reasonable and necessary.' }
  };
  var r = compose(input, codes);
  assert.equal(r.route, ROUTES.REDETERMINATION);
  assert.ok(r.letter_markdown.indexOf(input.citation.excerpt) !== -1);
  assert.ok(r.letter_markdown.indexOf(input.claim.medical_necessity_narrative) !== -1);
  assert.ok(r.letter_markdown.indexOf('must be filed within 120 days from the date of the revised initial determination') !== -1);
  assert.ok(r.letter_markdown.indexOf('due no later than 2026-11-17') !== -1);
  var deadlineCheck = r.preflight.find(function (p) { return p.check === 'within_120_day_redetermination_window'; });
  assert.ok(deadlineCheck && deadlineCheck.pass === true);
  assertGrounded(r, input, codes);
});

test('route: documentation_query for medical necessity (CARC 50 + N115) when no narrative is supplied', function () {
  var input = {
    claim: { payer: 'Medicare (Wellpoint Federal J6/JK)', lines: [{ cpt: '93306', icd10: ['I10'], dos: '2026-08-01' }] },
    denial: { group: 'CO', carc: '50', rarc: 'N115' },
    citation: { source: 'Wellpoint Federal LCD L33577 / Article A56781', id: 'L33577', url: 'https://example.com/L33577', excerpt: 'Routine evaluation of patients with systemic hypertension without suspected hypertensive heart disease is not covered.' }
  };
  var r = compose(input, codes);
  assert.equal(r.route, ROUTES.DOC_QUERY);
  assert.deepEqual(r.missing_inputs, []);
  assertGrounded(r, input, codes);
});

test('route: appeal for prior authorization absent (CARC 197), flags the retro-auth question as missing', function () {
  var input = {
    claim: { payer: 'Commercial (eviCore)', lines: [{ cpt: '93306', dos: '2026-08-01' }], remit_date: '2026-08-10', today: '2026-08-20' },
    denial: { group: 'CO', carc: '197' }
  };
  var r = compose(input, codes);
  assert.equal(r.route, ROUTES.APPEAL);
  assert.ok(r.missing_inputs.some(function (m) { return m.indexOf('retroactive authorization window') !== -1; }));
  assertGrounded(r, input, codes);
});

test('route: appeal for MUE units (CARC 151) without a documented clerical flag requires medical necessity', function () {
  var input = {
    claim: { payer: 'Medicare', lines: [{ cpt: 'J2785', units: 5, dos: '2026-08-01' }] },
    denial: { group: 'CO', carc: '151', rarc: 'N362' }
  };
  var r = compose(input, codes);
  assert.equal(r.route, ROUTES.APPEAL);
  assert.ok(r.letter_markdown.indexOf('should not be appealed; it should be corrected or written off') !== -1);
  assertGrounded(r, input, codes);
});

test('route: reopening for MUE units (CARC 151) flagged as a clerical unit-entry error', function () {
  var input = {
    claim: { payer: 'Medicare', lines: [{ cpt: 'J2785', units: 5, dos: '2026-08-01' }], unit_error_type: 'clerical', units_billed: 5, units_correct: 4 },
    denial: { group: 'CO', carc: '151', rarc: 'N362' }
  };
  var r = compose(input, codes);
  assert.equal(r.route, ROUTES.REOPENING);
  assert.ok(r.letter_markdown.indexOf('clerical errors be processed as reopenings') !== -1);
  assertGrounded(r, input, codes);
});

test('route: appeal for timely filing (CARC 29)', function () {
  var input = {
    claim: { payer: 'Commercial', lines: [{ cpt: '93306', dos: '2026-05-01' }], timely_filing_proof: 'Clearinghouse 277CA accepted the original submission on 2026-05-10.', remit_date: '2026-08-01', today: '2026-08-10' },
    denial: { group: 'CO', carc: '29' }
  };
  var r = compose(input, codes);
  assert.equal(r.route, ROUTES.APPEAL);
  assert.ok(r.letter_markdown.indexOf(input.claim.timely_filing_proof) !== -1);
  assertGrounded(r, input, codes);
});

test('unrecognized CARC routes to documentation_query and is flagged for human triage', function () {
  var input = { claim: { payer: 'Medicare', lines: [{ cpt: '93306', dos: '2026-08-01' }] }, denial: { group: 'CO', carc: '999999' } };
  var r = compose(input, codes);
  assert.equal(r.route, ROUTES.DOC_QUERY);
  var routeCheck = r.preflight.find(function (p) { return p.check === 'route_determined'; });
  assert.ok(routeCheck && routeCheck.pass === false);
  assertGrounded(r, input, codes);
});

test('addDays / daysBetween helpers are correct and UTC-stable', function () {
  assert.equal(addDays('2026-01-01', 120), '2026-05-01');
  assert.equal(daysBetween('2026-01-01', '2026-01-11'), 10);
  assert.equal(daysBetween('2026-01-11', '2026-01-01'), -10);
});
