// verification-chip.js — the shared verification-chip contract.
//
// Lifted from the Trawl/Reckon engine (nomoi-research/web/app.html:20-24, :220-232) into a
// dependency-free module so both the research engine and Nimbir consume ONE definition.
// Source of the contract: .ainur/RECKON_DESIGN_SPEC_K3_2026_09_14.md §3.4-§3.5 and
// .tools/research-route:14-23 (withhold-below-tier rule).
//
// The contract, in one place:
//   1. Four states, each carrying a glyph AND a word AND a shape — colour is never the only signal.
//   2. Withhold rule: below the tier that can pay for primary-source verification the chip is
//      WITHHELD, never redefined. A chip that means something different at different tiers is a
//      chip that means nothing.
//   3. The four verdict colours appear on claim chips and the budget meter and NOWHERE else.
//   4. Expectation is set before spend: the mode control states how many claims will be checked.
//   5. Budget exhaustion never stops the work: research continues, verification stops, and the UI
//      says so at the exact claim where it happened — inline system card, never a modal.
//   6. Every Unchecked chip offers a promotion path: Check this claim / Queue for next mission /
//      Get more checks.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NomoiVerificationChip = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The single tier that can reserve primary-source verification (research-route:14-19:
  // the mission ledger refuses a paid reservation from any cheaper tier).
  const VERIFYING_TIER = 'flagship';

  const STATES = {
    VERIFIED: 'verified',
    QUALIFIED: 'qualified',
    CONTRADICTED: 'contradicted',
    UNCHECKED: 'unchecked'
  };

  // Glyph AND word AND shape per state. Shape differs where hue might not read:
  // Unchecked alone carries a dashed border; Contradicted carries a strike on its glyph.
  const DESCRIPTORS = {
    verified:     { glyph: '✓', word: 'Verified',     shape: 'solid',  className: 'vc-verified' },
    qualified:    { glyph: '!',      word: 'Qualified',    shape: 'solid',  className: 'vc-qualified' },
    contradicted: { glyph: '✕', word: 'Contradicted', shape: 'strike', className: 'vc-contradicted' },
    unchecked:    { glyph: '○', word: 'Unchecked',    shape: 'dashed', className: 'vc-unchecked' }
  };

  const VERDICT_CLASSES = ['vc-verified', 'vc-qualified', 'vc-contradicted', 'vc-unchecked'];

  function descriptor(state) {
    const d = DESCRIPTORS[state];
    if (!d) throw new Error('unknown verification state: ' + state);
    return d;
  }

  // The withhold rule. A check whose evidence requires primary-source verification gets NO chip
  // below the verifying tier — withheld, never redefined. Locally-evidenced checks (a hash-verified
  // citation, a code page verified on a dated pass) are not tier-gated: their verification already
  // happened and does not rest on the tier paying for it.
  function chipFor(check, tier) {
    if (check.needsPrimarySource && tier !== VERIFYING_TIER) {
      return {
        withheld: true,
        state: null,
        reason: 'Verification chip withheld at this tier: this check needs primary-source verification, which only a ' + VERIFYING_TIER + ' run can reserve. It is not shown as Unchecked or Qualified — an unverified chip that looks like a verified one is decoration, not a verdict.'
      };
    }
    const d = descriptor(check.state);
    return { withheld: false, state: check.state, glyph: d.glyph, word: d.word, shape: d.shape, className: d.className, label: check.label };
  }

  // §3.2 — expectation set before spend.
  function expectationLine(claimsToCheck, totalClaims) {
    return totalClaims === claimsToCheck
      ? 'All ' + totalClaims + ' claim' + (totalClaims === 1 ? '' : 's') + ' will be checked before this run starts.'
      : claimsToCheck + ' of ' + totalClaims + ' claim' + (totalClaims === 1 ? '' : 's') + ' will be checked before this run starts; the rest stay Unchecked.';
  }

  // §3.5 — budget exhaustion never stops the work. Inline system card, never a modal.
  function budgetExhaustionCard(claimLabel) {
    return {
      kind: 'inline-system-card',
      neverModal: true,
      text: 'Checks ran out at "' + claimLabel + '". The review continues — every remaining claim is still shown and still workable — but no further claims can be verified until more checks are available.'
    };
  }

  // §3.4 — every Unchecked chip offers a promotion path.
  function promotionAction(checksRemaining) {
    if (checksRemaining > 0) {
      return { action: 'check-this-claim', label: 'Check this claim', note: 'Spends 1 of ' + checksRemaining + ' remaining check' + (checksRemaining === 1 ? '' : 's') + '.' };
    }
    return {
      action: 'exhausted',
      options: [
        { action: 'queue-next-mission', label: 'Queue for next mission' },
        { action: 'get-more-checks', label: 'Get more checks' }
      ],
      note: 'No checks remain in this run’s budget.'
    };
  }

  // Chip styles only. The four verdict colours appear here and in the budget meter and NOWHERE
  // else; a consumer must not reuse these custom properties for non-verdict UI. Dark scheme and
  // forced-colours both keep glyph + word + dashed border as the load-bearing signal.
  const CSS = '.vc-chips{display:flex;flex-wrap:wrap;gap:6px;padding:2px 0}.vc-chip{display:inline-flex;align-items:center;gap:6px;min-height:26px;padding:2px 10px;border-radius:999px;font:500 12px/1.3 Inter,system-ui,sans-serif;border:1px solid transparent;background:#EFEDE5;color:#6E6A5F}.vc-chip .vc-g{font-family:"DM Mono",ui-monospace,monospace;font-size:11px}.vc-chip.vc-verified{background:#E3F2E7;color:#0C6B36}.vc-chip.vc-qualified{background:#FBF0D8;color:#8A5A00}.vc-chip.vc-contradicted{background:#FAE6E3;color:#B3261E}.vc-chip.vc-contradicted .vc-g{text-decoration:line-through}.vc-chip.vc-unchecked{background:#EFEDE5;color:#6E6A5F;border:1px dashed #A9A494}.vc-chip .vc-promote{margin-left:2px;font-size:11px;text-decoration:underline;text-underline-offset:2px;background:none;border:0;padding:0;color:inherit;font:inherit;cursor:pointer}.vc-withheld{font:400 12px/1.6 Inter,system-ui,sans-serif;color:#6E6A5F;border-left:2px solid #C9C4B4;padding:2px 0 2px 10px;margin:4px 0}.vc-card{border-left:3px solid #8A5A00;background:#FBF0D8;color:#8A5A00;font:400 12px/1.6 Inter,system-ui,sans-serif;padding:10px 12px;border-radius:6px;margin:8px 0}@media(prefers-color-scheme:dark){.vc-chip{background:#2A2925;color:#B9B4A6}.vc-chip.vc-verified{background:#12331F;color:#7FD8A4}.vc-chip.vc-qualified{background:#33270A;color:#E5C368}.vc-chip.vc-contradicted{background:#3A1714;color:#F1A69E}.vc-chip.vc-unchecked{background:#2A2925;color:#B9B4A6;border:1px dashed #8A8578}.vc-withheld{color:#B9B4A6;border-left-color:#8A8578}.vc-card{background:#33270A;color:#E5C368}}';

  return {
    STATES: STATES,
    VERIFYING_TIER: VERIFYING_TIER,
    descriptor: descriptor,
    chipFor: chipFor,
    expectationLine: expectationLine,
    budgetExhaustionCard: budgetExhaustionCard,
    promotionAction: promotionAction,
    VERDICT_CLASSES: VERDICT_CLASSES,
    CSS: CSS
  };
});
