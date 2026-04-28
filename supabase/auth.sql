-- Pylon — auth schema
--
-- Run this in the Supabase SQL Editor AFTER schema.sql. It is idempotent —
-- safe to re-run. It introduces:
--
--   profiles      — one row per auth.users user, holds the public-facing
--                   username and display_name. The username is the login
--                   handle (resolved to email server-side at sign-in).
--   user_leagues  — many-to-many between users and leagues, capped at 3
--                   per user via trigger. The leagues table itself stays
--                   shared so we don't re-sync the same Sleeper league
--                   for every user.
--
-- Auth tokens / hashes / sensitive identity data live ONLY in Supabase's
-- auth.users table, which is NOT readable by the app. The app reads
-- profiles via RLS-scoped queries. RLS on user_leagues makes a user's
-- league subscriptions invisible to other users.
--
-- ============================================================
-- Provider setup (do these in the Supabase dashboard, not in SQL)
-- ============================================================
--
-- Email / password (Phase 1):
--   Authentication → Providers → Email — enabled by default.
--   Authentication → URL Configuration:
--     Site URL: https://yourdomain.com   (or http://localhost:3000 for dev)
--     Additional Redirect URLs:
--       http://localhost:3000/auth/callback
--       https://yourdomain.com/auth/callback
--
-- Google OAuth (Phase 2):
--   1. Google Cloud Console → APIs & Services → Credentials
--      → Create OAuth 2.0 Client ID (Web application).
--      Authorized redirect URI:
--        https://<project-ref>.supabase.co/auth/v1/callback
--      Note the client ID + secret.
--   2. Supabase dashboard → Authentication → Providers → Google
--      → toggle on, paste the client ID and secret, save.
--   3. Make sure /auth/callback (your app's callback) is in the
--      "Additional Redirect URLs" list above. Supabase relays from its
--      own /auth/v1/callback to whatever `redirectTo` we pass, and
--      that URL has to be on the allow-list.

-- ============================================================
-- TABLES
-- ============================================================

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  -- Username is the login handle. Stored case-preserving for display, but
  -- unique-indexed case-insensitive (citext would be cleaner, but a
  -- functional unique index avoids the extension dependency). Validated
  -- to 3-24 chars of [a-z0-9_].
  username text unique not null,
  display_name text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_username_format
    check (username ~ '^[a-zA-Z0-9_]{3,24}$')
);

-- Case-insensitive uniqueness so "Billy" and "billy" can't both exist.
create unique index if not exists idx_profiles_username_lower
  on public.profiles (lower(username));

create table if not exists public.user_leagues (
  user_id uuid not null references auth.users(id) on delete cascade,
  league_id text not null references public.leagues(league_id) on delete cascade,
  added_at timestamptz not null default now(),
  is_default boolean not null default false,
  primary key (user_id, league_id)
);

create index if not exists idx_user_leagues_user on public.user_leagues(user_id);

-- Subscription state per user. One row per user, written by the Stripe
-- webhook on checkout completion / subscription updates. The presence of
-- a row at status='active' or 'trialing' grants Pro tier; absent users
-- and any other status are treated as free.
--
-- We store the Stripe customer ID once per user so subsequent checkouts
-- (upgrade, change billing) reuse the same customer record. The
-- subscription ID lets the customer portal know which sub to manage.
create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text not null,
  stripe_subscription_id text,
  -- Mirrors Stripe's subscription.status verbatim so we can debug from
  -- the DB without re-querying Stripe. Treated as Pro when in
  -- ('active','trialing'); anything else is free.
  status text not null default 'incomplete',
  -- Which price the user picked — used by the account page to render
  -- "$7/mo" vs "$59/yr" without another Stripe round-trip.
  price_id text,
  current_period_end timestamptz,
  -- Set when the user clicks "cancel" in the portal. The sub stays
  -- active until current_period_end, then Stripe sends a delete event
  -- and we flip status to 'canceled'.
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_subscriptions_customer
  on public.subscriptions(stripe_customer_id);

drop trigger if exists subscriptions_set_updated_at on public.subscriptions;
create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

-- ============================================================
-- TRIGGERS
-- ============================================================

-- Auto-bump updated_at on profile changes.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Tier-aware league cap. Free users are capped at 1; Pro users
-- (subscriptions.status in active/trialing) are uncapped. Enforced
-- before insert so the API can rely on a clean error rather than racing.
--
-- The cap delta from "3 free" to "1 free / unlimited Pro" is the
-- monetization gate: paying upgrades the cap, churning back to free
-- doesn't auto-delete extras (they linger read-only) — the app surfaces
-- a "you're over the free cap" warning until the user removes some.
create or replace function public.enforce_user_league_cap()
returns trigger
language plpgsql
as $$
declare
  current_count int;
  user_tier text;
