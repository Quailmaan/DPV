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
  synced_at timestamptz not null default now()
);

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

-- Pre-NFL-draft prospect rankings. Used to compute class strength per
-- draft_year, which in turn multiplies pick values. Populated by a
-- consensus-ingestion script (manual seed for now; data-source integration
-- is future work).
create table if not exists public.prospects (
  prospect_id text primary key,
  draft_year int not null,
  name text not null,
  position text check (position in ('QB','RB','WR','TE')),
  consensus_grade numeric,
  projected_round int,
  projected_overall_pick int,
  source text,
  updated_at timestamptz default now()
);

create index if not exists idx_prospects_year on public.prospects(draft_year);

-- Cached per-year class strength aggregate. Derived from the prospects
-- table but stored separately so the trade calc can read it cheaply without
-- re-aggregating on every request.
create table if not exists public.class_strength (
  draft_year int primary key,
  multiplier numeric not null default 1.0,
  top10_avg_grade numeric,
  top30_avg_grade numeric,
  prospect_count int,
  updated_at timestamptz default now()
);

-- ============================================================
-- RLS
-- ============================================================

alter table public.players enable row level security;
alter table public.player_seasons enable row level security;
alter table public.team_seasons enable row level security;
alter table public.market_values enable row level security;
alter table public.dpv_snapshots enable row level security;
alter table public.leagues enable row level security;
alter table public.league_rosters enable row level security;
alter table public.prospects enable row level security;
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

drop policy if exists "public read leagues" on public.leagues;
create policy "public read leagues" on public.leagues
  for select to anon, authenticated using (true);

drop policy if exists "public read league_rosters" on public.league_rosters;
create policy "public read league_rosters" on public.league_rosters
  for select to anon, authenticated using (true);

drop policy if exists "public read prospects" on public.prospects;
create policy "public read prospects" on public.prospects
  for select to anon, authenticated using (true);

drop policy if exists "public read class_strength" on public.class_strength;
create policy "public read class_strength" on public.class_strength
  for select to anon, authenticated using (true);
