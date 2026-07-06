const state = {
  mode: 'hard',
  cfg: {
    alpha: 1, beta: 1, gamma: 1, phi: 4,
    budgetScale: 1,
    compatibilityExt: false,
    diversityExt: false,
    skillLoadExt: false,
    kappa: 1,
    mandatoryOverride: Object.fromEntries(PROJECTS.map(p => [p.id, p.mandatory])),
    // persistent instance edits (editable formulation / applied repairs)
    overrides: { needs: {}, budget: {}, sizeMin: {}, sizeMax: {}, concurrency: {} },
  },
  solution: null,
  cancelSolve: null,
  analysisRunning: false,
  lastRepairs: [],
  activePreset: null,
  // 'js' = the brute-force enumerator in solver.js (default, always available,
  // no backend needed). 'scipy' = scipy.optimize.milp (HiGHS) via the local
  // Python service in scipy_solver/ -- see SCIPY_BACKEND_URL below.
  solverBackend: 'js',
  scipyOnline: null, // null = unknown/checking, true/false once probed
  // Live latency comparison for the *current* scenario -- measured fresh
  // after every solve(), independent of which engine is actually driving
  // the displayed board. See measureLatency().
  latency: { js: null, scipy: null, token: 0 },
};

// Where the SciPy backend (scipy_solver/server.py) listens. Override for a
// non-default port with ?scipyUrl=http://host:port in the page URL.
const SCIPY_BACKEND_URL = new URLSearchParams(location.search).get('scipyUrl') || 'http://localhost:8787';

// Effective (post-override) parameter getters — these must match the logic in
// solver.js / analysis.js so the board and formulation show what's solved.
function ovMap(name) { return (state.cfg.overrides && state.cfg.overrides[name]) || {}; }
function effNeed(proj, skill) { const o = ovMap('needs')[proj.id]; return o && skill in o ? o[skill] : proj.needs[skill]; }
function effBudget(proj) { const o = ovMap('budget'); return proj.id in o ? o[proj.id] : Math.round(proj.budget * (state.cfg.budgetScale || 1)); }
function effSizeMin(proj) { const o = ovMap('sizeMin'); return proj.id in o ? o[proj.id] : proj.sizeMin; }
function effSizeMax(proj) { const o = ovMap('sizeMax'); return proj.id in o ? o[proj.id] : proj.sizeMax; }
function effConc(person) { const o = ovMap('concurrency'); return person.id in o ? o[person.id] : person.concurrency; }
function overridesActive() { return Object.values(state.cfg.overrides).some(m => Object.keys(m).length > 0); }

const els = {
  peopleList: document.getElementById('peopleList'),
  projectsList: document.getElementById('projectsList'),
  statusBanner: document.getElementById('statusBanner'),
  progressFill: document.getElementById('progressFill'),
  solveBtn: document.getElementById('solveBtn'),
  objValue: document.getElementById('objValue'),
  objFormula: document.getElementById('objFormula'),
  edgeSvg: document.getElementById('edgeSvg'),
  liveForm: document.getElementById('liveForm'),
  resetInstanceBtn: document.getElementById('resetInstanceBtn'),
  presetBar: document.getElementById('presetBar'),
  presetDesc: document.getElementById('presetDesc'),
  whyNotList: document.getElementById('whyNotList'),
  shadowList: document.getElementById('shadowList'),
  repairList: document.getElementById('repairList'),
  repairTitle: document.getElementById('repairTitle'),
  analyzeBtn: document.getElementById('analyzeBtn'),
  analyzeProgressFill: document.getElementById('analyzeProgressFill'),
  sweepParam: document.getElementById('sweepParam'),
  sweepBtn: document.getElementById('sweepBtn'),
  sweepChart: document.getElementById('sweepChart'),
  sweepLegend: document.getElementById('sweepLegend'),
  shareBtn: document.getElementById('shareBtn'),
  solverToggle: document.getElementById('solverToggle'),
  solverStatus: document.getElementById('solverStatus'),
  latencyLine: document.getElementById('latencyLine'),
};

// ---------- Build static card skeletons ----------

function buildPeopleSkeleton() {
  els.peopleList.innerHTML = '';
  for (const person of PEOPLE) {
    const card = document.createElement('div');
    card.className = 'person-card';
    card.id = `person-${person.id}`;
    card.innerHTML = `
      <div class="person-top">
        <span class="person-name">${person.name}</span>
        <span class="person-dept">${person.dept}</span>
      </div>
      <div class="person-meta">
        <span>$${person.cost}/day</span>
        <span class="conc-meta">&times;${person.concurrency} concurrent</span>
      </div>
      <div class="skill-row">
        ${SKILLS.map(s => `
          <div class="skill-item">
            ${SKILL_LABEL[s]}
            <div class="dots">${[0,1,2].map(k => `<div class="dot ${k < person.prof[s] ? 'filled' : ''} ${isQualified(person,s) && k===0 ? 'qualified-mark' : ''}"></div>`).join('')}</div>
          </div>`).join('')}
      </div>
      <div class="assign-tag">→ assigned</div>
    `;
    els.peopleList.appendChild(card);
  }
}

function buildProjectsSkeleton() {
  els.projectsList.innerHTML = '';
  for (const proj of PROJECTS) {
    const card = document.createElement('div');
    card.className = 'project-card';
    card.id = `project-${proj.id}`;
    card.innerHTML = `
      <div class="project-top">
        <span class="project-name">${proj.name}</span>
        <span class="value-badge">v=${proj.value}</span>
      </div>
      <div class="project-blurb">${proj.blurb}</div>
      <label class="mandatory-toggle soft-only-control">
        <input type="checkbox" data-project="${proj.id}" ${proj.mandatory ? 'checked' : ''}>
        Mandatory (fixes w<sub>j</sub>=1)
      </label>
      ${Object.keys(proj.needs).map(s => `
        <div class="gauge-row" data-skill="${s}">
          <div class="gauge-label"><span>${SKILL_LABEL[s]}</span><span class="gauge-count">0 / ${proj.needs[s]}</span></div>
          <div class="gauge-track"><div class="gauge-fill"></div></div>
        </div>`).join('')}
      <div class="gauge-row" data-gauge="size">
        <div class="gauge-label"><span>Team size</span><span class="gauge-count">0 (${proj.sizeMin}&ndash;${proj.sizeMax})</span></div>
        <div class="gauge-track"><div class="gauge-fill"></div></div>
      </div>
      <div class="gauge-row" data-gauge="budget">
        <div class="gauge-label"><span>Budget</span><span class="gauge-count">$0 / $${proj.budget}</span></div>
        <div class="gauge-track"><div class="gauge-fill"></div></div>
      </div>
      <div class="badges-row"></div>
    `;
    els.projectsList.appendChild(card);
  }

  els.projectsList.querySelectorAll('input[data-project]').forEach(input => {
    input.addEventListener('change', () => {
      state.cfg.mandatoryOverride[input.dataset.project] = input.checked;
      solve();
    });
  });
}

