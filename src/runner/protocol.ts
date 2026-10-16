// protocol.ts — the runner's decisions over a leg script's result (BATON_SPEC §6.13 R-BTN-72,
// §2e, R-BTN-63/-71/-83): which shape the result is, whether its pair `(reached, next)` follows
// the course file, and what the runner therefore does — advance, end done, suspend or release.
// Pure: no clock, no network, no node API, so both hosts' typecheck covers it and the unit tests
// (test/unit/runner-protocol.test.ts) drive it directly. The runner owns no course: every name
// here comes from the graph the claim's snapshot loaded, and nothing is inferred from a station
// having one leg out (R-BTN-83 — a course change could add a second).

import type { Graph } from '../core/graph';
import { resolveLeg, resolveStation } from '../core/graph';

/** A leg script's result, one of §6.13's four shapes. `reached` names the station the leg rests
 * at: an outcome it reached, or its `from` when it gave the leg up (R-BTN-71). */
export type LegResult =
  | { reached: string; next?: string | null; bars?: string[]; session?: string; not_before?: number; outputs?: unknown[] }
  | { suspend: true; reached: string; next?: string | null }
  | { end: 'done'; reached: string; detail?: string }
  | { release: string; reached: string; next?: string | null };

/** The `released:` reasons a script may choose itself (§6.5): the runner's own are
 * `lease-lost` and `course-changed`, the server's are `owner-cancel` and `provider-suspended`,
 * and an owner bar's reason is the bar's, never a script's guess. */
export const SCRIPT_RELEASE_REASONS = ['stale-board', 'cannot-finish:transient', 'cannot-finish:capability', 'cannot-finish:spec',
  'requested', 'provider-exhausted'] as const;

/** What the runner does with a validated result. */
export type Decision =
  | { kind: 'advance'; reached: string; leg: string; bars: string[]; session?: string; notBefore?: number }
  | { kind: 'done'; reached: string; detail?: string }
  | { kind: 'suspend'; reached: string; next: string | null }
  | { kind: 'release'; reason: string; reached: string; next: string | null };

/** A script bug (§6.13): the result's pair does not follow the course file, so the leg is given
 * up — it rests at its `from` with itself as the queued leg (R-BTN-83) — and nothing it says is
 * reported. `why` names the fault for the hand-off document. */
export interface ScriptBug {
  bug: true;
  why: string;
  /** The give-up position: the leg's `from`, the leg itself queued. */
  reached: string;
  next: string;
}

export const isResult = (v: unknown): v is LegResult =>
  !!v && typeof v === 'object' && (!Array.isArray(v))
  && (typeof (v as { reached?: unknown }).reached === 'string'
    || (v as { suspend?: unknown }).suspend === true
    || (v as { end?: unknown }).end === 'done'
    || typeof (v as { release?: unknown }).release === 'string');

/** Validate one leg's result against the course file the claim's snapshot loaded. The leg runs
 * from `from` (the station the claim reached when it started the leg); `reached` may be any of
 * its outcomes or, for a give-up, its `from`. Old names resolve through `renamed_from`
 * (R-BTN-64). A result whose shape is none of the four is a bug too — the runner never guesses
 * what a script meant. */
