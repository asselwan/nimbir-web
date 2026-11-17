import { readFileSync, writeFileSync } from 'node:fs';

const builtFrom = 'data/rules-findings.json';
const sourcePath = new URL('../' + builtFrom, import.meta.url);
const tablePath = new URL('../data/ptp-table.json', import.meta.url);
const findings = JSON.parse(readFileSync(sourcePath, 'utf8'));
const pairs = new Map();
let metadata;

for (const claimFindings of Object.values(findings)) {
  for (const finding of claimFindings) {
    if (finding.rule_type !== 'PTP') continue;

    const [column1, column2] = finding.cpts;
    const key = column1 + '/' + column2;
    const { source, version, url, effective_date: date } = finding.citation;
    const { modifier_indicator } = finding;
    const rationale = finding.plain_english.match(/rationale: ([^)]+)\)/)?.[1].trim();
    if (!rationale || !/^\d{8}$/.test(date)) throw new Error('Invalid rationale or effective date for ' + key);

    metadata ??= { source, version, url };
    if (source !== metadata.source || version !== metadata.version || url !== metadata.url) {
      throw new Error('Inconsistent PTP citation for ' + key);
    }

    const effective_date = date.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
    const row = { column1, column2, modifier_indicator, effective_date, rationale };
    const previous = pairs.get(key);
    if (previous && (previous.modifier_indicator !== modifier_indicator ||
                     previous.effective_date !== effective_date || previous.rationale !== rationale)) {
      throw new Error('Inconsistent PTP finding for ' + key);
    }
    pairs.set(key, row);
  }
}

if (!metadata) throw new Error('No PTP findings found');
const sortedPairs = Array.from(pairs.keys()).sort().map(key => pairs.get(key));
const table = JSON.stringify({ ...metadata, built_from: builtFrom, pairs: sortedPairs }, null, 2) + '\n';

if (process.argv.includes('--check')) {
  let current;
  try {
    current = readFileSync(tablePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (current !== table) {
    console.error('PTP table out of sync. Run npm run build:ptp, then review git diff -- data/ptp-table.json.');
    process.exitCode = 1;
  } else {
    console.log('PTP table is in sync.');
  }
} else {
  writeFileSync(tablePath, table);
}
