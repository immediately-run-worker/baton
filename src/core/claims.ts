// claims.ts — the fenced lease (BATON_SPEC §6.1–6.7, §7.2 rules 1–10, §11 claim, end, holder and
// reap rows; R3-1212), with attempts, retries, holds and resume records (§6.10–6.11; R3-1217): claiming by the matching rules, ending in §6.5's vocabulary, the alarm's
// reaps, the fence before re-issue (R-BTN-19), confirmation by ancestry, and git winning over a
// stale claim (R-BTN-35). The lock is the two partial unique indexes: a claim inserts and lets
// SQLite refuse a second holder, never check-then-insert without them (R-BTN-4).
import { BatonError } from './http';
import { isUniqueViolation, logEvent, randomHex } from './db';
import { familyOf, isEligible, RULE_CODES, suspended } from '../shared/baton.mjs';
import { fitsTier, TIERS } from '../shared/vocabulary.mjs';
import { afterFailure, countsAsFailed, nonRetryableClass, resumeRecord, reviewCapacityRun, REVIEW_CAPACITY_LOOPS, type ResumeActivity } from './attempts';
import { checkAccept, checkClaim, checkConfirm, checkEnd, checkOverride, checkResolve } from './validate';
import { repositoryOf, transcriptReposOf } from './registry';

import type { Row, SqlValue, Store } from './ports';
const EXPEDITE_BOUND = 2; // §7.2 rule 2
const RELEASE_ACK_MS = 2 * 3_600_000; // §9: a delivered release unacknowledged for 2 h reaps the claim
export const UNCONFIRMED_FLAG_MS = 6 * 3_600_000; // §6.7
const STALLED_MS = 2 * 3_600_000; // §14 Running: alive but no activity for 2 h
/** R-BTN-35: the git states that end an active claim `released:stale-board`. */
const GIT_ENDS = new Set(['done', 'superseded', 'deferred', 'deprioritized']);

export interface Ctx {
  store: Store;
  now: () => number;
  /** §12: ask for the ticket's repository's sync or mirror to be dispatched once this
   *  request's transaction has committed. */
  dispatch?: (kind: 'mirror' | 'sync', ticketId: string) => void;
}

interface WorkerFacts {
  id: number;
  kind: string;
  incarnation: number;
  model_id: string | null;
  model_provider_id: string | null;
  tier_ceiling: string;
  lease_timeout_ms: number;
  last_seen_at: number;
  last_activity_at: number | null;
  declared: string[];
  billing: Record<string, string>;
  /** The courses its checkouts run (R-BTN-48): rule 9. */
  courses: { repository: string; course: string; version: number }[];
}

interface ItemFacts {
  id: string;
  repository: string;
  course: string;
  path: string;
  node: string;
  queue: string;
  status: string;
  tier: string | null;
  tags: string[];
  requires: string[] | null;
  expedite: boolean;
  rank: number | null;
}


export class Claims {
  constructor(private readonly c: Ctx) {}

  private rows<T = Row>(q: string, ...p: unknown[]): T[] {
    return this.c.store.exec(q, ...p).toArray() as T[];
  }
  private exec(q: string, ...p: unknown[]) {
    return this.c.store.exec(q, ...p);
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
    const w = this.rows<Omit<WorkerFacts, 'declared' | 'billing' | 'courses'>>(
      `SELECT id, kind, incarnation, model_id, model_provider_id, tier_ceiling, lease_timeout_ms, last_seen_at, last_activity_at
       FROM workers WHERE id = ?`, id)[0];
    if (!w) throw new BatonError('unauthenticated', 'no such worker');
    const declared = this.rows<{ declared: string }>('SELECT DISTINCT declared FROM worker_capabilities WHERE worker_id = ? ORDER BY declared', id).map((r) => r.declared);
    const billing = Object.fromEntries(this.rows<{ prefix: string; provider_id: string }>('SELECT prefix, provider_id FROM worker_providers WHERE worker_id = ?', id).map((r) => [r.prefix, r.provider_id]));
    const courses = this.rows<{ repository: string; course: string; version: number }>(
      'SELECT repository_id AS repository, course_id AS course, version FROM worker_courses WHERE worker_id = ? ORDER BY repository_id, course_id', id);
    return { ...w, declared, billing, courses };
  }

