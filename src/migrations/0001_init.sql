-- 0001_init.sql — every BATON_SPEC §4 table (docs content/specs/BATON_SPEC.mdx, as amended by
-- docs#204: work_items.operator_only, reviewer_agents.models). Taken verbatim from the spec's
-- §4 block; the additions after it are marked. Times are UTC epoch milliseconds.

-- Reference data (§7.3): written only by the board sync.
CREATE TABLE model_providers (
  id                 TEXT PRIMARY KEY,           -- one subscription account: 'opencode_go_plus'
  name               TEXT NOT NULL,
  billing            TEXT NOT NULL CHECK (billing IN ('subscription','api')),
  window_limits_json TEXT                        -- {"5h":0.2,"week":0.5,"month":1.0} or NULL
);
CREATE TABLE peak_schedules (
  id         TEXT PRIMARY KEY,
  rules_json TEXT NOT NULL,                      -- {"days":[1,2,3,4,5],"hoursUtc":[[1,4],[6,10]]}
  factor     REAL NOT NULL
);
CREATE TABLE provider_models (
  provider_id       TEXT NOT NULL REFERENCES model_providers(id),
  model_id          TEXT NOT NULL,               -- the harness's id: 'opencode-go/qwen3.8-max'
  input_per_m REAL, output_per_m REAL, cache_read_per_m REAL, cache_write_per_m REAL,
  monthly_limit_usd REAL,
  peak_schedule_id  TEXT REFERENCES peak_schedules(id),
  PRIMARY KEY (provider_id, model_id)
);

-- Credentials (§10.1). Token hashes live in Worker secrets; this table holds their policy.
CREATE TABLE credentials (                       -- includes a 'legacy' row with no token (§13)
  id                   TEXT PRIMARY KEY,         -- 'vm-fc-bering-0', 'owner-mac', 'cloud-env'
  hostname             TEXT NOT NULL,            -- the only hostname it may register
  allowed_capabilities TEXT NOT NULL,            -- JSON array: the most it may declare
  revoked_at           INTEGER
);

-- Workers (§5): created on first contact, never deleted; liveness is computed.
CREATE TABLE workers (
  id               INTEGER PRIMARY KEY,
  hostname         TEXT NOT NULL,
  session_name     TEXT NOT NULL CHECK (length(session_name) BETWEEN 1 AND 128),
  secret_hash      TEXT NOT NULL,                -- §10.2: SHA-256 of the sidecar-generated secret
  incarnation      INTEGER NOT NULL DEFAULT 1,   -- bumped by a re-key (§10.2)
  credential_id    TEXT NOT NULL REFERENCES credentials(id),
  harness          TEXT NOT NULL CHECK (harness IN ('opencode','claude-code')),
  kind             TEXT NOT NULL CHECK (kind IN ('vm','local','cloud','legacy')),
  model_id         TEXT,
  model_provider_id TEXT REFERENCES model_providers(id),   -- the account the coding model bills (§7.4)
  skills_version   INTEGER NOT NULL DEFAULT 0,   -- §5: the baton.json skills_version its skills were loaded at
  tier_ceiling     TEXT NOT NULL CHECK (tier_ceiling IN ('routine','judgement','critical')),
  lease_timeout_ms INTEGER NOT NULL
                   CHECK (kind = 'legacy' OR lease_timeout_ms BETWEEN 900000 AND 86400000),
  settings_hash    TEXT NOT NULL,                -- of capabilities + providers + settings
  first_seen_at    INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL,             -- last authenticated call
  last_activity_at INTEGER,                      -- harness activity (display only)
  reaped_at        INTEGER,                      -- set when §6.6 fires; cleared by a re-key
  UNIQUE (hostname, session_name)
);
CREATE TABLE worker_capabilities (
  worker_id  INTEGER NOT NULL REFERENCES workers(id),
  capability TEXT NOT NULL,                      -- expanded, ⊆ the credential's allow-list
  declared   TEXT NOT NULL,
  PRIMARY KEY (worker_id, capability)
);
CREATE TABLE worker_providers (                 -- exactly one account per harness prefix (§7.4)
  worker_id   INTEGER NOT NULL REFERENCES workers(id),
  prefix      TEXT NOT NULL,                     -- the harness provider prefix: 'opencode-go'
  provider_id TEXT NOT NULL REFERENCES model_providers(id),
  PRIMARY KEY (worker_id, prefix)
);

-- Claims (§6). Rows are kept forever.
CREATE TABLE work_item_claims (
  id               INTEGER PRIMARY KEY,
  work_item_id     TEXT NOT NULL,
  worker_id        INTEGER NOT NULL REFERENCES workers(id),
  request_id       TEXT NOT NULL UNIQUE,         -- §6.2 idempotency key
  nonce            TEXT NOT NULL,                -- 6 hex: the mirror's `(claim <nonce>…)` note
  reap_after       INTEGER,                      -- legacy claims only (§13): claim-note date + 7 days
  snapshot_sha     TEXT NOT NULL,                -- the board the claim was decided on
  claimed_at       INTEGER NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('active','completed','released','reaped')),
  ended_at         INTEGER,
  end_reason       TEXT,                         -- §6.5 vocabulary
  ended_at_sha     TEXT,
  confirmed_at     INTEGER,                      -- §6.7
  fence_pending    INTEGER NOT NULL DEFAULT 0,   -- §6.6: reaped while its worker was alive
  failed_attempt   INTEGER NOT NULL DEFAULT 0,   -- §6.10: this end counts against the item
  resume_json      TEXT,                         -- §6.11: the resume record written at the end
  CHECK ((status = 'active') = (ended_at IS NULL)),
  CHECK ((status = 'completed') = (ended_at_sha IS NOT NULL)),
  CHECK (confirmed_at IS NULL OR status = 'completed')
);
CREATE UNIQUE INDEX one_active_claim_per_item   ON work_item_claims(work_item_id) WHERE status = 'active';
CREATE UNIQUE INDEX one_active_claim_per_worker ON work_item_claims(worker_id)    WHERE status = 'active';
  -- (a legacy worker is created per imported item, §13, so this index holds for them too)
