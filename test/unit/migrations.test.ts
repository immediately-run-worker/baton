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

// R3-1231 part 2a — migration 0006 makes the one board docs' (BATON_SPEC §2a R-BTN-47, §4): a
// database at 0005 holding a board, a hold, a claim, an override, an adoption request, events and
// a message keeps every row, now under repository 'docs' with qualified ticket ids.
describe('migration 0006: one Baton, many repositories (R3-1231)', () => {
  const rewind = (sql: SqlStorage, upTo: number) => {
    sql.exec('PRAGMA foreign_keys = OFF');
    const objects = sql.exec("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND type = 'table'").toArray() as { name: string }[];
    for (const o of objects) sql.exec(`DROP TABLE IF EXISTS "${o.name}"`);
    for (const m of MIGRATIONS.filter((x) => x.id <= upTo)) sql.exec(m.sql);
    sql.exec('PRAGMA foreign_keys = ON');
  };

  it('moves the board, the cutover and every ticket id under docs', async () => {
    const id = env.BATON.idFromName('migrations-0006');
    await runInDurableObject(env.BATON.get(id), (_o: unknown, state: DurableObjectState) => {
      const sql = state.storage.sql;
      rewind(sql, 5);
      sql.exec(`INSERT INTO tickets (id, path, title, status, node, queue, tags, requires_clause, depends_on, blocked_by, repos, rank, snapshot_sha, row_hash)
                VALUES ('R3-9001', 'content/roadmap/R3-9001.mdx', 't', 'available', 'ready-autonomous', 'autonomous', '[]', 'listed', '["R3-9000"]', '[]', '[]', 1, 'aaa', 'h')`);
      sql.exec(`INSERT INTO ticket_requires (ticket_id, name) VALUES ('R3-9001', 'llm-call')`);
      sql.exec(`INSERT INTO claims (id, ticket_id, worker_id, request_id, nonce, snapshot_sha, claimed_at, status)
                VALUES (7, 'R3-9001', 1, 'req-1', 'abc123', 'aaa', 1000, 'active')`);
      sql.exec(`INSERT INTO ticket_overrides (ticket_id, hold, hold_reason, set_by, set_at) VALUES ('R3-9001', 1, 'owner', 'owner:x', 1000)`);
      sql.exec(`INSERT INTO adoptions (ticket_id, claim_id, worker_id, requested_at) VALUES ('R3-9001', 7, 1, 1000)`);
      sql.exec(`INSERT INTO board_head (id, sha) VALUES (1, 'aaa')`);
      sql.exec(`INSERT INTO board_snapshots (sha, parent_sha, received_at, ticket_count) VALUES ('aaa', NULL, 1000, 1)`);
      sql.exec(`INSERT INTO held_snapshots (sha, parent_sha, head_sha, ticket_count, received_at, auto_accept_at) VALUES ('bbb', 'zzz', 'aaa', 1, 1000, 2000)`);
      sql.exec(`INSERT INTO baton_settings (key, value) VALUES ('cutover_at', '900'), ('transcript_repos', '["immediately-run/claude-sessions"]'), ('min_skills_version', '3')`);
      sql.exec(`INSERT INTO events (at, kind, ticket_id, claim_id, actor) VALUES (1000, 'claimed', 'R3-9001', 7, 'worker:1')`);
      sql.exec(`INSERT INTO events (at, kind, actor, detail_json) VALUES (1001, 'cutover', 'owner:x', '{"imported":["R3-9001"]}')`);
      sql.exec(`INSERT INTO events (at, kind, actor, detail_json) VALUES (1002, 'rekeyed', 'admin', '{}')`);
      sql.exec(`INSERT INTO messages (id, kind, payload_json, from_principal, to_worker_id, sent_at, status)
                VALUES (3, 'release', '{"ticket_id":"R3-9001","reason":"stale-board"}', 'owner:x', 1, 1000, 'delivered')`);

      sql.exec(MIGRATIONS.find((x) => x.id === 6)!.sql);

      const all = (q: string) => sql.exec(q).toArray() as Record<string, unknown>[];
      expect(all('SELECT id, github, default_branch, cutover_at, transcript_repos FROM repositories')).toEqual([
        { id: 'docs', github: 'immediately-run/docs', default_branch: 'main', cutover_at: 900, transcript_repos: '["immediately-run/claude-sessions"]' }]);
      expect(all(`SELECT key FROM baton_settings ORDER BY key`)).toEqual([{ key: 'min_skills_version' }]);
      expect(all('SELECT repository_id, sha FROM board_head')).toEqual([{ repository_id: 'docs', sha: 'aaa' }]);
      expect(all('SELECT repository_id, sha FROM board_snapshots')).toEqual([{ repository_id: 'docs', sha: 'aaa' }]);
      expect(all('SELECT repository_id, sha, head_sha FROM held_snapshots')).toEqual([{ repository_id: 'docs', sha: 'bbb', head_sha: 'aaa' }]);
      // Dependencies stay local: they never leave their repository (R-BTN-47).
      expect(all('SELECT id, repository_id, local_id, depends_on FROM tickets')).toEqual([{ id: 'docs:R3-9001', repository_id: 'docs', local_id: 'R3-9001', depends_on: '["R3-9000"]' }]);
      expect(all('SELECT ticket_id FROM ticket_requires')).toEqual([{ ticket_id: 'docs:R3-9001' }]);
      expect(all('SELECT ticket_id FROM claims')).toEqual([{ ticket_id: 'docs:R3-9001' }]);
      expect(all('SELECT ticket_id FROM ticket_overrides')).toEqual([{ ticket_id: 'docs:R3-9001' }]);
      expect(all('SELECT ticket_id, claim_id FROM adoptions')).toEqual([{ ticket_id: 'docs:R3-9001', claim_id: 7 }]);
      expect(all('SELECT kind, ticket_id, repository_id, detail_json FROM events ORDER BY seq')).toEqual([
        { kind: 'claimed', ticket_id: 'docs:R3-9001', repository_id: 'docs', detail_json: null },
        { kind: 'cutover', ticket_id: null, repository_id: 'docs', detail_json: '{"imported":["docs:R3-9001"]}' },
        { kind: 'rekeyed', ticket_id: null, repository_id: null, detail_json: '{}' }]);
      expect(JSON.parse(all('SELECT payload_json FROM messages')[0].payload_json as string)).toEqual({ ticket_id: 'docs:R3-9001', reason: 'stale-board' });
      // The rebuilt keys bind: one local id per repository; the requires rows follow the renamed table.
      expect(() => sql.exec(`INSERT INTO tickets (id, repository_id, local_id, path, title, status, node, queue, tags, requires_clause, depends_on, blocked_by, repos, snapshot_sha, row_hash)
                              VALUES ('docs:other', 'docs', 'R3-9001', 'p', 't', 'available', 'blocked', 'autonomous', '[]', 'none', '[]', '[]', '[]', 'aaa', 'h')`)).toThrow(/UNIQUE/);
      expect(all(`SELECT "table", "from", "to", on_delete FROM pragma_foreign_key_list('ticket_requires')`)).toEqual([{ table: 'tickets', from: 'ticket_id', to: 'id', on_delete: 'CASCADE' }]);
      const names = (sql.exec("SELECT name FROM sqlite_master WHERE type = 'index'").toArray() as { name: string }[]).map((r) => r.name);
      for (const added of ['tickets_ready', 'events_by_repository']) expect(names).toContain(added);
    });
  });

  it('a fresh Baton gets no repository from the migration; the seed registers them', async () => {
    const id = env.BATON.idFromName('migrations-0006-fresh');
    await runInDurableObject(env.BATON.get(id), (_o: unknown, state: DurableObjectState) => {
      const sql = state.storage.sql;
      rewind(sql, 5);
      sql.exec(MIGRATIONS.find((x) => x.id === 6)!.sql);
      expect(sql.exec('SELECT count(*) AS n FROM repositories').toArray()).toEqual([{ n: 0 }]);
    });
  });
});