  private item(id: string): ItemFacts | null {
    const r = this.rows<{ id: string; repository_id: string; course_id: string; path: string; node: string; queue: string; status: string; tier: string | null; tags: string; requires_clause: string; operator_only: number; rank: number | null }>(
      'SELECT id, repository_id, course_id, path, node, queue, status, tier, tags, requires_clause, operator_only, rank FROM tickets WHERE id = ?', id)[0];
    if (!r) return null;
    const requires = r.requires_clause === 'listed'
      ? this.rows<{ name: string }>('SELECT name FROM ticket_requires WHERE ticket_id = ? ORDER BY name', id).map((x) => x.name)
      : null;
    const tags: string[] = JSON.parse(r.tags);
    // Rule 6 reads `operator_only` (§7.2): the sync stores no role name, human-operator included.
    if (r.operator_only && !tags.includes('OP')) tags.push('OP');
    const override = this.override(id);
    return { id: r.id, repository: r.repository_id, course: r.course_id, path: r.path, node: r.node, queue: r.queue, status: r.status, tier: r.tier, tags, requires,
      expedite: r.queue === 'expedite' || !!override?.expedite, rank: r.rank };
  }

  private override(id: string) {
    return this.rows<{ expedite: number; hold: number; retry_after: number | null }>('SELECT expedite, hold, retry_after FROM ticket_overrides WHERE ticket_id = ?', id)[0] ?? null;
  }

  private suspensions() {
    return this.rows('SELECT id, provider_id, model_id, starts_at, ends_at, lifted_at FROM provider_suspensions WHERE lifted_at IS NULL');
  }

  /** The reviewer data rule 8 reads (R-BTN-27): the posted matrix and catalog, or none. */
  private reviewerData(): { matrix: Record<string, unknown> | null; catalog: Record<string, unknown> | null } {
    const m = this.setting('reviewer_matrix');
    const c = this.setting('reviewer_catalog');
    return { matrix: m ? JSON.parse(m) : null, catalog: c ? JSON.parse(c) : null };
  }

  /** `isEligible`'s context for one item (§7.2), from Baton's own tables (R-BTN-33). */
  private contextFor(item: ItemFacts, now: number, shared: { suspensions: Row[]; expediteActive: number; reviewer: ReturnType<Claims['reviewerData']> }) {
    const claims = this.rows('SELECT status, confirmed_at, fence_pending FROM claims WHERE ticket_id = ?', item.id);
    const last = this.rows<{ end_reason: string | null }>(
      `SELECT end_reason FROM claims WHERE ticket_id = ? AND status != 'active' ORDER BY ended_at DESC, id DESC LIMIT 1`, item.id)[0];
    const lastEndReason = last?.end_reason ?? null;
    let authorFamilies: (string | null)[] = [];
    if (lastEndReason === 'released:awaiting-review-capacity' && shared.reviewer.matrix) {
      // R-BTN-27: every family that wrote code on the item, the original author first — the
      // families of the coding models of the item's earlier claims.
      authorFamilies = this.rows<{ model_id: string | null }>(
        `SELECT w.model_id FROM claims c JOIN workers w ON w.id = c.worker_id WHERE c.ticket_id = ? ORDER BY c.id`, item.id)
        .map((r) => (r.model_id ? familyOf(r.model_id, shared.reviewer.matrix) : null));
    }
    return {
      now,
      claims,
      override: this.override(item.id),
      suspensions: shared.suspensions,
      // Rule 9 (R-BTN-65): the item's course's. A ticket whose course is not registered (a head
      // posted before migration 0007, until its next post) fits no worker, as the query has it.
      minWorkerVersion: this.rows<{ v: number }>('SELECT min_worker_version AS v FROM courses WHERE repository_id = ? AND id = ?', item.repository, item.course)[0]?.v ?? Number.POSITIVE_INFINITY,
      expediteActive: shared.expediteActive,
      expediteBound: EXPEDITE_BOUND,
      lastEndReason,
      authorFamilies,
      catalog: shared.reviewer.catalog ?? (shared.reviewer.matrix as { agents?: unknown } | null)?.agents,
      matrix: shared.reviewer.matrix ?? { families: {}, agents: {}, rows: [] },
    };
  }