CREATE INDEX claims_unconfirmed ON work_item_claims(work_item_id) WHERE status = 'completed' AND confirmed_at IS NULL;

-- Item overrides (§8).
CREATE TABLE item_overrides (
  work_item_id TEXT PRIMARY KEY,
  expedite     INTEGER NOT NULL DEFAULT 0,
  hold         INTEGER NOT NULL DEFAULT 0,
  hold_reason  TEXT,                         -- 'owner', 'attempts-exhausted', 'non-retryable:<class>', 'review-capacity'
  retry_after  INTEGER,                      -- §6.10 backoff: not claimable before this
  set_by       TEXT NOT NULL,
  set_at       INTEGER NOT NULL
);

-- The append-only event log: claims and overrides (§12 reads it; the dashboard draws it).
CREATE TABLE events (
  seq          INTEGER PRIMARY KEY,              -- the mirror's cursor
  at           INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('claimed','completed','confirmed',
                 'released','reaped','fence-cleared','adopted','rekeyed','override',
                 'suspension','reviewer-substituted','attempts-exhausted','held','cutover',
                 'snapshot-rejected','snapshot-accepted','shadow-conflict','foreign-claim')),
  work_item_id TEXT,
  claim_id     INTEGER REFERENCES work_item_claims(id),
  actor        TEXT NOT NULL,                    -- 'worker:<id>', 'owner:<email>', 'alarm', 'sync'
  detail_json  TEXT
);

