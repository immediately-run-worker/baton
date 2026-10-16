// trace.ts — every scenario's run as a trace the formal model can accept or reject (R3-1244;
// BATON_SPEC §13a R-BTN-29–31, §4 `events`). The local host records each request and each alarm
// tick as one step with the state projection after it; `scripts/check-traces.mjs` replays the
// steps through model/baton.qnt. Only the local project records: the two hosts run the same
// core (S-BTN-31), so one trace per scenario test is the record.
//
// The projection is the model's state, nothing more (the item's decision): the head's
// observation numbers, each ticket of the model's repository and course as the head posts it,
// claims with their legs, holds, owner bars, the workers' tags and the required bar — read from
// the Store, never from wall-clock time (the scenarios' fake clock is the model's clock, and the
// model's time is abstract). What the model abstracts (other repositories, other courses — its
// README's "Not modelled") is left out of the projection, not out of the trace: a step on them
// is still recorded, and must leave the projection as it was.
import type { Store } from '../../src/core/ports';

/** The repository and course the model is written against (model/README.md). */
export const MODEL_REPOSITORY = 'docs';
export const MODEL_COURSE = 'roadmap-pr';

export interface TicketView {
  present: boolean;
  /** Scope evidence, not model state: what R-BTN-35's other "taken away" (a re-tier) and docs'
   *  interim status read, so the checker can tell those apart from a withdrawal. */
  tier: string | null;
  status: string | null;
  path: string[];                  // ticket_stations.path, as leg names
  closed: 'done' | 'withdrawn' | null;
  bars: Record<string, string[]>;  // ticket_bars, per leg
}
export interface ClaimView {
  ticket: string;
  worker: number;
  status: string;
  endReason: string | null;
  station: string;
  leg: string;
  finished: string[];
  legBars: string[];               // the running leg's bars, as the holder gave them
  startPath: string[];
  claimObs: number;
  endObs: number;
  regressed: boolean;
  endedRegressed: boolean;
  confirmed: boolean;
  fencePending: boolean;
}
export interface Projection {
  counter: number;
  lastAccepted: number;
  outstanding: boolean;
  tickets: Record<string, TicketView>;
  claims: Record<string, ClaimView>;
  held: Record<string, boolean>;
  ownerBars: { tag: string; applies: string; course: string; legs: string[] }[];
  workers: Record<string, string[]>;
  required: { course: string; leg: string; except?: string[]; tag_prefix: string }[];
  /** Courses of the model's repository whose file is not the model's (R-BTN-64: not modelled). */
  courseFile: string | null;
  /** Each worker's last call and lease, by the core's clock: the checker's evidence that an
   *  alarm reap or fence timeout came after the lease ran out. Not a reason to record a step. */
  liveness: Record<string, { lastSeen: number; lease: number }>;
}

const legsOf = (json: string | null): string[] => (json ? (JSON.parse(json) as { leg: string }[]).map((s) => s.leg) : []);