  private shared(now: number) {
    return {
      suspensions: this.suspensions(),
      // Rule 2 counts active Baton claims on expedited items, not git in-progress.
      expediteActive: this.rows<{ n: number }>(
        `SELECT count(*) AS n FROM claims c LEFT JOIN tickets w ON w.id = c.ticket_id
         LEFT JOIN ticket_overrides o ON o.ticket_id = c.ticket_id
         WHERE c.status = 'active' AND (w.queue = 'expedite' OR o.expedite = 1)`)[0].n,
      reviewer: this.reviewerData(),
      now,
    };
  }

  /** The §7.2 candidate query: rules 1, 3, 4, 5 (as a tier rank), 6, 9 and 10, across every
   *  cut-over repository: expedited first, then the repositories by weight, each in its own rank
   *  order (an interim of R-BTN-61's merge, which R3-1232 builds). */
  candidates(w: WorkerFacts, now: number, limit = 20, rule9 = true): string[] {
    return this.rows<{ id: string }>(
      `SELECT w.id FROM tickets w JOIN repositories p ON p.id = w.repository_id
       WHERE w.node LIKE 'ready-%' AND p.cutover_at IS NOT NULL AND p.retired_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.ticket_id = w.id
                         AND (c.status = 'active'
                              OR (c.status = 'completed' AND c.confirmed_at IS NULL)
                              OR (c.status = 'reaped' AND c.fence_pending = 1)))
         AND NOT EXISTS (SELECT 1 FROM ticket_overrides o WHERE o.ticket_id = w.id
                         AND (o.hold = 1 OR o.retry_after > ?))
         AND NOT EXISTS (SELECT 1 FROM ticket_requires r WHERE r.ticket_id = w.id
                         AND r.name NOT IN (SELECT capability FROM worker_capabilities WHERE worker_id = ?))
         AND ? >= CASE COALESCE(w.tier, 'critical') WHEN 'routine' THEN 0 WHEN 'judgement' THEN 1 ELSE 2 END
         AND (? OR w.operator_only = 0)
         AND (? = 0 OR EXISTS (SELECT 1 FROM worker_courses f JOIN courses k ON k.repository_id = f.repository_id AND k.id = f.course_id
                               WHERE f.worker_id = ? AND f.repository_id = w.repository_id AND f.course_id = w.course_id
                                 AND f.version >= k.min_worker_version))
       ORDER BY COALESCE((SELECT expedite FROM ticket_overrides o WHERE o.ticket_id = w.id), 0) DESC, p.weight DESC, w.rank, w.repository_id
       LIMIT ?`,
      now, w.id, (TIERS as string[]).indexOf(w.tier_ceiling), w.declared.includes('human-operator') ? 1 : 0, rule9 ? 1 : 0, w.id, limit).map((r) => r.id);
  }

  /** The worker-level rule, checked once before any query (§7.2): 7, with the same
   *  functions `isEligible` applies to each item. */
  private workerRules(w: WorkerFacts, now: number, shared: ReturnType<Claims['shared']>) {
    if (suspended(shared.suspensions, w.model_provider_id, w.model_id, now)) {
      throw new BatonError('provider-suspended', 'the coding model’s account is suspended or unresolved (§7.4)', { rule: 7 });
    }
  }

