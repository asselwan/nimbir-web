let claims = [];
let source = null;
let filter = 'All';
let sortBy = 'state';
let selected = null;
const demoDecisions = new Map();
// Real, claim-specific appeal letter drafts. Each entry is grounded only in that
// claim's own recorded denial_category/payer_response/amount fields (see app/appeals/*.html).
// Not illustrative — these are genuinely drafted for these exact claim_ids.
const CLAIM_APPEAL_DRAFTS = {
  'wb-1fd306401e7125fe7ca1d503': 'wb-1fd306401e7125fe7ca1d503.html',
  'wb-29ed0215bbb01746a1f21d4d': 'wb-29ed0215bbb01746a1f21d4d.html',
  'wb-ec98c4ff3f7e14fec76470ec': 'wb-ec98c4ff3f7e14fec76470ec.html'
};
const rows = document.getElementById('rows');
const search = document.getElementById('claim-search');
const sort = document.getElementById('claim-sort');
const setText = (id, value) => { document.getElementById(id).textContent = value ?? '—'; };
function addCell(tr, value, className) {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  cell.textContent = value ?? '—';
  tr.append(cell);
  return cell;
}
function statusContract(c) {
  if (c.state !== 'Needs approval' && c.state !== 'Blocked') return null;
  const flag = (c.review_drivers || []).find(driver => driver.startsWith('SV flag '));
  let unresolved;
  if (c.state === 'Blocked' && c.amount == null && c.currency == null) {
    unresolved = 'Displayable amount and currency are missing from the source.';
  } else if (c.state === 'Blocked' && c.payer === 'Not present in source') {
    unresolved = 'Payer is missing from the source; tariff citations do not establish payer coverage.';
  } else if (flag) {
    unresolved = flag.replace(/^SV flag /, 'Setting check: ');
  } else {
    unresolved = `${c.denial_category} evidence needs review${c.review_reason.includes('payer coverage not established') ? '; payer coverage is not established' : ''}.`;
  }
  return {
    unresolved,
    nextStep: `${c.owner}: ${c.next_action}`,
    nextUpdate: 'Illustrative: after this review step is completed. No update is scheduled in this demo.'
  };
}
// Denial-risk signal, read verbatim from the claim's own review_drivers.
// Two recorded shapes exist in claim-lines.json:
//   "Demo denial-risk rank: high (score 0.992063)"
//   "Demo review signals: uncalibrated denial-risk score 0.667704, high rank; not a denial decision."
// The score is kept as the source string; nothing is rounded, rescaled or turned into a percentage.
const RISK_RANK = /^Demo denial-risk rank:\s*(high|medium|low)\s*\(score\s*([0-9.]+)\)/i;
const RISK_SIGNAL = /uncalibrated denial-risk score\s*([0-9.]+),\s*(high|medium|low) rank/i;
const RISK_FEATURE = /^Risk feature:\s*/i;
const OTHER_CHECK = /^(sv-stay-setting:|SV flag )/i;
function isRiskDriver(text) {
  return RISK_RANK.test(text) || RISK_SIGNAL.test(text) || RISK_FEATURE.test(text);
}
function riskSignal(c) {
  const drivers = (c?.review_drivers || []).map(String);
  for (const d of drivers) {
    const a = d.match(RISK_RANK);
    const b = a ? null : d.match(RISK_SIGNAL);
    if (!a && !b) continue;
    return {
      rank: (a ? a[1] : b[2]).toLowerCase(),
      score: a ? a[2] : b[1],
      features: drivers.filter(x => RISK_FEATURE.test(x)).map(x => x.replace(RISK_FEATURE, '')),
      otherChecks: drivers.filter(x => OTHER_CHECK.test(x))
    };
  }
  return null;
}
function riskFeatureGloss(name) {
  const activity = name.match(/^activity=(.+)$/);
  if (activity) return ['Activity code on the claim', `activity=${activity[1]}`];
  return {
    log_claim_net: ['Claim net amount (log scale)', name],
    log_net_per_activity: ['Net amount per activity (log scale)', name]
  }[name] || ['Scorer feature', name];
}
function renderRisk(c) {
  const panel = document.getElementById('risk-explainer');
  const risk = riskSignal(c);
  panel.hidden = !risk;
  if (!risk) return;
  const chip = document.getElementById('risk-chip');
  chip.dataset.rank = risk.rank;
  chip.textContent = `${risk.rank} rank`;
  const steps = document.getElementById('risk-steps');
  steps.dataset.rank = risk.rank;
  steps.setAttribute('aria-label', `Rank position: ${risk.rank} of low, medium, high`);
  const list = document.getElementById('risk-reasons');
  list.replaceChildren();
  for (const feature of risk.features) {
    const [plain, raw] = riskFeatureGloss(feature);
    const li = document.createElement('li');
    const code = document.createElement('code');
    code.textContent = raw;
    li.append(document.createTextNode(`${plain} `), code);
    list.append(li);
  }
  list.hidden = !risk.features.length;
  setText('risk-reasons-note', risk.features.length
    ? 'Feature names as exported by the scorer. Their direction and weight were not exported, so they show what the scorer looked at, not how much each one counted.'
    : 'The scorer did not export feature reasons for this claim. Read the source evidence in the review drivers below.');
  setText('risk-outcome', c.payer_response || 'No payer outcome supplied');
  const other = document.getElementById('risk-other-wrap');
  other.hidden = !risk.otherChecks.length;
  setText('risk-other', risk.otherChecks.join(' · '));
  setText('risk-score', risk.score);
}
// --- Verification chips (D-0trawl-steal-1, prm_eb07b4a6 v13) ------------------------------
// The contract lives in verification-chip.js (shared, dependency-free, lifted from the
// Trawl/Reckon engine). This block only maps THIS claim's real recorded drivers onto it.
const VC = window.NomoiVerificationChip;
// This preview cannot reserve primary-source verification, so it honestly declares a
// below-flagship tier: primary-source checks are withheld here, never softened.
const VC_TIER = 'standard';
const vcBudget = { remaining: 2 };
let vcStyleDone = false;
const vcQueued = new Set();
function claimChecks(c) {
  const drivers = (c.review_drivers || []).map(String);
  const checks = [];
  const citation = drivers.find(d => /sha256:/i.test(d));
  if (citation) {
    const contradicted = drivers.some(d => /rule valid_from is after/i.test(d));
    checks.push({
      label: 'Tariff rule citation',
      state: contradicted ? VC.STATES.CONTRADICTED : VC.STATES.VERIFIED,
      note: contradicted ? 'Rule valid_from is after the claim date — the cited source disagrees with this use.' : 'Hash-verified citation recorded in this claim’s source drivers.'
    });
  }
  const setting = drivers.find(d => /^sv-stay-setting:/i.test(d));
  if (setting) checks.push({ label: 'Setting check', state: VC.STATES.QUALIFIED, note: 'Check ran with a stated caveat: ' + setting });
  if (riskSignal(c)) checks.push({ label: 'Denial-risk rank', state: VC.STATES.UNCHECKED, note: 'Uncalibrated demo scorer output; no verification stands behind it yet.' });
  const payer = drivers.find(d => /^EXPLORATORY: payer code/i.test(d));
  if (payer) checks.push({ label: 'Payer identity', state: VC.STATES.UNCHECKED, needsPrimarySource: true, note: payer });
  return checks;
}
function vcSpendCheck(label) {
  if (vcBudget.remaining <= 0) return;
  vcBudget.remaining--;
  vcQueued.add(label);
  if (vcBudget.remaining === 0) {
    const card = VC.budgetExhaustionCard(selected ? selected.claim_id : 'this claim');
    const box = document.createElement('p');
    box.className = 'vc-card';
    box.textContent = card.text;
    document.getElementById('vc-notes').append(box);
  }
  renderClaimChecks(selected);
}
function renderClaimChecks(c) {
  if (!VC) return;
  if (!vcStyleDone) {
    const style = document.createElement('style');
    style.textContent = VC.CSS;
    document.head.append(style);
    vcStyleDone = true;
  }
  const section = document.getElementById('claim-checks');
  const chips = document.getElementById('vc-chips');
  const notes = document.getElementById('vc-notes');
  chips.replaceChildren();
  notes.replaceChildren();
  const checks = c ? claimChecks(c) : [];
  section.hidden = !checks.length;
  if (!checks.length) return;
  for (const check of checks) {
    const verdict = VC.chipFor(check, VC_TIER);
    if (verdict.withheld) {
      const row = document.createElement('p');
      row.className = 'vc-withheld';
      row.textContent = verdict.reason;
      notes.append(row);
      continue;
    }
    const chip = document.createElement('span');
    chip.className = 'vc-chip ' + verdict.className;
    const glyph = document.createElement('span');
    glyph.className = 'vc-g';
    glyph.textContent = verdict.glyph;
    chip.append(glyph, document.createTextNode(verdict.word));
    chip.title = check.note || '';
    if (verdict.state === VC.STATES.UNCHECKED) {
      if (vcQueued.has(check.label)) {
        const done = document.createElement('small');
        done.textContent = ' · queued for the pilot verification mission';
        chip.append(done);
      } else {
        const promo = VC.promotionAction(vcBudget.remaining);
        const add = (spec) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'vc-promote';
          b.textContent = spec.label;
          b.title = spec.note || '';
          b.addEventListener('click', () => {
            if (spec.action === 'check-this-claim') vcSpendCheck(check.label);
            else vcQueued.add(check.label), renderClaimChecks(selected);
          });
          chip.append(b);
        };
        if (promo.action === 'check-this-claim') add(promo);
        else promo.options.forEach(add);
      }
    }
    chips.append(chip);
  }
}
const matchesSearch = (c, query) => !query ||
  [c.claim_id,c.review_reason,c.owner,c.state,c.payer,c.denial_category].some(value => String(value ?? '').toLowerCase().includes(query));
