// stations.ts — where each ticket is, as its repository's sync places it (BATON_SPEC §2e R-BTN-70,
// R-BTN-39, §7.1 `stations` and `closed`, R-BTN-10's closures). A cache each accepted snapshot
// overwrites: Baton never computes a station, and on any conflict git wins. Applying a snapshot
// also notices a path that is neither an extension of the previous one by edges of the course
// file nor shorter (`off-graph`), and hands the claims what changed, so they judge confirmation,
// staleness and regression from it (claims.ts).
import { logEvent } from './db';
import { extendsPath, graphOf, onGraph, type Graph, type Step } from './graph';
import type { PostedStation } from './board';
import type { Store } from './ports';
import { qualify } from './validate';

/** What one snapshot showed of one ticket, against the previous accepted one. */
export interface Seen {
  station: string;
  path: Step[];
  /** The previous accepted snapshot's path, or null when it placed the ticket nowhere. */
  prev: Step[] | null;
  bars: Record<string, string[]>;
}

export class Stations {
  private graphs = new Map<string, Graph | null>();

  constructor(private readonly c: { store: Store; now: () => number }) {}

  private rows<T>(q: string, ...p: unknown[]): T[] {
    return this.c.store.exec<T>(q, ...p).toArray();
  }
  private exec(q: string, ...p: unknown[]) {
    return this.c.store.exec(q, ...p);
  }

  /** The graph of a repository's course in force, or null when it has none. Cached until the next
   *  board post, which resets it before and after it runs and again once its registry is applied:
   *  the course table changes only there. */
  graph(repo: string, course: string): Graph | null {
    const key = `${repo}\u0000${course}`;
    if (!this.graphs.has(key)) {
      const row = this.rows<{ course_json: string }>('SELECT course_json FROM courses WHERE repository_id = ? AND id = ?', repo, course)[0];
      this.graphs.set(key, row ? graphOf(JSON.parse(row.course_json)) : null);
    }
    return this.graphs.get(key)!;
  }

  /** Forget the cached graphs: a registry was applied. */
  reset() {
    this.graphs.clear();
  }

  /** The interim post's stations (docs until R3-1233), which place nothing: each ticket rests at
   *  its course's start with the start leg queued, ready exactly when factory-state calls the
   *  item ready. Interim tickets therefore claim as before, and run their legs by `advance`. */
  interim(repo: string, items: { id: string; course: string; node: string }[]): Map<string, PostedStation> {
    const out = new Map<string, PostedStation>();
    for (const it of items) {
      const g = this.graph(repo, it.course);
      if (!g) continue;
      const ready = it.node.startsWith('ready-');
      out.set(it.id, {
        station: g.start, path: [], next_leg: g.startLeg, next_source: 'course', handoff_url: null,
        next: [{ leg: g.startLeg, state: ready ? 'ready' : 'waiting', waiting_on: ready ? null : it.node.slice(0, 64) }], bars: {},
      });
    }
    return out;
  }

  /**
   * Write a snapshot's stations for the repository's live tickets (by local id) and its closures.
   * A station naming a station or leg the course file does not have — the file or the sync is
   * wrong — places the ticket nowhere and logs `off-graph`, so it is never offered on a guess. A
   * path that neither extends the previous one by edges nor is shorter is stored (git wins) and
   * logs `off-graph`. Returns what each placed ticket showed, by qualified id.
   */
  apply(repo: string, sha: string, observation: number, stations: Map<string, PostedStation>, closed: { id: string; as: 'done' | 'withdrawn' }[], at: number): Map<string, Seen> {
    const seen = new Map<string, Seen>();
    for (const [local, st] of stations) {
      const id = qualify(repo, local);
      const t = this.rows<{ course_id: string }>('SELECT course_id FROM tickets WHERE id = ?', id)[0];
      if (!t) continue;
      const g = this.graph(repo, t.course_id);
      const unknown = !g ? 'no course in force' : this.unknownNames(g, st);
      const prevRow = this.rows<{ path: string }>('SELECT path FROM ticket_stations WHERE ticket_id = ?', id)[0];
      const prev = prevRow ? (JSON.parse(prevRow.path) as Step[]) : null;
      if (unknown) {
        this.clear(id);
        // Once per distinct fault, not on every snapshot that repeats it (the sync posts every
        // 15 minutes).
        const last = this.rows<{ why: string | null }>(
          `SELECT json_extract(detail_json, '$.why') AS why FROM events WHERE ticket_id = ? AND kind = 'off-graph' ORDER BY seq DESC LIMIT 1`, id)[0];
        if (last?.why !== unknown) this.offGraph(repo, id, { observation, why: unknown });
        continue;
      }
      // §2e: between two snapshots the path extends by edges, or goes backwards (a regression,
      // judged by the claims); anything else is off-graph. The first placement must follow the
      // file from its start.
      const fine = prev ? extendsPath(g!, prev, st.path, g!.start) || st.path.length < prev.length : onGraph(g!, st.path);
      if (!fine) this.offGraph(repo, id, { observation, why: prev ? 'the path does not extend the previous one by edges' : 'the path does not follow the course file from its start', path: st.path, previous: prev });
      this.write(id, g!, st, sha, observation, at);
      seen.set(id, { station: st.station, path: st.path, prev, bars: st.bars });
    }
    for (const c of closed) {
      // The first snapshot to report a closure stands (R-BTN-10 compares its observation).
      this.exec('INSERT INTO closed_tickets (ticket_id, closed_as, observation, closed_at) VALUES (?, ?, ?, ?) ON CONFLICT (ticket_id) DO NOTHING',
        qualify(repo, c.id), c.as, observation, at);
    }
    return seen;
  }

