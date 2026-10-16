-- 0014_admin.sql — R3-1240 (BATON_SPEC §10.6 R-BTN-57/-58, R-BTN-66/-67, R-BTN-16, §4): the
-- administration Baton keeps in SQLite, out of agents' reach — repositories' owner keys, worker
-- grants per repository, owner bars, the owners' settings, and the dashboard's one-time links
-- and sessions. Administrators are BATON_ADMIN_KEYS alone; nothing here adds one.

CREATE TABLE repository_owners (                 -- R-BTN-58: owner keys per repository
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  public_key    TEXT NOT NULL,                   -- `<type> <base64>`, one of R-BTN-13's key types
  fingerprint   TEXT NOT NULL,                   -- 'SHA256:…', the signer's keyid (spec-silent: kept so a signed
                                                 -- request finds its owner key without parsing every key)
  added_by      TEXT NOT NULL,                   -- 'admin:<fingerprint>' or 'owner:<fingerprint>'
  added_at      INTEGER NOT NULL,
  removed_at    INTEGER,
  revoked_at    INTEGER,                         -- an administrator's revoke (spec-silent): never re-added
  PRIMARY KEY (repository_id, public_key)
);
CREATE INDEX owners_by_fingerprint ON repository_owners (fingerprint) WHERE removed_at IS NULL;

CREATE TABLE worker_grants (                     -- R-BTN-58: which repositories a worker key may work on, and with what
  credential_id TEXT NOT NULL REFERENCES credentials(id),
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  capabilities  TEXT NOT NULL DEFAULT '[]',      -- JSON, expanded; 'human-operator' only in a grant an administrator made
  max_tier      INTEGER,                         -- the highest position in the repository's `tiers` it may take; NULL: any
  granted_by    TEXT NOT NULL,                   -- 'owner:<fingerprint>' or 'admin:<fingerprint>'
  granted_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  PRIMARY KEY (credential_id, repository_id)
);

CREATE TABLE owner_bars (                        -- R-BTN-67: tags barred by a repository's owners, never by git
  id            INTEGER PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  course        TEXT NOT NULL,                   -- a course id of the repository, or '*' for every course
  tag           TEXT NOT NULL,
  legs          TEXT NOT NULL DEFAULT '[]',      -- JSON leg names of that course's file, only with a named course; [] every leg
  applies       TEXT NOT NULL CHECK (applies IN ('claim','claim+advance')),
  starts_at     INTEGER NOT NULL,
  ends_at       INTEGER,                         -- NULL: until lifted
  release_holders INTEGER NOT NULL DEFAULT 0,
  reason        TEXT NOT NULL,                   -- the release reason (`released:<reason>`) and the dashboard's label
  set_by        TEXT NOT NULL,                   -- 'owner:<fingerprint>' or 'admin:<fingerprint>'
  lifted_at     INTEGER,
  holders_released_at INTEGER                    -- spec-silent: when the alarm sent its releases, so it sends them once
);
CREATE INDEX owner_bars_by_repository ON owner_bars (repository_id) WHERE lifted_at IS NULL;

CREATE TABLE login_links (                       -- R-BTN-57: one-time dashboard links
  token_hash    TEXT PRIMARY KEY,                -- SHA-256 of the 256-bit token in the link's fragment
  admin_key     TEXT NOT NULL,                   -- the fingerprint of the administrator key that minted it
  expires_at    INTEGER NOT NULL,                -- minted + 5 minutes
  used_at       INTEGER
);
CREATE TABLE dashboard_sessions (                -- R-BTN-57, R-BTN-16: the cookie's server side
  id_hash       TEXT PRIMARY KEY,                -- SHA-256 of the cookie value
  admin_key     TEXT NOT NULL,                   -- valid only while this key is still in BATON_ADMIN_KEYS
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,                -- created + 12 hours
  revoked_at    INTEGER
);

-- The owners' settings (R-BTN-66): `transcript_repos` and `unblocked_trigger` exist already.
ALTER TABLE repositories ADD COLUMN retry TEXT;                              -- {backoff_ms: [..], max_failed}; NULL the default
ALTER TABLE repositories ADD COLUMN required_bars TEXT NOT NULL DEFAULT '[]'; -- [{course, leg, except?, tag_prefix}]

-- A key's label for people, and a probe's instances (R-BTN-53; read by R3-1251).
ALTER TABLE credentials ADD COLUMN label TEXT;
ALTER TABLE credentials ADD COLUMN allowed_instances TEXT NOT NULL DEFAULT '[]';
ALTER TABLE credentials ADD COLUMN revoked_by TEXT;           -- 'admin:<fingerprint>' when an administrator revoked it (spec-silent): a
                                                         -- later CREDENTIALS/TOKEN_HASHES edit never un-revokes it

-- The event log gains `admin` (every administrator's and owner's act). Nothing references
-- `events`, so it is rebuilt with the wider check, every row and its seq carried over.
CREATE TABLE events_0014 (
  seq           INTEGER PRIMARY KEY,
  at            INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('claimed','completed','confirmed',
                  'released','reaped','fence-cleared','adopted','rekeyed','override',
                  'suspension','reviewer-substituted','attempts-exhausted','held','cutover',
                  'snapshot-rejected','snapshot-accepted','shadow-conflict','foreign-claim',
                  'advanced','advice-overridden','off-graph','bars-mismatch','regressed','admin')),
  ticket_id     TEXT,
  claim_id      INTEGER REFERENCES claims(id),
  actor         TEXT NOT NULL,
  detail_json   TEXT,
  repository_id TEXT
);
INSERT INTO events_0014 (seq, at, kind, ticket_id, claim_id, actor, detail_json, repository_id)
  SELECT seq, at, kind, ticket_id, claim_id, actor, detail_json, repository_id FROM events;
DROP TABLE events;
ALTER TABLE events_0014 RENAME TO events;
CREATE INDEX events_by_ticket ON events(ticket_id, kind, seq);
CREATE INDEX events_by_claim ON events(claim_id, kind, seq);
CREATE INDEX events_by_repository ON events(repository_id, seq);
