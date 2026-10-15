-- 0008_observations.sql — R3-1231 part 3 (BATON_SPEC R-BTN-62, §4). Baton orders what each
-- sync saw — PRs, reviews, code repositories, which no commit orders — by a per-repository
-- counter: POST /v1/sync/observation hands out its next number before the sync reads anything,
-- and the board post carries it back.
ALTER TABLE board_head ADD COLUMN observation INTEGER NOT NULL DEFAULT 0;      -- the last accepted post's
ALTER TABLE board_head ADD COLUMN last_handed_out INTEGER NOT NULL DEFAULT 0;  -- the counter's last value handed out
-- When the last number was handed out while it is outstanding (handed out, not yet posted or
-- refused); NULL once a post used it. An outstanding number older than 10 minutes is void
-- (spec-silent, recorded on R3-1231: the hand-out time must be stored to tell).
ALTER TABLE board_head ADD COLUMN handed_out_at INTEGER;
ALTER TABLE held_snapshots ADD COLUMN observation INTEGER;                      -- the held post's (R-BTN-62)
-- R-BTN-62: a snapshot confirms an end, or makes a claim stale, only if its number is greater
-- than the counter's last handed-out value when that end or claim happened.
ALTER TABLE claims ADD COLUMN claim_observation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE claims ADD COLUMN end_observation INTEGER;