  /** A live ticket is not closed: a closure row of a ticket that returned is deleted. */
  reopened(repo: string, liveLocals: string[]) {
    this.exec(`DELETE FROM closed_tickets WHERE ticket_id IN (SELECT ? || ':' || value FROM json_each(?))`, repo, JSON.stringify(liveLocals));
  }

  /** A ticket that left the board leaves the cache. */
  clear(id: string) {
    this.exec('DELETE FROM ticket_stations WHERE ticket_id = ?', id);
    this.exec('DELETE FROM ticket_next_legs WHERE ticket_id = ?', id);
    this.exec('DELETE FROM ticket_bars WHERE ticket_id = ?', id);
  }

  /** Every station and leg a posted station names must be in the course file (§7.1). */
  private unknownNames(g: Graph, st: PostedStation): string | null {
    if (!g.stations.has(st.station)) return `unknown station ${st.station}`;
    for (const s of st.path) {
      if (!g.legs.has(s.leg)) return `unknown leg ${s.leg} in the path`;
      if (!g.stations.has(s.reached)) return `unknown station ${s.reached} in the path`;
    }
    if (st.next_leg !== null && !(g.legs.get(st.next_leg)?.from.includes(st.station))) return `the queued leg ${st.next_leg} does not leave ${st.station}`;
    for (const n of st.next) if (!g.legs.get(n.leg)?.from.includes(st.station)) return `the next leg ${n.leg} does not leave ${st.station}`;
    for (const leg of Object.keys(st.bars)) if (!g.legs.has(leg)) return `bars for unknown leg ${leg}`;
    return null;
  }

  private write(id: string, g: Graph, st: PostedStation, sha: string, observation: number, at: number) {
    const before = new Map(this.rows<{ leg: string; state: string; ready_since: number | null; waiting_since: number | null }>(
      'SELECT leg, state, ready_since, waiting_since FROM ticket_next_legs WHERE ticket_id = ?', id).map((r) => [r.leg, r]));
    this.exec(`INSERT INTO ticket_stations (ticket_id, station, path, path_len, to_end, next_leg, next_source, handoff_url, snapshot_sha, observation)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (ticket_id) DO UPDATE SET station = excluded.station, path = excluded.path, path_len = excluded.path_len,
                 to_end = excluded.to_end, next_leg = excluded.next_leg, next_source = excluded.next_source, handoff_url = excluded.handoff_url,
                 snapshot_sha = excluded.snapshot_sha, observation = excluded.observation`,
      id, st.station, JSON.stringify(st.path), st.path.length, g.toEnd.get(st.station) ?? 0, st.next_leg, st.next_source, st.handoff_url, sha, observation);
    this.exec('DELETE FROM ticket_next_legs WHERE ticket_id = ?', id);
    for (const n of st.next) {
      const b = before.get(n.leg);
      // Age (the default order's fourth key) runs from the first snapshot that showed the leg
      // ready, and an unbroken wait from the first that showed it waiting.
      const readySince = n.state === 'ready' ? (b?.state === 'ready' ? b.ready_since : at) : null;
      const waitingSince = n.state === 'waiting' ? (b?.state === 'waiting' ? b.waiting_since : at) : null;
      this.exec('INSERT INTO ticket_next_legs (ticket_id, leg, state, waiting_on, ready_since, waiting_since) VALUES (?, ?, ?, ?, ?, ?)',
        id, n.leg, n.state, n.waiting_on, readySince, waitingSince);
    }
    this.exec('DELETE FROM ticket_bars WHERE ticket_id = ?', id);
    for (const [leg, tags] of Object.entries(st.bars)) for (const tag of tags) this.exec('INSERT OR IGNORE INTO ticket_bars (ticket_id, leg, tag) VALUES (?, ?, ?)', id, leg, tag);
  }

  private offGraph(repo: string, id: string, detail: Record<string, unknown>) {
    logEvent(this.c.store, this.c.now(), 'off-graph', 'sync', detail, id, null, repo);
  }
}
