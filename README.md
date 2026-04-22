# DPV — Dynasty Player Valuation

A data-driven dynasty fantasy football valuation engine. Combines weighted
production, position-specific aging curves, opportunity metrics, situation
modifiers, and positional scarcity into a single `DPV` score normalized to
0–10,000.

Built with Next.js, TypeScript, Supabase, and Python (for nflverse ingestion).

## Prerequisites

- Node 20+
- Python 3.11 (not 3.14 — numpy wheels lag)
- A Supabase project (free tier is fine)

## Setup

1. Install dependencies:

   ```bash
   npm install
   py -3.11 -m venv .venv
   ./.venv/Scripts/python -m pip install -r scripts/requirements.txt
   ```

2. Create Supabase project, run `supabase/schema.sql` in the SQL Editor.

3. Fill `.env.local` (copy from `.env.example`):

   ```
   NEXT_PUBLIC_SUPABASE_URL=...
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
   SUPABASE_SECRET_KEY=sb_secret_...
   ```

4. Ingest nflverse data (2021–2025):

   ```bash
   ./.venv/Scripts/python -u scripts/ingest.py
   ```

5. Compute DPV snapshots for all players:

   ```bash
   npx tsx scripts/compute-dpv.ts
   ```

6. Run the dev server:

   ```bash
   npm run dev
   ```

## Architecture

- `src/lib/dpv/` — pure TypeScript formula engine (deterministic, no I/O)
- `src/app/` — Next.js App Router pages (rankings, player detail, methodology)
- `scripts/ingest.py` — fetches nflverse parquet files, writes to Supabase
- `scripts/compute-dpv.ts` — runs the engine over ingested data, writes snapshots
- `supabase/schema.sql` — database schema + RLS policies

## Deploying to Vercel

1. Push this repo to GitHub
2. Import to Vercel
3. Add env vars in Vercel project settings:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
4. Deploy

The ingestion and compute scripts run locally; only pre-computed snapshots
are read by the deployed app.