// ---------- Update from solution ----------

function clearBoard() {
  for (const person of PEOPLE) {
    const el = document.getElementById(`person-${person.id}`);
    el.classList.remove('assigned', 'unused');
  }
  for (const proj of PROJECTS) {
    const el = document.getElementById(`project-${proj.id}`);
    el.classList.remove('covered', 'shortfall', 'dropped');
    el.querySelectorAll('.gauge-fill').forEach(g => { g.style.width = '0%'; g.className = 'gauge-fill'; });
    el.querySelector('.badges-row').innerHTML = '';
  }
  els.edgeSvg.innerHTML = '';
}

function applySolutionToBoard(solution) {
  PEOPLE.forEach((person, i) => {
    const el = document.getElementById(`person-${person.id}`);
    const cm = el.querySelector('.conc-meta');
    if (cm) cm.innerHTML = `&times;${effConc(person)} concurrent`;
    const assignedProject = PROJECTS.find((proj, j) => solution.xBits & (1 << (i * PROJECTS.length + j)));
    if (assignedProject) {
      el.classList.add('assigned');
      el.classList.remove('unused');
      el.querySelector('.assign-tag').textContent = `→ ${assignedProject.name}`;
    } else {
      el.classList.add('unused');
      el.classList.remove('assigned');
    }
  });

  PROJECTS.forEach((proj, j) => {
    const el = document.getElementById(`project-${proj.id}`);
    const team = solution.teams[j];
    const selected = state.mode === 'soft' ? !!solution.wOut[j] : true;

    el.classList.remove('covered', 'shortfall', 'dropped');
    el.querySelectorAll('.gauge-fill').forEach(g => { g.classList.remove('ok', 'short'); });
    el.querySelector('.badges-row').innerHTML = '';

    if (!selected) {
      el.classList.add('dropped');
      el.querySelector('.badges-row').innerHTML = `<span class="badge notstaffed">Not staffed (optional)</span>`;
    }

    for (const s of Object.keys(proj.needs)) {
      const row = el.querySelector(`.gauge-row[data-skill="${s}"]`);
      const count = team.filter(p => isQualified(p, s)).length;
      const needFull = effNeed(proj, s);
      const need = needFull * (selected ? 1 : 0);
      const pct = need === 0 ? (count > 0 ? 100 : 0) : Math.min(100, (count / need) * 100);
      const fill = row.querySelector('.gauge-fill');
      fill.style.width = `${pct}%`;
      if (selected) fill.classList.add(count >= need ? 'ok' : 'short');
      row.querySelector('.gauge-count').textContent = `${count} / ${needFull}`;
    }

    const sizeRow = el.querySelector('.gauge-row[data-gauge="size"]');
    const sMin = effSizeMin(proj), sMax = effSizeMax(proj);
    const sizePct = selected ? Math.min(100, (team.length / sMax) * 100) : 0;
    sizeRow.querySelector('.gauge-fill').style.width = `${sizePct}%`;
    if (selected) sizeRow.querySelector('.gauge-fill').classList.add(team.length >= sMin ? 'ok' : 'short');
    sizeRow.querySelector('.gauge-count').textContent = `${team.length} (${sMin}–${sMax})`;

    const budgetRow = el.querySelector('.gauge-row[data-gauge="budget"]');
    const cost = team.reduce((a, p) => a + p.cost, 0);
    const projBudget = effBudget(proj);
    const budgetPct = Math.min(100, (cost / projBudget) * 100);
    budgetRow.querySelector('.gauge-fill').style.width = `${budgetPct}%`;
    budgetRow.querySelector('.gauge-fill').classList.add(cost <= projBudget ? 'ok' : 'short');
    budgetRow.querySelector('.gauge-count').textContent = `$${cost} / $${projBudget}`;

    const shortfallsHere = (solution.shortfalls || []).filter(sf => sf.projectId === proj.id);
    if (shortfallsHere.length) {
      el.classList.add('shortfall');
      const badgeRow = el.querySelector('.badges-row');
      badgeRow.innerHTML += shortfallsHere.map(sf => `<span class="badge gap">short ${sf.amount} ${SKILL_LABEL[sf.skill]}</span>`).join('');
    } else if (selected) {
      el.classList.add('covered');
    }
  });

  drawEdges(solution);
}

