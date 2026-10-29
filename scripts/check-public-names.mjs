import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = pathResolve(fileURLToPath(new URL('..', import.meta.url)));
// Nimbir is the only public product name. "Recall" is the internal engine name
// and must never appear beside Nimbir/NOMOI on this public surface (nimbir.com).
// Flat repo: nginx serves the whole tree, so scan everything text.
const BANNED = [
  { label: 'Nimbir Recall', pattern: /nimbir[^a-z0-9]*recall/i },
  { label: 'Recall by Nimbir', pattern: /recall[^a-z0-9]*by[^a-z0-9]*nimbir/i },
  { label: 'NOMOI Recall', pattern: /nomoi[^a-z0-9]*recall/i },
];
const SKIP_DIRS = new Set(['.git', 'node_modules', 'scripts']);
// Internal engine data files — "recall" in them is the internal name, not public copy.
const SKIP_FILES = new Set([
  'nimbir-real-recall-slice.json',
  'nimbir-real-recall-slice-classified.json',
]);

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === repoRoot && dir === repoRoot) continue;
    const full = join(dir, entry);
    const rel = relative(repoRoot, full);
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(full, files);
    } else {
      if (SKIP_FILES.has(entry)) continue;
      files.push(full);
    }
  }
  return files;
}

function isTextFile(bytes) {
  const sniff = bytes.subarray(0, 8192);
  return !sniff.includes(0x00);
}

const failures = [];
for (const file of walk(repoRoot)) {
  const bytes = readFileSync(file);
  if (!isTextFile(bytes)) continue;
  const lines = bytes.toString('utf8').split('\n');
  lines.forEach((line, index) => {
    for (const rule of BANNED) {
      if (rule.pattern.test(line)) {
        failures.push(`${relative(repoRoot, file)}:${index + 1}: banned public name "${rule.label}": ${line.trim().slice(0, 120)}`);
      }
    }
  });
}

if (failures.length > 0) {
  console.error('check-public-names: FAIL');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log('check-public-names: OK — no banned "Nimbir Recall" naming in nimbir-web');