  /** `isEligible` for one item. Rule 8 reads the reviewer matrix, which a board may post
   *  without a usable row (no `default`): that fails closed as rule 8, never as a 500. */
  private eligible(w: WorkerFacts, item: ItemFacts, now: number, shared: ReturnType<Claims['shared']>): { ok: boolean; rule?: number | string; code?: string } {
    const context = this.contextFor(item, now, shared);
    try {
      return isEligible(w, item, context);
    } catch (e) {
      if (context.lastEndReason !== 'released:awaiting-review-capacity') throw e;
      return { ok: false, rule: 8, code: RULE_CODES[8] };
    }
  }

  /** The item a claim by `w` would get now: the named one if eligible, else the first
   *  eligible candidate. Throws the §11 refusal. */
  private decide(w: WorkerFacts, wanted: string | null, now: number): { item: ItemFacts; reason: string } {
    const shared = this.shared(now);
    this.workerRules(w, now, shared);
    if (wanted) {
      if (!this.cutOver(wanted)) throw new BatonError('not-cut-over', `${repositoryOf(wanted)}'s claims go through git until its cutover (R-BTN-28)`);
      const item = this.item(wanted);
      if (!item || !item.node.startsWith('ready-')) throw new BatonError('not-eligible', `${wanted} is not in the claim order`, { rule: 1, rule_code: 'not-ready' });
      const v = this.eligible(w, item, now, shared);
      // Two refusals have codes of their own (§11): a backoff, and a worker stale on the course.
      if (!v.ok) throw new BatonError(v.code === 'backing-off' || v.code === 'stale-skills' ? v.code : 'not-eligible', `${wanted}: ${v.code}`, { rule: v.rule, rule_code: v.code });
      return { item, reason: 'requested' };
    }
    for (const id of this.candidates(w, now)) {
      const item = this.item(id)!;
      if (this.eligible(w, item, now, shared).ok) {
        return { item, reason: item.expedite ? 'expedite lane' : `${item.queue} queue · rank ${item.rank ?? '—'}` };
      }
    }
    // Rule 9 is per course now: say `stale-skills` when it alone stood between this worker and
    // a ticket, so the worker knows to restart from a pulled checkout (R-BTN-22).
    // Only tickets of courses the worker declares count: a course it does not run at all is not
    // its to restart for, so that stays no-eligible-ticket (round 3, 3-A-1). A worker declaring
    // no course at all is stale on every course (its sidecar predates R-BTN-22's change).
    if (this.candidates(w, now, 20, false).some((id) => {
      const item = this.item(id)!;
      return (!w.courses.length || w.courses.some((c) => c.repository === item.repository && c.course === item.course))
        && this.eligible(w, item, now, shared).code === RULE_CODES[9];
    })) {
      throw new BatonError('stale-skills', 'this worker does not declare the ready tickets’ courses at their min_worker_version — it declares an older version or none (R-BTN-22, R-BTN-65)', { rule: 9 });
    }
    throw new BatonError('no-eligible-ticket', 'no ready ticket fits this worker');
  }

  // ── the worker calls (§11) ──────────────────────────────────────────────────────────────

  /** `GET /v1/runner/next`: what a claim would return, without claiming (for next-available.sh). */
  next(workerId: number) {
    const { item, reason } = this.decide(this.worker(workerId), null, this.c.now());
    return { ticket_id: item.id, rank_reason: reason };
  }

