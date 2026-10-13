// baton.ts — the one Durable Object (BATON_SPEC §3): every table, every write. Requests reach
// it only through the Worker (src/worker.ts), which has already verified the principal, so
// nothing here re-reads a credential. Each request runs alone and its writes are one
// transaction, so the compare-and-set below needs no lock.
import { DurableObject } from 'cloudflare:workers';
import { MIGRATIONS } from './migrations';
import { BatonError, errorResponse, json } from './http';
import { checkPayload, inPeak, nextPeakChange, rowFor, rowHash, type BoardPayload } from './board';
import { priceFor } from './shared/sessionUsage.mjs';
import { familyOf } from './shared/baton.mjs';
import { fitsTier, TIERS } from './shared/vocabulary.mjs';
import { WorkerApi } from './workerApi';
import { Claims } from './claims';
import { Cutover } from './cutover';
import { dispatchWorkflow, Mirror, type Workflow } from './mirror';
import { checkConfirmations, ITEM_ID } from './validate';

const HELD_AUTO_ACCEPT_MS = 24 * 3_600_000; // §7.1: a held history is accepted after 24 h (R3-1212)
const ALARM_EVERY_MS = 60_000; // §3: one alarm, every 60 seconds

export class Baton extends DurableObject<Env> {
  /** The clock (R-BTN-32). Tests replace it through `runInDurableObject`; nothing else here
   *  reads the time. */
  now: () => number = () => Date.now();

