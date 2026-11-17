(function () {
  'use strict';

  const mount = document.querySelector('#denial-check');
  if (!mount) return;

  const scenarios = [
    { slug: 'bundling-co97', label: 'Bundled echo lines (CO-97)' },
    { slug: 'modifier-co4', label: 'Modifier mismatch (CO-4)' },
    { slug: 'lcd-co50', label: 'Medical-necessity LCD denial (CO-50)' },
    { slug: 'partial-payment-co45', fixture: 'partial-payment', label: 'Contractual write-off (CO-45)' },
    { slug: 'multi-st', label: 'Two remittances in one file' },
    { slug: 'reversal', label: 'Payment reversal' }
  ];
  const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const money = amount => currency.format(amount);
  const countLabel = (count, noun) => count + ' ' + noun + (count === 1 ? '' : 's');

  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  }

  function link(className, label, href) {
    const anchor = element('a', className, label);
    anchor.href = href;
    return anchor;
  }

  const title = element('h2', 'dc-title', 'See what Nimbir would catch, in one click.');
  title.id = 'denial-check-title';
  mount.setAttribute('aria-labelledby', title.id);
  mount.append(
    element('p', 'dc-eyebrow', 'DENIAL CHECK'),
    title,
    element('p', 'dc-intro', 'Pick a synthetic hospital 835. Everything runs in this browser tab; nothing is uploaded.')
  );

  const controls = element('div', 'dc-controls');
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', 'Remittance scenarios');
  const fileInput = element('input', 'dc-file-input');
  fileInput.type = 'file';
  fileInput.id = 'denial-check-file';
  fileInput.accept = '.835,.edi,.txt,text/plain';
  const fileControl = element('label', 'dc-file');
  fileControl.append(fileInput, element('span', 'dc-chip', 'Use your own 835'));

  const chips = new Map();
  for (const scenario of scenarios) {
    const chip = element('button', 'dc-chip', scenario.label);
    chip.type = 'button';
    chip.dataset.scenario = scenario.slug;
    chip.setAttribute('aria-pressed', 'false');
    chip.addEventListener('click', () => runScenario(scenario));
    chips.set(scenario.slug, chip);
    controls.append(chip);
  }
  controls.append(fileControl);
  const result = element('div', 'dc-result');
  result.id = 'denial-check-result';
  result.setAttribute('aria-live', 'polite');
  mount.append(controls, result);

  function draftDetails(finding) {
    const details = element('details', 'dc-draft');
    const letter = element('pre');
    for (const part of finding.letter.split(/(\[NEEDS: [^\]\r\n]+\])/g)) {
      letter.append(part.startsWith('[NEEDS: ') ? element('mark', 'dc-need', part) : document.createTextNode(part));
    }
    details.append(
      element('summary', '', 'Read the draft'),
      letter,
      element('p', 'dc-citations', finding.citedCount + ' of ' + finding.sentenceCount + ' sentences cite their source')
    );
    return details;
  }

  function findingCard(finding) {
    const card = element('article', 'dc-card');
    const header = element('div', 'dc-card-head');
    const procedure = finding.cpt ? ['CPT ' + finding.cpt, ...finding.modifiers].join('-') : 'Claim-level adjustment';
    header.append(element('h4', '', procedure), element('strong', 'dc-money', finding.amount === null ? 'Amount missing' : money(finding.amount)));
    const reference = [finding.claimRef && 'Claim ' + finding.claimRef, finding.dos && 'Service date ' + finding.dos].filter(Boolean);
    const reason = element('p', 'dc-reason');
    reason.append(element('b', 'dc-code', 'CO-' + finding.carc), ' ' + (finding.carcText ?? 'not in the verified rule set'));
    card.append(header);
    if (reference.length) card.append(element('p', 'dc-reference', reference.join(' · ')));
    card.append(reason);
    if (finding.rarc) {
      card.append(element('p', 'dc-remark', 'RARC ' + finding.rarc + (finding.rarcText ? ' · ' + finding.rarcText : '')));
    }
    card.append(element('p', 'dc-route', finding.routeLabel));

    if (finding.preflight.length) {
      const checks = element('ul', 'dc-checks');
      checks.setAttribute('aria-label', 'Preflight checks');
      for (const check of finding.preflight) {
        const row = element('li');
        row.append(
          element('b', check.pass ? 'dc-pass' : 'dc-fail', check.pass ? '✓ Pass' : '× Fail'),
          element('span', '', check.detail)
        );
        checks.append(row);
      }
      card.append(checks);
    }
    if (finding.missing.length) {
      const evidence = element('ul', 'dc-evidence');
      for (const item of finding.missing) evidence.append(element('li', '', item));
      card.append(element('h5', '', 'Evidence still needed'), evidence);
    }
    if (finding.letter) card.append(draftDetails(finding));
    return card;
  }

  function footer() {
    const foot = element('footer', 'dc-footer');
    const actions = element('div', 'dc-actions');
    const own = link('dc-own', 'Run it on your own 835', '#' + fileInput.id);
    own.addEventListener('click', event => {
      event.preventDefault();
      fileControl.scrollIntoView({ behavior: 'instant', block: 'nearest' });
      fileInput.focus();
    });
    actions.append(
      link('button', 'Start Revenue Floor, USD 199/month', 'https://buy.nomoi.ai/nimbir/revenue_floor'),
      link('button secondary', 'Request an invoice instead', 'mailto:assel@nomoi.ai?subject=Nimbir%20Revenue%20Floor%20invoice%20request'),
      own
    );
    foot.append(element('p', '', 'A person reviews and approves before anything is sent. Nimbir files nothing.'), actions);
    return foot;
  }

  function render(analysis, synthetic) {
    const { deniedTotal, findings, unmatched, byRoute, needsCount, totals } = analysis;
    const headline = findings.length
      ? money(deniedTotal) + ' denied across ' + countLabel(totals.deniedLines, 'line') + '. ' +
        totals.verifiedLines + (totals.verifiedLines === 1 ? ' has' : ' have') + ' a verified next step; ' +
        needsCount + (needsCount === 1 ? ' needs' : ' need') + ' a person to supply evidence first.'
      : 'No provider denials in this file.';
    const header = element('header', 'dc-result-head');
    const heading = element('h3', 'dc-result-title', headline);
    heading.tabIndex = -1;
    if (synthetic) header.append(element('p', 'dc-badge', 'Synthetic data. No real patient.'));
    header.append(heading);
    const content = [header];

    if (findings.length) {
      const routes = element('ul', 'dc-routes');
      routes.setAttribute('aria-label', 'Denials by route');
      for (const [id, route] of Object.entries(byRoute)) {
        const item = element('li');
        item.append(
          element('strong', '', countLabel(route.count, 'finding') + ' · ' + money(route.amount)),
          element('span', '', window.NimbirDenialCheck.routeLabels[id])
        );
        routes.append(item);
      }
      const cards = element('div', 'dc-cards');
      for (const finding of findings) cards.append(findingCard(finding));
      content.push(routes, cards);
    }
    if (unmatched.length) {
      const refs = unmatched.map(claim => claim.claimRef ?? 'Claim reference missing');
      const note = element('p', 'dc-unmatched', countLabel(unmatched.length, 'claim') +
        (unmatched.length === 1 ? ' was' : ' were') + ' marked denied without a CO reason code. ' + refs.join(', '));
      content.push(note);
    }
    result.replaceChildren(...content, footer());
    header.scrollIntoView({ behavior: 'instant', block: 'nearest' });
    heading.focus({ preventScroll: true });
  }

  async function staticFile(path, format) {
    const response = await fetch(path);
    if (!response.ok) throw new Error('could not load ' + path + ' (HTTP ' + response.status + ')');
    return response[format]();
  }

  let codesRequest;
  let currentRun = 0;

  async function run(fileName, readText, scenario) {
    const id = ++currentRun;
    for (const [slug, chip] of chips) chip.setAttribute('aria-pressed', String(slug === scenario));
    result.replaceChildren();
    result.setAttribute('aria-busy', 'true');
    const timer = setTimeout(() => {
      if (id !== currentRun) return;
      const skeleton = element('div', 'dc-skeleton');
      skeleton.setAttribute('aria-hidden', 'true');
      result.append(skeleton);
    }, 150);
    try {
      // Same-origin static rules are fetched once. The user's 835 content is
      // never sent anywhere. No fetch or XHR carries it.
      codesRequest ??= staticFile('appeals/codes.json', 'json');
      const [text, codes] = await Promise.all([readText(), codesRequest]);
      if (id !== currentRun) return;
      const parsed = window.Nimbir835.parse835(text);
      if (!parsed.functionalGroups.some(group => group.transactions.length)) {
        throw new Error('no 835 remittance transaction was found');
      }
      const analysis = window.NimbirDenialCheck.analyze(parsed, codes);
      result.removeAttribute('aria-busy');
      render(analysis, Boolean(scenario));
    } catch (error) {
      if (id !== currentRun) return;
      result.removeAttribute('aria-busy');
      const message = element('p', 'dc-error', 'Could not check “' + fileName + '”. ' + error.message);
      message.tabIndex = -1;
      result.replaceChildren(message);
      message.focus();
    } finally {
      clearTimeout(timer);
    }
  }

  function runScenario(scenario) {
    const fileName = 'synthetic-cardio-' + (scenario.fixture ?? scenario.slug) + '.835';
    return run(fileName, () => staticFile('x12/fixtures/' + fileName, 'text'), scenario.slug);
  }

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    fileInput.value = '';
    run(file.name, () => file.text());
  });
  document.querySelector('[data-dc-run]')?.addEventListener('click', () => runScenario(scenarios[0]));
})();
