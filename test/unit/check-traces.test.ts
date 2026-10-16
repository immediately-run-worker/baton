// check-traces.test.ts — scripts/check-traces.mjs rejects a trace the model forbids, naming the
// step (R3-1244 "Tests"): a claim on a held ticket, and an end confirmed by an observation no
// greater than its own. Each starts from a trace the model accepts, so the rejection is the
// mutation's. Node only: it runs Quint.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toItf, type ClaimView, type Projection, type Step } from '../integration/trace';
import { checkTrace } from '../../scripts/check-traces.mjs';
import { closureText, declarations, hashOf } from '../../scripts/check-model-links.mjs';
import { readFileSync } from 'node:fs';

const dir = mkdtempSync(join(tmpdir(), 'baton-check-traces-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const T = 'docs:T-1';
const base = (): Projection => ({ counter: 0, lastAccepted: 0, outstanding: false, tickets: {}, claims: {}, held: {}, ownerBars: [], workers: { 1: [] }, required: [], courseFile: null, liveness: { 1: { lastSeen: 0, lease: 900_000 } } });
const claim = (over: Partial<ClaimView> = {}): ClaimView => ({
  ticket: T, worker: 1, status: 'active', endReason: null, station: 'filed', leg: '', finished: [], legBars: [], startPath: [], claimObs: 1, endObs: -1,
  regressed: false, endedRegressed: false, confirmed: false, fencePending: false, ...over,
});

/** A small run: a number, a post putting T-1 at filed, then `rest`. */
function trace(rest: [Step['origin'], (p: Projection) => Projection][]): Step[] {
  const steps: Step[] = [];
  let s = base();
  const push = (origin: Step['origin'], f: (p: Projection) => Projection) => {
    s = f(structuredClone(s));
    steps.push({ kind: origin?.kind ?? 'harness', origin, now: 0, state: s });
  };
  push({ kind: 'request', method: 'POST', path: '/v1/sync/observation', status: 200 }, (p) => ({ ...p, counter: 1, outstanding: true }));
  push({ kind: 'request', method: 'POST', path: '/v1/sync/board', body: { observation: 1 }, status: 200 },
    (p) => ({ ...p, outstanding: false, lastAccepted: 1, tickets: { [T]: { present: true, path: [], closed: null, bars: {}, tier: 'routine', status: 'ready' } } }));
  for (const [o, f] of rest) push(o, f);
  return steps;
}

const req = (method: string, path: string, body?: unknown): Step['origin'] => ({ kind: 'request', method, path, body, status: 200 });
async function check(name: string, steps: Step[]) {
  const file = join(dir, `${name}.itf.json`);
  writeFileSync(file, JSON.stringify(toItf('check-traces.test', name, steps)));
  return checkTrace(file, name);
}

describe('check-traces rejects what the model forbids, naming the step', () => {
  it('a second claim on a held ticket: the base is accepted, the claim after the hold is not', async () => {
    const claimed = (p: Projection) => ({ ...p, claims: { 1: claim() } });
    const held = (p: Projection) => ({ ...p, held: { [T]: true } });
    // accepted: the claim, then the hold
    expect(await check('claim-then-hold', trace([[req('POST', '/v1/runner/claim'), claimed], [req('POST', `/v1/ui/overrides/${T}`), held]]))).toMatchObject({ ok: true, end: null });
    // rejected: the hold, then a claim the core should have refused (rule 3)
    const r = await check('hold-then-claim', trace([[req('POST', `/v1/ui/overrides/${T}`), held], [req('POST', '/v1/runner/claim'), claimed]]));
    expect(r.ok).toBe(false);
    // the model will not even start it: claimStart's gates fail on the hold
    expect(r.failure).toMatchObject({ step: 3, label: 'POST /v1/runner/claim → 200', actionRefused: true });
    expect(r.failure.actions).toContain('claimStart("w1", "docs:T-1")');
  }, 120_000);

  it('an end confirmed by an observation not above its own: rejected at the post that claims it', async () => {
    const steps = trace([
      [req('POST', '/v1/runner/claim'), (p) => ({ ...p, claims: { 1: claim() } })],
      [req('POST', '/v1/runner/claims/1/advance', { leg: 'implement' }), (p) => ({ ...p, claims: { 1: claim({ leg: 'implement' }) } })],
      [req('POST', '/v1/runner/claims/1/end'), (p) => ({ ...p, claims: { 1: claim({ status: 'completed', endReason: 'suspended:pr-open', station: 'pr-open', finished: ['implement'], endObs: 1 }) } })],
    ]);
    // accepted: a newer reading (2) showing the leg confirms it
    const confirmed = [...steps,
      { kind: 'request', origin: req('POST', '/v1/sync/observation'), now: 0, state: { ...steps.at(-1)!.state, counter: 2, outstanding: true } },
    ] as Step[];
    confirmed.push({ kind: 'request', origin: req('POST', '/v1/sync/board', { observation: 2 }), now: 0, state: {
      ...confirmed.at(-1)!.state, outstanding: false, lastAccepted: 2, tickets: { [T]: { present: true, path: ['implement'], closed: null, bars: {}, tier: 'routine', status: 'ready' } },
      claims: { 1: { ...confirmed.at(-1)!.state.claims[1], confirmed: true } } } } as unknown as Step);
    expect(await check('confirmed-by-newer', confirmed)).toMatchObject({ ok: true, end: null });
    // rejected: the same confirmation credited to a refused post of the end's own number (1)
    const stale = [...steps,
      { kind: 'request', origin: { ...req('POST', '/v1/sync/board', { observation: 1 }), status: 409 }, now: 0, state: {
        ...steps.at(-1)!.state, claims: { 1: { ...steps.at(-1)!.state.claims[1], confirmed: true } } } },
    ] as Step[];
    const r = await check('confirmed-by-older', stale);
    expect(r.ok).toBe(false);
    expect(r.failure).toMatchObject({ step: 5 });
    expect(r.failure.fields).toContain('claim 1 confirmed');
  }, 120_000);
});

describe('model:links hashes what an action rests on (round 1, 1-A-6)', () => {
  it('a change to a helper the action reaches — the claim gate, the judge — changes its hash', () => {
    const src = readFileSync(join(import.meta.dirname, '../../model/baton.qnt'), 'utf8');
    const hash = (text: string, action: string) => hashOf(closureText(action, declarations(text)));
    const gate = src.replace('activeOf(t).size() == 0, fencedOf(t).size() == 0', 'activeOf(t).size() <= 1, fencedOf(t).size() == 0');
    expect(gate).not.toBe(src);
    expect(hash(gate, 'claimStart')).not.toBe(hash(src, 'claimStart'));
    const judge = src.replace('if (ok) c.with("confirmed", true)', 'if (true) c.with("confirmed", true)');
    expect(judge).not.toBe(src);
    expect(hash(judge, 'syncPost')).not.toBe(hash(src, 'syncPost'));
    // and an unrelated action keeps its hash
    expect(hash(judge, 'setHold')).toBe(hash(src, 'setHold'));
  });
});