  /** `POST /v1/runner/claim` (§6.2): idempotent by `request_id`; the lock is the index. */
  claim(workerId: number, body: unknown) {
    const b = checkClaim(body);
    if (!this.anyCutOver()) throw new BatonError('not-cut-over', 'claims go through git until cutover (R-BTN-28)');
    const prior = this.rows<{ id: number; worker_id: number }>('SELECT id, worker_id FROM claims WHERE request_id = ?', b.request_id)[0];
    if (prior) {
      // A lost response retried: the same claim, never a second item (G-BTN-2).
      if (prior.worker_id !== workerId) throw new BatonError('invalid-params', 'request_id: already used by another worker');
      return this.claimResponse(prior.id);
    }
    const now = this.c.now();
    const w = this.worker(workerId);
    const mine = this.rows<{ ticket_id: string }>(`SELECT ticket_id FROM claims WHERE worker_id = ? AND status = 'active'`, workerId)[0];
    if (mine) throw new BatonError('not-eligible', `this worker holds ${mine.ticket_id}; end it before claiming another (R-BTN-4)`, { rule: 'one-claim-per-worker' });
    const { item } = this.decide(w, b.ticket_id, now);
    try {
      this.exec(`INSERT INTO claims (ticket_id, worker_id, request_id, nonce, snapshot_sha, claimed_at, status)
                 VALUES (?, ?, ?, ?, ?, ?, 'active')`, item.id, workerId, b.request_id, randomHex(3), this.headOf(repositoryOf(item.id)) ?? '', now);
    } catch (e) {
      // R-BTN-4: the partial unique indexes refuse a second holder of the item or the worker.
      if (isUniqueViolation(e)) throw new BatonError('not-eligible', `${item.id} is already held`, { rule: 3, rule_code: RULE_CODES[3] });
      throw e;
    }
    const id = this.rows<{ id: number }>('SELECT last_insert_rowid() AS id')[0].id;
    this.event('claimed', `worker:${workerId}`, { request_id: b.request_id }, item.id, id);
    this.c.dispatch?.('mirror', item.id);
    // §6.8: transcripts reported while the worker held nothing are linked to this claim — those
    // in its repository's transcript repositories (R-BTN-66); the rest are dropped.
    const allowed = transcriptReposOf(this.c.store, repositoryOf(item.id));
    this.exec(`INSERT INTO transcripts (worker_id, claim_id, repo, path, role, activity_id, first_seen_at, last_pushed_at)
               SELECT worker_id, ?, repo, path, role, activity_id, first_seen_at, last_pushed_at FROM pending_transcripts
               WHERE worker_id = ? AND repo IN (SELECT value FROM json_each(?))
               ON CONFLICT (worker_id, repo, path, claim_id) DO NOTHING`, id, workerId, JSON.stringify(allowed));
    this.exec('DELETE FROM pending_transcripts WHERE worker_id = ?', workerId);
    return this.claimResponse(id);
  }

  /** The claim response (§11, R-BTN-34): the item's path and the snapshot it was decided on —
   *  never the item's content — and the earlier attempts, newest first, each with its resume record (§6.11, R-BTN-24). */
  private claimResponse(id: number) {
    const c = this.rows<{ id: number; ticket_id: string; nonce: string; snapshot_sha: string }>('SELECT id, ticket_id, nonce, snapshot_sha FROM claims WHERE id = ?', id)[0];
    const path = this.rows<{ path: string }>('SELECT path FROM tickets WHERE id = ?', c.ticket_id)[0]?.path ?? null;
    const previous = this.rows<{ id: number; status: string; end_reason: string | null; ended_at: number | null; resume_json: string | null }>(
      `SELECT id, status, end_reason, ended_at, resume_json FROM claims WHERE ticket_id = ? AND id < ? AND status != 'active' ORDER BY id DESC`, c.ticket_id, id);
    return {
      claim_id: c.id, ticket_id: c.ticket_id, path, nonce: c.nonce, snapshot_sha: c.snapshot_sha,
      previous_attempts: previous.map((p) => ({ claim_id: p.id, status: p.status, end_reason: p.end_reason, ended_at: p.ended_at, resume: p.resume_json ? JSON.parse(p.resume_json) : null })),
    };
  }

