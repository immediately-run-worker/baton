#!/usr/bin/env node
// check-traces.mjs — replay each scenario's trace through the formal model (R3-1244; BATON_SPEC
// §13a R-BTN-29–31): test/integration/trace.ts writes one ITF trace per scenario test, the
// steps Baton took with the state projection after each; this turns each into a deterministic
// Quint run of model/baton.qnt — Baton's action, with the environment's steps that make it
// possible (the holder's push, git moving, time passing), then the projection the model must
// have reached — and fails naming the scenario, the step and the model action that would not
// accept it. A rejected trace is a step the implementation took that the checked model forbids.
//
// What the model abstracts (model/README.md, "Not modelled": other repositories, other
// courses, course changes, held histories, tiers and grants) the recorder already leaves out
// of the projection. A step the model has no action for — a claim the harness wrote itself, a
// course file that is not the model's, a required bar changed under a run — ends the part of
// the trace the model can judge; the checked prefix and the reason are printed for every trace,
// every such stop is pinned in test/integration/trace-scope.json (a new or moved one fails), and
// nothing is filtered to make a trace pass. `--write-scope` rewrites that list from a run.
//
//   node scripts/check-traces.mjs [trace files or directories]   (default: test/.traces)
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'test', '.traces', '.qnt');

// ── the model's course and constants (model/baton.qnt) ───────────────────────────────────
export const START = 'filed';
/** R-BTN-35's git statuses that end an item (src/core/claims.ts GIT_ENDS). */
const GIT_ENDS = ['done', 'superseded', 'deferred', 'deprioritized'];
export const LEGS = ['implement', 'review', 'fix', 'adjudicate', 'merge'];
export const FROM = { implement: ['filed'], review: ['pr-open', 'fixed'], fix: ['reviewed'], adjudicate: ['reviewed'], merge: ['reviewed', 'adjudicated'] };
export const TO = { implement: 'pr-open', review: 'reviewed', fix: 'fixed', adjudicate: 'adjudicated', merge: 'merged' };
const TIMEOUT = 4;
/** R-BTN-62: Baton voids an outstanding observation number at this age (src/core/observations.ts). */
const OBSERVATION_TTL_MS = 10 * 60_000;
const stationOf = (path) => path.reduce((_, l) => TO[l], START);
const COURSE = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'courses', 'roadmap-pr', 'course.json'), 'utf8'));

// ── ITF back to JSON ─────────────────────────────────────────────────────────────────────
export function fromItf(v) {
  if (Array.isArray(v)) return v.map(fromItf);
  if (v && typeof v === 'object') {
    if ('#bigint' in v) return Number(v['#bigint']);
    if ('#set' in v) return v['#set'].map(fromItf);
    if ('#map' in v) return Object.fromEntries(v['#map'].map(([k, x]) => [fromItf(k), fromItf(x)]));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fromItf(x)]));
  }
  return v;
}

export function readTrace(file) {
  const t = JSON.parse(readFileSync(file, 'utf8'));
  return { scenario: t['#meta']?.source ?? basename(dirname(file)), test: t['#meta']?.description ?? basename(file), steps: t.states.map((s) => ({ ...s['#meta'], state: fromItf(s.baton) })) };
}

// ── Quint literals ───────────────────────────────────────────────────────────────────────
const q = (s) => JSON.stringify(String(s));
const qList = (xs) => `List(${xs.map(q).join(', ')})`;
const qSet = (xs) => (xs.length ? `Set(${[...new Set(xs)].sort().map(q).join(', ')})` : 'Set()');
const sameSet = (a, b) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());

/** The model's `kind` for an end reason (§6.5). */
export function kindOf(endReason) {
  if (endReason == null) return '';
  if (endReason === 'done') return 'done';
  if (endReason.startsWith('suspended:')) return 'suspended';
  if (endReason === 'released:stale-board') return 'stale';
  if (endReason.startsWith('released:')) return 'release';
  if (endReason.startsWith('reaped:')) return 'reap';
  return `?${endReason}`;
}

/** The shortest legs from where `path` leaves a ticket to an end station, along edges. */
function toEnd(path) {
  const seen = new Set([stationOf(path)]);
  let frontier = [[...path]];
  while (frontier.length) {
    const next = [];
    for (const p of frontier) {
      const st = stationOf(p);
      if (COURSE.end.includes(st)) return p;
      for (const l of LEGS) if (FROM[l].includes(st) && !seen.has(TO[l])) { seen.add(TO[l]); next.push([...p, l]); }
    }
    frontier = next;
  }
  return null;
}

