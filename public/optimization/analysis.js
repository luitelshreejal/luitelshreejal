// Analysis layer that sits on top of the demo instance in data.js.
//
// The animated brute-force enumerator in solver.js is the "hero" solve the
// user watches. The features here — explainability, shadow prices, minimal
// infeasibility repairs, and what-if sweeps — all need the *same* problem
// re-solved many times with one parameter perturbed. So this file carries a
// second, allocation-free enumerator (`solveFast`) that produces bit-for-bit
// the same optimum as `evaluateCombo`, fast enough to run a few dozen times
// without a build step or a web worker.
//
// Everything here is pure (no DOM). app.js drives it and renders the results.

const A = (() => {
  const P = PEOPLE.length;
  const J = PROJECTS.length;
  const S = SKILLS.length;

  // ---- static, instance-level precompute (never changes) ----
  const skillIndex = Object.fromEntries(SKILLS.map((s, k) => [s, k]));
  const deptNames = [...new Set(PEOPLE.map(p => p.dept))];
  const deptIndex = Object.fromEntries(deptNames.map((d, k) => [d, k]));
  const D = deptNames.length;

  const costI = PEOPLE.map(p => p.cost);
  const concurI = PEOPLE.map(p => p.concurrency);
  const deptOf = PEOPLE.map(p => deptIndex[p.dept]);

  // qual[i*S + s] === 1  iff person i is qualified in skill s
  const qual = new Uint8Array(P * S);
  for (let i = 0; i < P; i++) {
    for (let s = 0; s < S; s++) qual[i * S + s] = isQualified(PEOPLE[i], SKILLS[s]) ? 1 : 0;
  }

  // per-project needed-skill lists (skill index + required headcount)
  const needIdx = PROJECTS.map(p => Object.keys(p.needs).map(s => skillIndex[s]));
  const needCnt = PROJECTS.map(p => Object.keys(p.needs).map(s => p.needs[s]));
  const valueJ = PROJECTS.map(p => p.value);

  const pairA = PEOPLE.findIndex(p => p.id === INCOMPATIBLE_PAIR[0]);
  const pairB = PEOPLE.findIndex(p => p.id === INCOMPATIBLE_PAIR[1]);

  const fitArr = new Float64Array(P * J);
  const prefArr = new Float64Array(P * J);
  for (let i = 0; i < P; i++) {
    for (let j = 0; j < J; j++) {
      fitArr[i * J + j] = FIT[PEOPLE[i].id][PROJECTS[j].id];
      prefArr[i * J + j] = PREF[PEOPLE[i].id][PROJECTS[j].id];
    }
  }

  // Resolve a cfg (plus optional overrides `ov`) into flat arrays the hot loop
  // can read without any object property lookups.
  function resolve(cfg, ov = {}) {
    const coeff = new Float64Array(P * J);
    for (let i = 0; i < P; i++) {
      for (let j = 0; j < J; j++) {
        coeff[i * J + j] = cfg.alpha * fitArr[i * J + j]
                         + cfg.beta * prefArr[i * J + j]
                         - cfg.gamma * (costI[i] / 100);
      }
    }
    // Two layers of overrides feed every effective parameter:
    //   - obc = cfg.overrides: persistent user edits (from the editable
    //     formulation / applied repairs) — part of the scenario itself.
    //   - ov = per-call probe override (sensitivity / repair experiments).
    // ov wins over obc wins over the base instance in data.js.
    const obc = cfg.overrides || {};
    const pick = (map, id, base) => (map && id in map ? map[id] : base);
    return {
      coeff,
      phi: cfg.phi,
      kappa: cfg.kappa,
      compat: cfg.compatibilityExt && !ov.disableCompat,
      diversity: cfg.diversityExt && !ov.disableDiversity,
      skillLoad: !!cfg.skillLoadExt,
      budget: PROJECTS.map(p => pick(ov.budgetOf, p.id, pick(obc.budget, p.id, p.budget * (cfg.budgetScale || 1))) + (ov.budgetDelta || 0)),
      sizeMin: PROJECTS.map(p => pick(ov.sizeMinOf, p.id, pick(obc.sizeMin, p.id, p.sizeMin))),
      sizeMax: PROJECTS.map(p => pick(ov.sizeMaxOf, p.id, pick(obc.sizeMax, p.id, p.sizeMax))),
      concur: PEOPLE.map(p => pick(ov.concurrencyOf, p.id, pick(obc.concurrency, p.id, p.concurrency))),
      mandatory: PROJECTS.map(p => pick(ov.mandatoryOf, p.id, cfg.mandatoryOverride[p.id])),
      // per-project, per-needed-skill headcount requirement (n_js)
      needCnt: PROJECTS.map((p, j) => needIdx[j].map((s, t) => {
        const skill = SKILLS[s];
        const ovNeed = ov.needOf && ov.needOf[p.id];
        if (ovNeed && skill in ovNeed) return ovNeed[skill];
        const obcNeed = obc.needs && obc.needs[p.id];
        return obcNeed && skill in obcNeed ? obcNeed[skill] : needCnt[j][t];
      })),
    };
  }

  // scratch reused across every evaluation (no per-iteration allocation)
  const teamCount = new Int32Array(J);
  const teamCost = new Int32Array(J);
  const usedCount = new Int32Array(P);
  const skc = new Int32Array(J * S);       // qualified count per project/skill
  const deptCount = new Int32Array(J * D);

  // Evaluate one (x, w) combination against a resolved scenario `sc`.
  // Returns { objective, shortfall } or null if infeasible — identical
  // semantics to evaluateCombo() in solver.js.
  function evalFast(xBits, wBits, mode, sc) {
    teamCount.fill(0); teamCost.fill(0); usedCount.fill(0);
    skc.fill(0); deptCount.fill(0);

    let obj = 0;
    for (let i = 0; i < P; i++) {
      const base = i * J;
      for (let j = 0; j < J; j++) {
        if (xBits & (1 << (base + j))) {
          usedCount[i]++;
          if (usedCount[i] > sc.concur[i]) return null;
          teamCount[j]++;
          teamCost[j] += costI[i];
          deptCount[j * D + deptOf[i]]++;
          for (let s = 0; s < S; s++) if (qual[i * S + s]) skc[j * S + s]++;
          obj += sc.coeff[base + j];
        }
      }
    }

    let shortfall = 0;
    for (let j = 0; j < J; j++) {
      const w = mode === 'soft' ? (wBits >> j) & 1 : 1;
      const size = teamCount[j];

      if (mode === 'soft') {
        if (sc.mandatory[j] && !w) return null;
        if (size > 0 && !w) return null;
        if (w) {
          if (size < sc.sizeMin[j] || size > sc.sizeMax[j]) return null;
          if (teamCost[j] > sc.budget[j]) return null;
        }
      } else {
        if (size < sc.sizeMin[j] || size > sc.sizeMax[j]) return null;
        if (teamCost[j] > sc.budget[j]) return null;
      }

      // skill-load control replaces the naive qualified-count with an exact
      // attributed coverage (max-flow) — rare, so we drop to the slow path.
      let covered = null;
      if (mode === 'soft' && sc.skillLoad && w && size > 0) {
        const team = [];
        for (let i = 0; i < P; i++) if (xBits & (1 << (i * J + j))) team.push(PEOPLE[i]);
        const proj = PROJECTS[j];
        // use the effective (possibly overridden) headcounts, not the base ones
        const effNeeds = {};
        needIdx[j].forEach((s, t) => { effNeeds[SKILLS[s]] = sc.needCnt[j][t]; });
        covered = maxSkillCoverage(team, Object.keys(proj.needs), effNeeds, sc.kappa);
      }

      const nk = needIdx[j].length;
      for (let t = 0; t < nk; t++) {
        const s = needIdx[j][t];
        const need = sc.needCnt[j][t] * w;
        const count = covered ? (covered[SKILLS[s]] || 0) : skc[j * S + s];
        if (mode === 'soft') {
          if (need - count > 0) shortfall += need - count;
        } else if (count < need) {
          return null;
        }
      }

      if (sc.compat && size > 1 && pairA >= 0 && pairB >= 0) {
        if ((xBits & (1 << (pairA * J + j))) && (xBits & (1 << (pairB * J + j)))) return null;
      }
      if (sc.diversity && size > 0) {
        for (let d = 0; d < D; d++) {
          if (deptCount[j * D + d] > DIVERSITY_RATIO * size + 1e-9) return null;
        }
      }
    }

    if (mode === 'soft') {
      for (let j = 0; j < J; j++) obj += valueJ[j] * ((wBits >> j) & 1);
      obj -= sc.phi * shortfall;
    }
    return { objective: obj, shortfall };
  }

  // Full enumeration; returns the proven-optimal incumbent or null (infeasible).
  // Same search as solver.js, but two exact prunings collapse the soft-mode
  // space from 2^(P·J+J) to roughly 2^(P·J): skip any project-selection wBits
  // that leaves a mandatory project unstaffed, and — for a fixed wBits — skip
  // any assignment that puts someone on an unselected project (which is always
  // infeasible), via one AND against a precomputed forbidden-bit mask.
  function solveFast(mode, cfg, ov = {}) {
    const sc = resolve(cfg, ov);
    const xTotal = 1 << (P * J);
    let best = null, bestObj = -Infinity;
    const keep = (x, w, r) => {
      if (r && r.objective > bestObj + 1e-12) {
        bestObj = r.objective;
        best = { xBits: x, wBits: w, objective: r.objective, shortfall: r.shortfall };
      }
    };

    if (mode === 'hard') {
      for (let x = 0; x < xTotal; x++) keep(x, 0, evalFast(x, 0, 'hard', sc));
      return best;
    }

    for (let w = 0; w < (1 << J); w++) {
      let bad = false, forbidden = 0;
      for (let j = 0; j < J; j++) {
        if ((w >> j) & 1) continue;
        if (sc.mandatory[j]) { bad = true; break; }
        for (let i = 0; i < P; i++) forbidden |= 1 << (i * J + j);
      }
      if (bad) continue;
      for (let x = 0; x < xTotal; x++) {
        if (x & forbidden) continue;
        keep(x, w, evalFast(x, w, 'soft', sc));
      }
    }
    return best;
  }

  // ---- helpers that read a solved assignment ----
  function teamsOf(xBits) {
    const teams = PROJECTS.map(() => []);
    for (let i = 0; i < P; i++) {
      for (let j = 0; j < J; j++) if (xBits & (1 << (i * J + j))) teams[j].push(i);
    }
    return teams;
  }
  function usedOf(xBits) {
    const u = new Array(P).fill(0);
    for (let i = 0; i < P; i++) for (let j = 0; j < J; j++) if (xBits & (1 << (i * J + j))) u[i]++;
    return u;
  }

  return {
    P, J, S, deptNames, pairA, pairB, needIdx, needCnt,
    resolve, evalFast, solveFast, teamsOf, usedOf, skillIndex,
  };
})();

