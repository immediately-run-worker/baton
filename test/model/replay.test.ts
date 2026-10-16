// replay.test.ts — model-based tests, the model's direction (R3-1244): `quint run --mbt` draws
// traces from model/replay.qnt (sim's instance, every action the harness can make the core
// take), and each trace drives the core on the local host — fake clock, the trace's choices —
// one model step at a time, comparing the core's state projection (test/integration/trace.ts)
// with the trace's state after every step. A difference is a step where the code and the
// checked model disagree. `REPLAY_TRACES` sets the count: 200 in `npm test`, more in CI's
// `model` job.
import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { adminSession, course, cutover, hbBody as baseHb, keyCall, ORIGIN, placed, sessionCall, rows, setAdminKeys, setClock, sha256, syncCall, ticket, tick, withCore, workerCall } from '../helpers';
import { makeKey, type TestKey } from '../lib/sshKeys';
import { projectState, type Projection } from '../integration/trace';
import { fromItf, kindOf, FROM, TO, LEGS } from '../../scripts/check-traces.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const COUNT = Number(process.env.REPLAY_TRACES ?? 200);
const SEED = process.env.REPLAY_SEED ?? '20261016';
const T0 = Date.parse('2026-10-16T12:00:00Z');
/** One model tick of Baton's clock: four make the shortest lease Baton grants (900 s). */
const TICK_MS = 225_000;
const CREDS = { w1: 'vm-a', w2: 'vm-b', w3: 'mac' } as const;
const TAGS = { w1: ['family:a'], w2: ['family:b'], w3: ['family:a'] } as const;
const TICKET = (t: string) => `T-${t.slice(1)}`;
const MAX_RUNS: Record<string, number> = { implement: 99, review: 3, fix: 2, adjudicate: 99, merge: 99 };
const REQUIRED = ['fix', 'merge'];
/** rlegs' holder bars: the other family, so the required bar is met and the holder not barred. */
const FAMILY_BARS = { w1: ['family:b'], w2: ['family:a'], w3: ['family:b'] } as const;

/** The traces, drawn once per run from model/replay.qnt's four relations: every actor's step
 *  (rstep), the happy path's (rprogress), whole tickets (rlegs) and fences (rfence) — so legs to
 *  fix and merge, ends, confirmations, reaps and fence timeouts are all reached (round 1, 1-A-5,
 *  1-B-3; the coverage test below holds the draw to it). */
const RELATIONS = ['rstep', 'rprogress', 'rlegs', 'rfence'];
function draw(): { file: string; states: any[] }[] {
  const per = Math.ceil(COUNT / RELATIONS.length);
  return RELATIONS.flatMap((r, k) => drawFrom(r, Math.min(per, COUNT - k * per)));
}

function drawFrom(step: string, n: number): { file: string; states: any[] }[] {
  if (n <= 0) return [];
  const dir = mkdtempSync(join(tmpdir(), 'baton-replay-'));
  const r = spawnSync('npx', ['quint', 'run', 'model/replay.qnt', '--main=replay', '--init=rinit', `--step=${step}`, '--backend=typescript',
    '--max-steps=40', `--max-samples=${n}`, `--n-traces=${n}`, '--mbt', `--seed=${SEED}`, `--out-itf=${join(dir, `${step}_{seq}.itf.json`)}`], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`quint run failed: ${r.stdout}${r.stderr}`);
  const out = readdirSync(dir).filter((f) => f.endsWith('.itf.json')).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
    .map((f) => ({ file: f, states: (JSON.parse(readFileSync(join(dir, f), 'utf8')).states as any[]).map((s) => ({
      st: fromItf(s['replay::baton::st']), action: s['mbt::actionTaken'] as string,
      picks: Object.fromEntries(Object.entries(s['mbt::nondetPicks'] as Record<string, { tag: string; value: unknown }>).filter(([, v]) => v.tag === 'Some').map(([k, v]) => [k, fromItf(v.value)])),
    })) }));
  rmSync(dir, { recursive: true, force: true });
  return out;
}

const traces = draw().filter((t) => !process.env.REPLAY_ONLY || t.file.startsWith(process.env.REPLAY_ONLY));
/** The core's answer to the last request a step made, for a failure's message. */
let lastAnswer = '';
const answered = async (res: Response) => {
  lastAnswer = `${res.status} ${(await res.clone().text()).slice(0, 300)}`;
  return res;
};

