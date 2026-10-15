-- 0009_tiers.sql — R3-1231 part 4 (BATON_SPEC R-BTN-66, §7.2 rule 5, §4). Tiers are a repository
-- setting: a ticket's tier arrives by name and is matched as its position in its repository's
-- ladder (lowest first); a worker's ceiling may differ per repository.
-- NULL: untiered, which fits only the top. A name the ladder lacks fits nothing: its position is
-- the ladder's length, above every ceiling.
ALTER TABLE tickets ADD COLUMN tier_position INTEGER;
UPDATE tickets SET tier_position = (
  SELECT COALESCE((SELECT CAST(j.key AS INTEGER) FROM json_each(r.tiers) j WHERE j.value = tickets.tier), json_array_length(r.tiers))
  FROM repositories r WHERE r.id = tickets.repository_id)
WHERE tier IS NOT NULL;
-- {repository: tier name} from the heartbeat; a repository absent from it takes tier_ceiling
-- where its ladder has that name (§7.2 rule 5).
ALTER TABLE workers ADD COLUMN tier_ceilings TEXT NOT NULL DEFAULT '{}';
