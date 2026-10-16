// claims.ts — the fenced lease (BATON_SPEC §6.1–6.7, §7.2 rules 1–10, §11 claim, end, holder and
// reap rows; R3-1212), with attempts, retries, holds and resume records (§6.10–6.11; R3-1217): claiming by the matching rules, ending in §6.5's vocabulary, the alarm's
// reaps, the fence before re-issue (R-BTN-19), confirmation by ancestry, and git winning over a
// stale claim (R-BTN-35). The lock is the two partial unique indexes: a claim inserts and lets
// SQLite refuse a second holder, never check-then-insert without them (R-BTN-4).
import { BatonError } from './http';
import { transcriptUrl } from './links';
import { isUniqueViolation, logEvent, randomHex } from './db';
import { fitsTier, TIERS } from '../shared/vocabulary.mjs';
import { afterFailure, countsAsFailed, nonRetryableClass, resumeRecord, type ResumeActivity } from './attempts';
import { checkAccept, checkAdvance, checkClaim, checkConfirm, checkEnd, checkOverride, checkResolve, type End } from './validate';
import { ceilingIn, repositoryOf, transcriptReposOf } from './registry';
import { GATE_CODES, gatesFor, type GateContext, type GateLeg, type GateTicket, type GateVerdict, type Phase } from './gates';
import { extendsPath, leaves, resolveLeg, resolveStation, runsOf, type Step } from './graph';
import type { Seen, Stations } from './stations';
import type { Row, SqlValue, Store } from './ports';
const EXPEDITE_BOUND = 2; // §7.2 rule 2, advice
/** §2e: a claim regressed this long is listed under Needs you. */
export const REGRESSED_FLAG_MS = 30 * 60_000;
/** §14 Needs you: how long a bars-mismatch stays listed (spec-silent, recorded on R3-1232). */
const BARS_MISMATCH_LISTED_MS = 24 * 3_600_000;
const RELEASE_ACK_MS = 2 * 3_600_000; // §9: a delivered release unacknowledged for 2 h reaps the claim
export const UNCONFIRMED_FLAG_MS = 6 * 3_600_000; // §6.7
const STALLED_MS = 2 * 3_600_000; // §14 Running: alive but no activity for 2 h
/** R-BTN-35: the git states that end an active claim `released:stale-board`. */
const GIT_ENDS = new Set(['done', 'superseded', 'deferred', 'deprioritized']);

export interface Ctx {
  store: Store;
  now: () => number;
  /** Where each ticket is, and its course's graph (R-BTN-70). */
  stations: Stations;
  /** §12: ask for the ticket's repository's sync or mirror to be dispatched once this
   *  request's transaction has committed. */
  dispatch?: (kind: 'mirror' | 'sync', ticketId: string) => void;
}

interface WorkerFacts {
  id: number;
  kind: string;
  incarnation: number;
  tier_ceiling: string;
  /** Per repository (R-BTN-66); `ceilingIn` resolves the one rule 5 compares. */
  tier_ceilings: Record<string, string>;
  lease_timeout_ms: number;
  last_seen_at: number;
  last_activity_at: number | null;
  declared: string[];
  /** The courses its checkouts run (R-BTN-48): rule 9. */
  courses: { repository: string; course: string; version: number }[];
  /** R-BTN-60: what rule 8 matches. */
  tags: string[];
}

interface ItemFacts {
  id: string;
  repository: string;
  course: string;
  path: string;
  tier: string | null;
  requires: string[] | null;
  operator_only: boolean;
  expedite: boolean;
  rank: number | null;
  /** Where the head snapshot places it, or null when it places it nowhere. */
  station: { station: string; path: Step[]; next_leg: string | null; to_end: number; handoff_url: string | null } | null;
}

/** A row of the candidate query (§7.2). */
interface Candidate {
  id: string;
  repository_id: string;
  course_id: string;
  weight: number;
  expedite: number;
  to_end: number;
  ready_since: number | null;
  n: number;
}

/** An entry of `GET /v1/runner/recommendations` (§11). */
export interface Recommendation {
  ticket_id: string;
  station: string;
  legs: string[];
  score: number | null;
  reasons: string[];
  flags: string[];
  advice: unknown;
  handoff_url: string | null;
}

interface HeldClaim {
  id: number;
  worker_id: number;
  ticket_id: string;
  status: string;
  end_reason: string | null;
  station: string;
  leg: string | null;
  course_id: string | null;
  start_path: string;
  offered_leg: string | null;
  claim_observation: number;
  regressed_since: number | null;
}

/** A course with no registry row maps branches the default way (R-BTN-51). */
const DEFAULT_BRANCH_PATTERN = 'claude/{ticket}-*';
/** Whether `branch` is `pattern` with `{ticket}` = `local` and `{repository}` = `repository`,
 *  `*` matching any run of characters, compared case-insensitively as GitHub branch names are
 *  typed. A wildcard match, not a regex: it returns to the last star only, so it takes at most
 *  |branch| × |pattern| steps, never the exponential backtracking a pattern's stars can force on
 *  a RegExp. */
export function branchMatches(pattern: string, branch: string, local: string, repository: string): boolean {
  const p = pattern.replace(/\{ticket\}|\{repository\}/g, (m) => (m === '{ticket}' ? local : repository)).toLowerCase();
  // `*` in a local id or repository id cannot occur (LOCAL_ID, REPOSITORY_ID), so every star is the pattern's.
  const b = branch.toLowerCase();
  let i = 0;
  let j = 0;
  let star = -1;
  let mark = 0;
  while (i < b.length) {
    if (j < p.length && p[j] !== '*' && p[j] === b[i]) {
      i++;
      j++;
    } else if (j < p.length && p[j] === '*') {
      star = j++;
      mark = i;
    } else if (star >= 0) {
      j = star + 1;
      i = ++mark;
    } else {
      return false;
    }
  }
  while (j < p.length && p[j] === '*') j++;
  return j === p.length;
}

export class Claims {
  constructor(private readonly c: Ctx) {}

  private rows<T = Row>(q: string, ...p: unknown[]): T[] {
    return this.c.store.exec(q, ...p).toArray() as T[];
  }
  private exec(q: string, ...p: unknown[]) {
    return this.c.store.exec(q, ...p);
  }
  /** A query with `:name` parameters, bound in the order they occur. */
  private named<T>(q: string, params: Record<string, unknown>): T[] {
    const values: unknown[] = [];
    const sql = q.replace(/:([a-z_][a-z0-9_]*)/g, (m, name: string) => {
      if (!(name in params)) return m;
      values.push(params[name]);
      return '?';
    });
    return this.rows<T>(sql, ...values);
  }
  private get stations() {
    return this.c.stations;
  }
  private event(kind: string, actor: string, detail: unknown, ticketId: string | null = null, claimId: number | null = null, repo?: string) {
    logEvent(this.c.store, this.c.now(), kind, actor, detail, ticketId, claimId, repo ?? (ticketId ? repositoryOf(ticketId) : null));
  }
  private setting(key: string): string | null {
    return this.rows<{ value: string }>('SELECT value FROM baton_settings WHERE key = ?', key)[0]?.value ?? null;
  }
  /** Whether the ticket's repository has cut over (R-BTN-28, per repository). */
  private cutOver(ticketId: string) {
    return this.rows('SELECT 1 FROM repositories WHERE id = ? AND cutover_at IS NOT NULL', repositoryOf(ticketId)).length > 0;
  }
  private anyCutOver() {
    return this.rows('SELECT 1 FROM repositories WHERE cutover_at IS NOT NULL AND retired_at IS NULL').length > 0;
  }
  private headOf(repo: string) {
    return this.rows<{ sha: string | null }>('SELECT sha FROM board_head WHERE repository_id = ?', repo)[0]?.sha ?? null;
  }

  // ── what matching reads ─────────────────────────────────────────────────────────────────

  private worker(id: number): WorkerFacts {
    const w = this.rows<Omit<WorkerFacts, 'declared' | 'courses' | 'tier_ceilings' | 'tags'> & { tier_ceilings: string }>(
      `SELECT id, kind, incarnation, tier_ceiling, tier_ceilings, lease_timeout_ms, last_seen_at, last_activity_at
       FROM workers WHERE id = ?`, id)[0];
    if (!w) throw new BatonError('unauthenticated', 'no such worker');
    const declared = this.rows<{ declared: string }>('SELECT DISTINCT declared FROM worker_capabilities WHERE worker_id = ? ORDER BY declared', id).map((r) => r.declared);
    const courses = this.rows<{ repository: string; course: string; version: number }>(
      'SELECT repository_id AS repository, course_id AS course, version FROM worker_courses WHERE worker_id = ? ORDER BY repository_id, course_id', id);
    const tags = this.rows<{ tag: string }>('SELECT tag FROM worker_tags WHERE worker_id = ? ORDER BY tag', id).map((r) => r.tag);
    return { ...w, tier_ceilings: JSON.parse(w.tier_ceilings) as Record<string, string>, declared, courses, tags };
  }

  /** A ticket's filter fields and where the head snapshot places it (R-BTN-33, R-BTN-70). */
  private item(id: string): ItemFacts | null {
    const r = this.rows<{ id: string; repository_id: string; course_id: string; path: string; tier: string | null; requires_clause: string; operator_only: number; rank: number | null; expedite: number }>(
      'SELECT id, repository_id, course_id, path, tier, requires_clause, operator_only, rank, expedite FROM tickets WHERE id = ?', id)[0];
    if (!r) return null;
    const requires = r.requires_clause === 'listed'
      ? this.rows<{ name: string }>('SELECT name FROM ticket_requires WHERE ticket_id = ? ORDER BY name', id).map((x) => x.name)
      : null;
    const s = this.rows<{ station: string; path: string; next_leg: string | null; to_end: number; handoff_url: string | null }>(
      'SELECT station, path, next_leg, to_end, handoff_url FROM ticket_stations WHERE ticket_id = ?', id)[0] ?? null;
    return {
      id: r.id, repository: r.repository_id, course: r.course_id, path: r.path, tier: r.tier, requires, operator_only: !!r.operator_only, rank: r.rank,
      expedite: !!r.expedite || !!this.override(id)?.expedite,
      station: s ? { station: s.station, path: JSON.parse(s.path) as Step[], next_leg: s.next_leg, to_end: s.to_end, handoff_url: s.handoff_url } : null,
    };
  }

  private override(id: string) {
    return this.rows<{ expedite: number; hold: number; retry_after: number | null }>('SELECT expedite, hold, retry_after FROM ticket_overrides WHERE ticket_id = ?', id)[0] ?? null;
  }

