-- Adds the breakdown column to dpv_history so per-player trend charts
-- can attribute week-over-week DPV moves to the underlying sub-scores
-- (opportunity, age, O-line, QB tier, etc.).
--
-- Safe to run repeatedly — both statements are guarded by IF NOT EXISTS.
-- Existing rows are NOT backfilled (breakdown stays NULL until the next
-- compute-dpv run writes it). The "what changed" UI gracefully degrades
-- when one or both endpoints have a NULL breakdown.
--
-- To apply:
--   1. Open Supabase → SQL Editor → New query
--   2. Paste this file
--   3. Run
--   4. Re-run compute-dpv.ts so the next history row carries breakdown

alter table public.dpv_history
  add column if not exists breakdown jsonb;
