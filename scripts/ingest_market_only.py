"""Run only the market_values ingestion step. Requires rosters endpoint
reachable (to build the sleeper_id → gsis_id crosswalk)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ingest import ingest_rosters, ingest_market_values, SEASONS, SUPABASE_SECRET_KEY


def main() -> None:
    if SUPABASE_SECRET_KEY in ("", "PASTE_YOUR_SECRET_KEY_HERE"):
        print("ERROR: SUPABASE_SECRET_KEY not set in .env.local")
        sys.exit(1)
    _, sleeper_to_gsis = ingest_rosters(SEASONS)
    ingest_market_values(sleeper_to_gsis)
    print("Done.")


if __name__ == "__main__":
    main()
