-- Anchor each dpv_history row to an NFL (season, week) so the per-player
-- trend chart can render two distinct views off the same table:
--   1. Career arc — one point per season, picking the last snapshot of
--      that season's row set. Reads as "how this player's value moved
--      year over year."
--   2. In-season arc — one point per week during the live season. Reads
--      as "how the model's read accumulated as games were played."
--
-- Both columns nullable so existing rows keep working without backfill.
-- compute-dpv.ts will start populating them on the next nightly run.
-- Past rows can be backfilled later with a one-shot script that maps
-- snapshot_date → (season, week) using the same nflContext helper.

alter table public.dpv_history
  add column if not exists season int;

alter table public.dpv_history
  add column if not exists week int;
