'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parse835, X12ParseError, tokenize } = require('./parse835.js');

const FIX = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('tokenize() reads ISA delimiters from the segment itself, not a fixed offset', () => {
  const text = FIX('synthetic-cardio-paid-eval.835');
  const { elementSep, componentSep, segmentTerm } = tokenize(text);
  assert.equal(elementSep, '*');
  assert.equal(componentSep, ':');
  assert.equal(segmentTerm, '~');
});

test('parse835() rejects text that is not an X12 interchange', () => {
  assert.throws(() => parse835('not an edi file'), X12ParseError);
  assert.throws(() => parse835(''), X12ParseError);
});

test('interchange header: sender id, usage indicator and separators come from ISA', () => {
  const parsed = parse835(FIX('synthetic-cardio-paid-eval.835'));
  assert.equal(parsed.interchange.senderId, 'SYNTHETICNIMBIR');
  assert.equal(parsed.interchange.receiverId, 'SYNTHCARDIOPAYR');
  assert.equal(parsed.interchange.usageIndicator, 'T');
  assert.equal(parsed.interchange.elementSeparator, '*');
  assert.equal(parsed.interchange.componentSeparator, ':');
});

test('parses a single ST/SE transaction: BPR, TRN, N1 payer/payee, CLP, NM1, SVC, DTM', () => {
  const parsed = parse835(FIX('synthetic-cardio-paid-eval.835'));
  assert.equal(parsed.functionalGroups.length, 1);
  const tx = parsed.functionalGroups[0].transactions[0];
  assert.equal(tx.payment.totalPaid, 150.00);
  assert.equal(tx.payment.paymentMethod, 'ACH');
  assert.equal(tx.payment.traceNumber, 'TRACE0000004');
  assert.equal(tx.payer.name, 'SYNTHETIC CARDIOLOGY PAYER CO');
  assert.equal(tx.payee.name, 'SYNTHETIC CARDIOLOGY ASSOCIATES');
  assert.equal(tx.payee.id, '1999999999');
  assert.equal(tx.claims.length, 1);
  const claim = tx.claims[0];
  assert.equal(claim.patientControlNumber, 'CARDIO-0004');
  assert.equal(claim.statusCode, '1');
  assert.equal(claim.statusDescription, 'Processed as Primary');
  assert.equal(claim.patient.lastOrOrgName, 'SYNTHETICPATIENT');
  assert.equal(claim.renderingProvider.id, '1999999999');
  assert.equal(claim.services.length, 1);
  const svc = claim.services[0];
  assert.equal(svc.procedureQualifier, 'HC');
  assert.equal(svc.procedureCode, '99214');
  assert.deepEqual(svc.modifiers, ['25']);
  assert.equal(svc.charge, 150.00);
  assert.equal(svc.paid, 150.00);
  assert.equal(svc.dates['472'], '2026-09-02');
});

test('CAS: claim-level and service-level adjustment group/reason/amount triplets', () => {
  const claim = parse835(FIX('synthetic-cardio-bundling-co97.835')).functionalGroups[0].transactions[0].claims[0];
  assert.equal(claim.services.length, 2);
  assert.deepEqual(claim.services[0].adjustments, [{ groupCode: 'CO', reasonCode: '97', amount: 450.00, quantity: null }]);
  assert.deepEqual(claim.services[1].adjustments, [{ groupCode: 'CO', reasonCode: '97', amount: 300.00, quantity: null }]);
  assert.equal(claim.adjustments.length, 0); // these adjustments are service-level, not claim-level
});

test('PR-1 deductible is a service-level CAS under group PR, distinct from a CO denial', () => {
  const claim = parse835(FIX('synthetic-cardio-deductible-pr1.835')).functionalGroups[0].transactions[0].claims[0];
  assert.deepEqual(claim.services[0].adjustments, [{ groupCode: 'PR', reasonCode: '1', amount: 40.00, quantity: null }]);
  assert.equal(claim.totalPaid, 100.00);
  assert.equal(claim.patientResponsibility, 40.00);
});

test('SVC composite: qualifier, procedure code and modifiers split on the component separator', () => {
  const claim = parse835(FIX('synthetic-cardio-modifier-co4.835')).functionalGroups[0].transactions[0].claims[0];
  const svc = claim.services[0];
  assert.equal(svc.procedureQualifier, 'HC');
  assert.equal(svc.procedureCode, '93224');
  assert.deepEqual(svc.modifiers, ['26']);
  assert.deepEqual(svc.adjustments, [{ groupCode: 'CO', reasonCode: '4', amount: 180.00, quantity: null }]);
});