/** The legs a required bar covers in the model's course (R-BTN-67). */
function requiredLegs(required) {
  const legs = new Set();
  for (const r of required) {
    if (r.course !== '*' && r.course !== 'roadmap-pr') continue;
    if (r.leg === '*') for (const l of LEGS) { if (!(r.except ?? []).includes(l)) legs.add(l); }
    else legs.add(r.leg);
  }
  return [...legs].sort();
}

// ── one trace → one Quint run ────────────────────────────────────────────────────────────

/**
 * Translate a trace into model steps. Returns `{ consts, steps: [{ index, label, actions,
 * expect: [[name, expr]] }], end: { index, reason } | null }`: `end` is the first step the model
 * has no action for; the steps before it are the trace's checked part.
 */
export function translate(trace) {
  const states = trace.steps.map((s) => s.state);
  const empty = { counter: 0, lastAccepted: 0, outstanding: false, tickets: {}, claims: {}, held: {}, ownerBars: [], workers: {}, required: [], courseFile: null };
  // The constants: every ticket and worker the trace names; each worker's tags as it first
  // acts; the required bar in force at the first worker action.
  const tickets = new Set();
  const workers = new Set();
  for (const s of states) {
    for (const t of Object.keys(s.tickets)) tickets.add(t);
    for (const t of Object.keys(s.held)) tickets.add(t);
    for (const c of Object.values(s.claims)) { tickets.add(c.ticket); workers.add(String(c.worker)); }
  }
  const W = (id) => `w${id}`;
  const tags = {};
  for (const w of workers) {
    const first = states.find((s) => Object.values(s.claims).some((c) => String(c.worker) === w));
    tags[w] = first?.workers[w] ?? [];
  }
  const firstAct = states.findIndex((s) => Object.keys(s.claims).length > 0);
  const required = firstAct >= 0 ? states[firstAct].required : (states.at(-1)?.required ?? []);
  const prefixes = required.map((r) => r.tag_prefix);
  const allTags = new Set();
  for (const s of states) {
    for (const ts of Object.values(s.workers)) ts.forEach((t) => allTags.add(t));
    for (const tv of Object.values(s.tickets)) Object.values(tv.bars).flat().forEach((t) => allTags.add(t));
    for (const c of Object.values(s.claims)) c.legBars.forEach((t) => allTags.add(t));
    for (const b of s.ownerBars) allTags.add(b.tag);
  }
  const REQUIRED = requiredLegs(required);
  const FAMILIES = [...allTags].filter((t) => prefixes.some((p) => t.startsWith(p)));
  const T = tickets.size ? [...tickets].sort() : ['t0'];
  const WS = workers.size ? [...workers].sort((a, b) => a - b).map(W) : ['w0'];
  const claimIds = Object.keys(states.at(-1)?.claims ?? {}).length;
  const consts = {
    TICKETS: `Set(${T.map(q).join(', ')})`,
    WORKERS: `Set(${WS.map(q).join(', ')})`,
    SLOTS: 'Set(1, 2)',
    MAX_CLAIMS: claimIds + 2,
    GIT_BUDGET: 100000,
    OWNER_BUDGET: 100000,
    FAMILIES: qSet(FAMILIES),
    TAGS: `Map(${WS.map((w) => `${q(w)} -> ${qSet(tags[w.slice(1)] ?? [])}`).join(', ')})`,
    REQUIRED: qSet(REQUIRED),
    MAX_TIME: 100000,
  };

  // The environment the model has and Baton cannot see: git, each sync run's phase, the claim
  // ids the model hands out.
  const env = {
    git: Object.fromEntries(T.map((t) => [t, []])),
    withdrawn: Object.fromEntries(T.map((t) => [t, false])),
    posted: Object.fromEntries(T.map((t) => [t, []])),
    gone: Object.fromEntries(T.map((t) => [t, false])),
    bars: Object.fromEntries(T.map((t) => [t, []])),
    seen: Object.fromEntries(T.map((t) => [t, false])),
    slots: { 1: { phase: 'idle', obs: 0, voided: false, at: 0 }, 2: { phase: 'idle', obs: 0, voided: false, at: 0 } },
    ids: {},
    nextId: 1,
    claimTier: {}, // each claim's ticket tier when it was made (R-BTN-35's re-tier)
  };
  const out = [];
  let prev = empty;
  for (let i = 0; i < trace.steps.length; i++) {
    const step = trace.steps[i];
    const r = translateStep(step, prev, env, { W, tags, required, REQUIRED });
    if (r.reject) return { consts, steps: out, end: null, reject: { index: i, label: label(step), reason: r.reject }, total: trace.steps.length };
    if (r.end) return { consts, steps: out, end: { index: i, reason: r.end }, total: trace.steps.length };
    out.push({ index: i, label: label(step), actions: r.actions, expect: expectations(step.state, env, T, W) });
    prev = step.state;
  }
  return { consts, steps: out, end: null, total: trace.steps.length };
}