function drawEdges(solution) {
  const svg = els.edgeSvg;
  svg.innerHTML = '';
  if (!solution) return;
  const boardRect = document.querySelector('.board').getBoundingClientRect();
  const svgNS = 'http://www.w3.org/2000/svg';

  PEOPLE.forEach((person, i) => {
    PROJECTS.forEach((proj, j) => {
      if (!(solution.xBits & (1 << (i * PROJECTS.length + j)))) return;
      const pRect = document.getElementById(`person-${person.id}`).getBoundingClientRect();
      const jRect = document.getElementById(`project-${proj.id}`).getBoundingClientRect();
      const x1 = pRect.right - boardRect.left;
      const y1 = pRect.top - boardRect.top + pRect.height / 2;
      const x2 = jRect.left - boardRect.left;
      const y2 = jRect.top - boardRect.top + jRect.height / 2;
      const midX = (x1 + x2) / 2;

      const hasShortfall = (solution.shortfalls || []).some(sf => sf.projectId === proj.id);
      const path = document.createElementNS(svgNS, 'path');
      path.setAttribute('d', `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', hasShortfall ? '#C0492F' : '#4C6EF5');
      path.setAttribute('stroke-width', '2');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('opacity', '0.8');
      svg.appendChild(path);

      const len = path.getTotalLength();
      path.style.strokeDasharray = String(len);
      path.style.strokeDashoffset = String(len);
      requestAnimationFrame(() => {
        path.style.transition = 'stroke-dashoffset 0.8s cubic-bezier(.2,.8,.2,1)';
        path.style.strokeDashoffset = '0';
      });
    });
  });
}

// ---------- Objective readout ----------

let objAnimGeneration = 0;
function animateObjective(target) {
  const el = els.objValue;
  const start = parseFloat(el.dataset.raw || '0');
  const duration = 500;
  const generation = ++objAnimGeneration;
  let startTime = null;
  function tick(now) {
    if (generation !== objAnimGeneration) return; // superseded by a newer call
    if (startTime === null) startTime = now;
    const t = Math.min(1, Math.max(0, (now - startTime) / duration));
    const eased = 1 - Math.pow(1 - t, 3);
    const val = start + (target - start) * eased;
    el.textContent = val.toFixed(2);
    el.classList.toggle('negative', val < 0);
    el.dataset.raw = String(val);
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// ---------- Status ----------

function setStatus(text, cls) {
  els.statusBanner.textContent = text;
  els.statusBanner.className = `status-banner ${cls}`;
}

// ---------- Solve orchestration ----------
//
// Two interchangeable backends, selected by the "solver engine" toggle:
//   'js'    -> solveViaJS()    the brute-force enumerator in solver.js
//   'scipy' -> solveViaScipy() scipy.optimize.milp (HiGHS) over HTTP, see
//                               scipy_solver/. Both funnel into finishSolve()
//                               so board rendering is identical either way.
let solveToken = 0;

function solve() {
  const token = ++solveToken;
  if (state.cancelSolve) state.cancelSolve();
  clearBoard();
  els.solveBtn.disabled = true;
  els.progressFill.style.width = '0%';
  els.progressFill.classList.remove('indeterminate');
  renderLiveFormulation();
  resetAnalysisPanels(); // any prior analysis is now stale

  if (state.solverBackend === 'scipy') solveViaScipy(token);
  else solveViaJS();

  measureLatency(); // independent of the above -- always compares both engines
}

// ---------- Latency comparison (brute-force vs. real MILP, this scenario) ----------
//
// Fires after every solve() so the numbers always reflect the current mode,
// weights, extensions, and overrides. Timed independently of whichever
// engine is actually driving the board:
//   - "brute-force" is timed via analysis.js's solveFast -- the same
//     enumeration as solver.js, but without the setTimeout animation pacing,
//     so this is raw compute time, not the deliberately-slowed display.
//   - "SciPy/HiGHS" is timed as a full fetch round trip, since that network
//     hop is real latency you'd feel if you switched the toggle.
function measureLatency() {
  const myToken = ++state.latency.token;
  const mode = state.mode, cfg = state.cfg;

  // Brute-force: local, synchronous, cheap at this instance size -- defer
  // one tick so it doesn't delay the "Solving…" status paint.
  setTimeout(() => {
    if (myToken !== state.latency.token) return;
    const t0 = performance.now();
    A.solveFast(mode, cfg);
    state.latency.js = performance.now() - t0;
    renderLatencyPanel();
  }, 0);

  // SciPy: real network round trip, timed end-to-end from the caller's side.
  const t1 = performance.now();
  fetch(`${SCIPY_BACKEND_URL}/solve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, cfg }),
  })
    .then(res => res.json())
    .then(() => {
      if (myToken !== state.latency.token) return;
      state.latency.scipy = performance.now() - t1;
      state.scipyOnline = true;
      renderLatencyPanel();
    })
    .catch(() => {
      if (myToken !== state.latency.token) return;
      state.latency.scipy = null;
      state.scipyOnline = false;
      renderLatencyPanel();
    });
}

function renderLatencyPanel() {
  if (!els.latencyLine) return;
  const { js, scipy } = state.latency;
  const jsText = js == null ? 'measuring…' : `${js.toFixed(0)}ms`;

  if (state.scipyOnline === false) {
    els.latencyLine.innerHTML = `<strong>Brute-force (JS):</strong> ${jsText} &nbsp;&middot;&nbsp; <span class="latency-offline">SciPy backend offline — start it to compare</span>`;
    return;
  }
  const scipyText = scipy == null ? 'measuring…' : `${scipy.toFixed(0)}ms`;

  let compare = '';
  if (js != null && scipy != null && scipy > 0) {
    compare = js >= scipy
      ? ` &nbsp;&middot;&nbsp; <strong class="latency-winner">SciPy ~${(js / scipy).toFixed(1)}&times; faster</strong>`
      : ` &nbsp;&middot;&nbsp; <strong class="latency-winner">Brute-force ~${(scipy / js).toFixed(1)}&times; faster here</strong> <span class="latency-note">(tiny instance — the network round trip dominates)</span>`;
  }
  els.latencyLine.innerHTML = `<strong>Brute-force (JS):</strong> ${jsText} &nbsp;&middot;&nbsp; <strong>SciPy/HiGHS:</strong> ${scipyText}${compare}`;
}

// Shared "solve finished" rendering, regardless of which backend produced it.
function finishSolve(best) {
  els.solveBtn.disabled = false;
  state.solution = best;
  if (!best) {
    clearBoard();
    objAnimGeneration++; // supersede any in-flight animation
    els.objValue.dataset.raw = '0';
    els.objValue.textContent = '—';
    els.objValue.classList.remove('negative');
    setStatus('INFEASIBLE — no plan satisfies every coverage requirement at once. Try Soft coverage (Variant 3) →', 'infeasible');
    els.statusBanner.style.cursor = 'pointer';
    els.statusBanner.onclick = () => setMode('soft');
    renderWhyNot(null);
    return;
  }
  els.statusBanner.style.cursor = 'default';
  els.statusBanner.onclick = null;
  applySolutionToBoard(best);
  animateObjective(best.objective);
  renderWhyNot(best);
}

function solveViaJS() {
  setStatus('Solving — enumerating the full feasible search space…', 'solving');
  const total = state.mode === 'soft'
    ? (1 << (PEOPLE.length * PROJECTS.length)) * (1 << PROJECTS.length)
    : (1 << (PEOPLE.length * PROJECTS.length));
  const chunkSize = Math.max(500, Math.ceil(total / 80));

  state.cancelSolve = runSolve({
    mode: state.mode,
    cfg: state.cfg,
    chunkSize,
    onProgress: (frac, incumbent) => {
      els.progressFill.style.width = `${(frac * 100).toFixed(1)}%`;
      state.solution = incumbent;
      applySolutionToBoard(incumbent);
      animateObjective(incumbent.objective);
      setStatus(`Solving — found improved plan, objective ${incumbent.objective.toFixed(2)}…`, 'solving');
    },
    onDone: (best) => {
      els.progressFill.style.width = '100%';
      finishSolve(best);
      if (best) {
        const hasGap = (best.shortfalls || []).length > 0;
        setStatus(
          hasGap
            ? `Proven optimal ✓ — searched all ${total.toLocaleString()} combinations. Best plan still leaves a priced gap.`
            : `Proven optimal ✓ — searched all ${total.toLocaleString()} combinations. Every constraint satisfied.`,
          'optimal'
        );
      }
    },
  });
}

// Converts the SciPy backend's response ({assignment, selected, shortfalls,
// objective}) into the same {xBits, wBits, teams, wOut, shortfalls,
// shortfallTotal, objective} shape solver.js produces, so every downstream
// renderer (applySolutionToBoard, drawEdges, renderWhyNot...) is unchanged.
function scipyResultToSolution(result) {
  const J = PROJECTS.length;
  const personIdx = Object.fromEntries(PEOPLE.map((p, i) => [p.id, i]));
  const projectIdx = Object.fromEntries(PROJECTS.map((p, j) => [p.id, j]));
  let xBits = 0;
  const teams = PROJECTS.map(() => []);
  (result.assignment || []).forEach(([personId, projectId]) => {
    const i = personIdx[personId], j = projectIdx[projectId];
    xBits |= (1 << (i * J + j));
    teams[j].push(PEOPLE[i]);
  });
  const wOut = PROJECTS.map(p => (state.mode === 'soft' ? !!(result.selected && result.selected[p.id]) : true) ? 1 : 0);
  let wBits = 0;
  wOut.forEach((w, j) => { if (w) wBits |= (1 << j); });
  const shortfalls = result.shortfalls || [];
  const shortfallTotal = shortfalls.reduce((a, s) => a + s.amount, 0);
  return { xBits, wBits, teams, wOut, shortfalls, shortfallTotal, objective: result.objective };
}

async function solveViaScipy(token) {
  setStatus('Solving via SciPy (HiGHS)…', 'solving');
  els.progressFill.classList.add('indeterminate');
  els.progressFill.style.width = '40%';
  const t0 = performance.now();
  try {
    const res = await fetch(`${SCIPY_BACKEND_URL}/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: state.mode, cfg: state.cfg }),
    });
    const data = await res.json();
    if (token !== solveToken) return; // superseded by a newer solve() call
    state.scipyOnline = true;
    updateSolverStatusPill();
    els.progressFill.classList.remove('indeterminate');
    els.progressFill.style.width = '100%';
    const ms = (performance.now() - t0).toFixed(0);
    if (!data.feasible) {
      finishSolve(null);
      setStatus(`INFEASIBLE — SciPy/HiGHS proved no plan satisfies every constraint (${ms}ms). Try Soft coverage (Variant 3) →`, 'infeasible');
      els.statusBanner.style.cursor = 'pointer';
      els.statusBanner.onclick = () => setMode('soft');
      return;
    }
    const solution = scipyResultToSolution(data);
    finishSolve(solution);
    const hasGap = (solution.shortfalls || []).length > 0;
    setStatus(
      hasGap
        ? `Proven optimal ✓ — solved via SciPy/HiGHS (${ms}ms). Best plan still leaves a priced gap.`
        : `Proven optimal ✓ — solved via SciPy/HiGHS (${ms}ms). Every constraint satisfied.`,
      'optimal'
    );
  } catch (err) {
    if (token !== solveToken) return;
    state.scipyOnline = false;
    updateSolverStatusPill();
    els.progressFill.classList.remove('indeterminate');
    els.progressFill.style.width = '0%';
    els.solveBtn.disabled = false;
    setStatus(
      `Can't reach the SciPy backend at ${SCIPY_BACKEND_URL} — start it with "python3 scipy_solver/server.py" (see scipy_solver/README.md), or switch back to Brute-force (JS).`,
      'infeasible'
    );
  }
}

async function checkScipyHealth() {
  try {
    const res = await fetch(`${SCIPY_BACKEND_URL}/health`, { method: 'GET' });
    state.scipyOnline = res.ok;
  } catch (err) {
    state.scipyOnline = false;
  }
  updateSolverStatusPill();
}

function updateSolverStatusPill() {
  if (!els.solverStatus) return;
  if (state.solverBackend !== 'scipy') { els.solverStatus.style.display = 'none'; return; }
  els.solverStatus.style.display = '';
  if (state.scipyOnline === true) {
    els.solverStatus.textContent = '● SciPy backend connected';
    els.solverStatus.className = 'solver-status online';
  } else if (state.scipyOnline === false) {
    els.solverStatus.textContent = '● SciPy backend offline — start python3 scipy_solver/server.py';
    els.solverStatus.className = 'solver-status offline';
  } else {
    els.solverStatus.textContent = '● checking SciPy backend…';
    els.solverStatus.className = 'solver-status checking';
  }
}

function setSolverBackend(backend) {
  state.solverBackend = backend;
  document.querySelectorAll('.solver-btn').forEach(b => b.classList.toggle('active', b.dataset.backend === backend));
  updateSolverStatusPill();
  if (backend === 'scipy') checkScipyHealth();
}

// ---------- Wiring ----------

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  document.querySelectorAll('.soft-only').forEach(el => el.classList.toggle('active', mode === 'soft'));
  document.querySelectorAll('.soft-only-control').forEach(el => el.classList.toggle('visible', mode === 'soft'));
  solve();
}

