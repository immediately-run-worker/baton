// claims.ts — the fenced lease (BATON_SPEC §6.1–6.7, §7.2 rules 1–9, §11 claim, end, holder and
// reap rows; R3-1212): claiming by the matching rules, ending in §6.5's vocabulary, the alarm's
// reaps, the fence before re-issue (R-BTN-19), confirmation by ancestry, and git winning over a
// stale claim (R-BTN-35). The lock is the two partial unique indexes: a claim inserts and lets
// SQLite refuse a second holder, never check-then-insert without them (R-BTN-4).
import { BatonError } from './http';
import { familyOf, isEligible, RULE_CODES, suspended } from './shared/baton.mjs';
import { checkAccept, checkClaim, checkConfirm, checkEnd } from './validate';

type Row = Record<string, SqlStorageValue>;
const EXPEDITE_BOUND = 2; // §7.2 rule 2
const RELEASE_ACK_MS = 2 * 3_600_000; // §9: a delivered release unacknowledged for 2 h reaps the claim
export const UNCONFIRMED_FLAG_MS = 6 * 3_600_000; // §6.7
const STALLED_MS = 2 * 3_600_000; // §14 Running: alive but no activity for 2 h
const TIER_RANK: Record<string, number> = { routine: 0, judgement: 1, critical: 2 };
/** R-BTN-35: the git states that end an active claim `released:stale-board`. */
const GIT_ENDS = new Set(['done', 'superseded', 'deferred', 'deprioritized']);

export interface Ctx {
  storage: DurableObjectStorage;
  now: () => number;
}

interface WorkerFacts {
  id: number;
  kind: string;
  incarnation: number;
  model_id: string | null;
  model_provider_id: string | null;
  tier_ceiling: string;
  skills_version: number;
  lease_timeout_ms: number;
  last_seen_at: number;
  last_activity_at: number | null;
  declared: string[];
  billing: Record<string, string>;
}

interface ItemFacts {
  id: string;
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

const randomNonce = () => [...crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(16).padStart(2, '0')).join('');

export class Claims {
  constructor(private readonly c: Ctx) {}

  private rows<T = Row>(q: string, ...p: unknown[]): T[] {
    return this.c.storage.sql.exec(q, ...(p as SqlStorageValue[])).toArray() as T[];
  }
  private exec(q: string, ...p: unknown[]) {
    return this.c.storage.sql.exec(q, ...(p as SqlStorageValue[]));
  }
  private event(kind: string, actor: string, detail: unknown, workItemId: string | null = null, claimId: number | null = null) {
    this.exec('INSERT INTO events (at, kind, work_item_id, claim_id, actor, detail_json) VALUES (?, ?, ?, ?, ?, ?)',
      this.c.now(), kind, workItemId, claimId, actor, JSON.stringify(detail));
  }
  private setting(key: string): string | null {
    return this.rows<{ value: string }>('SELECT value FROM baton_settings WHERE key = ?', key)[0]?.value ?? null;
  }
  private cutOver() {
    return this.setting('cutover_at') != null;
  }
  private head() {
    return this.rows<{ sha: string }>('SELECT sha FROM board_head WHERE id = 1')[0]?.sha ?? null;
  }

  // ── what matching reads ─────────────────────────────────────────────────────────────────

  private worker(id: number): WorkerFacts {
    const w = this.rows<Omit<WorkerFacts, 'declared' | 'billing'>>(
      `SELECT id, kind, incarnation, model_id, model_provider_id, tier_ceiling, skills_version, lease_timeout_ms, last_seen_at, last_activity_at
       FROM workers WHERE id = ?`, id)[0];
    if (!w) throw new BatonError('unauthenticated', 'no such worker');
    const declared = this.rows<{ declared: string }>('SELECT DISTINCT declared FROM worker_capabilities WHERE worker_id = ? ORDER BY declared', id).map((r) => r.declared);
    const billing = Object.fromEntries(this.rows<{ prefix: string; provider_id: string }>('SELECT prefix, provider_id FROM worker_providers WHERE worker_id = ?', id).map((r) => [r.prefix, r.provider_id]));
    return { ...w, declared, billing };
  }

