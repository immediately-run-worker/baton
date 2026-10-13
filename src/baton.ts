// baton.ts — the one Durable Object (BATON_SPEC §3): every table, every write. Requests reach
// it only through the Worker (src/worker.ts), which has already verified the principal, so
// nothing here re-reads a credential. Each request runs alone and its writes are one
// transaction, so the compare-and-set below needs no lock.
import { DurableObject } from 'cloudflare:workers';
import { MIGRATIONS } from './migrations';
import { BatonError, errorResponse, json } from './http';
import { checkPayload, inPeak, nextPeakChange, priceFor, rowFor, rowHash, type BoardPayload } from './board';
import { familyOf } from './shared/baton.mjs';
import { fitsTier, TIERS } from './shared/vocabulary.mjs';

const HELD_AUTO_ACCEPT_MS = 24 * 3_600_000; // §7.1: a held history is accepted after 24 h (R3-1212)

export class Baton extends DurableObject<Env> {
  /** The clock (R-BTN-32). Tests replace it through `runInDurableObject`; nothing else here
   *  reads the time. */
  now: () => number = () => Date.now();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The object refuses to serve until every migration is applied (§3).
    ctx.blockConcurrencyWhile(async () => this.migrate());
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
    try {
      if (req.method === 'GET' && url.pathname === '/v1/sync/head') return json(this.head());
      if (req.method === 'POST' && url.pathname === '/v1/sync/board') return json(await this.board(checkPayload(await readJson(req))));
      if (req.method === 'GET' && url.pathname === '/v1/ui/state') return json(this.uiState());
      throw new BatonError('not-found', `no route ${req.method} ${url.pathname}`);
    } catch (e) {
      // Drain an unread body so the forwarded stream completes before the response does.
      if (req.body && !req.bodyUsed) await req.arrayBuffer().catch(() => {});
      if (e instanceof BatonError) return errorResponse(e.code, e.message);
      throw e;
    }
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
   * held for the owner as a `snapshot-rejected` event and changes nothing else; accepting it
   * is the alarm's and the dashboard's job (R3-1212). A repeat of the head is a no-op.
   */
  async board(p: BoardPayload) {
    const head = this.sql<{ sha: string }>('SELECT sha FROM board_head WHERE id = 1')[0]?.sha ?? null;
    const at = this.now();
    if (p.force) {
      this.event('snapshot-rejected', { sha: p.sha, parent_sha: p.parent_sha, head, item_count: p.state.items.length, held: true, auto_accept_at: at + HELD_AUTO_ACCEPT_MS }, at);
      throw new BatonError('snapshot-rejected', 'a rewritten history is held for the owner; claims continue on the current head');
    }
    if (p.sha === head) return { ok: true, unchanged: true };
    if (p.parent_sha !== head) throw new BatonError('head-moved', `the head is ${head ?? 'unset'}; re-read it and retry`);

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
             depends_on, blocked_by, repos, ord, rank, snapshot_sha, row_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET path = excluded.path, title = excluded.title, project = excluded.project,
             status = excluded.status, node = excluded.node, queue = excluded.queue, tags = excluded.tags,
             tier = excluded.tier, requires_clause = excluded.requires_clause, operator_only = excluded.operator_only,
             depends_on = excluded.depends_on, blocked_by = excluded.blocked_by, repos = excluded.repos,
             ord = excluded.ord, rank = excluded.rank, snapshot_sha = excluded.snapshot_sha, row_hash = excluded.row_hash`,
          row.id, row.path, row.title, row.project, row.status, row.node, row.queue, row.tags, row.tier,
          row.requires_clause, row.operator_only, row.depends_on, row.blocked_by, row.repos, row.ord, row.rank, p.sha, hash);
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
      this.event('snapshot-accepted', { sha: p.sha, parent_sha: p.parent_sha, item_count: p.state.items.length, ...changed }, at);
    });
    return { ok: true, ...changed };
  }

  /** The reference data the sync posts with every snapshot (§7.3, §7.4): providers, peak
   *  schedules, per-model prices and limits, the reviewer catalog, `min_skills_version`. Each
   *  table is a copy of a docs file, never edited here, so it is rewritten whole. */
  private reference(p: BoardPayload) {
    const exec = (q: string, ...a: unknown[]) => this.ctx.storage.sql.exec(q, ...(a as SqlStorageValue[]));
    if (p.providers) {
      exec('DELETE FROM provider_models');
      for (const a of p.providers.accounts) {
        exec(`INSERT INTO model_providers (id, name, billing, window_limits_json) VALUES (?, ?, ?, ?)
              ON CONFLICT (id) DO UPDATE SET name = excluded.name, billing = excluded.billing, window_limits_json = excluded.window_limits_json`,
          a.id, a.name, a.billing, a.window_limits ? JSON.stringify(a.window_limits) : null);
      }
      exec('DELETE FROM peak_schedules');
      for (const s of p.providers.peak_schedules) exec('INSERT INTO peak_schedules (id, rules_json, factor) VALUES (?, ?, ?)', s.id, JSON.stringify(s.rules), s.factor);
      for (const m of p.providers.models) {
        const price = priceFor(p.prices, m.model);
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

    const held = this.sql<{ at: number; detail_json: string }>(
      `SELECT at, detail_json FROM events WHERE kind = 'snapshot-rejected' ORDER BY seq DESC LIMIT 5`).map((e) => ({ at: e.at, ...JSON.parse(e.detail_json) }));
    return { server_time: now, head: snap, ready, ready_by_tier: byTier, providers, held };
  }
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new BatonError('invalid-params', 'the body is not JSON');
  }
}