function bindSlider(id, key, decimals = 1) {
  const input = document.getElementById(id);
  const val = document.getElementById(`${id}Val`);
  input.addEventListener('input', () => {
    val.textContent = parseFloat(input.value).toFixed(decimals);
  });
  input.addEventListener('change', () => {
    state.cfg[key] = parseFloat(input.value);
    solve();
  });
}

function init() {
  buildPeopleSkeleton();
  buildProjectsSkeleton();

  document.querySelectorAll('.seg-btn').forEach(btn => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });
  els.solveBtn.addEventListener('click', solve);

  bindSlider('alpha', 'alpha');
  bindSlider('beta', 'beta');
  bindSlider('gamma', 'gamma');
  bindSlider('phi', 'phi');
  bindSlider('kappa', 'kappa', 0);

  document.getElementById('extCompat').addEventListener('change', (e) => {
    state.cfg.compatibilityExt = e.target.checked;
    solve();
  });
  document.getElementById('extDiversity').addEventListener('change', (e) => {
    state.cfg.diversityExt = e.target.checked;
    solve();
  });
  document.getElementById('extSkillLoad').addEventListener('change', (e) => {
    state.cfg.skillLoadExt = e.target.checked;
    solve();
  });

  window.addEventListener('resize', () => { if (state.solution) drawEdges(state.solution); });

  // New: presets, share link, analysis, and what-if wiring.
  buildPresetBar();
  els.shareBtn.addEventListener('click', copyShareLink);
  els.analyzeBtn.addEventListener('click', runAnalysis);

  // Editable-formulation steppers (event delegation, survives re-renders).
  els.liveForm.addEventListener('click', (e) => {
    const btn = e.target.closest('.lf-step-btn');
    if (!btn) return;
    const st = btn.closest('.lf-stepper');
    const dir = parseInt(btn.dataset.dir, 10);
    const step = parseFloat(st.dataset.step);
    const min = parseFloat(st.dataset.min), max = parseFloat(st.dataset.max);
    const cur = parseFloat(st.dataset.value);
    const next = Math.min(max, Math.max(min, cur + dir * step));
    if (next === cur) return;
    setInstanceOverride(st.dataset.kind, st.dataset.id, st.dataset.skill || null, next);
    solve();
  });
  // Apply-a-repair buttons.
  els.repairList.addEventListener('click', (e) => {
    const btn = e.target.closest('.lf-apply');
    if (!btn) return;
    const r = state.lastRepairs[parseInt(btn.dataset.repair, 10)];
    if (r) applyRepair(r.apply);
  });
  if (els.resetInstanceBtn) els.resetInstanceBtn.addEventListener('click', resetInstance);

  document.querySelectorAll('.solver-btn').forEach(btn => {
    btn.addEventListener('click', () => { setSolverBackend(btn.dataset.backend); solve(); });
  });

  populateSweepParams();
  els.sweepBtn.addEventListener('click', runSweep);
  els.sweepParam.addEventListener('change', () => { clearSweepChart(); });

  // Restore full state from the URL if present, else default to the
  // Hard-coverage opener (deliberately infeasible — the slide-6 hook).
  const applied = applyStateFromURL();
  if (!applied) solve();
}