const label = (s) => (s.kind === 'request' ? `${s.method} ${s.path} → ${s.status}` : s.kind);

/** The model actions one recorded step stands for, or `{end: reason}`. */
function translateStep(step, P, env, k) {
  const Q = step.state;
  const acts = [];
  const path = step.path ?? '';
  const origin = step.kind === 'request' ? path.replace(/\?.*$/, '') : step.kind;
  if (Q.courseFile && JSON.stringify(JSON.parse(Q.courseFile)) !== JSON.stringify(COURSE)) return { end: 'a roadmap-pr course file other than the model’s (R-BTN-64, course changes: not modelled)' };
  if (Object.keys(Q.claims).length && JSON.stringify(Q.required) !== JSON.stringify(k.required)) return { end: 'the required bar changed under a run (the model’s REQUIRED is constant)' };
  // A worker's tags matter to the model only at its own claims and advances (rule 8, R-BTN-67):
  // there they must be the tags it first claimed with.
  const sameTags = (worker) => JSON.stringify(Q.workers[String(worker)] ?? []) === JSON.stringify(k.tags[String(worker)] ?? []);
  for (const b of Q.ownerBars) if (b.legs.length) return { end: 'an owner bar on named legs (the model’s owner bars bar every leg)' };
  if (step.kind === 'harness' && JSON.stringify(P.claims) !== JSON.stringify(Q.claims)) return { end: 'the harness wrote a claim (a state Baton did not reach)' };
  const silent = (worker) => {
    const l = Q.liveness?.[String(worker)];
    return !!l && step.now - l.lastSeen >= l.lease;
  };
  for (const [id, d] of Object.entries(Q.claims)) {
    const c = P.claims[id];
    // R-BTN-35's other "taken away": a re-tier since the claim, or docs' interim status at one
    // that ends the item (claims.ts GIT_ENDS) — only when the post shows one (round 1, 1-A-3).
    // The status may have been posted earlier, by a reading not numbered after the claim.
    if (c?.status === 'active' && d.endReason === 'released:stale-board' && Q.tickets[d.ticket]?.present) {
      const after = Q.tickets[d.ticket];
      if (GIT_ENDS.includes(after.status) || (id in env.claimTier && env.claimTier[id] !== after.tier)) {
        return { end: `claim ${id} released stale on its ticket's re-tier or interim status (R-BTN-35; tiers are not modelled)` };
      }
      return { reject: `claim ${id} released stale with its ticket still posted, neither withdrawn nor re-tiered` };
    }
    // docs' interim confirmation by the post's own list, naming this claim (round 1, 1-A-3)
    if (c && !c.confirmed && d.confirmed && origin === '/v1/sync/board' && step.body?.state
      && (step.body.confirmations ?? []).some((x) => String(x?.claim_id) === id)) {
      return { end: `claim ${id} confirmed by the interim post's confirmations (docs' interim shape, not modelled)` };
    }
  }

  // Owner acts — holds and owner bars (§8, R-BTN-67).
  for (const t of new Set([...Object.keys(P.held), ...Object.keys(Q.held)])) {
    if (!!P.held[t] !== !!Q.held[t]) acts.push(`setHold(${q(t)}, ${!!Q.held[t]})`);
  }
  const barKey = (b) => `${b.tag}|${b.applies}`;
  const pb = [...new Set(P.ownerBars.map(barKey))].sort();
  const qb = [...new Set(Q.ownerBars.map(barKey))].sort();
  if (JSON.stringify(pb) !== JSON.stringify(qb)) {
    if (pb.length) acts.push('liftOwnerBars');
    for (const b of qb) { const [tag, applies] = b.split('|'); acts.push(`setOwnerBar(${q(tag)}, ${q(applies)})`); }
  }

  // The sync: numbers handed out (R-BTN-62). One outstanding at a time: an earlier number is
  // voided only once it is 10 minutes old by Baton's clock (round 1, 1-A-1).
  for (let n = P.counter + 1; n <= Q.counter; n++) {
    if (origin !== '/v1/sync/observation') return { reject: `observation ${n} handed out by ${origin}` };
    for (const s of [1, 2]) {
      const sl = env.slots[s];
      if ((sl.phase === 'numbered' || sl.phase === 'read') && !sl.voided) {
        if (step.now - sl.at < OBSERVATION_TTL_MS) return { reject: `observation ${n} handed out while ${sl.obs} is outstanding and under 10 minutes old (R-BTN-62: sync-busy)` };
        acts.push(`syncVoid(${s})`);
        sl.voided = true;
      }
    }
    let s = [1, 2].find((x) => env.slots[x].phase === 'idle');
    if (!s) {
      // both runs hold voided numbers: one posts and is refused, freeing its slot
      s = 1;
      if (env.slots[1].phase === 'numbered') acts.push(`syncRead(1, ${barsMap(env)})`);
      acts.push('syncPost(1)');
    }
    acts.push(`syncNumber(${s})`);
    env.slots[s] = { phase: 'numbered', obs: n, voided: false, at: step.now };
  }

  // A board post: accepted whole, or refused (R-BTN-62, §7.1).
  if (origin === '/v1/sync/board') {
    const n = step.body?.observation;
    const s = [1, 2].find((x) => env.slots[x].phase !== 'idle' && env.slots[x].obs === n);
    if (s) {
      if (Q.lastAccepted === n && n > P.lastAccepted) {
        const r = applyPost(Q, env, k);
        if (r.end || r.reject) return r;
        acts.push(...r.acts, `syncRead(${s}, ${barsMap(env)})`, `syncPost(${s})`);
      } else {
        if (env.slots[s].phase === 'numbered') acts.push(`syncRead(${s}, ${barsMap(env)})`);
        if (!env.slots[s].voided) acts.push(`syncVoid(${s})`);
        acts.push(`syncPost(${s})`);
      }
      env.slots[s] = { phase: 'idle', obs: 0, voided: false, at: 0 };
    } else if (Q.lastAccepted !== P.lastAccepted || JSON.stringify(Q.tickets) !== JSON.stringify(P.tickets)) {
      return { reject: `a post with observation ${n}, which no sync run holds, changed the board` };
    }
  } else if (Q.lastAccepted !== P.lastAccepted || JSON.stringify(Q.tickets) !== JSON.stringify(P.tickets)) {
    if (step.kind === 'harness') return { end: 'the harness wrote the board (a state Baton did not reach)' };
    return { reject: `the board changed outside a board post (${origin})` };
  }

  // Claims (R-BTN-4, R-BTN-63, R-BTN-71, §6.6).
  let ticked = false;
  const tick = () => { if (!ticked) { for (let x = 0; x < TIMEOUT; x++) acts.push('tick'); ticked = true; } };
  for (const id of Object.keys(Q.claims).sort((a, b) => a - b)) {
    const d = Q.claims[id];
    const c = P.claims[id];
    const w = q(k.W(d.worker));
    if (!c) {
      if (origin === '/v1/ui/cutover') return { end: `claim ${id} imported at cutover (a legacy claim; §13 step 3, not modelled)` };
      if (step.kind !== 'request' || origin !== '/v1/runner/claim') return { reject: `claim ${id} made by ${origin}, which is no worker's claim` };
      if (!sameTags(d.worker)) return { end: `worker ${d.worker} claims with other tags than at its first claim (the model’s TAGS are constant)` };
      if (d.leg !== '' || d.finished.length || d.status !== 'active') return { reject: `claim ${id} created already advanced or ended` };
      env.ids[id] = env.nextId++;
      env.claimTier[id] = Q.tickets[d.ticket]?.tier ?? null;
      acts.push(`heartbeat(${w})`, `claimStart(${w}, ${q(d.ticket)})`, `claimFinish(${w}, "order")`);
      continue;
    }
    const m = env.ids[id];
    if (m == null) continue; // a claim from before the checked part (none: claims are made in it)
    if (c.status === 'active' && d.status === 'active' && (d.leg !== c.leg || d.finished.length !== c.finished.length)) {
      if (!/\/advance$/.test(origin)) return { reject: `claim ${id}'s legs changed by ${origin}` };
      if (!sameTags(d.worker)) return { end: `worker ${d.worker} advances with other tags than at its first claim (the model’s TAGS are constant)` };
      // the bars are the ones the holder SENT (round 1, 1-B-2): a store that kept others is rejected
      const sent = step.body?.bars ?? []; // absent is none (validate.ts)
      if (!Array.isArray(sent)) return { reject: `claim ${id} advanced by a request whose bars are not a list` };
      if (!sameSet(sent, d.legBars)) return { reject: `claim ${id}'s leg stored bars ${JSON.stringify(d.legBars)}, not the ${JSON.stringify(sent)} the holder sent` };
      acts.push(`heartbeat(${w})`);
      if (c.leg !== '') acts.push(`pushEvidence(${w}, false)`);
      acts.push(`advance(${w}, ${q(d.leg)}, ${qSet(sent)}, false)`);
    } else if (c.status === 'active' && d.status !== 'active' && /\/end$/.test(origin)) {
      const reached = d.finished.length > c.finished.length;
      acts.push(`heartbeat(${w})`);
      if (reached) acts.push(`pushEvidence(${w}, false)`);
      acts.push(`endClaim(${w}, ${q(kindOf(d.endReason))}, ${reached})`);
    } else if (c.status === 'active' && d.status === 'reaped') {
      if (origin === 'alarm' && d.endReason === 'reaped:release-unacknowledged') return { end: `claim ${id} reaped on an unacknowledged release (§9; messages are not modelled)` };
      if (origin === 'alarm') {
        // the lease ran out by Baton's clock (round 1, 1-A-0)
        if (!silent(d.worker)) return { reject: `claim ${id} reaped by the alarm before worker ${d.worker}'s lease ran out` };
        tick();
        acts.push(`alarmReap(${m})`);
      } else if (/\/reap$/.test(origin)) {
        if (d.fencePending) acts.push(`forceReap(${w})`);
        // R-BTN-19: a worker already silent past its lease is not fenced — the fence, timed out
        else if (silent(d.worker)) { acts.push(`forceReap(${w})`); tick(); acts.push(`fenceTimeout(${m})`); }
        else return { reject: `claim ${id} force-reaped without a fence while worker ${d.worker} was alive (R-BTN-19)` };
      } else return { reject: `claim ${id} reaped by ${origin}` };
    } else if (c.status === 'active' && d.status === 'released' && d.endReason === 'released:stale-board') {
      if (origin !== '/v1/sync/board') return { reject: `claim ${id} released stale by ${origin}` };
    } else if (c.status === 'completed' && d.status === 'released' && /\/resolve$/.test(origin)) {
      return { end: `the owner released claim ${id}'s unconfirmed completion (§6.7; the model's owner only confirms)` };
    } else if (c.status !== d.status && !(c.status === 'active' && origin === '/v1/sync/board')) {
      return { reject: `claim ${id} went ${c.status} → ${d.status} by ${origin}, which no model action does` };
    }
    if (c.fencePending && !d.fencePending) {
      if (origin === '/v1/runner/heartbeat') acts.push(`fenceCleared(${w})`);
      else if (origin === 'alarm') {
        if (!silent(d.worker)) return { reject: `claim ${id}'s fence timed out while worker ${d.worker} was heard from` };
        tick();
        acts.push(`fenceTimeout(${m})`);
      } else return { reject: `claim ${id}'s fence cleared by ${origin}` };
    }
    if (!c.confirmed && d.confirmed && /\/resolve$/.test(origin)) acts.push(`ownerResolve(${m})`);
  }
  for (const id of Object.keys(P.claims)) if (!Q.claims[id]) return { reject: `claim ${id} vanished` };
  return { actions: dedupeHeartbeats(acts) };
}

