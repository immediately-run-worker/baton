// cutover.ts — the one-way switch (BATON_SPEC §13 step 3, R-BTN-28; R3-1217): the owner's
// cutover, the legacy import that runs in the same transaction, and adoption of a legacy claim
// by the session that was working it, which moves only on the owner's confirmation.
import { BatonError } from './http';
import { checkConfirm, checkRepositoryId, SESSION_NAME, TICKET_ID } from './validate';
import { localOf, repositoryOf } from './registry';
import { isUniqueViolation, logEvent, randomHex } from './db';

import type { Row, SqlValue, Store } from './ports';
/** The cutover refuses a board older than this: the import must see git's in-progress items as they are. */
export const FRESH_BOARD_MS = 15 * 60_000;
/** §13: a legacy claim is reaped at its claim note's date plus 7 days — the witness's rule. */
export const LEGACY_REAP_MS = 7 * 24 * 3_600_000;

/**
 * §13 step 3: one legacy claim of its own legacy worker — the shape the cutover import and the
 * mirror's foreign-claim report (§12) both make. The worker is named for `preferred` (the claim
 * note's holder) unless a legacy worker already has that name, else `item-<id>` (the
 * ticket's local id, as its claim note writes it), else `item-<id>-<nonce>`; the claim is reaped at `claimedAt` plus 7 days. Logs the `claimed`
 * (legacy) event the export reads as the claim's record.
 */
export function importLegacyClaim(sql: Store, now: number,
  o: { item: string; preferred: string | null; nonce: string; claimedAt: number; sha: string; requestId: string; detail?: Record<string, unknown> }) {
  const taken = (name: string) => sql.exec(`SELECT 1 FROM workers WHERE hostname = 'legacy' AND session_name = ?`, name).toArray().length > 0;
  sql.exec(`INSERT INTO credentials (id, hostname, allowed_capabilities) VALUES ('legacy', 'legacy', '[]') ON CONFLICT (id) DO NOTHING`);
  const session = o.preferred && SESSION_NAME.test(o.preferred) && !taken(o.preferred) ? o.preferred
    : !taken(`item-${localOf(o.item)}`) ? `item-${localOf(o.item)}` : `item-${localOf(o.item)}-${o.nonce}`;
  sql.exec(`INSERT INTO workers (hostname, session_name, secret_hash, credential_id, harness, kind, tier_ceiling, lease_timeout_ms, settings_hash, first_seen_at, last_seen_at)
            VALUES ('legacy', ?, ?, 'legacy', 'claude-code', 'legacy', 'critical', 0, '', ?, ?)`, session, randomHex(32), now, now);
  const workerId = sql.exec('SELECT last_insert_rowid() AS id').one().id as number;
  sql.exec(`INSERT INTO claims (ticket_id, worker_id, request_id, nonce, snapshot_sha, claimed_at, status, reap_after)
            VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`, o.item, workerId, o.requestId, o.nonce, o.sha, o.claimedAt, o.claimedAt + LEGACY_REAP_MS);
  const claimId = sql.exec('SELECT last_insert_rowid() AS id').one().id as number;
  logEvent(sql, now, 'claimed', 'baton', { legacy: true, session, ...(o.detail ?? {}) }, o.item, claimId);
  return { claimId, session };
}

export interface Ctx {
  store: Store;
  now: () => number;
}

export class Cutover {
  constructor(private readonly c: Ctx) {}

  private rows<T = Row>(q: string, ...p: unknown[]): T[] {
    return this.c.store.exec(q, ...p).toArray() as T[];
  }
  private exec(q: string, ...p: unknown[]) {
    return this.c.store.exec(q, ...p);
  }
  private event(kind: string, actor: string, detail: unknown, ticketId: string | null = null, claimId: number | null = null) {
    logEvent(this.c.store, this.c.now(), kind, actor, detail, ticketId, claimId);
  }

