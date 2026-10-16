'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parse835 } = require('./parse835.js');
const crypto = require('node:crypto');
const { buildDeidExport, BANNER_TEXT } = require('./deid-export.js');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const FIXTURES = fs.readdirSync(FIXTURES_DIR).filter(f => f.endsWith('.835'));

// Every patient/member identifier the generator puts into the fixtures (see _gen.py
// patient()/claim_header()), so we can assert none of it survives into an export.
const FORBIDDEN_SUBSTRINGS = [
  'SYNTHETICPATIENT', // NM1*QC last name
  'ONE',              // NM1*QC first name — checked word-boundary below, "ONE" alone is too common
  ...Array.from({ length: 10 }, (_, i) => `SYNTH0000000${i + 1}`), // member IDs
  ...Array.from({ length: 10 }, (_, i) => `PAYERCLM000${i + 1}`)   // raw CLP07 values
];

// CLP07 (payer claim control number) values read straight from the fixture text,
// so the check covers whatever the generator wrote, not just the PAYERCLM pattern.
function clp07Values(text) {
  return text.split('~').map(s => s.trim()).filter(s => s.startsWith('CLP*'))
    .map(s => s.split('*')[7]).filter(Boolean);
}

test('BANNER_TEXT states the Safe Harbor field rules the export actually follows', () => {
  assert.equal(BANNER_TEXT, 'Export follows HIPAA Safe Harbor field rules: no patient names or identifiers, no dates finer than year, no identifier-derived codes (row_id is random). Review the preview before sending.');
});

for (const file of FIXTURES) {
  test(`${file}: de-identified export contains no patient identifiers or raw payer claim control numbers`, async () => {
    const text = fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8');
    const parsed = parse835(text);
    const result = await buildDeidExport(parsed);
    assert.ok(result.rows.length > 0, 'expected at least one export row');
    for (const needle of FORBIDDEN_SUBSTRINGS) {
      if (needle === 'ONE') continue; // too common a substring on its own; see the dedicated check below
      assert.doesNotMatch(result.json, new RegExp(needle), `found forbidden identifier "${needle}" in JSON export of ${file}`);
      assert.doesNotMatch(result.csv, new RegExp(needle), `found forbidden identifier "${needle}" in CSV export of ${file}`);
    }
    // The patient's first name "ONE" as a standalone JSON string value, specifically.
    assert.doesNotMatch(result.json, /"ONE"/);
    // Safe Harbor (C): no date element finer than year. No YYYY-MM (or YYYY-MM-DD) anywhere.
    assert.doesNotMatch(result.json, /\d{4}-\d{2}/, `found a year-month date in JSON export of ${file}`);
    assert.doesNotMatch(result.csv, /\d{4}-\d{2}/, `found a year-month date in CSV export of ${file}`);
    for (const row of result.rows) {
      assert.ok(row.service_year === null || /^\d{4}$/.test(row.service_year), `service_year "${row.service_year}" is not a bare year in ${file}`);
    }
    // Safe Harbor (R): no CLP07 value, and no code derived from it (plain or hex/base64 SHA-256/MD5/SHA-1).
    const clp07s = clp07Values(text);
    assert.ok(clp07s.length > 0, `fixture ${file} should carry CLP07 values to test against`);
    for (const clp07 of clp07s) {
      const derived = [clp07];
      for (const algo of ['sha256', 'sha1', 'md5']) {
        derived.push(crypto.createHash(algo).update(clp07).digest('hex'));
        derived.push(crypto.createHash(algo).update(clp07).digest('base64'));
      }
      for (const needle of derived) {
        assert.ok(!result.json.includes(needle), `found CLP07 "${clp07}" or a hash of it in JSON export of ${file}`);
        assert.ok(!result.csv.includes(needle), `found CLP07 "${clp07}" or a hash of it in CSV export of ${file}`);
      }
    }
    // No digest-length hex string survives at all (a salted CLP07 hash would be 64 hex chars).
    assert.doesNotMatch(result.json, /[a-f0-9]{40,}/, `found a digest-like hex string in JSON export of ${file}`);
    for (const row of result.rows) {
      assert.ok(!('payer_claim_control_hash' in row), `payer_claim_control_hash must not be exported (${file})`);
    }
    // Full exact dates (YYYY-MM-DD) never appear either.
    const fullDates = text.match(/DTM\*(?:232|472)\*(\d{8})~/g) || [];
    for (const match of fullDates) {
      const raw = match.match(/(\d{8})/)[1];
      const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
      assert.doesNotMatch(result.json, new RegExp(iso), `found exact date ${iso} in export of ${file}`);
    }
  });
}

