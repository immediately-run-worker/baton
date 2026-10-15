// R3-1230 — migration 0005 renames work items to tickets in place (BATON_SPEC §2a, §4, §15):
// a database at 0004 holding a claim, an override, a requires row, an event and a message keeps
// every row, and the JSON keys stored in them, under the new names, and the renamed indexes still bind.
import { describe, it, expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { MIGRATIONS } from '../../src/migrations';

describe('migration 0005: work items become tickets (R3-1230)', () => {
  it('keeps every row under the new names', async () => {
    const id = env.BATON.idFromName('migrations-0005');
    await runInDurableObject(env.BATON.get(id), (_o: unknown, state: DurableObjectState) => {
      const sql = state.storage.sql;
      // Rewind this object to an empty schema, then build it to 0004 as a deployed Baton was.
      sql.exec('PRAGMA foreign_keys = OFF');
      const objects = sql.exec("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND type IN ('table','index')").toArray() as { type: string; name: string }[];
      for (const o of objects.filter((x) => x.type === 'table')) sql.exec(`DROP TABLE IF EXISTS "${o.name}"`);
      for (const m of MIGRATIONS.filter((x) => x.id <= 4)) sql.exec(m.sql);

      sql.exec(`INSERT INTO work_items (id, path, title, status, node, queue, tags, requires_clause, depends_on, blocked_by, repos, snapshot_sha, row_hash)
                VALUES ('R3-9001', 'content/roadmap/R3-9001.mdx', 't', 'in-progress', 'blocked', 'autonomous', '[]', 'listed', '[]', '[]', '[]', 'aaa', 'h')`);
      sql.exec(`INSERT INTO work_item_requires (work_item_id, name) VALUES ('R3-9001', 'llm-call')`);
      sql.exec(`INSERT INTO work_item_claims (id, work_item_id, worker_id, request_id, nonce, snapshot_sha, claimed_at, status)
                VALUES (7, 'R3-9001', 1, 'req-1', 'abc123', 'aaa', 1000, 'active')`);
      sql.exec(`INSERT INTO item_overrides (work_item_id, hold, hold_reason, set_by, set_at) VALUES ('R3-9001', 1, 'owner', 'owner:x', 1000)`);
      sql.exec(`INSERT INTO events (at, kind, work_item_id, claim_id, actor) VALUES (1000, 'claimed', 'R3-9001', 7, 'worker:1')`);
      sql.exec(`INSERT INTO board_snapshots (sha, parent_sha, received_at, item_count) VALUES ('aaa', NULL, 1000, 1)`);
      sql.exec(`INSERT INTO messages (id, kind, payload_json, from_principal, to_worker_id, sent_at, status)
                VALUES (3, 'release', '{"work_item_id":"R3-9001","reason":"stale-board"}', 'owner:x', 1, 1000, 'delivered')`);
      sql.exec(`INSERT INTO events (at, kind, actor, detail_json) VALUES (1001, 'snapshot-accepted', 'sync', '{"sha":"aaa","item_count":1}')`);

      sql.exec(MIGRATIONS.find((x) => x.id === 5)!.sql);

      const one = (q: string) => sql.exec(q).toArray()[0] as Record<string, unknown>;
      expect(one("SELECT id, title FROM tickets")).toEqual({ id: 'R3-9001', title: 't' });
      expect(one("SELECT ticket_id, name FROM ticket_requires")).toEqual({ ticket_id: 'R3-9001', name: 'llm-call' });
      expect(one("SELECT id, ticket_id, status FROM claims")).toEqual({ id: 7, ticket_id: 'R3-9001', status: 'active' });
      expect(one("SELECT ticket_id, hold_reason FROM ticket_overrides")).toEqual({ ticket_id: 'R3-9001', hold_reason: 'owner' });
      expect(one("SELECT ticket_id, claim_id FROM events")).toEqual({ ticket_id: 'R3-9001', claim_id: 7 });
      expect(one("SELECT ticket_count FROM board_snapshots")).toEqual({ ticket_count: 1 });
      // JSON already stored under the old keys reads under the new ones (review gate round 1, 1-B-0).
      expect(JSON.parse(one("SELECT payload_json FROM messages WHERE id = 3").payload_json as string)).toEqual({ ticket_id: 'R3-9001', reason: 'stale-board' });
      expect(one("SELECT count(*) AS n FROM messages m JOIN claims c ON c.ticket_id = json_extract(m.payload_json, '$.ticket_id')")).toEqual({ n: 1 });
      expect(JSON.parse(one("SELECT detail_json FROM events WHERE kind = 'snapshot-accepted'").detail_json as string)).toEqual({ sha: 'aaa', ticket_count: 1 });
      const names = (sql.exec("SELECT name FROM sqlite_master WHERE type IN ('table','index')").toArray() as { name: string }[]).map((r) => r.name);
      for (const gone of ['work_items', 'work_item_claims', 'item_overrides', 'work_item_requires', 'one_active_claim_per_item', 'work_items_ready', 'events_by_item']) {
        expect(names).not.toContain(gone);
      }
      for (const added of ['one_active_claim_per_ticket', 'tickets_ready', 'events_by_ticket']) expect(names).toContain(added);
      // The renamed unique index still binds: a second active claim on the ticket is refused.
      expect(() => sql.exec(`INSERT INTO claims (id, ticket_id, worker_id, request_id, nonce, snapshot_sha, claimed_at, status)
                              VALUES (8, 'R3-9001', 2, 'req-2', 'def456', 'aaa', 1001, 'active')`)).toThrow(/UNIQUE/);
    });
  });
});
