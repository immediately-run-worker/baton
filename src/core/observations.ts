// observations.ts — the per-repository counter that orders what each sync saw (BATON_SPEC
// R-BTN-62). `POST /v1/sync/observation` hands out the next number before the sync reads anything;
// its board post carries the number back, and is accepted or refused whole. A number is used
// once — posted or refused — and at most one is outstanding per repository at a time, so two
// overlapping sync runs can never post an older reading under a higher number.
import { BatonError } from './http';
import type { Store } from './ports';

/** An outstanding number older than this is void (R-BTN-62). */
export const OBSERVATION_TTL_MS = 10 * 60_000;

interface HeadRow { sha: string | null; observation: number; last_handed_out: number; handed_out_at: number | null }

export class Observations {
  constructor(private readonly c: { store: Store; now: () => number }) {}

  private row(repo: string): HeadRow {
    const r = this.c.store.exec<HeadRow>('SELECT sha, observation, last_handed_out, handed_out_at FROM board_head WHERE repository_id = ?', repo).toArray()[0];
    if (!r) throw new BatonError('forbidden', `${repo} has no board`);
    return r;
  }

  /** `POST /v1/sync/observation`: the head and the next number — refused `sync-busy` while the
   *  last one is outstanding and under 10 minutes old; an older one is voided by handing out the
   *  next. `bars` are the owner bars in force (R-BTN-67): none until Baton keeps owner bars. */
  // @model syncNumber sha256:f054af5dfb64
  // @model syncVoid sha256:26644cee5ca9
  observe(repo: string): { sha: string | null; observation: number; bars: unknown[] } {
    return this.c.store.transaction(() => {
      const now = this.c.now();
      const h = this.row(repo);
      if (h.handed_out_at != null && now - h.handed_out_at < OBSERVATION_TTL_MS) {
        throw new BatonError('sync-busy', `observation ${h.last_handed_out} is still outstanding; one reading at a time per repository (R-BTN-62)`);
      }
      const n = h.last_handed_out + 1;
      this.c.store.exec('UPDATE board_head SET last_handed_out = ?, handed_out_at = ? WHERE repository_id = ?', n, now, repo);
      return { sha: h.sha, observation: n, bars: [] };
    });
  }

  /** Use the number a board post carries, whatever becomes of the post: it must be the
   *  outstanding one, under 10 minutes old, and above the last accepted reading's — else the
   *  post is refused `stale-observation`. Committed before the post is judged, so a number is
   *  used once even when the post is then refused (head-moved, held, invalid). */
  // @model syncPost sha256:94a83f53cf43
  // @model syncVoid sha256:26644cee5ca9
  use(repo: string, n: number): void {
    const verdict = this.c.store.transaction(() => {
      const now = this.c.now();
      const h = this.row(repo);
      const outstanding = h.handed_out_at != null && n === h.last_handed_out;
      if (outstanding) this.c.store.exec('UPDATE board_head SET handed_out_at = NULL WHERE repository_id = ?', repo);
      if (n <= h.observation) return `observation ${n} is not above the last accepted reading's (${h.observation})`;
      if (!outstanding) return `observation ${n} is not the outstanding number (the last handed out is ${h.last_handed_out}${h.handed_out_at == null ? ', already used' : ''})`;
      if (now - (h.handed_out_at as number) >= OBSERVATION_TTL_MS) return `observation ${n} was handed out over 10 minutes ago and is void`;
      return null;
    });
    if (verdict) throw new BatonError('stale-observation', `${verdict}; take a new number and retry (R-BTN-62)`);
  }

  /** A refused post's number, used without judging it: it is no longer outstanding. */
  release(repo: string, n: number): void {
    this.c.store.exec('UPDATE board_head SET handed_out_at = NULL WHERE repository_id = ? AND last_handed_out = ?', repo, n);
  }

  /** Whether `n` is still above the last accepted reading's: re-checked in a post's writing
   *  transaction, after its awaits. */
  newest(repo: string, n: number): boolean {
    return this.row(repo).observation < n;
  }

  /** Record an accepted reading's number (the post's own transaction). */
  accept(repo: string, n: number): void {
    this.c.store.exec('UPDATE board_head SET observation = ? WHERE repository_id = ? AND observation < ?', n, repo, n);
  }
}
