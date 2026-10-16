-- 0013_stations.sql — R3-1232 (BATON_SPEC §2e R-BTN-63/-70/-71, §4, §6.7, §6.11, §7.1, §7.2):
-- where each ticket is, replayed from git by its repository's sync; the claim at a station and
-- running a leg; the legs it ran; the closures a snapshot reported; the worker's tags.

-- Where each ticket is (R-BTN-70). A cache: each accepted snapshot rewrites a ticket's rows.
CREATE TABLE ticket_stations (
  ticket_id    TEXT PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
  station      TEXT NOT NULL,                    -- a station of the course file
  path         TEXT NOT NULL,                    -- JSON: [{leg, reached}], the legs run so far, in order
  path_len     INTEGER NOT NULL,
  to_end       INTEGER NOT NULL,                 -- legs on the shortest route to an end station (resume before start)
  next_leg     TEXT,                             -- the queued leg; NULL only at an end station
  next_source  TEXT NOT NULL CHECK (next_source IN ('course','marker','inferred','holder')),
  handoff_url  TEXT,                             -- the newest hand-off document, if any (R-BTN-44)
  snapshot_sha TEXT NOT NULL,
  observation  INTEGER NOT NULL                  -- R-BTN-62
);
CREATE TABLE ticket_next_legs (                  -- the legs leaving the ticket's station it may still run
  ticket_id    TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  leg          TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('ready','waiting')),
  waiting_on   TEXT,                             -- a free label from the course
  ready_since  INTEGER,                          -- first snapshot that showed it ready (age)
  waiting_since INTEGER,                         -- first snapshot of an unbroken run of `waiting`
  PRIMARY KEY (ticket_id, leg)
);
CREATE INDEX next_legs_ready ON ticket_next_legs(state) WHERE state = 'ready';
CREATE TABLE ticket_bars (                       -- tags barred from a leg of the ticket (R-BTN-60), per leg name
  ticket_id    TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  leg          TEXT NOT NULL,
  tag          TEXT NOT NULL,
  PRIMARY KEY (ticket_id, leg, tag)
);

-- §7.1's normative ticket fields the interim post did not carry. `display` is shown, never read.
ALTER TABLE tickets ADD COLUMN expedite INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tickets ADD COLUMN display TEXT;

-- The claim at a station, running at most one leg (R-BTN-63).
ALTER TABLE claims ADD COLUMN station TEXT NOT NULL DEFAULT '';
-- The ticket's course when claimed: an end after the ticket left the board still reads its file.
ALTER TABLE claims ADD COLUMN course_id TEXT;
ALTER TABLE claims ADD COLUMN leg TEXT;
ALTER TABLE claims ADD COLUMN start_path TEXT NOT NULL DEFAULT '[]';
-- The leg the claim was offered (R-BTN-83): its first advance must start it. Spec-silent column.
ALTER TABLE claims ADD COLUMN offered_leg TEXT;
ALTER TABLE claims ADD COLUMN regressed_since INTEGER;
-- Whether it ended while regressed: such a suspension is confirmed by any later snapshot
-- (R-BTN-71), though `regressed_since` itself clears at the end. Spec-silent column.
ALTER TABLE claims ADD COLUMN ended_regressed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE claims ADD COLUMN end_detail TEXT;
ALTER TABLE claims ADD COLUMN advice_json TEXT;

CREATE TABLE claim_legs (                        -- R-BTN-63: the legs a claim started, in order, on the holder's word
  claim_id      INTEGER NOT NULL REFERENCES claims(id),
  seq           INTEGER NOT NULL,
  leg           TEXT NOT NULL,
  from_station  TEXT NOT NULL,
  to_station    TEXT,                            -- the station it reached; NULL while running or given up
  bars          TEXT NOT NULL DEFAULT '[]',      -- JSON: tags the holder barred from it at its advance
  started_at    INTEGER NOT NULL,
  started_observation INTEGER NOT NULL,          -- the counter when it started: bars-mismatch reads later snapshots only
  finished_at   INTEGER,                         -- set by the next advance or a completed end at its `to`
  abandoned_at  INTEGER,                         -- set by an end at its `from`
  evidence      TEXT,                            -- the pointer the finishing advance or end passed (sha or URL)
  bars_judged   INTEGER NOT NULL DEFAULT 0,      -- R-BTN-63: judged against the first later snapshot posting the leg's bars
  PRIMARY KEY (claim_id, seq)
);

CREATE TABLE closed_tickets (                    -- R-BTN-10: what a snapshot reported closing, kept after the row goes
  ticket_id     TEXT PRIMARY KEY,
  closed_as     TEXT NOT NULL CHECK (closed_as IN ('done','withdrawn')),
  observation   INTEGER NOT NULL,                -- the snapshot that reported it; the row is deleted if the ticket returns
  closed_at     INTEGER NOT NULL
);

CREATE TABLE worker_tags (                       -- R-BTN-60: course-defined strings the tag gate matches
  worker_id INTEGER NOT NULL REFERENCES workers(id),
  tag       TEXT NOT NULL,
  PRIMARY KEY (worker_id, tag)
);

-- The event log gains the kinds of stations and legs. Nothing references `events`, so it is
-- rebuilt with the wider check, every row and its seq (the mirror's cursor) carried over.
CREATE TABLE events_0013 (
  seq           INTEGER PRIMARY KEY,
  at            INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('claimed','completed','confirmed',
                  'released','reaped','fence-cleared','adopted','rekeyed','override',
                  'suspension','reviewer-substituted','attempts-exhausted','held','cutover',
                  'snapshot-rejected','snapshot-accepted','shadow-conflict','foreign-claim',
                  'advanced','advice-overridden','off-graph','bars-mismatch','regressed')),
  ticket_id     TEXT,
  claim_id      INTEGER REFERENCES claims(id),
  actor         TEXT NOT NULL,
  detail_json   TEXT,
  repository_id TEXT
);
INSERT INTO events_0013 (seq, at, kind, ticket_id, claim_id, actor, detail_json, repository_id)
  SELECT seq, at, kind, ticket_id, claim_id, actor, detail_json, repository_id FROM events;
DROP TABLE events;
ALTER TABLE events_0013 RENAME TO events;
CREATE INDEX events_by_ticket ON events(ticket_id, kind, seq);
CREATE INDEX events_by_claim ON events(claim_id, kind, seq);
CREATE INDEX events_by_repository ON events(repository_id, seq);
