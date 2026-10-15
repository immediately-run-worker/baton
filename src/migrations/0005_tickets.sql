-- 0005_tickets.sql — R3-1230 (BATON_SPEC §2a Names, §4, §15): work items become tickets.
-- Renamed in place, never copied: SQLite's RENAME TO and RENAME COLUMN carry every row, and
-- RENAME TO rewrites the foreign keys that name a renamed table. Indexes whose names changed
-- are dropped and re-created under the new names; the others follow their columns.

ALTER TABLE work_items RENAME TO tickets;
ALTER TABLE work_item_claims RENAME TO claims;
ALTER TABLE item_overrides RENAME TO ticket_overrides;
ALTER TABLE work_item_requires RENAME TO ticket_requires;

ALTER TABLE claims RENAME COLUMN work_item_id TO ticket_id;
ALTER TABLE ticket_overrides RENAME COLUMN work_item_id TO ticket_id;
ALTER TABLE ticket_requires RENAME COLUMN work_item_id TO ticket_id;
ALTER TABLE events RENAME COLUMN work_item_id TO ticket_id;
ALTER TABLE adoptions RENAME COLUMN work_item_id TO ticket_id;

ALTER TABLE board_snapshots RENAME COLUMN item_count TO ticket_count;
ALTER TABLE held_snapshots RENAME COLUMN item_count TO ticket_count;

DROP INDEX one_active_claim_per_item;
CREATE UNIQUE INDEX one_active_claim_per_ticket ON claims(ticket_id) WHERE status = 'active';
DROP INDEX work_items_ready;
CREATE INDEX tickets_ready ON tickets(rank) WHERE node LIKE 'ready-%';
DROP INDEX events_by_item;
CREATE INDEX events_by_ticket ON events(ticket_id, kind, seq);

-- JSON already stored in rows names the old keys: a pending `release` message's payload
-- (`work_item_id`, read back by the reap and the de-dup), and event details (`work_item_id`,
-- the snapshot events' `item_count`). Rewritten here so every row reads under the new names.
UPDATE messages SET payload_json = json_set(json_remove(payload_json, '$.work_item_id'), '$.ticket_id', json_extract(payload_json, '$.work_item_id'))
  WHERE json_valid(payload_json) AND json_type(payload_json, '$.work_item_id') IS NOT NULL;
UPDATE events SET detail_json = json_set(json_remove(detail_json, '$.work_item_id'), '$.ticket_id', json_extract(detail_json, '$.work_item_id'))
  WHERE json_valid(detail_json) AND json_type(detail_json, '$.work_item_id') IS NOT NULL;
UPDATE events SET detail_json = json_set(json_remove(detail_json, '$.item_count'), '$.ticket_count', json_extract(detail_json, '$.item_count'))
  WHERE json_valid(detail_json) AND json_type(detail_json, '$.item_count') IS NOT NULL;