// ---------------------------------------------------------------------------
// Explainability: why the plan looks the way it does.
// ---------------------------------------------------------------------------

// For every person the optimum leaves with spare capacity, give the single
// most informative reason they weren't added to some project — a hard block
// (size / budget / conflict / diversity) or "no net gain because the skill
// they'd bring is already covered / their cost outweighs their fit".
function explainAssignments(best, mode, cfg) {
  if (!best) return [];
  const { P, J, teamsOf, usedOf, resolve, evalFast, needIdx, needCnt } = A;
  const sc = resolve(cfg);
  const teams = teamsOf(best.xBits);
  const used = usedOf(best.xBits);
  const out = [];

  for (let i = 0; i < P; i++) {
    if (used[i] >= PEOPLE[i].concurrency) continue; // no spare capacity to explain
    const candidates = [];

    for (let j = 0; j < J; j++) {
      if (best.xBits & (1 << (i * J + j))) continue;          // already on it
      const w = mode === 'soft' ? (best.wBits >> j) & 1 : 1;
      if (!w) continue;                                        // project not staffed at all

      const team = teams[j];
      const proj = PROJECTS[j];

      // ---- hard blocks, in the order a planner would hit them ----
      if (team.length + 1 > sc.sizeMax[j]) {
        candidates.push({ j, sev: 3, text: `${proj.name} is already at its team-size cap (${sc.sizeMax[j]})` });
        continue;
      }
      if (team.reduce((a, p) => a + PEOPLE[p].cost, 0) + PEOPLE[i].cost > sc.budget[j]) {
        candidates.push({ j, sev: 3, text: `adding them would break ${proj.name}'s $${sc.budget[j]} budget` });
        continue;
      }
      if (sc.compat && ((i === A.pairA && team.includes(A.pairB)) || (i === A.pairB && team.includes(A.pairA)))) {
        const otherIdx = i === A.pairA ? A.pairB : A.pairA;
        candidates.push({ j, sev: 3, text: `they conflict with ${PEOPLE[otherIdx].name}, already on ${proj.name}` });
        continue;
      }
      if (sc.diversity) {
        const depts = {};
        for (const p of team) depts[PEOPLE[p].dept] = (depts[PEOPLE[p].dept] || 0) + 1;
        depts[PEOPLE[i].dept] = (depts[PEOPLE[i].dept] || 0) + 1;
        const size = team.length + 1;
        if (Object.values(depts).some(c => c > DIVERSITY_RATIO * size + 1e-9)) {
          candidates.push({ j, sev: 3, text: `it would breach ${proj.name}'s department-diversity cap` });
          continue;
        }
      }

      // ---- feasible to add: so the optimizer chose not to. Why? ----
      const forced = best.xBits | (1 << (i * J + j));
      const r = evalFast(forced, best.wBits, mode, sc);
      const delta = r ? r.objective - best.objective : -Infinity;

      // do they bring a skill that's already fully covered?
      let redundantSkill = null;
      for (let t = 0; t < needIdx[j].length; t++) {
        const s = needIdx[j][t];
        if (qualifiedIdx(i, s)) {
          const have = team.filter(p => qualifiedIdx(p, s)).length;
          if (have >= needCnt[j][t]) { redundantSkill = SKILLS[s]; break; }
        }
      }
      if (delta <= 1e-9) {
        const why = redundantSkill
          ? `${SKILL_LABEL[redundantSkill]} on ${proj.name} is already covered — adding ${PEOPLE[i].name} only adds $${PEOPLE[i].cost}/day`
          : `their fit + preference on ${proj.name} doesn't outweigh the $${PEOPLE[i].cost}/day they'd add`;
        candidates.push({ j, sev: 1, delta, text: why });
      } else {
        // Feasible AND improving but not taken — only possible if capacity/other
        // coupling elsewhere blocks it; rare, note it plainly.
        candidates.push({ j, sev: 2, delta, text: `assigning them to ${proj.name} is blocked by a constraint elsewhere in the plan` });
      }
    }

    if (!candidates.length) continue;
    // prefer the most "interesting" reason: a hard block over a no-gain note,
    // and among no-gain notes, the project they came closest on.
    candidates.sort((a, b) => (b.sev - a.sev) || ((b.delta ?? -1e9) - (a.delta ?? -1e9)));
    out.push({ person: PEOPLE[i].name, personId: PEOPLE[i].id, reason: candidates[0].text });
  }
  return out;
}