// ── driving the core ─────────────────────────────────────────────────────────────────────

interface Run {
  secrets: Record<string, string>;
  /** model claim id → Baton claim id */
  claims: Map<number, number>;
  /** sync slot → the number Baton handed out, and what the run read */
  numbers: Map<number, number>;
  owner: TestKey;
  /** the administrator's dashboard session, for the owner's dashboard actions */
  session: string;
  /** the last board post's answer, for a failure's message */
  last?: string;
  /** the bars the last advance sent: the core must store them as the leg's (round 1, 1-B-2) */
  sentBars?: { claim: number; bars: string[] };
}

const stationOf = (path: string[]) => path.reduce((_, l) => TO[l as keyof typeof TO], 'filed');
const runs = (path: string[], leg: string) => path.filter((l) => l === leg).length;

async function setup(): Promise<Run> {
  await setClock(T0);
  const admin = await makeKey('ssh-ed25519', 'admin');
  const owner = await makeKey('ssh-ed25519', 'owner');
  await setAdminKeys(admin);
  expect((await keyCall(admin, '/v1/admin/repositories', { id: 'docs', owner_keys_add: [owner.publicKey] })).status).toBe(200);
  // The model's required bar (R-BTN-67), docs': every leg but implement, review and adjudicate
  // must bar a family. Set before the trace, as the instance's constant.
  await rows(`UPDATE repositories SET required_bars = ? WHERE id = 'docs'`,
    JSON.stringify([{ course: 'roadmap-pr', leg: '*', except: ['implement', 'review', 'adjudicate'], tag_prefix: 'family:' }]));
  // The retry policy (§6.10, R-BTN-23) is not modelled: a reaped claim's ticket is claimable again
  // at once and never held for attempts. Written past checkRetry's floors on purpose — no owner
  // can set it, so a drawn re-claim after a reap meets the model's gates and nothing else.
  await rows(`UPDATE repositories SET retry = ? WHERE id = 'docs'`, JSON.stringify({ backoff_ms: [0], max_failed: 1000 }));
  // The board the model starts from: both tickets filed, nothing posted against them. One post
  // puts them there, so Baton's observation numbers run one ahead of the model's.
  const res = await syncCall('/v1/sync/board', { registry: [course()], sha: '0'.repeat(40), parent_sha: null, tickets: [ticket('T-1', { rank: 1 }), ticket('T-2', { rank: 2 })],
    closed: [], stations: { 'T-1': placed('filed', [], [['implement', 'ready']]), 'T-2': placed('filed', [], [['implement', 'ready']]) } });
  expect(res.status).toBe(200);
  const secrets: Record<string, string> = {};
  for (const [w, cred] of Object.entries(CREDS)) {
    secrets[w] = `secret-${w}`;
    const hb = await workerCall('/v1/runner/heartbeat', { cred, body: hbBody(w, { secret_hash: await sha256(secrets[w]) }) });
    expect(hb.status).toBe(200);
  }
  await cutover();
  return { secrets, claims: new Map(), numbers: new Map(), owner, session: await adminSession(admin) };
}

function hbBody(w: string, over: Record<string, unknown> = {}) {
  return baseHb(CREDS[w as keyof typeof CREDS], { session_name: `s-${w}`, lease_timeout_s: (4 * TICK_MS) / 1000, tags: [...TAGS[w as keyof typeof TAGS]], ...over });
}

const worker = async (w: string, path: string, body: unknown, secret: string) =>
  answered(await workerCall(path, { cred: CREDS[w as keyof typeof CREDS], secret, body }));

