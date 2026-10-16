// S-BTN-41 the runner (BATON_SPEC §13a S-BTN-41, §6.13 R-BTN-72; R3-1245): `baton run` on a VM
// with a home repository's `.baton/` — stub leg scripts that push evidence into git, `close`
// writing the closing marker as a commit — claims a ticket and follows its results. Must hold:
// the runner holds the claim through a `ci` wait and goes on; it takes the leg each result names
// — the merge advance carrying the adjudicate result's `bars` — never inferring a single edge;
// the `max-runs` refusal suspends, writing the hand-off; a regressed path aborts the leg and
// suspends at its `from`; `close` and `handoff` run before the suspension and it ends
// `suspended:<station>`; on a lost lease it aborts the leg and kills its process group before
// any fence report, with no hand-off; the second claim runs new scripts with no restart; a bad
// `next` suspends at its station; a release aborts the leg at its next safe point, writes the
// hand-off and ends `released:requested` naming whether the leg reached its `to`; a leg
// session's claim is refused, since it carries IR_BATON_PARENT, and leg sessions register no
// worker of their own. Node only: it spawns the legs' child processes and runs git.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { BatonApi } from '../../src/runner/api';
import { Runner } from '../../src/runner/runner';
import { call as hostCall } from '#host';
import { course, cutover, ORIGIN, ownerCall, placed, rows, setClock, syncCall, ticket, TOKENS } from '../helpers';
import relay from '../fixtures/courses/relay/course.json';

const T0 = Date.parse('2026-10-16T12:00:00Z');

/** One leg script: `run` is the body given; `close` commits a closing marker and returns the
 * commit (the position is in git before it is reported, R-BTN-83); `handoff` records its call.
 * Every line the test asserts on lands in `<home>/.baton/evidence.jsonl`. */
function legFile(run: string, defaultExport = false): string {
  return `import { appendFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const at = (ctx, name) => [ctx.checkout, '.baton', name].join('/');
const ev = (ctx, line) => appendFileSync(at(ctx, 'evidence.jsonl'), line + '\\n');
const out = (ctx, o) => { const f = at(ctx, 'evidence.jsonl'); const was = existsSync(f) ? readFileSync(f, 'utf8') : ''; writeFileSync(f, was + JSON.stringify(o) + '\\n'); };
const git = (ctx, ...a) => execFileSync('git', ['-C', ctx.checkout, ...a], { encoding: 'utf8' }).trim();
${defaultExport ? 'export default' : 'export'} async function run(ctx) {
${run}
}
export async function close(ctx, result) {
  appendFileSync(at(ctx, 'markers.jsonl'), JSON.stringify({ leg: ctx.leg, ...(result && result.reached ? { reached: result.reached } : {}), claim: ctx.claim.nonce }) + '\\n');
  git(ctx, 'add', '.baton/markers.jsonl');
  git(ctx, 'commit', '--allow-empty', '--no-gpg-sign', '-m', 'baton:close ' + ctx.leg);
  ev(ctx, 'close ' + ctx.leg);
  return git(ctx, 'rev-parse', 'HEAD');
}
export async function handoff(ctx) {
  ev(ctx, 'handoff ' + ctx.leg + (ctx.bug ? ' bug=' + ctx.bug : ''));
  return 'https://example.test/handoff/' + ctx.leg;
}
`;
}

/** The home repository: a real git checkout whose `.baton/` the runner reads at the claim's
 * snapshot, and whose board posts carry the real head sha (R-BTN-34's fetch never fires). */
