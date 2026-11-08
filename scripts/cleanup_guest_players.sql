-- Remove guest-only names from the `players` identity table.
--
-- Before this change, every name seen in a replay went into `players`
-- (replay_players' foreign key required it), so guest names like
-- "New Player" ended up looking like accounts. New replays no longer add
-- guests there. This removes the old ones.
--
-- Run ONLY after src/backfill_participants.js has finished; before that,
-- replay_participants doesn't yet know who was a guest in older replays.
-- Check: the backfill's last log line says "Done", or
--   SELECT processed FROM backfill_state WHERE name = 'participants_v1';
-- is about the same as SELECT count(*) FROM replays;
--
-- A name is kept if it ever appeared as a registered (non-guest) player.
-- Deleting a players row also deletes its replay_players rows (ON DELETE
-- CASCADE); the replay site searches replay_participants instead, so
-- nothing it shows is lost.
--
-- Note: a guest who used the same name as a registered account was merged
-- into that account's row (level, avatars). That can't be separated after
-- the fact; only new replays are kept apart.

-- 1. Preview: how many names would be removed, and a sample
SELECT count(*) AS guest_only_names
FROM players p
WHERE NOT EXISTS (
    SELECT 1 FROM replay_participants rp
    WHERE rp.username = p.username AND NOT rp.guest
);

SELECT p.username, p.level
FROM players p
WHERE NOT EXISTS (
    SELECT 1 FROM replay_participants rp
    WHERE rp.username = p.username AND NOT rp.guest
)
ORDER BY p.username
LIMIT 25;

-- 2. Delete (run in a transaction so you can check the count first)
BEGIN;

DELETE FROM players p
WHERE NOT EXISTS (
    SELECT 1 FROM replay_participants rp
    WHERE rp.username = p.username AND NOT rp.guest
);

-- Look at the DELETE count above. If it matches the preview:
COMMIT;
-- otherwise: ROLLBACK;