  /** `POST /v1/runner/claims/{id}/end` (§6.5, R-BTN-8). A retried identical end is a no-op. */
  end(workerId: number, claimId: number, body: unknown) {
    const e = checkEnd(body);
    const c = this.rows<{ id: number; worker_id: number; ticket_id: string; status: string; end_reason: string | null }>(
      'SELECT id, worker_id, ticket_id, status, end_reason FROM claims WHERE id = ?', claimId)[0];
    if (!c && !this.anyCutOver()) throw new BatonError('not-cut-over', 'claims end through git until cutover (R-BTN-28)');
    if (c && !this.cutOver(c.ticket_id)) throw new BatonError('not-cut-over', `${repositoryOf(c.ticket_id)}'s claims end through git until its cutover (R-BTN-28)`);
    if (!c || c.worker_id !== workerId) throw new BatonError('not-holder', 'this worker does not hold that claim');
    if (c.status !== 'active') {
      if (c.end_reason === e.end_reason) return { ok: true };
      // R-BTN-8 pushes git first, so a sync can see the item done and release the claim
      // stale-board (R-BTN-35) before the worker's own end arrives: that completion is the
      // truth, recorded as such, and the release it no longer needs is withdrawn.
      if (c.status === 'released' && c.end_reason === 'released:stale-board' && e.status === 'completed' && this.gitEnded(c.ticket_id, c.id)) {
        this.exec(`UPDATE claims SET status = 'completed', end_reason = ?, ended_at_sha = ? WHERE id = ?`, e.end_reason, e.ended_at_sha, c.id);
        this.exec(`UPDATE messages SET status = 'expired' WHERE to_worker_id = ? AND kind = 'release' AND status IN ('pending','delivered')
                   AND json_extract(payload_json, '$.ticket_id') = ? AND json_extract(payload_json, '$.reason') = 'stale-board'`, workerId, c.ticket_id);
        this.event('completed', `worker:${workerId}`, { end_reason: e.end_reason, ended_at_sha: e.ended_at_sha, after: 'released:stale-board' }, c.ticket_id, c.id);
        this.c.dispatch?.('sync', c.ticket_id);
        return { ok: true };
      }
      throw new BatonError('claim-ended', `the claim already ended (${c.status}: ${c.end_reason})`);
    }
    this.finish(c.id, c.ticket_id, e.status, e.end_reason, `worker:${workerId}`, { ended_at_sha: e.ended_at_sha });
    return { ok: true };
  }