// ===================================================================
//  Presets + shareable state
// ===================================================================

function defaultCfg() {
  return {
    alpha: 1, beta: 1, gamma: 1, phi: 4, budgetScale: 1,
    compatibilityExt: false, diversityExt: false, skillLoadExt: false, kappa: 1,
    mandatoryOverride: Object.fromEntries(PROJECTS.map(p => [p.id, p.mandatory])),
    overrides: { needs: {}, budget: {}, sizeMin: {}, sizeMax: {}, concurrency: {} },
  };
}

// One-click "interesting" scenarios. Each is a full cfg snapshot plus a
// plain-English description shown in the UI. Most presets are mode-agnostic
// and simply run under whichever coverage mode you're already in; only the
// two that are meaningless in Hard coverage (no project can ever be made
// optional there) declare `requiresMode` and switch you over.
const PRESETS = {
  baseline: {
    label: 'Baseline',
    desc: 'Everything at its default: even weights, full budget, no conflicts, no extensions — the calibrated starting point.',
    cfg: () => defaultCfg(),
  },
  tightBudget: {
    label: 'Tight budget',
    desc: "Every project's budget cut to 60% — forces the solver to swap in cheaper people even where they fit less well.",
    cfg: () => ({ ...defaultCfg(), budgetScale: 0.6 }),
  },
  incompatible: {
    label: 'Incompatible pair',
    desc: 'Ben and Chen can never share a team — breaks up their combined coverage and forces a different split.',
    cfg: () => ({ ...defaultCfg(), compatibilityExt: true }),
  },
  skillLoad: {
    label: 'Skill-load squeeze',
    desc: 'Each person can be credited for only 1 skill per project (κ=1) — a generalist can no longer single-handedly satisfy two coverage rows.',
    requiresMode: 'soft', // skill-load control is a Variant 3 extension only
    cfg: () => ({ ...defaultCfg(), skillLoadExt: true, kappa: 1 }),
  },
};

function buildPresetBar() {
  const bar = els.presetBar;
  if (!bar) return;
  bar.querySelectorAll('.preset-btn').forEach(b => b.remove());
  Object.keys(PRESETS).forEach(key => {
    const preset = PRESETS[key];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preset-btn';
    btn.dataset.preset = key;
    btn.textContent = preset.label;
    btn.title = preset.desc;
    btn.addEventListener('click', () => applyPreset(key));
    btn.addEventListener('mouseenter', () => showPresetDesc(key));
    btn.addEventListener('focus', () => showPresetDesc(key));
    btn.addEventListener('mouseleave', () => showPresetDesc(state.activePreset));
    btn.addEventListener('blur', () => showPresetDesc(state.activePreset));
    bar.appendChild(btn);
  });
  showPresetDesc(state.activePreset);
}

function showPresetDesc(key) {
  if (!els.presetDesc) return;
  const preset = key && PRESETS[key];
  els.presetDesc.textContent = preset ? preset.desc : 'Hover a scenario to see what it changes.';
  els.presetDesc.classList.toggle('preset-desc-hint', !preset);
}

function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;
  state.cfg = preset.cfg();
  // Only force a mode switch when the scenario genuinely doesn't work in the
  // mode you're currently in (see requiresMode above) — otherwise stay put,
  // so clicking a preset from Hard coverage doesn't silently jump to Soft.
  state.mode = preset.requiresMode || state.mode;
  state.activePreset = name;
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.toggle('active', b.dataset.preset === name));
  showPresetDesc(name);
  setUIFromState();
  clearSweepChart();
  solve();
}

// Push every control in the DOM to match state.cfg / state.mode (no solve).
function setUIFromState() {
  const c = state.cfg;
  const setSlider = (id, v, d) => {
    const input = document.getElementById(id);
    if (!input) return;
    input.value = v;
    const val = document.getElementById(`${id}Val`);
    if (val) val.textContent = Number(v).toFixed(d);
  };
  setSlider('alpha', c.alpha, 1);
  setSlider('beta', c.beta, 1);
  setSlider('gamma', c.gamma, 1);
  setSlider('phi', c.phi, 1);
  setSlider('kappa', c.kappa, 0);
  document.getElementById('extCompat').checked = c.compatibilityExt;
  document.getElementById('extDiversity').checked = c.diversityExt;
  document.getElementById('extSkillLoad').checked = c.skillLoadExt;
  document.querySelectorAll('input[data-project]').forEach(inp => {
    inp.checked = !!c.mandatoryOverride[inp.dataset.project];
  });
  document.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === state.mode));
  document.querySelectorAll('.soft-only').forEach(el => el.classList.toggle('active', state.mode === 'soft'));
  document.querySelectorAll('.soft-only-control').forEach(el => el.classList.toggle('visible', state.mode === 'soft'));
  document.querySelectorAll('.solver-btn').forEach(b => b.classList.toggle('active', b.dataset.backend === state.solverBackend));
  populateSweepParams();
}

function serializeState() {
  const c = state.cfg;
  const p = new URLSearchParams();
  p.set('mode', state.mode);
  p.set('a', c.alpha); p.set('b', c.beta); p.set('g', c.gamma); p.set('p', c.phi); p.set('k', c.kappa);
  if ((c.budgetScale || 1) !== 1) p.set('bs', c.budgetScale);
  const ext = [];
  if (c.compatibilityExt) ext.push('compat');
  if (c.diversityExt) ext.push('div');
  if (c.skillLoadExt) ext.push('skill');
  if (ext.length) p.set('ext', ext.join(','));
  p.set('mand', PROJECTS.filter(pr => c.mandatoryOverride[pr.id]).map(pr => pr.id).join(','));
  if (overridesActive()) p.set('ov', JSON.stringify(c.overrides));
  if (state.solverBackend === 'scipy') p.set('solver', 'scipy');
  const customScipyUrl = new URLSearchParams(location.search).get('scipyUrl');
  if (customScipyUrl) p.set('scipyUrl', customScipyUrl);
  return p.toString();
}

