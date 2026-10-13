// mirror.ts — what the git mirror reads and reports (BATON_SPEC §12, R-BTN-36; R3-1218): the
// event feed `GET /v1/sync/events`, the foreign-claim report, and which workflows Baton
// dispatches after a transition (§10.3). The mirror workflow itself lives in docs.
import { BatonError } from './http';
import { ITEM_ID } from './validate';
import { logEvent, randomHex } from './db';
import { LEGACY_REAP_MS } from './cutover';

type Row = Record<string, SqlStorageValue>;
const MAX_PAGE = 200;
const NONCE = /^[0-9a-f]{6}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
/** R-BTN-36: the detail keys the feed may carry. Nothing that names a session, worker or host
 *  (`session`, `worker_id`, `request_id`, an owner's email) ever leaves through it. */
const DETAIL_KEYS = new Set(['end_reason', 'ended_at_sha', 'hold_reason', 'hold', 'expedite', 'retry_after', 'attempts', 'fence_pending',
  'by', 'legacy', 'shadow', 'status', 'nonce', 'holder_nonce', 'sha', 'imported', 'snapshot', 'reason', 'action', 'after', 'since', 'claim_id']);
/** The actor's kind only: `worker:<id>` and `owner:<email>` name people and machines. */
const actorKind = (actor: string) => actor.split(':')[0];

export interface Ctx {
  storage: DurableObjectStorage;
  now: () => number;
}

export class Mirror {
  constructor(private readonly c: Ctx) {}

  private rows<T = Row>(q: string, ...p: unknown[]): T[] {
    return this.c.storage.sql.exec(q, ...(p as SqlStorageValue[])).toArray() as T[];
  }

  /**
   * `GET /v1/sync/events?after=<seq>` (§12): the log after the mirror's cursor, oldest first,
   * at most 200 per page. Each event carries its claim's nonce and, once ended, its end and
   * whether work started; an ended claim also carries its activities and transcript pointers
   * for the export. Workers are named only by claim id (R-BTN-36). `cutover_at` lets the
   * mirror leave pre-cutover claims to git, which wrote them itself.
   */
  events(after: number, limit: number) {
    const n = Math.min(Math.max(1, limit || MAX_PAGE), MAX_PAGE);
    const rows = this.rows<{ seq: number; at: number; kind: string; work_item_id: string | null; claim_id: number | null; actor: string; detail_json: string | null }>(
      'SELECT seq, at, kind, work_item_id, claim_id, actor, detail_json FROM events WHERE seq > ? ORDER BY seq LIMIT ?', after, n);
    const events = rows.map((e) => {
      let detail: Record<string, unknown> = {};
      try {
        detail = e.detail_json ? JSON.parse(e.detail_json) : {};
      } catch {
        detail = {};
      }
      const kept = Object.fromEntries(Object.entries(detail).filter(([k]) => DETAIL_KEYS.has(k)));
      return { seq: e.seq, at: e.at, kind: e.kind, work_item_id: e.work_item_id, claim_id: e.claim_id, actor: actorKind(e.actor), detail: kept, claim: e.claim_id ? this.claim(e.claim_id) : null };
    });
    const at = this.rows<{ value: string }>(`SELECT value FROM baton_settings WHERE key = 'cutover_at'`)[0]?.value;
    return { events, next: events.at(-1)?.seq ?? after, cutover_at: at == null ? null : Number(at) };
  }

  private claim(id: number) {
    const c = this.rows<{ id: number; nonce: string; status: string; end_reason: string | null; claimed_at: number; ended_at: number | null; ended_at_sha: string | null }>(
      'SELECT id, nonce, status, end_reason, claimed_at, ended_at, ended_at_sha FROM work_item_claims WHERE id = ?', id)[0];
    if (!c) return null;
    // §12's `unstarted:` note: a claim that ended before any work beyond orienting.
    const started = this.rows(`SELECT 1 FROM activities WHERE claim_id = ? AND kind != 'orient' LIMIT 1`, id).length > 0;
    const out: Record<string, unknown> = { ...c, started };
    if (c.status !== 'active') {
      out.activities = this.rows('SELECT kind, seq, label, started_at, ended_at, outcome, detail_json FROM activities WHERE claim_id = ? ORDER BY started_at', id);
      out.transcripts = this.rows('SELECT repo, path, role FROM transcripts WHERE claim_id = ? ORDER BY id', id);
    }
    return out;
  }