/** A worker heartbeats once before its actions in one step. */
function dedupeHeartbeats(acts) {
  const out = [];
  for (const a of acts) if (!(a.startsWith('heartbeat(') && out.at(-1) === a)) out.push(a);
  return out;
}

/** Git as an accepted post shows it: the environment's steps that move the model's git there,
 *  and the posted state the model will take from it. */
function applyPost(Q, env, k) {
  const acts = [];
  for (const t of Object.keys(env.git)) {
    const v = Q.tickets[t];
    let target = env.git[t];
    let gone = false;
    if (v?.present) target = v.path;
    else if (v?.closed === 'done') {
      target = toEnd(env.posted[t]);
      if (!target) return { reject: `${t} closed done from a station with no route to an end` };
    } else if (v?.closed === 'withdrawn' || env.seen[t]) gone = true;
    // regress to the common prefix, then push the rest (any pusher may, R-BTN-66)
    let g = env.git[t];
    let common = 0;
    while (common < g.length && common < target.length && g[common] === target[common]) common++;
    for (let x = g.length; x > common; x--) acts.push(`regress(${q(t)})`);
    g = g.slice(0, common);
    for (const l of target.slice(common)) {
      if (!FROM[l]?.includes(stationOf(g))) return { reject: `${t}'s posted path ${target.join(',')} is not a path of the course` };
      acts.push(`foreignPush(${q(t)}, ${q(l)})`);
      g = [...g, l];
    }
    env.git[t] = g;
    if (gone && !env.withdrawn[t]) {
      if (COURSE.end.includes(stationOf(g))) return { reject: `${t} withdrawn at an end station` };
      acts.push(`withdraw(${q(t)})`);
      env.withdrawn[t] = true;
    }
    if (!gone && env.withdrawn[t]) return { end: `${t} returned after it was withdrawn (a closure undone; the model's withdrawal is final)` };
    // the model's one bar set per ticket stands for its covered legs' (R-BTN-67)
    let bars = [];
    if (v?.present && k.REQUIRED.length) {
      const sets = k.REQUIRED.filter((l) => v.bars[l]).map((l) => v.bars[l]);
      if (sets.some((s) => !sameSet(s, sets[0]))) return { end: `${t}'s covered legs posted different bars (the model has one set per ticket)` };
      bars = sets[0] ?? [];
    }
    env.bars[t] = bars;
    env.posted[t] = g;
    env.gone[t] = env.withdrawn[t];
    if (v?.present) env.seen[t] = true;
  }
  return { acts };
}

