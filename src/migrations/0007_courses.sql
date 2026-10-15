-- 0007_courses.sql — R3-1231 part 2b (BATON_SPEC §2a R-BTN-48, §2e R-BTN-69, §4, R-BTN-22,
-- R-BTN-65). Each repository's sync posts a course registry with its board; a ticket names its
-- course; a worker declares the courses its checkouts run, and rule 9 compares that version
-- with the course's min_worker_version. The skills version is each course's version, so the
-- instance-wide min_skills_version goes.
CREATE TABLE courses (                         -- the registry each repository's sync posts (R-BTN-48)
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  id            TEXT NOT NULL,                   -- 'roadmap-pr'
  version       INTEGER NOT NULL,                -- also its skills version (R-BTN-22)
  skill         TEXT NOT NULL,                   -- 'next-roadmap-item'
  course_json   TEXT NOT NULL,                   -- the course file: stations and legs, validated (R-BTN-69)
  step_kinds    TEXT NOT NULL,                   -- JSON: the §6.9 step kinds its skills report (R-BTN-50)
  min_worker_version INTEGER NOT NULL,           -- rule 9 (R-BTN-65)
  report_horizon_h INTEGER NOT NULL DEFAULT 6,   -- R-BTN-52, ≤ 168
  branch_pattern TEXT NOT NULL DEFAULT 'claude/{ticket}-*',  -- §6.3 (R-BTN-51)
  previous_branch_pattern TEXT,                  -- an older pattern still matched (R-BTN-51)
  PRIMARY KEY (repository_id, id)
);
-- R-BTN-69: a posted course file that fails keeps the previous one in force and is listed
-- under Needs you — the newest refused file per course, cleared when one is accepted.
CREATE TABLE course_refusals (
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  course_id     TEXT NOT NULL,
  version       INTEGER NOT NULL,
  snapshot_sha  TEXT NOT NULL,                   -- the board post that carried it
  refused_at    INTEGER NOT NULL,
  violations    TEXT NOT NULL,                   -- JSON: validateCourse's list (src/core/course.ts)
  PRIMARY KEY (repository_id, course_id)
);
CREATE TABLE worker_courses (                  -- what a worker's checkouts can run (R-BTN-48)
  worker_id     INTEGER NOT NULL REFERENCES workers(id),
  repository_id TEXT NOT NULL,
  course_id     TEXT NOT NULL,
  version       INTEGER NOT NULL,
  PRIMARY KEY (worker_id, repository_id, course_id)
);
-- A ticket names its course; docs' tickets are roadmap-pr's (R-BTN-48: the default when absent).
ALTER TABLE tickets ADD COLUMN course_id TEXT NOT NULL DEFAULT 'roadmap-pr';
DELETE FROM baton_settings WHERE key = 'min_skills_version';
-- A worker's versions are per course now (worker_courses).
ALTER TABLE workers DROP COLUMN skills_version;
