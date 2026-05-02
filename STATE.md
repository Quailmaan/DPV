# Pylon — State of Project

**Repo:** `Quailmaan/DPV` · **Live:** https://www.pylonff.com · **Snapshot:** May 1, 2026

This doc is a session-handoff brief. Keep it accurate by updating after large
feature ships; treat sections that drift out of sync with the codebase as
debt to fix.

---

## What Pylon is

Dynasty fantasy football platform. Calibrates **PYV** (Pylon Value) per player
using production, age curve, opportunity, situation, consistency, market, and
EPA-per-opportunity. Sleeper league sync, roster analysis, trade tools.

- **Free tier**: full PYV board, rookie consensus, 1 synced Sleeper league,
  universal trade calculator.
- **Pro tier ($7/mo via Stripe)**: sell-window flags, position profile charts
  (passing/rushing/receiving trends per player), league-aware trade calculator
  with traded picks + scarcity, weekly insight digest.
- **Members-only model** with a public marketing landing at `/`.

**Stack:** Next.js 16.2.4 (Turbopack, app router) · Supabase (Postgres + RLS +
Auth) · Vercel (hosting + cron) · Sleeper API (league data) · nflverse (NFL
stats) · FantasyCalc (market values) · Resend (email) · Stripe (billing) ·
Tailwind v4.

---

## State of the build

### Core scoring (DPV/PYV pipeline)

- **EPA-per-opportunity efficiency multiplier** baked into PYV chain. Bounded
  ±15%, calibrated from real 2024 nflverse distributions per position.
  Recalibrate by running `scripts/inspect-advanced-stats.ts` annually.
- **Historical backfill** of 2013-2025 seasons stored in `dpv_history` (NFL
  season+week anchored).
