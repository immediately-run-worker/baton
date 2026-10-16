-- 0012_forges.sql — R3-1262 (BATON_SPEC §2k R-BTN-92–R-BTN-94, §4): a repository is a forge path, a
-- remote and a forge; its sync authenticates by a sync key or a CI identity token. Columns are
-- added, never rebuilt: `github` (the forge path) keeps its UNIQUE and `sync_workflow` its NOT NULL
-- ('' for none), because a migration cannot rebuild a table others reference with foreign keys on.
ALTER TABLE repositories ADD COLUMN forge TEXT NOT NULL DEFAULT 'github' CHECK (forge IN ('github','gitlab','gitea','git'));
ALTER TABLE repositories ADD COLUMN remote TEXT NOT NULL DEFAULT '';
ALTER TABLE repositories ADD COLUMN web_base TEXT;
ALTER TABLE repositories ADD COLUMN ci_identity TEXT;
ALTER TABLE repositories ADD COLUMN dispatch TEXT;
ALTER TABLE repositories ADD COLUMN unblocked_trigger TEXT;
ALTER TABLE repositories ADD COLUMN sync_wanted_at INTEGER;
ALTER TABLE repositories ADD COLUMN sync_wanted_after INTEGER;

-- Every repository Baton knew was on GitHub, posting by Actions OIDC and dispatched by the App.
UPDATE repositories SET
  remote = 'https://github.com/' || github || '.git',
  web_base = 'https://github.com/' || github,
  ci_identity = CASE WHEN sync_workflow != '' THEN '{"kind":"github-actions"}' END,
  dispatch = '{"kind":"github-app"}';

-- R-BTN-93: a sync key serves one repository in one role. One role per key across this table,
-- `credentials` and BATON_ADMIN_KEYS is enforced where a key is added (src/core/registry.ts).
CREATE TABLE sync_keys (
  fingerprint   TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  role          TEXT NOT NULL CHECK (role IN ('sync','mirror')),
  public_key    TEXT NOT NULL UNIQUE,
  added_by      TEXT NOT NULL,
  added_at      INTEGER NOT NULL,
  revoked_at    INTEGER
);
CREATE INDEX sync_keys_repository ON sync_keys (repository_id);
