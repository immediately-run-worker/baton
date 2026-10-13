-- 0002_workers.sql — R3-1211 (BATON_SPEC §6.8, §7.4).

-- §6.8: a transcript path reported while the worker holds no claim is linked to its next
-- claim when that starts (R3-1212); `transcripts.claim_id` is NOT NULL, so it waits here.
CREATE TABLE pending_transcripts (
  worker_id      INTEGER NOT NULL REFERENCES workers(id),
  repo           TEXT NOT NULL,
  path           TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('session','subagent')),
  activity_id    TEXT,
  first_seen_at  INTEGER NOT NULL,
  last_pushed_at INTEGER,
  PRIMARY KEY (worker_id, repo, path)
);

-- §7.4: a scheduled start and a timed end are each logged once, by the alarm.
ALTER TABLE provider_suspensions ADD COLUMN start_logged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE provider_suspensions ADD COLUMN end_logged INTEGER NOT NULL DEFAULT 0;
