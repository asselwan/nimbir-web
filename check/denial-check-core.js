(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../appeals/compose.js'));
  } else {
    root.NimbirDenialCheck = factory(root.NimbirAppealComposer);
  }
})(globalThis, function (composer) {
  'use strict';

  const DENIAL_GROUP = 'CO'; // Same group as x12/to-nimbir.js.
  const routeLabels = Object.freeze({
    corrected_claim: 'Fix and resubmit (corrected claim, not an appeal)',
    reopening: 'Request a reopening (clerical error)',
    redetermination: 'Request redetermination',
    appeal: 'Appeal',
    documentation_query: 'Ask the ordering clinician for documentation first',
    human_triage: 'Human triage: no verified rule for this code in this build'
  });

  const isDenial = adjustment => adjustment.groupCode === DENIAL_GROUP;
  const serviceDate = (service, claim) => service?.dates['472'] ?? claim.dates['232'] ?? null;
  const toCents = amount => Math.sign(amount) * Math.round((Math.abs(amount) + Number.EPSILON) * 100);

  function findingsForLine(service, claim, composeClaim, codes) {
    const amountsByCode = new Map();
    for (const adjustment of (service ?? claim).adjustments.filter(isDenial)) {
      const { reasonCode, amount } = adjustment;
      if (!amountsByCode.has(reasonCode)) amountsByCode.set(reasonCode, null);
      if (amount !== null) {
        amountsByCode.set(reasonCode, (amountsByCode.get(reasonCode) ?? 0) + toCents(amount));
      }
    }

    const rarc = service?.remarkCodes[0]?.code ?? claim.remarkCodes[0]?.code ?? null;
    return Array.from(amountsByCode, ([carc, cents]) => {
      const verified = Object.hasOwn(codes.carc, carc);
      const composeInput = verified ? { claim: composeClaim, denial: { group: DENIAL_GROUP, carc, rarc } } : null;
      const draft = composeInput ? composer.compose(composeInput, codes) : null;
      const route = draft?.route ?? 'human_triage';
      const preflight = draft?.preflight ?? [];
      const missing = [...(draft?.missing_inputs ?? [])];
      if (preflight.some(check => check.check === 'medical_necessity_narrative_present' && !check.pass)) {
        missing.push('A chart-sourced medical necessity narrative');
      }

      return {
        claimRef: claim.patientControlNumber,
        cpt: service?.procedureCode ?? null,
        modifiers: [...(service?.modifiers ?? [])],
        dos: serviceDate(service, claim),
        amount: cents === null ? null : cents / 100,
        carc,
        rarc,
        carcText: verified ? codes.carc[carc].text : null,
        rarcText: rarc && Object.hasOwn(codes.rarc, rarc) ? codes.rarc[rarc].text : null,
        route,
        routeLabel: routeLabels[route],
        preflight,
        missing,
        letter: draft?.letter_markdown ?? null,
        sentenceCount: draft?.sentences.length ?? 0,
        citedCount: draft?.sentences.filter(sentence => sentence.source_ref !== 'missing_input').length ?? 0,
        composeInput
      };
    });
  }

  function partyName(names) {
    return Array.from(names).join('; ') || null;
  }

  function analyze(parsed835, codes) {
    const payers = new Set();
    const payees = new Set();
    const findings = [];
    const unmatched = [];
    const byRoute = {};
    let deniedCents = 0;
    let claims = 0;
    let lines = 0;
    let deniedLines = 0;
    let needsCount = 0;

    for (const group of parsed835.functionalGroups) {
      for (const transaction of group.transactions) {
        const payer = transaction.payer?.name ?? null;
        if (payer) payers.add(payer);
        if (transaction.payee?.name) payees.add(transaction.payee.name);
        for (const claim of transaction.claims) {
          claims++;
          lines += claim.services.length;
          const composeClaim = {
            payer,
            lines: claim.services.map(service => ({ cpt: service.procedureCode, dos: serviceDate(service, claim) }))
          };
          if (transaction.payment.paymentDate != null) {
            composeClaim.remit_date = transaction.payment.paymentDate;
          }
          if (claim.statusCode === '4' && !claim.adjustments.some(isDenial) &&
              !claim.services.some(service => service.adjustments.some(isDenial))) {
            unmatched.push({ claimRef: claim.patientControlNumber });
          }

          for (const service of claim.services.length ? claim.services : [null]) {
            const lineFindings = findingsForLine(service, claim, composeClaim, codes);
            if (lineFindings.length === 0) continue;
            deniedLines++;
            if (lineFindings.some(finding => finding.route === 'human_triage' ||
                finding.missing.length || finding.preflight.some(check => !check.pass))) {
              needsCount++;
            }
            for (const finding of lineFindings) {
              const cents = toCents(finding.amount ?? 0);
              const route = byRoute[finding.route] ??= { count: 0, amount: 0 };
              route.count++;
              route.amount += cents;
              deniedCents += cents;
              findings.push(finding);
            }
          }
        }
      }
    }

    for (const route of Object.values(byRoute)) route.amount /= 100;
    return {
      payer: partyName(payers),
      payee: partyName(payees),
      claims,
      lines,
      deniedTotal: deniedCents / 100,
      findings,
      unmatched,
      byRoute,
      needsCount,
      totals: { deniedLines, verifiedLines: deniedLines - needsCount }
    };
  }

  return { analyze, routeLabels };
});
