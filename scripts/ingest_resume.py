"""Resume ingest after the dedup fix — skips rosters/seasons (already done),
re-runs snaps (with dedup), team context, and market values."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ingest import (
    ingest_rosters,
    ingest_snaps,
    ingest_team_context,
    ingest_market_values,
    SEASONS,
    SUPABASE_SECRET_KEY,
)


def main() -> None:
    if SUPABASE_SECRET_KEY in ("", "PASTE_YOUR_SECRET_KEY_HERE"):
        print("ERROR: SUPABASE_SECRET_KEY not set in .env.local")
        sys.exit(1)
    # Re-run rosters to rebuild the crosswalks (cheap, idempotent upsert).
    pfr_to_gsis, sleeper_to_gsis = ingest_rosters(SEASONS)
    ingest_snaps(SEASONS, pfr_to_gsis)
    ingest_team_context(SEASONS)
    ingest_market_values(sleeper_to_gsis)
    print("Done.")


if __name__ == "__main__":
    main()