  /** A repository's tier ladder, lowest first (R-BTN-66). */
  private ladder(repo: string): string[] {
    const t = this.rows<{ tiers: string }>('SELECT tiers FROM repositories WHERE id = ?', repo)[0]?.tiers;
    return t ? (JSON.parse(t) as string[]) : [...TIERS];
  }

  /** The worker's ceiling in `repo`'s ladder, by name (rule 5). */
  private ceiling(w: WorkerFacts, repo: string): string {
    return ceilingIn(repo, this.ladder(repo), w.tier_ceilings, w.tier_ceiling);
  }

  /** The counter's last number handed out for `repo` (R-BTN-62): recorded with a claim, an
   *  advance and an end, so only a reading numbered above it can judge them. */
  handedOut(repo: string): number {
    return this.rows<{ n: number }>('SELECT last_handed_out AS n FROM board_head WHERE repository_id = ?', repo)[0]?.n ?? 0;
  }

  /** The leg as the head snapshot posted it for the ticket, and its barred tags (R-BTN-70). */
  private postedLeg(ticketId: string, leg: string): GateLeg {
    const n = this.rows<{ state: 'ready' | 'waiting' }>('SELECT state FROM ticket_next_legs WHERE ticket_id = ? AND leg = ?', ticketId, leg)[0];
    const bars = this.rows<{ tag: string }>('SELECT tag FROM ticket_bars WHERE ticket_id = ? AND leg = ? ORDER BY tag', ticketId, leg).map((r) => r.tag);
    return { name: leg, state: n?.state ?? null, bars };
  }

  /** `gatesFor`'s inputs for one ticket (§7.2), from Baton's own tables (R-BTN-33). */
  private gate(w: WorkerFacts, item: ItemFacts, leg: string, phase: Phase, opts: { except?: number; holderBars?: string[] } = {}): GateVerdict {
    const ticket: GateTicket = { repository: item.repository, course: item.course, tier: item.tier, requires: item.requires, operator_only: item.operator_only, tiers: this.ladder(item.repository) };
    const facts: GateContext = {
      now: this.c.now(),
      claims: this.rows('SELECT status, confirmed_at, fence_pending FROM claims WHERE ticket_id = ? AND id IS NOT ?', item.id, opts.except ?? null),
      override: this.override(item.id),
      // Rule 9 (R-BTN-65): a ticket whose course is not registered fits no worker.
      minWorkerVersion: this.rows<{ v: number }>('SELECT min_worker_version AS v FROM courses WHERE repository_id = ? AND id = ?', item.repository, item.course)[0]?.v ?? Number.POSITIVE_INFINITY,
      headObservation: this.rows<{ n: number }>('SELECT observation AS n FROM board_head WHERE repository_id = ?', item.repository)[0]?.n ?? 0,
      lastEndObservation: this.rows<{ n: number | null }>('SELECT MAX(end_observation) AS n FROM claims WHERE ticket_id = ?', item.id)[0]?.n ?? -1,
      holderBars: opts.holderBars,
    };
    return gatesFor({ declared: w.declared, tier_ceiling: this.ceiling(w, item.repository), tags: w.tags, courses: w.courses }, ticket, this.postedLeg(item.id, leg), phase, facts);
  }

  /** Rule 2's count (advice): active Baton claims on expedited tickets, not git in-progress. */
  private expediteActive(): number {
    return this.rows<{ n: number }>(
      `SELECT count(*) AS n FROM claims c LEFT JOIN tickets w ON w.id = c.ticket_id
       LEFT JOIN ticket_overrides o ON o.ticket_id = c.ticket_id
       WHERE c.status = 'active' AND (w.expedite = 1 OR o.expedite = 1)`)[0].n;
  }

  /**
   * §7.2's candidate query, the mirror of `gatesFor` at a claim: per (repository, course) group,
   * the tickets whose queued leg is ready with none of its posted barred tags on the worker, a
   * sync since their last end, rules 3, 4, 5 (as a position in the repository's ladder), 6, 9 and
   * 10, in the default order — expedite, `to_end`, rank, `ready_since`, id — numbered within the
   * group, and the `page`th 50 of each group. Only cut-over repositories are claimed through Baton.
   */
  candidates(w: WorkerFacts, page = 0, rule9 = true): Candidate[] {
    return this.named<Candidate>(
      `SELECT id, repository_id, course_id, weight, expedite, to_end, ready_since, n FROM (
         SELECT w.id, w.repository_id, w.course_id, p.weight, s.to_end, a.ready_since,
                MAX(w.expedite, COALESCE((SELECT o.expedite FROM ticket_overrides o WHERE o.ticket_id = w.id), 0)) AS expedite,
                ROW_NUMBER() OVER (PARTITION BY w.repository_id, w.course_id
                                   ORDER BY MAX(w.expedite, COALESCE((SELECT o.expedite FROM ticket_overrides o WHERE o.ticket_id = w.id), 0)) DESC,
                                            s.to_end, w.rank IS NULL, w.rank, a.ready_since, w.id) AS n
         FROM tickets w
         JOIN repositories p ON p.id = w.repository_id
         JOIN ticket_stations s ON s.ticket_id = w.id
         JOIN ticket_next_legs a ON a.ticket_id = w.id AND a.leg = s.next_leg AND a.state = 'ready'          -- rule 1
         WHERE p.cutover_at IS NOT NULL AND p.retired_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM ticket_bars b JOIN worker_tags t ON t.tag = b.tag
                           WHERE b.ticket_id = w.id AND b.leg = a.leg AND t.worker_id = :worker)                -- rule 8's posted bars
           AND (SELECT h.observation FROM board_head h WHERE h.repository_id = w.repository_id)
               > COALESCE((SELECT MAX(c.end_observation) FROM claims c WHERE c.ticket_id = w.id), -1)          -- §6.7: a sync since the last end
           AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.ticket_id = w.id
                           AND (c.status = 'active'
                                OR (c.status = 'completed' AND c.confirmed_at IS NULL)
                                OR (c.status = 'reaped' AND c.fence_pending = 1)))                             -- rule 3
           AND NOT EXISTS (SELECT 1 FROM ticket_overrides o WHERE o.ticket_id = w.id
                           AND (o.hold = 1 OR o.retry_after > :now))                                          -- rules 3, 10
           AND NOT EXISTS (SELECT 1 FROM ticket_requires r WHERE r.ticket_id = w.id
                           AND r.name NOT IN (SELECT capability FROM worker_capabilities WHERE worker_id = :worker))  -- rule 4
           AND COALESCE(w.tier_position, json_array_length(p.tiers) - 1)
               <= json_extract(:ceiling, '$."' || w.repository_id || '"')                                      -- rule 5, per repository
           AND (:human_operator OR w.operator_only = 0)                                                       -- rule 6
           AND (:rule9 = 0 OR EXISTS (SELECT 1 FROM worker_courses f JOIN courses k ON k.repository_id = f.repository_id AND k.id = f.course_id
                                      WHERE f.worker_id = :worker AND f.repository_id = w.repository_id AND f.course_id = w.course_id
                                        AND f.version >= k.min_worker_version)))                              -- rule 9
       WHERE n > :page * 50 AND n <= (:page + 1) * 50
       ORDER BY repository_id, course_id, n`,
      { worker: w.id, now: this.c.now(), ceiling: JSON.stringify(this.ceilingPositions(w)), human_operator: w.declared.includes('human-operator') ? 1 : 0, rule9: rule9 ? 1 : 0, page });
  }