/** The core's side of one model step. */
async function drive(r: Run, before: any, after: any, action: string, p: Record<string, any>) {
  await setClock(T0 + after.st.now * TICK_MS);
  const b = before.st;
  const w: string = p.w;
  const active = (st: any, who: string) => Object.entries(st.claims as Record<string, any>).find(([, c]) => c.worker === who && c.status === 'active');
  switch (action) {
    case 'claimFinish': {
      // a crashed or sleeping machine makes no request; past MAX_CLAIMS is the model's bound only
      if (!b.up[w] || b.asleep[w] || b.nextId > 6) return;
      const t = b.pending[w];
      const res = await worker(w, '/v1/runner/claim', { request_id: `req-${w}-${after.st.nextId}-${Math.random().toString(16).slice(2, 8)}`, ticket_id: `docs:${TICKET(t)}` }, r.secrets[w]);
      const json = (await res.json()) as { claim_id?: number };
      if (after.st.nextId > b.nextId && json.claim_id) r.claims.set(b.nextId, json.claim_id);
      return;
    }
    case 'advance': {
      const [id, c] = active(b, w)!;
      const body = { leg: p.leg, bars: p.holderBars, ...(c.leg !== '' ? { reached: TO[c.leg as keyof typeof TO] } : {}) };
      await worker(w, `/v1/runner/claims/${r.claims.get(Number(id))}/advance`, body, r.secrets[w]);
      r.sentBars = { claim: r.claims.get(Number(id))!, bars: [...p.holderBars].sort() };
      return;
    }
    case 'endDoneAtEnd':
    case 'endClaim': {
      const [id, c] = active(b, w)!;
      const reach = p.b && c.leg !== '' && b.pushed[w];
      const station = reach ? TO[c.leg as keyof typeof TO] : c.station;
      const end_reason = p.kind === 'done' || action === 'endDoneAtEnd' ? 'done' : p.kind === 'suspended' ? `suspended:${station}` : 'released:requested';
      await worker(w, `/v1/runner/claims/${r.claims.get(Number(id))}/end`, { end_reason, reached: station }, r.secrets[w]);
      return;
    }
    case 'heartbeat':
      await heartbeat(r, w);
      return;
    case 'fenceCleared': {
      const fenced = Object.entries(b.claims as Record<string, any>).find(([, c]) => c.worker === w && c.fencePending);
      await heartbeat(r, w, { fenced: { claim_id: r.claims.get(Number(fenced![0])), terminated: true } });
      return;
    }
    case 'alarmReap':
    case 'fenceTimeout':
      await tick();
      return;
    case 'forceReap': {
      const [id] = active(b, w)!;
      await owner(r, `/v1/ui/claims/${r.claims.get(Number(id))}/reap`, { confirm: true });
      return;
    }
    case 'setHold':
      await owner(r, `/v1/ui/overrides/${encodeURIComponent(`docs:${TICKET(p.t)}`)}`, { hold: p.b });
      return;
    case 'setOwnerBar':
      await keyCall(r.owner, '/v1/owner/docs/bars', { course: '*', tag: p.tag, applies: p.applies, reason: 'replay' });
      return;
    case 'liftOwnerBars':
      for (const { id } of await rows<{ id: number }>('SELECT id FROM owner_bars WHERE lifted_at IS NULL')) await keyCall(r.owner, `/v1/owner/docs/bars/${id}/lift`, {});
      return;
    case 'ownerResolve':
      await owner(r, `/v1/ui/claims/${r.claims.get(p.i)}/resolve`, { action: 'confirm', confirm: true });
      return;
    case 'syncNumber': {
      const res = await syncCall('/v1/sync/observation', {});
      r.numbers.set(p.s, ((await res.json()) as { observation: number }).observation);
      return;
    }
    case 'syncPost': {
      const run = b.syncs[p.s];
      const tickets: unknown[] = [];
      const stations: Record<string, unknown> = {};
      const closed: { id: string; as: 'withdrawn' }[] = [];
      for (const t of ['t1', 't2']) {
        const id = TICKET(t);
        if (run.gone[t]) { closed.push({ id, as: 'withdrawn' }); continue; }
        const path: string[] = run.git[t];
        const st = stationOf(path);
        const next = st === 'merged' ? [] : (LEGS as string[]).filter((l: string) => FROM[l as keyof typeof FROM].includes(st) && runs(path, l) < MAX_RUNS[l]).map((l: string) => [l, 'ready'] as [string, 'ready']);
        tickets.push(ticket(id, { rank: Number(t.slice(1)) }));
        const bars = run.bars[t].length ? Object.fromEntries(REQUIRED.map((l) => [l, run.bars[t]])) : {};
        let at = 'filed';
        stations[id] = placed(st, path.map((l) => { at = TO[l as keyof typeof TO]; return [l, at] as [string, string]; }), next, { bars });
      }
      const head = (await rows<{ sha: string }>(`SELECT sha FROM board_head WHERE repository_id = 'docs'`))[0].sha;
      const sha = (BigInt(`0x${head}`) + 1n).toString(16).padStart(40, '0');
      const res = await syncCall('/v1/sync/board', { registry: [course()], sha, parent_sha: head, tickets, closed, stations, observation: r.numbers.get(p.s) ?? -1 });
      r.last = `${res.status} ${await res.text()}`;
      return;
    }
    default:
      // claimStart, the holder's pushes, git, time, a machine crashing, sleeping or waking: the
      // core takes no step
      return;
  }
}

