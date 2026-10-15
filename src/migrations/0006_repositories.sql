-- 0006_repositories.sql — R3-1231 part 2a (BATON_SPEC §2a R-BTN-47, §4, §7.1 R-BTN-11, §10.3
-- R-BTN-15, R-BTN-28). One Baton, many registered repositories: each has its own board head,
-- snapshots, holds and cutover, and every ticket is known by a qualified id, '<repository>:<local>'.
--
-- A Baton that already holds data held exactly one board, docs', so its rows become repository
-- 'docs' with qualified ids. A fresh Baton gets no repository here: the BATON_REPOSITORIES seed
-- registers them at start (src/core/registry.ts). The spec's other repository columns arrive with
-- their items: retry and required_bars (R3-1240), mirror_acked_seq (R3-1220's seal),
-- unblocked_workflow (R3-1251), remind_after_s (R3-1249), artifact_buckets (R3-1257); the
-- observation counter with part 3 of this item.
--
-- Rebuilt rather than updated in place where an id is a key: the migration runs in one
-- transaction with foreign keys on, so the child table is copied first and nothing cascades.

CREATE TABLE repositories (
  id               TEXT PRIMARY KEY,                -- 'docs'; `^[a-z][a-z0-9-]{0,39}$` (R-BTN-47)
  github           TEXT NOT NULL UNIQUE COLLATE NOCASE,  -- 'immediately-run/docs'
  default_branch   TEXT NOT NULL,                   -- 'main'
  sync_workflow    TEXT NOT NULL,                   -- '.github/workflows/baton-sync.yml' (R-BTN-15)
  mirror_workflow  TEXT,                            -- NULL: this repository has no git mirror
  weight           INTEGER NOT NULL DEFAULT 100,    -- cross-repository priority (R-BTN-47, R-BTN-61)
  transcript_repos TEXT NOT NULL DEFAULT '[]',      -- JSON (§6.8, R-BTN-66)
  tiers            TEXT NOT NULL DEFAULT '["routine","judgement","critical"]',  -- lowest first (R-BTN-66)
  cutover_at       INTEGER,                         -- one-way (R-BTN-28)
  retired_at       INTEGER
);

-- The existing board, if any, was docs'.
INSERT INTO repositories (id, github, default_branch, sync_workflow, mirror_workflow, transcript_repos, cutover_at)
SELECT 'docs', 'immediately-run/docs', 'main', '.github/workflows/baton-sync.yml', '.github/workflows/baton-mirror.yml',
       COALESCE((SELECT value FROM baton_settings WHERE key = 'transcript_repos'),
                '["immediately-run/claude-sessions","immediately-run-worker/session-transcripts"]'),
       (SELECT CAST(value AS INTEGER) FROM baton_settings WHERE key = 'cutover_at')
WHERE EXISTS (SELECT 1 FROM board_head) OR EXISTS (SELECT 1 FROM tickets) OR EXISTS (SELECT 1 FROM claims)
   OR EXISTS (SELECT 1 FROM ticket_overrides) OR EXISTS (SELECT 1 FROM held_snapshots)
   OR EXISTS (SELECT 1 FROM baton_settings WHERE key IN ('cutover_at', 'transcript_repos'));
DELETE FROM baton_settings WHERE key IN ('cutover_at', 'transcript_repos');

-- The board, per repository (§7.1). sha is NULL until the repository's first snapshot.
CREATE TABLE board_head_0006 (
  repository_id TEXT PRIMARY KEY REFERENCES repositories(id),
  sha           TEXT
);
INSERT INTO board_head_0006 (repository_id, sha) SELECT 'docs', sha FROM board_head;
DROP TABLE board_head;
ALTER TABLE board_head_0006 RENAME TO board_head;

CREATE TABLE board_snapshots_0006 (
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  sha           TEXT NOT NULL,
  parent_sha    TEXT,
  received_at   INTEGER NOT NULL,
  ticket_count  INTEGER NOT NULL,
  PRIMARY KEY (repository_id, sha)
);
INSERT INTO board_snapshots_0006 SELECT 'docs', sha, parent_sha, received_at, ticket_count FROM board_snapshots;
DROP TABLE board_snapshots;
ALTER TABLE board_snapshots_0006 RENAME TO board_snapshots;

CREATE TABLE held_snapshots_0006 (
  repository_id  TEXT NOT NULL REFERENCES repositories(id),
  sha            TEXT NOT NULL,
  parent_sha     TEXT,
  head_sha       TEXT,
  ticket_count   INTEGER NOT NULL,
  received_at    INTEGER NOT NULL,
  auto_accept_at INTEGER NOT NULL,
  accepted_at    INTEGER,
  PRIMARY KEY (repository_id, sha)
);
INSERT INTO held_snapshots_0006 SELECT 'docs', sha, parent_sha, head_sha, ticket_count, received_at, auto_accept_at, accepted_at FROM held_snapshots;
DROP TABLE held_snapshots;
ALTER TABLE held_snapshots_0006 RENAME TO held_snapshots;

-- Tickets: a qualified id, its repository and its local id. depends_on and blocked_by keep
-- local ids: dependencies stay within one repository in v1 (R-BTN-47).
CREATE TABLE tickets_0006 (
  id              TEXT PRIMARY KEY,                -- 'docs:R3-1205'
  repository_id   TEXT NOT NULL REFERENCES repositories(id),
  local_id        TEXT NOT NULL,                   -- 'R3-1205'
  path            TEXT NOT NULL,
  title           TEXT NOT NULL,
  project         TEXT,
  status          TEXT NOT NULL,
  node            TEXT NOT NULL,
  queue           TEXT NOT NULL,
  tags            TEXT NOT NULL,
  tier            TEXT,
  requires_clause TEXT NOT NULL CHECK (requires_clause IN ('absent','none','listed')),
  operator_only   INTEGER NOT NULL DEFAULT 0,
  depends_on      TEXT NOT NULL,
  blocked_by      TEXT NOT NULL,
  repos           TEXT NOT NULL,
  ord             TEXT,
  rank            INTEGER,
  snapshot_sha    TEXT NOT NULL,
  row_hash        TEXT NOT NULL,
  since           TEXT,
  holder          TEXT,
  UNIQUE (repository_id, local_id)
);
INSERT INTO tickets_0006 (id, repository_id, local_id, path, title, project, status, node, queue, tags, tier, requires_clause,
                          operator_only, depends_on, blocked_by, repos, ord, rank, snapshot_sha, row_hash, since, holder)
SELECT 'docs:' || id, 'docs', id, path, title, project, status, node, queue, tags, tier, requires_clause,
       operator_only, depends_on, blocked_by, repos, ord, rank, snapshot_sha, row_hash, since, holder
FROM tickets;
CREATE TABLE ticket_requires_0006 (
  ticket_id TEXT NOT NULL REFERENCES tickets_0006(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  PRIMARY KEY (ticket_id, name)
);
INSERT INTO ticket_requires_0006 SELECT 'docs:' || ticket_id, name FROM ticket_requires;
DROP TABLE ticket_requires;
DROP TABLE tickets;
ALTER TABLE tickets_0006 RENAME TO tickets;                  -- rewrites ticket_requires_0006's reference
ALTER TABLE ticket_requires_0006 RENAME TO ticket_requires;
CREATE INDEX tickets_ready ON tickets(rank) WHERE node LIKE 'ready-%';

-- Every other ticket_id column, qualified in place (none is a foreign-key parent).
UPDATE claims           SET ticket_id = 'docs:' || ticket_id WHERE instr(ticket_id, ':') = 0;
UPDATE ticket_overrides SET ticket_id = 'docs:' || ticket_id WHERE instr(ticket_id, ':') = 0;
UPDATE adoptions        SET ticket_id = 'docs:' || ticket_id WHERE instr(ticket_id, ':') = 0;

-- The event log, per repository; instance events (a re-key, a suspension) keep NULL.
ALTER TABLE events ADD COLUMN repository_id TEXT;
UPDATE events SET repository_id = 'docs'
  WHERE ticket_id IS NOT NULL OR kind IN ('snapshot-accepted', 'snapshot-rejected', 'cutover', 'shadow-conflict', 'foreign-claim');
UPDATE events SET ticket_id = 'docs:' || ticket_id WHERE ticket_id IS NOT NULL AND instr(ticket_id, ':') = 0;
CREATE INDEX events_by_repository ON events(repository_id, seq);

-- Ticket ids inside stored JSON.
UPDATE messages SET payload_json = json_set(payload_json, '$.ticket_id', 'docs:' || json_extract(payload_json, '$.ticket_id'))
  WHERE json_valid(payload_json) AND json_type(payload_json, '$.ticket_id') = 'text'
    AND instr(json_extract(payload_json, '$.ticket_id'), ':') = 0;
UPDATE events SET detail_json = json_set(detail_json, '$.ticket_id', 'docs:' || json_extract(detail_json, '$.ticket_id'))
  WHERE json_valid(detail_json) AND json_type(detail_json, '$.ticket_id') = 'text'
    AND instr(json_extract(detail_json, '$.ticket_id'), ':') = 0;
UPDATE events SET detail_json = json_set(detail_json, '$.imported',
         json((SELECT json_group_array(CASE WHEN instr(value, ':') = 0 THEN 'docs:' || value ELSE value END)
               FROM json_each(events.detail_json, '$.imported'))))
  WHERE kind = 'cutover' AND json_valid(detail_json) AND json_type(detail_json, '$.imported') = 'array';