function qualifiedIdx(i, s) { return isQualified(PEOPLE[i], SKILLS[s]); }

// ---------------------------------------------------------------------------
// Shadow prices (finite-difference duals) + minimal infeasibility repairs.
// Both are batteries of full re-solves, so they run through a yielding
// scheduler (see runJobs in app.js) rather than blocking the main thread.
// ---------------------------------------------------------------------------

// Build the list of "relax this one thing by a step" experiments. Each job
// returns a labelled probe result; app.js turns positive ones into
// shadow-price rows and feasibility-restoring ones into repair suggestions.
function buildProbeJobs(mode, cfg, base) {
  const jobs = [];
  const baseObj = base ? base.objective : -Infinity;
  const baseShort = base ? (base.shortfall || 0) : Infinity;

  // Budget shadow price + repair: bump each project's (effective) budget.
  const effBudget = proj => proj.budget * (cfg.budgetScale || 1);
  for (const proj of PROJECTS) {
    for (const step of [25, 50, 100]) {
      jobs.push({
        kind: 'budget', proj: proj.id, step,
        run: () => A.solveFast(mode, cfg, { budgetOf: { [proj.id]: effBudget(proj) + step } }),
      });
    }
  }
  // Team-size floor: relaxing the minimum by 1.
  for (const proj of PROJECTS) {
    if (proj.sizeMin <= 1) continue;
    jobs.push({
      kind: 'sizeMin', proj: proj.id, step: 1,
      run: () => A.solveFast(mode, cfg, { sizeMinOf: { [proj.id]: proj.sizeMin - 1 } }),
    });
  }
  // Coverage requirement: dropping one required head off a skill (n_js − 1) —
  // this is exactly the gap Soft coverage prices instead of forbidding, so it's
  // the honest repair for a hard-infeasible instance.
  for (const proj of PROJECTS) {
    for (const s of Object.keys(proj.needs)) {
      if (proj.needs[s] < 1) continue;
      jobs.push({
        kind: 'coverage', proj: proj.id, skill: s,
        run: () => A.solveFast(mode, cfg, { needOf: { [proj.id]: { [s]: proj.needs[s] - 1 } } }),
      });
    }
  }
  // Concurrency: letting one person take a second project.
  const obc = cfg.overrides || {};
  const effConc = id => (obc.concurrency && id in obc.concurrency ? obc.concurrency[id] : PEOPLE.find(p => p.id === id).concurrency);
  for (const person of PEOPLE) {
    jobs.push({
      kind: 'concurrency', person: person.id,
      run: () => A.solveFast(mode, cfg, { concurrencyOf: { [person.id]: effConc(person.id) + 1 } }),
    });
  }
  // Turning off each active extension module.
  if (cfg.diversityExt) jobs.push({ kind: 'diversity', run: () => A.solveFast(mode, cfg, { disableDiversity: true }) });
  if (cfg.compatibilityExt) jobs.push({ kind: 'compat', run: () => A.solveFast(mode, cfg, { disableCompat: true }) });
  // Making each mandatory project optional (soft mode only).
  if (mode === 'soft') {
    for (const proj of PROJECTS) {
      if (cfg.mandatoryOverride[proj.id]) {
        jobs.push({ kind: 'unmandate', proj: proj.id, run: () => A.solveFast(mode, cfg, { mandatoryOf: { [proj.id]: false } }) });
      }
    }
  }

  return { jobs, baseObj, baseShort };
}

