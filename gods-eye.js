// Pure projections over the checked-in, de-identified trajectory and queue snapshots.
const cents = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 100);
const date = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? Date.parse(`${value}T00:00:00Z`) : NaN;
const days = c => {
  const start = date(c.submitted_at), end = date(c.first_remitted_at);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.round((end - start) / 86400000) : null;
};
const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const ordered = rows => [...rows].sort((a, b) => {
  const ad = date(a.submitted_at), bd = date(b.submitted_at);
  return (Number.isFinite(ad) ? ad : Infinity) - (Number.isFinite(bd) ? bd : Infinity) || String(a.demo_claim_id).localeCompare(String(b.demo_claim_id));
});
const sum = rows => rows.reduce((total, c) => total + (cents(c.claim_net) || 0), 0);
export function bookTrajectory(rows) {
  const buckets = Object.fromEntries(['0–30', '31–60', '61–90', '90+', 'Unknown'].map(k => [k, { count: 0, netCents: 0 }]));
  let remittedCents = 0, outstandingCents = 0, unknownNetCount = 0;
  for (const c of rows) {
    const net = cents(c.claim_net);
    if (net == null) unknownNetCount++;
    if (c.first_remitted_at) remittedCents += net || 0;
    else outstandingCents += net || 0;
    const d = days(c);
    const key = d == null ? 'Unknown' : d <= 30 ? '0–30' : d <= 60 ? '31–60' : d <= 90 ? '61–90' : '90+';
    buckets[key].count++;
    buckets[key].netCents += net || 0;
  }
  return { count: rows.length, totalCents: sum(rows), remittedCents, outstandingCents,
    medianDays: median(rows.map(days)), buckets, unknownNetCount,
    unknownDateCount: rows.filter(c => days(c) == null).length };
}
export function payerVectors(rows, queue, riskSignal) {
  const groups = new Map();
  for (const c of rows) {
    const key = c.payer_code || 'Unknown payer';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  // There is no shared claim ID between these shipped snapshots. Never assign queue risk to a payer by guess.
  const queueIds = new Set(queue.map(c => c.claim_id));
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([payer, claims]) => {
    const sorted = ordered(claims);
    const pivot = Math.floor(sorted.length / 2);
    const earlier = median(sorted.slice(0, pivot).map(days));
    const later = median(sorted.slice(pivot).map(days));
    const changeDays = earlier == null || later == null ? null : later - earlier;
    const linked = claims.map(c => queue.find(q => q.claim_id === c.demo_claim_id)).filter(Boolean);
    const atRiskShare = linked.length ? linked.filter(c => ['high', 'medium'].includes(riskSignal(c)?.rank)).length / linked.length : null;
    return { payer, count: claims.length, netCents: sum(claims), medianDays: median(claims.map(days)),
      earlierDays: earlier, laterDays: later, changeDays,
      direction: changeDays == null ? 'unknown' : changeDays < 0 ? 'improving' : changeDays > 0 ? 'worsening' : 'flat',
      atRiskShare, linkedCount: linked.length, unlinkedCount: claims.filter(c => !queueIds.has(c.demo_claim_id)).length };
  });
}
export function rankedRisk(queue, riskSignal) {
  const weight = { high: 1, medium: 0.6, low: 0.3 };
  return queue.map(c => {
    const signal = riskSignal(c);
    const net = cents(c.amount);
    if (!signal) return null;
    const feature = signal.features[0];
    return { claim: c, rank: signal.rank, weightedCents: net == null ? null : Math.round(net * weight[signal.rank]), score: Number(signal.score),
      reason: feature ? `Scorer feature: ${feature}` : 'Scorer did not export a feature reason' };
  }).filter(Boolean).sort((a, b) => (b.weightedCents ?? -1) - (a.weightedCents ?? -1) || b.score - a.score || a.claim.claim_id.localeCompare(b.claim.claim_id)).slice(0, 10);
}
export function bookMix(rows) {
  const encounter = new Map(), activity = new Map();
  let unknownActivityCents = 0;
  for (const c of rows) {
    const net = cents(c.claim_net) || 0;
    const type = c.encounter_type || 'Unknown';
    encounter.set(type, (encounter.get(type) || 0) + net);
    if (!Array.isArray(c.activity_codes) || !c.activity_codes.length) { unknownActivityCents += net; continue; }
    // A claim can have several codes and no line-level amounts. Split claim net evenly to avoid double counting.
    const codes = [...new Set(c.activity_codes)];
    const base = Math.trunc(net / codes.length), extra = net - base * codes.length;
    codes.forEach((code, i) => activity.set(code, (activity.get(code) || 0) + base + (i < extra ? 1 : 0)));
  }
  const sorted = map => [...map].map(([name, netCents]) => ({ name, netCents })).sort((a, b) => b.netCents - a.netCents || a.name.localeCompare(b.name));
  return { encounter: sorted(encounter), activity: sorted(activity).slice(0, 8), unknownActivityCents };
}
export function whatMoved(vectors) {
  const known = vectors.filter(v => v.changeDays != null && v.payer !== 'Unknown payer').sort((a, b) => Math.abs(b.changeDays) - Math.abs(a.changeDays) || a.payer.localeCompare(b.payer));
  const v = known[0];
  if (!v) return 'Payer movement is unknown because the slice has no comparable remittance dates.';
  const verb = v.changeDays < 0 ? 'improved' : v.changeDays > 0 ? 'worsened' : 'held flat';
  return `${v.payer} remit time ${verb} by ${Math.abs(v.changeDays)} days between submission halves, across ${v.count} claims and ${(v.netCents / 100).toFixed(2)} net units.`;
}
export function godsEye(rows, queue, riskSignal) {
  const sorted = ordered(rows), half = Math.floor(sorted.length / 2);
  const vectors = payerVectors(rows, queue, riskSignal);
  return { book: bookTrajectory(rows), was: bookTrajectory(sorted.slice(0, half)), vectors,
    ranked: rankedRisk(queue, riskSignal), mix: bookMix(rows), movement: whatMoved(vectors) };
}