  /** Ends an active claim: its open activities close `abandoned` (§6.9) and the end is logged. */
  private finish(claimId: number, item: string, status: 'completed' | 'released' | 'reaped', reason: string, actor: string,
    opts: { ended_at_sha?: string | null; fence?: { incarnation: number } | null } = {}) {
    const now = this.c.now();
    this.exec(`UPDATE claims SET status = ?, ended_at = ?, end_reason = ?, ended_at_sha = ?, fence_pending = ?, fence_incarnation = ? WHERE id = ?`,
      status, now, reason, opts.ended_at_sha ?? null, opts.fence ? 1 : 0, opts.fence?.incarnation ?? null, claimId);
    this.exec(`UPDATE activities SET ended_at = ?, outcome = 'abandoned' WHERE claim_id = ? AND ended_at IS NULL`, now, claimId);
    this.event(status, actor, { end_reason: reason, ...(opts.ended_at_sha ? { ended_at_sha: opts.ended_at_sha } : {}), ...(opts.fence ? { fence_pending: true } : {}) }, item, claimId);
    // §12: the mirror writes the end; a completion also wants a board sync, which confirms it
    // (R-BTN-10) without waiting for an unrelated push.
    this.c.dispatch?.('mirror', item);
    if (status === 'completed') this.c.dispatch?.('sync', item);
    // §13 step 3: a legacy claim that ends takes its adoption request with it.
    this.exec('DELETE FROM adoptions WHERE claim_id = ?', claimId);
    if (status !== 'completed') {
      this.writeResume(claimId, reason, now);
      this.applyRetryPolicy(claimId, item, reason);
    }
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
  private writeResume(claimId: number, reason: string, now: number) {
    const acts = this.rows<ResumeActivity>('SELECT kind, seq, label, started_at, ended_at, outcome, detail_json FROM activities WHERE claim_id = ? ORDER BY started_at', claimId);
    const transcripts = this.rows<{ repo: string; path: string; role: string }>('SELECT repo, path, role FROM transcripts WHERE claim_id = ? ORDER BY id', claimId);
    this.exec('UPDATE claims SET resume_json = ? WHERE id = ?', JSON.stringify(resumeRecord(reason, now, acts, transcripts)), claimId);
  }

  /** §6.10 and §7.4, after a claim ends other than completed: mark the failed attempt, then
   *  back off, or hold — non-retryable at once, attempts-exhausted at the third, review-capacity
   *  at the third consecutive awaiting-review-capacity release. */
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
    if (reason === 'released:awaiting-review-capacity') {
      if (reviewCapacityRun(ended.map((e) => e.end_reason)) >= REVIEW_CAPACITY_LOOPS) this.hold(item, 'review-capacity', 'baton', { claim_id: claimId });
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
    return !it || GIT_ENDS.has(it.status);
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
  confirm(confirmations: { claim_id: number; sha: string }[]) {
    const now = this.c.now();
    let n = 0;
    for (const k of confirmations) {
      const c = this.rows<{ ticket_id: string }>(`SELECT ticket_id FROM claims WHERE id = ? AND status = 'completed' AND confirmed_at IS NULL`, k.claim_id)[0];
      if (!c) continue;
      this.exec('UPDATE claims SET confirmed_at = ? WHERE id = ?', now, k.claim_id);
      this.event('confirmed', 'sync', { sha: k.sha }, c.ticket_id, k.claim_id);
      n++;
    }
    return n;
  }

  /** R-BTN-35 (GitHub wins), on each accepted snapshot after cutover: an active claim whose item
   *  git now shows done, archived, superseded, deferred, re-tiered above the holder's ceiling or
   *  gone ends `released:stale-board`, and the holder is told. Before cutover git decides alone
   *  and the shadow reports end claims. */
  staleBoard(repo: string) {
    if (!this.rows('SELECT 1 FROM repositories WHERE id = ? AND cutover_at IS NOT NULL', repo).length) return 0;
    const active = this.rows<{ id: number; ticket_id: string; worker_id: number; tier_ceiling: string; kind: string }>(
      `SELECT c.id, c.ticket_id, c.worker_id, w.tier_ceiling, w.kind FROM claims c JOIN workers w ON w.id = c.worker_id
       WHERE c.status = 'active' AND substr(c.ticket_id, 1, length(?) + 1) = ? || ':'`, repo, repo);
    let n = 0;
    for (const c of active) {
      const it = this.rows<{ status: string; tier: string | null }>('SELECT status, tier FROM tickets WHERE id = ?', c.ticket_id)[0];
      const why = !it ? 'gone or archived' : GIT_ENDS.has(it.status) ? it.status
        : !fitsTier(it.tier ?? null, c.tier_ceiling) ? `re-tiered ${it.tier ?? 'untiered'}` : null;
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
              return { ...a, transcript_url: t ? `https://github.com/${t.repo}/blob/HEAD/${t.path}` : null };
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
      held_items: this.rows<{ ticket_id: string; hold_reason: string | null; set_at: number }>(
        `SELECT ticket_id, hold_reason, set_at FROM ticket_overrides WHERE hold = 1 ORDER BY ticket_id`).map((h) => ({
        ...h,
        attempts: this.rows(`SELECT id, end_reason, ended_at, resume_json FROM claims WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`,
          JSON.stringify(this.failedAttempts(h.ticket_id))),
      })),
    };
  }
}

