// course.ts — the course file's schema and graph rules (BATON_SPEC §2e R-BTN-69; contracts
// R-BTN-82, R-BTN-84; bounds R-BTN-79, R-BTN-90; renames R-BTN-64; labels §10.4). Pure, importing
// only the pure text.ts, so the course test kit (R3-1248) runs the very function Baton runs on
// every registry post. The work is bounded by the file's caps whatever it holds: lists are
// deduplicated and capped, and the graph pass runs only on a file within them.
//
// To core a course is names and edges: stations, and legs from stations to stations. What a
// station or a leg means is the course's own; this only checks that every ticket can finish
// and no loop is unbounded.

export type CourseRule =
  | 'shape' | 'unknown-key' | 'id' | 'unknown-station' | 'start-leg' | 'unreachable' | 'no-end'
  | 'unbounded-cycle' | 'input' | 'bound' | 'renamed-from';

export interface CourseViolation {
  rule: CourseRule;
  /** Where in the file, as a dotted path (`legs.review.max_runs`); `` for the whole file. */
  path: string;
  message: string;
}

import { isFreeText } from './text';

const ID = /^[a-z][a-z0-9-]{0,39}$/;
/** An input's or output's name: no `.`, which `from: "<leg>.<output>"` separates on. */
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** A `short_waits` label is a `waiting_on` label, compared as a string (R-BTN-69, §6). */
const WAIT_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
// The validator's work bound (spec-silent, recorded on R3-1231): the graph pass touches at
// most COURSE_LEGS_MAX × COURSE_STATIONS_MAX² edge pairs and keeps at most
// COURSE_STATIONS_MAX² of them, so a registry post cannot spend a Durable Object's 128 MB or
// its CPU on a hostile file. COURSE_LIST_MAX bounds every other list a file holds.
const COURSE_STATIONS_MAX = 100;
const COURSE_LEGS_MAX = 200;
const COURSE_LIST_MAX = 64;
const MAX_VIOLATIONS = 100;
const TOP_KEYS = new Set(['start', 'start_leg', 'end', 'short_waits', 'stations', 'legs']);
const STATION_KEYS = new Set(['label', 'renamed_from']);
const LEG_KEYS = new Set(['from', 'to', 'label', 'max_runs', 'max_duration', 'max_queue', 'version', 'inputs', 'outputs', 'replay_safe', 'renamed_from']);
const INPUT_KEYS = new Set(['from', 'accepts', 'required']);
const OUTPUT_KEYS = new Set(['schema']);
/** A schema file in the course directory (R-BTN-82): a relative path whose every segment is
 *  a name — none empty, `.` or `..` (as §10.4 asks of a `git:` path). */
const isSchemaPath = (v: unknown) =>
  typeof v === 'string' && v.length <= 200 && v.split('/').every((seg) => /^[A-Za-z0-9._-]+$/.test(seg) && seg !== '.' && seg !== '..');

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const own = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Every way `json` fails to be a course file, sorted by path then rule (at most 100); empty
 * when it is one. A file passes only if every station is reachable from `start` through any
 * outcome, an end is reachable from every station, every `from` and `to` names a station,
 * every cycle contains a leg with `max_runs`, `start_leg` leaves `start`, and every
 * `inputs.from` names a leg and one of its outputs.
 */
