// app/x12/deid-export.js
// "Export de-identified findings" — lets a practice that just dropped its own
// 835 into Nimbir (see app/x12/dropzone.js) share the RESULT with NOMOI without
// sharing any patient. Built for the council-approved pilot offer on
// ainur-nimbir (prm_35fc4fc2): the practice runs its own file in-browser and
// may then choose to export only claim-level financial/coding facts.
//
// Row shape is an ALLOWLIST, not a blocklist: only the fields named in the
// council ask are written out. Everything else — every NM1 person (QC patient,
// IL subscriber, 82/74 rendering/corrected-insured provider), every member ID,
// the CLP07 payer claim control number, and every address — is never read into
// a row in the first place, so there is no field to forget to strip later.
//
// HIPAA Safe Harbor, 45 CFR 164.514(b)(2)(i):
//   (C) all elements of dates except year are identifiers, so the only date
//       field exported is the service YEAR (YYYY), never year-month or day.
//   (R) any unique identifying number or code is an identifier, including one
//       derived from an identifier (a hash of CLP07 is still CLP07-derived).
//       164.514(c) only allows a re-identification code that is NOT derived
//       from PHI. So each row instead gets `row_id`: fresh CSPRNG bytes drawn
//       per row per export, derived from no field of the 835. It keeps rows
//       distinguishable inside one export and links to nothing outside it.
//       `claim_sequence` is the claim's ordinal position in this export only
//       (1, 2, 3...), also derived from no identifier.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    const nodeCrypto = require('crypto');
    module.exports = factory(() => nodeCrypto.randomBytes(16).toString('hex'));
  } else {
    root.NimbirDeidExport = factory(
      () => Array.from(window.crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('')
    );
  }
})(typeof self !== 'undefined' ? self : this, function (randomIdHex) {
  'use strict';

  function serviceYear(isoDate) {
    if (!isoDate || typeof isoDate !== 'string') return null;
    const m = isoDate.match(/^(\d{4})-\d{2}-\d{2}$/);
    return m ? m[1] : null; // if it isn't a full YYYY-MM-DD we don't know it's safe to truncate, so drop it
  }

  function adjRow(a, level) {
    return { level, group_code: a.groupCode, reason_code: a.reasonCode, amount: a.amount };
  }

  const CSV_COLUMNS = ['row_id', 'claim_sequence', 'payer_name', 'cpt_code',
    'modifiers', 'units_paid', 'units_submitted', 'charge_amount', 'paid_amount',
    'claim_status_code', 'adjustments', 'remark_codes', 'service_year'];

  function toCsv(rows) {
    const quote = v => '"' + String(v ?? '').replaceAll('"', '""') + '"';
    const cell = (row, col) => {
      const v = row[col];
      if (Array.isArray(v)) return quote(JSON.stringify(v));
      return quote(v);
    };
    return [CSV_COLUMNS.join(','), ...rows.map(r => CSV_COLUMNS.map(c => cell(r, c)).join(','))].join('\n');
  }

  /**
   * Build a de-identified export from a parse835() result. Row ids come from
   * the platform's real CSPRNG (Web Crypto in a browser, node:crypto under
   * node:test). Kept async so existing `await` callers are unchanged.
   * Returns { rows, json, csv }.
   */
  async function buildDeidExport(parsed) {
    const rows = [];
    let claimSequence = 0;
    for (const group of parsed.functionalGroups) {
      for (const tx of group.transactions) {
        const payerName = tx.payer && tx.payer.name ? tx.payer.name : null;
        for (const claim of tx.claims) {
          claimSequence += 1;
          const claimAdjustments = (claim.adjustments || []).map(a => adjRow(a, 'claim'));
          const claimRemarks = (claim.remarkCodes || []).map(r => ({ qualifier: r.qualifier, code: r.code }));
          const claimYear = serviceYear(claim.dates && claim.dates['232']);
          const services = claim.services.length ? claim.services : [null];
          for (const service of services) {
            const adjustments = claimAdjustments.concat((service ? service.adjustments || [] : []).map(a => adjRow(a, 'service')));
            const remarkCodes = claimRemarks.concat((service ? service.remarkCodes || [] : []).map(r => ({ qualifier: r.qualifier, code: r.code })));
            const year = serviceYear(service && service.dates && service.dates['472']) || claimYear;
            rows.push({
              row_id: randomIdHex(),
              claim_sequence: claimSequence,
              payer_name: payerName,
              cpt_code: service ? service.procedureCode : null,
              modifiers: service ? service.modifiers.slice() : [],
              units_paid: service ? service.unitsPaid : null,
              units_submitted: service ? service.unitsSubmitted : null,
              charge_amount: service ? service.charge : claim.totalCharge,
              paid_amount: service ? service.paid : claim.totalPaid,
              claim_status_code: claim.statusCode,
              adjustments,
              remark_codes: remarkCodes,
              service_year: year
            });
          }
        }
      }
    }
    return { rows, json: JSON.stringify(rows, null, 2), csv: toCsv(rows) };
  }

  return { buildDeidExport, BANNER_TEXT: 'Export follows HIPAA Safe Harbor field rules: no patient names or identifiers, no dates finer than year, no identifier-derived codes (row_id is random). Review the preview before sending.' };
});