// Turn completed probe results into the two rendered lists.
function summarizeProbes(results, mode, base) {
  const infeasible = !base;
  const baseObj = base ? base.objective : -Infinity;
  const baseShort = base ? (base.shortfall || 0) : Infinity;
  const projName = id => PROJECTS.find(p => p.id === id).name;

  const shadow = [];   // binding constraints with a marginal value
  const repairs = [];  // single relaxations that fix / improve things

  // keep only the smallest budget step that helps, per project
  const bestBudget = {};
  for (const r of results) {
    if (r.kind !== 'budget' || !r.result) continue;
    const improved = r.result.objective - baseObj;
    const closes = infeasible ? true : (r.result.shortfall || 0) < baseShort;
    if ((infeasible && r.result) || improved > 1e-6 || closes) {
      if (!bestBudget[r.proj] || r.step < bestBudget[r.proj].step) bestBudget[r.proj] = r;
    }
  }

  for (const proj in bestBudget) {
    const r = bestBudget[proj];
    const improved = r.result.objective - baseObj;
    if (!infeasible && improved > 1e-6) {
      shadow.push({ label: `${projName(proj)} budget`, detail: `+ $${r.step} → objective ${improved >= 0 ? '+' : ''}${improved.toFixed(2)}` });
    }
    repairs.push({
      label: `Add $${r.step} to ${projName(proj)}'s budget`,
      effect: infeasible ? 'restores a feasible plan' : `objective ${improved >= 0 ? '+' : ''}${improved.toFixed(2)}`,
      apply: { kind: 'budget', id: proj, delta: r.step },
    });
  }

  for (const r of results) {
    if (!r.result) continue;
    const improved = r.result.objective - baseObj;
    const closes = infeasible || (r.result.shortfall || 0) < baseShort || improved > 1e-6;
    if (r.kind === 'sizeMin' && closes) {
      const target = PROJECTS.find(p => p.id === r.proj).sizeMin - 1;
      if (!infeasible && improved > 1e-6) shadow.push({ label: `${projName(r.proj)} min team size`, detail: `−1 → objective +${improved.toFixed(2)}` });
      repairs.push({ label: `Lower ${projName(r.proj)}'s minimum team size to ${target}`, effect: infeasible ? 'restores a feasible plan' : `objective ${improved >= 0 ? '+' : ''}${improved.toFixed(2)}`, apply: { kind: 'sizeMin', id: r.proj, value: target } });
    }
    if (r.kind === 'diversity' && closes) {
      repairs.push({ label: 'Disable the Diversity-ratio module', effect: infeasible ? 'restores a feasible plan' : `objective +${improved.toFixed(2)}`, apply: { kind: 'toggle', flag: 'diversityExt', value: false } });
    }
    if (r.kind === 'compat' && closes) {
      repairs.push({ label: 'Disable the Compatibility module', effect: infeasible ? 'restores a feasible plan' : `objective +${improved.toFixed(2)}`, apply: { kind: 'toggle', flag: 'compatibilityExt', value: false } });
    }
    if (r.kind === 'unmandate' && closes) {
      repairs.push({ label: `Make ${projName(r.proj)} optional (free wⱼ)`, effect: infeasible ? 'restores a feasible plan' : `objective +${improved.toFixed(2)}`, apply: { kind: 'mandatory', id: r.proj, value: false } });
    }
    if (r.kind === 'coverage' && closes) {
      repairs.push({ label: `Drop ${projName(r.proj)}'s ${SKILL_LABEL[r.skill]} requirement by one head`, effect: infeasible ? 'restores a feasible plan (or switch to Soft coverage, which prices this gap)' : `objective +${improved.toFixed(2)}`, apply: { kind: 'need', id: r.proj, skill: r.skill, delta: -1 } });
    }
    if (r.kind === 'concurrency' && closes) {
      const nm = PEOPLE.find(p => p.id === r.person).name;
      repairs.push({ label: `Let ${nm} take a second concurrent project`, effect: infeasible ? 'restores a feasible plan' : `objective +${improved.toFixed(2)}`, apply: { kind: 'concurrency', id: r.person, delta: 1 } });
    }
  }

  return { shadow, repairs, infeasible };
}