export function validateCourse(json: unknown): CourseViolation[] {
  const out: CourseViolation[] = [];
  const add = (rule: CourseRule, path: string, message: string) => out.push({ rule, path, message });

  if (!isObject(json)) {
    add('shape', '', 'a course file is a JSON object');
    return out;
  }
  for (const k of Object.keys(json)) if (!TOP_KEYS.has(k)) add('unknown-key', k, `unknown key "${k}"`);

  // Stations.
  const stations = isObject(json.stations) ? json.stations : null;
  if (!stations) add('shape', 'stations', 'stations must be an object of station ids');
  const stationIds = stations ? Object.keys(stations) : [];
  if (stationIds.length === 0 && stations) add('shape', 'stations', 'a course has at least one station');
  if (stationIds.length > COURSE_STATIONS_MAX) add('shape', 'stations', `at most ${COURSE_STATIONS_MAX} stations`);
  const isStation = new Set(stationIds);
  for (const id of stationIds) {
    const at = `stations.${id}`;
    if (!ID.test(id)) add('id', at, `station id "${id}" must match ${ID.source}`);
    const s = stations![id];
    if (!isObject(s)) {
      add('shape', at, 'a station is an object');
      continue;
    }
    for (const k of Object.keys(s)) if (!STATION_KEYS.has(k)) add('unknown-key', `${at}.${k}`, `unknown key "${k}"`);
    if ('label' in s && !isFreeText(s.label)) add('bound', `${at}.label`, 'a label is §10.4 free text: 1–500 characters, no control characters, none of < > { }');
  }

  // Legs.
  const legs = isObject(json.legs) ? json.legs : null;
  if (!legs) add('shape', 'legs', 'legs must be an object of leg ids');
  const legIds = legs ? Object.keys(legs) : [];
  if (legIds.length > COURSE_LEGS_MAX) add('shape', 'legs', `at most ${COURSE_LEGS_MAX} legs`);
  const isLeg = new Set(legIds);
  /** Each leg's edges as the graph rules read them: from-stations, to-stations, bounded. */
  const edges = new Map<string, { from: string[]; to: string[]; bounded: boolean }>();
  for (const id of legIds) {
    const at = `legs.${id}`;
    if (!ID.test(id)) add('id', at, `leg id "${id}" must match ${ID.source}`);
    const l = legs![id];
    if (!isObject(l)) {
      add('shape', at, 'a leg is an object');
      continue;
    }
    for (const k of Object.keys(l)) if (!LEG_KEYS.has(k)) add('unknown-key', `${at}.${k}`, `unknown key "${k}"`);

    const from = stationList(l.from, `${at}.from`, false);
    const to = typeof l.to === 'string' ? stationList([l.to], `${at}.to`, true) : stationList(l.to, `${at}.to`, false);
    edges.set(id, { from, to, bounded: 'max_runs' in l });

    if ('max_runs' in l && !(isInt(l.max_runs) && l.max_runs >= 1)) add('bound', `${at}.max_runs`, 'max_runs is an integer of at least 1');
    if ('max_duration' in l && !(isInt(l.max_duration) && l.max_duration >= 60 && l.max_duration <= 604_800)) add('bound', `${at}.max_duration`, 'max_duration is an integer from 60 to 604800 seconds');
    if ('max_queue' in l && !(isInt(l.max_queue) && l.max_queue >= 1 && l.max_queue <= 10_000)) add('bound', `${at}.max_queue`, 'max_queue is an integer from 1 to 10000');
    if ('version' in l && !(isInt(l.version) && l.version >= 0)) add('bound', `${at}.version`, 'a contract version is an integer of at least 0');
    if ('replay_safe' in l && typeof l.replay_safe !== 'boolean') add('bound', `${at}.replay_safe`, 'replay_safe is true or false');
    if ('label' in l && !isFreeText(l.label)) add('bound', `${at}.label`, 'a label is §10.4 free text: 1–500 characters, no control characters, none of < > { }');
    if ('outputs' in l) {
      if (!isObject(l.outputs)) add('shape', `${at}.outputs`, 'outputs is an object of output names');
      else if (Object.keys(l.outputs).length > COURSE_LIST_MAX) add('shape', `${at}.outputs`, `at most ${COURSE_LIST_MAX} outputs`);
      else for (const [name, o] of Object.entries(l.outputs)) {
        const op = `${at}.outputs.${name}`;
        if (!NAME.test(name)) add('id', op, `output name "${name}" must match ${NAME.source}`);
        if (!isObject(o)) { add('shape', op, 'an output is an object'); continue; }
        for (const k of Object.keys(o)) if (!OUTPUT_KEYS.has(k)) add('unknown-key', `${op}.${k}`, `unknown key "${k}"`);
        if ('schema' in o && !isSchemaPath(o.schema)) add('shape', `${op}.schema`, 'a schema is a relative path in the course directory, no segment empty, . or ..');
      }
    }
  }

  /** A non-empty list of station ids, each one a station, deduplicated (a repeat names the
   *  same edge). Longer than a file may have stations, it is a shape violation, and empty. */
  function stationList(v: unknown, path: string, single: boolean): string[] {
    if (!Array.isArray(v) || v.length === 0 || v.length > COURSE_STATIONS_MAX || !v.every((x) => typeof x === 'string')) {
      add('shape', path, single ? 'must name a station' : `must be a station id or a list of 1–${COURSE_STATIONS_MAX} of them`);
      return [];
    }
    for (const [i, s] of (v as string[]).entries()) {
      if (!isStation.has(s)) add('unknown-station', single ? path : `${path}.${i}`, `"${s}" is not a station`);
    }
    return [...new Set((v as string[]).filter((s) => isStation.has(s)))];
  }

  // start, end, start_leg, short_waits.
  const start = typeof json.start === 'string' ? json.start : null;
  if (start === null) add('shape', 'start', 'start must name a station');
  else if (!isStation.has(start)) add('unknown-station', 'start', `"${start}" is not a station`);
  const ends = Array.isArray(json.end) && json.end.length > 0 && json.end.every((x) => typeof x === 'string') ? (json.end as string[]) : null;
  if (!ends) add('shape', 'end', 'end must be a non-empty list of stations');
  else for (const [i, e] of ends.entries()) if (!isStation.has(e)) add('unknown-station', `end.${i}`, `"${e}" is not a station`);
  if (typeof json.start_leg !== 'string') add('shape', 'start_leg', 'start_leg must name a leg');
  else if (!isLeg.has(json.start_leg)) add('start-leg', 'start_leg', `"${json.start_leg}" is not a leg`);
  else if (start !== null && !(edges.get(json.start_leg)?.from ?? []).includes(start)) add('start-leg', 'start_leg', `"${json.start_leg}" does not leave the start station "${start}"`);
  if ('short_waits' in json) {
    if (!Array.isArray(json.short_waits) || json.short_waits.length > COURSE_LIST_MAX || !json.short_waits.every((x) => typeof x === 'string')) add('shape', 'short_waits', `short_waits is a list of at most ${COURSE_LIST_MAX} waiting_on labels`);
    else for (const [i, w] of (json.short_waits as string[]).entries()) if (!WAIT_LABEL.test(w)) add('id', `short_waits.${i}`, `label "${w}" must match ${WAIT_LABEL.source}`);
  }

  // Inputs: each reads one leg's declared output.
  for (const id of legIds) {
    const l = legs![id];
    if (!isObject(l) || !('inputs' in l)) continue;
    const at = `legs.${id}.inputs`;
    if (!isObject(l.inputs)) { add('shape', at, 'inputs is an object of input names'); continue; }
    if (Object.keys(l.inputs).length > COURSE_LIST_MAX) { add('shape', at, `at most ${COURSE_LIST_MAX} inputs`); continue; }
    for (const [name, inp] of Object.entries(l.inputs)) {
      const ip = `${at}.${name}`;
      if (!NAME.test(name)) add('id', ip, `input name "${name}" must match ${NAME.source}`);
      if (!isObject(inp)) { add('shape', ip, 'an input is an object'); continue; }
      for (const k of Object.keys(inp)) if (!INPUT_KEYS.has(k)) add('unknown-key', `${ip}.${k}`, `unknown key "${k}"`);
      if ('accepts' in inp && !(Array.isArray(inp.accepts) && inp.accepts.length > 0 && inp.accepts.length <= COURSE_LIST_MAX && inp.accepts.every((v) => isInt(v) && v >= 0))) add('bound', `${ip}.accepts`, `accepts is a list of 1–${COURSE_LIST_MAX} contract versions`);
      if ('required' in inp && typeof inp.required !== 'boolean') add('bound', `${ip}.required`, 'required is true or false');
      const m = typeof inp.from === 'string' ? /^([^.]+)\.([^.]+)$/.exec(inp.from) : null;
      if (!m) { add('input', `${ip}.from`, 'from is "<leg>.<output>"'); continue; }
      const producer = isLeg.has(m[1]) ? legs![m[1]] : undefined;
      if (!isLeg.has(m[1])) add('input', `${ip}.from`, `"${m[1]}" is not a leg`);
      // Own keys only: an inherited name (`toString`, `__proto__`) is no declared output.
      else if (!isObject(producer) || !isObject(producer.outputs) || !NAME.test(m[2]) || !own(producer.outputs, m[2])) add('input', `${ip}.from`, `leg "${m[1]}" declares no output "${m[2]}"`);
    }
  }

  // renamed_from: an old name, or a list of them, never a current name of its kind, never
  // claimed by two.
  const renames = (kind: 'stations' | 'legs', ids: string[], current: Set<string>, all: Record<string, unknown> | null) => {
    const claimed = new Map<string, string>();
    for (const id of ids) {
      const v = all && isObject(all[id]) ? (all[id] as Record<string, unknown>).renamed_from : undefined;
      if (v === undefined) continue;
      const at = `${kind}.${id}.renamed_from`;
      const names = typeof v === 'string' ? [v] : Array.isArray(v) && v.length <= COURSE_LIST_MAX && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
      if (!names || names.length === 0) { add('renamed-from', at, 'renamed_from is an id or a list of ids'); continue; }
      for (const n of names) {
        if (!ID.test(n)) add('renamed-from', at, `"${n}" must match ${ID.source}`);
        else if (current.has(n)) add('renamed-from', at, `"${n}" is a current ${kind === 'legs' ? 'leg' : 'station'}`);
        else if (claimed.has(n) && claimed.get(n) !== id) add('renamed-from', at, `"${n}" is also claimed by "${claimed.get(n)}"`);
        else claimed.set(n, id);
      }
    }
  };
  renames('stations', stationIds, isStation, stations);
  renames('legs', legIds, isLeg, legs);

  // The graph rules run only on a file within its caps, so the work is bounded whatever it
  // holds (at most 200 legs × 100 × 100 edges); past them the shape violations stand alone.
  if (stationIds.length > COURSE_STATIONS_MAX || legIds.length > COURSE_LEGS_MAX) return finish(out);

  // The graph: station → station along every leg's every outcome.
  const next = new Map<string, Set<string>>(stationIds.map((s) => [s, new Set()]));
  const prev = new Map<string, Set<string>>(stationIds.map((s) => [s, new Set()]));
  for (const { from, to } of edges.values()) {
    for (const f of from) for (const t of to) {
      next.get(f)!.add(t);
      prev.get(t)!.add(f);
    }
  }
  const reach = (seeds: string[], via: Map<string, Set<string>>) => {
    const seen = new Set(seeds);
    const todo = [...seeds];
    while (todo.length) for (const n of via.get(todo.pop()!) ?? []) if (!seen.has(n)) { seen.add(n); todo.push(n); }
    return seen;
  };
  if (start !== null && isStation.has(start)) {
    const fromStart = reach([start], next);
    for (const s of stationIds) if (!fromStart.has(s)) add('unreachable', `stations.${s}`, `no leg reaches "${s}" from "${start}"`);
  }
  if (ends) {
    const toEnd = reach(ends.filter((e) => isStation.has(e)), prev);
    for (const s of stationIds) if (!toEnd.has(s)) add('no-end', `stations.${s}`, `no path leads from "${s}" to an end`);
  }

  // Every cycle contains a leg with max_runs: exactly when the graph of the unbounded legs
  // alone has no cycle. One violation per strongly connected component of it that loops.
  // The graph is kept as station pairs (at most stations², whatever the legs), never per leg.
  const loose = new Map<string, Set<string>>(stationIds.map((s) => [s, new Set()]));
  for (const { from, to, bounded } of edges.values()) if (!bounded) for (const f of from) for (const t of to) loose.get(f)!.add(t);
  const sccOf = new Map<string, number>();
  const sccs = components(stationIds, loose);
  sccs.forEach((scc, i) => scc.forEach((s) => sccOf.set(s, i)));
  // A leg loops inside a component when it leaves a station of it for a station of it: in a
  // component of two or more stations any such edge lies on a cycle; in one of one, it is a
  // self-loop.
  const legsIn = new Map<number, string[]>();
  for (const [leg, { from, to, bounded }] of edges) {
    if (bounded) continue;
    const into = new Set(to.map((t) => sccOf.get(t)!));
    for (const c of new Set(from.map((f) => sccOf.get(f)!))) {
      if (!into.has(c)) continue;
      if (sccs[c].length === 1 && !(from.includes(sccs[c][0]) && to.includes(sccs[c][0]))) continue;
      legsIn.set(c, [...(legsIn.get(c) ?? []), leg]);
    }
  }
  for (const legsHere of legsIn.values()) {
    const names = legsHere.sort();
    add('unbounded-cycle', `legs.${names[0]}`, `the legs ${names.map((n) => `"${n}"`).join(', ')} form a cycle with no max_runs`);
  }

  return finish(out);
}