-- Activities (§6.9): what a worker is doing under its claim, for the timeline.
CREATE TABLE activities (
  worker_id   INTEGER NOT NULL REFERENCES workers(id),
  id          TEXT NOT NULL,              -- client-generated, unique per worker (idempotent retries)
  claim_id    INTEGER REFERENCES work_item_claims(id),   -- NULL only for 'orient' before a claim
  parent_id   TEXT,                       -- a reviewer's review round: same worker, same claim
  call_id     TEXT,                       -- hook activities: the harness's tool-call id
  kind        TEXT NOT NULL CHECK (kind IN ('orient','implement','local-verify','open-pr',
                'push','ci-wait','review-round','reviewer','fix-findings','adjudicate',
                'merge','reconcile','status-write','decision-packet','other')),
  seq         INTEGER,                    -- the round number, for review-round
  label       TEXT,                       -- short human text: 'review-pr-deepseek (deepseek-v4-pro)'
  source      TEXT NOT NULL CHECK (source IN ('skill','hook')),
  started_at  INTEGER NOT NULL,           -- worker clock
  ended_at    INTEGER,
  outcome     TEXT CHECK (outcome IN ('succeeded','failed','cancelled','abandoned')),
  received_at INTEGER NOT NULL,           -- server clock
  detail_json TEXT,                       -- bounded (§10.4): PR URL, finding counts, exit code
  PRIMARY KEY (worker_id, id),
  UNIQUE (worker_id, call_id),
  CHECK ((ended_at IS NULL) = (outcome IS NULL)),
  CHECK (claim_id IS NOT NULL OR kind = 'orient')
);
CREATE INDEX activities_by_claim ON activities(claim_id, started_at);
CREATE INDEX activities_open ON activities(worker_id) WHERE ended_at IS NULL;

-- Transcripts (§6.8): where the session's archived transcript lives in git.
CREATE TABLE transcripts (
  id          INTEGER PRIMARY KEY,
  worker_id   INTEGER NOT NULL REFERENCES workers(id),
  claim_id    INTEGER NOT NULL REFERENCES work_item_claims(id),
  repo        TEXT NOT NULL,              -- 'immediately-run/claude-sessions'; from the allow-list
  path        TEXT NOT NULL,              -- 'claude-code/2026-10-13-<session>.jsonl'
  role        TEXT NOT NULL CHECK (role IN ('session','subagent')),
  activity_id TEXT,                       -- a subagent's: the (same worker's) activity that ran it
  first_seen_at INTEGER NOT NULL,
  last_pushed_at INTEGER,                 -- the archiver's last successful push, if reported
  UNIQUE (worker_id, repo, path, claim_id)
);

-- Messages (§9).
CREATE TABLE messages (
  id              INTEGER PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('release','status_request','status_report')),
  payload_json    TEXT,
  from_worker_id  INTEGER REFERENCES workers(id),
  from_principal  TEXT,                          -- 'owner:<email>'
  to_worker_id    INTEGER NOT NULL REFERENCES workers(id),
  in_reply_to     INTEGER REFERENCES messages(id),
  sent_at         INTEGER NOT NULL,
  delivered_at    INTEGER,
  acknowledged_at INTEGER,
  status          TEXT NOT NULL CHECK (status IN ('pending','delivered','acknowledged','expired')),
  CHECK (from_worker_id IS NOT NULL OR from_principal IS NOT NULL)
);

-- The board (§7.1).
CREATE TABLE board_snapshots (
  sha         TEXT PRIMARY KEY,
  parent_sha  TEXT,                              -- the snapshot it replaced (the CAS base)
  received_at INTEGER NOT NULL,
  item_count  INTEGER NOT NULL                   -- live items in it; the rows themselves are work_items
);
CREATE TABLE board_head (id INTEGER PRIMARY KEY CHECK (id = 1), sha TEXT NOT NULL);

-- The filter fields of every live item at the head snapshot (R-BTN-33). Derived, never edited:
-- the sync's accepted snapshot rewrites only the rows whose row_hash changed.
CREATE TABLE work_items (
  id          TEXT PRIMARY KEY,                  -- 'R3-1205'
  path        TEXT NOT NULL,                     -- 'content/roadmap/R3-1205.mdx'
  title       TEXT NOT NULL,
  project     TEXT,
  status      TEXT NOT NULL,                     -- the item's `status:` in git
  node        TEXT NOT NULL,                     -- factory-state node: 'ready-autonomous', 'blocked', …
  queue       TEXT NOT NULL,                     -- 'autonomous' | 'operator' | 'expedite'
  tags        TEXT NOT NULL,                     -- JSON array
  tier        TEXT,                              -- NULL: untiered (fits only 'critical')
  requires_clause TEXT NOT NULL CHECK (requires_clause IN ('absent','none','listed')),  -- no clause / `none` / names
  operator_only INTEGER NOT NULL DEFAULT 0,      -- §7.2 rule 6: the `OP` tag or a `human-operator` clause
  depends_on  TEXT NOT NULL,                     -- JSON array of ids
  blocked_by  TEXT NOT NULL,                     -- JSON array of ids still open
  repos       TEXT NOT NULL,                     -- JSON array
  ord         TEXT,                              -- `order:`
  rank        INTEGER,                           -- position in rankReady (NULL when not ready)
  snapshot_sha TEXT NOT NULL,                    -- the snapshot that last wrote the row
  row_hash    TEXT NOT NULL
);
CREATE TABLE work_item_requires (                -- the 'listed' clause, expanded (§7.2 rule 4)
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,                    -- a capability or legacy resource name; a role is stored as its capabilities
  PRIMARY KEY (work_item_id, name)
);
CREATE INDEX work_items_ready ON work_items(rank) WHERE node LIKE 'ready-%';

