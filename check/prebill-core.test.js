// Pre-bill PTP check: tests written before the code (prm_d6f2caa2 v8, 2026-11-18).
// Contract: a pair outside the table is never called clean; counts only, no estimates;
// every table row cites CMS NCCI PTP v32.3 with a dated effective date.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync, existsSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const tablePath = path.join(root, 'data/ptp-table.json');
const table = () => JSON.parse(readFileSync(tablePath, 'utf8'));
const core = () => require('./prebill-core.js');

test('the committed PTP table is in sync with its builder and holds 62 distinct pairs', () => {
  execFileSync('node', [path.join(root, 'scripts/build-ptp-table.mjs'), '--check'], { stdio: 'pipe' });
  const t = table();
  assert.equal(t.version, 'v32.3');
  assert.equal(t.source, 'CMS NCCI Procedure-to-Procedure (PTP) Edits, Practitioner');
  assert.match(t.url, /^https:\/\/www\.cms\.gov\//);
  assert.equal(t.pairs.length, 62);
  const keys = new Set();
  for (const pair of t.pairs) {
    assert.match(pair.column1, /^[A-Z0-9]{5}$/);
    assert.match(pair.column2, /^[A-Z0-9]{5}$/);
    assert.ok([0, 1, 9].includes(pair.modifier_indicator), 'indicator is 0, 1 or 9');
    assert.match(pair.effective_date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(typeof pair.rationale, 'string');
    assert.ok(pair.rationale.length > 0);
    assert.ok(!/on this claim|grade [A-D]|none was present/i.test(JSON.stringify(pair)), 'no claim-specific text copied');
    const key = pair.column1 + '/' + pair.column2;
    assert.ok(!keys.has(key), 'duplicate pair ' + key);
    keys.add(key);
  }
  const sorted = [...t.pairs].sort((a, b) => (a.column1 + a.column2).localeCompare(b.column1 + b.column2));
  assert.deepEqual(t.pairs.map(p => p.column1 + p.column2), sorted.map(p => p.column1 + p.column2), 'sorted deterministically');
});

test('parseLines accepts the shapes a biller pastes and rejects non-codes with a line number', () => {
  const { parseLines } = core();
  const parsed = parseLines('93306\n93306-26\n93320 26 59\n\n93325,TC\nhello\nJ1234\n0001U\n12a45\n');
  assert.deepEqual(parsed.lines.map(l => [l.cpt, l.modifiers, l.lineNo]), [
    ['93306', [], 1],
    ['93306', ['26'], 2],
    ['93320', ['26', '59'], 3],
    ['93325', ['TC'], 5],
    ['J1234', [], 7],
    ['0001U', [], 8]
  ]);
  assert.deepEqual(parsed.rejected.map(r => r.lineNo), [6, 9]);
});

test('indicator 1 without a distinct-service modifier is bundled_no_modifier, with one it needs documentation', () => {
  const { parseLines, check } = core();
  const t = table();
  const row = t.pairs.find(p => p.column1 === '93000' && p.column2 === '93224') || t.pairs.find(p => p.column2 === '93000' && p.column1 === '93224');
  assert.ok(row, 'ECG/Holter pair is in the table');
  const plain = check(parseLines('93000\n93224').lines, t);
  assert.equal(plain.pairs.length, 1);
  assert.equal(plain.pairs[0].status, 'bundled_no_modifier');
  assert.equal(plain.pairs[0].modifierIndicator, 1);
  assert.equal(plain.pairs[0].citation.version, 'v32.3');
  assert.match(plain.pairs[0].citation.url, /cms\.gov/);
  assert.equal(plain.pairs[0].citation.effective_date, row.effective_date);
  assert.equal(plain.summary.pairsInTable, 1);
  assert.equal(plain.summary.pairsNotInTable, 0);

  const withModifier = check(parseLines(row.column1 + '\n' + row.column2 + ' 59').lines, t);
  assert.equal(withModifier.pairs[0].status, 'modifier_present_needs_documentation');
  assert.equal(withModifier.pairs[0].distinctModifierPresent, true);
  const withXU = check(parseLines(row.column1 + '\n' + row.column2 + '-XU').lines, t);
  assert.equal(withXU.pairs[0].status, 'modifier_present_needs_documentation');
});

test('indicator 0 is never separately payable, whatever modifier is present', () => {
  const { parseLines, check } = core();
  const synthetic = { version: 'v32.3', url: 'https://www.cms.gov/x', source: 'CMS NCCI PTP, Practitioner',
    pairs: [{ column1: '11111', column2: '22222', modifier_indicator: 0, effective_date: '2020-01-01', rationale: 'synthetic' }] };
  const result = check(parseLines('11111\n22222 59').lines, synthetic);
  assert.equal(result.pairs[0].status, 'never_separately_payable');
  assert.equal(result.pairs[0].distinctModifierPresent, true);
});

test('a pair absent from the table is not_in_table and is never described as clean', () => {
  const { parseLines, check, indicatorMeaning } = core();
  const result = check(parseLines('93306\n93320\n93325').lines, table());
  assert.equal(result.summary.linesChecked, 3);
  assert.equal(result.summary.pairsInTable + result.summary.pairsNotInTable, 3);
  const misses = result.unpaired;
  assert.ok(misses.length >= 1, 'echo example has at least one pair outside the table');
  for (const miss of misses) assert.equal(miss.status, 'not_in_table');
  const text = JSON.stringify(result) + indicatorMeaning(0) + indicatorMeaning(1) + indicatorMeaning(9) + indicatorMeaning(7);
  assert.ok(!/\bclean\b|\bclear\b|\bsafe\b|approved|\bpass(ed)?\b/i.test(text), 'no clearance words in check output');
  assert.ok(!/%|percent|probab|estimate|typically|guarantee|recover/i.test(text), 'no estimate words in check output');
});

test('the same code twice is not a pair and a single code yields nothing to check', () => {
  const { parseLines, check } = core();
  const t = table();
  assert.deepEqual(check(parseLines('93000\n93000').lines, t).pairs, []);
  assert.equal(check(parseLines('93000').lines, t).summary.linesChecked, 1);
  assert.equal(check(parseLines('93000').lines, t).pairs.length + check(parseLines('93000').lines, t).unpaired.length, 0);
});

test('more than 200 lines returns a cap error instead of a result', () => {
  const { parseLines, check } = core();
  const text = Array.from({ length: 201 }, (_, i) => String(10000 + i)).join('\n');
  const result = check(parseLines(text).lines, table());
  assert.equal(result.error, 'line_cap');
});

test('the shipped files carry no banned words', () => {
  const files = ['check/prebill-core.js', 'check/prebill-check.js', 'check/prebill-check.css', 'data/ptp-table.json'];
  for (const file of files) {
    const full = path.join(root, file);
    assert.ok(existsSync(full), file + ' exists');
    const text = readFileSync(full, 'utf8');
    for (const banned of [/%(?![0-9A-F]{2})/, /percent/i, /probab/i, /estimate/i, /typically/i, /guarantee/i, /recover/i, /\bRecall\b/, /\bInternal\b/, /\b155\b/, /Shafafiya/i, /\bAED\b/]) {
      assert.ok(!banned.test(text), file + ' contains banned pattern ' + banned);
    }
    const cleanHits = text.match(/\bclean\b/gi) || [];
    const allowed = (text.match(/not the same as clean/gi) || []).length;
    assert.equal(cleanHits.length, allowed, file + ': "clean" only inside "not the same as clean"');
  }
});

// Independent-check fixes (Opus verifier, prm_d6f2caa2 v8, after two Codex read-only reviews):
// CMS accepts the distinct-service modifier on either code of the pair (MLN1783722), and every
// pair of billed lines is judged on its own, so one modified line never hides an unmodified one.
test('a distinct-service modifier on either code of the pair counts as present', () => {
  const { parseLines, check } = core();
  const t = table();
  for (const text of ['93224 59\n93000', '93224\n93000 59', '93000 XU\n93224']) {
    const result = check(parseLines(text).lines, t);
    assert.equal(result.pairs[0].column1, '93224');
    assert.equal(result.pairs[0].status, 'modifier_present_needs_documentation', text);
  }
});

test('a repeated code is judged line by line: one unmodified pair of lines flags the pair', () => {
  const { parseLines, check } = core();
  const t = table();
  const a = check(parseLines('93224\n93000\n93000 59').lines, t);
  const b = check(parseLines('93224\n93000 59\n93000').lines, t);
  assert.equal(a.pairs.length, 1);
  assert.equal(a.pairs[0].status, 'bundled_no_modifier');
  assert.equal(b.pairs[0].status, 'bundled_no_modifier');
  assert.deepEqual(a.pairs[0].modifiersPresent, b.pairs[0].modifiersPresent);
  const covered = check(parseLines('93224\n93000 59\n93000 XU').lines, t);
  assert.equal(covered.pairs[0].status, 'modifier_present_needs_documentation');
});

test('the placeholder example shows a modifier on the column 2 code', () => {
  const ui = readFileSync(path.join(root, 'check/prebill-check.js'), 'utf8');
  const placeholder = ui.match(/input\.placeholder = '([^']*)'/)[1].split('\\n');
  const { parseLines, check } = core();
  const result = check(parseLines(placeholder.join('\n')).lines, table());
  assert.equal(result.pairs.length, 1);
  assert.equal(result.pairs[0].status, 'modifier_present_needs_documentation');
});

// Third Codex review: the bypass set is CMS's full list of NCCI-associated modifiers, not five.
test('every NCCI-associated modifier counts, other modifiers do not', () => {
  const { parseLines, check } = core();
  const t = table();
  const em = check(parseLines('93015\n99213 25').lines, t);
  assert.equal(em.pairs[0].status, 'modifier_present_needs_documentation');
  for (const modifier of ['24', '27', '57', '58', '78', '79', '91', 'RT', 'LT', 'F1', 'TA', 'E1', 'XP']) {
    assert.equal(check(parseLines('93224\n93000 ' + modifier).lines, t).pairs[0].status, 'modifier_present_needs_documentation', modifier);
  }
  for (const modifier of ['26', 'TC', 'GA', 'Q0']) {
    assert.equal(check(parseLines('93224\n93000 ' + modifier).lines, t).pairs[0].status, 'bundled_no_modifier', modifier);
  }
});

test('the action text never tells the biller to drop a line outright', () => {
  const ui = readFileSync(path.join(root, 'check/prebill-check.js'), 'utf8');
  assert.ok(!/Bill column 1 only|Remove the column 2 line|NCCI pays/.test(ui));
  assert.match(ui, /tableRequest = undefined;\n      if \(id === currentRun\)/);
  assert.match(ui, /same provider/);
});