// ---------------------------------------------------------------------------
// What-if sweeps: re-solve across a range of one parameter and return the
// objective (and, in soft mode, the coverage shortfall) at each step — the
// cost/coverage trade-off frontier.
// ---------------------------------------------------------------------------

const SWEEP_SPECS = {
  budget: { label: 'Budget (all projects)', unit: '$', min: 150, max: 420, step: 30, apply: (cfg, v) => [cfg, { budgetOf: Object.fromEntries(PROJECTS.map(p => [p.id, v])) }], current: cfg => PROJECTS[0].budget * (cfg.budgetScale || 1) },
  gamma:  { label: 'γ · cost weight',        unit: '',  min: 0,   max: 2,   step: 0.2, apply: (cfg, v) => [{ ...cfg, gamma: v }, {}], current: cfg => cfg.gamma },
  alpha:  { label: 'α · fit weight',         unit: '',  min: 0,   max: 2,   step: 0.2, apply: (cfg, v) => [{ ...cfg, alpha: v }, {}], current: cfg => cfg.alpha },
  beta:   { label: 'β · preference weight',  unit: '',  min: 0,   max: 2,   step: 0.2, apply: (cfg, v) => [{ ...cfg, beta: v }, {}], current: cfg => cfg.beta },
  phi:    { label: 'φ · shortfall penalty',  unit: '',  min: 0,   max: 10,  step: 1,   apply: (cfg, v) => [{ ...cfg, phi: v }, {}], current: cfg => cfg.phi, softOnly: true },
};

