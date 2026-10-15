// db.ts — the small helpers every class that writes the object's tables shares: the event log's
// one insert, the random hex nonces and secrets, and recognising a unique-index refusal.
import type { Store } from './ports';

/** Append to the event log (§4): the one place an event row is written. An event about a
 *  ticket belongs to the ticket's repository (its qualified id says which, R-BTN-47); a
 *  repository's own events (a snapshot, a cutover) name it; instance events have none. */
export function logEvent(sql: Store, at: number, kind: string, actor: string, detail: unknown, ticketId: string | null = null, claimId: number | null = null,
  repositoryId: string | null = ticketId ? ticketId.slice(0, ticketId.indexOf(':')) : null) {
  sql.exec('INSERT INTO events (at, kind, ticket_id, claim_id, actor, detail_json, repository_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    at, kind, ticketId, claimId, actor, JSON.stringify(detail), repositoryId);
}

/** `bytes` random bytes as hex: a claim's 6-hex nonce, a legacy worker's unusable secret hash. */
export function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Whether `e` is SQLite refusing a write on a unique index — the lock's refusal (R-BTN-4). */
export function isUniqueViolation(e: unknown): boolean {
  return /UNIQUE constraint failed/.test(String(e));
}
