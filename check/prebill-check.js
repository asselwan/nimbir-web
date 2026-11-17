(function () {
  'use strict';

  const mount = document.querySelector('#prebill-check');
  if (!mount) return;

  const examples = [
    { slug: 'echo-doppler', label: 'Echo with stress echo and Doppler (synthetic)', text: '93306\n93350\n93325' },
    { slug: 'ecg-holter', label: 'ECG with Holter (synthetic)', text: '93000\n93224' }
  ];
  const actionText = {
    bundled_no_modifier: 'Bill column 1 only, or add a distinct-service modifier to the column 2 line only when the documentation shows a separate site, session or encounter.',
    modifier_present_needs_documentation: 'A distinct-service modifier is on the line. Before billing, make sure the note documents why the services were separate; the modifier alone does not carry the claim.',
    never_separately_payable: 'Remove the column 2 line; NCCI allows no modifier for this pair.',
    edit_deleted: 'This edit does not apply in this version of the table.'
  };
  const wideMisses = window.matchMedia('(min-width: 700px)');
  const compactCards = window.matchMedia('(max-width: 480px)');
  const countLabel = (count, noun) => count + ' ' + noun + (count === 1 ? '' : 's');

  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  }

  function link(className, label, href, ctaId) {
    const anchor = element('a', className, label);
    anchor.href = href;
    if (ctaId) anchor.dataset.ctaId = ctaId;
    return anchor;
  }

  const title = element('h2', 'pb-title', 'Check the lines before the claim goes out.');
  title.id = 'prebill-check-title';
  mount.setAttribute('aria-labelledby', title.id);

  const input = element('textarea', 'pb-input');
  input.id = 'prebill-lines';
  input.rows = 6;
  input.placeholder = '93000\n93224 59';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'CPT lines and modifiers');

  const chips = element('div', 'pb-chips');
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', 'Synthetic CPT examples');
  for (const example of examples) {
    const chip = element('button', 'pb-chip', example.label);
    chip.type = 'button';
    chip.dataset.example = example.slug;
    chip.addEventListener('click', () => {
      input.value = example.text;
      run();
    });
    chips.append(chip);
  }

  const runButton = element('button', 'button', 'Check before billing');
  runButton.id = 'prebill-run';
  runButton.type = 'button';
  runButton.addEventListener('click', run);
  const controls = element('div', 'pb-controls');
  controls.append(input, chips, runButton);

  const result = element('div', 'pb-result');
  result.id = 'prebill-result';
  result.setAttribute('aria-live', 'polite');
  mount.append(
    element('p', 'pb-eyebrow', 'PRE-BILL CHECK'),
    title,
    element('p', 'pb-intro', 'Paste the CPT lines you are about to bill, one per line, modifiers after the code. Everything runs in this browser tab; nothing is uploaded. Codes and modifiers only, no dates, no patient fields.'),
    controls,
    result
  );

  wideMisses.addEventListener('change', event => {
    const misses = result.querySelector('.pb-miss');
    if (misses) misses.open = event.matches;
  });
  compactCards.addEventListener('change', event => {
    for (const details of result.querySelectorAll('.pb-indicator-details')) details.open = !event.matches;
  });

  function pairCard(pair) {
    const card = element('article', 'pb-card');
    const heading = element('h4');
    heading.append('CPT ', element('span', 'pb-code', pair.column1), ' with CPT ', element('span', 'pb-code', pair.column2));

    const indicator = 'Modifier indicator ' + pair.modifierIndicator;
    const details = element('details', 'pb-indicator-details');
    details.open = !compactCards.matches;
    details.append(element('summary', '', indicator), element('p', 'pb-indicator', indicator + ' · ' + pair.meaning));

    const action = element('div', 'pb-action');
    action.append(
      element('h5', '', 'What to do before billing'),
      element('p', '', actionText[pair.status] ?? pair.meaning)
    );

    const { url, version, effective_date } = pair.citation;
    const citation = element('p', 'pb-citation');
    const source = link('', 'CMS NCCI PTP Edits, Practitioner, ' + version + ', effective ' + effective_date, url);
    source.rel = 'noopener';
    source.target = '_blank';
    citation.append(source);
    card.append(
      heading,
      details,
      element('p', 'pb-rationale', 'NCCI rationale: ' + pair.rationale),
      element('p', 'pb-mods', pair.modifiersPresent.length ? 'Modifiers seen: ' + pair.modifiersPresent.join(', ') : 'No modifiers on these lines'),
      action,
      citation
    );
    return card;
  }

  function missedPairs(unpaired, tableSize) {
    const details = element('details', 'pb-miss');
    details.open = wideMisses.matches;
    const list = element('ul', 'pb-code');
    for (const { column1, column2 } of unpaired) list.append(element('li', '', column1 + ' / ' + column2));
    details.append(
      element('summary', '', countLabel(unpaired.length, 'pair') + ' not in this build’s table'),
      element('p', '', 'Not in this build’s table of ' + tableSize + ' pairs. Not checked is not the same as clean.'),
      list
    );
    return details;
  }

  function footer(table) {
    const foot = element('footer', 'pb-footer');
    const actions = element('div', 'pb-actions');
    actions.append(
      link('button', 'Start Revenue Floor, USD 199/month', 'https://buy.nomoi.ai/nimbir/revenue_floor', 'prebill_start_revenue_floor'),
      link('button secondary', 'Request an invoice instead', 'mailto:assel@nomoi.ai?subject=Nimbir%20Revenue%20Floor%20invoice%20request', 'prebill_request_invoice')
    );
    foot.append(
      element('p', '', 'This build holds ' + table.pairs.length + ' NCCI PTP pairs (practitioner table, ' + table.version +
        '). Nimbir says whether a pair is in its table and what the indicator means.'),
      actions
    );
    return foot;
  }

  function showResult(heading, ...content) {
    heading.tabIndex = -1;
    result.removeAttribute('aria-busy');
    result.replaceChildren(heading, ...content);
    heading.scrollIntoView({ behavior: 'instant', block: 'nearest' });
    heading.focus({ preventScroll: true });
  }

  function render(analysis, rejected, table) {
    const { pairs, unpaired, summary } = analysis;
    const { linesChecked, pairsInTable, pairsNotInTable } = summary;
    const headline = countLabel(linesChecked, 'line') + ' checked. ' + countLabel(pairsInTable, 'pair') +
      (pairsInTable === 1 ? ' is' : ' are') + ' in the NCCI table in this build; ' + countLabel(pairsNotInTable, 'pair') +
      (pairsNotInTable === 1 ? ' is not in it and was not checked.' : ' are not in it and were not checked.');
    const content = [];
    if (pairs.length) {
      const cards = element('div', 'pb-cards');
      for (const pair of pairs) cards.append(pairCard(pair));
      content.push(cards);
    }
    if (unpaired.length) content.push(missedPairs(unpaired, table.pairs.length));
    if (rejected.length) {
      const numbers = rejected.map(line => line.lineNo).join(', ');
      content.push(element('p', 'pb-rejected', (rejected.length === 1 ? 'Line ' : 'Lines ') + numbers +
        (rejected.length === 1 ? ' was' : ' were') + ' rejected. Enter a CPT code and optional modifiers on each line.'));
    }
    showResult(element('h3', 'pb-result-title', headline), ...content, footer(table));
  }

  async function loadTable() {
    const response = await fetch('data/ptp-table.json', { mode: 'same-origin' });
    if (!response.ok) throw new Error('Could not load the NCCI table');
    return response.json();
  }

  let tableRequest;
  let currentRun = 0;

  async function run() {
    const id = ++currentRun;
    result.setAttribute('aria-busy', 'true');
    const { parseLines, check } = window.NimbirPrebillCheck;
    const { lines, rejected } = parseLines(input.value);
    if (lines.length > 200) {
      showResult(element('p', 'pb-error', 'More than 200 lines. Check in batches of 200.'));
      return;
    }
    try {
      tableRequest ??= loadTable();
      const table = await tableRequest;
      if (id === currentRun) render(check(lines, table), rejected, table);
    } catch {
      if (id === currentRun) showResult(element('p', 'pb-error', 'Could not load the NCCI table. Reload the page to try again.'));
    }
  }
})();