class Home {
  readonly dir: string;
  head: string | null = null;
  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'baton-home-'));
    const g = (...a: string[]) => execFileSync('git', ['-C', this.dir, ...a], { encoding: 'utf8', stdio: 'ignore' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 'relay@test');
    g('config', 'user.name', 'relay test');
    this.write('.baton/courses/relay/course.json', `${JSON.stringify(relay, null, 2)}\n`);
    this.write('.baton/baton.json', `${JSON.stringify({ course: 'relay', skills_version: 3 }, null, 2)}\n`);
  }
  write(path: string, text: string): void {
    const file = join(this.dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  leg(name: string, run: string, defaultExport = false): void {
    this.write(`.baton/courses/relay/legs/${name}.mjs`, legFile(run, defaultExport));
  }
  sha(): string {
    return execFileSync('git', ['-C', this.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  }
  commit(): string {
    execFileSync('git', ['-C', this.dir, 'add', '.baton'], { stdio: 'ignore' });
    execFileSync('git', ['-C', this.dir, 'commit', '--no-gpg-sign', '-q', '-m', 'legs'], { stdio: 'ignore' });
    return this.sha();
  }
  async post(stations: Record<string, unknown>, tickets: unknown[] = [ticket('T-1', { course_id: 'relay' })], registryOver: Record<string, unknown> = {}): Promise<void> {
    const sha = this.sha();
    const res = await syncCall('/v1/sync/board', {
      registry: [course(3, 3, { id: 'relay', course: relay as unknown as Record<string, unknown>, ...registryOver })],
      sha, parent_sha: this.head, tickets, closed: [], stations,
    });
    if (res.status !== 200) throw new Error(`board post: ${res.status} ${await res.text()}`);
    this.head = sha;
  }
  evidence(): string[] {
    const f = join(this.dir, '.baton', 'evidence.jsonl');
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
  }
  markers(): { leg: string; reached?: string; claim: string }[] {
    const f = join(this.dir, '.baton', 'markers.jsonl');
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { leg: string; reached?: string; claim: string }) : [];
  }
}

let home: Home;
let n = 0;
const clock = { now: T0 };
const runners: Runner[] = [];

/** A runner against this test's Baton (the local host), heartbeating as credential vm-a. */
function makeRunner(over: Record<string, unknown> = {}): Runner {
  const stateFile = join(tmpdir(), `baton-runner-${process.pid}-${++n}.json`);
  const api = new BatonApi({
    url: 'https://baton.test',
    transport: (req) => hostCall(req),
    auth: (_m, _u, _b, secret) => ({ Authorization: `Bearer ${TOKENS['vm-a']}`, ...(secret ? { 'X-Worker-Secret': secret } : {}) }),
  });
  const runner = new Runner({
    api, home: home.dir, repository: 'docs', hostname: 'vm-a', harness: 'opencode',
    session: `runner-${n}`, courses: [{ course: 'relay', version: 3 }],
    stateFile, beatEvery: 40, now: () => clock.now, log: () => {},
    ...over,
  });
  runners.push(runner);
  return runner;
}

/** Wait until `q` returns a non-empty list — the test's window into the runner's progress. */
async function until(q: () => Promise<unknown[]> | unknown[]): Promise<unknown[]> {
  for (let i = 0; i < 400; i++) {
    const r = await q();
    if (r.length) return r;
    await new Promise((r2) => setTimeout(r2, 10));
  }
  throw new Error('condition never became true');
}

/** Wait until `pid` is gone — a killed process group's proof. */
async function untilDead(pid: number): Promise<boolean> {
  for (let i = 0; i < 400; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r2) => setTimeout(r2, 10));
  }
  return false;
}

const ABORTABLE = `await new Promise((resolve) => {
  const t = setInterval(() => { if (ctx.signal.aborted) { clearInterval(t); resolve(); } }, 10);
  setTimeout(() => { clearInterval(t); resolve(); }, 30000);
});`;

beforeEach(async () => {
  clock.now = T0;
  await setClock(T0);
  home = new Home();
  await cutover();
});

afterEach(async () => {
  for (const r of runners.splice(0)) r.stop();
  rmSync(home.dir, { recursive: true, force: true });
});