const barsMap = (env) => `Map(${Object.keys(env.bars).map((t) => `${q(t)} -> ${qSet(env.bars[t])}`).join(', ')})`;

/** What the model's state must be after the step: the projection, in the model's names. */
function expectations(Q, env, T, W) {
  const e = [
    ['counter', `st.counter == ${Q.counter}`],
    ['lastAccepted', `st.lastAccepted == ${Q.lastAccepted}`],
  ];
  for (const t of T) {
    e.push([`posted ${t}`, `st.posted.get(${q(t)}) == ${qList(env.posted[t])}`]);
    e.push([`postedGone ${t}`, `st.postedGone.get(${q(t)}) == ${env.gone[t]}`]);
    e.push([`postedBars ${t}`, `st.postedBars.get(${q(t)}) == ${qSet(env.bars[t])}`]);
    e.push([`held ${t}`, `st.held.get(${q(t)}) == ${!!Q.held[t]}`]);
  }
  const bars = [...new Set(Q.ownerBars.map((b) => `{ tag: ${q(b.tag)}, applies: ${q(b.applies)} }`))];
  e.push(['ownerBars', bars.length ? `st.ownerBars == Set(${bars.join(', ')})` : 'st.ownerBars.size() == 0']);
  const ids = Object.keys(Q.claims).map((id) => env.ids[id]).filter((x) => x != null);
  e.push(['claims', ids.length ? `st.claims.keys() == Set(${ids.join(', ')})` : 'st.claims.keys().size() == 0']);
  for (const [id, c] of Object.entries(Q.claims)) {
    const m = env.ids[id];
    if (m == null) continue;
    const g = `st.claims.get(${m})`;
    e.push(
      [`claim ${id} ticket`, `${g}.ticket == ${q(c.ticket)}`],
      [`claim ${id} worker`, `${g}.worker == ${q(W(c.worker))}`],
      [`claim ${id} status`, `${g}.status == ${q(c.status)}`],
      [`claim ${id} kind`, `${g}.kind == ${q(kindOf(c.endReason))}`],
      [`claim ${id} station`, `${g}.station == ${q(c.station)}`],
      // a reaped claim keeps its leg in the model, as its worker's view; Baton keeps no worker's view
      ...(c.status === 'active' ? [[`claim ${id} leg`, `${g}.leg == ${q(c.leg)}`]] : []),
      [`claim ${id} finished`, `${g}.finished == ${qList(c.finished)}`],
      [`claim ${id} startPath`, `${g}.startPath == ${qList(c.startPath)}`],
      [`claim ${id} claimObs`, `${g}.claimObs == ${c.claimObs}`],
      [`claim ${id} endObs`, `${g}.endObs == ${c.endObs}`],
      // regressed_since clears with the end (§2e); the model keeps the flag on ended claims
      ...(c.status === 'active' ? [[`claim ${id} regressed`, `${g}.regressed == ${c.regressed}`]] : []),
      [`claim ${id} endedRegressed`, `${g}.endedRegressed == ${c.endedRegressed}`],
      [`claim ${id} confirmed`, `${g}.confirmed == ${c.confirmed}`],
      [`claim ${id} fencePending`, `${g}.fencePending == ${c.fencePending}`],
    );
  }
  return e;
}

