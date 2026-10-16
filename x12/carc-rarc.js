// app/x12/carc-rarc.js
// Small, deliberately narrow lookup for Claim Adjustment Reason Codes (CARC) and
// Remittance Advice Remark Codes (RARC). Only the codes used by the synthetic
// cardiology fixtures in app/x12/fixtures/ are included, and each description
// below was copied verbatim from the X12.org public code pages on 2026-10-05:
//   https://x12.org/codes/claim-adjustment-reason-codes
//   https://x12.org/codes/remittance-advice-remark-codes
//
// Deliberate design choice: a real uploaded 835 will contain CARC/RARC codes
// outside this short list. lookupCARC()/lookupRARC() never invent a description
// for a code they don't recognize — they return the code with an honest
// "not independently verified in this build" note instead. Fabricating a plausible-
// sounding reason-code description would be a false factual claim about what a
// payer said, which NOMOI's standing rules forbid even where the UI copy itself is
// otherwise unconstrained.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NimbirCodes = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERIFIED_ON = '2026-10-05';
  const CARC_SOURCE = `X12.org Claim Adjustment Reason Codes (verified ${VERIFIED_ON})`;
  const RARC_SOURCE = `X12.org Remittance Advice Remark Codes (verified ${VERIFIED_ON})`;

  const CARC = {
    '1': "Deductible Amount",
    '4': "The procedure code is inconsistent with the modifier used. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present.",
    '45': "Charge exceeds fee schedule/maximum allowable or contracted/legislated fee arrangement. Usage: This adjustment amount cannot equal the total service or claim charge amount; and must not duplicate provider adjustment amounts (payments and contractual reductions) that have resulted from prior payer(s) adjudication. (Use only with Group Codes PR or CO depending upon liability)",
    '50': "These are non-covered services because this is not deemed a 'medical necessity' by the payer.",
    '97': "The benefit for this service is included in the payment/allowance for another service/procedure that has already been adjudicated. Usage: Refer to the 835 Healthcare Policy Identification Segment (loop 2110 Service Payment Information REF), if present."
  };

  const RARC = {
    N115: "This decision was based on a Local Coverage Determination (LCD). An LCD provides a guide to assist in determining whether a particular item or service is covered. A copy of this policy is available at www.cms.gov/mcd, or if you do not have web access, you may contact the contractor to request a copy of the LCD."
  };

  function lookupCARC(code) {
    const key = String(code);
    const description = CARC[key];
    return description
      ? { code: key, description, verified: true, source: CARC_SOURCE }
      : { code: key, description: null, verified: false, source: 'Code not independently verified against x12.org in this build; showing the raw code only.' };
  }

  function lookupRARC(code) {
    const key = String(code);
    const description = RARC[key];
    return description
      ? { code: key, description, verified: true, source: RARC_SOURCE }
      : { code: key, description: null, verified: false, source: 'Code not independently verified against x12.org in this build; showing the raw code only.' };
  }

  return { lookupCARC, lookupRARC };
});