  /** When `repo` cut over (R-BTN-28, per repository), or null: it has not, or is unknown. */
  cutoverAt(repo: string): number | null {
    return this.rows<{ cutover_at: number | null }>('SELECT cutover_at FROM repositories WHERE id = ?', repo)[0]?.cutover_at ?? null;
  }

  /**
   * `POST /v1/ui/cutover {repository, confirm}` (R-BTN-28): records the repository's
   * `cutover_at` — the only write of it anywhere, and no call clears it — and imports each of its
   * in-progress tickets without a Baton claim as a claim of its own legacy worker, in the same
   * transaction. Refused unless its newest snapshot is under 15 minutes old. A repeat is a no-op
   * that keeps the first `cutover_at`.
   */
  cutover(owner: string, body: unknown) {
    checkConfirm(body);
    const repo = checkRepositoryId((body as { repository?: unknown }).repository);
    if (!this.rows('SELECT 1 FROM repositories WHERE id = ? AND retired_at IS NULL', repo).length) {
      throw new BatonError('invalid-params', 'repository: must be a registered repository id');
    }
    const already = this.cutoverAt(repo);
    if (already != null) return { ok: true, repository: repo, cutover_at: already, imported: [] as string[] };
    const now = this.c.now();
    const head = this.rows<{ sha: string; received_at: number }>(
      `SELECT s.sha, s.received_at FROM board_head h JOIN board_snapshots s ON s.repository_id = h.repository_id AND s.sha = h.sha
       WHERE h.repository_id = ?`, repo)[0];
    if (!head || now - head.received_at >= FRESH_BOARD_MS) {
      throw new BatonError('forbidden', `${repo}'s newest board snapshot must be under 15 minutes old; let its sync post, then cut over`);
    }
    const imported = this.importLegacy(repo, head.sha, now);
    this.exec('UPDATE repositories SET cutover_at = ? WHERE id = ?', now, repo);
    logEvent(this.c.store, now, 'cutover', `owner:${owner}`, { snapshot: head.sha, imported }, null, null, repo);
    return { ok: true, repository: repo, cutover_at: now, imported };
  }

  /** §13 step 3: one legacy worker per in-progress item with no Baton claim — named for the
   *  claim note's holder session when the board carries it, else `item-<id>` — holding an
   *  active claim reaped at the note's date plus 7 days. */
  private importLegacy(repo: string, sha: string, now: number): string[] {
    const items = this.rows<{ id: string; since: string | null; holder: string | null }>(
      `SELECT id, since, holder FROM tickets w WHERE repository_id = ? AND status = 'in-progress'
       AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.ticket_id = w.id AND c.status = 'active') ORDER BY id`, repo);
    const out: string[] = [];
    for (const it of items) {
      // A holder session that two notes share falls back to the item's own name rather than
      // merging two claims into one worker (the per-hostname session name is unique).
      importLegacyClaim(this.c.store, now, {
        item: it.id, preferred: it.holder, nonce: randomHex(3), sha, requestId: `legacy:${it.id}`,
        claimedAt: it.since ? Date.parse(`${it.since}T00:00:00Z`) : now, detail: { since: it.since },
      });
      out.push(it.id);
    }
    return out;
  }