  private item(id: string): ItemFacts | null {
    const r = this.rows<{ id: string; path: string; node: string; queue: string; status: string; tier: string | null; tags: string; requires_clause: string; operator_only: number; rank: number | null }>(
      'SELECT id, path, node, queue, status, tier, tags, requires_clause, operator_only, rank FROM work_items WHERE id = ?', id)[0];
    if (!r) return null;
    const requires = r.requires_clause === 'listed'
      ? this.rows<{ name: string }>('SELECT name FROM work_item_requires WHERE work_item_id = ? ORDER BY name', id).map((x) => x.name)
      : null;
    const tags: string[] = JSON.parse(r.tags);
    // Rule 6 reads `operator_only` (§7.2): the sync stores no role name, human-operator included.
    if (r.operator_only && !tags.includes('OP')) tags.push('OP');
    const override = this.override(id);
    return { id: r.id, path: r.path, node: r.node, queue: r.queue, status: r.status, tier: r.tier, tags, requires,
      expedite: r.queue === 'expedite' || !!override?.expedite, rank: r.rank };
  }

  private override(id: string) {
    return this.rows<{ expedite: number; hold: number; retry_after: number | null }>('SELECT expedite, hold, retry_after FROM item_overrides WHERE work_item_id = ?', id)[0] ?? null;
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
  private contextFor(item: ItemFacts, now: number, shared: { suspensions: Row[]; minSkills: number; expediteActive: number; reviewer: ReturnType<Claims['reviewerData']> }) {
    const claims = this.rows('SELECT status, confirmed_at, fence_pending FROM work_item_claims WHERE work_item_id = ?', item.id);
    const last = this.rows<{ end_reason: string | null }>(
      `SELECT end_reason FROM work_item_claims WHERE work_item_id = ? AND status != 'active' ORDER BY ended_at DESC, id DESC LIMIT 1`, item.id)[0];
    const lastEndReason = last?.end_reason ?? null;
    let authorFamilies: (string | null)[] = [];
    if (lastEndReason === 'released:awaiting-review-capacity' && shared.reviewer.matrix) {
      // R-BTN-27: every family that wrote code on the item, the original author first — the
      // families of the coding models of the item's earlier claims.
      authorFamilies = this.rows<{ model_id: string | null }>(
        `SELECT w.model_id FROM work_item_claims c JOIN workers w ON w.id = c.worker_id WHERE c.work_item_id = ? ORDER BY c.id`, item.id)
        .map((r) => (r.model_id ? familyOf(r.model_id, shared.reviewer.matrix) : null));
    }
    return {
      now,
      claims,
      override: this.override(item.id),
      suspensions: shared.suspensions,
      minSkillsVersion: shared.minSkills,
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
      minSkills: Number(this.setting('min_skills_version') ?? 0),
      // Rule 2 counts active Baton claims on expedited items, not git in-progress.
      expediteActive: this.rows<{ n: number }>(
        `SELECT count(*) AS n FROM work_item_claims c LEFT JOIN work_items w ON w.id = c.work_item_id
         LEFT JOIN item_overrides o ON o.work_item_id = c.work_item_id
         WHERE c.status = 'active' AND (w.queue = 'expedite' OR o.expedite = 1)`)[0].n,
      reviewer: this.reviewerData(),
      now,
    };
  }

  /** The §7.2 candidate query: rules 1, 3, 4, 5 (as a tier rank), 6 and 10, in rank order. */
  candidates(w: WorkerFacts, now: number, limit = 20): string[] {
    return this.rows<{ id: string }>(
      `SELECT w.id FROM work_items w
       WHERE w.node LIKE 'ready-%'
         AND NOT EXISTS (SELECT 1 FROM work_item_claims c WHERE c.work_item_id = w.id
                         AND (c.status = 'active'
                              OR (c.status = 'completed' AND c.confirmed_at IS NULL)
                              OR (c.status = 'reaped' AND c.fence_pending = 1)))
         AND NOT EXISTS (SELECT 1 FROM item_overrides o WHERE o.work_item_id = w.id
                         AND (o.hold = 1 OR o.retry_after > ?))
         AND NOT EXISTS (SELECT 1 FROM work_item_requires r WHERE r.work_item_id = w.id
                         AND r.name NOT IN (SELECT capability FROM worker_capabilities WHERE worker_id = ?))
         AND ? >= CASE COALESCE(w.tier, 'critical') WHEN 'routine' THEN 0 WHEN 'judgement' THEN 1 ELSE 2 END
         AND (? OR w.operator_only = 0)
       ORDER BY COALESCE((SELECT expedite FROM item_overrides o WHERE o.work_item_id = w.id), 0) DESC, w.rank
       LIMIT ?`,
      now, w.id, TIER_RANK[w.tier_ceiling] ?? 2, w.declared.includes('human-operator') ? 1 : 0, limit).map((r) => r.id);
  }

  /** The worker-level rules, checked once before any query (§7.2): 7 and 9, with the same
   *  functions `isEligible` applies to each item. */
  private workerRules(w: WorkerFacts, now: number, shared: ReturnType<Claims['shared']>) {
    if (suspended(shared.suspensions, w.model_provider_id, w.model_id, now)) {
      throw new BatonError('provider-suspended', 'the coding model’s account is suspended or unresolved (§7.4)', { rule: 7 });
    }
    if ((w.skills_version ?? 0) < shared.minSkills) {
      throw new BatonError('stale-skills', 'this worker’s skills are below min_skills_version (R-BTN-22)', { rule: 9 });
    }
  }

  /** The item a claim by `w` would get now: the named one if eligible, else the first
   *  eligible candidate. Throws the §11 refusal. */
  private decide(w: WorkerFacts, wanted: string | null, now: number): { item: ItemFacts; reason: string } {
    const shared = this.shared(now);
    this.workerRules(w, now, shared);
    if (wanted) {
      const item = this.item(wanted);
      if (!item || !item.node.startsWith('ready-')) throw new BatonError('not-eligible', `${wanted} is not in the claim order`, { rule: 1, rule_code: 'not-ready' });
      const v = isEligible(w, item, this.contextFor(item, now, shared));
      if (!v.ok) throw new BatonError(v.code === 'backing-off' ? 'backing-off' : 'not-eligible', `${wanted}: ${v.code}`, { rule: v.rule, rule_code: v.code });
      return { item, reason: 'requested' };
    }
    for (const id of this.candidates(w, now)) {
      const item = this.item(id)!;
      if (isEligible(w, item, this.contextFor(item, now, shared)).ok) {
        return { item, reason: item.expedite ? 'expedite lane' : `${item.queue} queue · rank ${item.rank ?? '—'}` };
      }
    }
    throw new BatonError('no-eligible-item', 'no ready item fits this worker');
  }

  // ── the worker calls (§11) ──────────────────────────────────────────────────────────────

  /** `GET /v1/worker/next`: what a claim would return, without claiming (for next-available.sh). */
  next(workerId: number) {
    const { item, reason } = this.decide(this.worker(workerId), null, this.c.now());
    return { work_item_id: item.id, rank_reason: reason };
  }

  /** `POST /v1/worker/claim` (§6.2): idempotent by `request_id`; the lock is the index. */
  claim(workerId: number, body: unknown) {
    const b = checkClaim(body);
    if (!this.cutOver()) throw new BatonError('not-cut-over', 'claims go through git until cutover (R-BTN-28)');
    const prior = this.rows<{ id: number; worker_id: number }>('SELECT id, worker_id FROM work_item_claims WHERE request_id = ?', b.request_id)[0];
    if (prior) {
      // A lost response retried: the same claim, never a second item (G-BTN-2).
      if (prior.worker_id !== workerId) throw new BatonError('invalid-params', 'request_id: already used by another worker');
      return this.claimResponse(prior.id);
    }
    const now = this.c.now();
    const w = this.worker(workerId);
    const mine = this.rows<{ work_item_id: string }>(`SELECT work_item_id FROM work_item_claims WHERE worker_id = ? AND status = 'active'`, workerId)[0];
    if (mine) throw new BatonError('not-eligible', `this worker holds ${mine.work_item_id}; end it before claiming another (R-BTN-4)`, { rule: 'one-claim-per-worker' });
    const { item } = this.decide(w, b.work_item_id, now);
    try {
      this.exec(`INSERT INTO work_item_claims (work_item_id, worker_id, request_id, nonce, snapshot_sha, claimed_at, status)
                 VALUES (?, ?, ?, ?, ?, ?, 'active')`, item.id, workerId, b.request_id, randomNonce(), this.head() ?? '', now);
    } catch (e) {
      // R-BTN-4: the partial unique indexes refuse a second holder of the item or the worker.
      if (/UNIQUE constraint failed/.test(String(e))) throw new BatonError('not-eligible', `${item.id} is already held`, { rule: 3, rule_code: RULE_CODES[3] });
      throw e;
    }
    const id = this.rows<{ id: number }>('SELECT last_insert_rowid() AS id')[0].id;
    this.event('claimed', `worker:${workerId}`, { request_id: b.request_id }, item.id, id);
    // §6.8: transcripts reported while the worker held nothing are linked to this claim.
    this.exec(`INSERT INTO transcripts (worker_id, claim_id, repo, path, role, activity_id, first_seen_at, last_pushed_at)
               SELECT worker_id, ?, repo, path, role, activity_id, first_seen_at, last_pushed_at FROM pending_transcripts WHERE worker_id = ?
               ON CONFLICT (worker_id, repo, path, claim_id) DO NOTHING`, id, workerId);
    this.exec('DELETE FROM pending_transcripts WHERE worker_id = ?', workerId);
    return this.claimResponse(id);
  }

  /** The claim response (§11, R-BTN-34): the item's path and the snapshot it was decided on —
   *  never the item's content — and the earlier attempts, newest first (§6.11; their resume
   *  records are R3-1217's). */
  private claimResponse(id: number) {
    const c = this.rows<{ id: number; work_item_id: string; nonce: string; snapshot_sha: string }>('SELECT id, work_item_id, nonce, snapshot_sha FROM work_item_claims WHERE id = ?', id)[0];
    const path = this.rows<{ path: string }>('SELECT path FROM work_items WHERE id = ?', c.work_item_id)[0]?.path ?? `content/roadmap/${c.work_item_id}.mdx`;
    const previous = this.rows<{ id: number; status: string; end_reason: string | null; ended_at: number | null; resume_json: string | null }>(
      `SELECT id, status, end_reason, ended_at, resume_json FROM work_item_claims WHERE work_item_id = ? AND id < ? AND status != 'active' ORDER BY id DESC`, c.work_item_id, id);
    return {
      claim_id: c.id, work_item_id: c.work_item_id, path, nonce: c.nonce, snapshot_sha: c.snapshot_sha,
      previous_attempts: previous.map((p) => ({ claim_id: p.id, status: p.status, end_reason: p.end_reason, ended_at: p.ended_at, resume: p.resume_json ? JSON.parse(p.resume_json) : null })),
    };
  }

  /** `POST /v1/worker/claims/{id}/end` (§6.5, R-BTN-8). A retried identical end is a no-op. */
  end(workerId: number, claimId: number, body: unknown) {
    const e = checkEnd(body);
    if (!this.cutOver()) throw new BatonError('not-cut-over', 'claims end through git until cutover (R-BTN-28)');
    const c = this.rows<{ id: number; worker_id: number; work_item_id: string; status: string; end_reason: string | null }>(
      'SELECT id, worker_id, work_item_id, status, end_reason FROM work_item_claims WHERE id = ?', claimId)[0];
    if (!c || c.worker_id !== workerId) throw new BatonError('not-holder', 'this worker does not hold that claim');
    if (c.status !== 'active') {
      if (c.end_reason === e.end_reason) return { ok: true };
      throw new BatonError('claim-ended', `the claim already ended (${c.status}: ${c.end_reason})`);
    }
    this.finish(c.id, c.work_item_id, e.status, e.end_reason, `worker:${workerId}`, { ended_at_sha: e.ended_at_sha });
    return { ok: true };
  }

  /** Ends an active claim: its open activities close `abandoned` (§6.9) and the end is logged. */
  private finish(claimId: number, item: string, status: 'completed' | 'released' | 'reaped', reason: string, actor: string,
    opts: { ended_at_sha?: string | null; fence?: { incarnation: number } | null } = {}) {
    const now = this.c.now();
    this.exec(`UPDATE work_item_claims SET status = ?, ended_at = ?, end_reason = ?, ended_at_sha = ?, fence_pending = ?, fence_incarnation = ? WHERE id = ?`,
      status, now, reason, opts.ended_at_sha ?? null, opts.fence ? 1 : 0, opts.fence?.incarnation ?? null, claimId);
    this.exec(`UPDATE activities SET ended_at = ?, outcome = 'abandoned' WHERE claim_id = ? AND ended_at IS NULL`, now, claimId);
    this.event(status, actor, { end_reason: reason, ...(opts.ended_at_sha ? { ended_at_sha: opts.ended_at_sha } : {}), ...(opts.fence ? { fence_pending: true } : {}) }, item, claimId);
  }

  /** `GET /v1/worker/items/{item}/holder` (R-BTN-7): whether another live, non-legacy worker
   *  holds the item, and whether a reaped claim on it is still fence-pending. `callerId` is
   *  null for a token-only caller (the witness), for whom every holder is another. */
  holder(callerId: number | null, item: string) {
    const held = this.rows(`SELECT 1 FROM work_item_claims c JOIN workers w ON w.id = c.worker_id
                            WHERE c.work_item_id = ? AND c.status = 'active' AND w.kind != 'legacy' AND (? IS NULL OR c.worker_id != ?)`, item, callerId, callerId).length > 0;
    const fence = this.rows(`SELECT 1 FROM work_item_claims WHERE work_item_id = ? AND status = 'reaped' AND fence_pending = 1`, item).length > 0;
    return { held_by_other: held, fence_pending: fence };
  }

  /** The heartbeat's `fenced` report (R-BTN-19): clears the fence of a claim reaped while this
   *  worker was alive — only in the incarnation it was reaped in, since a re-key never clears one. */
  fenced(workerId: number, incarnation: number, claimId: number) {
    const c = this.rows<{ work_item_id: string }>(
      `SELECT work_item_id FROM work_item_claims WHERE id = ? AND worker_id = ? AND status = 'reaped' AND fence_pending = 1 AND fence_incarnation = ?`,
      claimId, workerId, incarnation)[0];
    if (!c) return false;
    this.exec('UPDATE work_item_claims SET fence_pending = 0 WHERE id = ?', claimId);
    this.event('fence-cleared', `worker:${workerId}`, { by: 'sidecar' }, c.work_item_id, claimId);
    return true;
  }

  // ── the owner's actions (§14) ───────────────────────────────────────────────────────────

  /** `POST /v1/ui/claims/{id}/reap`: any active claim. A live worker's claim is fence-pending
   *  (R-BTN-19) and the worker is not reaped, so its sidecar can still report the fence; a
   *  silent worker's is reaped as the alarm would. */
  forceReap(owner: string, claimId: number, body: unknown) {
    checkConfirm(body);
    const c = this.rows<{ id: number; work_item_id: string; worker_id: number; status: string }>('SELECT id, work_item_id, worker_id, status FROM work_item_claims WHERE id = ?', claimId)[0];
    if (!c) throw new BatonError('not-found', 'no such claim');
    if (c.status !== 'active') throw new BatonError('claim-ended', 'the claim already ended');
    const w = this.worker(c.worker_id);
    const now = this.c.now();
    const alive = w.kind !== 'legacy' && now - w.last_seen_at < w.lease_timeout_ms;
    this.finish(c.id, c.work_item_id, 'reaped', 'reaped:owner', `owner:${owner}`, { fence: alive ? { incarnation: w.incarnation } : null });
    if (!alive) this.exec('UPDATE workers SET reaped_at = ? WHERE id = ? AND reaped_at IS NULL', now, w.id);
    return { ok: true, fence_pending: alive };
  }

  /** `POST /v1/ui/board/accept`: the owner accepts a held history; the sync's next force post
   *  of it then becomes the head (§7.1). */
  acceptHeld(owner: string, body: unknown) {
    const { sha } = checkAccept(body);
    const held = this.rows<{ accepted_at: number | null }>('SELECT accepted_at FROM held_snapshots WHERE sha = ?', sha)[0];
    if (!held) throw new BatonError('not-found', 'no such held history');
    if (held.accepted_at == null) {
      this.exec('UPDATE held_snapshots SET accepted_at = ? WHERE sha = ?', this.c.now(), sha);
      this.event('snapshot-accepted', `owner:${owner}`, { sha, held: true, by: 'owner' });
    }
    return { ok: true };
  }

  // ── the sync's share (§6.7, R-BTN-35) ───────────────────────────────────────────────────

  /** §6.7: the sync confirms a completion once git carries it (it checked the ancestry and the
   *  status); anything but an unconfirmed completion is ignored. */
  confirm(confirmations: { claim_id: number; sha: string }[]) {
    const now = this.c.now();
    let n = 0;
    for (const k of confirmations) {
      const c = this.rows<{ work_item_id: string }>(`SELECT work_item_id FROM work_item_claims WHERE id = ? AND status = 'completed' AND confirmed_at IS NULL`, k.claim_id)[0];
      if (!c) continue;
      this.exec('UPDATE work_item_claims SET confirmed_at = ? WHERE id = ?', now, k.claim_id);
      this.event('confirmed', 'sync', { sha: k.sha }, c.work_item_id, k.claim_id);
      n++;
    }
    return n;
  }

  /** R-BTN-35 (GitHub wins), on each accepted snapshot after cutover: an active claim whose item
   *  git now shows done, archived, superseded, deferred, re-tiered above the holder's ceiling or
   *  gone ends `released:stale-board`, and the holder is told. Before cutover git decides alone
   *  and the shadow reports end claims. */
  staleBoard() {
    if (!this.cutOver()) return 0;
    const active = this.rows<{ id: number; work_item_id: string; worker_id: number; tier_ceiling: string; kind: string }>(
      `SELECT c.id, c.work_item_id, c.worker_id, w.tier_ceiling, w.kind FROM work_item_claims c JOIN workers w ON w.id = c.worker_id WHERE c.status = 'active'`);
    let n = 0;
    for (const c of active) {
      const it = this.rows<{ status: string; tier: string | null }>('SELECT status, tier FROM work_items WHERE id = ?', c.work_item_id)[0];
      const why = !it ? 'gone or archived' : GIT_ENDS.has(it.status) ? it.status
        : (TIER_RANK[it.tier ?? 'critical'] ?? 2) > (TIER_RANK[c.tier_ceiling] ?? 2) ? `re-tiered ${it.tier ?? 'untiered'}` : null;
      if (!why) continue;
      this.finish(c.id, c.work_item_id, 'released', 'released:stale-board', 'sync', {});
      if (c.kind !== 'legacy') {
        this.exec(`INSERT INTO messages (kind, payload_json, from_principal, to_worker_id, sent_at, status) VALUES ('release', ?, 'sync', ?, ?, 'pending')`,
          JSON.stringify({ work_item_id: c.work_item_id, reason: 'stale-board', why }), c.worker_id, this.c.now());
      }
      n++;
    }
    return n;
  }

  // ── the alarm's share (§6.6, §7.1, §9) ──────────────────────────────────────────────────

  alarm() {
    const now = this.c.now();
    // Silent workers: reaped at exactly their clamped timeout (R-BTN-9), never by Date.now().
    const silent = this.rows<{ id: number; work_item_id: string; worker_id: number }>(
      `SELECT c.id, c.work_item_id, c.worker_id FROM work_item_claims c JOIN workers w ON w.id = c.worker_id
       WHERE c.status = 'active' AND ((w.kind != 'legacy' AND ? - w.last_seen_at >= w.lease_timeout_ms)
                                      OR (w.kind = 'legacy' AND c.reap_after IS NOT NULL AND c.reap_after <= ?))`, now, now);
    for (const c of silent) {
      this.finish(c.id, c.work_item_id, 'reaped', 'reaped:silent', 'alarm', {});
      this.exec('UPDATE workers SET reaped_at = ? WHERE id = ? AND reaped_at IS NULL', now, c.worker_id);
    }
    // §9: a release delivered 2 h ago and still unacknowledged reaps the claim, fenced: the
    // worker is alive (it took the message), so the item waits for its fence (R-BTN-19).
    const stale = this.rows<{ mid: number; id: number; work_item_id: string; worker_id: number; incarnation: number }>(
      `SELECT m.id AS mid, c.id, c.work_item_id, c.worker_id, w.incarnation FROM messages m
       JOIN work_item_claims c ON c.worker_id = m.to_worker_id AND c.status = 'active' AND c.work_item_id = json_extract(m.payload_json, '$.work_item_id')
       JOIN workers w ON w.id = c.worker_id
       WHERE m.kind = 'release' AND m.status = 'delivered' AND m.delivered_at <= ?`, now - RELEASE_ACK_MS);
    for (const c of stale) {
      this.finish(c.id, c.work_item_id, 'reaped', 'reaped:release-unacknowledged', 'alarm', { fence: { incarnation: c.incarnation } });
      this.exec(`UPDATE messages SET status = 'expired' WHERE id = ?`, c.mid);
    }
    // A fence also clears when its worker goes silent past its own timeout (R-BTN-19).
    const lapsed = this.rows<{ id: number; work_item_id: string; worker_id: number }>(
      `SELECT c.id, c.work_item_id, c.worker_id FROM work_item_claims c JOIN workers w ON w.id = c.worker_id
       WHERE c.status = 'reaped' AND c.fence_pending = 1 AND ? - w.last_seen_at >= w.lease_timeout_ms`, now);
    for (const c of lapsed) {
      this.exec('UPDATE work_item_claims SET fence_pending = 0 WHERE id = ?', c.id);
      this.exec('UPDATE workers SET reaped_at = ? WHERE id = ? AND reaped_at IS NULL', now, c.worker_id);
      this.event('fence-cleared', 'alarm', { by: 'timeout' }, c.work_item_id, c.id);
    }
    // §7.1: a held history is accepted automatically 24 h after its first post.
    for (const h of this.rows<{ sha: string }>('SELECT sha FROM held_snapshots WHERE accepted_at IS NULL AND auto_accept_at <= ?', now)) {
      this.exec('UPDATE held_snapshots SET accepted_at = ? WHERE sha = ?', now, h.sha);
      this.event('snapshot-accepted', 'alarm', { sha: h.sha, held: true, by: 'auto-accept' });
    }
  }

  // ── the dashboard (§14: Running, Timeline, Needs you) ───────────────────────────────────

  running(now: number) {
    return this.rows<Row>(
      `SELECT c.id, c.work_item_id, c.worker_id, c.claimed_at, c.nonce, w.hostname, w.session_name, w.last_seen_at, w.last_activity_at,
              w.lease_timeout_ms, w.kind, wi.title
       FROM work_item_claims c JOIN workers w ON w.id = c.worker_id LEFT JOIN work_items wi ON wi.id = c.work_item_id
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
        claims: this.rows<Row>(`SELECT id, work_item_id, claimed_at, ended_at, status, end_reason FROM work_item_claims
                                WHERE worker_id = ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY claimed_at`, l.id, from).map((c) => ({
          ...c,
          activities: this.rows('SELECT id, kind, label, started_at, ended_at, outcome, parent_id FROM activities WHERE claim_id = ? ORDER BY started_at', c.id),
        })),
      })),
    };
  }

  needsYou(now: number) {
    const minSkills = Number(this.setting('min_skills_version') ?? 0);
    return {
      // §6.7: never auto-confirmed; the owner resolves it.
      unconfirmed: this.rows(`SELECT id, work_item_id, worker_id, ended_at, end_reason, ended_at_sha FROM work_item_claims
                              WHERE status = 'completed' AND confirmed_at IS NULL AND ended_at <= ? ORDER BY ended_at`, now - UNCONFIRMED_FLAG_MS),
      unacknowledged_releases: this.rows(`SELECT id, to_worker_id, payload_json, sent_at, delivered_at FROM messages
                                          WHERE kind = 'release' AND status IN ('pending','delivered') ORDER BY sent_at`),
      fence_pending: this.rows(`SELECT id, work_item_id, worker_id, ended_at FROM work_item_claims WHERE status = 'reaped' AND fence_pending = 1 ORDER BY ended_at`),
      stale_skills: this.rows(`SELECT id, hostname, session_name, skills_version FROM workers
                               WHERE reaped_at IS NULL AND kind != 'legacy' AND skills_version < ? AND ? - last_seen_at < lease_timeout_ms`, minSkills, now),
      held_items: this.rows(`SELECT work_item_id, hold_reason, retry_after FROM item_overrides WHERE hold = 1 ORDER BY work_item_id`),
    };
  }
}