// ── Quint ────────────────────────────────────────────────────────────────────────────────

const header = (consts) => `module replay {
  import baton(${Object.entries(consts).map(([k, v]) => `${k} = ${v}`).join(', ')}).* from "../../../model/baton"
  action start: bool = initWith(WORKERS.mapBy(w => 0))
`;
const chain = (steps, upto, withExpect = true) => {
  let s = '    start';
  for (const st of steps.slice(0, upto)) {
    for (const a of st.actions) s += `\n      .then(${a})`;
    if (withExpect) s += `\n      .expect(${st.expect.map(([, x]) => x).join(' and ')})`;
  }
  return s;
};

/** The Quint module that replays `t` (translate's result) whole. */
export function quintModule(t) {
  return `${header(t.consts)}  run traceTest =\n${chain(t.steps, t.steps.length)}\n}\n`;
}

/** On a rejection: the run of the first `k` steps — the checker searches for the smallest `k`
 *  that fails — and then one run per expectation of that step, so the field is named too. */
function prefixModule(t, k) {
  return `${header(t.consts)}  run prefixTest =\n${chain(t.steps, k)}\n}\n`;
}
/** The first `i` steps, step `i`'s actions, then the expectations `only` of step `i`. */
function stepModule(t, i, only) {
  let actions = '';
  for (const a of t.steps[i].actions) actions += `\n      .then(${a})`;
  const expect = only.length ? `\n      .expect(${only.map((j) => t.steps[i].expect[j][1]).join(' and ')})` : '';
  return `${header(t.consts)}  run stepTest =\n${chain(t.steps, i)}${actions}${expect}\n}\n`;
}