function buildSweepJobs(mode, cfg, key) {
  const spec = SWEEP_SPECS[key];
  const jobs = [];
  for (let v = spec.min; v <= spec.max + 1e-9; v += spec.step) {
    const vv = Math.round(v * 1000) / 1000;
    jobs.push({
      v: vv,
      run: () => {
        const [c, ov] = spec.apply(cfg, vv);
        return A.solveFast(mode, c, ov);
      },
    });
  }
  return { jobs, spec };
}

// ---------------------------------------------------------------------------
// Instantiated ("personalized") formulation: the abstract MILP written out
// for THIS instance — every x_ij carries its real person/project, every
// coefficient is the current numeric value, every constraint is enumerated
// over the actual people, projects, and skills. Rebuilt on each solve so it
// tracks the sliders, toggles, mode, and budget scale live. Returns LaTeX
// strings only (app.js renders them with KaTeX). Covers both variants.
// ---------------------------------------------------------------------------

function instFormulation(mode, cfg) {
  const soft = mode === 'soft';
  const bs = cfg.budgetScale || 1;
  const TN = s => `\\text{${s}}`;
  const xv = (p, pr) => `x_{${TN(p.name)},\\,${TN(pr.name)}}`;
  const wv = pr => `w_{${TN(pr.name)}}`;
  const uv = (pr, s) => `u_{${TN(pr.name)},\\,${TN(SKILL_LABEL[s])}}`;
  const P = PEOPLE.length, J = PROJECTS.length;

  // effective (post-override) parameter getters — the numbers actually solved,
  // and the ones the editable steppers in the formulation read/write.
  const obc = cfg.overrides || {};
  const eNeed = (pr, s) => (obc.needs && obc.needs[pr.id] && s in obc.needs[pr.id]) ? obc.needs[pr.id][s] : pr.needs[s];
  const eBudget = pr => (obc.budget && pr.id in obc.budget) ? obc.budget[pr.id] : Math.round(pr.budget * bs);
  const eMin = pr => (obc.sizeMin && pr.id in obc.sizeMin) ? obc.sizeMin[pr.id] : pr.sizeMin;
  const eMax = pr => (obc.sizeMax && pr.id in obc.sizeMax) ? obc.sizeMax[pr.id] : pr.sizeMax;
  const eConc = p => (obc.concurrency && p.id in obc.concurrency) ? obc.concurrency[p.id] : p.concurrency;

  // ---- sets ----
  const sets = [
    `I = \\{\\, ${PEOPLE.map(p => TN(p.name)).join(',\\ ')} \\,\\}`,
    `J = \\{\\, ${PROJECTS.map(p => TN(p.name)).join(',\\ ')} \\,\\}`,
    `S = \\{\\, ${SKILLS.map(s => TN(SKILL_LABEL[s])).join(',\\ ')} \\,\\}`,
  ];

  // ---- decision variables ----
  const uList = [];
  PROJECTS.forEach(pr => Object.keys(pr.needs).forEach(s => uList.push(uv(pr, s))));
  const variables = [`x_{i,j} \\in \\{0,1\\} \\quad \\forall\\, i \\in I,\\ j \\in J \\;\\;(${P * J}\\text{ variables})`];
  if (soft) {
    variables.push(`w_{j} \\in \\{0,1\\} \\quad \\forall\\, j \\in J`);
    variables.push(`${uList.join(',\\ ')} \\;\\ge\\; 0`);
  }

  // ---- objective (numeric coefficients, grouped per project) ----
  const innerSum = pr => {
    let out = '';
    PEOPLE.forEach((p, i) => {
      const coef = cfg.alpha * FIT[p.id][pr.id] + cfg.beta * PREF[p.id][pr.id] - cfg.gamma * (p.cost / 100);
      const term = `${Math.abs(coef).toFixed(2)}\\,${xv(p, pr)}`;
      out += i === 0 ? (coef < 0 ? '-\\,' : '') + term : (coef < 0 ? ' - ' : ' + ') + term;
    });
    return out;
  };
  const groups = PROJECTS.map(pr => `\\underbrace{\\big( ${innerSum(pr)} \\big)}_{${TN(pr.name)}}`);
  const bodyLines = [];
  if (soft) {
    bodyLines.push(PROJECTS.map(pr => `${pr.value}\\,${wv(pr)}`).join(' + '));
    groups.forEach(g => bodyLines.push('{}+\\; ' + g));
    bodyLines.push(`{}-\\; ${cfg.phi.toFixed(1)}\\big( ${uList.join(' + ')} \\big)`);
  } else {
    bodyLines.push(groups[0]);
    for (let k = 1; k < groups.length; k++) bodyLines.push('{}+\\; ' + groups[k]);
  }
  const objective = '\\begin{aligned}\n' +
    bodyLines.map((l, i) => (i === 0 ? '\\max\\quad & ' : '& ') + l).join(' \\\\\n') +
    '\n\\end{aligned}';

  // ---- constraints, enumerated ----
  const cgroups = [];

  const covRows = [];
  PROJECTS.forEach(pr => Object.keys(pr.needs).forEach(s => {
    const need = eNeed(pr, s);
    const quals = PEOPLE.filter(p => isQualified(p, s));
    const lhs = quals.map(p => xv(p, pr)).join(' + ') || '0';
    const rhs = soft ? `${need}\\,${wv(pr)} - ${uv(pr, s)}` : `${need}`;
    covRows.push({
      cap: `${pr.name} · ${SKILL_LABEL[s]}`, note: `prof ≥ ${THRESHOLD}, ${quals.length} qualified`,
      tex: `${lhs} \\;\\ge\\; ${rhs}`,
      edit: [{ kind: 'need', id: pr.id, skill: s, label: 'needs', value: need, base: pr.needs[s], min: 0, max: quals.length, step: 1 }],
    });
  }));
  cgroups.push({ title: 'Skill coverage', rows: covRows });

  cgroups.push({
    title: 'Team size', rows: PROJECTS.map(pr => {
      const mid = PEOPLE.map(p => xv(p, pr)).join(' + ');
      const lo = soft ? `${eMin(pr)}\\,${wv(pr)}` : `${eMin(pr)}`;
      const hi = soft ? `${eMax(pr)}\\,${wv(pr)}` : `${eMax(pr)}`;
      return {
        cap: pr.name, tex: `${lo} \\;\\le\\; ${mid} \\;\\le\\; ${hi}`,
        edit: [
          { kind: 'sizeMin', id: pr.id, label: 'min', value: eMin(pr), base: pr.sizeMin, min: 1, max: P, step: 1 },
          { kind: 'sizeMax', id: pr.id, label: 'max', value: eMax(pr), base: pr.sizeMax, min: 1, max: P, step: 1 },
        ],
      };
    })
  });

  cgroups.push({
    title: 'Concurrency', rows: PEOPLE.map(p => ({
      cap: p.name,
      tex: `${PROJECTS.map(pr => xv(p, pr)).join(' + ')} \\;\\le\\; ${eConc(p)}`,
      edit: [{ kind: 'concurrency', id: p.id, label: 'max projects', value: eConc(p), base: p.concurrency, min: 1, max: J, step: 1 }],
    }))
  });

  cgroups.push({
    title: 'Budget', rows: PROJECTS.map(pr => {
      const b = eBudget(pr);
      return {
        cap: `${pr.name}${(obc.budget && pr.id in obc.budget) ? '' : (bs !== 1 ? ` (×${bs})` : '')}`,
        tex: `${PEOPLE.map(p => `${p.cost}\\,${xv(p, pr)}`).join(' + ')} \\;\\le\\; ${b}`,
        edit: [{ kind: 'budget', id: pr.id, label: '$', value: b, base: Math.round(pr.budget * bs), min: 0, max: 900, step: 5 }],
      };
    })
  });

  if (soft) {
    cgroups.push({ title: 'Selection (membership)', rows: PROJECTS.map(pr => ({ cap: pr.name, tex: `x_{i,\\,${TN(pr.name)}} \\le ${wv(pr)} \\quad \\forall\\, i \\in I` })) });
    const mand = PROJECTS.filter(pr => cfg.mandatoryOverride[pr.id]);
    if (mand.length) cgroups.push({ title: 'Mandatory', rows: [{ cap: 'must be staffed', tex: mand.map(pr => `${wv(pr)} = 1`).join(', \\quad ') }] });
  }

  if (cfg.compatibilityExt) {
    const a = PEOPLE.find(p => p.id === INCOMPATIBLE_PAIR[0]);
    const b = PEOPLE.find(p => p.id === INCOMPATIBLE_PAIR[1]);
    cgroups.push({ title: `Compatibility — ${a.name} & ${b.name}`, rows: PROJECTS.map(pr => ({ cap: pr.name, tex: `${xv(a, pr)} + ${xv(b, pr)} \\;\\le\\; 1` })) });
  }
  if (cfg.diversityExt) {
    const depts = [...new Set(PEOPLE.map(p => p.dept))];
    const rows = [];
    PROJECTS.forEach(pr => depts.forEach(d => {
      const inDept = PEOPLE.filter(p => p.dept === d);
      rows.push({ cap: `${pr.name} · ${d}`, tex: `${inDept.map(p => xv(p, pr)).join(' + ')} \\;\\le\\; ${DIVERSITY_RATIO}\\big( ${PEOPLE.map(p => xv(p, pr)).join(' + ')} \\big)` });
    }));
    cgroups.push({ title: `Diversity ratio — ρ = ${DIVERSITY_RATIO}`, rows });
  }
  if (cfg.skillLoadExt && soft) {
    cgroups.push({
      title: `Skill-load control — κ = ${cfg.kappa}`, rows: [
        { cap: 'designate ≥ n to cover', tex: `\\sum_{i \\in Q_{js}} y_{i,j,s} \\;\\ge\\; n_{js}\\,w_j` },
        { cap: 'only if assigned', tex: `y_{i,j,s} \\;\\le\\; x_{i,j}` },
        { cap: 'cap owned per person', tex: `\\sum_{s} y_{i,j,s} \\;\\le\\; ${cfg.kappa}` },
      ]
    });
  }

  return { sets, variables, objective, groups: cgroups };
}
