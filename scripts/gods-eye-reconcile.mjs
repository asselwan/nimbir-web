import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { bookTrajectory } from '../gods-eye.js';
const rows = JSON.parse(readFileSync(new URL('../nimbir-real-recall-slice-classified.json', import.meta.url), 'utf8')).claims;
let total = 0, remitted = 0, old = 0;
const durations = [];
for (const row of rows) {
  const amount = row.claim_net == null ? 0 : Math.round(Number(row.claim_net) * 100);
  total += amount;
  if (row.first_remitted_at) remitted += amount;
  if (typeof row.submitted_at !== 'string' || typeof row.first_remitted_at !== 'string') continue;
  const start = Date.parse(row.submitted_at + 'T00:00:00Z');
  const finish = Date.parse(row.first_remitted_at + 'T00:00:00Z');
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) continue;
  const elapsed = Math.round((finish - start) / 86400000);
  durations.push(elapsed);
  if (elapsed > 90) old += amount;
}
durations.sort((a, b) => a - b);
const mid = Math.floor(durations.length / 2);
const median = durations.length ? durations.length % 2 ? durations[mid] : (durations[mid - 1] + durations[mid]) / 2 : null;
const projected = bookTrajectory(rows);
assert.equal(projected.totalCents, total, 'in-flight net drift');
assert.equal(projected.remittedCents, remitted, 'remitted net drift');
assert.equal(projected.buckets['90+'].netCents, old, '90+ net drift');
assert.equal(projected.medianDays, median, 'median days drift');
const fmt = cents => (cents / 100).toFixed(2);
console.log(`gods-eye-reconcile: OK — in-flight ${fmt(total)} net units; remitted ${fmt(remitted)} net units; 90+ ${fmt(old)} net units; median ${median} days`);