function applyStateFromURL() {
  const params = new URLSearchParams(location.search);
  if (![...params.keys()].length) return false;
  const c = state.cfg;
  const num = (k, def) => (params.has(k) && !isNaN(parseFloat(params.get(k))) ? parseFloat(params.get(k)) : def);
  c.alpha = num('a', c.alpha);
  c.beta = num('b', c.beta);
  c.gamma = num('g', c.gamma);
  c.phi = num('p', c.phi);
  c.kappa = num('k', c.kappa);
  c.budgetScale = num('bs', 1);
  if (params.has('ext')) {
    const e = params.get('ext').split(',');
    c.compatibilityExt = e.includes('compat');
    c.diversityExt = e.includes('div');
    c.skillLoadExt = e.includes('skill');
  }
  if (params.get('skillLoad') === '1') c.skillLoadExt = true; // legacy deep-link
  if (params.has('mand')) {
    const m = params.get('mand').split(',').filter(Boolean);
    PROJECTS.forEach(pr => { c.mandatoryOverride[pr.id] = m.includes(pr.id); });
  }
  if (params.has('ov')) {
    try {
      const parsed = JSON.parse(params.get('ov'));
      for (const k of ['needs', 'budget', 'sizeMin', 'sizeMax', 'concurrency']) {
        if (parsed && typeof parsed[k] === 'object' && parsed[k]) c.overrides[k] = parsed[k];
      }
    } catch (e) { /* ignore malformed override blob */ }
  }
  const mode = params.get('mode');
  if (mode === 'soft' || mode === 'hard') state.mode = mode;
  if (params.get('solver') === 'scipy') setSolverBackend('scipy');
  setUIFromState();
  solve();
  return true;
}

function copyShareLink() {
  const url = `${location.origin}${location.pathname}?${serializeState()}`;
  history.replaceState(null, '', url);
  const done = (ok) => {
    els.shareBtn.textContent = ok ? '✓ Link copied' : '⌘C to copy — shown in address bar';
    setTimeout(() => { els.shareBtn.textContent = '🔗 Copy link'; }, 2200);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => done(true)).catch(() => done(false));
  } else {
    done(false);
  }
}

// ===================================================================
//  Yielding job scheduler (keeps the UI live through batches of solves)
// ===================================================================

function runJobs(jobs, onProgress, onDone) {
  let i = 0;
  const results = [];
  // setTimeout (not requestAnimationFrame) so batches keep progressing even if
  // the tab is backgrounded, and never deadlock against the animated solve.
  function tick() {
    const t0 = performance.now();
    while (i < jobs.length && performance.now() - t0 < 45) {
      const j = jobs[i];
      let result = null;
      try { result = j.run(); } catch (e) { console.error('probe failed:', e); }
      results.push(Object.assign({}, j, { result }));
      i++;
      if (onProgress) onProgress(i / jobs.length);
    }
    if (i < jobs.length) setTimeout(tick, 0);
    else onDone(results);
  }
  setTimeout(tick, 0);
}

// ===================================================================
//  Explainability — why the plan looks the way it does
// ===================================================================

function renderWhyNot(best) {
  const list = els.whyNotList;
  if (!best) {
    list.innerHTML = `<li class="reason-empty">No feasible plan — see the repairs below for the smallest change that unblocks one.</li>`;
    return;
  }
  const reasons = explainAssignments(best, state.mode, state.cfg);
  if (!reasons.length) {
    list.innerHTML = `<li class="reason-ok">Everyone with spare capacity is already optimally placed — no one is being left out.</li>`;
    return;
  }
  list.innerHTML = reasons.map(r =>
    `<li><span class="reason-who">${r.person}</span><span class="reason-why">${r.reason}</span></li>`
  ).join('');
}

function resetAnalysisPanels() {
  els.shadowList.innerHTML = `<li class="reason-empty">Run the analysis to compute marginal values.</li>`;
  els.repairList.innerHTML = `<li class="reason-empty">Run the analysis to find the smallest fixes.</li>`;
  els.repairTitle.innerHTML = `Minimal repairs <span class="insight-sub">single changes that fix the gap</span>`;
  els.analyzeProgressFill.style.width = '0%';
  els.analyzeProgressFill.parentElement.classList.remove('active');
  if (els.analyzeBtn) els.analyzeBtn.textContent = 'Run sensitivity & repair analysis ▸';
  clearSweepChart();
}

function runAnalysis() {
  if (state.analysisRunning) return;
  const base = A.solveFast(state.mode, state.cfg); // normalized {objective, shortfall} or null
  const { jobs } = buildProbeJobs(state.mode, state.cfg, base);
  state.analysisRunning = true;
  els.analyzeBtn.disabled = true;
  els.analyzeBtn.textContent = 'Analyzing…';
  els.analyzeProgressFill.parentElement.classList.add('active');
  els.analyzeProgressFill.style.width = '0%';

  runJobs(jobs,
    frac => { els.analyzeProgressFill.style.width = `${(frac * 100).toFixed(0)}%`; },
    results => {
      const summary = summarizeProbes(results, state.mode, base);
      state.lastRepairs = summary.repairs;
      renderShadow(summary.shadow);
      renderRepairs(summary.repairs, summary.infeasible);
      state.analysisRunning = false;
      els.analyzeBtn.disabled = false;
      els.analyzeBtn.textContent = 'Re-run analysis ▸';
      els.analyzeProgressFill.parentElement.classList.remove('active');
    }
  );
}

function renderShadow(shadow) {
  if (!shadow.length) {
    els.shadowList.innerHTML = `<li class="reason-ok">No constraint is currently binding — the optimum has slack on every lever tested.</li>`;
    return;
  }
  els.shadowList.innerHTML = shadow.map(s =>
    `<li><span class="reason-who">${s.label}</span><span class="reason-why">${s.detail}</span></li>`
  ).join('');
}