test('row_id is a random per-row id, unique within one export', async () => {
  const text = fs.readFileSync(path.join(FIXTURES_DIR, 'synthetic-cardio-bundling-co97.835'), 'utf8');
  const a = await buildDeidExport(parse835(text));
  assert.equal(a.rows.length, 4); // two claims x two service lines each
  for (const row of a.rows) assert.match(row.row_id, /^[a-f0-9]{32}$/);
  // Distinguishable within one export, even for two lines of the same claim (same CLP07).
  assert.equal(new Set(a.rows.map(r => r.row_id)).size, a.rows.length);
  assert.notEqual(a.rows[0].row_id, a.rows[1].row_id);
  // Lines of one claim still group by in-export ordinal, which is not derived from any identifier.
  assert.equal(a.rows[0].claim_sequence, a.rows[1].claim_sequence);
  assert.notEqual(a.rows[0].claim_sequence, a.rows[2].claim_sequence);
});

test('two exports of the same file share no row_id, so exports cannot be linked to each other', async () => {
  const text = fs.readFileSync(path.join(FIXTURES_DIR, 'synthetic-cardio-bundling-co97.835'), 'utf8');
  const a = await buildDeidExport(parse835(text));
  const b = await buildDeidExport(parse835(text));
  const bIds = new Set(b.rows.map(r => r.row_id));
  assert.equal(bIds.size, b.rows.length);
  for (const row of a.rows) assert.ok(!bIds.has(row.row_id), 'row_id repeated across two exports of the same file');
});

test('export rows carry only the allowlisted claim-level financial/coding fields', async () => {
  const text = fs.readFileSync(path.join(FIXTURES_DIR, 'synthetic-cardio-lcd-co50.835'), 'utf8');
  const result = await buildDeidExport(parse835(text));
  const row = result.rows[0];
  assert.equal(row.cpt_code, '93306');
  assert.deepEqual(row.modifiers, ['TC']);
  assert.equal(row.charge_amount, 300.00);
  assert.equal(row.paid_amount, 0.00);
  assert.equal(row.service_year, '2026');
  assert.deepEqual(row.adjustments.map(a => `${a.group_code}-${a.reason_code}`), ['CO-50']);
  assert.deepEqual(row.remark_codes, [{ qualifier: 'HE', code: 'N115' }]);
  const allowed = new Set(['row_id', 'claim_sequence', 'payer_name', 'cpt_code', 'modifiers',
    'units_paid', 'units_submitted', 'charge_amount', 'paid_amount', 'claim_status_code', 'adjustments',
    'remark_codes', 'service_year']);
  for (const key of Object.keys(row)) assert.ok(allowed.has(key), `unexpected field "${key}" in export row`);
});

test('CSV export has a header row and one data row per export row', async () => {
  const text = fs.readFileSync(path.join(FIXTURES_DIR, 'synthetic-cardio-reversal.835'), 'utf8');
  const result = await buildDeidExport(parse835(text));
  const lines = result.csv.trim().split('\n');
  assert.equal(lines.length, result.rows.length + 1);
  assert.match(lines[0], /^row_id,claim_sequence,payer_name,/);
  assert.match(lines[0], /,service_year$/);
  assert.doesNotMatch(lines[0], /hash|month/);
});