begin
  -- Treat active/trialing as Pro. Anything else (including no row) is
  -- free. Kept as a single SELECT so the trigger stays cheap.
  select case
    when status in ('active','trialing') then 'pro'
    else 'free'
  end into user_tier
  from public.subscriptions
  where user_id = new.user_id;
  if user_tier is null then user_tier := 'free'; end if;

  if user_tier = 'pro' then
    return new; -- no cap
  end if;

  select count(*) into current_count
    from public.user_leagues
    where user_id = new.user_id;
  if current_count >= 1 then
    raise exception 'user_leagues_cap_exceeded'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists user_leagues_cap on public.user_leagues;
create trigger user_leagues_cap
  before insert on public.user_leagues
  for each row execute function public.enforce_user_league_cap();

-- Auto-create a placeholder profile row whenever a new auth.users row is
-- created. Username defaults to "user_<short-uuid>" — kept as a placeholder
-- regardless of provider so the welcome flow always forces the user to
-- pick a real handle (we don't want a Google display name as the login
-- key). For OAuth signups, we DO seed display_name from the provider's
-- metadata so the UI has something nicer to render until the user
-- customizes it. Google sets `full_name` in raw_user_meta_data.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  fallback_username text;
  meta_name text;
begin
  fallback_username := 'user_' || replace(substring(new.id::text from 1 for 8), '-', '');
  meta_name := coalesce(
    new.raw_user_meta_data->>'full_name',
    new.raw_user_meta_data->>'name',
    null
  );
  insert into public.profiles (user_id, username, display_name)
  values (new.id, fallback_username, meta_name)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- RLS
-- ============================================================

alter table public.profiles enable row level security;
alter table public.user_leagues enable row level security;
alter table public.subscriptions enable row level security;

-- Profiles: public read of (username, display_name) so other features can
-- show "@username" without leaking PII (no email here). Update only by
-- the owning user. No client-side insert (the trigger handles it).
drop policy if exists "public read profiles" on public.profiles;
create policy "public read profiles" on public.profiles
  for select to anon, authenticated using (true);

drop policy if exists "users update own profile" on public.profiles;
create policy "users update own profile" on public.profiles
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- user_leagues: each user sees only their own subscriptions, can add or
-- remove rows for themselves, and cannot read others' rows.
drop policy if exists "users read own user_leagues" on public.user_leagues;
create policy "users read own user_leagues" on public.user_leagues
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "users insert own user_leagues" on public.user_leagues;
create policy "users insert own user_leagues" on public.user_leagues
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "users delete own user_leagues" on public.user_leagues;
create policy "users delete own user_leagues" on public.user_leagues
  for delete to authenticated
  using (auth.uid() = user_id);

drop policy if exists "users update own user_leagues" on public.user_leagues;
create policy "users update own user_leagues" on public.user_leagues
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- subscriptions: read-only by the owner. Writes happen exclusively from
-- the Stripe webhook handler using the service-role key (which bypasses
-- RLS), so there's no insert/update policy here — clients should never
-- be able to forge their own subscription state.
drop policy if exists "users read own subscription" on public.subscriptions;
create policy "users read own subscription" on public.subscriptions
  for select to authenticated
  using (auth.uid() = user_id);

-- The leagues table itself stays publicly readable (already enabled in
-- schema.sql) so the league dashboards and trade calculator continue to
-- work for unauthenticated browsing of the public DPV pages. Per-user
-- access is enforced by joining through user_leagues server-side, not by
-- locking down the leagues table.

-- ============================================================
-- EMAIL PREFERENCES
-- ============================================================
-- Opt-in storage for transactional / digest email. One row per user
-- once they've ever expressed a preference; absence of a row means
-- "default off". Storing a per-user unsubscribe_token lets us include
-- a one-click unsubscribe URL in every email without exposing the
-- user_id (CAN-SPAM + GDPR baseline).
--
-- last_digest_sent_at lets the cron skip users who already received
-- this week's digest, so a re-fired cron (manual retry, double-fire)
-- doesn't double-send.

create table if not exists public.email_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  weekly_digest_opted_in boolean not null default false,
  unsubscribe_token uuid not null default gen_random_uuid() unique,
  last_digest_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_email_preferences_token
  on public.email_preferences(unsubscribe_token);

drop trigger if exists email_preferences_set_updated_at on public.email_preferences;
create trigger email_preferences_set_updated_at
  before update on public.email_preferences
  for each row execute function public.set_updated_at();

alter table public.email_preferences enable row level security;

drop policy if exists "users read own email prefs" on public.email_preferences;
create policy "users read own email prefs" on public.email_preferences
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "users insert own email prefs" on public.email_preferences;
create policy "users insert own email prefs" on public.email_preferences
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "users update own email prefs" on public.email_preferences;
create policy "users update own email prefs" on public.email_preferences
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