function renderRepairs(repairs, infeasible) {
  els.repairTitle.innerHTML = infeasible
    ? `Restore feasibility <span class="insight-sub">smallest single change that yields a plan</span>`
    : `Minimal repairs <span class="insight-sub">single changes that close the gap / improve the plan</span>`;
  if (!repairs.length) {
    els.repairList.innerHTML = infeasible
      ? `<li class="reason-empty">No single relaxation restores feasibility — this is the slide-6 case. Switch to <a class="inline-link" href="#" id="toSoftLink">Soft coverage</a>, which prices the gap instead of forbidding it.</li>`
      : `<li class="reason-ok">The optimum is unaffected by any single relaxation tested — it's well inside the feasible region.</li>`;
    const link = document.getElementById('toSoftLink');
    if (link) link.addEventListener('click', (e) => { e.preventDefault(); setMode('soft'); });
    return;
  }
  els.repairList.innerHTML = repairs.map((r, i) =>
    `<li><span class="reason-who">${r.label}</span><span class="reason-why">${r.effect}</span>`
    + (r.apply ? `<button class="lf-apply" data-repair="${i}">Apply ▸</button>` : '')
    + `</li>`
  ).join('');
}

// ===================================================================
//  Live formulation (KaTeX) — the real MILP with current weights
// ===================================================================

function renderLiveFormulation() {
  if (typeof katex === 'undefined' || !els.liveForm) return;
  const F = instFormulation(state.mode, state.cfg);

  // Build the whole panel as HTML with placeholder spans, then typeset each.
  const pending = [];
  let n = 0;
  const M = (tex, cls) => { const id = `lf${n++}`; pending.push([id, tex]); return `<span class="lf-math ${cls || ''}" id="${id}"></span>`; };

  // Build a caption cell: plain text + optional note + editable steppers.
  const stepper = e => {
    const modified = e.value !== e.base;
    return `<span class="lf-stepper${modified ? ' modified' : ''}" data-kind="${e.kind}" data-id="${e.id}" data-skill="${e.skill || ''}"`
      + ` data-value="${e.value}" data-min="${e.min}" data-max="${e.max}" data-step="${e.step}">`
      + `<span class="lf-step-label">${e.label}</span>`
      + `<button class="lf-step-btn" data-dir="-1" aria-label="decrease">−</button>`
      + `<span class="lf-step-val">${e.value}</span>`
      + `<button class="lf-step-btn" data-dir="1" aria-label="increase">+</button>`
      + `</span>`;
  };
  const capCell = r => {
    let s = `<span class="lf-con-cap"><span class="lf-cap-text"></span>`;
    if (r.note) s += `<span class="lf-cap-note"></span>`;
    if (r.edit) s += `<span class="lf-editors">${r.edit.map(stepper).join('')}</span>`;
    return s + `</span>`;
  };

  let html = '';
  html += `<div class="lf-section"><div class="lf-head">Sets</div><div class="lf-rows">${F.sets.map(s => `<div class="lf-row">${M(s)}</div>`).join('')}</div></div>`;
  html += `<div class="lf-section"><div class="lf-head">Decision variables</div><div class="lf-rows">${F.variables.map(v => `<div class="lf-row">${M(v)}</div>`).join('')}</div></div>`;
  html += `<div class="lf-section"><div class="lf-head">Objective</div><div class="lf-obj">${M(F.objective, 'lf-block')}</div></div>`;
  html += `<div class="lf-section"><div class="lf-head">Subject to <span class="lf-head-hint">— nudge the ± controls to edit the reasonable knobs and re-solve</span></div>`;
  F.groups.forEach(g => {
    html += `<div class="lf-group"><div class="lf-group-title">${g.title}</div>`;
    g.rows.forEach(r => { html += `<div class="lf-con">${r.cap ? capCell(r) : ''}${M(r.tex, 'lf-block')}</div>`; });
    html += `</div>`;
  });
  html += `</div>`;

  els.liveForm.innerHTML = html;
  // fill captions/notes as text (so LaTeX-looking labels never get interpreted)
  let ci = 0;
  F.groups.forEach(g => g.rows.forEach(r => {
    if (!r.cap) return;
    const cap = els.liveForm.querySelectorAll('.lf-con-cap')[ci++];
    if (!cap) return;
    cap.querySelector('.lf-cap-text').textContent = r.cap;
    if (r.note) cap.querySelector('.lf-cap-note').textContent = r.note;
  }));
  // typeset all math
  pending.forEach(([id, tex]) => {
    const el = document.getElementById(id);
    if (!el) return;
    try { katex.render(tex, el, { throwOnError: false, displayMode: true }); }
    catch (e) { el.textContent = tex; }
  });

  if (els.resetInstanceBtn) els.resetInstanceBtn.style.display = overridesActive() ? '' : 'none';
}

// ---------- Instance edits: steppers, applied repairs, reset ----------

function setInstanceOverride(kind, id, skill, newVal) {
  const o = state.cfg.overrides;
  if (kind === 'need') { (o.needs[id] = o.needs[id] || {})[skill] = newVal; }
  else if (kind === 'budget') o.budget[id] = newVal;
  else if (kind === 'sizeMin') o.sizeMin[id] = newVal;
  else if (kind === 'sizeMax') o.sizeMax[id] = newVal;
  else if (kind === 'concurrency') o.concurrency[id] = newVal;
}

// Apply one of the analysis's suggested repairs to the live model.
function applyRepair(desc) {
  if (!desc) return;
  if (desc.kind === 'toggle') {
    state.cfg[desc.flag] = desc.value;
    setUIFromState();
  } else if (desc.kind === 'mandatory') {
    state.cfg.mandatoryOverride[desc.id] = desc.value;
    setUIFromState();
  } else if (desc.kind === 'budget') {
    const proj = PROJECTS.find(p => p.id === desc.id);
    setInstanceOverride('budget', desc.id, null, effBudget(proj) + desc.delta);
  } else if (desc.kind === 'sizeMin') {
    setInstanceOverride('sizeMin', desc.id, null, desc.value);
  } else if (desc.kind === 'need') {
    const proj = PROJECTS.find(p => p.id === desc.id);
    setInstanceOverride('need', desc.id, desc.skill, Math.max(0, effNeed(proj, desc.skill) + desc.delta));
  } else if (desc.kind === 'concurrency') {
    const person = PEOPLE.find(p => p.id === desc.id);
    setInstanceOverride('concurrency', desc.id, null, effConc(person) + desc.delta);
  }
  solve();
}

function resetInstance() {
  state.cfg.overrides = { needs: {}, budget: {}, sizeMin: {}, sizeMax: {}, concurrency: {} };
  solve();
}

// ===================================================================
//  What-if sweep + SVG frontier chart
// ===================================================================

function populateSweepParams() {
  if (!els.sweepParam) return;
  const prev = els.sweepParam.value;
  const opts = Object.keys(SWEEP_SPECS)
    .filter(k => !(SWEEP_SPECS[k].softOnly && state.mode !== 'soft'))
    .map(k => `<option value="${k}">${SWEEP_SPECS[k].label}</option>`)
    .join('');
  els.sweepParam.innerHTML = opts;
  if (prev && SWEEP_SPECS[prev] && !(SWEEP_SPECS[prev].softOnly && state.mode !== 'soft')) els.sweepParam.value = prev;
}