function finish(out: CourseViolation[]): CourseViolation[] {
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
  return out.slice(0, MAX_VIOLATIONS);
}

/** Tarjan's strongly connected components, iteratively (no recursion on a 100-station file). */
function components(nodes: string[], adj: Map<string, Set<string>>): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  const list = new Map<string, string[]>([...adj].map(([k, v]) => [k, [...v]]));
  for (const root of nodes) {
    if (idx.has(root)) continue;
    const work: { node: string; i: number }[] = [{ node: root, i: 0 }];
    idx.set(root, index); low.set(root, index); index++;
    stack.push(root); onStack.add(root);
    while (work.length) {
      const top = work[work.length - 1];
      const edges = list.get(top.node) ?? [];
      if (top.i < edges.length) {
        const w = edges[top.i++];
        if (!idx.has(w)) {
          idx.set(w, index); low.set(w, index); index++;
          stack.push(w); onStack.add(w);
          work.push({ node: w, i: 0 });
        } else if (onStack.has(w)) low.set(top.node, Math.min(low.get(top.node)!, idx.get(w)!));
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1].node;
        low.set(parent, Math.min(low.get(parent)!, low.get(top.node)!));
      }
      if (low.get(top.node) === idx.get(top.node)) {
        const scc: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          scc.push(w);
        } while (w !== top.node);
        out.push(scc);
      }
    }
  }
  return out;
}
