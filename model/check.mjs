// npm run model: the formal model's fast checks (R3-1243), no JVM needed.
//   1. typecheck every module;
//   2. the regression runs (model/regressions.qnt) — one per defect the reviews found;
//   3. random simulation of every safety property (model/properties.qnt);
//   4. reachability witnesses (model/witnesses.qnt): each must be VIOLATED, or the
//      properties above would hold only because the model never gets there.
import { spawnSync } from 'node:child_process';

const quint = (args) => spawnSync('npx', ['quint', ...args], { encoding: 'utf8' });
const samples = process.env.MODEL_SAMPLES ?? '1000';
let failed = false;
const step = (label, ok, out) => {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) { failed = true; console.log(out); }
};

for (const f of ['baton', 'properties', 'regressions', 'witnesses']) {
  const r = quint(['typecheck', `model/${f}.qnt`]);
  step(`typecheck ${f}.qnt`, r.status === 0, r.stdout + r.stderr);
}
const t = quint(['test', 'model/regressions.qnt', '--main=regressions', '--backend=typescript']);
step('regression runs', t.status === 0, t.stdout + t.stderr);
const s = quint(['run', 'model/properties.qnt', '--main=properties', '--invariant=safety',
  '--backend=typescript', '--max-steps=40', `--max-samples=${samples}`]);
step(`safety, ${samples} random runs of 40 steps`, s.status === 0, s.stdout.slice(-4000) + s.stderr);
for (const w of ['noConfirmedSuspension', 'noRegressedClaim', 'noResumedClaim']) {
  const r = quint(['run', 'model/witnesses.qnt', '--main=witnesses', `--invariant=${w}`,
    '--backend=typescript', '--max-steps=60', '--max-samples=3000']);
  step(`witness ${w} is reached`, r.status !== 0 && /violation/.test(r.stdout), r.stdout.slice(-2000));
}
process.exit(failed ? 1 : 0);