function clearSweepChart() {
  if (!els.sweepChart) return;
  els.sweepChart.innerHTML = `<text x="360" y="130" text-anchor="middle" class="chart-hint">Pick a parameter and press “Run sweep” to trace the trade-off curve.</text>`;
  els.sweepLegend.innerHTML = '';
}

function runSweep() {
  if (state.analysisRunning) return;
  const key = els.sweepParam.value;
  const { jobs, spec } = buildSweepJobs(state.mode, state.cfg, key);
  state.analysisRunning = true;
  els.sweepBtn.disabled = true;
  els.sweepBtn.textContent = 'Sweeping…';

  runJobs(jobs,
    null,
    results => {
      const points = results.map(r => ({
        v: r.v,
        obj: r.result ? r.result.objective : null,
        short: r.result ? (r.result.shortfall || 0) : null,
      }));
      drawSweepChart(points, spec, spec.current(state.cfg));
      state.analysisRunning = false;
      els.sweepBtn.disabled = false;
      els.sweepBtn.textContent = 'Run sweep ▸';
    }
  );
}

function drawSweepChart(points, spec, currentVal) {
  const W = 720, H = 260, padL = 52, padR = 54, padT = 20, padB = 36;
  const x0 = padL, x1 = W - padR, y0 = H - padB, y1 = padT;
  const soft = state.mode === 'soft';
  const feas = points.filter(p => p.obj !== null);

  const xOf = v => x0 + (v - spec.min) / (spec.max - spec.min || 1) * (x1 - x0);
  const fmtX = v => (spec.unit === '$' ? `$${Math.round(v)}` : (Math.round(v * 10) / 10));

  if (!feas.length) {
    els.sweepChart.innerHTML = `<text x="360" y="130" text-anchor="middle" class="chart-hint">Every point in this range is infeasible.</text>`;
    return;
  }

  const objVals = feas.map(p => p.obj);
  let oMin = Math.min(...objVals), oMax = Math.max(...objVals);
  if (oMax - oMin < 1e-6) { oMax += 1; oMin -= 1; }
  const pad = (oMax - oMin) * 0.12;
  oMin -= pad; oMax += pad;
  const yObj = o => y0 - (o - oMin) / (oMax - oMin) * (y0 - y1);

  const shortMax = Math.max(1, ...feas.map(p => p.short || 0));
  const yShort = s => y0 - (s / shortMax) * (y0 - y1);

  const parts = [];
  // axes
  parts.push(`<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y0}" class="chart-axis"/>`);
  parts.push(`<line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y1}" class="chart-axis"/>`);
  // x ticks (min, mid, max)
  [spec.min, (spec.min + spec.max) / 2, spec.max].forEach(v => {
    parts.push(`<line x1="${xOf(v)}" y1="${y0}" x2="${xOf(v)}" y2="${y0 + 5}" class="chart-axis"/>`);
    parts.push(`<text x="${xOf(v)}" y="${y0 + 20}" text-anchor="middle" class="chart-tick">${fmtX(v)}</text>`);
  });
  // y ticks for objective (min, max)
  [oMin + pad, oMax - pad].forEach(o => {
    parts.push(`<text x="${x0 - 8}" y="${yObj(o) + 3}" text-anchor="end" class="chart-tick">${o.toFixed(1)}</text>`);
  });
  parts.push(`<text x="${x0 - 40}" y="${(y0 + y1) / 2}" text-anchor="middle" class="chart-axis-label" transform="rotate(-90 ${x0 - 40} ${(y0 + y1) / 2})">objective</text>`);
  parts.push(`<text x="${(x0 + x1) / 2}" y="${H - 4}" text-anchor="middle" class="chart-axis-label">${spec.label}</text>`);

  // current-value marker
  if (currentVal >= spec.min && currentVal <= spec.max) {
    parts.push(`<line x1="${xOf(currentVal)}" y1="${y1}" x2="${xOf(currentVal)}" y2="${y0}" class="chart-current"/>`);
    parts.push(`<text x="${xOf(currentVal)}" y="${y1 - 6}" text-anchor="middle" class="chart-current-label">current (${fmtX(currentVal)})</text>`);
  }

  // shortfall line (soft) — right axis, drawn under the objective line
  if (soft) {
    const segShort = [];
    feas.forEach(p => segShort.push(`${xOf(p.v).toFixed(1)},${yShort(p.short || 0).toFixed(1)}`));
    parts.push(`<polyline points="${segShort.join(' ')}" class="chart-line-short"/>`);
    feas.forEach(p => parts.push(`<circle cx="${xOf(p.v).toFixed(1)}" cy="${yShort(p.short || 0).toFixed(1)}" r="2.6" class="chart-dot-short"/>`));
    [0, shortMax].forEach(s => parts.push(`<text x="${x1 + 8}" y="${yShort(s) + 3}" text-anchor="start" class="chart-tick chart-tick-short">${s}</text>`));
    parts.push(`<text x="${x1 + 40}" y="${(y0 + y1) / 2}" text-anchor="middle" class="chart-axis-label chart-axis-short" transform="rotate(90 ${x1 + 40} ${(y0 + y1) / 2})">shortfall</text>`);
  }

  // objective line (break at infeasible gaps)
  let run = [];
  const flush = () => { if (run.length) { parts.push(`<polyline points="${run.join(' ')}" class="chart-line-obj"/>`); run = []; } };
  points.forEach(p => {
    if (p.obj === null) { flush(); return; }
    run.push(`${xOf(p.v).toFixed(1)},${yObj(p.obj).toFixed(1)}`);
  });
  flush();
  points.forEach(p => {
    if (p.obj === null) parts.push(`<text x="${xOf(p.v).toFixed(1)}" y="${y0 - 4}" text-anchor="middle" class="chart-infeas">×</text>`);
    else parts.push(`<circle cx="${xOf(p.v).toFixed(1)}" cy="${yObj(p.obj).toFixed(1)}" r="3" class="chart-dot-obj"/>`);
  });

  els.sweepChart.innerHTML = parts.join('');
  els.sweepLegend.innerHTML = `<span class="legend-item"><span class="swatch swatch-obj"></span>objective</span>`
    + (soft ? `<span class="legend-item"><span class="swatch swatch-short"></span>coverage shortfall</span>` : '')
    + `<span class="legend-item"><span class="swatch swatch-infeas">×</span>infeasible</span>`;
}

document.addEventListener('DOMContentLoaded', init);
