// graph.ts — a course file read as a graph (BATON_SPEC §2e R-BTN-63/-64/-70/-71): the edge a leg
// follows, the runs a ticket has made of a leg, whether one path extends another by edges, the
// legs from a station to an end, and the names a renaming file still resolves. Pure, and only
// ever given a file `validateCourse` accepted (courses.ts stores no other), so it trusts the
// shape. To core a station and a leg are names: nothing here reads what one means.

/** One step of a ticket's path: the leg run and the station it reached (R-BTN-70). */
export interface Step {
  leg: string;
  reached: string;
}

export interface Leg {
  from: string[];
  to: string[];
  maxRuns: number | null;
}

export interface Graph {
  start: string;
  startLeg: string;
  ends: Set<string>;
  shortWaits: string[];
  stations: Set<string>;
  legs: Map<string, Leg>;
  /** An old leg or station name → the current one (`renamed_from`, R-BTN-64). */
  legRenames: Map<string, string>;
  stationRenames: Map<string, string>;
  /** Legs on the shortest route from each station to an end (`to_end`, §2e). */
  toEnd: Map<string, number>;
}

const names = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? (v as string[]) : []);

/** The graph of a validated course file. */
export function graphOf(json: unknown): Graph {
  const f = json as {
    start: string; start_leg: string; end: string[]; short_waits?: string[];
    stations: Record<string, { renamed_from?: string | string[] }>;
    legs: Record<string, { from: string[]; to: string | string[]; max_runs?: number; renamed_from?: string | string[] }>;
  };
  const legs = new Map<string, Leg>();
  const legRenames = new Map<string, string>();
  const stationRenames = new Map<string, string>();
  for (const [id, l] of Object.entries(f.legs)) {
    legs.set(id, { from: [...new Set(l.from)], to: [...new Set(names(l.to))], maxRuns: l.max_runs ?? null });
    for (const old of names(l.renamed_from)) legRenames.set(old, id);
  }
  for (const [id, s] of Object.entries(f.stations)) for (const old of names(s.renamed_from)) stationRenames.set(old, id);
  const stations = new Set(Object.keys(f.stations));
  const ends = new Set(f.end);
  // Breadth-first from the ends, backwards along every leg's every outcome.
  const toEnd = new Map<string, number>([...ends].map((e) => [e, 0]));
  let frontier = [...ends];
  while (frontier.length) {
    const next: string[] = [];
    for (const s of frontier) {
      for (const l of legs.values()) {
        if (!l.to.includes(s)) continue;
        for (const from of l.from) {
          if (toEnd.has(from)) continue;
          toEnd.set(from, toEnd.get(s)! + 1);
          next.push(from);
        }
      }
    }
    frontier = next;
  }
  return { start: f.start, startLeg: f.start_leg, ends, shortWaits: f.short_waits ?? [], stations, legs, legRenames, stationRenames, toEnd };
}

/** A leg's current name: itself, or the leg whose `renamed_from` names it; null when neither. */
export function resolveLeg(g: Graph, name: string): string | null {
  return g.legs.has(name) ? name : g.legRenames.get(name) ?? null;
}

/** A station's current name, as `resolveLeg`. */
export function resolveStation(g: Graph, name: string): string | null {
  return g.stations.has(name) ? name : g.stationRenames.get(name) ?? null;
}

/** A path under current names; a step naming a leg or station the file no longer has keeps its
 *  name, so it matches nothing and extends nothing. */
export function resolvePath(g: Graph, path: Step[]): Step[] {
  return path.map((s) => ({ leg: resolveLeg(g, s.leg) ?? s.leg, reached: resolveStation(g, s.reached) ?? s.reached }));
}

/** Whether `leg` leaves `station` (an edge of the file, R-BTN-63). */
export function leaves(g: Graph, leg: string, station: string): boolean {
  return g.legs.get(leg)?.from.includes(station) ?? false;
}

/** Whether `step` follows from `station`: its leg leaves it and it reached one of its outcomes. */
function follows(g: Graph, station: string, step: Step): boolean {
  const l = g.legs.get(step.leg);
  return !!l && l.from.includes(station) && l.to.includes(step.reached);
}

const sameStep = (a: Step, b: Step) => a.leg === b.leg && a.reached === b.reached;

/**
 * R-BTN-71 and §2e's off-graph rule: whether `path` begins with `base` and continues, if at all,
 * by edges of the file in order from `base`'s last station (`from` when `base` is empty). Both
 * are read under current names. Equal paths extend.
 */
export function extendsPath(g: Graph, base: Step[], path: Step[], from: string): boolean {
  const b = resolvePath(g, base);
  const p = resolvePath(g, path);
  if (p.length < b.length || !b.every((s, i) => sameStep(s, p[i]))) return false;
  let at = b.length ? b[b.length - 1].reached : resolveStation(g, from) ?? from;
  for (const step of p.slice(b.length)) {
    if (!follows(g, at, step)) return false;
    at = step.reached;
  }
  return true;
}

/** Whether a whole path, from the course's start, follows the file's edges. */
export function onGraph(g: Graph, path: Step[]): boolean {
  return extendsPath(g, [], path, g.start);
}

/** How often `leg` was run in `legs` (names, any of them old), counted under current names
 *  (R-BTN-63, R-BTN-64). */
export function runsOf(g: Graph, leg: string, legs: string[]): number {
  return legs.filter((l) => (resolveLeg(g, l) ?? l) === leg).length;
}
