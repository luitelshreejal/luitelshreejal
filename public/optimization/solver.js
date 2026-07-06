// Real brute-force MILP solver over the small demo instance.
// Enumerates every binary assignment (and, in soft mode, every project-selection
// combination), keeps the best feasible incumbent, and reports proven-optimal
// once the whole search space has been exhausted. Chunked via setTimeout so the
// UI can animate progress and incumbent improvements as they're found.

const P = PEOPLE.length;
const J = PROJECTS.length;

function teamsFromBits(xBits) {
  const teams = PROJECTS.map(() => []);
  for (let i = 0; i < P; i++) {
    for (let j = 0; j < J; j++) {
      if (xBits & (1 << (i * J + j))) teams[j].push(PEOPLE[i]);
    }
  }
  return teams;
}

// Section 3.3 "skill-load control": exact bipartite max-flow between team
// members (capacity kappa each: at most kappa skills owned per project) and
// required skills (capacity = remaining headcount needed), edges only where
// the person qualifies. Flow into a skill node = how many people can be
// *attributed* to cover it under the y_ijs / kappa constraints (eqs 6-8) -
// which is <= the naive "count everyone qualified" number the base model
// uses. Since y has no cost/fit/pref term of its own, the max-flow solution
// for a fixed team is exactly the optimal y, so this is exact, not a heuristic.
function maxSkillCoverage(team, skills, needs, kappa) {
  const m = team.length, k = skills.length;
  const n = m + k + 2;
  const source = 0, sink = n - 1;
  const cap = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let p = 0; p < m; p++) cap[source][1 + p] = kappa;
  for (let s = 0; s < k; s++) cap[1 + m + s][sink] = needs[skills[s]];
  for (let p = 0; p < m; p++) {
    for (let s = 0; s < k; s++) {
      if (isQualified(team[p], skills[s])) cap[1 + p][1 + m + s] = 1;
    }
  }
  // Edmonds-Karp: repeatedly BFS for an augmenting path and saturate it.
  for (;;) {
    const parent = new Array(n).fill(-1);
    parent[source] = source;
    const queue = [source];
    for (let qi = 0; qi < queue.length; qi++) {
      const u = queue[qi];
      if (u === sink) break;
      for (let v = 0; v < n; v++) {
        if (parent[v] === -1 && cap[u][v] > 0) {
          parent[v] = u;
          queue.push(v);
        }
      }
    }
    if (parent[sink] === -1) break;
    let bottleneck = Infinity;
    for (let v = sink; v !== source; v = parent[v]) bottleneck = Math.min(bottleneck, cap[parent[v]][v]);
    for (let v = sink; v !== source; v = parent[v]) {
      cap[parent[v]][v] -= bottleneck;
      cap[v][parent[v]] += bottleneck;
    }
  }
  const covered = {};
  for (let s = 0; s < k; s++) covered[skills[s]] = needs[skills[s]] - cap[1 + m + s][sink];
  return covered;
}

