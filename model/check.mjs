// npm run model: the formal model's fast checks (R3-1243), no JVM needed.
//   1. typecheck every module;
//   2. the regression runs (model/regressions.qnt) — one per defect the reviews found;
//   3. random simulation of `safety` on the `sim` instance (instances.qnt): with the full
//      `step` (every actor) and with `progressStep` (the happy path's actors, so runs reach
//      merges, fix loops, regressions and confirmations — every such run is a run of `step`);
//   4. reachability witnesses (witnesses.qnt): each must be VIOLATED — the state reached —
//      or the properties above would hold only because the runs never get there.
import { spawnSync } from 'node:child_process';

const quint = (args) => spawnSync('npx', ['quint', ...args], { encoding: 'utf8' });
const samples = process.env.MODEL_SAMPLES ?? '10000';
// progressStep's runs scale with MODEL_SAMPLES (3,000 at the default 10,000), so `npm test`'s
// smaller run stays short (baton#10 round 2, 2-A-3)
const progressSamples = String(Math.max(100, Math.round(Number(samples) * 0.3)));
const sim = (step) => ['model/instances.qnt', '--main=sim', '--init=pinit', `--step=${step}`,
  '--backend=typescript'];
let failed = false;
const check = (label, ok, out) => {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) { failed = true; console.log(out); }
};

for (const f of ['baton', 'properties', 'instances', 'regressions', 'witnesses', 'liveness']) {
  const r = quint(['typecheck', `model/${f}.qnt`]);
  check(`typecheck ${f}.qnt`, r.status === 0, r.stdout + r.stderr);
}
const t = quint(['test', 'model/regressions.qnt', '--main=regressions', '--backend=typescript']);
check('regression runs', t.status === 0, t.stdout + t.stderr);
const s = quint(['run', ...sim('pstep'), '--invariant=safety', '--max-steps=40', `--max-samples=${samples}`]);
check(`safety, ${samples} random runs of 40 steps of step`, s.status === 0, s.stdout.slice(-4000) + s.stderr);
const sp = quint(['run', ...sim('pprogress'), '--invariant=safety', '--max-steps=40', `--max-samples=${progressSamples}`]);
check(`safety, ${progressSamples} random runs of 40 steps of progressStep`, sp.status === 0, sp.stdout.slice(-4000) + sp.stderr);
const wsim = (step) => ['model/witnesses.qnt', '--main=witnesses', '--init=winit', `--step=${step}`,
  '--backend=typescript'];
const witnesses = [
  ['wstep', ['noConfirmedSuspension', 'noResumedClaim', 'noFence', 'noAlarmReap']],
  ['wprogress', ['noFixLeg', 'noRegressedClaim', 'noMerge', 'noConfirmedDone']],
];
// A second review takes a long specific sequence random runs rarely produce;
// regressions.qnt reaches it deterministically (maxRunsSurviveResumptionTest).
for (const [step, names] of witnesses) for (const w of names) {
  // a fixed seed: a witness is a fact about the model, not a lottery
  const r = quint(['run', ...wsim(step), `--invariant=${w}`, '--max-steps=60', '--max-samples=3000', '--seed=1']);
  check(`witness ${w} is reached (${step})`, r.status !== 0 && /violation/.test(r.stdout), r.stdout.slice(-2000));
}
process.exit(failed ? 1 : 0);
