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

-- ============================================================
-- RLS
-- ============================================================

alter table public.players enable row level security;
alter table public.player_seasons enable row level security;
alter table public.team_seasons enable row level security;
alter table public.market_values enable row level security;
alter table public.dpv_snapshots enable row level security;

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