describe('S-BTN-41 the runner', () => {
  it('claims a ticket and takes the leg each result names, never inferring one', async () => {
    home.leg('build', `out(ctx, { leg: 'build', parent: process.env.IR_BATON_PARENT ?? null, hasState: !!process.env.IR_BATON_STATE, session: ctx.session ?? null, run: ctx.run });
  return { reached: 'built', next: 'check', session: 's-1' };`);
    home.leg('check', `out(ctx, { leg: 'check', session: ctx.session ?? null, run: ctx.run });
  return { reached: 'checked', next: 'merge', bars: ['family:anthropic'] };`);
    home.leg('merge', `out(ctx, { leg: 'merge', run: ctx.run });
  return { reached: 'merged' };`, true);
    home.commit();
    await home.post({ 'T-1': placed('filed', [], [['build', 'ready']]) });
    const out = await makeRunner().runOnce();
    expect(out).toMatchObject({ ticket: 'docs:T-1', end_reason: 'done', reached: 'merged' });
    expect(await rows('SELECT status, end_reason FROM claims')).toEqual([{ status: 'completed', end_reason: 'done' }]);
    // The merge advance carried the check result's bars on the edge (R-BTN-63).
    expect(await rows('SELECT leg, to_station, bars FROM claim_legs ORDER BY seq')).toEqual([
      { leg: 'build', to_station: 'built', bars: '[]' },
      { leg: 'check', to_station: 'checked', bars: '[]' },
      { leg: 'merge', to_station: 'merged', bars: '["family:anthropic"]' },
    ]);
    // The leg session's env named its parent and the runner's state file (it registers no worker
    // of its own); the session token travelled from build's result into check's ctx. Each leg's
    // run number is 1 on its first run — the path gains a leg only when it finishes.
    const lines = home.evidence();
    expect(JSON.parse(lines[0])).toMatchObject({ leg: 'build', parent: expect.stringMatching(/^\d+$/), hasState: true, run: 1 });
    expect(JSON.parse(lines[2])).toMatchObject({ leg: 'check', session: 's-1', run: 1 });
    // close ran for every leg (git before the report, R-BTN-83); a done end writes no hand-off.
    expect(lines.filter((l) => l.startsWith('close '))).toEqual(['close build', 'close check', 'close merge']);
    expect(lines.some((l) => l.startsWith('handoff'))).toBe(false);
    expect(home.markers()).toHaveLength(3);
  }, 30_000);

  it('holds the claim through a short ci wait and goes on when it clears', async () => {
    home.leg('build', `return { reached: 'built', next: 'check' };`);
    home.leg('check', `return { reached: 'checked', next: 'merge' };`);
    home.leg('merge', `return { reached: 'merged' };`);
    home.commit();
    await home.post({ 'T-1': placed('filed', [], [['build', 'ready']]) });
    const runner = makeRunner();
    runner.start();
    const done = runner.runOnce();
    await until(() => rows(`SELECT 1 FROM claim_legs WHERE leg = 'build'`));
    // While build runs, the snapshot moves: the ticket is built and check waits on ci — the
    // advance into check then reads the wait, deterministically.
    await home.post({ 'T-1': placed('built', [['build', 'built']], [['check', 'waiting', 'ci']]) });
    await until(() => rows(`SELECT 1 FROM claim_legs WHERE leg = 'check'`));
    // The claim is held through the wait — check started only when the wait cleared? No: the
    // advance started check, the wait governs running it. The claim stays active meanwhile.
    expect(await rows('SELECT status FROM claims')).toEqual([{ status: 'active' }]);
    expect(await rows('SELECT leg, started_at FROM claim_legs')).toHaveLength(2);
    // The wait clears (R-BTN-40's re-read at each heartbeat) and the leg runs to the end.
    await home.post({ 'T-1': placed('built', [['build', 'built']], [['check', 'ready']]) });
    expect(await done).toMatchObject({ end_reason: 'done', reached: 'merged' });
    expect(await rows('SELECT leg FROM claim_legs ORDER BY seq')).toEqual([{ leg: 'build' }, { leg: 'check' }, { leg: 'merge' }]);
  }, 30_000);

  it('a short wait that never clears suspends after 30 minutes', async () => {
    home.leg('build', `return { reached: 'built', next: 'check' };`);
    home.commit();
    await home.post({ 'T-1': placed('filed', [], [['build', 'ready']]) });
    const runner = makeRunner();
    runner.start();
    const done = runner.runOnce();
    await until(() => rows(`SELECT 1 FROM claim_legs WHERE leg = 'build'`));
    await home.post({ 'T-1': placed('built', [['build', 'built']], [['check', 'waiting', 'ci']]) });
    await until(() => rows(`SELECT 1 FROM claim_legs WHERE leg = 'check'`));
    await new Promise((r) => setTimeout(r, 120));
    expect(await rows('SELECT status FROM claims')).toEqual([{ status: 'active' }]); // still waiting
    clock.now = T0 + 31 * 60_000; // the budget is spent (R-BTN-40)
    expect(await done).toMatchObject({ end_reason: 'suspended:built', reached: 'built' });
    expect(await rows('SELECT end_reason, status FROM claims')).toEqual([{ end_reason: 'suspended:built', status: 'completed' }]);
    // The waiting leg was started then given up at its from; the end names it queued again.
    expect(await rows('SELECT leg, to_station, abandoned_at IS NOT NULL AS gone FROM claim_legs')).toEqual([
      { leg: 'build', to_station: 'built', gone: 0 },
      { leg: 'check', to_station: null, gone: 1 },
    ]);
    expect(home.evidence().at(-1)).toMatch(/^handoff build/);
  }, 30_000);

  it('a release that lands during the short wait is honoured, not dropped', async () => {
    home.leg('build', `return { reached: 'built', next: 'check' };`);
    home.leg('check', `return { reached: 'checked', next: 'merge' };`);
    home.commit();
    await home.post({ 'T-1': placed('filed', [], [['build', 'ready']]) });
    const runner = makeRunner();
    runner.start();
    const done = runner.runOnce();
    await until(() => rows('SELECT 1 FROM claims'));
    await home.post({ 'T-1': placed('built', [['build', 'built']], [['check', 'waiting', 'ci']]) });
    await until(() => rows(`SELECT 1 FROM claim_legs WHERE leg = 'check'`)); // the wait holds
    const worker = (await rows<{ id: number }>('SELECT id FROM workers ORDER BY id DESC LIMIT 1'))[0].id;
    const send = await ownerCall('/v1/ui/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ kind: 'release', to_worker_id: worker, payload: { ticket_id: 'docs:T-1', reason: 'requested' } }) });
    expect(send.status).toBe(200);
    // No leg was running when the release landed — the claim still ends released, never
    // suspended, and the message is acked because it was acted on.
    expect(await done).toMatchObject({ end_reason: 'released:requested', reached: 'built' });
    expect(await rows('SELECT end_reason FROM claims')).toEqual([{ end_reason: 'released:requested' }]);
    await until(() => rows(`SELECT 1 FROM messages WHERE status = 'acknowledged'`));
    expect(home.evidence().at(-1)).toMatch(/^handoff build/); // the leg that ran writes it
  }, 30_000);

  it('a home with no .baton/baton.json serves its single course directory (docs today)', async () => {
    home.leg('check', `return { suspend: true, reached: 'checked' };`);
    rmSync(join(home.dir, '.baton', 'baton.json'));
    home.commit();
    await home.post({ 'T-1': placed('built', [['build', 'built']], [['check', 'ready']]) });
    const out = await makeRunner().runOnce();
    expect(out).toMatchObject({ end_reason: 'suspended:checked' }); // ran, not stale-board
    expect(await rows('SELECT end_reason FROM claims')).toEqual([{ end_reason: 'suspended:checked' }]);
  }, 30_000);

  it('a lease lost during the short wait stops it at once, no hand-off', async () => {
    home.leg('build', `return { reached: 'built', next: 'check' };`);
    home.commit();
    await home.post({ 'T-1': placed('filed', [], [['build', 'ready']]) });
    const runner = makeRunner();
    runner.start();
    const done = runner.runOnce();
    await until(() => rows(`SELECT 1 FROM claim_legs WHERE leg = 'build'`));
    await home.post({ 'T-1': placed('built', [['build', 'built']], [['check', 'waiting', 'ci']]) });
    await until(() => rows(`SELECT 1 FROM claim_legs WHERE leg = 'check'`));
    // The lease goes while the wait holds it: no waiting out the 30 minutes, no hand-off.
    const claim = (await rows<{ id: number }>('SELECT id FROM claims'))[0].id;
    const reap = await ownerCall(`/v1/ui/claims/${claim}/reap`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ confirm: true }) });
    expect(reap.status).toBe(200);
    expect(await done).toMatchObject({ end_reason: 'released:lease-lost', reached: 'built' });
    expect(home.evidence().some((l) => l.startsWith('handoff'))).toBe(false);
  }, 30_000);

  it('a snapshot the checkout lacks is fetched once, and the claim runs (R-BTN-34)', async () => {
    // The runner's home is a clone of the course-only root: the legs commit the claim is
    // decided on does not exist in it yet, so the one bounded fetch must bring it.
    home.commit(); // the course-only root, before any legs
    const clone = mkdtempSync(join(tmpdir(), 'baton-clone-'));
    execFileSync('git', ['clone', '-q', home.dir, clone], { stdio: 'ignore' });
    // A fresh clone carries no identity of its own (CI has no global one), and the stub's
    // close commits from the leg's checkout.
    execFileSync('git', ['-C', clone, 'config', 'user.email', 'relay@test']);
    execFileSync('git', ['-C', clone, 'config', 'user.name', 'relay test']);
    const fetched: string[] = [];
    home.leg('build', `return { reached: 'built', next: 'check' };`);
    home.leg('check', `return { suspend: true, reached: 'checked' };`);
    home.commit();
    await home.post({ 'T-1': placed('filed', [], [['build', 'ready']]) });
    const runner = makeRunner({ home: clone, fetch: (h: string) => {
      fetched.push(h);
      execFileSync('git', ['-C', h, 'fetch', '-q', 'origin', 'main'], { stdio: 'ignore' });
    } } as Record<string, unknown>);
    const out = await runner.runOnce();
    expect(out).toMatchObject({ ticket: 'docs:T-1', end_reason: 'suspended:checked' }); // ran, not stale-board
    expect(fetched).toEqual([clone]); // one bounded fetch
    expect(await rows('SELECT end_reason FROM claims')).toEqual([{ end_reason: 'suspended:checked' }]);
    rmSync(clone, { recursive: true, force: true });
  }, 30_000);

  it('a script’s own suspension rests at its outcome, close before handoff', async () => {
    home.leg('build', `return { reached: 'built', next: 'check' };`);
    home.leg('check', `return { suspend: true, reached: 'checked', next: 'merge' };`);
    home.commit();
    await home.post({ 'T-1': placed('filed', [], [['build', 'ready']]) });
    const out = await makeRunner().runOnce();
    expect(out).toMatchObject({ end_reason: 'suspended:checked', reached: 'checked', handoff: 'https://example.test/handoff/check' });
    expect(await rows('SELECT end_reason, status FROM claims')).toEqual([{ end_reason: 'suspended:checked', status: 'completed' }]);
    const lines = home.evidence();
    expect(lines.indexOf('close check')).toBeLessThan(lines.indexOf('handoff check')); // §6.13's order
    expect(home.markers().at(-1)).toMatchObject({ leg: 'check', reached: 'checked' });
  }, 30_000);

  it('a max-runs refusal suspends at the station reached, never releasing', async () => {
    // gate has run once already, as git evidences it (R-BTN-63 counts the start_path's runs).
    home.leg('build', `return { reached: 'built', next: 'check' };`);
    home.leg('check', `return { reached: 'checked', next: 'gate' };`);
    home.leg('gate', `return { reached: 'adjudicated', next: 'merge' };`);
    home.leg('merge', `return { reached: 'merged' };`);
    home.leg('rework', `return { reached: 'checked', next: 'gate' };`);
    home.commit();
    const RAN: [string, string][] = [['build', 'built'], ['check', 'checked'], ['gate', 'adjudicated'], ['rework', 'checked']];
    await home.post({ 'T-1': placed('checked', RAN, [['gate', 'ready'], ['adjudicate', 'ready'], ['merge', 'waiting', 'owner']]) });
    const out = await makeRunner().runOnce();
    expect(out).toMatchObject({ end_reason: 'suspended:checked', reached: 'checked' });
    expect(await rows('SELECT end_reason, status FROM claims')).toEqual([{ end_reason: 'suspended:checked', status: 'completed' }]);
    expect(await rows('SELECT leg FROM claim_legs')).toEqual([]); // the refused leg never started
  }, 30_000);

  it('a bad next suspends the leg given up at its from, reporting nothing it said', async () => {
    home.leg('build', `return { reached: 'built', next: 'check' };`);
    home.leg('check', `return { reached: 'checked', next: 'not-a-leg' };`);
    home.commit();
    await home.post({ 'T-1': placed('filed', [], [['build', 'ready']]) });
    const out = await makeRunner().runOnce();
    expect(out).toMatchObject({ end_reason: 'suspended:built', reached: 'built' });
    // No closing marker for the buggy leg (a bad pair never reaches git, R-BTN-83)…
    expect(home.markers().some((m) => m.leg === 'check')).toBe(false);
    // …and the hand-off names the fault for the next claimant.
    expect(home.evidence().at(-1)).toMatch(/^handoff check bug=/);
    expect(await rows('SELECT end_reason FROM claims')).toEqual([{ end_reason: 'suspended:built' }]);
  }, 30_000);

  it('a regressed path aborts the leg and suspends at its from', async () => {
    home.leg('check', `${ABORTABLE}
    ev(ctx, 'check aborted:' + ctx.signal.reason);
    throw new Error('aborted');`);
    home.commit();
    await home.post({ 'T-1': placed('built', [['build', 'built']], [['check', 'ready']]) });
    const runner = makeRunner();
    runner.start();
    const done = runner.runOnce();
    await until(() => rows(`SELECT 1 FROM claim_legs WHERE leg = 'check'`));
    // The PR closed under the leg: git's path went backwards (§2e) — shorter than the
    // snapshot before it and the claim's start_path.
    await home.post({ 'T-1': placed('filed', [], [['build', 'ready']]) });
    expect(await done).toMatchObject({ end_reason: 'suspended:built', reached: 'built' });
    expect(home.evidence().some((l) => l.includes('aborted:regressed'))).toBe(true);
    expect(home.evidence().at(-1)).toMatch(/^handoff check/);
    expect(await rows('SELECT end_reason FROM claims')).toEqual([{ end_reason: 'suspended:built' }]);
  }, 30_000);

  it('a release message aborts the leg at its next safe point and ends released:requested', async () => {
    home.leg('check', `${ABORTABLE}
    ev(ctx, 'check aborted:' + ctx.signal.reason);
    return { reached: 'checked', next: 'merge' }; // it finished its work as it stopped`);
    home.commit();
    await home.post({ 'T-1': placed('built', [['build', 'built']], [['check', 'ready']]) });
    const runner = makeRunner();
    runner.start();
    const done = runner.runOnce();
    await until(() => rows(`SELECT 1 FROM claim_legs WHERE leg = 'check'`));
    const worker = (await rows<{ id: number }>('SELECT id FROM workers ORDER BY id DESC LIMIT 1'))[0].id;
    const send = await ownerCall('/v1/ui/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ kind: 'release', to_worker_id: worker, payload: { ticket_id: 'docs:T-1', reason: 'requested' } }) });
    expect(send.status).toBe(200);
    // It names that the leg reached its to — validated and closed like any result (R-BTN-83),
    // the marker before the hand-off — and releases naming a leg leaving where it rests.
    expect(await done).toMatchObject({ end_reason: 'released:requested', reached: 'checked' });
    expect(home.evidence().some((l) => l.includes('aborted:release'))).toBe(true);
    const lines = home.evidence();
    expect(lines.indexOf('close check')).toBeLessThan(lines.indexOf('handoff check'));
    expect(home.markers().at(-1)).toMatchObject({ leg: 'check', reached: 'checked' });
    expect(await rows('SELECT end_reason, status FROM claims')).toEqual([{ end_reason: 'released:requested', status: 'released' }]);
    expect((await rows<{ resume_json: string }>('SELECT resume_json FROM claims'))[0].resume_json).toMatch(/"next":"merge"/); // the script's own word (R-BTN-83)
    // The message is acknowledged once acted on (§9).
    await until(() => rows(`SELECT 1 FROM messages WHERE status = 'acknowledged'`));
  }, 30_000);

  it('a lost lease kills the leg’s whole process group with no hand-off', async () => {
    home.leg('check', `const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    ev(ctx, 'grandchild ' + child.pid);
    ${ABORTABLE}
    ev(ctx, 'check aborted:' + ctx.signal.reason);
    throw new Error('aborted');`);
    home.commit();
    await home.post({ 'T-1': placed('built', [['build', 'built']], [['check', 'ready']]) });
    const runner = makeRunner();
    runner.start();
    const done = runner.runOnce();
    await until(() => (home.evidence().some((l) => l.startsWith('grandchild')) ? [1] : []));
    const pid = Number(/grandchild (\d+)/.exec(home.evidence().find((l) => l.startsWith('grandchild')) ?? '')?.[1]);
    expect(pid).toBeTruthy();
    // The lease goes: the owner reaps the claim (§6.6), so the heartbeat no longer lists it.
    const claim = (await rows<{ id: number }>('SELECT id FROM claims'))[0].id;
    const reap = await ownerCall(`/v1/ui/claims/${claim}/reap`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ confirm: true }) });
    expect(reap.status).toBe(200);
    expect(await done).toMatchObject({ end_reason: 'released:lease-lost' });
    // The grandchild died with the group, and no hand-off was written (R-BTN-24 covers it).
    expect(await untilDead(pid)).toBe(true);
    expect(home.evidence().some((l) => l.startsWith('handoff'))).toBe(false);
    // R-BTN-19: the next heartbeat reports the fence it cleared, so the ticket is re-issued
    // instead of waiting for the worker to go silent…
    await until(() => rows('SELECT 1 FROM claims WHERE fence_pending = 0'));
    // The owner's reap ended the claim first; the runner's own end was answered claim-ended and
    // the outcome stands — the ticket is re-issued, not fence-pending.
    expect((await rows<{ end_reason: string }>('SELECT end_reason FROM claims'))[0].end_reason).toBe('reaped:owner');
    // …and the lost lease belonged to that claim: the next one runs on a fresh lease.
    home.leg('check', `return { suspend: true, reached: 'checked' };`);
    home.commit();
    await home.post({ 'T-1': placed('built', [['build', 'built']], [['check', 'ready']]) });
    expect(await runner.runOnce()).toMatchObject({ end_reason: 'suspended:checked' });
    expect((await rows<{ end_reason: string }>('SELECT end_reason FROM claims ORDER BY id DESC'))[0].end_reason).toBe('suspended:checked');
  }, 60_000);

  it('a course change between two claims runs the new scripts with no restart', async () => {
    home.leg('adjudicate', `out(ctx, { leg: 'adjudicate', flavour: 'v1', run: ctx.run });
    return { suspend: true, reached: 'adjudicated' };`);
    home.leg('rework', `out(ctx, { leg: 'rework', run: ctx.run });
    return { reached: 'checked', next: 'adjudicate' };`);
    home.commit();
    const TO_CHECKED: [string, string][] = [['build', 'built'], ['check', 'checked']];
    await home.post({ 'T-1': placed('checked', TO_CHECKED, [['adjudicate', 'ready']]) });
    const runner = makeRunner();
    expect(await runner.runOnce()).toMatchObject({ end_reason: 'suspended:adjudicated' });
    expect((JSON.parse(home.evidence().find((l) => l.includes('flavour')) ?? '{}') as Record<string, unknown>).flavour).toBe('v1');
    // The course changes: adjudicate's script behaves differently, on a new head; the same
    // runner (no restart) loads the new bytes with its next claim, through rework's edge.
    home.leg('adjudicate', `out(ctx, { leg: 'adjudicate', flavour: 'v2', run: ctx.run });
    return { suspend: true, reached: 'adjudicated' };`);
    home.commit();
    await home.post({ 'T-1': placed('adjudicated', [...TO_CHECKED, ['adjudicate', 'adjudicated']], [['rework', 'ready']]) });
    expect(await runner.runOnce()).toMatchObject({ end_reason: 'suspended:adjudicated' });
    const second = JSON.parse([...home.evidence()].reverse().find((l) => l.includes('flavour')) ?? '{}') as Record<string, unknown>;
    expect(second.flavour).toBe('v2');
    // The second claim's rework ran once (run 1) and adjudicate again — run 2, the earlier
    // claim's leg counted from git (R-BTN-63).
    expect(second.run).toBe(2);
    const rework = [...home.evidence()].reverse().find((l) => l.startsWith('{') && l.includes('rework')) ?? '{}';
    expect((JSON.parse(rework) as Record<string, unknown>).run).toBe(1);
  }, 30_000);

  it('an off-graph refusal ends released:course-changed', async () => {
    home.leg('build', `await new Promise((r) => setTimeout(r, 200));
    return { reached: 'built', next: 'check' };`);
    home.commit();
    await home.post({ 'T-1': placed('filed', [], [['build', 'ready']]) });
    const runner = makeRunner();
    const done = runner.runOnce();
    await until(() => rows('SELECT 1 FROM claims'));
    // The course changes under the claim: check is gone (no renamed_from — R-BTN-64's other
    // half), on a new head — the runner's claim still carries the old snapshot.
    const CHANGED = { ...relay, legs: { ...(relay.legs as Record<string, unknown>), audit: { from: ['built'], to: 'checked' } } } as Record<string, unknown>;
    delete (CHANGED.legs as Record<string, unknown>).check;
    home.write('.baton/courses/relay/course.json', `${JSON.stringify(CHANGED, null, 2)}\n`);
    home.commit();
    await home.post({ 'T-1': placed('filed', [], [['build', 'ready']]) }, undefined, { course: CHANGED });
    expect(await done).toMatchObject({ end_reason: 'released:course-changed', reached: 'built' });
    expect(await rows('SELECT end_reason, status FROM claims')).toEqual([{ end_reason: 'released:course-changed', status: 'released' }]);
  }, 30_000);

  it('a heartbeat showing station unknown ends released:course-changed at the leg’s safe point', async () => {
    home.leg('check', `${ABORTABLE}
    ev(ctx, 'check aborted:' + ctx.signal.reason);
    throw new Error('aborted');`);
    home.commit();
    await home.post({ 'T-1': placed('built', [['build', 'built']], [['check', 'ready']]) });
    const runner = makeRunner();
    runner.start();
    const done = runner.runOnce();
    await until(() => rows(`SELECT 1 FROM claim_legs WHERE leg = 'check'`));
    // A file that drops the claim's station: the heartbeat says unknown (R-BTN-64), on a new head.
    const CHANGED = {
      ...relay,
      stations: { ...(relay.stations as Record<string, unknown>), assembled: { label: 'Assembled' } },
      legs: Object.fromEntries(Object.entries(relay.legs as Record<string, { from: string[]; to: string | string[] }>).map(([k, l]) => [k, { ...l, from: l.from.map((s) => (s === 'built' ? 'assembled' : s)), to: l.to === 'built' ? 'assembled' : l.to }])),
    } as Record<string, unknown>;
    delete (CHANGED.stations as Record<string, unknown>).built;
    home.write('.baton/courses/relay/course.json', `${JSON.stringify(CHANGED, null, 2)}\n`);
    home.commit();
    await home.post({ 'T-1': placed('assembled', [], [['check', 'ready']]) }, undefined, { course: CHANGED });
    expect(await done).toMatchObject({ end_reason: 'released:course-changed' });
    expect(home.evidence().some((l) => l.includes('aborted:release'))).toBe(true); // §6.13's closed signal set
    expect(home.evidence().at(-1)).toMatch(/^handoff check/);
  }, 30_000);

  it('a script’s own release ends the claim, no evidence pointer on a released end', async () => {
    home.leg('check', `return { release: 'cannot-finish:capability', reached: 'checked', next: 'merge' };`);
    home.commit();
    await home.post({ 'T-1': placed('built', [['build', 'built']], [['check', 'ready']]) });
    const out = await makeRunner().runOnce();
    expect(out).toMatchObject({ end_reason: 'released:cannot-finish:capability', reached: 'checked' });
    expect(await rows('SELECT end_reason, status, ended_at_sha FROM claims')).toEqual([
      { end_reason: 'released:cannot-finish:capability', status: 'released', ended_at_sha: null },
    ]);
    // close still wrote the marker (the position is in git) before handoff; the end carries no sha.
    const lines = home.evidence();
    expect(lines.indexOf('close check')).toBeLessThan(lines.indexOf('handoff check'));
  }, 30_000);

  it('the spool: transcript pointers ride the beat, activity rows post under their own call, and a dropped request loses nothing', async () => {
    home.leg('check', `return { suspend: true, reached: 'checked' };`);
    home.commit();
    await home.post({ 'T-1': placed('built', [['build', 'built']], [['check', 'ready']]) });
    const runner = makeRunner();
    await runner.tick(); // registers the worker
    const stateFile = join(tmpdir(), `baton-runner-${process.pid}-spool.json`);
    rmSync(stateFile, { force: true });
    const spooling = makeRunner({ stateFile, session: 'spool' } as Record<string, unknown>);
    await spooling.tick();
    // A leg session's records: two transcript pointers and an activity row (§6.8, §6.9).
    writeFileSync(`${stateFile}.spool.jsonl`, [
      JSON.stringify({ repo: 'immediately-run/claude-sessions', path: 'claude-code/2026-10-16-x.jsonl', role: 'subagent' }),
      JSON.stringify({ id: 'act-1', kind: 'orient', label: 'a session orienting', source: 'skill', started_at: clock.now }),
      JSON.stringify({ repo: 'immediately-run-worker/session-transcripts', path: 'host1/s.md', role: 'session' }),
      'not json at all',
    ].join('\n') + '\n');
    await spooling.tick();
    // No claim is held, so the pointers wait in pending_transcripts (§6.8) for the next claim.
    expect(await rows(`SELECT repo, path FROM pending_transcripts ORDER BY rowid`)).toEqual([
      { repo: 'immediately-run/claude-sessions', path: 'claude-code/2026-10-16-x.jsonl' },
      { repo: 'immediately-run-worker/session-transcripts', path: 'host1/s.md' },
    ]);
    expect(await rows(`SELECT kind, label FROM activities`)).toEqual([{ kind: 'orient', label: 'a session orienting' }]);
    expect(existsSync(`${stateFile}.spool.jsonl.taken`)).toBe(false); // sent: the taken file is gone
    // A dropped request: the pointers come back to the spool for the next beat.
    const api = (spooling as unknown as { o: { api: { broken: boolean } } }).o.api as unknown as { broken?: boolean } & { heartbeat: (b: unknown) => Promise<unknown> };
    const realHeartbeat = api.heartbeat.bind(api);
    let drop = true;
    (api as unknown as { heartbeat: (b: unknown) => Promise<unknown> }).heartbeat = async (b: unknown) => {
      if (drop) throw new Error('network down');
      return realHeartbeat(b);
    };
    writeFileSync(`${stateFile}.spool.jsonl`, `${JSON.stringify({ repo: 'immediately-run/claude-sessions', path: 'claude-code/2026-10-16-y.jsonl', role: 'session' })}\n`);
    await expect(spooling.tick()).rejects.toThrow(/network down/);
    expect(existsSync(`${stateFile}.spool.jsonl.taken`)).toBe(false); // nothing truncated away
    drop = false;
    await spooling.tick();
    expect(await rows(`SELECT path FROM pending_transcripts WHERE path LIKE '%y.jsonl' ORDER BY rowid`)).toEqual([{ path: 'claude-code/2026-10-16-y.jsonl' }]);
  }, 30_000);

  it('an orphaned claim is ended before the next claim, not held forever (rule 3)', async () => {
    home.leg('check', `return { suspend: true, reached: 'checked' };`);
    home.commit();
    await home.post({ 'T-1': placed('built', [['build', 'built']], [['check', 'ready']]) });
    // A first runner registers the worker, then dies with a claim live — the state file and
    // the server each hold half of it, as a killed process leaves them.
    const stateFile = join(tmpdir(), `baton-runner-${process.pid}-orphan.json`);
    rmSync(stateFile, { force: true });
    const first = makeRunner({ stateFile, session: 'orphan' } as Record<string, unknown>);
    await first.tick();
    const workerId = (await rows<{ id: number }>('SELECT id FROM workers'))[0].id;
    await rows(`INSERT INTO claims (ticket_id, worker_id, request_id, nonce, snapshot_sha, claimed_at, status, station, start_path, course_id)
                 VALUES ('docs:T-1', ?, 'seed:orphan', 'orphan1', '', ?, 'active', 'built', '[]', 'relay')`, workerId, clock.now);
    const orphan = (await rows<{ id: number }>('SELECT id FROM claims'))[0].id;
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
    state.claim = { id: orphan, ticket_id: 'docs:T-1', nonce: 'orphan1' };
    writeFileSync(stateFile, JSON.stringify(state));
    // The next process over that state file ends the orphan before claiming.
    const runner = makeRunner({ stateFile, session: 'orphan' } as Record<string, unknown>);
    // The orphan ends; the ticket becomes claimable again only after a reading follows the end
    // (§6.7) — the next idle attempt sees it, once the board refreshes.
    expect(await runner.runOnce()).toBeNull();
    // The orphan's lease-lost counts as a failed attempt (§6.10): the backoff passes, then a
    // reading makes the ticket claimable again.
    await setClock(clock.now + 2 * 60 * 60_000);
    await home.post({ 'T-1': placed('built', [['build', 'built']], [['check', 'ready']]) });
    const out = await runner.runOnce();
    expect(out).toMatchObject({ end_reason: 'suspended:checked' });
    expect(await rows<{ id: number; end_reason: string }>('SELECT id, end_reason FROM claims ORDER BY id')).toEqual([
      { id: orphan, end_reason: 'released:lease-lost' },
      expect.objectContaining({ end_reason: 'suspended:checked' }),
    ]);
  }, 30_000);

  it('a reaped worker re-keys on its next beat and carries on (R-BTN-14)', async () => {
    home.leg('check', `return { suspend: true, reached: 'checked' };`);
    home.commit();
    await home.post({ 'T-1': placed('built', [['build', 'built']], [['check', 'ready']]) });
    const runner = makeRunner();
    await runner.tick();
    const stateFile = (runner as unknown as { o: { stateFile: string } }).o.stateFile;
    const before = JSON.parse(readFileSync(stateFile, 'utf8')) as { secret: string };
    await rows(`UPDATE workers SET reaped_at = ?`, clock.now); // the alarm's verdict arrived
    await runner.tick(); // the beat that learns it and parks the re-key
    expect(JSON.parse(readFileSync(stateFile, 'utf8')).lease_lost).toBe(true);
    await runner.tick(); // the beat that re-keys
    expect(await rows(`SELECT reaped_at FROM workers`)).toEqual([{ reaped_at: null }]); // a new incarnation
    const after = JSON.parse(readFileSync(stateFile, 'utf8')) as { secret: string; incarnation: number };
    expect(after.secret).not.toBe(before.secret);
    expect(after.incarnation).toBe(2);
    expect(await runner.runOnce()).toMatchObject({ end_reason: 'suspended:checked' }); // serving again
  }, 30_000);

  it('a leg session never claims: the runner refuses to nest under IR_BATON_PARENT', async () => {
    // Through the real CLI entry (the bundle `baton run` runs), as a leg session would.
    const r = spawnSync(process.execPath, [resolve('cli/baton.mjs'), 'run'], {
      cwd: resolve('.'),
      env: { ...process.env, IR_BATON_PARENT: '7' },
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/IR_BATON_PARENT=7: a leg session never claims/);
  }, 60_000);

  it('the state file carries the runner across a restart: the same worker, not a second one', async () => {
    home.leg('build', `return { suspend: true, reached: 'built' };`);
    home.commit();
    await home.post({ 'T-1': placed('filed', [], [['build', 'ready']]) });
    const stateFile = join(tmpdir(), `baton-runner-${process.pid}-restart.json`);
    rmSync(stateFile, { force: true });
    const first = makeRunner({ stateFile, session: 'restart' } as Record<string, unknown>);
    expect(await first.runOnce()).toMatchObject({ end_reason: 'suspended:built' });
    first.stop();
    // A second runner over the same state file: its heartbeat authenticates as the worker the
    // first registered — the secret and the worker id are what survived (§6.4).
    const second = makeRunner({ stateFile, session: 'restart' } as Record<string, unknown>);
    await second.tick();
    expect(await rows('SELECT count(*) AS n FROM workers')).toEqual([{ n: 1 }]);
    expect(JSON.parse(readFileSync(stateFile, 'utf8')).worker_id).toBe(1);
  }, 30_000);

  it('nothing to claim: one idle attempt, no claim row', async () => {
    home.commit();
    await home.post({});
    expect(await makeRunner().runOnce()).toBeNull();
    expect(await rows('SELECT * FROM claims')).toEqual([]);
  }, 30_000);
});