- **`CURRENT_SEASON` auto-derives** from calendar — flips March 1 each year
  (the previous September's season is now fully complete). Override via
  `DPV_CURRENT_SEASON` env var for backfills.

### UI surface

- **Public marketing landing at `/`** — hero ("Stop guessing whether to
  trade") + live rankings teaser (RLS-allowed for anon) + closing CTA for
  guests. Members get the Rankings home directly.
- **Auth panel** beside login + signup forms — Free vs Pro feature breakdown
  alongside the form so users coming straight from the home hero or a
  bookmark don't lose marketing context.
- **Mobile polish**: hamburger nav, responsive table column hiding via
  `hidden sm:table-cell` / `hidden md:table-cell` patterns, `active:` touch
  feedback states.
- **"Eff" column** on rankings — % above/below position-average EPA per
  opportunity. Color-coded green/red. Inline on phone summary line, full
  column on tablet+.
- **Pro position cards** on player detail pages, position-specific:
  - WR/TE → Receiving profile (aDOT trend + YAC-per-reception trend)
  - RB → Rushing profile (EPA-per-carry + Carries volume)
  - QB → Passing profile (EPA-per-dropback + Dropbacks volume)
  - Each card has Pro upsell teaser for free users; faded dots on
    sub-threshold sample seasons; zero-line baseline for EPA charts.

### PWA — fully shipped

- Manifest at `/manifest.webmanifest`, square (192/512) + maskable icons,
  apple-touch-icon (180×180).
- Service worker (`public/sw.js`): network-first navigation, offline shell at
  `/offline`. SW registers in production only.
- **In-app Install button** (mobile sheet + desktop header) with **dismiss
  ✕ + 30-day TTL** stored in localStorage; `getInstalledRelatedApps()`
  detection so users who installed via Chrome's own ⋮ menu don't re-see the
  CTA.
- iOS Safari fallback: clicking the button reveals manual "Add to Home
  Screen" instructions (Apple won't let JS trigger install dialogs).
- Manifest screenshots (1280×720 wide + 1080×1920 narrow) for Chrome's
  richer install dialog.
- `start_url: "/"` works because `/` is publicly reachable.

### Rookies

- Prospects CSV (`data/prospects.csv`) holds per-source mock-draft rankings.
  Multi-source rows for the same `prospect_id` aggregate via
  `compute-prospect-consensus.ts`.
- 2026 class is now ground-truth from `nflverse/draft_picks.csv` (~80
  offensive skill picks) under source label `NFLVERSE_2026_DRAFT`. Pre-draft
  mocks (DRAFTTEK, WALTERFOOTBALL_CAMPBELL) preserved as historical context.
- `scripts/sync-nflverse-draft.ts` runs in the daily refresh; auto-defaults
  to `CURRENT_SEASON + 1` so each year's incoming class auto-pivots without
  manual edits.

### Weekly digest (Friday 14:00 UTC)

Insight-driven, not data-dump. Per league:

- League header with verdict + composite + rank (e.g. "Bubble · 64/100 · 5th of 12")
- **Position strength**: strongest + weakest position with rank + delta-pct
  vs league average
- **This week**: top 3 risers + top 3 fallers in PYV (computed from two most
  recent `dpv_history` snapshot dates)
- **Trade target**: "Look to acquire a TE — you're 38% below league avg"
- **Trade partners at TE**: other rosters with surplus, named with their top
  2-3 players at that position
- **Biggest trade in your league**: Sleeper transactions API, scored by PYV
  swap. Picks valued via `pickDpv` round-average. Includes pick movements in
  Got/Sent display.
- **Biggest league-wide PYV drop**: across all rostered players (not just
  user's roster) — gossip / market-watch signal
- **Sell-window flags**: top 3 SELL_NOW or SELL_SOON on focused team
- "Open league →" CTA

Idempotency: 6-day `MIN_GAP_MS` per user blocks duplicate sends. Override via
`scripts/digest-check.ts --reset @username` or `--reset-all`.

---

## What runs automatically

| Schedule | What | Where |
|---|---|---|
| Daily 11:00 + 23:00 UTC | `npm run refresh` (11 steps in dep order) | `.github/workflows/refresh.yml` |
| After each refresh | `sync-leagues.ts` (Sleeper roster sync) | same workflow |
| Friday 14:00 UTC | `/api/cron/weekly-digest` (Resend send) | `vercel.json` |

**`npm run refresh` order** (each step idempotent; failure halts pipeline):

1. `ingest.py` — nflverse rosters + weekly stats + snaps + EPA/aDOT/YAC + market values
2. `sync-teams.ts` — Sleeper `current_team` refresh
3. `sync-draft-capital.ts` — belt-and-suspenders draft_round/year sync
4. `ingest-combine.ts` — combine + pro day → athleticism scores
5. `sync-nflverse-draft.ts` — actual draft results for incoming class
6. `ingest-prospects.ts data/prospects.csv` — manual CSV → prospects table
7. `compute-prospect-consensus.ts`
8. `compute-class-strength.ts`
9. `compute-hsm.ts` — veteran HSM projections
10. `compute-rookie-hsm.ts`
11. `compute-dpv.ts` — final PYV with efficiency multiplier

---

## Operational scripts (manual triggers)

| Command | Purpose |
|---|---|
| `npx tsx scripts/digest-check.ts` | Diagnostic: per-user opt-in / last-sent / leagues |
| `... --send` | Manual fire `/api/cron/weekly-digest` |
| `... --reset @username` | Clear one user's `last_digest_sent_at` |
| `... --reset-all` | Clear every opted-in user's timestamp |
| `... --preview @username > preview.html` | Build digest HTML locally; field-presence dump on stderr |
| `npx tsx scripts/sync-nflverse-draft.ts [year]` | Pull actual draft results |
| `npx tsx scripts/inspect-advanced-stats.ts` | EPA distribution per position (calibration check) |
| `npx tsx scripts/preview-efficiency-impact.ts` | In-memory before/after rank diff for algorithm changes |
| `npx tsx scripts/diff-recent-ranks.ts` | Compare two most recent dpv_history dates |
| `./.venv/Scripts/python.exe scripts/ingest.py` | Manual nflverse ingest (Windows venv path) |

---

## Critical environment

- **`.env.local`** must contain: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY`,
  `CRON_SECRET` (Vercel marks this "Sensitive" — pull via `vercel env pull`),
  Resend + Stripe keys.
- **Python venv** at `.venv/Scripts/python.exe` (Windows). Activate before
  running `scripts/ingest.py`.
- **Node 20+**, Tailwind v4, Next.js 16.

---

## Live operational state

- **3 opted-in digest users**: @Quailman (Admin), @Vito8675309, @johnsticle.
- **prospect_consensus**:
  - 2026 = ~80 actual draft picks + DRAFTTEK + Walter Football aggregated
  - 2027 = 17 prospects across NBADRAFTROOM_MOCK + WALTERFOOTBALL_CAMPBELL
- **dpv_history**: backfilled 2013-2025; live row appended each `compute-dpv` run.
- **player_advanced_stats**: 2024 fully ingested with EPA + aDOT + YAC.

---

## Open items / known polish

- **Claude Design integration** — possibly for pitch deck, marketing visuals,
  or UI mockups. Discovered late in this session, not yet scoped.
- **Failure visibility** — workflow failures email the repo owner only;
  consider Slack/Discord webhook for higher-signal alerting.
- **Smarter cron schedule** — twice-daily refresh is overkill in offseason;
  could drop to once daily Mar-Aug.
- **3-strikes alert** — single failure mails out, but consecutive failures
  signal a real outage and should escalate.
- **`.compute-dpv.log`** keeps showing in `git status`; should be gitignored.
- **Random debug scripts** in `scripts/` (`brooks-check.ts`,
  `analyze-3way-trade.ts`, etc.) — not in production paths, can be cleaned up
  or committed.

### Mobile app paths (costed but not pursued)

- PWA already shipped — $0.
- Capacitor wrapper — ~$125 first year ($99 Apple Developer + $25 Google
  Play one-time), then $99/yr.
- Native rewrite — same store fees + 2-3 months of dev time.
- **Apple's 15-30% IAP cut** is the hidden cost — would meaningfully eat into
  Pro subscription revenue if Pylon launches a wrapped iOS app.

---

## Architectural decisions worth remembering

- **Supabase `.in()` filter has a URL-length limit.** Once a query needs
  > ~50 ids in `.in()`, it can quietly return zero rows with no error.
  Pull broader and filter in memory. Burned us on the digest league-loser
  section twice; the lesson is in `digest-check.ts`'s preview-mode comment.
- **Sleeper transactions are partitioned by NFL "round" / week.** During
  offseason Sleeper keeps the league at the most recent regular-season week
  number. We query current + previous week to cover boundary trades.
- **dpv_history snapshot dates accumulate fast.** Don't try to detect
  distinct dates by `.select("snapshot_date").limit(N)` — N rows can all be
  the same date if the per-date row count exceeds N. Detect via a player-
  narrowed query (focused roster's ~25 ids per date) instead.
- **PYV efficiency multiplier defaults to 1.0 when no data.** A rookie or
  depth piece with no EPA samples is never *penalized* for missing data;
  the multiplier just stays neutral.
- **Pylon's PYV opportunity score for QBs is hardcoded to 1.0.** That's why
  the new PassingProfileCard's volume chart matters — it's the only UI
  surface that exposes QB role-confidence shifts (backups gaining
  dropbacks, starters losing them).

---

## Reading order for a fresh session

If this doc is being read by a new session resuming Pylon work, scan in this
order:

1. **`AGENTS.md`** — repo conventions
2. **`CLAUDE.md`** — repo's per-Claude-session instructions
3. **`src/lib/dpv/dpv.ts`** — core PYV calculation (modifier chain)
4. **`src/lib/dpv/efficiency.ts`** — most recent ranking-algorithm change
5. **`scripts/refresh-all.ts`** — what runs nightly
6. **`scripts/digest-check.ts`** — most-touched operational tool
7. **`src/app/page.tsx`** + **`src/app/league/[id]/page.tsx`** — biggest user-
   facing surfaces; both have inline comments explaining their data flow.