// R3-1231 part 2b — migration 0007 adds the course registry (R-BTN-48): a database at 0006 keeps
// its tickets, now roadmap-pr's, and loses the instance-wide min_skills_version.
describe('migration 0007: courses (R3-1231)', () => {
  it('adds the registry tables, names every ticket roadmap-pr and drops min_skills_version', async () => {
    const id = env.BATON.idFromName('migrations-0007');
    await runInDurableObject(env.BATON.get(id), (_o: unknown, state: DurableObjectState) => {
      const sql = state.storage.sql;
      sql.exec('PRAGMA foreign_keys = OFF');
      const objects = sql.exec("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND type = 'table'").toArray() as { name: string }[];
      for (const o of objects) sql.exec(`DROP TABLE IF EXISTS "${o.name}"`);
      for (const m of MIGRATIONS.filter((x) => x.id <= 6)) sql.exec(m.sql);
      sql.exec(`INSERT INTO repositories (id, github, default_branch, sync_workflow) VALUES ('docs', 'immediately-run/docs', 'main', '.github/workflows/baton-sync.yml')`);
      sql.exec(`INSERT INTO tickets (id, repository_id, local_id, path, title, status, node, queue, tags, requires_clause, depends_on, blocked_by, repos, snapshot_sha, row_hash)
                VALUES ('docs:R3-9001', 'docs', 'R3-9001', 'p', 't', 'available', 'blocked', 'autonomous', '[]', 'none', '[]', '[]', '[]', 'aaa', 'h')`);
      sql.exec(`INSERT INTO baton_settings (key, value) VALUES ('min_skills_version', '3'), ('reviewer_matrix', '{}')`);
      sql.exec(`INSERT INTO credentials (id, hostname, allowed_capabilities) VALUES ('vm-a', 'vm-a', '[]')`);
      sql.exec(`INSERT INTO workers (hostname, session_name, secret_hash, credential_id, harness, kind, tier_ceiling, lease_timeout_ms, settings_hash, first_seen_at, last_seen_at, skills_version)
                VALUES ('vm-a', 's', 'h', 'vm-a', 'opencode', 'vm', 'critical', 900000, '', 1, 1, 3)`);
      sql.exec(MIGRATIONS.find((x) => x.id === 7)!.sql);
      const all = (q: string) => sql.exec(q).toArray() as Record<string, unknown>[];
      expect(all('SELECT id, course_id FROM tickets')).toEqual([{ id: 'docs:R3-9001', course_id: 'roadmap-pr' }]);
      expect(all('SELECT key FROM baton_settings')).toEqual([{ key: 'reviewer_matrix' }]);
      // The worker keeps its row; its version is per course now.
      expect(all('SELECT hostname, session_name FROM workers')).toEqual([{ hostname: 'vm-a', session_name: 's' }]);
      expect(all(`SELECT name FROM pragma_table_info('workers') WHERE name = 'skills_version'`)).toEqual([]);
      for (const t of ['courses', 'course_refusals', 'worker_courses']) expect(all(`SELECT count(*) AS n FROM ${t}`)).toEqual([{ n: 0 }]);
    });
  });
});

