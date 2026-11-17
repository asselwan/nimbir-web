(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NimbirPrebillCheck = factory();
  }
})(globalThis, function () {
  'use strict';

  // CMS NCCI-associated modifiers for PTP edits with modifier indicator 1 (NCCI Policy Manual, Chapter I):
  // anatomic E1-E4, FA, F1-F9, LC, LD, LM, LT, RC, RI, RT, TA, T1-T9; global surgery 24, 25, 57, 58, 78, 79;
  // other 27, 59, 91, XE, XS, XP, XU.
  const distinctModifiers = new Set([
    'E1', 'E2', 'E3', 'E4', 'FA', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9',
    'LC', 'LD', 'LM', 'LT', 'RC', 'RI', 'RT', 'TA', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9',
    '24', '25', '57', '58', '78', '79', '27', '59', '91', 'XE', 'XS', 'XP', 'XU'
  ]);

  function parseLines(text) {
    const lines = [];
    const rejected = [];
    text.split(/\r\n|\n|\r/).forEach((raw, index) => {
      const line = raw.trim();
      if (!line) return;

      const lineNo = index + 1;
      const [code, ...modifiers] = line.split(/[\s,-]+/);
      // CPT: five digits, or four digits + a letter (Category II/III, PLA). HCPCS Level II: a letter + four digits.
      const isCode = /^(\d{5}|\d{4}[a-z]|[a-z]\d{4})$/i.test(code);
      if (!isCode || modifiers.some(modifier => !/^[a-z0-9]{2}$/i.test(modifier))) {
        rejected.push({ raw, lineNo });
        return;
      }
      lines.push({ cpt: code.toUpperCase(), modifiers: modifiers.map(modifier => modifier.toUpperCase()), raw, lineNo });
    });
    return { lines, rejected };
  }

  function indicatorMeaning(indicator) {
    switch (indicator) {
      case 0: return 'Never billed together on the same date of service; no modifier unbundles this pair.';
      case 1: return 'Bundled by default; billable separately only with an NCCI-associated modifier (such as 59, XE, XS, XP, XU, 25 or an anatomic modifier) when the documentation supports it.';
      case 9: return 'Edit deleted or not applicable in this version.';
      default: return 'Indicator not in this build of the table.';
    }
  }

  function pairStatus(indicator, distinctModifierPresent) {
    switch (indicator) {
      case 0: return 'never_separately_payable';
      case 1: return distinctModifierPresent ? 'modifier_present_needs_documentation' : 'bundled_no_modifier';
      case 9: return 'edit_deleted';
      default: return 'indicator_not_in_table';
    }
  }

  function check(lines, table) {
    const linesChecked = lines.length;
    if (linesChecked > 200) return { error: 'line_cap', summary: { linesChecked } };

    const { source, version, url } = table;
    const rows = new Map(table.pairs.map(row => [row.column1 + '/' + row.column2, row]));
    // One entry per code, in first-seen order, holding the modifier list of every line that bills it.
    // A pair counts as modified only when every pairing of its lines has an NCCI-associated modifier on
    // one of the two lines (CMS accepts it on either code), so one modified line never hides an unmodified one.
    const codes = new Map();
    for (const line of lines) {
      if (!codes.has(line.cpt)) codes.set(line.cpt, []);
      codes.get(line.cpt).push(line.modifiers);
    }
    const hasDistinct = modifiers => modifiers.some(modifier => distinctModifiers.has(modifier));
    const unique = [...codes.keys()];
    const pairs = [];
    const unpaired = [];
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const first = unique[i];
        const second = unique[j];
        const row = rows.get(first + '/' + second) ?? rows.get(second + '/' + first);
        if (!row) {
          unpaired.push({ column1: first, column2: second, status: 'not_in_table' });
          continue;
        }

        const { column1, column2, modifier_indicator: modifierIndicator, rationale, effective_date } = row;
        const modifiersPresent = [column1, column2].flatMap(code =>
          [...new Set(codes.get(code).flat())].sort().map(modifier => modifier + ' on ' + code));
        const distinctModifierPresent = codes.get(column1).every(left =>
          codes.get(column2).every(right => hasDistinct(left) || hasDistinct(right)));
        pairs.push({
          column1, column2, modifierIndicator,
          meaning: indicatorMeaning(modifierIndicator),
          rationale, modifiersPresent, distinctModifierPresent,
          status: pairStatus(modifierIndicator, distinctModifierPresent),
          citation: { source, version, url, effective_date }
        });
      }
    }
    return {
      pairs,
      unpaired,
      rejected: [],
      summary: { linesChecked, pairsInTable: pairs.length, pairsNotInTable: unpaired.length }
    };
  }

  return { parseLines, indicatorMeaning, check };
});