function quintTest(file) {
  return new Promise((done) => {
    const p = spawn('npx', ['quint', 'test', file, '--main=replay', '--backend=typescript', '--max-samples=1'], { cwd: ROOT });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => done({ ok: code === 0, out }));
  });
}

/** Check one trace file: `{ok, checked, total, end, failure}`. */
export async function checkTrace(file, tag = basename(file).replace(/\W+/g, '_').slice(0, 60)) {
  const trace = readTrace(file);
  const t = translate(trace);
  // a step no model action explains rejects the trace whatever the run before it (round 1, 1-A-2)
  if (t.reject) {
    return { file, scenario: trace.scenario, test: trace.test, checked: t.steps.length, total: t.total, end: null, ok: false,
      failure: { step: t.reject.index, label: t.reject.label, actions: [], actionRefused: true, fields: [], reason: t.reject.reason } };
  }
  mkdirSync(OUT, { recursive: true });
  const qnt = join(OUT, `${tag}.qnt`);
  writeFileSync(qnt, quintModule(t));
  const r = await quintTest(relative(ROOT, qnt));
  const res = { file, scenario: trace.scenario, test: trace.test, checked: t.steps.length, total: t.total, end: t.end, ok: r.ok };
  if (r.ok) return res;
  if (!/failed/.test(r.out)) return { ...res, failure: { error: r.out.slice(-1500) } };
  // name the step (the shortest failing prefix), the action and the field
  const dq = join(OUT, `${tag}.prefix.qnt`);
  let lo = 0;
  let hi = t.steps.length;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    writeFileSync(dq, prefixModule(t, mid));
    if ((await quintTest(relative(ROOT, dq))).ok) lo = mid;
    else hi = mid;
  }
  const first = hi - 1;
  const st = t.steps[first];
  const fq = join(OUT, `${tag}.step.qnt`);
  const holds = async (only) => {
    writeFileSync(fq, stepModule(t, first, only));
    return (await quintTest(relative(ROOT, fq))).ok;
  };
  const actionRefused = !(await holds([]));
  // the failing expectations, by halving
  const failing = async (js) => {
    if (await holds(js)) return [];
    if (js.length === 1) return js;
    const mid = js.length >> 1;
    return [...(await failing(js.slice(0, mid))), ...(await failing(js.slice(mid)))];
  };
  const fields = actionRefused ? [] : (await failing(st.expect.map((_, j) => j))).map((j) => st.expect[j][0]);
  return { ...res, failure: { step: st.index, label: st.label, actions: st.actions, actionRefused, fields } };
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