/** A heartbeat; a worker the alarm reaped re-keys first (R-BTN-14: its old secret is refused). */
async function heartbeat(r: Run, w: string, over: Record<string, unknown> = {}) {
  const reaped = (await rows<{ reaped_at: number | null }>('SELECT reaped_at FROM workers WHERE session_name = ?', `s-${w}`))[0]?.reaped_at != null;
  if (reaped) {
    r.secrets[w] = `secret-${w}-${Math.random().toString(16).slice(2, 8)}`;
    await worker(w, '/v1/runner/heartbeat', hbBody(w, { rekey: true, secret_hash: await sha256(r.secrets[w]), ...over }), r.secrets[w]);
  } else await worker(w, '/v1/runner/heartbeat', hbBody(w, over), r.secrets[w]);
}

const owner = async (r: Run, path: string, body: unknown) =>
  answered(await sessionCall(r.session, path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));

// ── comparing ────────────────────────────────────────────────────────────────────────────

const obs = (n: number) => (n < 0 ? n : n + 1);

/** The differences between the model's state and the core's projection, as `field: model ≠ core`. */
function differences(m: any, core: Projection, r: Run): string[] {
  const d: string[] = [];
  const eq = (name: string, a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) d.push(`${name}: model ${JSON.stringify(a)} ≠ core ${JSON.stringify(b)}`); };
  eq('counter', obs(m.counter), core.counter);
  eq('lastAccepted', obs(m.lastAccepted), core.lastAccepted);
  for (const t of ['t1', 't2']) {
    const id = `docs:${TICKET(t)}`;
    const v = core.tickets[id];
    if (m.postedGone[t]) eq(`${t} withdrawn`, true, v?.closed === 'withdrawn');
    else {
      eq(`${t} posted`, m.posted[t], v?.path ?? null);
      // the model's one bar set stands for the covered legs' (round 1, 1-A-4)
      const bars = [...(m.postedBars[t] as string[])].sort();
      eq(`${t} postedBars`, REQUIRED.map(() => bars), REQUIRED.map((l) => [...(v?.bars[l] ?? [])].sort()));
    }
    eq(`${t} held`, m.held[t], core.held[id] ?? false);
  }
  eq('ownerBars', [...new Set((m.ownerBars as { tag: string; applies: string }[]).map((b) => `${b.tag}|${b.applies}`))].sort(),
    [...new Set(core.ownerBars.map((b) => `${b.tag}|${b.applies}`))].sort());
  if (r.sentBars) {
    const k = core.claims[String(r.sentBars.claim)];
    if (k?.status === 'active') eq('the advance\'s bars', r.sentBars.bars, [...k.legBars].sort());
    r.sentBars = undefined;
  }
  const ids = Object.keys(m.claims).map(Number).sort((a, b) => a - b);
  eq('claims', ids.map((i) => r.claims.get(i) ?? null), Object.keys(core.claims).map(Number).sort((a, b) => a - b));
  for (const i of ids) {
    const c = m.claims[i];
    const k = core.claims[String(r.claims.get(i))];
    if (!k) continue;
    eq(`claim ${i} ticket`, `docs:${TICKET(c.ticket)}`, k.ticket);
    eq(`claim ${i} status`, c.status, k.status);
    eq(`claim ${i} kind`, c.kind, kindOf(k.endReason));
    eq(`claim ${i} station`, c.station, k.station);
    // a reaped claim keeps its leg in the model, as its worker's view (a push it may still try);
    // the core keeps no worker's view: compared while the claim is active
    if (c.status === 'active') eq(`claim ${i} leg`, c.leg, k.leg);
    eq(`claim ${i} finished`, c.finished, k.finished);
    eq(`claim ${i} startPath`, c.startPath, k.startPath);
    eq(`claim ${i} claimObs`, obs(c.claimObs), k.claimObs);
    eq(`claim ${i} endObs`, obs(c.endObs), k.endObs);
    eq(`claim ${i} regressed`, c.regressed, k.regressed);
    eq(`claim ${i} endedRegressed`, c.endedRegressed, k.endedRegressed);
    eq(`claim ${i} confirmed`, c.confirmed, k.confirmed);
    eq(`claim ${i} fencePending`, c.fencePending, k.fencePending);
    if (d.some((x) => x.startsWith(`claim ${i} `))) d.push(`claim ${i}: model ${JSON.stringify({ ...c, startBars: undefined })} core ${JSON.stringify(k)}`);
  }
  return d;
}