test('LQ remark code attaches to the service line it follows', () => {
  const claim = parse835(FIX('synthetic-cardio-lcd-co50.835')).functionalGroups[0].transactions[0].claims[0];
  assert.deepEqual(claim.services[0].remarkCodes, [{ qualifier: 'HE', code: 'N115' }]);
  assert.deepEqual(claim.services[0].adjustments, [{ groupCode: 'CO', reasonCode: '50', amount: 300.00, quantity: null }]);
});

test('CLP02=22 reversal and PLB provider-level adjustment tied to the same claim', () => {
  const tx = parse835(FIX('synthetic-cardio-reversal.835')).functionalGroups[0].transactions[0];
  assert.equal(tx.claims[0].statusCode, '22');
  assert.equal(tx.claims[0].statusDescription, 'Reversal of Previous Payment');
  assert.equal(tx.providerAdjustments.length, 1);
  assert.deepEqual(tx.providerAdjustments[0].adjustments[0], { reasonCode: 'WO', referenceId: 'CARDIO-0007', amount: 95.00 });
});

test('a partial payment carries a routine CO-45 write-off, not one of the flagged denial codes', () => {
  const claim = parse835(FIX('synthetic-cardio-partial-payment.835')).functionalGroups[0].transactions[0].claims[0];
  assert.equal(claim.totalPaid, 150.00);
  assert.equal(claim.totalCharge, 220.00);
  assert.deepEqual(claim.services[0].adjustments, [{ groupCode: 'CO', reasonCode: '45', amount: 70.00, quantity: null }]);
});

test('multiple ST/SE transaction sets inside one GS/ISA interchange both parse', () => {
  const group = parse835(FIX('synthetic-cardio-multi-st.835')).functionalGroups[0];
  assert.equal(group.transactions.length, 2);
  assert.equal(group.transactions[0].controlNumber, '0001');
  assert.equal(group.transactions[0].claims[0].patientControlNumber, 'CARDIO-0009');
  assert.equal(group.transactions[1].controlNumber, '0002');
  assert.equal(group.transactions[1].claims[0].patientControlNumber, 'CARDIO-0010');
});

test('segment terminators work whether or not they are followed by a newline', () => {
  const withNewlines = FIX('synthetic-cardio-bundling-co97.835');
  const oneLine = withNewlines.replace(/\r?\n/g, ''); // same file, every segment on one physical line
  const a = parse835(withNewlines);
  const b = parse835(oneLine);
  assert.equal(a.functionalGroups[0].transactions.length, b.functionalGroups[0].transactions.length);
  assert.deepEqual(
    a.functionalGroups[0].transactions.map(t => t.claims.map(c => c.patientControlNumber)),
    b.functionalGroups[0].transactions.map(t => t.claims.map(c => c.patientControlNumber))
  );
  assert.equal(b.functionalGroups[0].transactions[0].claims[0].services[0].charge, 450.00);
});

test('an unrecognized segment is skipped with a warning, not a thrown error', () => {
  const text = FIX('synthetic-cardio-paid-eval.835').replace('TRN*1*TRACE0000004*1SYNTHCARDIOPAYR~', 'TRN*1*TRACE0000004*1SYNTHCARDIOPAYR~\nZZZ*unexpected~');
  const parsed = parse835(text);
  assert.ok(parsed.warnings.some(w => w.includes('ZZZ')));
  assert.equal(parsed.functionalGroups[0].transactions[0].claims[0].patientControlNumber, 'CARDIO-0004');
});

test('a non-835 transaction set is skipped with a warning and does not corrupt the next ST', () => {
  const text = FIX('synthetic-cardio-paid-eval.835').replace('ST*835*0001*005010X221A1~', 'ST*277*9999*005010X221A1~');
  // Force the fixture's own single ST to be a non-835; skip-to-SE then nothing follows, so
  // functionalGroups should contain no transactions once the only ST is skipped.
  const parsed = parse835(text);
  assert.equal(parsed.warnings.some(w => w.includes('non-835')), true);
  assert.equal(parsed.functionalGroups[0].transactions.length, 0);
});
