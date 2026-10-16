// app/x12/parse835.js
// Dependency-free X12 835 (Health Care Claim Payment/Advice, 005010X221A1) parser.
// Works unmodified in a <script> tag (browser global `window.Nimbir835`) and under
// Node's CommonJS `require()` (used by the node:test files in this folder).
//
// Scope: this parses the segments a US cardiology billing office denial queue needs
// (BPR, TRN, N1, CLP, CAS, NM1, DTM, SVC + service-level CAS, LQ, PLB) plus the
// envelope (ISA/GS/ST...SE/GE/IEA). Segments outside that list are recorded as
// warnings and skipped rather than failing the parse — a real-world 835 will
// contain plenty of segments (MIA, MOA, PER, CUR, ...) this build does not need to
// render a denial queue.
//
// Nothing in this file reads a file, makes a network call, or touches the DOM.
// Callers (app/x12/dropzone.js) own getting the raw text in and never send it anywhere.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Nimbir835 = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class X12ParseError extends Error {
    constructor(message) {
      super(message);
      this.name = 'X12ParseError';
    }
  }

  function toAmount(value) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function toInt(value) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  // DTM/PLB dates are CCYYMMDD in practice for an 835; a 6-digit YYMMDD fallback is
  // kept only because some trading partners still emit it on older interchanges.
  function formatDate(value) {
    if (!value) return null;
    if (/^\d{8}$/.test(value)) return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
    if (/^\d{6}$/.test(value)) return `20${value.slice(0, 2)}-${value.slice(2, 4)}-${value.slice(4, 6)}`;
    return value;
  }

  // Non-normative: CLP02 claim status codes, for display only. These are not a
  // CARC/RARC code set so they are not cross-checked against x12.org in this build.
  const CLAIM_STATUS = {
    '1': 'Processed as Primary',
    '2': 'Processed as Secondary',
    '3': 'Processed as Tertiary',
    '4': 'Denied',
    '19': 'Processed as Primary, Forwarded to Additional Payer(s)',
    '20': 'Processed as Secondary, Forwarded to Additional Payer(s)',
    '21': 'Processed as Tertiary, Forwarded to Additional Payer(s)',
    '22': 'Reversal of Previous Payment',
    '23': 'Not Our Claim, Forwarded to Additional Payer(s)',
    '25': 'Predetermination Pricing Only — No Payment'
  };

  // Splits the fixed-layout ISA segment using its own declared delimiters rather
  // than assuming byte offsets, so the parser tolerates senders that pad fields
  // slightly differently. The element separator is always the character right
  // after the literal "ISA"; the component separator (ISA16) and segment
  // terminator are the two characters that follow the 15th element separator,
  // because ISA16 is never itself followed by a separator — only by the terminator.
  function parseISA(raw) {
    if (typeof raw !== 'string' || raw.length < 20 || raw.slice(0, 3) !== 'ISA') {
      throw new X12ParseError('Not a valid X12 interchange: file does not start with an ISA segment');
    }
    const elementSep = raw[3];
    if (!elementSep) throw new X12ParseError('Malformed ISA segment: no element separator found');
    let pos = 4;
    const isaElements = ['ISA'];
    for (let i = 0; i < 15; i++) {
      const next = raw.indexOf(elementSep, pos);
      if (next === -1) {
        throw new X12ParseError(`Malformed ISA segment: expected 15 delimited elements, ran out after element ${i + 1}`);
      }
      isaElements.push(raw.slice(pos, next));
      pos = next + 1;
    }
    const componentSep = raw[pos];
    const segmentTerm = raw[pos + 1];
    if (!componentSep || !segmentTerm) {
      throw new X12ParseError('Malformed ISA segment: missing component element separator or segment terminator');
    }
    isaElements.push(componentSep); // ISA16
    return { isaElements, elementSep, componentSep, segmentTerm, bodyStart: pos + 2 };
  }

  function tokenize(rawText) {
    const text = String(rawText).replace(/^﻿/, ''); // strip a UTF-8 BOM if present
    const { isaElements, elementSep, componentSep, segmentTerm, bodyStart } = parseISA(text);
    const body = text.slice(bodyStart);
    // Segment terminators may be followed by \r\n, \n, \r, or nothing before the
    // next segment ID — tolerate all four by trimming only line-break characters
    // (never generic whitespace, so an intentional trailing space inside the last
    // element of a segment, e.g. a street address, is preserved).
    const segments = [isaElements];
    for (const rawSegment of body.split(segmentTerm)) {
      const trimmed = rawSegment.replace(/^[\r\n]+/, '').replace(/[\r\n]+$/, '');
      if (!trimmed) continue;
      segments.push(trimmed.split(elementSep));
    }
    return {
      elementSep,
      componentSep,
      repetitionSep: isaElements[11],
      segmentTerm,
      segments
    };
  }

  function parseCAS(seg) {
    const groupCode = seg[1];
    const out = [];
    for (let idx = 2; idx < seg.length; idx += 3) {
      const reasonCode = seg[idx];
      if (!reasonCode) break;
      out.push({
        groupCode,
        reasonCode,
        amount: toAmount(seg[idx + 1]),
        quantity: toInt(seg[idx + 2])
      });
    }
    return out;
  }

  function splitComposite(value, componentSep) {
    if (value === undefined || value === null || value === '') return [];
    return String(value).split(componentSep);
  }

  /**
   * Parse the text of one X12 835 interchange (it may contain multiple GS
   * functional groups and multiple ST/SE transaction sets within each group).
   * Returns { interchange, functionalGroups, warnings }. Throws X12ParseError
   * only for a structurally unreadable envelope (bad/missing ISA); anything else
   * unexpected is recorded in `warnings` and skipped so one malformed segment
   * does not blank the whole denial queue.
   */
  function parse835(rawText) {
    const tokenized = tokenize(rawText);
    const { segments, componentSep } = tokenized;
    const isaElements = segments[0];
    const interchange = {
      senderIdQualifier: isaElements[5],
      senderId: isaElements[6],
      receiverIdQualifier: isaElements[7],
      receiverId: isaElements[8],
      date: formatDate(isaElements[9]), // ISA09 is always 6-digit YYMMDD per 005010
      time: isaElements[10],
      repetitionSeparator: tokenized.repetitionSep,
      versionNumber: isaElements[12],
      controlNumber: isaElements[13],
      usageIndicator: isaElements[15],
      elementSeparator: tokenized.elementSep,
      componentSeparator: tokenized.componentSep,
      segmentTerminator: tokenized.segmentTerm
    };

    const warnings = [];
    const functionalGroups = [];
    let currentGroup = null;
    let currentTx = null;
    let currentClaim = null;
    let currentService = null;
    let n1Context = null;

    const targetForRefDtm = () => currentService || currentClaim || currentTx;

    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i];
      const id = seg[0];
      switch (id) {
        case 'GS': {
          currentGroup = {
            functionalIdCode: seg[1],
            senderCode: seg[2],
            receiverCode: seg[3],
            date: formatDate(seg[4]),
            time: seg[5],
            controlNumber: seg[6],
            agencyCode: seg[7],
            versionCode: seg[8],
            transactions: []
          };
          functionalGroups.push(currentGroup);
          break;
        }
        case 'GE': {
          currentGroup = null;
          break;
        }
        case 'ST': {
          if (seg[1] !== '835') {
            warnings.push(`Skipped non-835 transaction set (ST01=${seg[1]}, control ${seg[2]}); this build only reads 835 remittances`);
            while (i + 1 < segments.length && segments[i + 1][0] !== 'SE') i++;
            currentTx = null;
            break;
          }
          currentTx = {
            controlNumber: seg[2],
            implementationRef: seg[3] || null,
            payer: null,
            payee: null,
            payment: {},
            claims: [],
            providerAdjustments: [],
            headerDates: {},
            headerRefs: {}
          };
          if (!currentGroup) {
            currentGroup = { functionalIdCode: null, senderCode: null, receiverCode: null, transactions: [] };
            functionalGroups.push(currentGroup);
          }
          currentGroup.transactions.push(currentTx);
          break;
        }
        case 'SE': {
          currentTx = null;
          currentClaim = null;
          currentService = null;
          n1Context = null;
          break;
        }
        case 'BPR': {
          if (!currentTx) break;
          currentTx.payment = {
            transactionHandlingCode: seg[1] || null,
            totalPaid: toAmount(seg[2]),
            creditDebitFlag: seg[3] || null,
            paymentMethod: seg[4] || null,
            paymentFormat: seg[5] || null,
            paymentDate: formatDate(seg[16])
          };
          break;
        }
        case 'TRN': {
          if (!currentTx) break;
          currentTx.payment.traceType = seg[1] || null;
          currentTx.payment.traceNumber = seg[2] || null;
          currentTx.payment.payerId = seg[3] || null;
          break;
        }
        case 'DTM': {
          const target = targetForRefDtm();
          if (!target) break;
          target.dates = target.dates || {};
          target.dates[seg[1]] = formatDate(seg[2]);
          break;
        }
        case 'REF': {
          const target = targetForRefDtm();
          if (!target) break;
          target.refs = target.refs || {};
          target.refs[seg[1]] = seg[2] || null;
          break;
        }
        case 'N1': {
          if (!currentTx) break;
          n1Context = seg[1];
          const party = { code: seg[1], name: seg[2] || null, idQualifier: seg[3] || null, id: seg[4] || null };
          if (seg[1] === 'PR') currentTx.payer = party;
          else if (seg[1] === 'PE') currentTx.payee = party;
          break;
        }
        case 'N3': {
          const party = n1Context === 'PR' ? currentTx && currentTx.payer : n1Context === 'PE' ? currentTx && currentTx.payee : null;
          if (party) party.address1 = seg[1] || null;
          break;
        }
        case 'N4': {
          const party = n1Context === 'PR' ? currentTx && currentTx.payer : n1Context === 'PE' ? currentTx && currentTx.payee : null;
          if (party) { party.city = seg[1] || null; party.state = seg[2] || null; party.zip = seg[3] || null; }
          break;
        }
        case 'CLP': {
          if (!currentTx) break;
          currentClaim = {
            patientControlNumber: seg[1] || null,
            statusCode: seg[2] || null,
            statusDescription: CLAIM_STATUS[seg[2]] || (seg[2] ? `Unrecognized claim status code ${seg[2]}` : null),
            totalCharge: toAmount(seg[3]),
            totalPaid: toAmount(seg[4]),
            patientResponsibility: toAmount(seg[5]),
            filingIndicator: seg[6] || null,
            payerClaimControlNumber: seg[7] || null,
            facilityTypeCode: seg[8] || null,
            claimFrequencyCode: seg[9] || null,
            patient: null,
            renderingProvider: null,
            dates: {},
            refs: {},
            adjustments: [],
            remarkCodes: [],
            services: []
          };
          currentTx.claims.push(currentClaim);
          currentService = null;
          break;
        }
        case 'CAS': {
          const target = currentService || currentClaim;
          if (!target) break;
          target.adjustments = target.adjustments || [];
          target.adjustments.push(...parseCAS(seg));
          break;
        }
        case 'NM1': {
          if (!currentClaim) break;
          const person = {
            qualifier: seg[1] || null,
            entityType: seg[2] || null,
            lastOrOrgName: seg[3] || null,
            firstName: seg[4] || null,
            middleName: seg[5] || null,
            idQualifier: seg[8] || null,
            id: seg[9] || null
          };
          if (seg[1] === 'QC') currentClaim.patient = person;
          else if (seg[1] === '82' || seg[1] === '85' || seg[1] === '1P') currentClaim.renderingProvider = person;
          else if (seg[1] === 'IL') currentClaim.subscriber = person;
          else {
            currentClaim.otherParties = currentClaim.otherParties || [];
            currentClaim.otherParties.push(person);
          }
          break;
        }
        case 'SVC': {
          if (!currentClaim) break;
          const composite = splitComposite(seg[1], componentSep);
          const submitted = splitComposite(seg[6], componentSep);
          currentService = {
            procedureQualifier: composite[0] || null,
            procedureCode: composite[1] || null,
            modifiers: composite.slice(2).filter(Boolean),
            charge: toAmount(seg[2]),
            paid: toAmount(seg[3]),
            revenueCode: seg[4] || null,
            unitsPaid: toInt(seg[5]),
            submittedProcedureQualifier: submitted[0] || null,
            submittedProcedureCode: submitted[1] || null,
            submittedModifiers: submitted.slice(2).filter(Boolean),
            unitsSubmitted: toInt(seg[7]),
            dates: {},
            refs: {},
            adjustments: [],
            remarkCodes: []
          };
          currentClaim.services.push(currentService);
          break;
        }
        case 'LQ': {
          const target = currentService || currentClaim;
          if (!target) break;
          target.remarkCodes = target.remarkCodes || [];
          target.remarkCodes.push({ qualifier: seg[1] || null, code: seg[2] || null });
          break;
        }
        case 'AMT': {
          const target = currentClaim || currentTx;
          if (!target) break;
          target.amounts = target.amounts || {};
          target.amounts[seg[1]] = toAmount(seg[2]);
          break;
        }
        case 'PLB': {
          if (!currentTx) break;
          const adjustments = [];
          for (let k = 3; k < seg.length; k += 2) {
            if (!seg[k]) continue;
            const parts = splitComposite(seg[k], componentSep);
            adjustments.push({
              reasonCode: parts[0] || null,
              referenceId: parts[1] || null,
              amount: toAmount(seg[k + 1])
            });
          }
          currentTx.providerAdjustments.push({
            providerId: seg[1] || null,
            fiscalPeriodDate: formatDate(seg[2]),
            adjustments
          });
          break;
        }
        case 'MIA':
        case 'MOA': {
          if (currentClaim) currentClaim.medicareAdjudication = seg.slice(1);
          break;
        }
        case 'LX':
        case 'IEA':
          break; // informational-only markers, nothing to capture for the denial queue
        default: {
          warnings.push(`Unhandled segment ${id} ignored (not needed to render the denial queue)`);
        }
      }
    }

    return { interchange, functionalGroups, warnings };
  }

  return { parse835, X12ParseError, tokenize, formatDate, toAmount };
});
