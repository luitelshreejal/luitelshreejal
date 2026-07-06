// Scenario data for the People → Projects assignment demo.
// Mirrors the example on slide 3 of the deck (Python / Design / Client mgmt).

const THRESHOLD = 2; // proficiency >= THRESHOLD counts as "qualified" for a skill (Q_js)

const SKILLS = ['python', 'design', 'clientmgmt'];
const SKILL_LABEL = { python: 'Python', design: 'Design', clientmgmt: 'Client mgmt' };

const PEOPLE = [
  { id: 'alice', name: 'Alice', prof: { python: 3, design: 0, clientmgmt: 1 }, cost: 90,  concurrency: 1, dept: 'Engineering' },
  { id: 'ben',   name: 'Ben',   prof: { python: 0, design: 3, clientmgmt: 1 }, cost: 85,  concurrency: 1, dept: 'Studio' },
  { id: 'chen',  name: 'Chen',  prof: { python: 2, design: 0, clientmgmt: 2 }, cost: 95,  concurrency: 1, dept: 'Engineering' },
  { id: 'dana',  name: 'Dana',  prof: { python: 0, design: 2, clientmgmt: 3 }, cost: 100, concurrency: 1, dept: 'Studio' },
  { id: 'eli',   name: 'Eli',   prof: { python: 3, design: 0, clientmgmt: 2 }, cost: 105, concurrency: 1, dept: 'Engineering' },
  { id: 'farah', name: 'Farah', prof: { python: 1, design: 2, clientmgmt: 0 }, cost: 80,  concurrency: 1, dept: 'Studio' },
];

// pref_ij: hand-authored preference score in [0,1], person i for project j
const PREF = {
  alice: { atlas: 0.9, nimbus: 0.3, ledger: 0.4 },
  ben:   { atlas: 0.2, nimbus: 0.9, ledger: 0.5 },
  chen:  { atlas: 0.6, nimbus: 0.4, ledger: 0.8 },
  dana:  { atlas: 0.3, nimbus: 0.5, ledger: 0.9 },
  eli:   { atlas: 0.8, nimbus: 0.3, ledger: 0.6 },
  farah: { atlas: 0.4, nimbus: 0.7, ledger: 0.6 },
};

const PROJECTS = [
  { id: 'atlas',  name: 'Atlas',  blurb: 'Data platform rebuild',   needs: { python: 2, clientmgmt: 1 }, sizeMin: 2, sizeMax: 3, budget: 300, value: 8, mandatory: true },
  { id: 'nimbus', name: 'Nimbus', blurb: 'Brand & product design',  needs: { design: 2, python: 1 },     sizeMin: 2, sizeMax: 3, budget: 300, value: 6, mandatory: true },
  { id: 'ledger', name: 'Ledger', blurb: 'Client migration',        needs: { clientmgmt: 2, design: 1 }, sizeMin: 2, sizeMax: 3, budget: 300, value: 5, mandatory: false },
];

// fit_ij: derived from how well a person's proficiency matches a project's required skills
function computeFit(person, project) {
  const skills = Object.keys(project.needs);
  const scores = skills.map(s => Math.min(person.prof[s] / 3, 1));
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

const FIT = {};
for (const p of PEOPLE) {
  FIT[p.id] = {};
  for (const proj of PROJECTS) FIT[p.id][proj.id] = computeFit(p, proj);
}

function isQualified(person, skill) {
  return person.prof[skill] >= THRESHOLD;
}

// Extension module data (slide 8): compatibility conflict pair + department diversity ratio
const INCOMPATIBLE_PAIR = ['ben', 'chen'];
const DIVERSITY_RATIO = 0.6; // no department may exceed this share of a project's team
