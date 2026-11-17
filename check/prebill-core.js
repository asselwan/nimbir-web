(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NimbirPrebillCheck = factory();
  }
})(globalThis, function () {
  'use strict';

  const distinctModifiers = new Set(['59', 'XE', 'XS', 'XP', 'XU']);

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
      case 1: return 'Bundled by default; billable separately only with a distinct-service modifier (59, XE, XS, XP, XU) when the documentation supports it.';
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
    // One entry per code, in first-seen order, carrying the modifiers of every line that bills it,
    // so a repeated code gives the same result whatever order its lines are in.
    const codes = new Map();
    for (const line of lines) {
      if (!codes.has(line.cpt)) codes.set(line.cpt, new Set());
      for (const modifier of line.modifiers) codes.get(line.cpt).add(modifier);
    }
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
        const modifiersPresent = [column1, column2].flatMap(code => [...codes.get(code)].map(modifier => modifier + ' on ' + code));
        // The NCCI bypass modifier belongs on the column 2 (bundled) code; one on the column 1 line only does not count.
        const distinctModifierPresent = [...codes.get(column2)].some(modifier => distinctModifiers.has(modifier));
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
