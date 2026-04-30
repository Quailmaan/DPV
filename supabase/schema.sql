-- Dynasty Player Valuation (DPV) — Supabase schema
-- Paste this entire file into the Supabase SQL Editor and run it.

-- ============================================================
-- TABLES
-- ============================================================

create table if not exists public.players (
  player_id text primary key,
  name text not null,
  position text not null check (position in ('QB','RB','WR','TE')),
  birthdate date,
  draft_round int,
  draft_year int,
  current_team text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_players_position on public.players(position);
create index if not exists idx_players_team on public.players(current_team);

create table if not exists public.player_seasons (
  player_id text not null references public.players(player_id) on delete cascade,
  season int not null,
  team text,
  games_played int not null default 0,
  passing_yards int default 0,
  passing_tds int default 0,
  interceptions int default 0,
  rushing_yards int default 0,
  rushing_tds int default 0,
  receptions int default 0,
  receiving_yards int default 0,
  receiving_tds int default 0,
  fumbles_lost int default 0,
  snap_share_pct numeric,
  target_share_pct numeric,
  opportunity_share_pct numeric,
  weekly_fantasy_points_half jsonb,
  updated_at timestamptz default now(),
  primary key (player_id, season)
);

create index if not exists idx_seasons_season on public.player_seasons(season);

create table if not exists public.team_seasons (
  team text not null,
  season int not null,
  oline_composite_rank int,
  qb_tier int check (qb_tier between 1 and 5),
  team_offense_rank int,
  updated_at timestamptz default now(),
  primary key (team, season)
);

create table if not exists public.market_values (
  player_id text not null references public.players(player_id) on delete cascade,
  scoring_format text not null check (scoring_format in ('STANDARD','HALF_PPR','FULL_PPR')),
  market_value_normalized numeric,
  position_rank int,
  overall_rank int,
  source text,
  snapshot_at timestamptz default now(),
  primary key (player_id, scoring_format, source)
);

create table if not exists public.dpv_snapshots (
  player_id text not null references public.players(player_id) on delete cascade,
  scoring_format text not null check (scoring_format in ('STANDARD','HALF_PPR','FULL_PPR')),
  dpv int not null,
  tier text,
  breakdown jsonb not null,
  computed_at timestamptz default now(),
  primary key (player_id, scoring_format)
);

create index if not exists idx_dpv_sorted on public.dpv_snapshots(scoring_format, dpv desc);

-- Daily DPV snapshots over time. Source of truth for the trajectory
-- indicator (30-day, 6-month value change %) and the sell-window score.
-- Appended once per compute-dpv run, keyed by snapshot_date so re-running
-- the same day overwrites instead of double-counting.
--
-- Retention: unbounded for now. ~5k players × 3 formats × 365 days =
-- ~5.5M rows/year, well within Postgres comfort with the index below.
-- We can prune to weekly granularity past 90 days later if needed.
create table if not exists public.dpv_history (
  player_id text not null references public.players(player_id) on delete cascade,
  scoring_format text not null check (scoring_format in ('STANDARD','HALF_PPR','FULL_PPR')),
  snapshot_date date not null,
  dpv int not null,
  -- Full DPVBreakdown persisted alongside the final number so the
  -- per-player trend chart can attribute week-over-week DPV moves to
  -- the underlying inputs (opportunity ↑, age ↓, etc.). Nullable
  -- because rows written before this column was added have no
  -- breakdown — the "what changed" UI degrades gracefully when it's
  -- missing.
  breakdown jsonb,
  primary key (player_id, scoring_format, snapshot_date)
);

-- Idempotent column add for existing deploys: re-running schema.sql
-- against a database that already has dpv_history (without the
-- breakdown column) backfills it as nullable.
alter table public.dpv_history
  add column if not exists breakdown jsonb;

-- Trajectory queries hit (player_id, scoring_format) and walk back in
-- time, so the index leads with those and orders by date desc.
create index if not exists idx_dpv_history_player
  on public.dpv_history(player_id, scoring_format, snapshot_date desc);

create table if not exists public.hsm_comps (
  player_id text not null references public.players(player_id) on delete cascade,
  comps jsonb not null,
  summary jsonb not null,
  computed_at timestamptz default now(),
  primary key (player_id)
);

create table if not exists public.leagues (
  league_id text primary key,
  name text not null,
  season text,
  total_rosters int,
  scoring_format text check (scoring_format in ('STANDARD','HALF_PPR','FULL_PPR')),
  raw_settings jsonb,
  -- Sleeper-style roster slot list (e.g. ["QB","RB","RB","WR","WR","WR","TE",
  -- "FLEX","SUPER_FLEX","BN",...]). Drives league-aware position scarcity in
  -- the trade calculator: SF leagues raise QB scarcity, deep-flex leagues
  -- raise RB/WR scarcity. Null until first sync after column was added; the
  -- trade page falls back to a standard 12-team 1-QB build when missing.
  roster_positions text[],
  synced_at timestamptz not null default now()
);

alter table public.leagues
  add column if not exists roster_positions text[];

create table if not exists public.league_rosters (
  league_id text not null references public.leagues(league_id) on delete cascade,
  roster_id int not null,
  owner_user_id text,
  owner_display_name text,
  team_name text,
  player_ids text[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (league_id, roster_id)
);

create index if not exists idx_league_rosters_league on public.league_rosters(league_id);

-- Per-league rookie pick ownership. Each row is one round of one season,
-- pinned to the team whose draft slot it is (`original_roster_id`) and the
-- team that currently holds it (`owner_roster_id`). Slot ordering inside a
-- round (1.01 vs 1.05) isn't determined until standings finalize, so we
-- only track at round granularity — the trade calculator values these as
-- the average DPV across the round and notes the limitation in the UI.
--
-- Sleeper's /league/{id}/traded_picks endpoint only returns picks that
-- have changed hands. Untraded picks are synthesized from the roster list
-- at sync time so every team's default picks (their own R1/R2/R3 across
-- the rolling 3-year window) appear here too.
create table if not exists public.league_picks (
  league_id text not null references public.leagues(league_id) on delete cascade,
  season int not null,
  round int not null,
  original_roster_id int not null,
  owner_roster_id int not null,
  updated_at timestamptz not null default now(),
  primary key (league_id, season, round, original_roster_id)
);

create index if not exists idx_league_picks_league on public.league_picks(league_id);
create index if not exists idx_league_picks_owner on public.league_picks(league_id, owner_roster_id);

-- Pre-NFL-draft prospect rankings. Raw per-source entries: one row per
-- (prospect, source). Stack multiple sites (KTC, DLF, NFLMDD, etc.) for
-- the same prospect and let the aggregation script build a consensus.
--
-- source values are free-form but should be stable per site (e.g. "KTC",
-- "DLF_STAFF", "NFLMDD"). Ingestion upserts on (prospect_id, source).
--
-- If you had the single-PK version of this table, drop it first:
--   drop table if exists public.prospects cascade;
create table if not exists public.prospects (
  prospect_id text not null,
  source text not null,
  draft_year int not null,
  name text not null,
  position text check (position in ('QB','RB','WR','TE')),
  consensus_grade numeric,
  projected_round int,
  projected_overall_pick int,
  updated_at timestamptz default now(),
  primary key (prospect_id, source)
);

create index if not exists idx_prospects_year on public.prospects(draft_year);
create index if not exists idx_prospects_id on public.prospects(prospect_id);

-- Aggregated cross-source consensus. One row per prospect_id, computed by
-- ranking each source's grades within the year, averaging ranks per
-- prospect, and mapping back to a normalized 0-100 grade. Robust to
-- different sources using different grade scales.
create table if not exists public.prospect_consensus (
  prospect_id text primary key,
  draft_year int not null,
  name text not null,
  position text,
  avg_rank numeric,            -- average across sources (1 = best)
  normalized_grade numeric,    -- 0-100, derived from avg_rank via decay curve
  source_count int not null,
  projected_round int,
  projected_overall_pick int,
  updated_at timestamptz default now()
);

create index if not exists idx_prospect_consensus_year on public.prospect_consensus(draft_year);

-- Cached per-year class strength aggregate. Derived from the prospects
-- table but stored separately so the trade calc can read it cheaply without
-- re-aggregating on every request.
--
-- The slot-aware pick calculator (src/lib/picks/constants.ts) drives off
-- r1_offensive_count and top15_offensive_count — cross-year anchors that
-- capture "how many real NFL first-round offensive prospects exist."
-- multiplier/top10_avg_grade remain for legacy readers / dashboards.
create table if not exists public.class_strength (
  draft_year int primary key,
  multiplier numeric not null default 1.0,
  r1_offensive_count int,
  top15_offensive_count int,
  top10_avg_grade numeric,
  top30_avg_grade numeric,
  prospect_count int,
  updated_at timestamptz default now()
);

-- Migration for installs that predate the count columns.
alter table public.class_strength
  add column if not exists r1_offensive_count int;
alter table public.class_strength
  add column if not exists top15_offensive_count int;

-- Rookie-specific HSM comps. Same shape as hsm_comps, but the anchors are
-- PRE-rookie-year feature vectors (draft pick, age, RAS, team context) and
-- the "next" PPG columns are Y1/Y2/Y3 of their NFL career. Used by the
-- rookie prior path to blend an empirical projection into the formula.
create table if not exists public.rookie_hsm_comps (
  player_id text primary key references public.players(player_id) on delete cascade,
  comps jsonb not null,
  summary jsonb not null,
  computed_at timestamptz default now()
);

alter table public.rookie_hsm_comps enable row level security;
drop policy if exists "public read rookie_hsm_comps" on public.rookie_hsm_comps;
create policy "public read rookie_hsm_comps" on public.rookie_hsm_comps
  for select to anon, authenticated using (true);

-- NFL Combine & pro-day measurables. Populated once per player at the combine
-- (rookie year). The `athleticism_score` column is a 0-10 composite z-scored
-- within position — a lightweight RAS approximation used exclusively by the
-- rookie prior path.
create table if not exists public.combine_stats (
  player_id text primary key references public.players(player_id) on delete cascade,
  pfr_id text,
  combine_season int,
  position text,
  height_in numeric,
  weight_lb numeric,
  forty numeric,
  bench int,
  vertical numeric,
  broad_jump numeric,
  cone numeric,
  shuttle numeric,
  athleticism_score numeric,
  metrics_count int,
  updated_at timestamptz default now()
);

create index if not exists idx_combine_position on public.combine_stats(position);

alter table public.combine_stats enable row level security;
drop policy if exists "public read combine_stats" on public.combine_stats;
create policy "public read combine_stats" on public.combine_stats
  for select to anon, authenticated using (true);

-- ============================================================
-- RLS
-- ============================================================

alter table public.players enable row level security;
alter table public.player_seasons enable row level security;
alter table public.team_seasons enable row level security;
alter table public.market_values enable row level security;
alter table public.dpv_snapshots enable row level security;
alter table public.dpv_history enable row level security;
alter table public.leagues enable row level security;
alter table public.league_rosters enable row level security;
alter table public.league_picks enable row level security;
alter table public.prospects enable row level security;
alter table public.prospect_consensus enable row level security;
alter table public.class_strength enable row level security;

drop policy if exists "public read players" on public.players;
create policy "public read players" on public.players
  for select to anon, authenticated using (true);

drop policy if exists "public read player_seasons" on public.player_seasons;
create policy "public read player_seasons" on public.player_seasons
  for select to anon, authenticated using (true);

drop policy if exists "public read team_seasons" on public.team_seasons;
create policy "public read team_seasons" on public.team_seasons
  for select to anon, authenticated using (true);

drop policy if exists "public read market_values" on public.market_values;
create policy "public read market_values" on public.market_values
  for select to anon, authenticated using (true);

drop policy if exists "public read dpv_snapshots" on public.dpv_snapshots;
create policy "public read dpv_snapshots" on public.dpv_snapshots
  for select to anon, authenticated using (true);

drop policy if exists "public read dpv_history" on public.dpv_history;
create policy "public read dpv_history" on public.dpv_history
  for select to anon, authenticated using (true);

drop policy if exists "public read leagues" on public.leagues;
create policy "public read leagues" on public.leagues
  for select to anon, authenticated using (true);

drop policy if exists "public read league_rosters" on public.league_rosters;
create policy "public read league_rosters" on public.league_rosters
  for select to anon, authenticated using (true);

drop policy if exists "public read league_picks" on public.league_picks;
create policy "public read league_picks" on public.league_picks
  for select to anon, authenticated using (true);

drop policy if exists "public read prospects" on public.prospects;
create policy "public read prospects" on public.prospects
  for select to anon, authenticated using (true);

drop policy if exists "public read prospect_consensus" on public.prospect_consensus;
create policy "public read prospect_consensus" on public.prospect_consensus
  for select to anon, authenticated using (true);

drop policy if exists "public read class_strength" on public.class_strength;
create policy "public read class_strength" on public.class_strength
  for select to anon, authenticated using (true);