/** The model's state, read from the Store after a request (one transaction's view). */
export function projectState(store: Store, now: number): Projection {
  const rows = <T>(q: string, ...p: unknown[]) => store.exec<T>(q, ...p).toArray();
  const head = rows<{ observation: number; last_handed_out: number; handed_out_at: number | null }>(
    'SELECT observation, last_handed_out, handed_out_at FROM board_head WHERE repository_id = ?', MODEL_REPOSITORY)[0];
  const tickets: Record<string, TicketView> = {};
  const inScope = (id: string) => id.startsWith(`${MODEL_REPOSITORY}:`);
  for (const t of rows<{ id: string; course_id: string | null; path: string | null; tier: string | null; status: string | null }>(
    `SELECT t.id, t.course_id, s.path, t.tier, t.status FROM tickets t LEFT JOIN ticket_stations s ON s.ticket_id = t.id WHERE t.repository_id = ?`, MODEL_REPOSITORY)) {
    if ((t.course_id ?? MODEL_COURSE) !== MODEL_COURSE) continue;
    tickets[t.id] = { present: true, path: legsOf(t.path), closed: null, bars: {}, tier: t.tier, status: t.status };
  }
  for (const b of rows<{ ticket_id: string; leg: string; tag: string }>('SELECT ticket_id, leg, tag FROM ticket_bars ORDER BY ticket_id, leg, tag')) {
    const t = tickets[b.ticket_id];
    if (t) (t.bars[b.leg] ??= []).push(b.tag);
  }
  for (const c of rows<{ ticket_id: string; closed_as: 'done' | 'withdrawn' }>('SELECT ticket_id, closed_as FROM closed_tickets')) {
    if (!inScope(c.ticket_id) || tickets[c.ticket_id]?.present) continue;
    tickets[c.ticket_id] = { present: false, path: [], closed: c.closed_as, bars: {}, tier: null, status: null };
  }
  const claims: Record<string, ClaimView> = {};
  for (const c of rows<{ id: number; ticket_id: string; worker_id: number; status: string; end_reason: string | null; station: string | null; leg: string | null;
    start_path: string; claim_observation: number; end_observation: number | null; regressed_since: number | null; ended_regressed: number;
    confirmed_at: number | null; fence_pending: number; course_id: string | null }>(
    `SELECT id, ticket_id, worker_id, status, end_reason, station, leg, start_path, claim_observation, end_observation, regressed_since, ended_regressed,
            confirmed_at, fence_pending, course_id FROM claims ORDER BY id`)) {
    if (!inScope(c.ticket_id) || (c.course_id ?? MODEL_COURSE) !== MODEL_COURSE) continue;
    const legs = rows<{ leg: string; to_station: string | null; bars: string; finished_at: number | null; abandoned_at: number | null }>(
      'SELECT leg, to_station, bars, finished_at, abandoned_at FROM claim_legs WHERE claim_id = ? ORDER BY seq', c.id);
    const running = legs.find((l) => l.to_station == null && l.abandoned_at == null && l.finished_at == null);
    claims[String(c.id)] = {
      ticket: c.ticket_id, worker: c.worker_id, status: c.status, endReason: c.end_reason, station: c.station ?? '', leg: c.leg ?? '',
      finished: legs.filter((l) => l.to_station != null).map((l) => l.leg), legBars: running ? (JSON.parse(running.bars) as string[]) : [],
      startPath: legsOf(c.start_path), claimObs: c.claim_observation, endObs: c.end_observation ?? -1,
      regressed: c.regressed_since != null, endedRegressed: c.ended_regressed === 1, confirmed: c.confirmed_at != null, fencePending: c.fence_pending === 1,
    };
  }
  const held: Record<string, boolean> = {};
  for (const o of rows<{ ticket_id: string; hold: number }>('SELECT ticket_id, hold FROM ticket_overrides')) if (inScope(o.ticket_id)) held[o.ticket_id] = o.hold === 1;
  const ownerBars = rows<{ tag: string; applies: string; course: string; legs: string }>(
    `SELECT tag, applies, course, legs FROM owner_bars WHERE repository_id = ? AND lifted_at IS NULL AND starts_at <= ? AND (ends_at IS NULL OR ends_at > ?)
       AND (course = '*' OR course = ?) ORDER BY id`, MODEL_REPOSITORY, now, now, MODEL_COURSE)
    .map((b) => ({ tag: b.tag, applies: b.applies, course: b.course, legs: JSON.parse(b.legs) as string[] }));
  const workers: Record<string, string[]> = {};
  const liveness: Projection['liveness'] = {};
  for (const w of rows<{ id: number; last_seen_at: number; lease_timeout_ms: number }>('SELECT id, last_seen_at, lease_timeout_ms FROM workers ORDER BY id')) {
    workers[String(w.id)] = [];
    liveness[String(w.id)] = { lastSeen: w.last_seen_at, lease: w.lease_timeout_ms };
  }
  for (const t of rows<{ worker_id: number; tag: string }>('SELECT worker_id, tag FROM worker_tags ORDER BY worker_id, tag')) (workers[String(t.worker_id)] ??= []).push(t.tag);
  const repo = rows<{ required_bars: string | null }>('SELECT required_bars FROM repositories WHERE id = ?', MODEL_REPOSITORY)[0];
  const course = rows<{ course_json: string }>('SELECT course_json FROM courses WHERE repository_id = ? AND id = ?', MODEL_REPOSITORY, MODEL_COURSE)[0];
  return {
    counter: head?.last_handed_out ?? 0,
    lastAccepted: head?.observation ?? 0,
    outstanding: head?.handed_out_at != null && now - head.handed_out_at < 10 * 60_000,
    tickets, claims, held, ownerBars, workers,
    required: repo?.required_bars ? JSON.parse(repo.required_bars) : [],
    courseFile: course?.course_json ?? null,
    liveness,
  };
}

