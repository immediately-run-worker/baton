-- 0003_claims.sql — R3-1212 (BATON_SPEC §6.6 R-BTN-19).

-- A claim reaped while its worker was alive is fence-pending until that worker, in the same
-- incarnation (its pre-reap secret: a re-key never clears a fence), reports it fenced.
ALTER TABLE work_item_claims ADD COLUMN fence_incarnation INTEGER;

