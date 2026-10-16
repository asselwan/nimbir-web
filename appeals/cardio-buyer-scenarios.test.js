'use strict';
/*
 * The 10 cardiology denial scenarios from
 * .ainur/review/nimbir/CARDIO_BUYER.md (b) as compose() fixtures, plus the
 * scenario #7 negative control. Each case asserts the route the buyer doc's
 * "Correct action Nimbir should propose" column calls for, and that the
 * letter is fully grounded (no invented fact).
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var { compose, loadDefaultCodes, ROUTES } = require('./compose.js');
var { assertGrounded } = require('./grounding-helper.js');

var codes = loadDefaultCodes();

// 1. TTE billed with separate Doppler and color-flow lines: 93306+93320+93325,
// 93320 is PTP mod-indicator-0 against 93306 -> corrected claim, never an appeal.
test('scenario 1: TTE + Doppler/color-flow bundling -> corrected_claim, warns against modifier 59', function () {
  var input = {
    claim: {
      payer: 'Medicare',
      lines: [{ cpt: '93306', dos: '2026-08-01', icd10: ['R01.1'] }, { cpt: '93320', dos: '2026-08-01', icd10: ['R01.1'] }, { cpt: '93325', dos: '2026-08-01', icd10: ['R01.1'] }],
      ptp_indicator: 0,
      ptp_column2_cpt: '93320'
    },
    denial: { group: 'CO', carc: '97' }
  };
  var r = compose(input, codes);
  assert.equal(r.route, ROUTES.CORRECTED_CLAIM);
  assert.ok(r.letter_markdown.indexOf('not an appeal') !== -1);
  assert.ok(r.letter_markdown.indexOf('may ever be appended') !== -1);
  assertGrounded(r, input, codes);
});

// 2. TTE for uncomplicated hypertension, Dx I10 only: CO-50 + N115, LCD L33577.
// No chart narrative yet -> documentation query to the ordering cardiologist, not an appeal.
test('scenario 2: TTE for uncomplicated HTN (no narrative yet) -> documentation_query', function () {
  var input = {
    claim: { payer: 'Medicare (Wellpoint Federal J6/JK)', lines: [{ cpt: '93306', dos: '2026-08-01', icd10: ['I10'] }] },
    denial: { group: 'CO', carc: '50', rarc: 'N115' },
    citation: {
      source: 'Wellpoint Federal LCD L33577 / Article A56781', id: 'L33577',
      url: 'https://www.cms.gov/medicare-coverage-database/view/lcd.aspx?lcdid=33577',
      excerpt: 'Routine evaluation of patients with systemic hypertension without suspected hypertensive heart disease is not covered.'
    }
  };
  var r = compose(input, codes);
  assert.equal(r.route, ROUTES.DOC_QUERY);
  assert.ok(r.letter_markdown.indexOf(input.citation.excerpt) !== -1);
  assert.ok(r.letter_markdown.indexOf('not a letter to the payer') !== -1);
  assertGrounded(r, input, codes);
});

// 3. Annual "routine" re-echo, mild AS, no clinical change: CO-50 + N115, LCD L33577.
// With a chart narrative documenting a clinical change -> redetermination, LCD quoted verbatim.
test('scenario 3: annual re-echo with a documented interval change -> redetermination, LCD quoted', function () {
  var input = {
    claim: {
      payer: 'Medicare (Wellpoint Federal J6/JK)',
      lines: [{ cpt: '93306', dos: '2026-08-01', icd10: ['I35.0'] }],
      medical_necessity_narrative: 'Interval history documents new exertional dyspnea since the prior echocardiogram eleven months ago.',
      remit_date: '2026-08-15'
    },
    denial: { group: 'CO', carc: '50', rarc: 'N115' },
    citation: {
      source: 'Wellpoint Federal LCD L33577 / Article A56781', id: 'L33577',
      url: 'https://www.cms.gov/medicare-coverage-database/view/lcd.aspx?lcdid=33577',
      excerpt: 'Routine (yearly) re-evaluation of an asymptomatic patient with mild native aortic stenosis without change is not covered.'
    }
  };
  var r = compose(input, codes);
  assert.equal(r.route, ROUTES.REDETERMINATION);
  assert.ok(r.letter_markdown.indexOf(input.citation.excerpt) !== -1);
  assert.ok(r.letter_markdown.indexOf(input.claim.medical_necessity_narrative) !== -1);
  assertGrounded(r, input, codes);
});

// 4. Stress echo billed with the exercise ECG codes: 93351+93015, PTP mod-indicator-0 -> corrected claim.
test('scenario 4: stress echo + exercise ECG bundling -> corrected_claim', function () {
  var input = {
    claim: { payer: 'Medicare', lines: [{ cpt: '93351', dos: '2026-08-01', icd10: ['I25.10'] }, { cpt: '93015', dos: '2026-08-01', icd10: ['I25.10'] }], ptp_indicator: 0, ptp_column2_cpt: '93015' },
    denial: { group: 'CO', carc: '97' }
  };
  var r = compose(input, codes);
  assert.equal(r.route, ROUTES.CORRECTED_CLAIM);
  assertGrounded(r, input, codes);
});

// 5. Screening stress test after PCI with no new symptoms: CO-50 + N115, LCD L35083.
// No narrative supplied -> documentation query first.
test('scenario 5: post-PCI screening stress test with no documented symptom -> documentation_query', function () {
  var input = {
    claim: { payer: 'Medicare (Novitas JH/JL)', lines: [{ cpt: '78452', dos: '2026-08-01', icd10: ['Z95.5', 'I25.10'] }] },
    denial: { group: 'CO', carc: '50', rarc: 'N115' },
    citation: {
      source: 'Novitas LCD L35083 / Article A56423', id: 'L35083',
      url: 'https://www.cms.gov/medicare-coverage-database/view/lcd.aspx?LCDId=35083',
      excerpt: 'Exercise testing or radiologic imaging within the first 2 years following PCI without specific symptoms is not reasonable and necessary.'
    }
  };
  var r = compose(input, codes);
  assert.equal(r.route, ROUTES.DOC_QUERY);
  assertGrounded(r, input, codes);
});

// 6. Pre-op stress test before low-risk surgery: CO-50 + N115, LCD L35083.
// With a documented high-risk/low-functional-capacity narrative -> redetermination.
test('scenario 6: pre-op stress test with documented high-risk surgery + low functional capacity -> redetermination', function () {
  var input = {
    claim: {
      payer: 'Medicare (Novitas JH/JL)',
      lines: [{ cpt: '78452', dos: '2026-08-01', icd10: ['Z01.810'] }],
      medical_necessity_narrative: 'Surgical consult documents a high-risk vascular procedure and functional capacity below 4 METs.',
      remit_date: '2026-08-12'
    },
    denial: { group: 'CO', carc: '50', rarc: 'N115' },
    citation: {
      source: 'Novitas LCD L35083', id: 'L35083',
      url: 'https://www.cms.gov/medicare-coverage-database/view/lcd.aspx?LCDId=35083',
      excerpt: 'Pre-operative evaluation for low risk noncardiac surgery is not covered; high-risk surgery requires documented functional capacity under 4 METs or unknown capacity.'
    }
  };
  var r = compose(input, codes);
  assert.equal(r.route, ROUTES.REDETERMINATION);
  assertGrounded(r, input, codes);
});

// 7. Regadenoson units over the MUE: J2785 x5 vs MUE 4 -> CO-151 + N362. A dosing/data-entry
// error should route to a reopening (clerical), not a formal appeal.
test('scenario 7: regadenoson units over MUE, flagged clerical -> reopening', function () {
  var input = {
    claim: {
      payer: 'Medicare', lines: [{ cpt: 'J2785', units: 5, dos: '2026-08-01', icd10: ['I25.10'] }],
      unit_error_type: 'clerical', units_billed: 5, units_correct: 4
    },
    denial: { group: 'CO', carc: '151', rarc: 'N362' }
  };
  var r = compose(input, codes);
  assert.equal(r.route, ROUTES.REOPENING);
  assert.ok(r.letter_markdown.indexOf('5') !== -1 && r.letter_markdown.indexOf('4') !== -1);
  assertGrounded(r, input, codes);
});

// 7 (negative control). 78452 + 93015 + J2785 x4: no PTP edit, units at the MUE cap, not over it.
// This is not a denial at all; compose() must not fabricate a letter for a clean line.
test('scenario 7 (negative control): clean line within MUE has no denial to compose against', function () {
  var input = { claim: { payer: 'Medicare', lines: [{ cpt: 'J2785', units: 4, dos: '2026-08-01' }, { cpt: '78452', dos: '2026-08-01' }, { cpt: '93015', dos: '2026-08-01' }] } };
  var r = compose(input, codes);
  assert.equal(r.route, null);
  assert.equal(r.letter_markdown, null);
  assert.deepEqual(r.missing_inputs, ['denial']);
});

// 8. 48-hour Holter and 7-day extended monitor same date: 93224+93241, PTP mod-indicator-0 -> corrected claim.
test('scenario 8a: simultaneous Holter + extended monitor -> corrected_claim', function () {
  var input = {
    claim: { payer: 'Medicare', lines: [{ cpt: '93224', dos: '2026-08-01', icd10: ['R00.2'] }, { cpt: '93241', dos: '2026-08-01', icd10: ['R00.2'] }], ptp_indicator: 0, ptp_column2_cpt: '93241' },
    denial: { group: 'CO', carc: '97' }
  };
  var r = compose(input, codes);
  assert.equal(r.route, ROUTES.CORRECTED_CLAIM);
  assertGrounded(r, input, codes);
});

// 8b. Holter billed with a 26 modifier (93224-26): CARC 4, procedure/modifier mismatch -> reopening (clerical).
test('scenario 8b: Holter billed with an inconsistent 26 modifier -> reopening', function () {
  var input = {
    claim: { payer: 'Medicare', lines: [{ cpt: '93224', modifiers: ['26'], dos: '2026-08-01', icd10: ['R00.2'] }] },
    denial: { group: 'CO', carc: '4' }
  };
  var r = compose(input, codes);
  assert.equal(r.route, ROUTES.REOPENING);
  assert.ok(r.letter_markdown.indexOf('26') !== -1);
  assertGrounded(r, input, codes);
});

// 9. Remote device interrogation billed twice within 90 days: frequency/benefit-max -> CO-119 ->
// corrected claim (void the duplicate), per the buyer doc's "bill once per 90-day period" guidance.
test('scenario 9: duplicate remote device interrogation within 90 days -> corrected_claim (void duplicate)', function () {
  var input = {
    claim: { payer: 'Medicare', lines: [{ cpt: '93296', dos: '2026-08-15', icd10: ['Z95.0'] }] },
    denial: { group: 'CO', carc: '119' }
  };
  var r = compose(input, codes);
  assert.equal(r.route, ROUTES.CORRECTED_CLAIM);
  assert.ok(r.letter_markdown.indexOf('benefit or frequency maximum') !== -1);
  assertGrounded(r, input, codes);
});

// 10. Commercial echo/nuclear study with no auth on file (eviCore-managed plan): CO-197 -> appeal
// (retro-auth request / appeal checklist); whether a retro-auth window exists is unknown here.
test('scenario 10: commercial echo with no prior auth on file (eviCore plan) -> appeal, retro-auth unknown flagged', function () {
  var input = {
    claim: { payer: 'Commercial (eviCore-managed cardiology)', lines: [{ cpt: '93306', dos: '2026-08-01', icd10: ['I25.10'] }] },
    denial: { group: 'CO', carc: '197' }
  };
  var r = compose(input, codes);
  assert.equal(r.route, ROUTES.APPEAL);
  assert.ok(r.missing_inputs.some(function (m) { return m.indexOf('retroactive authorization window') !== -1; }));
  assertGrounded(r, input, codes);
});
