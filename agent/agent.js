// Autonomous recovery run agent (D-askblitz-0deb27ec112732ff9e80, prm_50a8e84e v2).
// Works the local de-identified claim book claim-by-claim over hours or days.
// Durable: run state (ledger, checkpoints, packets) persists in localStorage and
// resumes across sessions. Nothing is sent anywhere; every packet is human-gated.
(() => {
  const KEY = 'nimbir-agent-run-v1';
  const $ = (id) => document.getElementById(id);
  const PHASES = ['triage', 'evidence', 'packet', 'gate', 'report'];
  let claims = [];
  let run = null;
  let timer = null;
  let uiTimer = null;

  const readRun = () => {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && Array.isArray(parsed.ledger) ? parsed : null;
    } catch {
      return null;
    }
  };
  const writeRun = () => localStorage.setItem(KEY, JSON.stringify(run));
  const log = (event) => {
    run.ledger.push({ at: new Date().toISOString(), event });
    if (run.ledger.length > 4000) run.ledger.splice(0, run.ledger.length - 4000);
  };
  const checkpoint = (note) => {
    run.checkpoints.push({ at: new Date().toISOString(), worked: run.worked, note });
    log('Checkpoint: ' + note);
  };
  const fmtAge = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return (d ? d + 'd ' : '') + pad(h) + ':' + pad(m) + ':' + pad(sec);
  };

  const phaseOf = () => {
    if (run.worked === 0) return 'triage';
    if (run.worked < claims.length) return 'evidence';
    if (run.packets.length < claims.length) return 'packet';
    if (run.approved < run.packets.length) return 'gate';
    return 'report';
  };
  const money = (c) => (c.amount == null ? '—' : `${c.currency || ''} ${Number(c.amount).toLocaleString()}`.trim());

  const render = () => {
    if (!run) {
      $('agent-state').textContent = 'IDLE';
      return;
    }
    const state = run.status.toUpperCase();
    $('agent-state').textContent = state;
    $('run-age').textContent = fmtAge(Date.now() - run.startedAt);
    $('stat-worked').textContent = `${run.worked} / ${claims.length}`;
    $('stat-gate').textContent = run.packets.length - run.approved;
    $('stat-checkpoints').textContent = run.checkpoints.length;
    $('stat-sessions').textContent = run.sessions;
    $('stat-ledger').textContent = run.ledger.length;
    const current = claims[run.worked];
    $('agent-current').textContent = run.status === 'done'
      ? 'Run complete. The run report is ready; packets remain at the human gate.'
      : current
        ? `${current.claim_id} — ${current.payer || 'payer not in source'} · ${money(current)} · ${current.denial_category || '—'}. ${PHASES.indexOf(phaseOf()) >= 2 ? 'Gathering evidence and building the recovery packet.' : 'Triaging against the book.'}`
        : '—';
    const phase = phaseOf();
    document.querySelectorAll('#phase-bar span').forEach((el) => {
      const p = el.getAttribute('data-phase');
      el.classList.toggle('current', p === phase);
      el.classList.toggle('done', PHASES.indexOf(p) < PHASES.indexOf(phase));
    });
    $('agent-pause').hidden = run.status !== 'running';
    $('agent-resume').hidden = run.status !== 'paused';
    $('agent-stop').hidden = run.status === 'done';
    $('agent-launch').hidden = !!run;
    $('agent-report').hidden = !run;
    const ledgerEl = $('ledger');
    ledgerEl.innerHTML = '';
    run.ledger.slice(-60).reverse().forEach((row) => {
      const li = document.createElement('li');
      const t = document.createElement('time');
      t.textContent = row.at.replace('T', ' ').slice(0, 19);
      li.append(t, row.event);
      ledgerEl.append(li);
    });
    const cpEl = $('checkpoints');
    cpEl.innerHTML = '';
    run.checkpoints.slice(-10).reverse().forEach((cp) => {
      const li = document.createElement('li');
      li.textContent = `${cp.at.replace('T', ' ').slice(0, 19)} — ${cp.note} (${cp.worked} claims worked)`;
      cpEl.append(li);
    });
    const rows = $('packet-rows');
    rows.innerHTML = '';
    $('packets-empty').hidden = run.packets.length > 0;
    run.packets.slice(-25).forEach((p) => {
      const tr = document.createElement('tr');
      [p.claim_id, p.payer, p.amount, p.category, p.evidence + ' items', p.next_step, p.status].forEach((v, i) => {
        const td = document.createElement('td');
        td.textContent = v == null ? '—' : v;
        if (i === 5) td.style.maxWidth = '260px';
        tr.append(td);
      });
      rows.append(tr);
    });
  };

  const workClaim = () => {
    if (!run || run.status !== 'running') return;
    const c = claims[run.worked];
    if (!c) { finish(); return; }
    const drivers = Array.isArray(c.review_drivers) ? c.review_drivers.length : 0;
    log(`Triage ${c.claim_id}: state "${c.state}", category "${c.denial_category || '—'}".`);
    log(`Evidence ${c.claim_id}: ${drivers} review driver(s) + payer response "${c.payer_response || '—'}".`);
    const packet = {
      claim_id: c.claim_id,
      payer: c.payer || 'Not present in source',
      amount: money(c),
      category: c.denial_category,
      evidence: drivers + 1,
      next_step: c.next_action || 'Route to human reviewer',
      status: 'Awaiting human approval'
    };
    run.packets.push(packet);
    run.worked += 1;
    log(`Packet ${c.claim_id}: built, placed at human gate. Nothing sent.`);
    if (run.worked % 5 === 0 || run.worked === claims.length) {
      checkpoint(`${run.worked} of ${claims.length} claims worked`);
    }
    writeRun();
    render();
    if (run.worked >= claims.length) finish();
  };

  const finish = () => {
    run.status = 'done';
    log('Run complete: book worked end-to-end. Packets await human approval.');
    checkpoint('final');
    writeRun();
    stopTick();
    render();
  };

  const startTick = () => {
    stopTick();
    if (!run || run.status !== 'running') return;
    timer = setInterval(workClaim, run.speed);
  };
  const stopTick = () => { if (timer) { clearInterval(timer); timer = null; } };

  const launch = () => {
    const speed = Number($('agent-speed').value);
    run = {
      version: 1,
      startedAt: Date.now(),
      status: 'running',
      speed,
      sessions: 1,
      worked: 0,
      approved: 0,
      packets: [],
      checkpoints: [],
      ledger: []
    };
    log(`Agent run launched over ${claims.length} de-identified claims. Cadence ${Math.round(speed / 1000)} s/claim.`);
    checkpoint('launch');
    writeRun();
    startTick();
    render();
  };

  $('agent-launch').addEventListener('click', launch);
  $('agent-pause').addEventListener('click', () => {
    run.status = 'paused';
    log('Paused by operator. State checkpointed.');
    checkpoint('pause');
    writeRun(); stopTick(); render();
  });
  $('agent-resume').addEventListener('click', () => {
    run.speed = Number($('agent-speed').value);
    run.status = 'running';
    log('Resumed by operator.');
    writeRun(); startTick(); render();
  });
  $('agent-stop').addEventListener('click', () => {
    run.status = 'done';
    log('Ended by operator. Packets remain at the human gate.');
    checkpoint('operator end');
    writeRun(); stopTick(); render();
  });
  $('agent-report').addEventListener('click', () => {
    if (!run) return;
    const report = {
      kind: 'nimbir-autonomous-run-report',
      run_id: 'agent-' + run.startedAt,
      generated_at: new Date().toISOString(),
      run_age: fmtAge(Date.now() - run.startedAt),
      sessions: run.sessions,
      claims_worked: run.worked,
      claims_total: claims.length,
      packets_at_human_gate: run.packets.length,
      checkpoints: run.checkpoints.length,
      ledger_events: run.ledger.length,
      note: 'In-browser preview over a local de-identified dataset. No packet has been sent; every packet requires human approval.'
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'nimbir-agent-run-report.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  fetch('claim-lines.json').then((r) => r.json()).then((data) => {
    claims = (data.claim_lines || []).filter((c) => c && c.claim_id);
    const existing = readRun();
    if (existing) {
      run = existing;
      run.sessions += 1;
      if (run.worked > claims.length) run.worked = claims.length;
      log('Session resumed from durable checkpoint; run age keeps counting across sessions.');
      writeRun();
      if (run.status === 'running') startTick();
    }
    render();
    uiTimer = setInterval(() => { if (run) $('run-age').textContent = fmtAge(Date.now() - run.startedAt); }, 1000);
  }).catch(() => {
    $('agent-current').textContent = 'Could not load the local claim dataset.';
  });
})();