function span(className, text) {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text ?? '—';
  return el;
}
// Arrow/j/k move between queue rows; Enter or Space opens the claim.
function moveRowFocus(tr, step) {
  const next = step > 0 ? tr.nextElementSibling : tr.previousElementSibling;
  if (!next) return;
  next.focus();
  next.scrollIntoView({block:'nearest'});
}
let visibleQueue = [];
function render() {
  rows.replaceChildren();
  const query = search.value.trim().toLowerCase();
  const searched = claims.filter(c => matchesSearch(c, query));
  const visible = searched.filter(c => filter === 'All' || c.state === filter);
  const priority = {'Blocked': 0, 'Needs approval': 1, 'Needs review': 2, 'Ready': 3};
  // Keep equal values in source order. last_update is compared as supplied text;
  // its mixed formats are source data, so this UI does not infer a timezone or date.
  const sourceOrder = new Map(claims.map((claim, index) => [claim, index]));
  visible.sort((a, b) => {
    let result = 0;
    if (sortBy === 'amount') {
      const left = a.amount == null ? null : Number(a.amount);
      const right = b.amount == null ? null : Number(b.amount);
      result = left == null ? (right == null ? 0 : 1) : right == null ? -1 : right - left;
    } else if (sortBy === 'last_update') {
      result = String(b.last_update ?? '').localeCompare(String(a.last_update ?? ''));
    } else {
      result = (priority[a.state] ?? 4) - (priority[b.state] ?? 4);
    }
    return result || sourceOrder.get(a) - sourceOrder.get(b);
  });
  const similarCounts = new Map();
  for (const claim of claims) {
    const key = `${claim.state}\u0000${claim.review_reason}`;
    similarCounts.set(key, (similarCounts.get(key) || 0) + 1);
  }
  visibleQueue = visible;
  for (const c of visible) {
    const tr = document.createElement('tr');
    tr.tabIndex = 0;
    tr.dataset.state = c.state;
    tr.setAttribute('role', 'button');
    tr.setAttribute('aria-label', `Review ${c.claim_id}: ${c.review_reason}, ${c.state}`);
    tr.setAttribute('aria-selected', String(selected?.claim_id === c.claim_id));
    if (selected?.claim_id === c.claim_id) tr.classList.add('chosen');
    // Claim: identifier, then payer and category so the row reads without opening it.
    const idCell = addCell(tr, '', 'claim-cell');
    const id = span('claim-id mono', c.claim_id); id.title = c.claim_id;
    const meta = span('row-meta', [c.payer, c.denial_category].filter(Boolean).join(' · '));
    meta.title = meta.textContent;
    idCell.append(id, meta, span('row-cue', 'View details →'));
    // Reason: two-line clamp, with the status contract as three labelled single lines.
    const reasonCell = addCell(tr, '', 'reason-cell');
    const reason = span('reason-text', c.review_reason); reason.title = c.review_reason ?? '';
    reasonCell.append(reason);
    const similar = similarCounts.get(`${c.state}\u0000${c.review_reason}`);
    if (similar > 1) {
      const code = String(c.review_reason).match(/\b[A-Z]{3,5}-\d{3}\b/)?.[0];
      const badge = span('similar-count', `${similar} similar${code ? `: ${code}` : ' reasons'}`);
      badge.title = `${similar} claims share this state and review reason. Every row remains visible.`;
      reasonCell.append(badge);
    }
    const contract = statusContract(c);
    if (contract) {
      const statement = document.createElement('span');
      statement.className = 'status-microstatement';
      statement.title = `${contract.unresolved}\nNext step: ${contract.nextStep}\nNext update: ${contract.nextUpdate}`;
      for (const [label, text] of [['Unresolved', contract.unresolved], ['Next step', contract.nextStep], ['Next update', contract.nextUpdate]]) {
        const line = span('contract-line', '');
        line.append(span('contract-label', label), document.createTextNode(` ${text}`));
        statement.append(line);
      }
      reasonCell.append(statement);
    }
    addCell(tr, c.owner); addCell(tr, c.last_update, 'num');
    const tag = document.createElement('span');
    tag.className = 'tag ' + (c.state === 'Ready' ? 'green' : c.state === 'Blocked' ? 'red' : 'amber');
    tag.textContent = c.state;
    const stateCell = addCell(tr, ''); stateCell.append(tag);
    tr.addEventListener('click', () => choose(c));
    tr.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(c); }
      else if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); moveRowFocus(tr, 1); }
      else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); moveRowFocus(tr, -1); }
    });
    rows.append(tr);
  }
  // Filter chips count the current search per state; stat tiles below keep whole-dataset counts.
  document.querySelectorAll('.filters [data-filter]').forEach(button => {
    const state = button.dataset.filter;
    let count = button.querySelector('.chip-count');
    if (!count) { count = span('chip-count', ''); button.append(count); }
    count.textContent = String(state === 'All' ? searched.length : searched.filter(c => c.state === state).length);
  });
  setText('queue-count', claims.length ? `Showing ${visible.length} of ${claims.length}` : '');
  const empty = document.getElementById('queue-empty');
  empty.classList.remove('is-loading');
  empty.hidden = visible.length > 0;
  document.querySelector('.table-wrap').hidden = visible.length === 0;
  if (!visible.length) {
    setText('queue-empty-title', 'No claims match this view');
    setText('queue-empty-copy', 'Try another state or clear your search.');
    document.getElementById('clear-filters').hidden = false;
    document.getElementById('retry-load').hidden = true;
  }
  for (const [state, id] of [['Ready','ready-count'],['Needs approval','approval-count'],['Needs review','review-count'],['Blocked','blocked-count']])
    setText(id, String(claims.filter(c => c.state === state).length).padStart(2, '0'));
  document.querySelectorAll('[data-tile]').forEach(tile => {
    const active = tile.dataset.tile === filter;
    tile.classList.toggle('active', active);
    tile.setAttribute('aria-pressed', String(active));
  });
}
// Review drivers, grouped: payer-rule citations first, then demo risk signals, then review prompts.
const CITATION = /sha256:[a-f0-9]{64}|Mandatory Tariff\s+\d{4}\s*!\s*\d+/i;
const HASH = /sha256:([a-f0-9]{64})/i;
function shortHash(digest) { return `${digest.slice(0, 6)}…${digest.slice(-6)}`; }
function citationItem(reason) {
  const li = document.createElement('li');
  li.className = 'citation-driver';
  const exploratory = /^EXPLORATORY\b/i.test(reason);
  const badge = span('citation-badge' + (exploratory ? ' exploratory' : ''), exploratory ? 'EXPLORATORY · UNVERIFIED' : 'SOURCE CITATION');
  badge.title = reason.match(CITATION)[0];
  const body = span('citation-body', '');
  const hash = reason.match(HASH);
  if (hash) {
    // Shorten only the 64-character digest on screen; the full digest stays in the tooltip, copy and CSV.
    const code = document.createElement('code');
    code.className = 'hash';
    code.textContent = `sha256:${shortHash(hash[1])}`;
    code.title = hash[0];
    const before = reason.slice(0, hash.index);
    const after = reason.slice(hash.index + hash[0].length);
    const loc = after.match(/^#([^;]+)/);
    body.append(document.createTextNode(before), code);
    if (loc) body.append(span('cite-loc', loc[0]), document.createTextNode(after.slice(loc[0].length)));
    else body.append(document.createTextNode(after));
  } else {
    body.textContent = reason;
  }
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'cite-copy';
  copy.textContent = 'Copy';
  copy.setAttribute('aria-label', 'Copy full citation text');
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(reason); copy.textContent = 'Copied'; }
    catch { copy.textContent = 'Copy unavailable'; }
    window.setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
  });
  li.append(badge, copy, body);
  return li;
}
function renderDrivers(c) {
  const drivers = document.getElementById('drivers'); drivers.replaceChildren();
  const all = (c.review_drivers || []).map(String);
  const groups = [
    ['Source citations', all.filter(r => CITATION.test(r))],
    ['Demo risk signals', all.filter(r => !CITATION.test(r) && isRiskDriver(r))],
    ['Review prompts', all.filter(r => !CITATION.test(r) && !isRiskDriver(r))]
  ];
  for (const [label, items] of groups) {
    if (!items.length) continue;
    const head = document.createElement('li');
    head.className = 'driver-group';
    head.append(span('driver-group-label', label), span('driver-group-count', String(items.length)));
    drivers.append(head);
    for (const reason of items) {
      if (CITATION.test(reason)) { drivers.append(citationItem(reason)); continue; }
      const li = document.createElement('li');
      if (isRiskDriver(reason)) {
        li.className = 'risk-driver';
        const badge = span('risk-badge', 'DEMO RISK SIGNAL');
        badge.title = 'Uncalibrated demo scorer output; not a denial decision';
        li.append(badge, document.createTextNode(reason));
      } else {
        li.className = 'prompt-driver';
        li.textContent = reason;
      }
      drivers.append(li);
    }
  }
  if (!all.length) {
    const li = document.createElement('li');
    li.className = 'prompt-driver';
    li.textContent = 'No review drivers were supplied for this claim.';
    drivers.append(li);
  }
}
function choose(c) {
  if (!c) return;
  selected = c; render();
  const contract = statusContract(c);
  const status = {
    'Needs approval': {
      unresolved: `Reviewer approval is pending. Review focus: ${c.review_reason || 'No review reason supplied.'}`,
      owner: 'Reviewer action required'
    },
    Ready: {
      unresolved: `Reviewer check is pending. ${c.next_action || 'No next action supplied.'}`,
      owner: 'Ready for reviewer'
    },
    Blocked: {
      unresolved: `Source information is required. ${c.next_action || 'No next action supplied.'}`,
      owner: 'Awaiting source record'
    }
  }[c.state] || {
    unresolved: c.review_reason || 'No review reason supplied.',
    owner: c.owner || 'No owner supplied'
  };
  setText('status-unresolved', contract?.unresolved || status.unresolved);
  setText('status-owner', contract?.nextStep || status.owner);
  setText('status-next-update', contract?.nextUpdate || 'Illustrative: after the demo reviewer completes the next check. No update is scheduled.');
  for (const [id, value] of Object.entries({
    'claim-title': c.claim_id, reason: c.review_reason, line: c.line_id, payer: c.payer,
    amount: c.amount == null ? '—' : `${c.currency} ${Number(c.amount).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`,
    'denial-category': c.denial_category, 'rcm-jev': c.rcm_jev_classification,
    'payer-response': c.payer_response, owner: c.owner, next: c.next_action,
    gate: c.state === 'Needs approval' ? 'Approval required before send' : c.state === 'Blocked' ? 'Blocked until source arrives' : 'Reviewer checks next action'
  })) setText(id, value);
  renderEvidenceSource(c.evidence_source || 'Source not supplied');
  renderDrivers(c);
  renderRisk(c);
  renderClaimChecks(c);
  document.getElementById('simulate-approve').disabled = c.state === 'Blocked';
  document.getElementById('simulate-evidence').disabled = false;
  renderDecisionLog();
  document.getElementById('draft').disabled = c.state === 'Blocked';
  document.getElementById('draft').title = c.state === 'Blocked' ? 'Source attachment required before drafting' : '';
  document.getElementById('draft-text').hidden = true;
  const claimAppealFile = CLAIM_APPEAL_DRAFTS[c.claim_id];
  const claimAppealLink = document.getElementById('claim-appeal-link') || document.createElement('a');
  claimAppealLink.id = 'claim-appeal-link';
  claimAppealLink.className = 'button secondary';
  claimAppealLink.textContent = 'Open claim-specific appeal draft ↗';
  claimAppealLink.target = '_blank';
  claimAppealLink.rel = 'noopener';
  claimAppealLink.hidden = !claimAppealFile;
  if (claimAppealFile) claimAppealLink.href = `./appeals/${claimAppealFile}`;
  claimAppealLink.style.display = claimAppealLink.hidden ? 'none' : 'inline-flex';
  document.getElementById('draft-text').after(claimAppealLink);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const detail = document.getElementById('detail');
  detail.scrollIntoView({behavior: reduceMotion ? 'auto' : 'smooth'});
  // Brief arrival ring so the eye lands on the panel that changed.
  const panel = detail.querySelector('.panel');
  panel.classList.remove('arrived'); void panel.offsetWidth; panel.classList.add('arrived');
  document.getElementById('back-to-queue').hidden = false;
}
function renderEvidenceSource(full) {
  const target = document.getElementById('evidence-source');
  target.replaceChildren();
  target.title = full;
  const pattern = /(SHA-256\s+)([a-f0-9]{64})/ig;
  let position = 0;
  for (const match of full.matchAll(pattern)) {
    target.append(document.createTextNode(full.slice(position, match.index) + match[1]));
    const code = document.createElement('code');
    code.className = 'hash';
    code.textContent = shortHash(match[2]);
    code.title = match[0];
    target.append(code);
    position = match.index + match[0].length;
  }
  target.append(document.createTextNode(full.slice(position)));
}
function renderDecisionLog() {
  const log = document.getElementById('decision-log');
  log.replaceChildren();
  const events = demoDecisions.get(selected?.claim_id) || [];
  for (const event of events) {
    const item = document.createElement('li');
    item.textContent = `${event.time} · ${event.action} · local preview only`;
    log.append(item);
  }
  setText('decision-status', events.length ? `Last simulated decision: ${events.at(-1).action}. No claim-system change.` : 'No decision recorded in this preview session.');
}
function simulateDecision(action) {
  if (!selected || (action === 'Approval' && selected.state === 'Blocked')) return;
  const events = demoDecisions.get(selected.claim_id) || [];
  events.push({time:new Date().toLocaleTimeString(), action});
  demoDecisions.set(selected.claim_id, events);
  renderDecisionLog();
}
document.getElementById('simulate-approve').addEventListener('click', () => simulateDecision('Approval'));
document.getElementById('simulate-evidence').addEventListener('click', () => simulateDecision('Evidence requested'));
function setFilter(value) {
  filter = value;
  document.querySelectorAll('[data-filter]').forEach(button => {
    const active = button.dataset.filter === value;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  render();
}
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => setFilter(button.dataset.filter)));
// Stat tiles double as filters: click a count to see those claims; click again to show all.
document.querySelectorAll('[data-tile]').forEach(tile => {
  const toggle = () => { if (claims.length) setFilter(filter === tile.dataset.tile ? 'All' : tile.dataset.tile); };
  tile.addEventListener('click', toggle);
  tile.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
});
search.addEventListener('input', render);
sort.addEventListener('change', () => { sortBy = sort.value; render(); });
document.getElementById('evidence-copy').addEventListener('click', async event => {
  const button = event.currentTarget;
  try { await navigator.clipboard.writeText(selected?.evidence_source || 'Source not supplied'); button.textContent = 'Copied'; }
  catch { button.textContent = 'Copy unavailable'; }
  window.setTimeout(() => { button.textContent = 'Copy'; }, 1400);
});
search.addEventListener('keydown', e => {
  if (e.key === 'Escape' && search.value) { search.value = ''; render(); }
  else if (e.key === 'ArrowDown') { const first = rows.querySelector('tr'); if (first) { e.preventDefault(); first.focus(); } }
});
// "/" jumps to search from anywhere outside a text field.
document.addEventListener('keydown', e => {
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
  e.preventDefault(); search.focus(); search.select();
});
document.getElementById('back-to-queue').addEventListener('click', () => {
  const row = rows.querySelector('tr.chosen');
  document.getElementById('queue').scrollIntoView({behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
  if (row) {
    const wrap = document.querySelector('.table-wrap');
    wrap.scrollTop += row.getBoundingClientRect().top - wrap.getBoundingClientRect().top - wrap.clientHeight / 3;
    row.focus({preventScroll:true});
  }
});
document.getElementById('clear-filters').addEventListener('click', () => { search.value = ''; setFilter('All'); search.focus(); });
document.getElementById('retry-load').addEventListener('click', load);
document.getElementById('review-next').addEventListener('click', () => choose(visibleQueue[0] || claims.find(c => c.state === 'Needs approval') || claims[0]));
document.getElementById('draft').addEventListener('click', () => { document.getElementById('draft-text').hidden = false; });
document.getElementById('run-report').addEventListener('click', () => {
  const button = document.getElementById('run-report');
  const status = document.getElementById('report-status');
  const q = document.getElementById('question').selectedIndex;
  button.disabled = true; button.textContent = 'Creating preview…';
  status.textContent = 'Preparing the selected local view…';
  document.getElementById('report-output').hidden = true;
  window.setTimeout(() => {
    const subset = q === 0 ? claims.filter(c => c.state === 'Blocked') : q === 1 ? claims.filter(c => c.state === 'Needs approval') : claims;
    setText('report-answer', q === 2
      ? `This local dataset contains ${claims.length} encounters. It is a point-in-time sample; no historical comparison is available.`
      : `${subset.length} encounter${subset.length === 1 ? '' : 's'}: ${subset.map(c => `${c.claim_id} (${c.owner}; ${c.next_action})`).join('; ') || 'none'}.`);
    document.getElementById('report-output').hidden = false;
    status.textContent = 'Preview report ready.';
    button.disabled = false; button.textContent = 'Create preview report';
  }, 350);
});
document.getElementById('export').addEventListener('click', () => {
  if (!source) return;
  const columns = ['claim_id','line_id','payer','amount','currency','denial_category','rcm_jev_classification','review_reason','owner','last_update','state'];
  const quote = value => '"' + String(value ?? '').replaceAll('"', '""') + '"';
  const csv = [columns.join(','), ...claims.map(c => columns.map(k => quote(c[k])).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv'}));
  a.download = 'nimbir-demo-claim-lines.csv'; a.click();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
async function load() {
  document.querySelector('.table-wrap').hidden = true;
  document.getElementById('queue-empty').hidden = false;
  document.getElementById('queue-empty').classList.add('is-loading');
  setText('queue-empty-title', 'Loading claims…');
  setText('queue-empty-copy', 'Preparing the local claim-line view.');
  document.getElementById('retry-load').hidden = true;
  document.getElementById('clear-filters').hidden = true;
  try {
    const response = await fetch('./claim-lines.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!data || !Array.isArray(data.claim_lines) || !['real_deidentified','hand_built_sample'].includes(data.data_kind)) throw new Error('Invalid dataset shape');
    source = data; claims = data.claim_lines;
    document.getElementById('export').disabled = false;
    document.getElementById('run-report').disabled = false;
    document.getElementById('review-next').disabled = false;
    source.display_label = data.data_kind === 'real_deidentified' ? 'Real de-identified claims, demo purposes' : 'Hand-built de-identified-shape sample, demo purposes';
    document.querySelectorAll('[data-source-label]').forEach(el => { el.textContent = source.display_label; });
    setText('queue-scope', `Scope: ${claims.length} local encounters · ${source.display_label} · Counts include all records, even when a filter is active.`);
    setText('report-source', `Scope: ${claims.length} local encounters · Source: ${data.source_note} · Generated locally · No production outcome claim.`);
    render();
  } catch (error) {
    source = null; claims = []; rows.replaceChildren();
    document.querySelector('.table-wrap').hidden = true;
    document.getElementById('queue-empty').hidden = false;
    document.getElementById('queue-empty').classList.remove('is-loading');
    setText('queue-empty-title', 'Claim-line data unavailable');
    setText('queue-count', '');
    setText('queue-empty-copy', 'Check the local data file and serve this folder over HTTP, then retry.');
    document.getElementById('retry-load').hidden = false;
    for (const id of ['ready-count','approval-count','review-count','blocked-count']) setText(id, '—');
    document.getElementById('export').disabled = true;
    document.getElementById('run-report').disabled = true;
    document.getElementById('review-next').disabled = true;
    document.querySelectorAll('[data-source-label]').forEach(el => { el.textContent = 'Claim-line data unavailable'; });
    setText('queue-scope', 'Claim-line data unavailable; counts cannot be shown.');
  }
}
load();

const realAppealLetter = "Draft generated from a real de-identified claim; human review required before submission\n\nTo: Daman Claims Appeals / Provider Relations\nSubject: Request for reconsideration of authorization denial — de-identified claim REAL-001\nService date: 1 August 2020 | Submitted: 4 August 2020 | Remittance: 18 August 2020\nAmount at issue: 15,467.50 in recorded claim net amounts (currency and payable amount to be confirmed)\n\nDear Claims Review Team,\n\nWe request a line-level review of the `AUTH-001` denial on this claim. The remittance assigns that code and zero payment to drug-coded lines `E74-0478-00700-02` (9,557.50) and `E74-0478-00700-01` (5,535.00), and to line `24` (375.00). The same prior authorization reference is recorded on all three denied lines and on the related administration line `96413`. That reference does not, by itself, establish that approval was granted or that its scope matched the services. It does, however, warrant reconciliation with Daman's authorization record before the claim is treated as lacking approval.\n\nDaman circular `PRD/JA/JC/19/UAE-18` (20 March 2019, pages 1–2) sets out the preauthorization workflow for listed specialty drugs in day-case and outpatient care, including the applicable drug and administration or per-diem codes and review of dose, quantity, and medical reports. We are not seeking an exemption from that workflow. Please compare the authorization referenced on the remittance with the authorization decision, effective dates, approved drug codes and quantities, facility, member benefit, and actual service setting for 1 August 2020. Please also confirm whether the denied codes were subject to the controlling specialty-drug list and benefit terms on that date.\n\nIf the authorization covered these billed services and the claim met the applicable coding and benefit rules, please reverse the `AUTH-001` denial and reprocess the three lines. If it did not, please identify the precise missing approval or mismatch for each line, the effective policy provision relied upon, and whether a corrected claim or further clinical documentation is required. This will let the provider address the actual defect instead of resubmitting an unchanged claim.\n\nBefore sending this request, the provider's reviewer should verify the member and claim identifiers, obtain the original authorization decision and any amendments, confirm the drug names and doses behind the billed codes, and attach the treatment order, administration record, and itemized claim where relevant. The diagnosis codes on the claim provide clinical context but are not offered as independent proof of medical necessity or coverage.\n\nSincerely,\nAuthorized provider appeals representative — signature and contact details to be completed after review";
const realAppealButton = document.getElementById('show-real-appeal');
const realAppealOutput = document.getElementById('real-appeal-letter');
realAppealOutput.textContent = realAppealLetter;
realAppealButton.addEventListener('click', () => { const expanded = realAppealButton.getAttribute('aria-expanded') === 'true'; realAppealButton.setAttribute('aria-expanded', String(!expanded)); realAppealOutput.hidden = expanded; realAppealButton.textContent = expanded ? 'Show full appeal letter' : 'Hide full appeal letter'; });

// --- 835 drop-in hook begin (D-nimbir-835-dropin, prm_35fc4fc2) — all logic lives in app/x12/*.js; this is the only wiring point ---
if (window.Nimbir835Dropzone) window.Nimbir835Dropzone.init({ getClaims: () => claims, setClaims: v => { claims = v; }, getSource: () => source, setSource: v => { source = v; }, render, reload: load });
// --- 835 drop-in hook end ---