describe('the draw reaches what it is for (round 1, 1-A-5, 1-B-3)', () => {
  it('legs to fix and merge, multi-leg claims, a confirmed done, reaps and fence timeouts', () => {
    if (process.env.REPLAY_ONLY) return;
    const count = { fix: 0, merge: 0, multi: 0, confirmedDone: 0, alarmReap: 0, fenceTimeout: 0, fenceCleared: 0, regressed: 0 };
    for (const t of traces) {
      for (const s of t.states) if (s.action in count) count[s.action as keyof typeof count]++;
      for (const c of Object.values(t.states.at(-1)!.st.claims) as any[]) {
        const legs = [...c.finished, ...(c.leg ? [c.leg] : [])];
        if (legs.includes('fix')) count.fix++;
        if (legs.includes('merge')) count.merge++;
        if (legs.length >= 2) count.multi++;
        if (c.kind === 'done' && c.confirmed) count.confirmedDone++;
      }
      if (t.states.some((s) => Object.values(s.st.claims as Record<string, any>).some((c) => c.regressed))) count.regressed++;
    }
    const floor = Math.max(1, Math.floor(COUNT / 200));
    expect(count).toMatchObject({ fix: expect.toSatisfy((n: number) => n >= floor), merge: expect.toSatisfy((n: number) => n >= floor),
      multi: expect.toSatisfy((n: number) => n >= 10 * floor), confirmedDone: expect.toSatisfy((n: number) => n >= floor),
      alarmReap: expect.toSatisfy((n: number) => n >= floor), fenceTimeout: expect.toSatisfy((n: number) => n >= floor),
      fenceCleared: expect.toSatisfy((n: number) => n >= floor) });
  });
});

describe(`model-based tests: ${traces.length} traces drawn from model/replay.qnt drive the core`, () => {
  beforeEach(async () => {
    await setClock(T0);
  });

  it.each(traces.map((t, k) => [k, t] as const))('trace %i', async (_k, trace) => {
    const r = await setup();
    for (let i = 1; i < trace.states.length; i++) {
      const before = trace.states[i - 1];
      const after = trace.states[i];
      lastAnswer = 'no request';
      // rprogress passes its literals (`endClaim(w, kind, true)`, `syncNumber(1)`): no nondet pick
      // rprogress, rlegs and rfence pass literals (`endClaim(w, kind, true)`, `syncNumber(1)`, the
      // holder's bars): no nondet pick for them
      const literal: Record<string, unknown> = { b: true, s: 1 };
      if (trace.file.startsWith('rlegs')) literal.holderBars = FAMILY_BARS[after.picks.w as keyof typeof FAMILY_BARS];
      if (trace.file.startsWith('rfence')) literal.holderBars = [];
      if (after.action === 'endDoneAtEnd') literal.kind = 'done';
      const picks = trace.file.startsWith('rstep') ? after.picks : { ...literal, ...after.picks };
      await drive(r, before, after, after.action, picks);
      const core = await withCore((c) => projectState(c.store, c.now()));
      const d = differences(after.st, core, r);
      if (d.length && after.action === 'syncPost') d.push(`post: ${r.last}`);
      else if (d.length) d.push(`core answered: ${lastAnswer}`);
      expect([`${trace.file} step ${i} ${after.action}(${JSON.stringify(after.picks)})`, d]).toEqual([`${trace.file} step ${i} ${after.action}(${JSON.stringify(after.picks)})`, []]);
    }
  });
});