  /** `POST /v1/runner/adopt` (§13 step 3): the session that was working a legacy item asks for
   *  it — a worker whose session name is the legacy worker's (the claim note's holder). When the
   *  note named no holder (`item-<id>`), any session may ask; the owner's confirmation is the
   *  gate either way. The claim does not move here. */
  adopt(workerId: number, body: unknown) {
    const item = (body as { ticket_id?: unknown } | null)?.ticket_id;
    if (typeof item !== 'string' || !TICKET_ID.test(item)) throw new BatonError('invalid-params', 'ticket_id: must be a ticket id, <repository>:<id>');
    if (this.cutoverAt(repositoryOf(item)) == null) throw new BatonError('not-cut-over', 'adoption follows the cutover import');
    const c = this.rows<{ id: number; nonce: string; session_name: string }>(
      `SELECT c.id, c.nonce, w.session_name FROM claims c JOIN workers w ON w.id = c.worker_id
       WHERE c.ticket_id = ? AND c.status = 'active' AND w.kind = 'legacy'`, item)[0];
    if (!c) throw new BatonError('not-found', `${item} has no legacy claim to adopt`);
    const me = this.rows<{ session_name: string }>('SELECT session_name FROM workers WHERE id = ?', workerId)[0];
    // A note with no holder made `item-<id>`, or `item-<id>-<nonce>` when another repository's
    // ticket of the same local id had taken that name first (importLegacyClaim).
    const unnamed = c.session_name === `item-${localOf(item)}` || c.session_name === `item-${localOf(item)}-${c.nonce}`;
    if (!unnamed && c.session_name !== me.session_name) {
      throw new BatonError('forbidden', 'only the session the claim note names may ask to adopt it');
    }
    this.exec(`INSERT INTO adoptions (ticket_id, claim_id, worker_id, requested_at) VALUES (?, ?, ?, ?)
               ON CONFLICT (ticket_id) DO UPDATE SET claim_id = excluded.claim_id, worker_id = excluded.worker_id, requested_at = excluded.requested_at`,
      item, c.id, workerId, this.c.now());
    return { claim_id: c.id, nonce: c.nonce, pending: true };
  }

  /** `POST /v1/ui/adoptions/{item}/confirm`: the owner moves the legacy claim to the session
   *  that asked. The per-worker index refuses it if that session already holds another item. */
  confirmAdoption(owner: string, item: string, body: unknown) {
    checkConfirm(body);
    const a = this.rows<{ claim_id: number; worker_id: number }>('SELECT claim_id, worker_id FROM adoptions WHERE ticket_id = ?', item)[0];
    if (!a) throw new BatonError('not-found', 'no adoption request for that item');
    // (A legacy claim that ends deletes its request in Claims.finish, so it is never stale here.)
    const live = this.rows(`SELECT 1 FROM claims c JOIN workers w ON w.id = c.worker_id WHERE c.id = ? AND c.status = 'active' AND w.kind = 'legacy'`, a.claim_id).length;
    if (!live) throw new BatonError('claim-ended', 'the legacy claim has ended');
    // A late confirmation must not hand a live claim to a session that has since gone silent:
    // the alarm would reap it at once, as a failed attempt (§6.10).
    const asker = this.rows<{ reaped_at: number | null; last_seen_at: number; lease_timeout_ms: number }>(
      'SELECT reaped_at, last_seen_at, lease_timeout_ms FROM workers WHERE id = ?', a.worker_id)[0];
    if (!asker || asker.reaped_at != null || this.c.now() - asker.last_seen_at >= asker.lease_timeout_ms) {
      throw new BatonError('not-eligible', 'the session that asked is no longer alive; it must ask again', { rule: 'requester-silent' });
    }
    try {
      this.exec('UPDATE claims SET worker_id = ?, reap_after = NULL WHERE id = ?', a.worker_id, a.claim_id);
    } catch (e) {
      if (isUniqueViolation(e)) throw new BatonError('not-eligible', 'that session already holds another item', { rule: 'one-claim-per-worker' });
      throw e;
    }
    this.exec('DELETE FROM adoptions WHERE ticket_id = ?', item);
    this.event('adopted', `owner:${owner}`, { worker_id: a.worker_id }, item, a.claim_id);
    return { ok: true };
  }

  adoptions() {
    // Only requests the owner can act on: the legacy claim still active, the asker still alive.
    return this.rows(`SELECT a.ticket_id, a.claim_id, a.worker_id, a.requested_at, w.hostname, w.session_name, l.session_name AS legacy_session
                      FROM adoptions a JOIN workers w ON w.id = a.worker_id JOIN claims c ON c.id = a.claim_id
                      JOIN workers l ON l.id = c.worker_id
                      WHERE c.status = 'active' AND l.kind = 'legacy' AND w.reaped_at IS NULL AND ? - w.last_seen_at < w.lease_timeout_ms
                      ORDER BY a.requested_at`, this.c.now());
  }
}