function traceFiles(args) {
  const roots = args.length ? args : [join(ROOT, 'test', '.traces')];
  const files = [];
  const walk = (p) => {
    if (!existsSync(p)) return;
    if (statSync(p).isDirectory()) { for (const f of readdirSync(p)) if (f !== '.qnt') walk(join(p, f)); }
    else if (p.endsWith('.itf.json')) files.push(p);
  };
  roots.forEach(walk);
  return files.sort();
}

// ── the truncation allowlist (round 1, 1-B-5) ────────────────────────────────────────────
// Every trace the model cannot judge to its end is listed in test/integration/trace-scope.json
// with the step it stops at and the reason, so a new truncation, a moved one, or a trace the
// checker judges nothing of fails the run instead of passing quietly.
export const SCOPE = join(ROOT, 'test', 'integration', 'trace-scope.json');
const keyOf = (r) => `${r.scenario} › ${r.test}`;

/** The scope errors for accepted results against the allowlist; `whole` also checks stale entries. */
export function scopeErrors(results, scope, whole = true) {
  const errors = [];
  const seen = new Set();
  for (const r of results) {
    const key = keyOf(r);
    seen.add(key);
    if (!r.ok) continue;
    const want = scope[key];
    if (r.checked === 0) errors.push(`${key}: no step checked (the model judges nothing of it)`);
    if (!r.end) { if (want) errors.push(`${key}: listed as stopping at step ${want.at}, but is judged whole — remove the entry`); continue; }
    if (!want) errors.push(`${key}: stops at step ${r.end.index} (${r.end.reason}), which trace-scope.json does not list`);
    else if (want.at !== r.end.index || want.reason !== r.end.reason) errors.push(`${key}: stops at step ${r.end.index} (${r.end.reason}), not the listed step ${want.at} (${want.reason})`);
  }
  if (whole) for (const key of Object.keys(scope)) if (!seen.has(key)) errors.push(`${key}: listed in trace-scope.json, but no accepted trace has that name`);
  return errors;
}

async function main(args) {
  const writeScope = args.includes('--write-scope');
  args = args.filter((a) => a !== '--write-scope');
  const files = traceFiles(args);
  if (!files.length) {
    console.error('check-traces: no traces — run the scenarios first (npm test writes test/.traces/)');
    return 1;
  }
  let bad = 0;
  let full = 0;
  const results = await pool(files, Number(process.env.TRACE_JOBS ?? 4), async (f, k) => {
    const r = await checkTrace(f, `${process.pid}-t${k}`);
    report(r);
    return r;
  });
  function report(r) {
    const where = `${r.scenario} › ${r.test}`;
    if (!r.ok) {
      bad++;
      const f = r.failure;
      if (f?.label) {
        console.log(`✗ ${where}\n    step ${f.step} (${f.label}): ${f.reason ? `no model action does this: ${f.reason}` : f.actionRefused ? `the model refuses ${f.actions.join(' → ')}` : `after ${f.actions.join(' → ') || 'no action'}, the model's state differs: ${f.fields.join(', ')}`}`);
      } else console.log(`✗ ${where}\n${f?.error ?? ''}`);
      return;
    }
    if (!r.end) full++;
    console.log(`✓ ${where} — ${r.checked}/${r.total} steps${r.end ? `; step ${r.end.index} on is outside the model: ${r.end.reason}` : ''}`);
  }
  for (const f of readdirSync(OUT)) if (f.startsWith(`${process.pid}-`)) rmSync(join(OUT, f), { force: true });
  console.log(`\n${results.length} traces: ${results.length - bad} accepted (${full} whole), ${bad} rejected`);
  if (writeScope) {
    const scope = Object.fromEntries(results.filter((r) => r.ok && r.end).map((r) => [keyOf(r), { at: r.end.index, reason: r.end.reason }]).sort(([a], [b]) => (a < b ? -1 : 1)));
    writeFileSync(SCOPE, `${JSON.stringify(scope, null, 2)}\n`);
    console.log(`wrote ${relative(ROOT, SCOPE)}: ${Object.keys(scope).length} truncated traces`);
    return bad ? 1 : 0;
  }
  const errors = scopeErrors(results, existsSync(SCOPE) ? JSON.parse(readFileSync(SCOPE, 'utf8')) : {}, !args.length);
  for (const e of errors) console.log(`✗ scope: ${e}`);
  return bad || errors.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
}
