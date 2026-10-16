// app/x12/to-nimbir.js
// Normalises the structure parse835() returns into the claim-line schema
// app/claim-lines.json already uses (read against app/app.js's `load()` and
// `render()` before writing this), so a dropped-in 835 renders in the same
// work-queue UI as the bundled demo dataset with no UI changes required.
//
// One output row per SVC service line (the level a CPT-specific denial like
// CO-97/CO-4 actually lives at); a claim with no SVC lines at all still gets one
// row built from its CLP totals so nothing silently disappears.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    const { parse835 } = require('./parse835.js');
    const { lookupCARC, lookupRARC } = require('./carc-rarc.js');
    module.exports = factory(parse835, lookupCARC, lookupRARC);
  } else {
    root.NimbirFromX12 = factory(root.Nimbir835.parse835, root.NimbirCodes.lookupCARC, root.NimbirCodes.lookupRARC);
  }
})(typeof self !== 'undefined' ? self : this, function (parse835, lookupCARC, lookupRARC) {
  'use strict';

  // CO = Contractual Obligation (provider's write-off/denial), the group this
  // build treats as "denied $" for totals. PR/OA/PI are patient or other-payer
  // responsibility, not a provider denial, so they are tracked separately.
  const DENIAL_GROUP = 'CO';
  // Reason codes under CO that this build renders as a hard denial needing a
  // reviewer decision ("Needs approval"), vs. a routine contractual write-off
  // ("Needs review"). This list is intentionally only the codes the synthetic
  // fixtures exercise and verified against x12.org — see carc-rarc.js.
  const FLAGGED_DENIAL_CARCS = new Set(['4', '50', '97']);

  function money(n) {
    return n == null ? null : Number(n);
  }

  function adjustmentLabel(adj) {
    const looked = lookupCARC(adj.reasonCode);
    const head = `${adj.groupCode}-${adj.reasonCode}`;
    return looked.verified ? `${head} — ${looked.description}` : `${head} (${looked.source})`;
  }

  function remarkLabel(remark) {
    const looked = lookupRARC(remark.code);
    return looked.verified
      ? `${remark.qualifier} ${remark.code} — ${looked.description}`
      : `${remark.qualifier} ${remark.code} (${looked.source})`;
  }

  function classifyState(claim, service, payerName) {
    if (!payerName) return 'Blocked'; // matches app.js's statusContract() "payer missing" contract text
    if (claim.statusCode === '22') return 'Needs review'; // reversal of a previous payment
    if (claim.statusCode === '4') return 'Needs approval'; // claim denied outright
    const adjustments = [].concat(service ? service.adjustments || [] : [], claim.adjustments || []);
    const coAdjustments = adjustments.filter(a => a.groupCode === DENIAL_GROUP);
    if (coAdjustments.some(a => FLAGGED_DENIAL_CARCS.has(String(a.reasonCode)))) return 'Needs approval';
    if (coAdjustments.length) return 'Needs review'; // routine contractual write-off, still worth a glance
    const paid = service ? service.paid : claim.totalPaid;
    const charge = service ? service.charge : claim.totalCharge;
    if (paid != null && charge != null && paid >= charge) return 'Ready';
    const prAdjustments = adjustments.filter(a => a.groupCode === 'PR');
    if (prAdjustments.length) return 'Ready'; // patient-responsibility only, no payer action needed
    return 'Needs review';
  }

  function nextActionFor(state, primaryAdj) {
    if (state === 'Blocked') return 'Payer (N1*PR) is missing from this 835; re-export the remittance with the payer loop before it can be reviewed.';
    if (state === 'Needs approval' && primaryAdj) return `Review the ${primaryAdj.groupCode}-${primaryAdj.reasonCode} denial reason and supporting documentation, then decide whether to appeal.`;
    if (state === 'Needs review' && primaryAdj) return `Confirm the ${primaryAdj.groupCode}-${primaryAdj.reasonCode} adjustment matches the fee schedule or payer rule before closing this line.`;
    if (state === 'Needs review') return 'Reconcile this reversal against the original payment before resubmitting or writing it off.';
    return 'No reviewer action needed; payment matches the recorded charge or patient responsibility.';
  }

  function pickPrimaryAdjustment(adjustments) {
    const co = adjustments.filter(a => a.groupCode === 'CO');
    if (co.length) return co[0];
    return adjustments[0] || null;
  }

  function lineId(claim, service) {
    if (!service) return `Claim ${claim.patientControlNumber} (no service lines reported)`;
    const mods = service.modifiers.length ? `-${service.modifiers.join('-')}` : '';
    return `${service.procedureCode || 'Unknown CPT'}${mods}`;
  }

  function buildRow(ctx, claim, service) {
    const { payer, fileName, txControlNumber, headerDate } = ctx;
    const adjustments = [].concat(service ? service.adjustments || [] : [], claim.adjustments || []);
    const primaryAdj = pickPrimaryAdjustment(adjustments);
    const remarkCodes = [].concat(service ? service.remarkCodes || [] : [], claim.remarkCodes || []);
    const payerName = payer && payer.name ? payer.name : 'Not present in source';
    const state = classifyState(claim, service, payer && payer.name);
    const charge = service ? service.charge : claim.totalCharge;
    const paid = service ? service.paid : claim.totalPaid;

    const drivers = [];
    drivers.push(`835 claim status ${claim.statusCode ?? 'unknown'} (${claim.statusDescription || 'status code not recognized'})`);
    if (adjustments.length) {
      for (const adj of adjustments) drivers.push(`${service ? 'Service' : 'Claim'}-level adjustment ${adjustmentLabel(adj)}: ${money(adj.amount) ?? 'amount not supplied'}`);
    } else {
      drivers.push('No CAS adjustment reported on this line; payment matches the billed charge in the source file.');
    }
    for (const remark of remarkCodes) drivers.push(`Remark code ${remarkLabel(remark)}`);
    drivers.push(`Parsed locally from uploaded 835 file "${fileName}" (ST control ${txControlNumber}); nothing was uploaded to a server.`);

    const denialCategory = primaryAdj ? `${primaryAdj.groupCode}-${primaryAdj.reasonCode}` : (claim.statusCode === '22' ? 'Reversal (CLP02=22)' : 'No adjustment reported');
    const payerResponse = `Claim status ${claim.statusCode ?? 'unknown'} (${claim.statusDescription || 'unrecognized'})${primaryAdj ? ` · ${primaryAdj.groupCode}-${primaryAdj.reasonCode}` : ''}`;

    return {
      claim_id: `x12-${claim.patientControlNumber || 'unknown'}`,
      line_id: lineId(claim, service),
      payer: payerName,
      payer_response: payerResponse,
      amount: money(charge),
      currency: 'USD', // the 835 005010X221A1 is a US-domestic transaction set; no CUR segment is expected
      denial_category: denialCategory,
      rcm_jev_classification: primaryAdj ? adjustmentLabel(primaryAdj) : denialCategory,
      review_reason: `${denialCategory}${primaryAdj && lookupCARC(primaryAdj.reasonCode).verified ? `: ${lookupCARC(primaryAdj.reasonCode).description}` : ''}`,
      review_drivers: drivers,
      evidence_source: `Uploaded 835 file: ${fileName} — ST control ${txControlNumber}, CLP payer claim control number ${claim.payerClaimControlNumber || 'not present'}. Parsed locally in this browser; not persisted or transmitted.`,
      owner: 'Reviewer',
      last_update: headerDate || new Date().toISOString().slice(0, 10),
      state,
      next_action: nextActionFor(state, primaryAdj),
      paid_amount: money(paid) // extra field beyond the base schema; the UI ignores unknown keys
    };
  }

  /**
   * Convert one parsed 835 (the object parse835() returns) into Nimbir claim-line
   * rows plus a small totals summary (denied $, by CARC, by CPT).
   */
  function toNimbirRows(parsed, opts) {
    const fileName = (opts && opts.fileName) || 'uploaded-835.txt';
    const rows = [];
    for (const group of parsed.functionalGroups) {
      for (const tx of group.transactions) {
        const headerDate = (tx.headerDates && tx.headerDates['405']) || (tx.payment && tx.payment.paymentDate) || null;
        const ctx = { payer: tx.payer, fileName, txControlNumber: tx.controlNumber, headerDate };
        for (const claim of tx.claims) {
          if (claim.services.length) {
            for (const service of claim.services) rows.push(buildRow(ctx, claim, service));
          } else {
            rows.push(buildRow(ctx, claim, null));
          }
        }
      }
    }
    return rows;
  }

  function computeTotals(rows) {
    const byCARC = {};
    const byCPT = {};
    let deniedTotal = 0;
    for (const row of rows) {
      const amount = row.amount || 0;
      const isDenied = row.denial_category && /^CO-/.test(row.denial_category);
      if (isDenied) {
        deniedTotal += amount;
        byCARC[row.denial_category] = (byCARC[row.denial_category] || 0) + amount;
        const cpt = (row.line_id || '').split('-')[0];
        byCPT[cpt] = (byCPT[cpt] || 0) + amount;
      }
    }
    return {
      deniedTotal: Math.round(deniedTotal * 100) / 100,
      byCARC,
      byCPT
    };
  }

  /**
   * End-to-end convenience: raw 835 text -> { schema_version, data_kind,
   * source_note, claim_lines, totals, warnings }. This is what app/x12/dropzone.js
   * calls after reading the dropped file with FileReader.
   */
  function fromX12Text(rawText, opts) {
    const parsed = parse835(rawText);
    const claim_lines = toNimbirRows(parsed, opts);
    return {
      schema_version: 1,
      data_kind: 'uploaded_835',
      source_note: `Parsed locally in this browser from the uploaded file "${(opts && opts.fileName) || 'uploaded-835.txt'}". Nothing was uploaded to a server.`,
      claim_lines,
      totals: computeTotals(claim_lines),
      warnings: parsed.warnings
    };
  }

  return { toNimbirRows, computeTotals, fromX12Text };
});