-- Provider suspensions (§7.4): set by the owner, read by matching, the hooks and the gate.
CREATE TABLE provider_suspensions (
  id          INTEGER PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES model_providers(id),
  model_id    TEXT,                       -- NULL: the whole account; else one model on it
  mode        TEXT NOT NULL CHECK (mode IN ('no-new-work','stop')),
  starts_at   INTEGER NOT NULL,           -- now, or a scheduled start
  ends_at     INTEGER,                    -- NULL: until the owner lifts it
  reason      TEXT,
  set_by      TEXT NOT NULL,
  lifted_at   INTEGER,
  lifted_by   TEXT,
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);

-- The reviewer catalog (§7.4), written by the board sync from `.opencode/agents/*.md`.
CREATE TABLE reviewer_agents (
  name         TEXT PRIMARY KEY,          -- 'review-pr-qwen', 'adjudicator'
  reviews_on   TEXT NOT NULL,             -- frontmatter `reviews_on:`: the model that reviews
  family       TEXT NOT NULL,             -- derived from reviews_on: 'qwen','glm','deepseek','kimi','claude'
  bills        TEXT NOT NULL,             -- frontmatter `bills:`: JSON array of harness prefixes
  models       TEXT                       -- frontmatter `models:` (optional): JSON {prefix: model id}, §7.4
);

-- Usage and limits (§7.3).
CREATE TABLE usage_reports (
  worker_id   INTEGER NOT NULL REFERENCES workers(id),
  provider_id TEXT NOT NULL REFERENCES model_providers(id),
  model_id    TEXT NOT NULL,
  hour        INTEGER NOT NULL,                  -- start of the UTC hour
  usd_list    REAL NOT NULL,                     -- running total for that hour (replaced, not added)
  PRIMARY KEY (worker_id, provider_id, model_id, hour)
);
CREATE TABLE rate_limit_events (
  id          INTEGER PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES model_providers(id),
  model_id    TEXT,
  worker_id   INTEGER NOT NULL REFERENCES workers(id),
  at          INTEGER NOT NULL,
  resets_at   INTEGER
);

-- Not in §4 (R3-1206): the settings the board sync posts with each snapshot
-- (`min_skills_version`, R-BTN-22) and, later, the one-way `cutover_at` (R-BTN-28).
CREATE TABLE baton_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Not in §4 (R3-1206, review round 1): a rewritten history held for the owner (§7.1
-- R-BTN-11). One row per held sha, written once: a repeat force post of the same sha keeps
-- the first `auto_accept_at`, so the sync's 15-minute re-posts cannot push the 24-hour
-- deadline forward. Only the sha and its counts are kept, never the board (R-BTN-33);
-- accepting one is R3-1212's, which re-syncs from git. `accepted_at` is set then.
CREATE TABLE held_snapshots (
  sha            TEXT PRIMARY KEY,
  parent_sha     TEXT,
  head_sha       TEXT,                           -- the head it was held against
  item_count     INTEGER NOT NULL,
  received_at    INTEGER NOT NULL,               -- the first force post
  auto_accept_at INTEGER NOT NULL,               -- received_at + 24 h (§7.1)
  accepted_at    INTEGER
);