  /**
   * `POST /v1/sync/foreign-claim` (§12): the mirror found a `roadmap: claim` commit it did not
   * write (a stale clone's old claim.sh). If Baton holds the item, the holder keeps it — the
   * answer carries its nonce so the mirror can write the holder's note back — and the report is
   * a `foreign-claim` event. If nobody holds it, it is imported as a legacy claim under the
   * commit's own nonce, so it is visible and reaped on the witness's 7-day rule. Before cutover
   * git decides alone, and the report is ignored. A repeat is idempotent.
   */
  foreignClaim(body: unknown) {
    const b = (body ?? {}) as Record<string, unknown>;
    if (typeof b.work_item_id !== 'string' || !ITEM_ID.test(b.work_item_id)) throw new BatonError('invalid-params', 'work_item_id: must be a work item id');
    if (typeof b.nonce !== 'string' || !NONCE.test(b.nonce)) throw new BatonError('invalid-params', 'nonce: must be the claim note’s 6 hex');
    if (typeof b.sha !== 'string' || !GIT_SHA.test(b.sha)) throw new BatonError('invalid-params', 'sha: must be the claim commit');
    if (!Number.isInteger(b.at) || (b.at as number) < 0) throw new BatonError('invalid-params', 'at: must be the commit’s epoch ms');
    const item = b.work_item_id;
    const nonce = b.nonce;
    const cut = this.rows(`SELECT 1 FROM baton_settings WHERE key = 'cutover_at'`).length > 0;
    if (!cut) return { ignored: 'shadow' };
    const now = this.c.now();
    const holder = this.rows<{ id: number; nonce: string; claimed_at: number }>(
      `SELECT id, nonce, claimed_at FROM work_item_claims WHERE work_item_id = ? AND status = 'active'`, item)[0];
    if (holder && holder.nonce === nonce) return { imported: true, claim_id: holder.id, nonce };
    if (holder) {
      logEvent(this.c.storage.sql, now, 'foreign-claim', 'sync', { nonce, holder_nonce: holder.nonce, sha: b.sha }, item, holder.id);
      return { held: true, claim_id: holder.id, nonce: holder.nonce, claimed_at: holder.claimed_at };
    }
    // Nobody holds it: a legacy claim of its own legacy worker, as the cutover import makes.
    this.c.storage.sql.exec(`INSERT INTO credentials (id, hostname, allowed_capabilities) VALUES ('legacy', 'legacy', '[]') ON CONFLICT (id) DO NOTHING`);
    const session = this.rows(`SELECT 1 FROM workers WHERE hostname = 'legacy' AND session_name = ?`, `item-${item}`).length
      ? `item-${item}-${nonce}` : `item-${item}`;
    this.c.storage.sql.exec(`INSERT INTO workers (hostname, session_name, secret_hash, credential_id, harness, kind, tier_ceiling, lease_timeout_ms, settings_hash, first_seen_at, last_seen_at)
                             VALUES ('legacy', ?, ?, 'legacy', 'claude-code', 'legacy', 'critical', 0, '', ?, ?)`, session, randomHex(32), now, now);
    const workerId = this.rows<{ id: number }>('SELECT last_insert_rowid() AS id')[0].id;
    const head = this.rows<{ sha: string }>('SELECT sha FROM board_head WHERE id = 1')[0]?.sha ?? '';
    this.c.storage.sql.exec(`INSERT INTO work_item_claims (work_item_id, worker_id, request_id, nonce, snapshot_sha, claimed_at, status, reap_after)
                             VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`, item, workerId, `foreign:${item}:${nonce}`, nonce, head, b.at, (b.at as number) + LEGACY_REAP_MS);
    const claimId = this.rows<{ id: number }>('SELECT last_insert_rowid() AS id')[0].id;
    logEvent(this.c.storage.sql, now, 'foreign-claim', 'sync', { nonce, sha: b.sha, imported: true }, item, claimId);
    return { imported: true, claim_id: claimId, nonce };
  }
}

/** §10.3: the workflows Baton dispatches. */
export type Workflow = 'baton-mirror.yml' | 'baton-sync.yml';

/**
 * Dispatch `workflow` on docs main with the Actions-write token (§10.3). Fire and forget: a
 * missing or revoked token, or a failed call, leaves the workflow to its 15-minute schedule.
 */
export async function dispatchWorkflow(env: Env, workflow: Workflow): Promise<boolean> {
  if (!env.GITHUB_DISPATCH_TOKEN) return false;
  try {
    const res = await fetch(`https://api.github.com/repos/${env.OIDC_REPOSITORY}/actions/workflows/${workflow}/dispatches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'baton', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main' }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
