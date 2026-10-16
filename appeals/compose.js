/*
 * Nimbir deterministic appeal composer (D-nimbir-appeal-engine).
 *
 * No LLM at runtime. Every sentence this file emits is either:
 *   (a) quoted verbatim from app/appeals/codes.json (which is itself sourced
 *       from the official X12 CARC/RARC lists and the public CMS IOM manual —
 *       see codes.json._meta.sources),
 *   (b) quoted verbatim from the `citation.excerpt` the caller supplies,
 *   (c) built from a field the caller actually supplied on `input.claim` /
 *       `input.denial`, or
 *   (d) a fixed boilerplate sentence from codes.json.boilerplate.
 * Anything the caller did not supply renders as a `[NEEDS: ...]` placeholder
 * instead of being invented. See `compose()` below and the tests in this
 * directory (compose.test.js, cardio-buyer-scenarios.test.js,
 * no-invented-fact.test.js) for the contract this enforces.
 *
 * Works as a plain <script> in a browser (attaches `NimbirAppealComposer` to
 * `globalThis`) and via `require('./compose.js')` in Node. Codes data is not
 * bundled in — pass the parsed contents of codes.json as the second
 * argument to `compose()` (or call `loadDefaultCodes()` from Node, which
 * reads codes.json off disk next to this file).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NimbirAppealComposer = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var ROUTES = Object.freeze({
    CORRECTED_CLAIM: 'corrected_claim',
    REOPENING: 'reopening',
    REDETERMINATION: 'redetermination',
    APPEAL: 'appeal',
    DOC_QUERY: 'documentation_query'
  });

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function addDays(dateStr, days) {
    var d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  function daysBetween(aStr, bStr) {
    var a = new Date(aStr + 'T00:00:00Z').getTime();
    var b = new Date(bStr + 'T00:00:00Z').getTime();
    return Math.round((b - a) / 86400000);
  }

  function todayStr() {
    var d = new Date();
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  // ---- shared claim-summary paragraph (used by every route) --------------

  function buildClaimSummary(ctx) {
    var claim = ctx.claim, S = ctx.S, need = ctx.need;
    var parts = [];
    parts.push(claim.payer ? S('Payer: ' + claim.payer + '.', 'claim.payer') : need('payer name'));
    var lines = Array.isArray(claim.lines) ? claim.lines.filter(function (l) { return l && l.cpt; }) : [];
    if (lines.length) {
      var descs = lines.map(function (l) {
        var mods = (l.modifiers && l.modifiers.length) ? ('-' + l.modifiers.join('-')) : '';
        var units = (l.units !== undefined && l.units !== null) ? (' x' + l.units) : '';
        return l.cpt + mods + units;
      });
      parts.push(S('Billed line(s): ' + descs.join(', ') + '.', 'claim.lines'));
    } else {
      parts.push(need('the billed CPT/HCPCS line(s) under review'));
    }
    var dos = lines[0] && lines[0].dos;
    parts.push(dos ? S('Date of service: ' + dos + '.', 'claim.lines[0].dos') : need('date of service'));
    var dx = lines[0] && Array.isArray(lines[0].icd10) && lines[0].icd10.length ? lines[0].icd10.join(', ') : null;
    parts.push(dx ? S('Diagnosis code(s): ' + dx + '.', 'claim.lines[0].icd10') : need('diagnosis code(s) on the billed line'));
    return parts.join(' ');
  }

  // ---- routing -------------------------------------------------------------

  function determineRoute(ctx) {
    var claim = ctx.claim, denial = ctx.denial, preflight = ctx.preflight;
    var carc = denial.carc;
    switch (carc) {
      case '97':
      case '236': {
        var indicatorKnown = typeof claim.ptp_indicator === 'number';
        preflight.push({
          check: 'ptp_modifier_indicator_known',
          pass: indicatorKnown,
          detail: indicatorKnown
            ? 'NCCI PTP modifier indicator for this code pair is ' + claim.ptp_indicator + '.'
            : 'claim.ptp_indicator was not supplied; cannot confirm whether a modifier could ever separate these codes.'
        });
        return { route: ROUTES.CORRECTED_CLAIM };
      }
      case '4':
        return { route: ROUTES.REOPENING };
      case '15':
      case '18':
      case '119':
        return { route: ROUTES.CORRECTED_CLAIM };
      case '29':
        preflight.push({
          check: 'timely_filing_proof_present',
          pass: !!claim.timely_filing_proof,
          detail: claim.timely_filing_proof ? 'Proof of timely filing was supplied.' : 'claim.timely_filing_proof was not supplied.'
        });
        return { route: ROUTES.APPEAL };
      case '50': {
        var hasNarrative = !!claim.medical_necessity_narrative;
        preflight.push({
          check: 'medical_necessity_narrative_present',
          pass: hasNarrative,
          detail: hasNarrative
            ? 'A chart-sourced medical-necessity narrative was supplied.'
            : 'No chart-sourced medical-necessity narrative was supplied; routing to a documentation query instead of an appeal.'
        });
        return { route: hasNarrative ? ROUTES.REDETERMINATION : ROUTES.DOC_QUERY };
      }
      case '151': {
        var unitErrorType = claim.unit_error_type;
        preflight.push({
          check: 'unit_error_type_specified',
          pass: !!unitErrorType,
          detail: unitErrorType
            ? 'claim.unit_error_type is "' + unitErrorType + '".'
            : 'claim.unit_error_type was not supplied; defaulting to the appeal path, which requires documented medical necessity for the units billed.'
        });
        return { route: unitErrorType === 'clerical' ? ROUTES.REOPENING : ROUTES.APPEAL };
      }
      case '197':
        preflight.push({
          check: 'retro_auth_window_checked',
          pass: typeof claim.retro_auth_available === 'boolean',
          detail: typeof claim.retro_auth_available === 'boolean'
            ? 'claim.retro_auth_available = ' + claim.retro_auth_available + '.'
            : 'claim.retro_auth_available was not supplied.'
        });
        return { route: ROUTES.APPEAL };
      default:
        preflight.push({
          check: 'route_determined',
          pass: false,
          detail: 'CARC ' + (carc || '(none)') + ' has no routing rule in this composer; human triage required.'
        });
        return { route: ROUTES.DOC_QUERY };
    }
  }

  // ---- letter builders, one per route --------------------------------------

  function buildCorrectedClaim(ctx) {
    var claim = ctx.claim, denial = ctx.denial, S = ctx.S, boiler = ctx.boiler, need = ctx.need, carcEntry = ctx.carcEntry;
    var paragraphs = [];
    paragraphs.push('# Internal correction note — not an appeal');
    paragraphs.push(boiler('not_an_appeal_notice'));
    paragraphs.push(buildClaimSummary(ctx));

    var body = [];
    body.push(carcEntry
      ? S('The remittance carries CARC ' + denial.carc + ': "' + carcEntry.text + '"', 'codes.json#carc.' + denial.carc)
      : need('the official CARC ' + denial.carc + ' description (code not in codes.json)'));

    if (denial.carc === '97' || denial.carc === '236') {
      body.push(typeof claim.ptp_indicator === 'number'
        ? S('NCCI lists this as a Procedure-to-Procedure (PTP) edit with modifier indicator ' + claim.ptp_indicator + '.', 'claim.ptp_indicator')
        : need('the NCCI PTP modifier indicator for this code pair (0 or 1)'));
      body.push(claim.ptp_column2_cpt
        ? S('The column-2 (bundled) code to remove from this claim is ' + claim.ptp_column2_cpt + '.', 'claim.ptp_column2_cpt')
        : need('the NCCI PTP column-2 (bundled) CPT code for this pair'));
      if (claim.ptp_indicator === 0) {
        body.push(boiler('ptp_indicator_0_warning'));
        body.push(boiler('ptp_indicator_0_warning_2'));
      } else if (claim.ptp_indicator === 1) {
        body.push(boiler('ptp_indicator_1_note'));
      }
    } else if (denial.carc === '15') {
      body.push(claim.auth_number
        ? S('The correct authorization number to use on the corrected claim is ' + claim.auth_number + '.', 'claim.auth_number')
        : need('the correct authorization number to use on the corrected claim'));
    } else if (denial.carc === '18') {
      body.push(boiler('duplicate_void_note'));
    } else if (denial.carc === '119') {
      body.push(boiler('frequency_void_note'));
    }
    body.push(boiler('corrected_claim_closing'));
    body.push(boiler('closing_internal'));
    paragraphs.push(body.join(' '));
    return paragraphs.join('\n\n');
  }

  function buildReopening(ctx) {
    var claim = ctx.claim, denial = ctx.denial, S = ctx.S, boiler = ctx.boiler, need = ctx.need, carcEntry = ctx.carcEntry, codes = ctx.codes;
    var paragraphs = [];
    paragraphs.push('# Request for reopening — clerical or minor error correction');
    paragraphs.push(boiler('not_an_appeal_notice'));
    paragraphs.push(buildClaimSummary(ctx));

    var body = [];
    body.push(carcEntry
      ? S('The remittance carries CARC ' + denial.carc + ': "' + carcEntry.text + '"', 'codes.json#carc.' + denial.carc)
      : need('the official CARC ' + denial.carc + ' description (code not in codes.json)'));
    body.push(S(codes.cms_manual.clerical_error_reopening.text, 'codes.json#cms_manual.clerical_error_reopening'));

    if (denial.carc === '4') {
      var line0 = claim.lines && claim.lines[0];
      var mods = line0 && line0.modifiers && line0.modifiers.length ? line0.modifiers.join(', ') : null;
      body.push(mods
        ? S('The modifier billed on this line (' + mods + ') is inconsistent with the procedure code and should be corrected through a reopening.', 'claim.lines[0].modifiers')
        : need('the modifier actually billed on this line that is inconsistent with the procedure code'));
    } else if (denial.carc === '151') {
      body.push(claim.units_billed !== undefined
        ? S('The units billed (' + claim.units_billed + ') reflect a data-entry error.', 'claim.units_billed')
        : need('the units actually billed on this line'));
      body.push(claim.units_correct !== undefined
        ? S('The chart-supported unit count is ' + claim.units_correct + '.', 'claim.units_correct')
        : need('the correct unit count supported by the medication administration record or chart'));
    } else {
      body.push(boiler('generic_clerical_note'));
    }
    body.push(boiler('reopening_request'));
    body.push(boiler('closing_internal'));
    paragraphs.push(body.join(' '));
    return paragraphs.join('\n\n');
  }

  function buildRedetermination(ctx) {
    var claim = ctx.claim, denial = ctx.denial, citation = ctx.citation, S = ctx.S, boiler = ctx.boiler, need = ctx.need,
      carcEntry = ctx.carcEntry, rarcEntry = ctx.rarcEntry, codes = ctx.codes;
    var paragraphs = [];
    paragraphs.push('# Request for redetermination — medical necessity');
    paragraphs.push(boiler('draft_notice'));
    paragraphs.push(boiler('salutation_payer'));
    paragraphs.push(buildClaimSummary(ctx));

    var body = [];
    body.push(carcEntry
      ? S('This claim was denied under CARC ' + denial.carc + ': "' + carcEntry.text + '".', 'codes.json#carc.' + denial.carc)
      : need('the official CARC ' + denial.carc + ' description (code not in codes.json)'));
    if (denial.rarc) {
      body.push(rarcEntry
        ? S('Remark code ' + denial.rarc + ': "' + rarcEntry.text + '".', 'codes.json#rarc.' + denial.rarc)
        : need('the official RARC ' + denial.rarc + ' description (code not in codes.json)'));
    }
    body.push(citation && citation.excerpt
      ? S('The governing coverage policy, ' + citation.source + (citation.id ? ' (' + citation.id + ')' : '') + ', states: "' + citation.excerpt + '".', 'citation.excerpt')
      : need('the verbatim LCD/coverage-policy excerpt this denial is based on'));
    body.push(claim.medical_necessity_narrative
      ? S(claim.medical_necessity_narrative, 'claim.medical_necessity_narrative')
      : need('chart-sourced documentation establishing medical necessity'));
    if (claim.remit_date) {
      var deadline = addDays(claim.remit_date, 120);
      body.push(S(codes.cms_manual.redetermination_120_day.text, 'codes.json#cms_manual.redetermination_120_day'));
      body.push(S('This request, on a claim remitted ' + claim.remit_date + ', is due no later than ' + deadline + '.', 'claim.remit_date'));
    } else {
      body.push(need('the remittance date to calculate the 120-day redetermination deadline'));
    }
    body.push(boiler('redetermination_request'));
    body.push(boiler('closing_payer_facing'));
    paragraphs.push(body.join(' '));
    return paragraphs.join('\n\n');
  }

  function buildAppeal(ctx) {
    var claim = ctx.claim, denial = ctx.denial, S = ctx.S, boiler = ctx.boiler, need = ctx.need,
      carcEntry = ctx.carcEntry, rarcEntry = ctx.rarcEntry, codes = ctx.codes;
    var paragraphs = [];
    paragraphs.push('# Appeal');
    paragraphs.push(boiler('draft_notice'));
    paragraphs.push(boiler('salutation_payer'));
    paragraphs.push(buildClaimSummary(ctx));

    var body = [];
    body.push(carcEntry
      ? S('This claim was denied under CARC ' + denial.carc + ': "' + carcEntry.text + '".', 'codes.json#carc.' + denial.carc)
      : need('the official CARC ' + denial.carc + ' description (code not in codes.json)'));
    if (denial.rarc) {
      body.push(rarcEntry
        ? S('Remark code ' + denial.rarc + ': "' + rarcEntry.text + '".', 'codes.json#rarc.' + denial.rarc)
        : need('the official RARC ' + denial.rarc + ' description (code not in codes.json)'));
    }

    if (denial.carc === '29') {
      body.push(claim.timely_filing_proof
        ? S('Proof of timely filing: ' + claim.timely_filing_proof + '.', 'claim.timely_filing_proof')
        : need("proof the claim was filed within the payer's timely-filing limit"));
      body.push(boiler('timely_filing_request'));
    } else if (denial.carc === '151') {
      if (claim.medical_necessity_narrative) {
        body.push(S(claim.medical_necessity_narrative, 'claim.medical_necessity_narrative'));
        body.push(boiler('mue_necessity_request'));
      } else {
        body.push(need('chart documentation establishing medical necessity for the units billed beyond the Medically Unlikely Edit default'));
        body.push(boiler('mue_no_necessity_warning'));
      }
    } else if (denial.carc === '197') {
      if (claim.retro_auth_available === true) {
        body.push(S('A retroactive authorization is available for this service.', 'claim.retro_auth_available'));
      } else if (claim.retro_auth_available === false) {
        body.push(S('No retroactive authorization is available under this plan for this service.', 'claim.retro_auth_available'));
        body.push(need('evidence the service met an exception to the prior-authorization requirement'));
      } else {
        body.push(need('whether a retroactive authorization window exists for this payer and service, and whether an authorization already exists under a related or sibling code'));
      }
      body.push(boiler('prior_auth_request'));
    }

    if (claim.remit_date) {
      var deadline = addDays(claim.remit_date, 120);
      body.push(S(codes.cms_manual.redetermination_120_day.text, 'codes.json#cms_manual.redetermination_120_day'));
      body.push(S('This appeal, on a claim remitted ' + claim.remit_date + ', is due no later than ' + deadline + '.', 'claim.remit_date'));
    } else {
      body.push(need('the remittance date to calculate the applicable appeal deadline'));
    }
    body.push(boiler('closing_payer_facing'));
    paragraphs.push(body.join(' '));
    return paragraphs.join('\n\n');
  }

  function buildDocQuery(ctx) {
    var claim = ctx.claim, denial = ctx.denial, citation = ctx.citation, S = ctx.S, boiler = ctx.boiler, need = ctx.need,
      carcEntry = ctx.carcEntry, rarcEntry = ctx.rarcEntry;
    var paragraphs = [];
    paragraphs.push('# Documentation query to the ordering clinician — not a payer-facing letter');
    paragraphs.push(boiler('doc_query_notice'));
    paragraphs.push(buildClaimSummary(ctx));

    var body = [];
    if (denial.carc) {
      body.push(carcEntry
        ? S('This line was denied under CARC ' + denial.carc + ': "' + carcEntry.text + '".', 'codes.json#carc.' + denial.carc)
        : need('the official CARC ' + denial.carc + ' description (code not in codes.json); this route needs human triage'));
    } else {
      body.push(need('the CARC on this denial'));
    }
    if (denial.rarc) {
      body.push(rarcEntry
        ? S('Remark code ' + denial.rarc + ': "' + rarcEntry.text + '".', 'codes.json#rarc.' + denial.rarc)
        : need('the official RARC ' + denial.rarc + ' description (code not in codes.json)'));
    }
    body.push(citation && citation.excerpt
      ? S("The payer's coverage policy, " + citation.source + ', requires: "' + citation.excerpt + '".', 'citation.excerpt')
      : need('the verbatim coverage-policy excerpt this denial is based on'));
    body.push(boiler('doc_query_ask'));
    body.push(boiler('doc_query_branch'));
    paragraphs.push(body.join(' '));
    return paragraphs.join('\n\n');
  }

  // ---- entry point ----------------------------------------------------------

  /**
   * @param {object} input
   * @param {object} input.claim - { lines:[{cpt,modifiers,units,icd10[],dos}], payer, ...optional context fields }
   * @param {object} input.denial - { group, carc, rarc, text }
   * @param {object} [input.citation] - { source, id, version, url, effective_date, excerpt }
   * @param {object} codes - parsed contents of codes.json (required; see loadDefaultCodes() in Node)
   * @returns {{route:string|null, letter_markdown:string|null, sentences:Array, preflight:Array, missing_inputs:Array}}
   */
  function compose(input, codes) {
    if (!codes || !codes.carc || !codes.rarc || !codes.boilerplate || !codes.cms_manual) {
      throw new Error('compose(input, codes) requires parsed codes.json as the second argument');
    }
    var sentences = [];
    var missing_inputs = [];
    var preflight = [];
    var claim = (input && input.claim) || {};
    var denial = input && input.denial;
    var citation = input && input.citation;

    function need(desc) {
      missing_inputs.push(desc);
      var text = '[NEEDS: ' + desc + ']';
      sentences.push({ text: text, source_ref: 'missing_input' });
      return text;
    }
    function S(text, source_ref) {
      sentences.push({ text: text, source_ref: source_ref });
      return text;
    }
    function boiler(id) {
      var text = codes.boilerplate[id];
      if (text === undefined) throw new Error('unknown boilerplate id: ' + id);
      return S(text, 'boilerplate#' + id);
    }

    if (!denial) {
      preflight.push({ check: 'denial_present', pass: false, detail: 'No denial object was provided; nothing to route or compose.' });
      return { route: null, letter_markdown: null, sentences: [], preflight: preflight, missing_inputs: ['denial'] };
    }

    preflight.push({
      check: 'payer_identified',
      pass: !!claim.payer,
      detail: claim.payer ? ('Payer: ' + claim.payer + '.') : 'claim.payer was not supplied.'
    });
    preflight.push({
      check: 'claim_lines_present',
      pass: Array.isArray(claim.lines) && claim.lines.length > 0,
      detail: (Array.isArray(claim.lines) && claim.lines.length)
        ? (claim.lines.length + ' claim line(s) supplied.')
        : 'claim.lines is missing or empty.'
    });

    var carc = (denial.carc === undefined || denial.carc === null) ? '' : String(denial.carc);
    var carcEntry = codes.carc[carc];
    preflight.push({
      check: 'denial_code_recognized',
      pass: !!carcEntry,
      detail: carcEntry ? ('CARC ' + carc + ': "' + carcEntry.text + '" (X12, codes.json).') : ('CARC ' + carc + ' is not in codes.json.')
    });

    var rarcEntry = denial.rarc ? codes.rarc[String(denial.rarc)] : undefined;
    if (denial.rarc) {
      preflight.push({
        check: 'remark_code_recognized',
        pass: !!rarcEntry,
        detail: rarcEntry ? ('RARC ' + denial.rarc + ': "' + rarcEntry.text + '" (X12, codes.json).') : ('RARC ' + denial.rarc + ' is not in codes.json.')
      });
    }

    var ctx = {
      claim: claim,
      denial: Object.assign({}, denial, { carc: carc }),
      citation: citation,
      codes: codes,
      S: S,
      boiler: boiler,
      need: need,
      carcEntry: carcEntry,
      rarcEntry: rarcEntry,
      preflight: preflight
    };

    var routing = determineRoute(ctx);

    if (routing.route === ROUTES.REDETERMINATION || routing.route === ROUTES.APPEAL) {
      if (claim.remit_date) {
        var deadline = addDays(claim.remit_date, 120);
        var today = claim.today || todayStr();
        var daysLeft = daysBetween(today, deadline);
        preflight.push({
          check: 'within_120_day_redetermination_window',
          pass: daysLeft >= 0,
          detail: daysLeft >= 0
            ? ('Deadline ' + deadline + ' (120 days from remit date ' + claim.remit_date + '); ' + daysLeft + ' day(s) remain as of ' + today + '.')
            : ('Deadline ' + deadline + ' (120 days from remit date ' + claim.remit_date + ') passed ' + Math.abs(daysLeft) + ' day(s) ago as of ' + today + '; check good-cause late-filing grounds.')
        });
      } else {
        preflight.push({
          check: 'within_120_day_redetermination_window',
          pass: false,
          detail: 'claim.remit_date was not supplied; the 120-day redetermination deadline cannot be computed.'
        });
      }
    }

    var letter_markdown;
    switch (routing.route) {
      case ROUTES.CORRECTED_CLAIM: letter_markdown = buildCorrectedClaim(ctx); break;
      case ROUTES.REOPENING: letter_markdown = buildReopening(ctx); break;
      case ROUTES.REDETERMINATION: letter_markdown = buildRedetermination(ctx); break;
      case ROUTES.APPEAL: letter_markdown = buildAppeal(ctx); break;
      case ROUTES.DOC_QUERY: letter_markdown = buildDocQuery(ctx); break;
      default: throw new Error('unreachable route: ' + routing.route);
    }

    return { route: routing.route, letter_markdown: letter_markdown, sentences: sentences, preflight: preflight, missing_inputs: missing_inputs };
  }

  function loadDefaultCodes() {
    /* global require, __dirname */
    if (typeof require !== 'function') {
      throw new Error('loadDefaultCodes() only works under Node (CommonJS require); in a browser, fetch codes.json yourself and pass it to compose()');
    }
    var fs = require('fs');
    var path = require('path');
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'codes.json'), 'utf8'));
  }

  return {
    compose: compose,
    ROUTES: ROUTES,
    addDays: addDays,
    daysBetween: daysBetween,
    loadDefaultCodes: loadDefaultCodes
  };
}));
