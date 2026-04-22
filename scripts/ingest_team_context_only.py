"""Re-run only the team_seasons ingestion (qb_tier + oline_composite_rank)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ingest import ingest_team_context, SEASONS, SUPABASE_SECRET_KEY


def main() -> None:
    if SUPABASE_SECRET_KEY in ("", "PASTE_YOUR_SECRET_KEY_HERE"):
        print("ERROR: SUPABASE_SECRET_KEY not set in .env.local")
        sys.exit(1)
    ingest_team_context(SEASONS)
    print("Done.")


if __name__ == "__main__":
    main()
