// check-traces.test.ts — scripts/check-traces.mjs rejects a trace the model forbids, naming the
// step (R3-1244 "Tests"): a claim on a held ticket, and an end confirmed by an observation no
// greater than its own. Each starts from a trace the model accepts, so the rejection is the
// mutation's. Node only: it runs Quint.
import { describe, it, expect, afterAll } from 'vitest';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toItf, type ClaimView, type Projection, type Step } from '../integration/trace';
import { checkTrace, scopeErrors } from '../../scripts/check-traces.mjs';
import { check as checkLinks, closureText, declarations, hashOf } from '../../scripts/check-model-links.mjs';
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

describe('check-traces rejects each step round 1 found accepted (round 2, 2-r2-1)', () => {
  const claimed = (over: Partial<ClaimView> = {}) => (p: Projection) => ({ ...p, claims: { 1: claim(over) } });
  const rejected = async (name: string, rest: [Step['origin'], (p: Projection) => Projection][], reason: string) => {
    const r = await check(name, trace(rest));
    expect(r.ok).toBe(false);
    expect(r.failure.reason).toContain(reason);
    return r;
  };
  const claimReq = req('POST', '/v1/runner/claim');
  it('the base claim is accepted', async () => {
    expect(await check('claim-base', trace([[claimReq, claimed()]]))).toMatchObject({ ok: true, end: null });
  });
  it('a second observation number under ten minutes after the first (R-BTN-62 sync-busy)', async () => {
    await rejected('sync-busy', [[req('POST', '/v1/sync/observation'), (p) => ({ ...p, counter: 2, outstanding: true })],
      [req('POST', '/v1/sync/observation'), (p) => ({ ...p, counter: 3, outstanding: true })]], 'sync-busy');
  });
  it('an alarm reap before the lease ran out by the recorded clock', async () => {
    await rejected('early-reap', [[claimReq, claimed()], [{ kind: 'alarm' }, claimed({ status: 'reaped', endReason: 'reaped:silent' })]], 'before worker 1\'s lease ran out');
  });
  it('a claim\'s legs moved by anything but its advance', async () => {
    await rejected('legs-by-heartbeat', [[claimReq, claimed()], [req('POST', '/v1/runner/heartbeat'), claimed({ leg: 'implement' })]], 'legs changed by /v1/runner/heartbeat');
  });
  it('an advance whose stored bars are not the ones the holder sent', async () => {
    await rejected('bars-not-sent', [[claimReq, claimed()],
      [req('POST', '/v1/runner/claims/1/advance', { leg: 'implement', bars: ['family:a'] }), claimed({ leg: 'implement', legBars: ['family:b'] })]], 'not the ["family:a"] the holder sent');
  });
  it('the board changed outside a board post', async () => {
    await rejected('board-outside-post', [[req('POST', '/v1/runner/heartbeat'), (p) => ({ ...p, tickets: { [T]: { ...p.tickets[T], path: ['implement'] } } })]], 'outside a board post');
  });
  it('a claim that vanished', async () => {
    await rejected('vanished', [[claimReq, claimed()], [req('POST', '/v1/runner/heartbeat'), (p) => ({ ...p, claims: {} })]], 'claim 1 vanished');
  });
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

describe('every truncated trace is pinned in trace-scope.json (round 1, 1-B-5)', () => {
  const r = (test: string, checked: number, end: { index: number; reason: string } | null, ok = true) => ({ scenario: 'S', test, ok, checked, end });
  const why = 'the harness wrote a claim (a state Baton did not reach)';
  it('accepts a whole trace and a truncation listed with its step and reason', () => {
    expect(scopeErrors([r('whole', 4, null), r('cut', 3, { index: 3, reason: why })], { 'S › cut': { at: 3, reason: why } })).toEqual([]);
  });
  it('fails an unlisted truncation, a moved one, a changed reason, a stale entry and a trace with nothing checked', () => {
    expect(scopeErrors([r('cut', 3, { index: 3, reason: why })], {})).toEqual([expect.stringContaining('does not list')]);
    expect(scopeErrors([r('cut', 2, { index: 2, reason: why })], { 'S › cut': { at: 3, reason: why } })).toEqual([expect.stringContaining('not the listed step 3')]);
    expect(scopeErrors([r('cut', 3, { index: 3, reason: 'other' })], { 'S › cut': { at: 3, reason: why } })).toEqual([expect.stringContaining('not the listed step 3')]);
    expect(scopeErrors([r('whole', 4, null)], { 'S › whole': { at: 3, reason: why } })).toEqual([expect.stringContaining('judged whole')]);
    expect(scopeErrors([], { 'S › gone': { at: 3, reason: why } })).toEqual([expect.stringContaining('no accepted trace')]);
    expect(scopeErrors([], { 'S › gone': { at: 3, reason: why } }, false)).toEqual([]);
    expect(scopeErrors([r('cut', 0, { index: 0, reason: why })], { 'S › cut': { at: 0, reason: why } })).toEqual([expect.stringContaining('no step checked')]);
  });
});

describe('model:links matches a stamp to its function, not its file (round 2, 2-r2-2)', () => {
  it('a stamp above a function the action does not name, or a stale one there, fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'baton-links-'));
    const repo = join(import.meta.dirname, '../..');
    cpSync(join(repo, 'model'), join(root, 'model'), { recursive: true });
    cpSync(join(repo, 'src'), join(root, 'src'), { recursive: true });
    expect(checkLinks(root).errors).toEqual([]);
    const file = join(root, 'src/core/claims.ts');
    const src = readFileSync(file, 'utf8');
    const advance = /@model advance sha256:([0-9a-f]{12})/.exec(src)![1];
    // the current hash, above a function the action does not name
    writeFileSync(file, src.replace('  handedOut(repo: string): number {', `  // @model advance sha256:${advance}\n  handedOut(repo: string): number {`));
    expect(checkLinks(root).errors).toEqual([expect.stringContaining('src/core/claims.ts#handedOut: @model advance, but the action does not name')]);
    // a second, stale stamp in a function the action does name
    writeFileSync(file, src.replace(`@model advance sha256:${advance}`, `@model advance sha256:${advance}\n  // @model advance sha256:000000000000`));
    expect(checkLinks(root).errors.some((e: string) => e.includes('stamped 000000000000'))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