export function decide(result: unknown, g: Graph, legName: string, from: string): Decision | ScriptBug {
  const bug = (why: string): ScriptBug => ({ bug: true, why, reached: from, next: legName });
  if (!isResult(result)) return bug(`the result is none of the four shapes (got ${JSON.stringify(result)?.slice(0, 120)})`);
  const leg = resolveLeg(g, legName) ?? legName;
  const def = g.legs.get(leg);
  if (!def) return bug(`the course file no longer has the leg ${legName}`);
  // The stations the leg may rest at: its outcomes, or its `from` when it gives up (R-BTN-71).
  const rests = new Set([from, ...def.to]);
  // `next` must be a leg leaving the station the result rests at, under current names (R-BTN-63).
  const nextLeaving = (raw: string | null | undefined, at: string): string | null => {
    if (raw == null || raw === '') return null;
    const n = resolveLeg(g, raw) ?? raw;
    return g.legs.get(n)?.from.includes(at) ? n : null;
  };
  const resolved = (name: string) => resolveStation(g, name) ?? name;

  if ('suspend' in result) {
    const reached = resolved(result.reached);
    if (!rests.has(reached)) return bug(`suspends at ${result.reached}, which is not ${from} or an outcome of ${leg}`);
    const next = nextLeaving(result.next, reached);
    if (result.next != null && next == null) return bug(`names the next leg ${result.next}, which does not leave ${result.reached}`);
    return { kind: 'suspend', reached, next };
  }
  if ('end' in result) {
    const reached = resolved(result.reached);
    if (!rests.has(reached)) return bug(`ends at ${result.reached}, which is not ${from} or an outcome of ${leg}`);
    return { kind: 'done', reached, ...(result.detail != null ? { detail: result.detail } : {}) };
  }
  if ('release' in result) {
    if (!(SCRIPT_RELEASE_REASONS as readonly string[]).includes(result.release)) {
      return bug(`releases ${result.release}, which is not a reason a script may choose (§6.5)`);
    }
    const reached = resolved(result.reached);
    if (!rests.has(reached)) return bug(`releases at ${result.reached}, which is not ${from} or an outcome of ${leg}`);
    return { kind: 'release', reason: result.release, reached, next: nextLeaving(result.next, reached) };
  }
  // The go-on shape: the leg reached one of its outcomes and names the leg to run next. At an end
  // station the runner ends done whatever `next` says (§6.13) — Baton's ends have no legs out.
  const reached = resolved(result.reached);
  if (!def.to.includes(reached)) return bug(`reached ${result.reached}, which is not an outcome of ${leg} (${def.to.join(', ')})`);
  if (g.ends.has(reached)) return { kind: 'done', reached };
  const next = nextLeaving(result.next, reached);
  if (next == null) {
    return bug(result.next == null
      ? `reached ${reached}, not an end station, and named no next leg (required at every station but an end, R-BTN-83)`
      : `names the next leg ${result.next}, which does not leave ${reached}`);
  }
  return {
    kind: 'advance', reached, leg: next,
    bars: Array.isArray(result.bars) ? result.bars.filter((b) => typeof b === 'string') : [],
    ...(result.session != null ? { session: String(result.session) } : {}),
    ...(result.not_before != null && Number.isFinite(result.not_before) ? { notBefore: result.not_before } : {}),
  };
}

/** How an `advance` refusal settles (§6.13): `off-graph` means the course changed under the
 * claim (the runner validates against the snapshot it loaded, so a refusal is the server's
 * newer file disagreeing) and ends `released:course-changed`; every other refusal — a gate's,
 * `max-runs`, `policy`, `not-queued` — suspends at the station the claim reached, never
 * releasing. The codes are Baton's (`rule_code` in the §11 error body). */
export function refusalKind(ruleCode: string | undefined): 'course-changed' | 'suspend' {
  return ruleCode === 'off-graph' ? 'course-changed' : 'suspend';
}

/** What the latest snapshot says about the leg the runner would take (§6.13): run it, hold the
 * claim for a `short_waits` label (R-BTN-40 — re-read at each heartbeat for up to 30 minutes),
 * or suspend because it waits on something slower. A snapshot that does not list the leg does
 * not place the ticket there yet — the holder's own position leads — so the leg runs. */
export function waitState(next: { leg: string; state: string; waiting_on?: string }[], leg: string, shortWaits: string[]): 'run' | 'short' | 'suspend' {
  const shown = next.find((n) => n.leg === leg);
  if (!shown || shown.state !== 'waiting') return 'run';
  return shortWaits.includes(shown.waiting_on ?? '') ? 'short' : 'suspend';
}

/** The short-wait budget (R-BTN-40): a holder keeps the claim this long from the beat that first
 * saw the wait, then suspends. Named for what it protects: the lease others wait on. */
export const SHORT_WAIT_MS = 30 * 60_000;

/** Whether a short wait that started at `waitedSince` is spent at `now`. */
export const shortWaitSpent = (waitedSince: number, now: number): boolean => now - waitedSince >= SHORT_WAIT_MS;

/** A leg's run number for `ctx`: how many runs of it git evidences (every earlier attempt's
 * legs, flattened by the runner) plus the ones this claim started, under current names
 * (R-BTN-64, R-BTN-63). */
export function runNumber(g: Graph, path: { leg: string; reached?: string }[], leg: string, ownRuns: string[]): number {
  return path.filter((s) => (resolveLeg(g, s.leg) ?? s.leg) === leg).length
    + ownRuns.filter((l) => (resolveLeg(g, l) ?? l) === leg).length + 1;
}
