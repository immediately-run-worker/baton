// state.ts — the runner's local state (BATON_SPEC §6.4): one JSON file per session under
// `~/.cache/immediately-run/baton/`, mode 0600, holding the worker id, the worker secret, the
// active claim, the time of the last successful heartbeat, the lease the server granted and the
// sidecar's lease-lost flag — everything a harness hook or a leg session reads through
// `IR_BATON_STATE` (read-only for them) and everything the fence computes from (R-BTN-26). The
// spool of transcript pointers and activity rows sits beside it (never in it, R-BTN-20).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface RunnerState {
  worker_id: number | null;
  incarnation: number | null;
  secret: string;
  /** The active claim as the runner knows it: id, ticket, nonce. */
  claim: { id: number; ticket_id: string; nonce: string } | null;
  /** Epoch ms of the last heartbeat Baton answered (R-BTN-6). */
  last_ok: number | null;
  /** The lease the server granted, in seconds. */
  lease_timeout_s: number | null;
  /** Set when the sidecar's own computation — or a refused heartbeat — lost the lease. */
  lease_lost: boolean;
  lease_lost_because: string | null;
}

export const emptyState = (): RunnerState => ({ worker_id: null, incarnation: null, secret: '', claim: null, last_ok: null, lease_timeout_s: null, lease_lost: false, lease_lost_because: null });

/** §6.3's margin (R-BTN-6): two missed beats of the 2-minute cadence. */
export const LEASE_MARGIN_MS = 4 * 60_000;

/** Whether the lease is lost from the wall clock alone (R-BTN-26): every fence computes this
 * itself from the state file, never trusting only the sidecar's flag. */
export function leaseLostFrom(s: RunnerState, now: number): boolean {
  if (s.lease_lost) return true;
  if (s.last_ok == null || s.lease_timeout_s == null) return false;
  return now - s.last_ok >= s.lease_timeout_s * 1000 - LEASE_MARGIN_MS;
}

/** A state file at `path`, created on first write with mode 0600 (§6.4). */
export class StateFile {
  private s: RunnerState;
  constructor(readonly path: string) {
    this.s = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as RunnerState) : emptyState();
  }
  get(): RunnerState {
    return { ...this.s, claim: this.s.claim ? { ...this.s.claim } : null };
  }
  /** Update and persist atomically enough for one machine's own readers. */
  set(patch: Partial<RunnerState>): void {
    this.s = { ...this.s, ...patch };
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path, JSON.stringify(this.s), { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }
  /** The spool beside the state file (§6.8): JSON lines a leg session appends, the runner drains. */
  get spool(): string {
    return join(`${this.path}.spool.jsonl`);
  }
}