// R3-1231 part 3 — migration 0008 adds the observation counter (R-BTN-62): a board at 0007 starts
// at 0 with nothing outstanding, and claims made before it are judged by any reading.
describe('migration 0008: observations (R3-1231)', () => {
  it('adds the counter to each board head and the numbers to claims and holds', async () => {
    const id = env.BATON.idFromName('migrations-0008');
    await runInDurableObject(env.BATON.get(id), (_o: unknown, state: DurableObjectState) => {
      const sql = state.storage.sql;
      sql.exec('PRAGMA foreign_keys = OFF');
      const objects = sql.exec("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND type = 'table'").toArray() as { name: string }[];
      for (const o of objects) sql.exec(`DROP TABLE IF EXISTS "${o.name}"`);
      for (const m of MIGRATIONS.filter((x) => x.id <= 7)) sql.exec(m.sql);
      sql.exec(`INSERT INTO repositories (id, github, default_branch, sync_workflow) VALUES ('docs', 'immediately-run/docs', 'main', '.github/workflows/baton-sync.yml')`);
      sql.exec(`INSERT INTO board_head (repository_id, sha) VALUES ('docs', 'aaa')`);
      sql.exec(`INSERT INTO claims (id, ticket_id, worker_id, request_id, nonce, snapshot_sha, claimed_at, status) VALUES (7, 'docs:R3-9001', 1, 'r', 'abc123', 'aaa', 1, 'active')`);
      sql.exec(MIGRATIONS.find((x) => x.id === 8)!.sql);
      const all = (q: string) => sql.exec(q).toArray() as Record<string, unknown>[];
      expect(all('SELECT sha, observation, last_handed_out, handed_out_at FROM board_head')).toEqual([{ sha: 'aaa', observation: 0, last_handed_out: 0, handed_out_at: null }]);
      expect(all('SELECT claim_observation, end_observation FROM claims')).toEqual([{ claim_observation: 0, end_observation: null }]);
      expect(all(`SELECT name FROM pragma_table_info('held_snapshots') WHERE name = 'observation'`)).toEqual([{ name: 'observation' }]);
    });
  });

  it('gives a board head to a repository 0006 created without one (round 1, 1-A-2)', async () => {
    const id = env.BATON.idFromName('migrations-0008-headless');
    await runInDurableObject(env.BATON.get(id), (_o: unknown, state: DurableObjectState) => {
      const sql = state.storage.sql;
      sql.exec('PRAGMA foreign_keys = OFF');
      const objects = sql.exec("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND type = 'table'").toArray() as { name: string }[];
      for (const o of objects) sql.exec(`DROP TABLE IF EXISTS "${o.name}"`);
      for (const m of MIGRATIONS.filter((x) => x.id <= 5)) sql.exec(m.sql);
      sql.exec(`INSERT INTO baton_settings (key, value) VALUES ('cutover_at', '900')`); // a cutover, no board yet
      for (const m of MIGRATIONS.filter((x) => x.id >= 6 && x.id <= 8)) sql.exec(m.sql);
      const all = (q: string) => sql.exec(q).toArray() as Record<string, unknown>[];
      expect(all('SELECT id FROM repositories')).toEqual([{ id: 'docs' }]);
      expect(all('SELECT repository_id, sha, observation, last_handed_out FROM board_head')).toEqual([{ repository_id: 'docs', sha: null, observation: 0, last_handed_out: 0 }]);
    });
  });
});