// ── the recorder ─────────────────────────────────────────────────────────────────────────
// A step is taken at each commit that moves the projection — the outermost transaction, or a
// write outside one — and credited to the request or alarm tick whose code ran it (an
// AsyncLocalStorage context the local host sets around each). One request is one step, or two
// when it commits on both sides of an await (R3-1243's actors: the pre/post-await halves); the
// harness's own writes between requests (a test's SQL) are `harness` steps, never Baton's.

export interface Origin {
  kind: 'request' | 'alarm';
  method?: string;
  path?: string;
  body?: unknown;
  status?: number;
  response?: unknown;
}
export interface Step {
  kind: 'request' | 'alarm' | 'harness';
  origin: Origin | null;
  now: number;
  state: Projection;
}

/** The projection a step is taken on: liveness moves at every call and never makes a step. */
const key = (p: Projection) => JSON.stringify({ ...p, liveness: undefined });

let steps: Step[] = [];
let last = key(empty());
/** A projection that failed after the migrations: the test's trace is void, and says so. */
let failure: string | null = null;

/** The projection after a commit: a step when it moved. */
export function committed(state: Projection, origin: Origin | null, now: number): void {
  const s = key(state);
  if (s === last) return;
  last = s;
  // One request is one action: its consecutive commits (a board post uses its number, then
  // writes) are one step. Another request's commit between them keeps them apart.
  const prev = steps.at(-1);
  if (prev && origin && prev.origin === origin) {
    prev.state = state;
    prev.now = now;
    return;
  }
  steps.push({ kind: origin?.kind ?? 'harness', origin, now, state });
}

/** A new Baton has started: its state is the trace's start, whatever the start seeded. */
export function beginTrace(store: Store, now: number): void {
  steps = [];
  failure = null;
  last = key(projectState(store, now));
}

/** The steps so far, and a fresh start (each test begins from an empty Baton). */
export function takeSteps(): Step[] {
  const out = steps;
  const f = failure;
  steps = [];
  failure = null;
  last = key(empty());
  // round 1, 1-A-7: a projection that failed is never a quietly shorter trace
  if (f) throw new Error(`the trace could not be recorded: ${f}`);
  return out;
}

/** A Store that reports each commit — what the local host runs on while tests record. */
export function recordingStore(inner: Store, origin: () => Origin | null, now: () => number): Store {
  let depth = 0;
  let projecting = false;
  const after = () => {
    if (projecting) return;
    projecting = true;
    try {
      committed(projectState(inner, now()), origin(), now());
    } catch (e) {
      // Before the migrations have run there is no state to project; any other error voids the
      // test's trace (round 1, 1-A-7).
      if (!/no such table/.test(String(e))) failure ??= String(e);
    } finally {
      projecting = false;
    }
  };
  return {
    exec<T>(query: string, ...params: unknown[]) {
      const cursor = inner.exec<T>(query, ...params);
      if (depth === 0 && !projecting && !/^\s*(SELECT|WITH|PRAGMA)\b/i.test(query)) after();
      return cursor;
    },
    script(sql) {
      inner.script(sql);
    },
    transaction(fn) {
      depth++;
      try {
        return inner.transaction(fn);
      } finally {
        if (--depth === 0) after();
      }
    },
  };
}

function empty(): Projection {
  return { counter: 0, lastAccepted: 0, outstanding: false, tickets: {}, claims: {}, held: {}, ownerBars: [], workers: {}, required: [], courseFile: null, liveness: {} };
}

// ── ITF (https://apalache-mc.org/docs/adr/015adr-trace.html) ─────────────────────────────

/** A JSON value in ITF's encoding: integers as `#bigint`, string-keyed objects as records.
 *  Maps keyed by ids stay records (their keys are strings); the checker reads them back. */
export function itf(v: unknown): unknown {
  if (typeof v === 'number' && Number.isInteger(v)) return { '#bigint': String(v) };
  if (Array.isArray(v)) return v.map(itf);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, itf(x)]));
  return v;
}

/** The trace file's content: ITF with one variable, `baton`, and each step's request in `#meta`. */
export function toItf(scenario: string, test: string, trace: Step[]): unknown {
  return {
    '#meta': { format: 'ITF', 'format-description': 'https://apalache-mc.org/docs/adr/015adr-trace.html', source: scenario, description: test,
      producer: 'test/integration/trace.ts (R3-1244)' },
    vars: ['baton'],
    states: trace.map((s, i) => ({
      '#meta': { index: i, kind: s.kind, ...(s.origin ?? {}), now: s.now },
      baton: itf(s.state),
    })),
  };
}
