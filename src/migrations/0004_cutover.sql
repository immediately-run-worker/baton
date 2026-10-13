-- 0004_cutover.sql — R3-1217 (BATON_SPEC §6.10, §13 step 3, R-BTN-28).

-- §13 step 3: the legacy import needs, for each in-progress item, the date it entered that
-- status (factory-state's `since`: the claim note's date) and the claim note's holder session
-- when the sync posts one (`holderOf`). Both are filter-level facts, not note text (R-BTN-33).
ALTER TABLE work_items ADD COLUMN since TEXT;
ALTER TABLE work_items ADD COLUMN holder TEXT;

-- §13 step 3: a session asks to adopt its legacy claim; the claim moves only when the owner
-- confirms (claim notes are public, so a matching name alone proves nothing). One open
-- request per item: a newer one replaces it.
CREATE TABLE adoptions (
  work_item_id TEXT PRIMARY KEY,
  claim_id     INTEGER NOT NULL REFERENCES work_item_claims(id),
  worker_id    INTEGER NOT NULL REFERENCES workers(id),
  requested_at INTEGER NOT NULL
);