  /** The worker's ceiling's position in every repository's ladder: the query's rule 5. */
  private ceilingPositions(w: WorkerFacts): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.rows<{ id: string; tiers: string }>('SELECT id, tiers FROM repositories WHERE retired_at IS NULL')) {
      const ladder = JSON.parse(r.tiers) as string[];
      out[r.id] = ladder.indexOf(ceilingIn(r.id, ladder, w.tier_ceilings, w.tier_ceiling));
    }
    return out;
  }

  /**
   * R-BTN-45 and R-BTN-61: the legs this worker may take, sorted. Each (repository, course) group
   * is read 50 at a time in the default order (no hook yet: R3-1236), each candidate re-checked by
   * `gatesFor`; a group left short of `limit` reads its next page, at most 4. The groups merge by
   * expedite, the repository's weight, the place in the group, `to_end`, `ready_since` and id.
   * Rule 2 is advice: past the expedite lane's bound an expedited ticket loses its lane and says
   * so (`expedite-bound`). Every entry passes every gate.
   */
  private recommend(w: WorkerFacts, limit: number): Recommendation[] {
    const groups = new Map<string, { rows: (Candidate & { item: ItemFacts })[]; done: boolean }>();
    for (let page = 0; page < 4; page++) {
      const wanted = page === 0 ? null : [...groups].filter(([, g]) => !g.done && g.rows.length < limit).map(([k]) => k);
      if (wanted && !wanted.length) break;
      const read = this.candidates(w, page);
      const counts = new Map<string, number>();
      for (const c of read) {
        const key = `${c.repository_id}\u0000${c.course_id}`;
        if (wanted && !wanted.includes(key)) continue;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        const g = groups.get(key) ?? { rows: [], done: false };
        groups.set(key, g);
        const item = this.item(c.id);
        if (item?.station?.next_leg && this.gate(w, item, item.station.next_leg, 'claim').ok) g.rows.push({ ...c, item });
      }
      for (const [key, g] of groups) if ((counts.get(key) ?? 0) < 50) g.done = true;
    }
    // Rule 2 (advice): past the lane's bound an expedited ticket loses its lane — it sorts as an
    // unexpedited one in the default order — before its group's places are numbered, so R-BTN-61's
    // "firsts before any seconds" reads the order it is actually offered in (round 1, 1-A-2, 1-B-1).
    const full = this.expediteActive() >= EXPEDITE_BOUND;
    const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const merged = [...groups.values()].flatMap((g) => {
      const rows = g.rows.map((r) => ({ ...r, waits: !!r.expedite && full, lane: !!r.expedite && !full }));
      if (full) {
        rows.sort((a, b) => Number(b.lane) - Number(a.lane) || a.to_end - b.to_end
          || (a.item.rank ?? Number.MAX_SAFE_INTEGER) - (b.item.rank ?? Number.MAX_SAFE_INTEGER) || (a.ready_since ?? 0) - (b.ready_since ?? 0) || byId(a, b));
      }
      return rows.map((r, place) => ({ ...r, place }));
    });
    merged.sort((a, b) => Number(b.lane) - Number(a.lane) || b.weight - a.weight || a.place - b.place
      || a.to_end - b.to_end || (a.ready_since ?? 0) - (b.ready_since ?? 0) || byId(a, b));
    return merged.slice(0, limit).map((r) => ({
      ticket_id: r.id,
      station: r.item.station!.station,
      legs: [r.item.station!.next_leg!],
      score: null,
      reasons: [...(r.lane ? ['expedite lane'] : []), `${r.to_end} leg${r.to_end === 1 ? '' : 's'} to an end`, `rank ${r.item.rank ?? '—'} in ${r.repository_id}`],
      flags: r.waits ? ['expedite-bound'] : [],
      advice: null,
      handoff_url: r.item.station!.handoff_url,
    }));
  }

  /** The refusal a failed gate becomes (§11): `barred-tag`, `stale-skills` and `backing-off` have
   *  codes of their own; every other gate is `not-eligible` naming the rule. */
  private refusal(ticketId: string, v: Exclude<GateVerdict, { ok: true }>, phase: Phase): BatonError {
    const code = v.rule === 8 ? 'barred-tag' : v.rule === 9 ? 'stale-skills' : v.rule === 10 ? 'backing-off' : 'not-eligible';
    return new BatonError(code, `${ticketId}: ${v.code} at ${phase === 'claim' ? 'a claim' : 'an advance'}`, { rule: v.rule, rule_code: v.code });
  }

  /** The ticket a claim by `w` gets now (§6.2): the named one if it passes the gates, recommended
   *  or not, with the advice it went against; else the first recommendation. Throws the §11 refusal. */
  private decide(w: WorkerFacts, wanted: string | null): { item: ItemFacts; advice: Record<string, unknown> | null } {
    if (wanted) {
      if (!this.cutOver(wanted)) throw new BatonError('not-cut-over', `${repositoryOf(wanted)}'s claims go through git until its cutover (R-BTN-28)`);
      const item = this.item(wanted);
      if (!item || !item.station?.next_leg) throw new BatonError('not-eligible', `${wanted} has no leg to claim`, { rule: 1, rule_code: GATE_CODES[1] });
      const v = this.gate(w, item, item.station.next_leg, 'claim');
      if (!v.ok) throw this.refusal(wanted, v, 'claim');
      // R-BTN-45: advice never refuses; a claim against it is accepted and recorded.
      const recs = this.recommend(w, 50);
      const place = recs.findIndex((r) => r.ticket_id === wanted);
      const overridden = [
        ...(place !== 0 ? [{ advice: 'order', place: place < 0 ? null : place + 1, first: recs[0]?.ticket_id ?? null }] : []),
        ...(item.expedite && this.expediteActive() >= EXPEDITE_BOUND ? [{ advice: 'expedite-bound', bound: EXPEDITE_BOUND }] : []),
      ];
      return { item, advice: overridden.length ? { recommendation: place < 0 ? null : recs[place], overridden } : place === 0 ? { recommendation: recs[0] } : null };
    }
    const [first] = this.recommend(w, 1);
    if (first) return { item: this.item(first.ticket_id)!, advice: { recommendation: first } };
    // Rule 9 is per course: say `stale-skills` when it alone stood between this worker and a
    // ticket, so the worker knows to restart from a pulled checkout (R-BTN-22). Only tickets of
    // courses the worker declares count; a worker declaring no course is stale on every course.
    if (this.candidates(w, 0, false).some((c) => {
      const item = this.item(c.id);
      return !!item?.station?.next_leg && (!w.courses.length || w.courses.some((k) => k.repository === item.repository && k.course === item.course))
        && (this.gate(w, item, item.station.next_leg, 'claim') as { code?: string }).code === GATE_CODES[9];
    })) {
      throw new BatonError('stale-skills', 'this worker does not declare the ready tickets’ courses at their min_worker_version — it declares an older version or none (R-BTN-22, R-BTN-65)', { rule: 9 });
    }
    throw new BatonError('no-eligible-ticket', 'no ready ticket fits this worker');
  }

  // ── the worker calls (§11) ──────────────────────────────────────────────────────────────

  /** `GET /v1/runner/recommendations` (R-BTN-45): the sorted legs this worker may take, without
   *  claiming; `?limit=` applies after the merge (R-BTN-61). */
  recommendations(workerId: number, limit = 10) {
    return { recommendations: this.recommend(this.worker(workerId), limit) };
  }

  /** `GET /v1/runner/next`: the first recommendation, or `no-eligible-ticket`. */
  next(workerId: number) {
    const { item, advice } = this.decide(this.worker(workerId), null);
    const r = (advice?.recommendation ?? null) as Recommendation | null;
    return { ...(r ?? { ticket_id: item.id }), rank_reason: r?.reasons.join(' · ') ?? '' };
  }

  /** `POST /v1/runner/claim` (§6.2): idempotent by `request_id`; the lock is the index. The claim
   *  is at the ticket's posted station, running nothing, its path recorded (R-BTN-63). */
  claim(workerId: number, body: unknown) {
    const b = checkClaim(body);
    if (!this.anyCutOver()) throw new BatonError('not-cut-over', 'claims go through git until cutover (R-BTN-28)');
    const prior = this.rows<{ id: number; worker_id: number }>('SELECT id, worker_id FROM claims WHERE request_id = ?', b.request_id)[0];
    if (prior) {
      // A lost response retried: the same claim, never a second ticket (G-BTN-2).
      if (prior.worker_id !== workerId) throw new BatonError('invalid-params', 'request_id: already used by another worker');
      return this.claimResponse(prior.id);
    }
    const now = this.c.now();
    const w = this.worker(workerId);
    const mine = this.rows<{ ticket_id: string }>(`SELECT ticket_id FROM claims WHERE worker_id = ? AND status = 'active'`, workerId)[0];
    if (mine) throw new BatonError('not-eligible', `this worker holds ${mine.ticket_id}; end it before claiming another (R-BTN-4)`, { rule: 'one-claim-per-worker' });
    const { item, advice } = this.decide(w, b.ticket_id);
    const st = item.station!;
    try {
      // R-BTN-62: the counter's last handed-out number now; only a reading numbered above it can
      // make this claim stale.
      this.exec(`INSERT INTO claims (ticket_id, worker_id, request_id, nonce, snapshot_sha, claimed_at, status, claim_observation,
                   station, course_id, start_path, offered_leg, advice_json)
                 VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
        item.id, workerId, b.request_id, randomHex(3), this.headOf(item.repository) ?? '', now, this.handedOut(item.repository),
        st.station, item.course, JSON.stringify(st.path), st.next_leg, advice ? JSON.stringify(advice) : null);
    } catch (e) {
      // R-BTN-4: the partial unique indexes refuse a second holder of the ticket or the worker.
      if (isUniqueViolation(e)) throw new BatonError('not-eligible', `${item.id} is already held`, { rule: 3, rule_code: GATE_CODES[3] });
      throw e;
    }
    const id = this.rows<{ id: number }>('SELECT last_insert_rowid() AS id')[0].id;
    this.event('claimed', `worker:${workerId}`, { request_id: b.request_id, station: st.station, leg: st.next_leg }, item.id, id);
    if (advice?.overridden) this.event('advice-overridden', `worker:${workerId}`, { overridden: advice.overridden }, item.id, id);
    this.c.dispatch?.('mirror', item.id);
    this.c.dispatch?.('sync', item.id); // R-BTN-73: after every claim
    // §6.8: transcripts reported while the worker held nothing are linked to this claim — those
    // in its repository's transcript repositories (R-BTN-66); the rest are dropped.
    const allowed = transcriptReposOf(this.c.store, item.repository);
    this.exec(`INSERT INTO transcripts (worker_id, claim_id, repo, path, role, activity_id, first_seen_at, last_pushed_at)
               SELECT worker_id, ?, repo, path, role, activity_id, first_seen_at, last_pushed_at FROM pending_transcripts
               WHERE worker_id = ? AND repo IN (SELECT value FROM json_each(?))
               ON CONFLICT (worker_id, repo, path, claim_id) DO NOTHING`, id, workerId, JSON.stringify(allowed));
    this.exec('DELETE FROM pending_transcripts WHERE worker_id = ?', workerId);
    return this.claimResponse(id);
  }

  /** The latest snapshot's legs leaving a station, as the holder sees them (R-BTN-70): only when
   *  the snapshot has the ticket there — git may be behind or ahead of the holder. */
  private nextLegs(ticketId: string, station: string) {
    const s = this.rows<{ station: string }>('SELECT station FROM ticket_stations WHERE ticket_id = ?', ticketId)[0];
    if (!s || s.station !== station) return [];
    return this.rows<{ leg: string; state: string; waiting_on: string | null }>(
      'SELECT leg, state, waiting_on FROM ticket_next_legs WHERE ticket_id = ? ORDER BY leg', ticketId).map((n) => (n.waiting_on ? n : { leg: n.leg, state: n.state }));
  }

  /** The claim response (§11, R-BTN-34): where the ticket starts or resumes, its queued leg, the
   *  latest snapshot's next legs, its hand-off document, its path and the snapshot the claim was
   *  decided on — never its content — and the earlier attempts, newest first, each with its resume
   *  record and the legs it ran (§6.11, R-BTN-24). */
  private claimResponse(id: number) {
    const c = this.rows<{ id: number; ticket_id: string; nonce: string; snapshot_sha: string; station: string; offered_leg: string | null; advice_json: string | null }>(
      'SELECT id, ticket_id, nonce, snapshot_sha, station, offered_leg, advice_json FROM claims WHERE id = ?', id)[0];
    const path = this.rows<{ path: string }>('SELECT path FROM tickets WHERE id = ?', c.ticket_id)[0]?.path ?? null;
    const handoff = this.rows<{ handoff_url: string | null }>('SELECT handoff_url FROM ticket_stations WHERE ticket_id = ?', c.ticket_id)[0]?.handoff_url ?? null;
    const previous = this.rows<{ id: number; status: string; end_reason: string | null; end_detail: string | null; ended_at: number | null; resume_json: string | null }>(
      `SELECT id, status, end_reason, end_detail, ended_at, resume_json FROM claims WHERE ticket_id = ? AND id < ? AND status != 'active' ORDER BY id DESC`, c.ticket_id, id);
    const advice = c.advice_json ? (JSON.parse(c.advice_json) as { recommendation?: Recommendation | null }) : null;
    return {
      claim_id: c.id, ticket_id: c.ticket_id, station: c.station, legs: c.offered_leg ? [c.offered_leg] : [], next: this.nextLegs(c.ticket_id, c.station),
      ...(handoff ? { handoff_url: handoff } : {}), path, nonce: c.nonce, snapshot_sha: c.snapshot_sha,
      previous_attempts: previous.map((p) => ({
        claim_id: p.id, status: p.status, end_reason: p.end_reason, detail: p.end_detail, ended_at: p.ended_at,
        resume: p.resume_json ? JSON.parse(p.resume_json) : null, legs: this.legsOf(p.id),
      })),
      ...(advice?.recommendation ? { advice: advice.recommendation.advice } : {}),
    };
  }

  /** The legs a claim ran, in order (R-BTN-24, R-BTN-63). */
  private legsOf(claimId: number) {
    return this.rows<{ seq: number; leg: string; from_station: string; to_station: string | null; finished_at: number | null; abandoned_at: number | null }>(
      'SELECT seq, leg, from_station, to_station, finished_at, abandoned_at FROM claim_legs WHERE claim_id = ? ORDER BY seq', claimId)
      .map((l) => ({ leg: l.leg, from: l.from_station, reached: l.to_station, outcome: l.finished_at != null ? 'finished' : l.abandoned_at != null ? 'abandoned' : 'running' }));
  }

  /** The claim's running leg, if any: its last started leg not yet finished or given up. */
  private runningLeg(claimId: number) {
    return this.rows<{ seq: number; leg: string; from_station: string }>(
      'SELECT seq, leg, from_station FROM claim_legs WHERE claim_id = ? AND finished_at IS NULL AND abandoned_at IS NULL ORDER BY seq DESC LIMIT 1', claimId)[0] ?? null;
  }

  /** An active claim of this worker, for `advance` and `end`. */
  private held(workerId: number, claimId: number) {
    const c = this.rows<HeldClaim>(
      `SELECT id, worker_id, ticket_id, status, end_reason, station, leg, course_id, start_path, offered_leg, claim_observation, regressed_since
       FROM claims WHERE id = ?`, claimId)[0];
    if (!c && !this.anyCutOver()) throw new BatonError('not-cut-over', 'claims go through git until cutover (R-BTN-28)');
    if (c && !this.cutOver(c.ticket_id)) throw new BatonError('not-cut-over', `${repositoryOf(c.ticket_id)}'s claims go through git until its cutover (R-BTN-28)`);
    if (!c || c.worker_id !== workerId) throw new BatonError('not-holder', 'this worker does not hold that claim');
    return c;
  }

  /**
   * `POST /v1/runner/claims/{id}/advance` (R-BTN-63, §11): the running leg, if any, is finished —
   * the claim is at `reached`, one of its outcomes — and `leg` starts, on the holder's word: Baton
   * checks the edge (the leg leaves that station), the run limit (its runs in `start_path` and this
   * claim's legs, under current names, R-BTN-64) and the gates that bind a holder, never the leg's
   * state. The first advance starts the leg the claim was offered (R-BTN-83). A refusal changes
   * nothing. The answer carries the latest snapshot's next legs and the course's advice (none
   * until the course's hook, R3-1236).
   */
  advance(workerId: number, claimId: number, body: unknown) {
    const b = checkAdvance(body);
    const c = this.held(workerId, claimId);
    if (c.status !== 'active') throw new BatonError('claim-ended', `the claim already ended (${c.status}: ${c.end_reason})`);
    const repo = repositoryOf(c.ticket_id);
    const g = c.course_id ? this.stations.graph(repo, c.course_id) : null;
    const item = this.item(c.ticket_id);
    if (!g || !item) throw new BatonError('not-eligible', `${c.ticket_id} is no longer on the board, or its course is not in force`, { rule: 1, rule_code: 'gone' });
    const offGraph = (why: string) => new BatonError('not-eligible', `off-graph: ${why}`, { rule: 1, rule_code: 'off-graph' });
    const station = resolveStation(g, c.station);
    if (!station) throw offGraph(`the claim's station ${c.station} is no longer in the course file`);
    const leg = resolveLeg(g, b.leg);
    if (!leg) throw offGraph(`${b.leg} is not a leg of the course file`);
    const run = this.runningLeg(claimId);
    let at = station;
    if (run) {
      const running = resolveLeg(g, run.leg);
      const outcomes = running ? g.legs.get(running)!.to : [];
      if (!running) throw offGraph(`the running leg ${run.leg} is no longer in the course file`);
      // §11: `reached` is required while a leg runs — the holder says which outcome it reached.
      if (!b.reached) throw new BatonError('invalid-params', `reached: required while ${running} runs — one of ${outcomes.join(', ')}`);
      const reached = resolveStation(g, b.reached);
      if (!reached || !outcomes.includes(reached)) throw offGraph(`${running} cannot reach ${b.reached}`);
      at = reached;
    } else {
      if (b.reached && resolveStation(g, b.reached) !== station) throw offGraph(`the claim is at ${station}, running nothing`);
      // R-BTN-83: the first leg is the one the claim was offered.
      const started = this.rows('SELECT 1 FROM claim_legs WHERE claim_id = ?', claimId).length > 0;
      if (!started && c.offered_leg && (resolveLeg(g, c.offered_leg) ?? c.offered_leg) !== leg) {
        throw new BatonError('not-eligible', `not-queued: the claim was offered ${c.offered_leg}`, { rule: 1, rule_code: 'not-queued' });
      }
    }
    if (!leaves(g, leg, at)) throw offGraph(`${leg} does not leave ${at}`);
    const max = g.legs.get(leg)!.maxRuns;
    if (max != null) {
      const ran = [...(JSON.parse(c.start_path) as Step[]).map((s) => s.leg), ...this.rows<{ leg: string }>('SELECT leg FROM claim_legs WHERE claim_id = ?', claimId).map((r) => r.leg)];
      if (runsOf(g, leg, ran) >= max) throw new BatonError('not-eligible', `max-runs: ${leg} has run ${max} times`, { rule: 1, rule_code: 'max-runs' });
    }
    const v = this.gate(this.worker(workerId), item, leg, 'advance', { except: claimId, holderBars: b.bars });
    if (!v.ok) throw this.refusal(c.ticket_id, v, 'advance');

    const now = this.c.now();
    const n = this.handedOut(repo);
    if (run) this.exec('UPDATE claim_legs SET to_station = ?, finished_at = ?, evidence = ? WHERE claim_id = ? AND seq = ?', at, now, b.evidence, claimId, run.seq);
    const seq = (this.rows<{ s: number | null }>('SELECT MAX(seq) AS s FROM claim_legs WHERE claim_id = ?', claimId)[0].s ?? 0) + 1;
    this.exec(`INSERT INTO claim_legs (claim_id, seq, leg, from_station, bars, started_at, started_observation) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      claimId, seq, leg, at, JSON.stringify(b.bars), now, n);
    // R-BTN-62: only a reading numbered above the counter now can judge the claim stale.
    this.exec('UPDATE claims SET station = ?, leg = ?, claim_observation = ? WHERE id = ?', at, leg, n, claimId);
    this.event('advanced', `worker:${workerId}`, { from: station, reached: at, leg, ...(b.bars.length ? { bars: b.bars } : {}), ...(b.evidence ? { evidence: b.evidence } : {}) }, c.ticket_id, claimId);
    this.c.dispatch?.('sync', c.ticket_id); // R-BTN-73: after every advance
    return { ok: true, station: at, next: this.nextLegs(c.ticket_id, at), advice: null };
  }

  /** `POST /v1/runner/claims/{id}/end` (§6.5, R-BTN-8, R-BTN-71). A retried identical end is a no-op. */
  end(workerId: number, claimId: number, body: unknown) {
    const e = checkEnd(body);
    const c = this.held(workerId, claimId);
    if (c.status !== 'active') {
      if (c.end_reason === e.end_reason) return { ok: true };
      // R-BTN-8 pushes git first, so a sync can see the ticket closed and release the claim
      // stale-board (R-BTN-35) before the worker's own end arrives: that completion is the
      // truth, recorded as such, and the release it no longer needs is withdrawn.
      if (c.status === 'released' && c.end_reason === 'released:stale-board' && e.status === 'completed' && this.gitEnded(c.ticket_id, c.id)) {
        this.exec(`UPDATE claims SET status = 'completed', end_reason = ?, end_detail = ?, ended_at_sha = ?, end_observation = ? WHERE id = ?`,
          e.end_reason, e.detail, e.ended_at_sha ?? '', this.handedOut(repositoryOf(c.ticket_id)), c.id);
        this.exec(`UPDATE messages SET status = 'expired' WHERE to_worker_id = ? AND kind = 'release' AND status IN ('pending','delivered')
                   AND json_extract(payload_json, '$.ticket_id') = ? AND json_extract(payload_json, '$.reason') = 'stale-board'`, workerId, c.ticket_id);
        this.event('completed', `worker:${workerId}`, { end_reason: e.end_reason, ended_at_sha: e.ended_at_sha, after: 'released:stale-board' }, c.ticket_id, c.id);
        this.confirmByClosure(c.id);
        this.c.dispatch?.('sync', c.ticket_id);
        return { ok: true };
      }
      throw new BatonError('claim-ended', `the claim already ended (${c.status}: ${c.end_reason})`);
    }
    const { reached, finished } = this.restingAt(c, e);
    this.finish(c.id, c.ticket_id, e.status, e.end_reason, `worker:${workerId}`, { ended_at_sha: e.ended_at_sha, detail: e.detail, reached, finished, evidence: e.ended_at_sha, next: e.next });
    return { ok: true };
  }

  /**
   * R-BTN-71: the station an end rests at — the running leg's outcome it reached, or the leg's
   * `from` if it gave the leg up (the claim's current station); with no leg running, the claim's
   * station. Any other station is refused. With `reached` absent: a suspension names it; a `done`
   * that ran a leg of one outcome reached it; anything else rests where the claim is.
   */
  private restingAt(c: HeldClaim, e: End): { reached: string; finished: boolean } {
    const g = c.course_id ? this.stations.graph(repositoryOf(c.ticket_id), c.course_id) : null;
    const run = this.runningLeg(c.id);
    // A course no longer in force: nothing to check against; a named outcome finishes the leg.
    if (!g) return { reached: e.reached ?? c.station, finished: !!run && !!e.reached && e.reached !== c.station };
    const station = resolveStation(g, c.station) ?? c.station;
    const outcomes = run ? g.legs.get(resolveLeg(g, run.leg) ?? '')?.to ?? [] : [];
    const allowed = new Set([station, ...outcomes]);
    let reached = station;
    if (e.reached) {
      const r = resolveStation(g, e.reached);
      if (!r || !allowed.has(r)) {
        throw new BatonError('not-eligible', `off-graph: the claim rests at ${[...allowed].join(' or ')}, not ${e.reached}`, { rule: 1, rule_code: 'off-graph' });
      }
      reached = r;
    } else if (e.end_reason === 'done' && outcomes.length === 1) {
      reached = outcomes[0];
    }
    // A leg whose outcome is its own `from` (a loop) finishes there on a completed end; a release
    // at `from` gives the leg up.
    return { reached, finished: outcomes.includes(reached) && (reached !== station || e.status === 'completed') };
  }

  /** Ends an active claim (§6.5): the running leg finishes at its outcome or is given up at its
   *  `from` (R-BTN-71), open activities close `abandoned` (§6.9), the resume record is written
   *  for every end (R-BTN-24), and the end is logged. */
  private finish(claimId: number, ticketId: string, status: 'completed' | 'released' | 'reaped', reason: string, actor: string,
    opts: { ended_at_sha?: string | null; fence?: { incarnation: number } | null; detail?: string | null; reached?: string | null; finished?: boolean; evidence?: string | null; next?: string | null } = {}) {
    const now = this.c.now();
    const c = this.rows<{ station: string; regressed_since: number | null }>('SELECT station, regressed_since FROM claims WHERE id = ?', claimId)[0];
    const run = this.runningLeg(claimId);
    const reached = opts.reached ?? c.station;
    if (run && opts.finished) {
      this.exec('UPDATE claim_legs SET to_station = ?, finished_at = ?, evidence = ? WHERE claim_id = ? AND seq = ?', reached, now, opts.evidence ?? null, claimId, run.seq);
    } else if (run) {
      // A reap, a stale-board release or an end at the leg's `from`: the leg was given up.
      this.exec('UPDATE claim_legs SET abandoned_at = ? WHERE claim_id = ? AND seq = ?', now, claimId, run.seq);
    }
    // R-BTN-62: only a reading numbered above the counter's value now can confirm this end. §2e:
    // regressed_since clears with the end; a suspension made while regressed is confirmed by any
    // later snapshot, which `ended_regressed` remembers.
    this.exec(`UPDATE claims SET status = ?, ended_at = ?, end_reason = ?, end_detail = ?, ended_at_sha = ?, fence_pending = ?, fence_incarnation = ?, end_observation = ?,
                 station = ?, leg = NULL, ended_regressed = ?, regressed_since = NULL WHERE id = ?`,
      status, now, reason, opts.detail ?? null, status === 'completed' ? opts.ended_at_sha ?? '' : null, opts.fence ? 1 : 0, opts.fence?.incarnation ?? null,
      this.handedOut(repositoryOf(ticketId)), reached, c.regressed_since != null ? 1 : 0, claimId);
    this.exec(`UPDATE activities SET ended_at = ?, outcome = 'abandoned' WHERE claim_id = ? AND ended_at IS NULL`, now, claimId);
    this.event(status, actor, { end_reason: reason, reached, ...(opts.detail ? { detail: opts.detail } : {}), ...(opts.ended_at_sha ? { ended_at_sha: opts.ended_at_sha } : {}), ...(opts.fence ? { fence_pending: true } : {}) }, ticketId, claimId);
    // §12: the mirror writes the end; R-BTN-73: every end dispatches a sync, which confirms a
    // completion (R-BTN-10) without waiting for an unrelated push and makes the ticket claimable.
    this.c.dispatch?.('mirror', ticketId);
    this.c.dispatch?.('sync', ticketId);
    // §13 step 3: a legacy claim that ends takes its adoption request with it.
    this.exec('DELETE FROM adoptions WHERE claim_id = ?', claimId);
    this.writeResume(claimId, reason, now, opts.next ?? null);
    if (status === 'completed') this.confirmByClosure(claimId);
    else this.applyRetryPolicy(claimId, ticketId, reason);
  }

  // ── attempts, retries and holds (§6.10, §8; R3-1217) ────────────────────────────────────

  /** The event-log position of the newest hold-lift on the item: the count of failed attempts
   *  starts after it (§6.10). Ordered by the log, never by time — a lift and an end can share a
   *  millisecond. */
  private lastLift(item: string): number {
    return this.rows<{ seq: number | null }>(
      `SELECT max(seq) AS seq FROM events WHERE kind = 'override' AND ticket_id = ? AND json_extract(detail_json, '$.hold') = 0`, item)[0]?.seq ?? 0;
  }

  /** The claims of an item whose end was logged after event `since`, newest end first. */
  private endedSince(item: string, since: number) {
    return this.rows<{ id: number; worker_id: number; end_reason: string; failed_attempt: number }>(
      `SELECT id, worker_id, end_reason, failed_attempt FROM (
         SELECT c.id, c.worker_id, c.end_reason, c.failed_attempt,
                (SELECT max(e.seq) FROM events e WHERE e.claim_id = c.id AND e.kind IN ('completed', 'released', 'reaped')) AS end_seq
         FROM claims c WHERE c.ticket_id = ? AND c.status != 'active')
       WHERE end_seq > ? ORDER BY end_seq DESC`, item, since);
  }

  /** Counting is a query, not a counter: failed claims ended after the newest hold-lift. */
  failedAttempts(item: string): number[] {
    return this.endedSince(item, this.lastLift(item)).filter((c) => c.failed_attempt === 1).map((c) => c.id).sort((a, b) => a - b);
  }

  /** R-BTN-24: the record the next claimant reads, from this claim's activities. */
  private writeResume(claimId: number, reason: string, now: number, next: string | null = null) {
    const acts = this.rows<ResumeActivity>('SELECT kind, seq, label, started_at, ended_at, outcome, detail_json FROM activities WHERE claim_id = ? ORDER BY started_at', claimId);
    const transcripts = this.rows<{ repo: string; path: string; role: string }>('SELECT repo, path, role FROM transcripts WHERE claim_id = ? ORDER BY id', claimId);
    const c = this.rows<{ end_detail: string | null; station: string }>('SELECT end_detail, station FROM claims WHERE id = ?', claimId)[0];
    // R-BTN-24: every end, a suspension included; with the legs the claim ran, where it rests and
    // the queued leg the holder named (`next`, R-BTN-83; round 1, 1-B-4).
    const record = { ...resumeRecord(reason, now, acts, transcripts), detail: c?.end_detail ?? null, reached: c?.station ?? null, next, legs: this.legsOf(claimId) };
    this.exec('UPDATE claims SET resume_json = ? WHERE id = ?', JSON.stringify(record), claimId);
  }

  /** §6.10, after a claim ends other than completed: mark the failed attempt, then back off, or
   *  hold — non-retryable at once, attempts-exhausted at the third. (`awaiting-review-capacity`
   *  is retired: a review with no capacity is simply not ready, §6.5.) */
  private applyRetryPolicy(claimId: number, item: string, reason: string) {
    const ended = this.endedSince(item, this.lastLift(item));
    const c = this.rows<{ worker_id: number }>('SELECT worker_id FROM claims WHERE id = ?', claimId)[0];
    const leaseLostBefore = reason === 'released:lease-lost' &&
      ended.some((e) => e.id !== claimId && e.worker_id === c.worker_id && e.failed_attempt === 1 && e.end_reason === 'released:lease-lost');
    if (countsAsFailed(reason, leaseLostBefore)) {
      this.exec('UPDATE claims SET failed_attempt = 1 WHERE id = ?', claimId);
      const failed = this.failedAttempts(item);
      const cls = nonRetryableClass(reason);
      if (cls) return this.hold(item, `non-retryable:${cls}`, 'baton', { claim_id: claimId, attempts: failed });
      const next = afterFailure(failed.length);
      if (next && 'hold' in next) {
        this.event('attempts-exhausted', 'baton', { claim_id: claimId, attempts: failed }, item, claimId);
        return this.hold(item, next.hold, 'baton', { claim_id: claimId, attempts: failed });
      }
      if (next) {
        const until = this.c.now() + next.retryAfterMs;
        this.upsertOverride(item, 'baton', { retry_after: until });
        this.event('override', 'baton', { retry_after: until, claim_id: claimId, attempts: failed }, item, claimId);
      }
      return;
    }
  }

  private upsertOverride(item: string, by: string, set: { hold?: 0 | 1; hold_reason?: string | null; retry_after?: number | null; expedite?: 0 | 1 }) {
    const now = this.c.now();
    this.exec(`INSERT INTO ticket_overrides (ticket_id, expedite, hold, hold_reason, retry_after, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (ticket_id) DO UPDATE SET set_by = excluded.set_by, set_at = excluded.set_at`,
      item, set.expedite ?? 0, set.hold ?? 0, set.hold_reason ?? null, set.retry_after ?? null, by, now);
    for (const [k, v] of Object.entries(set)) this.exec(`UPDATE ticket_overrides SET ${k} = ? WHERE ticket_id = ?`, v, item);
  }

  /** §8: every hold, whoever sets it, is an `override` event and a `held` event with its reason. */
  private hold(item: string, reason: string, actor: string, detail: Record<string, unknown> = {}) {
    this.c.dispatch?.('mirror', item); // §6.10: the mirror writes the hold's note
    this.upsertOverride(item, actor, { hold: 1, hold_reason: reason });
    this.event('override', actor, { hold: 1, hold_reason: reason }, item, (detail.claim_id as number) ?? null);
    this.event('held', actor, { hold_reason: reason, ...detail }, item, (detail.claim_id as number) ?? null);
  }

  /** `POST /v1/ui/overrides/{item}` (§8, §11): `{expedite?, hold?}`. Lifting a hold clears its
   *  reason and any backoff, and resets the attempt count (§6.10). */
  setOverride(owner: string, item: string, body: unknown) {
    const o = checkOverride(body);
    const actor = `owner:${owner}`;
    if (o.expedite !== undefined) {
      if (o.expedite) this.c.dispatch?.('mirror', item); // §8: the mirror writes the EXPEDITE tag
      this.upsertOverride(item, actor, { expedite: o.expedite ? 1 : 0 });
      this.event('override', actor, { expedite: o.expedite ? 1 : 0 }, item);
    }
    if (o.hold === true) this.hold(item, 'owner', actor);
    if (o.hold === false) {
      this.upsertOverride(item, actor, { hold: 0, hold_reason: null, retry_after: null });
      this.event('override', actor, { hold: 0 }, item);
    }
    return { ok: true };
  }

  /** Whether a stale-board release still reads as the worker's own git-first completion: git
   *  shows the item ended (done, superseded, deferred, deprioritized, archived or gone — not a
   *  re-tier) and nobody has claimed it since. */
  private gitEnded(item: string, claimId: number) {
    if (this.rows('SELECT 1 FROM claims WHERE ticket_id = ? AND id > ?', item, claimId).length) return false;
    const it = this.rows<{ status: string }>('SELECT status FROM tickets WHERE id = ?', item)[0];
    const closed = this.rows<{ closed_as: string }>('SELECT closed_as FROM closed_tickets WHERE ticket_id = ?', item)[0]?.closed_as;
    // A normative post says how it closed: only a `done` closure is the holder's own completion.
    return closed ? closed === 'done' : !it || GIT_ENDS.has(it.status);
  }

  /** `GET /v1/runner/tickets/{ticket}/holder` (R-BTN-7): whether another live, non-legacy worker
   *  holds the item, and whether a reaped claim on it is still fence-pending. `callerId` is
   *  null for a token-only caller (the witness), for whom every holder is another. */
  holder(callerId: number | null, item: string) {
    const held = this.rows(`SELECT 1 FROM claims c JOIN workers w ON w.id = c.worker_id
                            WHERE c.ticket_id = ? AND c.status = 'active' AND w.kind != 'legacy' AND (? IS NULL OR c.worker_id != ?)`, item, callerId, callerId).length > 0;
    const fence = this.rows(`SELECT 1 FROM claims WHERE ticket_id = ? AND status = 'reaped' AND fence_pending = 1`, item).length > 0;
    return { held_by_other: held, fence_pending: fence };
  }

  /** `GET /v1/runner/branch-holder?repo=&branch=` (§6.3, R-BTN-51): every live ticket the branch
   *  maps to through its course's current or previous `branch_pattern` — `{ticket}` its local id,
   *  `{repository}` its repository's id, `*` anything — among the tickets whose home is that git
   *  repository or whose `repos` name it; and whether another live worker holds one of them or a
   *  reaped claim on one is fence-pending. Two repositories' tickets sharing a local id both map,
   *  and the push is refused if either is held: a collision fails safe. */
  branchHolder(callerId: number | null, gitRepo: string, branch: string) {
    const name = gitRepo.slice(gitRepo.indexOf('/') + 1).toLowerCase();
    const full = gitRepo.toLowerCase();
    const live = this.rows<{ id: string; local_id: string; repository_id: string; repos: string; github: string; branch_pattern: string | null; previous_branch_pattern: string | null }>(
      `SELECT t.id, t.local_id, t.repository_id, t.repos, p.github, k.branch_pattern, k.previous_branch_pattern
       FROM tickets t JOIN repositories p ON p.id = t.repository_id
       LEFT JOIN courses k ON k.repository_id = t.repository_id AND k.id = t.course_id
       WHERE p.retired_at IS NULL`);
    const tickets = live.filter((t) => {
      // `repos` holds owner/name once the sync resolves them (§7.1); docs' interim post sends
      // short names, matched against the repository's own name.
      const repos = (JSON.parse(t.repos) as string[]).map((r) => r.toLowerCase());
      if (t.github.toLowerCase() !== full && !repos.includes(full) && !repos.includes(name)) return false;
      return [t.branch_pattern ?? DEFAULT_BRANCH_PATTERN, t.previous_branch_pattern].some((pat) => pat != null && branchMatches(pat, branch, t.local_id, t.repository_id));
    }).map((t) => t.id).sort();
    // The same answer per ticket as the ticket holder query (R-BTN-7), any of them counting.
    const each = tickets.map((id) => this.holder(callerId, id));
    return { tickets, held_by_other: each.some((h) => h.held_by_other), fence_pending: each.some((h) => h.fence_pending) };
  }

  /** The heartbeat's view of an active claim (§11): its station and running leg, and `git` —
   *  where the head snapshot places the ticket, with `regressed` (§2e); `{closed}` once a snapshot
   *  recorded it closed; `unknown` when the course file no longer has the claim's station or leg
   *  (R-BTN-64); null when no snapshot places it. */
  holderView(claimId: number) {
    const c = this.rows<{ ticket_id: string; station: string; leg: string | null; course_id: string | null; regressed_since: number | null }>(
      'SELECT ticket_id, station, leg, course_id, regressed_since FROM claims WHERE id = ?', claimId)[0];
    if (!c) return {};
    const g = c.course_id ? this.stations.graph(repositoryOf(c.ticket_id), c.course_id) : null;
    const live = this.rows('SELECT 1 FROM tickets WHERE id = ?', c.ticket_id).length > 0;
    const closed = this.rows<{ closed_as: string }>('SELECT closed_as FROM closed_tickets WHERE ticket_id = ?', c.ticket_id)[0];
    const st = this.rows<{ station: string; path: string; path_len: number }>('SELECT station, path, path_len FROM ticket_stations WHERE ticket_id = ?', c.ticket_id)[0];
    let git: unknown = null;
    if (!live && closed) git = { closed: closed.closed_as };
    else if (g && c.station !== '' && (!resolveStation(g, c.station) || (c.leg != null && !resolveLeg(g, c.leg)))) git = 'unknown';
    else if (st) {
      git = { station: st.station, path: JSON.parse(st.path), path_len: st.path_len, regressed: c.regressed_since != null,
        next: this.rows<{ leg: string; state: string; waiting_on: string | null }>('SELECT leg, state, waiting_on FROM ticket_next_legs WHERE ticket_id = ? ORDER BY leg', c.ticket_id)
          .map((n) => (n.waiting_on ? n : { leg: n.leg, state: n.state })) };
    }
    return { station: c.station, ...(c.leg ? { leg: c.leg } : {}), git };
  }

  /** The heartbeat's `fenced` report (R-BTN-19): clears the fence of a claim reaped while this
   *  worker was alive — only in the incarnation it was reaped in, since a re-key never clears one. */
  fenced(workerId: number, incarnation: number, claimId: number) {
    const c = this.rows<{ ticket_id: string }>(
      `SELECT ticket_id FROM claims WHERE id = ? AND worker_id = ? AND status = 'reaped' AND fence_pending = 1 AND fence_incarnation = ?`,
      claimId, workerId, incarnation)[0];
    if (!c) return false;
    this.exec('UPDATE claims SET fence_pending = 0 WHERE id = ?', claimId);
    this.event('fence-cleared', `worker:${workerId}`, { by: 'sidecar' }, c.ticket_id, claimId);
    return true;
  }

  // ── the owner's actions (§14) ───────────────────────────────────────────────────────────

  /** `POST /v1/ui/claims/{id}/reap`: any active claim. A live worker's claim is fence-pending
   *  (R-BTN-19) and the worker is not reaped, so its sidecar can still report the fence; a
   *  silent worker's is reaped as the alarm would. */
  forceReap(owner: string, claimId: number, body: unknown) {
    checkConfirm(body);
    const c = this.rows<{ id: number; ticket_id: string; worker_id: number; status: string }>('SELECT id, ticket_id, worker_id, status FROM claims WHERE id = ?', claimId)[0];
    if (!c) throw new BatonError('not-found', 'no such claim');
    if (c.status !== 'active') throw new BatonError('claim-ended', 'the claim already ended');
    const w = this.worker(c.worker_id);
    const now = this.c.now();
    const alive = w.kind !== 'legacy' && now - w.last_seen_at < w.lease_timeout_ms;
    this.finish(c.id, c.ticket_id, 'reaped', 'reaped:owner', `owner:${owner}`, { fence: alive ? { incarnation: w.incarnation } : null });
    if (!alive) this.exec('UPDATE workers SET reaped_at = ? WHERE id = ? AND reaped_at IS NULL', now, w.id);
    return { ok: true, fence_pending: alive };
  }

  /** `POST /v1/ui/claims/{id}/resolve` (§6.7): an unconfirmed completion is never confirmed
   *  automatically; the owner confirms it (git does carry it) or releases it (it never landed),
   *  which makes the item claimable again. The commit it named stays in the event. */
  resolve(owner: string, claimId: number, body: unknown) {
    const { action } = checkResolve(body);
    const c = this.rows<{ ticket_id: string; end_reason: string; ended_at_sha: string }>(
      `SELECT ticket_id, end_reason, ended_at_sha FROM claims WHERE id = ? AND status = 'completed' AND confirmed_at IS NULL`, claimId)[0];
    if (!c) throw new BatonError('not-found', 'no unconfirmed completion with that id');
    if (action === 'confirm') {
      this.exec('UPDATE claims SET confirmed_at = ? WHERE id = ?', this.c.now(), claimId);
      this.event('confirmed', `owner:${owner}`, { by: 'owner', sha: c.ended_at_sha }, c.ticket_id, claimId);
    } else {
      this.exec(`UPDATE claims SET status = 'released', end_reason = 'released:requested', ended_at_sha = NULL WHERE id = ?`, claimId);
      this.c.dispatch?.('mirror', c.ticket_id);
      this.event('released', `owner:${owner}`, { by: 'owner', unconfirmed: { end_reason: c.end_reason, ended_at_sha: c.ended_at_sha } }, c.ticket_id, claimId);
    }
    return { ok: true };
  }

  /** `POST /v1/ui/board/accept`: the owner accepts a held history; the sync's next force post
   *  of it then becomes the head (§7.1). */
  acceptHeld(owner: string, body: unknown) {
    const { repository, sha } = checkAccept(body);
    const held = this.rows<{ accepted_at: number | null }>('SELECT accepted_at FROM held_snapshots WHERE repository_id = ? AND sha = ?', repository, sha)[0];
    if (!held) throw new BatonError('not-found', 'no such held history');
    if (held.accepted_at == null) {
      this.exec('UPDATE held_snapshots SET accepted_at = ? WHERE repository_id = ? AND sha = ?', this.c.now(), repository, sha);
      this.event('snapshot-accepted', `owner:${owner}`, { sha, held: true, by: 'owner' }, null, null, repository);
    }
    return { ok: true };
  }

  // ── the sync's share (§6.7, R-BTN-35) ───────────────────────────────────────────────────

  /** §7.1: whether a force post is the accepted rewritten history. Accepting a held history
   *  accepts the line, not one sha: main keeps moving while it is held, and the sync always
   *  posts the newest main (§7.1 step 2), so a force post against the head an accepted row
   *  was held against is accepted too. */
  acceptedLine(repo: string, head: string | null) {
    // Only against the head it was held against: an accepted sha re-posted later, once the head
    // has moved past it, is a rewind and is held like any other force post (R-BTN-11).
    return this.rows('SELECT 1 FROM held_snapshots WHERE repository_id = ? AND accepted_at IS NOT NULL AND head_sha IS ?', repo, head).length > 0;
  }

  /** A sync's confirmations, only those of claims on its own repository's tickets (R-BTN-47):
   *  one repository's sync never confirms another's completion. */
  ownConfirmations(repo: string, confirmations: { claim_id: number; sha: string }[]) {
    return confirmations.filter((k) => this.rows<{ ticket_id: string }>('SELECT ticket_id FROM claims WHERE id = ?', k.claim_id)
      .some((c) => repositoryOf(c.ticket_id) === repo));
  }

  /** §6.7: the sync confirms a completion once git carries it (it checked the ancestry and the
   *  status); anything but an unconfirmed completion is ignored. */
  confirm(confirmations: { claim_id: number; sha: string }[], observation: number) {
    const now = this.c.now();
    let n = 0;
    for (const k of confirmations) {
      // R-BTN-62: a reading confirms an end only if it was numbered after the end happened.
      const c = this.rows<{ ticket_id: string }>(`SELECT ticket_id FROM claims WHERE id = ? AND status = 'completed' AND confirmed_at IS NULL
                                                  AND COALESCE(end_observation, 0) < ?`, k.claim_id, observation)[0];
      if (!c) continue;
      this.exec('UPDATE claims SET confirmed_at = ? WHERE id = ?', now, k.claim_id);
      this.event('confirmed', 'sync', { sha: k.sha }, c.ticket_id, k.claim_id);
      n++;
    }
    return n;
  }

  /** R-BTN-71: the path an end or a claim is expected at — its `start_path` followed by the legs
   *  it finished, each with the station it reached. */
  private expectedPath(claimId: number, startPath: string): Step[] {
    return [...(JSON.parse(startPath) as Step[]),
      ...this.rows<{ leg: string; to_station: string }>('SELECT leg, to_station FROM claim_legs WHERE claim_id = ? AND finished_at IS NOT NULL ORDER BY seq', claimId)
        .map((l) => ({ leg: l.leg, reached: l.to_station }))];
  }

  /** R-BTN-10: a `done` end is confirmed by the closure a snapshot reported when that snapshot's
   *  observation is greater than the claim's own (its claim or latest advance) — usually before the
   *  end call, since the holder pushes the archive first (R-BTN-8). */
  private confirmByClosure(claimId: number) {
    const c = this.rows<{ ticket_id: string }>(
      `SELECT c.ticket_id FROM claims c JOIN closed_tickets k ON k.ticket_id = c.ticket_id
       WHERE c.id = ? AND c.status = 'completed' AND c.confirmed_at IS NULL AND c.end_reason = 'done'
         AND k.closed_as = 'done' AND k.observation > c.claim_observation`, claimId)[0];
    if (!c) return false;
    this.exec('UPDATE claims SET confirmed_at = ? WHERE id = ?', this.c.now(), claimId);
    this.event('confirmed', 'sync', { by: 'closure' }, c.ticket_id, claimId);
    return true;
  }

  /**
   * What an accepted snapshot (`observation`, its stations `seen`) settles for the repository's
   * claims, every course alike:
   * - R-BTN-10: a completed end observed after it is confirmed when git shows what it claims — a
   *   `done` by an end station, a recorded closure or the ticket's absence; a suspension by a path
   *   that extends the claim's expected path by edges, or by any path when it ended regressed;
   * - R-BTN-35: an active claim from before the reading whose ticket git took away — withdrawn,
   *   gone without a `done` closure, re-tiered above the holder's ceiling, or (the interim post)
   *   at a status that ends the item — ends `released:stale-board`; a station that lags never does;
   * - §2e: a path shorter than git's last or the claim's `start_path` sets `regressed_since`, and
   *   a later path that extends the expected one clears it;
   * - R-BTN-63: a holder's declared bars the snapshot posts that leg's bars without log
   *   `bars-mismatch`.
   */
  judge(repo: string, observation: number, seen: Map<string, Seen>) {
    let confirmed = 0;
    for (const c of this.rows<{ id: number; ticket_id: string; end_reason: string; start_path: string; ended_regressed: number; course_id: string | null }>(
      `SELECT id, ticket_id, end_reason, start_path, ended_regressed, course_id FROM claims
       WHERE status = 'completed' AND confirmed_at IS NULL AND COALESCE(end_observation, 0) < ? AND substr(ticket_id, 1, length(?) + 1) = ? || ':'`, observation, repo, repo)) {
      if (this.endShown(c, observation)) {
        this.exec('UPDATE claims SET confirmed_at = ? WHERE id = ?', this.c.now(), c.id);
        this.event('confirmed', 'sync', { observation }, c.ticket_id, c.id);
        confirmed++;
      } else if (c.end_reason === 'done' && this.confirmByClosure(c.id)) {
        confirmed++;
      }
    }
    const stale = this.staleBoard(repo, observation);
    const now = this.c.now();
    for (const c of this.rows<{ id: number; ticket_id: string; start_path: string; regressed_since: number | null; course_id: string | null }>(
      `SELECT id, ticket_id, start_path, regressed_since, course_id FROM claims WHERE status = 'active' AND substr(ticket_id, 1, length(?) + 1) = ? || ':'`, repo, repo)) {
      const s = seen.get(c.ticket_id);
      const g = c.course_id ? this.stations.graph(repo, c.course_id) : null;
      if (!s || !g) continue;
      const start = JSON.parse(c.start_path) as Step[];
      const backwards = (s.prev != null && s.path.length < s.prev.length) || s.path.length < start.length;
      if (backwards && c.regressed_since == null) {
        this.exec('UPDATE claims SET regressed_since = ? WHERE id = ?', now, c.id);
        this.event('regressed', 'sync', { observation, path: s.path }, c.ticket_id, c.id);
      } else if (!backwards && c.regressed_since != null && extendsPath(g, this.expectedPath(c.id, c.start_path), s.path, g.start)) {
        this.exec('UPDATE claims SET regressed_since = NULL WHERE id = ?', c.id);
      }
    }
    // R-BTN-63: the sync's reading of a leg's bars binds; a tag a holder declared that a later
    // snapshot's bars for that leg lack is logged once per leg run — whether the claim is still
    // active or has ended, typically at the snapshot that confirms its suspension (round 1, 1-A-1).
    for (const [ticketId, s] of seen) {
      for (const l of this.rows<{ claim_id: number; seq: number; leg: string; bars: string }>(
        `SELECT l.claim_id, l.seq, l.leg, l.bars FROM claim_legs l JOIN claims c ON c.id = l.claim_id
         WHERE c.ticket_id = ? AND l.bars != '[]' AND l.started_observation < ?`, ticketId, observation)) {
        const posted = s.bars[l.leg];
        if (!posted) continue;
        const missing = (JSON.parse(l.bars) as string[]).filter((t) => !posted.includes(t));
        if (!missing.length) continue;
        if (this.rows(`SELECT 1 FROM events WHERE claim_id = ? AND kind = 'bars-mismatch' AND json_extract(detail_json, '$.seq') = ?`, l.claim_id, l.seq).length) continue;
        this.event('bars-mismatch', 'sync', { seq: l.seq, leg: l.leg, declared_only: missing, observation }, ticketId, l.claim_id);
      }
    }
    return { confirmed, stale_released: stale };
  }

  /** R-BTN-10's test of one completed end against the head snapshot. */
  private endShown(c: { id: number; ticket_id: string; end_reason: string; start_path: string; ended_regressed: number; course_id: string | null }, observation: number): boolean {
    const st = this.rows<{ station: string; path: string; observation: number }>('SELECT station, path, observation FROM ticket_stations WHERE ticket_id = ?', c.ticket_id)[0];
    const live = this.rows('SELECT 1 FROM tickets WHERE id = ?', c.ticket_id).length > 0;
    const g = c.course_id ? this.stations.graph(repositoryOf(c.ticket_id), c.course_id) : null;
    if (c.end_reason === 'done') {
      if (!live) return true; // absent from a snapshot observed after the end
      return !!st && st.observation >= observation && !!g && g.ends.has(st.station);
    }
    if (!c.end_reason.startsWith('suspended:') || !st || st.observation < observation || !g) return false;
    if (c.ended_regressed) return true; // git had already overruled the claim (R-BTN-71)
    return extendsPath(g, this.expectedPath(c.id, c.start_path), JSON.parse(st.path) as Step[], g.start);
  }

  /** R-BTN-64: a course file accepted with renames rewrites its active claims' station and leg. */
  renameActive(repo: string, course: string) {
    const g = this.stations.graph(repo, course);
    if (!g || (!g.legRenames.size && !g.stationRenames.size)) return;
    for (const c of this.rows<{ id: number; station: string; leg: string | null }>(
      `SELECT id, station, leg FROM claims WHERE status = 'active' AND course_id = ? AND substr(ticket_id, 1, length(?) + 1) = ? || ':'`, course, repo, repo)) {
      const station = g.stationRenames.get(c.station) ?? c.station;
      const leg = c.leg == null ? null : g.legRenames.get(c.leg) ?? c.leg;
      if (station !== c.station || leg !== c.leg) this.exec('UPDATE claims SET station = ?, leg = ? WHERE id = ?', station, leg, c.id);
    }
  }

  /** R-BTN-35 (git wins), on each accepted snapshot after cutover: an active claim whose ticket
   *  git took away — withdrawn, gone with no `done` closure, re-tiered above the holder's ceiling,
   *  or at an interim status that ends the item — ends `released:stale-board`, and the holder is
   *  told. A station that lags the holder's advances is never staleness (§2e). Before cutover git
   *  decides alone and the shadow reports end claims. */
  private staleBoard(repo: string, observation: number) {
    if (!this.rows('SELECT 1 FROM repositories WHERE id = ? AND cutover_at IS NOT NULL', repo).length) return 0;
    const active = this.rows<{ id: number; ticket_id: string; worker_id: number; tier_ceiling: string; tier_ceilings: string; kind: string }>(
      `SELECT c.id, c.ticket_id, c.worker_id, w.tier_ceiling, w.tier_ceilings, w.kind FROM claims c JOIN workers w ON w.id = c.worker_id
       WHERE c.status = 'active' AND substr(c.ticket_id, 1, length(?) + 1) = ? || ':'
         AND c.claim_observation < ?`, repo, repo, observation); // R-BTN-62: a reading from before the claim cannot judge it
    let n = 0;
    const ladder = this.ladder(repo);
    for (const c of active) {
      const it = this.rows<{ status: string; tier: string | null }>('SELECT status, tier FROM tickets WHERE id = ?', c.ticket_id)[0];
      const closed = this.rows<{ closed_as: string }>('SELECT closed_as FROM closed_tickets WHERE ticket_id = ?', c.ticket_id)[0]?.closed_as;
      // A legacy holder declared no ceiling: its claim is never re-tiered away.
      const ceiling = c.kind === 'legacy' ? ladder[ladder.length - 1] : ceilingIn(repo, ladder, JSON.parse(c.tier_ceilings), c.tier_ceiling);
      // Closed `done` is the holder's own archive, pushed before its end (R-BTN-8): the heartbeat
      // tells it `closed: 'done'` and it ends done, so that is not staleness.
      const why = !it ? (closed === 'done' ? null : closed === 'withdrawn' ? 'withdrawn' : 'gone or archived') : GIT_ENDS.has(it.status) ? it.status
        : !fitsTier(it.tier ?? null, ceiling, ladder) ? `re-tiered ${it.tier ?? 'untiered'}` : null;
      if (!why) continue;
      this.finish(c.id, c.ticket_id, 'released', 'released:stale-board', 'sync', {});
      if (c.kind !== 'legacy') {
        this.exec(`INSERT INTO messages (kind, payload_json, from_principal, to_worker_id, sent_at, status) VALUES ('release', ?, 'sync', ?, ?, 'pending')`,
          JSON.stringify({ ticket_id: c.ticket_id, reason: 'stale-board', why }), c.worker_id, this.c.now());
      }
      n++;
    }
    return n;
  }

  // ── the alarm's share (§6.6, §7.1, §9) ──────────────────────────────────────────────────

  alarm() {
    const now = this.c.now();
    // Silent workers: reaped at exactly their clamped timeout (R-BTN-9), never by Date.now().
    const silent = this.rows<{ id: number; ticket_id: string; worker_id: number; kind: string }>(
      `SELECT c.id, c.ticket_id, c.worker_id, w.kind FROM claims c JOIN workers w ON w.id = c.worker_id
       WHERE c.status = 'active' AND ((w.kind != 'legacy' AND ? - w.last_seen_at >= w.lease_timeout_ms)
                                      OR (w.kind = 'legacy' AND c.reap_after IS NOT NULL AND c.reap_after <= ?))`, now, now);
    for (const c of silent) {
      this.finish(c.id, c.ticket_id, 'reaped', c.kind === 'legacy' ? 'reaped:legacy' : 'reaped:silent', 'alarm', {});
      this.exec('UPDATE workers SET reaped_at = ? WHERE id = ? AND reaped_at IS NULL', now, c.worker_id);
    }
    // §9: a release delivered 2 h ago and still unacknowledged reaps the claim, fenced: the
    // worker is alive (it took the message), so the item waits for its fence (R-BTN-19).
    const stale = this.rows<{ mid: number; id: number; ticket_id: string; worker_id: number; incarnation: number }>(
      `SELECT m.id AS mid, c.id, c.ticket_id, c.worker_id, w.incarnation FROM messages m
       JOIN claims c ON c.worker_id = m.to_worker_id AND c.status = 'active' AND c.ticket_id = json_extract(m.payload_json, '$.ticket_id')
       JOIN workers w ON w.id = c.worker_id
       WHERE m.kind = 'release' AND m.status = 'delivered' AND m.delivered_at <= ?`, now - RELEASE_ACK_MS);
    const reaped = new Set<number>();
    for (const c of stale) {
      this.exec(`UPDATE messages SET status = 'expired' WHERE id = ?`, c.mid);
      if (reaped.has(c.id)) continue; // two stale releases for one claim reap it once
      reaped.add(c.id);
      this.finish(c.id, c.ticket_id, 'reaped', 'reaped:release-unacknowledged', 'alarm', { fence: { incarnation: c.incarnation } });
    }
    // A fence also clears when its worker goes silent past its own timeout (R-BTN-19).
    const lapsed = this.rows<{ id: number; ticket_id: string; worker_id: number }>(
      `SELECT c.id, c.ticket_id, c.worker_id FROM claims c JOIN workers w ON w.id = c.worker_id
       WHERE c.status = 'reaped' AND c.fence_pending = 1 AND ? - w.last_seen_at >= w.lease_timeout_ms`, now);
    for (const c of lapsed) {
      this.exec('UPDATE claims SET fence_pending = 0 WHERE id = ?', c.id);
      this.exec('UPDATE workers SET reaped_at = ? WHERE id = ? AND reaped_at IS NULL', now, c.worker_id);
      this.event('fence-cleared', 'alarm', { by: 'timeout' }, c.ticket_id, c.id);
    }
    // §7.1: a held history is accepted automatically 24 h after its first post.
    for (const h of this.rows<{ repository_id: string; sha: string }>('SELECT repository_id, sha FROM held_snapshots WHERE accepted_at IS NULL AND auto_accept_at <= ?', now)) {
      this.exec('UPDATE held_snapshots SET accepted_at = ? WHERE repository_id = ? AND sha = ?', now, h.repository_id, h.sha);
      this.event('snapshot-accepted', 'alarm', { sha: h.sha, held: true, by: 'auto-accept' }, null, null, h.repository_id);
    }
  }

  // ── the dashboard (§14: Running, Timeline, Needs you) ───────────────────────────────────

  running(now: number) {
    return this.rows<Row>(
      `SELECT c.id, c.ticket_id, c.worker_id, c.claimed_at, c.nonce, w.hostname, w.session_name, w.last_seen_at, w.last_activity_at,
              w.lease_timeout_ms, w.kind, wi.title
       FROM claims c JOIN workers w ON w.id = c.worker_id LEFT JOIN tickets wi ON wi.id = c.ticket_id
       WHERE c.status = 'active' ORDER BY c.claimed_at`).map((c) => {
      const alive = c.kind !== 'legacy' && now - (c.last_seen_at as number) < (c.lease_timeout_ms as number);
      return {
        ...c,
        alive,
        reap_at: c.kind === 'legacy' ? null : (c.last_seen_at as number) + (c.lease_timeout_ms as number),
        stalled: alive && (c.last_activity_at == null ? now - (c.claimed_at as number) : now - (c.last_activity_at as number)) > STALLED_MS,
        events: this.rows('SELECT at, kind, actor, detail_json FROM events WHERE claim_id = ? ORDER BY seq', c.id),
        activities: this.rows('SELECT id, kind, label, started_at, ended_at, outcome, parent_id FROM activities WHERE claim_id = ? ORDER BY started_at', c.id),
      };
    });
  }

  /** One lane per alive worker over the last 24 h: its claims as bars and their activities. */
  timeline(now: number) {
    const from = now - 24 * 3_600_000;
    const lanes = this.rows<{ id: number; hostname: string; session_name: string }>(
      `SELECT id, hostname, session_name FROM workers WHERE reaped_at IS NULL AND ? - last_seen_at < lease_timeout_ms ORDER BY hostname, id`, now);
    return {
      from,
      to: now,
      lanes: lanes.map((l) => ({
        ...l,
        claims: this.rows<Row>(`SELECT id, ticket_id, claimed_at, ended_at, status, end_reason FROM claims
                                WHERE worker_id = ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY claimed_at`, l.id, from).map((c) => ({
          ...c,
          activities: this.rows<Row>('SELECT id, kind, seq, label, started_at, ended_at, outcome, parent_id, detail_json FROM activities WHERE claim_id = ? ORDER BY started_at', c.id)
            .map((a) => {
              // §6.8: a link built only from validated parts — the activity's own transcript, else the session's.
              const t = this.rows<{ repo: string; path: string }>(
                `SELECT repo, path FROM transcripts WHERE claim_id = ? AND (activity_id = ? OR activity_id IS NULL) ORDER BY activity_id IS NULL, id LIMIT 1`, c.id, a.id)[0];
              return { ...a, transcript_url: t ? transcriptUrl(t.repo, t.path) : null };
            }),
        })),
      })),
    };
  }

  needsYou(now: number) {
    return {
      // §6.7: never auto-confirmed; the owner resolves it.
      unconfirmed: this.rows(`SELECT id, ticket_id, worker_id, ended_at, end_reason, ended_at_sha FROM claims
                              WHERE status = 'completed' AND confirmed_at IS NULL AND ended_at <= ? ORDER BY ended_at`, now - UNCONFIRMED_FLAG_MS),
      unacknowledged_releases: this.rows(`SELECT id, to_worker_id, payload_json, sent_at, delivered_at FROM messages
                                          WHERE kind = 'release' AND status IN ('pending','delivered') ORDER BY sent_at`),
      fence_pending: this.rows(`SELECT id, ticket_id, worker_id, ended_at FROM claims WHERE status = 'reaped' AND fence_pending = 1 ORDER BY ended_at`),
      // R-BTN-22: live workers declaring a course below its min_worker_version, one row per
      // course, and those declaring none (course_id null) — each needs a restart from a pulled
      // checkout.
      stale_skills: this.rows(`SELECT w.id, w.hostname, w.session_name, f.repository_id, f.course_id, f.version, k.min_worker_version
                               FROM workers w JOIN worker_courses f ON f.worker_id = w.id
                               JOIN courses k ON k.repository_id = f.repository_id AND k.id = f.course_id
                               WHERE w.reaped_at IS NULL AND w.kind != 'legacy' AND f.version < k.min_worker_version AND ? - w.last_seen_at < w.lease_timeout_ms
                               UNION ALL
                               SELECT w.id, w.hostname, w.session_name, NULL, NULL, NULL, NULL FROM workers w
                               WHERE w.reaped_at IS NULL AND w.kind != 'legacy' AND ? - w.last_seen_at < w.lease_timeout_ms
                                 AND NOT EXISTS (SELECT 1 FROM worker_courses f WHERE f.worker_id = w.id) AND EXISTS (SELECT 1 FROM courses)
                               ORDER BY 1, 4, 5`, now, now),
      // §2e: a claim git has shown going backwards for 30 minutes.
      regressed: this.rows(`SELECT c.id, c.ticket_id, c.worker_id, c.regressed_since, s.path FROM claims c LEFT JOIN ticket_stations s ON s.ticket_id = c.ticket_id
                            WHERE c.status = 'active' AND c.regressed_since IS NOT NULL AND c.regressed_since <= ? ORDER BY c.regressed_since`, now - REGRESSED_FLAG_MS),
      // R-BTN-63: the holder and the sync read a leg's bars differently; the sync's reading binds.
      bars_mismatch: this.rows(`SELECT e.claim_id, e.ticket_id, e.at, e.detail_json FROM events e WHERE e.kind = 'bars-mismatch' AND e.at > ? ORDER BY e.seq`, now - BARS_MISMATCH_LISTED_MS),
      held_items: this.rows<{ ticket_id: string; hold_reason: string | null; set_at: number }>(
        `SELECT ticket_id, hold_reason, set_at FROM ticket_overrides WHERE hold = 1 ORDER BY ticket_id`).map((h) => ({
        ...h,
        attempts: this.rows(`SELECT id, end_reason, ended_at, resume_json FROM claims WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`,
          JSON.stringify(this.failedAttempts(h.ticket_id))),
      })),
    };
  }
}