  readonly workers: WorkerApi;
  readonly claims: Claims;
  readonly cutover: Cutover;
  readonly mirror: Mirror;
  /** §12: workflows to dispatch once the current request or alarm has committed. */
  private pendingDispatch = new Set<Workflow>();
  /** The dispatch call; tests replace it (as they replace `now`) to see what would be sent. */
  dispatcher: (workflow: Workflow) => Promise<unknown> = (wf) => dispatchWorkflow(this.env, wf);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.claims = new Claims({ storage: ctx.storage, now: () => this.now(), dispatch: (wf) => this.pendingDispatch.add(wf) });
    this.cutover = new Cutover({ storage: ctx.storage, now: () => this.now() });
    this.mirror = new Mirror({ storage: ctx.storage, now: () => this.now() });
    this.workers = new WorkerApi({ storage: ctx.storage, env, now: () => this.now(), fenced: (w, inc, id) => this.claims.fenced(w, inc, id) });
    // The object refuses to serve until every migration is applied (§3), and keeps one alarm.
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      if ((await ctx.storage.getAlarm()) == null) await ctx.storage.setAlarm(this.now() + ALARM_EVERY_MS);
    });
  }

  /** §3: the one alarm, every 60 seconds. R3-1211 gives it suspensions and message expiry;
   *  R3-1212 adds reaping. */
  /** Send the dispatches a committed transaction asked for — only after cutover, when the
   *  mirror writes git; before it, claim.sh does. Never awaited by the caller's response. */
  private flushDispatch() {
    const due = [...this.pendingDispatch];
    this.pendingDispatch.clear();
    if (!due.length || !this.cutover.cutoverAt()) return;
    this.ctx.waitUntil(Promise.all(due.map((wf) => this.dispatcher(wf).catch(() => false))));
  }

  async alarm(): Promise<void> {
    // Re-armed first, so one failing tick never ends the cycle.
    await this.ctx.storage.setAlarm(this.now() + ALARM_EVERY_MS);
    // Claims first, so a worker reaped this tick has its messages expired in the same tick.
    try {
      this.ctx.storage.transactionSync(() => {
        this.claims.alarm();
        this.workers.alarm();
      });
    } catch (e) {
      this.pendingDispatch.clear(); // rolled back: nothing to tell the mirror
      throw e;
    }
    this.flushDispatch();
  }

  private sql<T = Record<string, SqlStorageValue>>(query: string, ...params: unknown[]): T[] {
    return this.ctx.storage.sql.exec(query, ...(params as SqlStorageValue[])).toArray() as T[];
  }

  /** Apply the numbered migrations not yet applied, each in its own transaction. */
  migrate(): void {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS _baton_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
    const done = new Set(this.sql<{ id: number }>('SELECT id FROM _baton_migrations').map((r) => r.id));
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(m.sql);
        this.ctx.storage.sql.exec('INSERT INTO _baton_migrations (id, applied_at) VALUES (?, ?)', m.id, this.now());
      });
    }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    this.pendingDispatch.clear();
    try {
      const res = await this.route(req, url);
      // An error answer means its transaction rolled back: nothing changed to mirror.
      if (res.ok) this.flushDispatch();
      else this.pendingDispatch.clear();
      return res;
    } catch (e) {
      this.pendingDispatch.clear(); // the transaction rolled back: nothing changed to mirror
      throw e;
    }
  }

  private async route(req: Request, url: URL): Promise<Response> {
    try {
      if (req.method === 'GET' && url.pathname === '/v1/sync/head') return json(this.head());
      if (req.method === 'GET' && url.pathname === '/v1/sync/events') {
        const after = Number(url.searchParams.get('after') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? 200);
        if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit)) throw new BatonError('invalid-params', 'after and limit must be integers');
        return json(this.mirror.events(after, limit));
      }
      if (req.method === 'POST' && url.pathname === '/v1/sync/foreign-claim') {
        const body = await readJson(req);
        return json(this.ctx.storage.transactionSync(() => this.mirror.foreignClaim(body)));
      }
      if (req.method === 'POST' && url.pathname === '/v1/sync/board') return json(await this.board(checkPayload(await readJson(req))));
      if (req.method === 'GET' && url.pathname === '/v1/ui/state') return json(this.uiState());
      const routed = await this.workerRoute(req, url);
      if (routed) return routed;
      throw new BatonError('not-found', `no route ${req.method} ${url.pathname}`);
    } catch (e) {
      // Drain an unread body so the forwarded stream completes before the response does.
      if (req.body && !req.bodyUsed) await req.arrayBuffer().catch(() => {});
      if (e instanceof BatonError) return errorResponse(e.code, e.message, e.extra);
      throw e;
    }
  }

  /** The worker and owner routes of R3-1211. The Worker has verified the principal and passes
   *  it in `X-Baton-Credential` (a worker token's credential) or `X-Baton-Owner` (the Access
   *  email); it strips both from every incoming request first. */
  private async workerRoute(req: Request, url: URL): Promise<Response | null> {
    const p = url.pathname;
    const m = req.method;
    const owner = req.headers.get('X-Baton-Owner');
    const cred = req.headers.get('X-Baton-Credential');
    const secret = req.headers.get('X-Worker-Secret');
    const tx = <T>(f: () => T): T => this.ctx.storage.transactionSync(f);
    if (p.startsWith('/v1/worker/')) {
      if (!cred) throw new BatonError('unauthenticated', 'no worker principal');
      if (m === 'POST' && p === '/v1/worker/heartbeat') {
        const body = await readJson(req);
        // The hashing is async; the writes happen in one transaction after it (§3: atomic).
        return json(await this.workers.heartbeat(cred, secret, body));
      }
      if (m === 'GET' && p === '/v1/worker/mode') {
        await this.workers.authWorker(cred, secret);
        return json(this.workers.mode());
      }
      const holder = /^\/v1\/worker\/items\/([^/]+)\/holder$/.exec(p);
      if (m === 'GET' && holder) {
        // R-BTN-7: callable with the token alone (the witness has no sidecar); with a secret, the
        // caller's own claim is not "another".
        let item = '';
        try {
          item = decodeURIComponent(holder[1]);
        } catch {
          // a malformed escape is the caller's error, never a 500
        }
        if (!ITEM_ID.test(item)) throw new BatonError('invalid-params', 'item: must be a work item id');
        const caller = secret ? await this.workers.authWorker(cred, secret) : null;
        return json(this.claims.holder(caller, item));
      }
      const workerId = await this.workers.authWorker(cred, secret);
      if (m === 'POST' && p === '/v1/worker/claim') {
        const body = await readJson(req);
        return json(tx(() => this.claims.claim(workerId, body)));
      }
      if (m === 'GET' && p === '/v1/worker/next') return json(this.claims.next(workerId));
      if (m === 'POST' && p === '/v1/worker/adopt') {
        const body = await readJson(req);
        return json(tx(() => this.cutover.adopt(workerId, body)));
      }
      const end = /^\/v1\/worker\/claims\/(\d+)\/end$/.exec(p);
      if (m === 'POST' && end) {
        const body = await readJson(req);
        return json(tx(() => this.claims.end(workerId, Number(end[1]), body)));
      }
      if (m === 'POST' && p === '/v1/worker/activities') {
        const body = await readJson(req);
        return json(this.workers.activities(workerId, body));
      }
      const ack = /^\/v1\/worker\/messages\/(\d+)\/ack$/.exec(p);
      if (m === 'POST' && ack) {
        // An absent body is an acknowledgement with no reply; a malformed one is refused.
        const body = req.headers.get('Content-Length') === '0' || !req.body ? null : await readJson(req);
        return json(tx(() => this.workers.ack(workerId, Number(ack[1]), body)));
      }
      if (m === 'POST' && p === '/v1/worker/shadow-report') {
        const body = await readJson(req);
        return json(tx(() => this.workers.shadowReport(workerId, body)));
      }
      return null;
    }
    if (p.startsWith('/v1/ui/') && m === 'POST') {
      if (!owner) throw new BatonError('unauthenticated', 'no owner principal');
      if (p === '/v1/ui/messages') {
        const body = await readJson(req);
        return json(tx(() => this.workers.sendMessage(owner, body)));
      }
      if (p === '/v1/ui/suspensions') {
        const body = await readJson(req);
        return json(tx(() => this.workers.setSuspension(owner, body)));
      }
      const lift = /^\/v1\/ui\/suspensions\/(\d+)\/lift$/.exec(p);
      if (lift) return json(tx(() => this.workers.liftSuspension(owner, Number(lift[1]))));
      const reap = /^\/v1\/ui\/claims\/(\d+)\/reap$/.exec(p);
      if (reap) {
        const body = await readJson(req);
        return json(tx(() => this.claims.forceReap(owner, Number(reap[1]), body)));
      }
      const resolve = /^\/v1\/ui\/claims\/(\d+)\/resolve$/.exec(p);
      if (resolve) {
        const body = await readJson(req);
        return json(tx(() => this.claims.resolve(owner, Number(resolve[1]), body)));
      }
      if (p === '/v1/ui/cutover') {
        const body = await readJson(req);
        return json(tx(() => this.cutover.cutover(owner, body)));
      }
      const adoption = /^\/v1\/ui\/adoptions\/([^/]+)\/confirm$/.exec(p);
      if (adoption) {
        if (!ITEM_ID.test(adoption[1])) throw new BatonError('invalid-params', 'item: must be a work item id');
        const body = await readJson(req);
        return json(tx(() => this.cutover.confirmAdoption(owner, adoption[1], body)));
      }
      const override = /^\/v1\/ui\/overrides\/([^/]+)$/.exec(p);
      if (override) {
        if (!ITEM_ID.test(override[1])) throw new BatonError('invalid-params', 'item: must be a work item id');
        const body = await readJson(req);
        return json(tx(() => this.claims.setOverride(owner, override[1], body)));
      }
      if (p === '/v1/ui/board/accept') {
        const body = await readJson(req);
        return json(tx(() => this.claims.acceptHeld(owner, body)));
      }
    }
    return null;
  }

  // ── sync (§7.1) ───────────────────────────────────────────────────────────────────────

  /** `GET /v1/sync/head`: the head snapshot and the completions waiting for confirmation. */
  head() {
    const row = this.sql<{ sha: string }>('SELECT sha FROM board_head WHERE id = 1')[0];
    const unconfirmed = this.sql(
      `SELECT id AS claim_id, work_item_id, end_reason, ended_at_sha FROM work_item_claims
       WHERE status = 'completed' AND confirmed_at IS NULL ORDER BY id`);
    return { sha: row?.sha ?? null, unconfirmed };
  }

  /**
   * `POST /v1/sync/board` (R-BTN-11): accepted only when `parent_sha` is the current head (or
   * null while there is none); a lost race is `head-moved`. `force` — a rewritten `main` — is
   * held for the owner as a `snapshot-rejected` event and moves nothing else; accepting it
   * is the alarm's and the dashboard's job (R3-1212). A repeat of the head is a no-op.
   *
   * `held_snapshots` keeps one row per sha, written once PER HOLD (R3-1223): a force post of a
   * sha whose row was accepted, or held against another head, is a new hold that resets the
   * row's head, received_at and 24-hour deadline — the 0001 schema's "written once" and "the
   * first force post" describe a single hold. Rows held against a head are deleted when the
   * head moves, so every row is a hold against the current head.
   */
  async board(p: BoardPayload) {
    const head = this.sql<{ sha: string }>('SELECT sha FROM board_head WHERE id = 1')[0]?.sha ?? null;
    const at = this.now();
    const confirmations = checkConfirmations(p.confirmations);
    // A held history the owner (or the 24-hour clock) accepted becomes the head on its next post.
    const accepted = !!p.force && this.claims.acceptedLine(head);
    if (p.force && !accepted) {
      // A held post still carries the sync's confirmations: git carries those completions
      // whichever history the owner keeps, and dropping them would leave their items blocked.
      this.ctx.storage.transactionSync(() => this.claims.confirm(confirmations));
      // Held once per sha and head: a repeat (the sync re-posts every 15 minutes) changes
      // nothing, so the first deadline stands and the dashboard lists it once. A row that was
      // accepted, or held against another head, is a NEW hold (R3-1223): a rewind to a sha the
      // owner once accepted is held with a fresh row — held list, 24-hour clock, the owner's
      // Accept — never a silent 409. `held_snapshots` keeps one row per sha; the hold reuses it.
      const known = this.sql<{ auto_accept_at: number; accepted_at: number | null; head_sha: string | null }>(
        'SELECT auto_accept_at, accepted_at, head_sha FROM held_snapshots WHERE sha = ?', p.sha)[0];
      const held = !!known && known.accepted_at == null && known.head_sha === head;
      const deadline = held ? known.auto_accept_at : at + HELD_AUTO_ACCEPT_MS;
      if (!held) {
        this.ctx.storage.transactionSync(() => {
          if (known) {
            this.ctx.storage.sql.exec(`UPDATE held_snapshots SET parent_sha = ?, head_sha = ?, item_count = ?, received_at = ?, auto_accept_at = ?, accepted_at = NULL
                                       WHERE sha = ?`, p.parent_sha, head, p.state.items.length, at, deadline, p.sha);
          } else {
            this.ctx.storage.sql.exec('INSERT INTO held_snapshots (sha, parent_sha, head_sha, item_count, received_at, auto_accept_at) VALUES (?, ?, ?, ?, ?, ?)',
              p.sha, p.parent_sha, head, p.state.items.length, at, deadline);
          }
          this.event('snapshot-rejected', { sha: p.sha, parent_sha: p.parent_sha, head, item_count: p.state.items.length, auto_accept_at: deadline, ...(known ? { again: true } : {}) }, at);
        });
      }
      throw new BatonError('snapshot-rejected', `a rewritten history is held for the owner until ${new Date(deadline).toISOString()}; claims continue on the current head`);
    }
    if (p.sha === head) {
      // §6.7: the sync's confirm-only post re-sends the head with its confirmations.
      const confirmed = this.ctx.storage.transactionSync(() => this.claims.confirm(confirmations));
      return { ok: true, unchanged: true, confirmed };
    }
    if (!accepted && p.parent_sha !== head) throw new BatonError('head-moved', `the head is ${head ?? 'unset'}; re-read it and retry`);

    // Hash every row before the transaction: the digest is async, the transaction is not.
    const rankOf = new Map(p.ready.map((id, i) => [id, i]));
    const rows = await Promise.all(p.state.items.map(async (it) => {
      const row = rowFor(it, rankOf);
      return { row, hash: await rowHash(row) };
    }));
    const changed = { upserted: 0, deleted: 0 };
    this.ctx.storage.transactionSync(() => {
      const have = new Map(this.sql<{ id: string; row_hash: string }>('SELECT id, row_hash FROM work_items').map((r) => [r.id, r.row_hash]));
      for (const { row, hash } of rows) {
        const before = have.get(row.id);
        have.delete(row.id);
        if (before === hash) continue;
        this.ctx.storage.sql.exec(
          `INSERT INTO work_items (id, path, title, project, status, node, queue, tags, tier, requires_clause, operator_only,
             depends_on, blocked_by, repos, ord, rank, snapshot_sha, row_hash, since, holder)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET path = excluded.path, title = excluded.title, project = excluded.project,
             status = excluded.status, node = excluded.node, queue = excluded.queue, tags = excluded.tags,
             tier = excluded.tier, requires_clause = excluded.requires_clause, operator_only = excluded.operator_only,
             depends_on = excluded.depends_on, blocked_by = excluded.blocked_by, repos = excluded.repos,
             ord = excluded.ord, rank = excluded.rank, snapshot_sha = excluded.snapshot_sha, row_hash = excluded.row_hash,
             since = excluded.since, holder = excluded.holder`,
          row.id, row.path, row.title, row.project, row.status, row.node, row.queue, row.tags, row.tier,
          row.requires_clause, row.operator_only, row.depends_on, row.blocked_by, row.repos, row.ord, row.rank, p.sha, hash, row.since, row.holder);
        this.ctx.storage.sql.exec('DELETE FROM work_item_requires WHERE work_item_id = ?', row.id);
        for (const name of row.requires) this.ctx.storage.sql.exec('INSERT INTO work_item_requires (work_item_id, name) VALUES (?, ?)', row.id, name);
        changed.upserted++;
      }
      // Items no longer live leave the cache (R-BTN-35); their claims and events stay.
      for (const gone of have.keys()) {
        this.ctx.storage.sql.exec('DELETE FROM work_item_requires WHERE work_item_id = ?', gone);
        this.ctx.storage.sql.exec('DELETE FROM work_items WHERE id = ?', gone);
        changed.deleted++;
      }
      this.reference(p);
      this.ctx.storage.sql.exec('INSERT INTO board_snapshots (sha, parent_sha, received_at, item_count) VALUES (?, ?, ?, ?) ON CONFLICT (sha) DO NOTHING', p.sha, p.parent_sha, at, p.state.items.length);
      this.ctx.storage.sql.exec('INSERT INTO board_head (id, sha) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET sha = excluded.sha', p.sha);
      // A hold is against one head (R3-1223): when the head moves — an accepted rewrite or a
      // plain fast-forward — every row held against the head it leaves is retired, answered or
      // not. Left in place, an accepted row would accept a NEW rewrite silently whenever the
      // head came back to that sha; an unanswered one is moot (main moved on), and a re-post of
      // its sha is held afresh. So every row left is a hold against the current head. Their
      // history stays in the events.
      this.ctx.storage.sql.exec('DELETE FROM held_snapshots WHERE head_sha IS ?', head);
      this.event('snapshot-accepted', { sha: p.sha, parent_sha: p.parent_sha, item_count: p.state.items.length, ...changed, ...(accepted ? { held: true } : {}) }, at);
      (changed as Record<string, number>).confirmed = this.claims.confirm(confirmations);
      // R-BTN-35: git wins over a claim it has overtaken.
      (changed as Record<string, number>).stale_released = this.claims.staleBoard();
    });
    return { ok: true, ...changed };
  }

  /** The reference data the sync posts with every snapshot (§7.3, §7.4): providers, peak
   *  schedules, per-model prices and limits, the reviewer catalog, `min_skills_version`. Each
   *  table is a copy of a docs file, never edited here, so it is rewritten whole: an account
   *  the file no longer lists is deleted. (Nothing references `model_providers` yet; when
   *  workers and suspensions do, R3-1211 decides what retiring a referenced account means.) */
  private reference(p: BoardPayload) {
    const exec = (q: string, ...a: unknown[]) => this.ctx.storage.sql.exec(q, ...(a as SqlStorageValue[]));
    if (p.providers) {
      exec('DELETE FROM provider_models');
      const ids = p.providers.accounts.map((a) => a.id);
      exec(`DELETE FROM model_providers WHERE id NOT IN (${ids.map(() => '?').join(', ') || "''"})`, ...ids);
      for (const a of p.providers.accounts) {
        exec(`INSERT INTO model_providers (id, name, billing, window_limits_json) VALUES (?, ?, ?, ?)
              ON CONFLICT (id) DO UPDATE SET name = excluded.name, billing = excluded.billing, window_limits_json = excluded.window_limits_json`,
          a.id, a.name, a.billing, a.window_limits ? JSON.stringify(a.window_limits) : null);
      }
      exec('DELETE FROM peak_schedules');
      for (const s of p.providers.peak_schedules) exec('INSERT INTO peak_schedules (id, rules_json, factor) VALUES (?, ?, ?)', s.id, JSON.stringify(s.rules), s.factor);
      for (const m of p.providers.models) {
        const price = priceFor(m.model, p.prices);
        exec(`INSERT INTO provider_models (provider_id, model_id, input_per_m, output_per_m, cache_read_per_m, cache_write_per_m, monthly_limit_usd, peak_schedule_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          m.provider, m.model, price?.input ?? null, price?.output ?? null, price?.cacheRead ?? null, price?.cacheWrite5m ?? null, m.monthly_limit_usd, m.peak_schedule ?? null);
      }
    }
    const catalog = p.reviewers ?? p.matrix?.agents;
    if (catalog && p.matrix) {
      exec('DELETE FROM reviewer_agents');
      for (const [name, a] of Object.entries(catalog)) {
        exec('INSERT INTO reviewer_agents (name, reviews_on, family, bills, models) VALUES (?, ?, ?, ?, ?)',
          name, a.reviews_on, familyOf(a.reviews_on, p.matrix) ?? 'unknown', JSON.stringify(a.bills), a.models ? JSON.stringify(a.models) : null);
      }
    }
    // Rule 8 (R-BTN-27) reads the whole matrix (rows, seats, costs) and the posted catalog.
    if (p.matrix) exec(`INSERT INTO baton_settings (key, value) VALUES ('reviewer_matrix', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, JSON.stringify(p.matrix));
    if (p.reviewers) exec(`INSERT INTO baton_settings (key, value) VALUES ('reviewer_catalog', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, JSON.stringify(p.reviewers));
    if (p.transcript_repos) {
      exec(`INSERT INTO baton_settings (key, value) VALUES ('transcript_repos', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, JSON.stringify(p.transcript_repos));
    }
    if (p.min_skills_version != null) {
      exec(`INSERT INTO baton_settings (key, value) VALUES ('min_skills_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, String(p.min_skills_version));
    }
  }

  private event(kind: string, detail: unknown, at: number) {
    this.ctx.storage.sql.exec('INSERT INTO events (at, kind, actor, detail_json) VALUES (?, ?, ?, ?)', at, kind, 'sync', JSON.stringify(detail));
  }

  // ── the dashboard's state (§14: Ready and Providers in rollout step 1) ─────────────────

  uiState() {
    const now = this.now();
    const headSha = this.sql<{ sha: string }>('SELECT sha FROM board_head WHERE id = 1')[0]?.sha ?? null;
    const snap = headSha ? this.sql('SELECT sha, parent_sha, received_at, item_count FROM board_snapshots WHERE sha = ?', headSha)[0] : null;
    const items = this.sql<Record<string, SqlStorageValue>>(
      `SELECT id, path, title, project, status, node, queue, tags, tier, requires_clause, operator_only, ord, rank
       FROM work_items WHERE node LIKE 'ready-%' AND rank IS NOT NULL ORDER BY rank`);
    const requires = new Map<string, string[]>();
    for (const r of this.sql<{ work_item_id: string; name: string }>('SELECT work_item_id, name FROM work_item_requires ORDER BY name')) {
      requires.set(r.work_item_id, [...(requires.get(r.work_item_id) ?? []), r.name]);
    }
    const ready = items.map((r) => ({
      id: r.id,
      title: r.title,
      url: `https://github.com/immediately-run/docs/blob/main/${r.path}`,
      project: r.project,
      tier: r.tier,
      queue: r.queue,
      node: r.node,
      rank: r.rank,
      rank_reason: r.node === 'ready-expedite' ? 'expedite lane' : `${r.queue} queue · order ${r.ord ?? '—'}`,
      requires_clause: r.requires_clause,
      requires: requires.get(r.id as string) ?? [],
      operator_only: r.operator_only === 1,
    }));
    // Per tier ceiling, the order a worker under it would be offered (§13 step 1's exit).
    const byTier = Object.fromEntries((TIERS as string[]).map((t) => [t, ready.filter((r) => fitsTier(r.tier ?? null, t)).map((r) => r.id)]));

    const schedules = new Map(this.sql<{ id: string; rules_json: string; factor: number }>('SELECT id, rules_json, factor FROM peak_schedules').map((s) => [s.id, s]));
    const providers = this.sql<{ id: string; name: string; billing: string; window_limits_json: string | null }>('SELECT id, name, billing, window_limits_json FROM model_providers ORDER BY id').map((a) => {
      const models = this.sql<{ model_id: string; monthly_limit_usd: number | null; peak_schedule_id: string | null }>(
        'SELECT model_id, monthly_limit_usd, peak_schedule_id FROM provider_models WHERE provider_id = ? ORDER BY model_id', a.id);
      const peaks = [...new Set(models.map((m) => m.peak_schedule_id).filter((x): x is string => !!x))].map((id) => {
        const s = schedules.get(id);
        if (!s) return { schedule: id, in_peak: null, next_change: null, factor: null };
        const rules = JSON.parse(s.rules_json);
        return { schedule: id, in_peak: inPeak(rules, now), next_change: nextPeakChange(rules, now), factor: s.factor, models: models.filter((m) => m.peak_schedule_id === id).map((m) => m.model_id) };
      });
      return { id: a.id, name: a.name, billing: a.billing, window_limits: a.window_limits_json ? JSON.parse(a.window_limits_json) : null, models, peaks };
    });

    const held = this.sql(
      `SELECT sha, parent_sha, head_sha, item_count, received_at, auto_accept_at FROM held_snapshots
       WHERE accepted_at IS NULL ORDER BY received_at`);
    const suspensions = this.sql(`SELECT id, provider_id, model_id, mode, starts_at, ends_at, reason, set_by, lifted_at FROM provider_suspensions
                                  WHERE lifted_at IS NULL AND (ends_at IS NULL OR ends_at > ?) ORDER BY starts_at`, now);
    return {
      server_time: now, head: snap, ready, ready_by_tier: byTier, providers, held, workers: this.workers.workersView(now), suspensions,
      running: this.claims.running(now), timeline: this.claims.timeline(now),
      needs_you: { ...this.claims.needsYou(now), adoptions: this.cutover.adoptions() },
      mode: this.workers.mode(),
    };
  }
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new BatonError('invalid-params', 'the body is not JSON');
  }
}