function evaluateCombo(xBits, wBits, mode, cfg) {
  const teams = teamsFromBits(xBits);
  const budgetScale = cfg.budgetScale || 1;
  // Persistent instance edits (editable formulation / applied repairs).
  const ov = cfg.overrides || {};
  const budgetOf = (proj) => (ov.budget && proj.id in ov.budget) ? ov.budget[proj.id] : proj.budget * budgetScale;
  const sizeMinOf = (proj) => (ov.sizeMin && proj.id in ov.sizeMin) ? ov.sizeMin[proj.id] : proj.sizeMin;
  const sizeMaxOf = (proj) => (ov.sizeMax && proj.id in ov.sizeMax) ? ov.sizeMax[proj.id] : proj.sizeMax;
  const needOf = (proj, s) => (ov.needs && ov.needs[proj.id] && s in ov.needs[proj.id]) ? ov.needs[proj.id][s] : proj.needs[s];
  const concOf = (i) => (ov.concurrency && PEOPLE[i].id in ov.concurrency) ? ov.concurrency[PEOPLE[i].id] : PEOPLE[i].concurrency;

  const used = new Array(P).fill(0);
  for (let i = 0; i < P; i++) {
    for (let j = 0; j < J; j++) {
      if (xBits & (1 << (i * J + j))) used[i]++;
    }
  }
  for (let i = 0; i < P; i++) {
    if (used[i] > concOf(i)) return null;
  }

  let shortfallTotal = 0;
  const shortfalls = [];
  const wOut = [];

  for (let j = 0; j < J; j++) {
    const proj = PROJECTS[j];
    const w = mode === 'soft' ? (wBits >> j) & 1 : 1;
    wOut.push(w);
    const mandatory = cfg.mandatoryOverride[proj.id];
    const team = teams[j];

    if (mode === 'soft') {
      if (mandatory && !w) return null;
      if (team.length > 0 && !w) return null;
      if (w) {
        if (team.length < sizeMinOf(proj) || team.length > sizeMaxOf(proj)) return null;
        // Budget constraint (5) applies unchanged in Variant 3 (see formulation).
        const cost = team.reduce((a, p) => a + p.cost, 0);
        if (cost > budgetOf(proj)) return null;
      } else if (team.length !== 0) {
        return null;
      }
    } else {
      if (team.length < sizeMinOf(proj) || team.length > sizeMaxOf(proj)) return null;
      const cost = team.reduce((a, p) => a + p.cost, 0);
      if (cost > budgetOf(proj)) return null;
    }

    const skillsNeeded = Object.keys(proj.needs);
    const effNeeds = {};
    for (const s of skillsNeeded) effNeeds[s] = needOf(proj, s);
    const useSkillLoad = mode === 'soft' && cfg.skillLoadExt && w && team.length > 0;
    const covered = useSkillLoad ? maxSkillCoverage(team, skillsNeeded, effNeeds, cfg.kappa) : null;

    for (const s of skillsNeeded) {
      const need = effNeeds[s] * w;
      const count = useSkillLoad ? (covered[s] || 0) : team.filter(p => isQualified(p, s)).length;
      if (mode === 'hard') {
        if (count < need) return null;
      } else {
        const u = Math.max(0, need - count);
        if (u > 0) shortfalls.push({ projectId: proj.id, skill: s, amount: u });
        shortfallTotal += u;
      }
    }

    if (cfg.compatibilityExt && team.length > 1) {
      const ids = team.map(p => p.id);
      if (ids.includes(INCOMPATIBLE_PAIR[0]) && ids.includes(INCOMPATIBLE_PAIR[1])) return null;
    }

    if (cfg.diversityExt && team.length > 0) {
      const depts = {};
      for (const p of team) depts[p.dept] = (depts[p.dept] || 0) + 1;
      for (const dept in depts) {
        if (depts[dept] > DIVERSITY_RATIO * team.length + 1e-9) return null;
      }
    }
  }

  let objective = 0;
  for (let i = 0; i < P; i++) {
    for (let j = 0; j < J; j++) {
      if (xBits & (1 << (i * J + j))) {
        const person = PEOPLE[i], proj = PROJECTS[j];
        objective += cfg.alpha * FIT[person.id][proj.id]
                   + cfg.beta * PREF[person.id][proj.id]
                   - cfg.gamma * (person.cost / 100);
      }
    }
  }
  if (mode === 'soft') {
    for (let j = 0; j < J; j++) objective += PROJECTS[j].value * wOut[j];
    objective -= cfg.phi * shortfallTotal;
  }

  return { xBits, wBits, teams, wOut, shortfalls, shortfallTotal, objective };
}

// Returns a cancel() function. onProgress(fraction, incumbent) fires whenever a
// new best is found or periodically; onDone(best|null) fires once the full
// space has been searched (null means proven infeasible).
function runSolve({ mode, cfg, onProgress, onDone, chunkSize = 20000 }) {
  runSolve._token = (runSolve._token || 0) + 1;
  const token = runSolve._token;

  const xTotal = 1 << (P * J);
  const wTotal = mode === 'soft' ? (1 << J) : 1;
  const total = xTotal * wTotal;

  let idx = 0;
  let best = null, bestObj = -Infinity;

  function step() {
    if (token !== runSolve._token) return;
    let count = 0;
    while (idx < total && count < chunkSize) {
      const w = mode === 'soft' ? Math.floor(idx / xTotal) : 0;
      const x = mode === 'soft' ? idx % xTotal : idx;
      const res = evaluateCombo(x, w, mode, cfg);
      if (res && res.objective > bestObj) {
        bestObj = res.objective;
        best = res;
        if (onProgress) {
          try { onProgress(idx / total, best); }
          catch (err) { console.error('onProgress handler failed:', err && err.name, err && err.message, err && err.stack); }
        }
      }
      idx++;
      count++;
    }
    if (idx < total) {
      setTimeout(step, 0);
    } else {
      if (onDone) {
        try { onDone(best); }
        catch (err) { console.error('onDone handler failed:', err); }
      }
    }
  }
  step();

  return () => { if (token === runSolve._token) runSolve._token++; };
}
