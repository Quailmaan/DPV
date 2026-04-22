"""Ingest nflverse data into Supabase for the DPV engine.

Fetches parquet files directly from the nflverse GitHub releases (new schema),
bypassing nfl_data_py which still uses the old URL paths.

Run:
    ./.venv/Scripts/python.exe scripts/ingest.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pandas as pd
import requests
from dotenv import load_dotenv
from supabase import create_client

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env.local")

SUPABASE_URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
SUPABASE_SECRET_KEY = os.environ["SUPABASE_SECRET_KEY"]
SEASONS = [2021, 2022, 2023, 2024, 2025]
POSITIONS = {"QB", "RB", "WR", "TE"}
BATCH = 500

NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download"

sb = create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)


def batched_upsert(table: str, rows: list[dict], on_conflict: str | None = None) -> None:
    if not rows:
        print(f"  {table}: nothing to upsert")
        return
    for i in range(0, len(rows), BATCH):
        chunk = rows[i : i + BATCH]
        q = (
            sb.table(table).upsert(chunk, on_conflict=on_conflict)
            if on_conflict
            else sb.table(table).upsert(chunk)
        )
        q.execute()
    print(f"  {table}: upserted {len(rows)} rows")


def fetch_all_rows(table: str, columns: str) -> list[dict]:
    rows: list[dict] = []
    page = 1000
    start = 0
    while True:
        resp = sb.table(table).select(columns).range(start, start + page - 1).execute()
        batch = resp.data or []
        rows.extend(batch)
        if len(batch) < page:
            break
        start += page
    return rows


def fetch_weekly(year: int) -> pd.DataFrame:
    url = f"{NFLVERSE}/stats_player/stats_player_week_{year}.parquet"
    df = pd.read_parquet(url)
    df = df[df["season_type"] == "REG"].copy() if "season_type" in df.columns else df
    return df


def fetch_rosters(year: int) -> pd.DataFrame:
    url = f"{NFLVERSE}/rosters/roster_{year}.parquet"
    return pd.read_parquet(url)


def fetch_snaps(year: int) -> pd.DataFrame:
    url = f"{NFLVERSE}/snap_counts/snap_counts_{year}.parquet"
    return pd.read_parquet(url)


def half_ppr_points(row) -> float:
    return (
        0.04 * (row.get("passing_yards") or 0)
        + 4 * (row.get("passing_tds") or 0)
        - 2 * (row.get("passing_interceptions") or row.get("interceptions") or 0)
        + 0.1 * (row.get("rushing_yards") or 0)
        + 6 * (row.get("rushing_tds") or 0)
        + 0.1 * (row.get("receiving_yards") or 0)
        + 6 * (row.get("receiving_tds") or 0)
        + 0.5 * (row.get("receptions") or 0)
        - 2 * (row.get("rushing_fumbles_lost") or 0)
        - 2 * (row.get("receiving_fumbles_lost") or 0)
        - 2 * (row.get("sack_fumbles_lost") or 0)
    )


def ingest_rosters(seasons: list[int]) -> tuple[dict[str, str], dict[str, str]]:
    print("Loading rosters...")
    dfs = []
    for y in seasons:
        try:
            d = fetch_rosters(y)
            d["_season"] = y
            dfs.append(d)
            print(f"  {y}: {len(d)} roster rows")
        except Exception as e:
            print(f"  {y}: FAILED ({e})")
    rosters = pd.concat(dfs, ignore_index=True)
    rosters = rosters[rosters["position"].isin(POSITIONS)].copy()

    name_col = "full_name" if "full_name" in rosters.columns else "player_name"
    id_col = "gsis_id" if "gsis_id" in rosters.columns else "player_id"
    team_col = "team" if "team" in rosters.columns else "recent_team"

    rosters["birthdate"] = pd.to_datetime(rosters.get("birth_date"), errors="coerce")

    pfr_to_gsis: dict[str, str] = {}
    if "pfr_id" in rosters.columns:
        for _, r in rosters.iterrows():
            pfr = r.get("pfr_id")
            gsis = r.get(id_col)
            if pd.notna(pfr) and pd.notna(gsis):
                pfr_to_gsis[str(pfr)] = str(gsis)
        print(f"  crosswalk: {len(pfr_to_gsis)} pfr_id -> gsis_id mappings")

    sleeper_to_gsis: dict[str, str] = {}
    if "sleeper_id" in rosters.columns:
        for _, r in rosters.iterrows():
            sleeper = r.get("sleeper_id")
            gsis = r.get(id_col)
            if pd.notna(sleeper) and pd.notna(gsis):
                sleeper_to_gsis[str(sleeper)] = str(gsis)
        print(f"  crosswalk: {len(sleeper_to_gsis)} sleeper_id -> gsis_id mappings")

    latest = rosters.sort_values("_season").groupby(id_col).tail(1)
    players = []
    for _, r in latest.iterrows():
        pid = r[id_col]
        name = r[name_col]
        if pd.isna(pid) or pd.isna(name):
            continue
        round_val = r.get("entry_year")
        players.append(
            {
                "player_id": pid,
                "name": name,
                "position": r["position"],
                "birthdate": None if pd.isna(r["birthdate"]) else r["birthdate"].date().isoformat(),
                "draft_round": None,
                "draft_year": None if pd.isna(round_val) else int(round_val) if round_val else None,
                "current_team": r.get(team_col) if team_col in r.index else None,
            }
        )
    print(f"  {len(players)} unique players")
    batched_upsert("players", players, on_conflict="player_id")
    return pfr_to_gsis, sleeper_to_gsis


def ingest_seasons(seasons: list[int], pfr_to_gsis: dict[str, str] | None = None) -> None:
    print("Loading weekly stats (all seasons)...")
    frames = []
    for y in seasons:
        try:
            w = fetch_weekly(y)
            w["_season"] = y
            frames.append(w)
            print(f"  {y} weekly: {len(w)} rows")
        except Exception as e:
            print(f"  {y} weekly: FAILED ({e})")
    weekly = pd.concat(frames, ignore_index=True)

    if "season" not in weekly.columns:
        weekly["season"] = weekly["_season"]
    if "position" not in weekly.columns and "position_group" in weekly.columns:
        weekly["position"] = weekly["position_group"]
    weekly = weekly[weekly["position"].isin(POSITIONS)].copy()

    weekly["pass_int"] = weekly.get("passing_interceptions", weekly.get("interceptions", 0))
    weekly["fum_lost"] = (
        weekly.get("rushing_fumbles_lost", 0).fillna(0)
        + weekly.get("receiving_fumbles_lost", 0).fillna(0)
        + weekly.get("sack_fumbles_lost", 0).fillna(0)
    )
    weekly["half_ppr"] = weekly.apply(half_ppr_points, axis=1)

    team_col = "team" if "team" in weekly.columns else "recent_team"

    agg = (
        weekly.groupby(["player_id", "season"])
        .agg(
            games_played=("week", "nunique"),
            team=(team_col, lambda s: s.mode().iat[0] if not s.mode().empty else None),
            passing_yards=("passing_yards", "sum"),
            passing_tds=("passing_tds", "sum"),
            interceptions=("pass_int", "sum"),
            rushing_yards=("rushing_yards", "sum"),
            rushing_tds=("rushing_tds", "sum"),
            receptions=("receptions", "sum"),
            targets=("targets", "sum"),
            carries=("carries", "sum"),
            receiving_yards=("receiving_yards", "sum"),
            receiving_tds=("receiving_tds", "sum"),
            fumbles_lost=("fum_lost", "sum"),
        )
        .reset_index()
    )

    weekly_points = (
        weekly.sort_values("week")
        .groupby(["player_id", "season"])["half_ppr"]
        .apply(lambda s: [float(x) for x in s.tolist()])
        .to_dict()
    )

    team_tgt = (
        weekly[weekly["position"].isin(["WR", "TE", "RB"])]
        .groupby(["season", team_col])["targets"]
        .sum()
        .reset_index()
        .rename(columns={"targets": "team_targets", team_col: "_team"})
    )
    team_car = (
        weekly[weekly["position"] == "RB"]
        .groupby(["season", team_col])["carries"]
        .sum()
        .reset_index()
        .rename(columns={"carries": "team_carries", team_col: "_team"})
    )
    team_totals = team_tgt.merge(team_car, on=["season", "_team"], how="outer").fillna(0)

    existing_ids = {p["player_id"] for p in fetch_all_rows("players", "player_id")}
    print(f"  {len(existing_ids)} eligible player IDs in DB")

    rows = []
    for _, r in agg.iterrows():
        pid = r["player_id"]
        if pid not in existing_ids:
            continue
        season = int(r["season"])
        team = r["team"]

        tt = team_totals[(team_totals["season"] == season) & (team_totals["_team"] == team)]
        tt_targets = float(tt["team_targets"].iat[0]) if not tt.empty else 0.0
        tt_carries = float(tt["team_carries"].iat[0]) if not tt.empty else 0.0

        tgt = float(r["targets"] or 0)
        car = float(r["carries"] or 0)
        target_share = (tgt / tt_targets * 100) if tt_targets > 0 else None
        opp_share = ((tgt + car) / (tt_targets + tt_carries) * 100) if (tt_targets + tt_carries) > 0 else None

        rows.append(
            {
                "player_id": pid,
                "season": season,
                "team": team,
                "games_played": int(r["games_played"] or 0),
                "passing_yards": int(r["passing_yards"] or 0),
                "passing_tds": int(r["passing_tds"] or 0),
                "interceptions": int(r["interceptions"] or 0),
                "rushing_yards": int(r["rushing_yards"] or 0),
                "rushing_tds": int(r["rushing_tds"] or 0),
                "receptions": int(r["receptions"] or 0),
                "receiving_yards": int(r["receiving_yards"] or 0),
                "receiving_tds": int(r["receiving_tds"] or 0),
                "fumbles_lost": int(r["fumbles_lost"] or 0),
                "target_share_pct": round(target_share, 2) if target_share is not None else None,
                "opportunity_share_pct": round(opp_share, 2) if opp_share is not None else None,
                "weekly_fantasy_points_half": weekly_points.get((pid, season)),
            }
        )
    print(f"  {len(rows)} player-season rows")
    batched_upsert("player_seasons", rows, on_conflict="player_id,season")


def ingest_snaps(seasons: list[int], pfr_to_gsis: dict[str, str]) -> None:
    print("Loading snap counts...")
    frames = []
    for y in seasons:
        try:
            d = fetch_snaps(y)
            d["_season"] = y
            frames.append(d)
            print(f"  {y} snaps: {len(d)} rows")
        except Exception as e:
            print(f"  {y} snaps: FAILED ({e})")
    if not frames:
        return
    snaps = pd.concat(frames, ignore_index=True)

    if "season" not in snaps.columns:
        snaps["season"] = snaps["_season"]
    if "offense_pct" not in snaps.columns:
        print("  no offense_pct column; skipping snap share update")
        return

    snaps = snaps[snaps["position"].isin(POSITIONS)].copy()
    snaps["offense_pct"] = pd.to_numeric(snaps["offense_pct"], errors="coerce")

    avg = (
        snaps[snaps["offense_pct"].notna()]
        .groupby(["pfr_player_id", "season", "player"])["offense_pct"]
        .mean()
        .reset_index()
    )

    existing = fetch_all_rows("players", "player_id,name")
    name_to_id = {p["name"].lower(): p["player_id"] for p in existing}

    updates = []
    matched_pfr = 0
    matched_name = 0
    unmatched = 0
    for _, r in avg.iterrows():
        pfr = str(r["pfr_player_id"]) if pd.notna(r["pfr_player_id"]) else None
        pid = pfr_to_gsis.get(pfr) if pfr else None
        if pid:
            matched_pfr += 1
        else:
            name = r.get("player")
            if isinstance(name, str):
                pid = name_to_id.get(name.lower())
                if pid:
                    matched_name += 1
        if not pid:
            unmatched += 1
            continue
        pct = float(r["offense_pct"])
        if pct <= 1.0:
            pct *= 100
        updates.append({"player_id": pid, "season": int(r["season"]), "snap_share_pct": round(pct, 2)})

    print(f"  {len(updates)} snap-share updates (pfr:{matched_pfr}, name:{matched_name}, unmatched:{unmatched})")
    applied = 0
    for u in updates:
        sb.table("player_seasons").update({"snap_share_pct": u["snap_share_pct"]}).eq(
            "player_id", u["player_id"]
        ).eq("season", u["season"]).execute()
        applied += 1
        if applied % 500 == 0:
            print(f"  ... {applied}/{len(updates)} applied")
    print(f"  snap shares applied: {applied}")


def ingest_team_context(seasons: list[int]) -> None:
    print("Computing team-season context (QB tier)...")
    frames = []
    for y in seasons:
        try:
            w = fetch_weekly(y)
            w["_season"] = y
            frames.append(w)
        except Exception:
            continue
    weekly = pd.concat(frames, ignore_index=True)

    if "season" not in weekly.columns:
        weekly["season"] = weekly["_season"]
    team_col = "team" if "team" in weekly.columns else "recent_team"
    weekly["pass_int"] = weekly.get("passing_interceptions", weekly.get("interceptions", 0))
    weekly["fum_lost"] = (
        weekly.get("rushing_fumbles_lost", 0).fillna(0)
        + weekly.get("receiving_fumbles_lost", 0).fillna(0)
        + weekly.get("sack_fumbles_lost", 0).fillna(0)
    )
    weekly["half_ppr"] = weekly.apply(half_ppr_points, axis=1)

    qbs = weekly[weekly["position"] == "QB"].copy()
    qb_stats = (
        qbs.groupby(["season", team_col, "player_id"])
        .agg(games=("week", "nunique"), total=("half_ppr", "sum"))
        .reset_index()
    )
    qb_stats = qb_stats[qb_stats["games"] >= 4].copy()
    qb_stats["ppg"] = qb_stats["total"] / qb_stats["games"]
    team_qb = (
        qb_stats.sort_values(["season", team_col, "games"], ascending=[True, True, False])
        .groupby(["season", team_col])
        .head(1)
    )

    def qb_tier(ppg: float) -> int:
        if ppg >= 22:
            return 1
        if ppg >= 18:
            return 2
        if ppg >= 14:
            return 3
        if ppg >= 10:
            return 4
        return 5

    rbs = weekly[weekly["position"] == "RB"].copy()
    rbs["carries"] = pd.to_numeric(rbs.get("carries"), errors="coerce").fillna(0)
    rbs["rushing_yards"] = pd.to_numeric(rbs.get("rushing_yards"), errors="coerce").fillna(0)
    rb_team = (
        rbs.groupby(["season", team_col])
        .agg(team_carries=("carries", "sum"), team_rush_yd=("rushing_yards", "sum"))
        .reset_index()
    )
    rb_team = rb_team[rb_team["team_carries"] >= 50].copy()
    rb_team["ypc"] = rb_team["team_rush_yd"] / rb_team["team_carries"]
    rb_team["oline_rank"] = (
        rb_team.groupby("season")["ypc"].rank(ascending=False, method="min").astype(int)
    )
    oline_idx: dict[tuple[str, int], int] = {}
    for _, r in rb_team.iterrows():
        oline_idx[(r[team_col], int(r["season"]))] = int(r["oline_rank"])

    rows = []
    for _, r in team_qb.iterrows():
        team = r[team_col]
        if pd.isna(team):
            continue
        season = int(r["season"])
        rows.append(
            {
                "team": team,
                "season": season,
                "qb_tier": qb_tier(float(r["ppg"])),
                "oline_composite_rank": oline_idx.get((team, season)),
                "team_offense_rank": None,
            }
        )
    print(f"  {len(rows)} team-season rows (oline ranks: {sum(1 for r in rows if r['oline_composite_rank'] is not None)})")
    batched_upsert("team_seasons", rows, on_conflict="team,season")


FC_BASE = "https://api.fantasycalc.com/values/current"
FC_FORMATS = {
    "STANDARD": {"isDynasty": "true", "numQbs": "1", "ppr": "0"},
    "HALF_PPR": {"isDynasty": "true", "numQbs": "1", "ppr": "0.5"},
    "FULL_PPR": {"isDynasty": "true", "numQbs": "1", "ppr": "1"},
}


def fetch_fantasycalc(params: dict[str, str]) -> list[dict]:
    r = requests.get(FC_BASE, params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def ingest_market_values(sleeper_to_gsis: dict[str, str]) -> None:
    print("Loading FantasyCalc dynasty values...")
    existing = fetch_all_rows("players", "player_id,name,position")
    name_pos_to_id = {
        (p["name"].lower(), p.get("position") or ""): p["player_id"] for p in existing
    }

    rows = []
    for fmt, params in FC_FORMATS.items():
        try:
            data = fetch_fantasycalc(params)
        except Exception as e:
            print(f"  {fmt}: FAILED ({e})")
            continue
        print(f"  {fmt}: {len(data)} players from FantasyCalc")

        matched_sleeper = 0
        matched_name = 0
        unmatched = 0
        for entry in data:
            p = entry.get("player") or {}
            position = p.get("position")
            if position not in POSITIONS:
                continue
            sleeper = p.get("sleeperId")
            pid = sleeper_to_gsis.get(str(sleeper)) if sleeper else None
            if pid:
                matched_sleeper += 1
            else:
                name = p.get("name")
                if isinstance(name, str):
                    pid = name_pos_to_id.get((name.lower(), position))
                    if pid:
                        matched_name += 1
            if not pid:
                unmatched += 1
                continue
            value = entry.get("value")
            rows.append(
                {
                    "player_id": pid,
                    "scoring_format": fmt,
                    "market_value_normalized": float(value) if value is not None else None,
                    "position_rank": entry.get("positionRank"),
                    "overall_rank": entry.get("overallRank"),
                    "source": "fantasycalc",
                }
            )
        print(
            f"    matched sleeper:{matched_sleeper} name:{matched_name} unmatched:{unmatched}"
        )

    batched_upsert("market_values", rows, on_conflict="player_id,scoring_format,source")


def main() -> None:
    if SUPABASE_SECRET_KEY in ("", "PASTE_YOUR_SECRET_KEY_HERE"):
        print("ERROR: SUPABASE_SECRET_KEY not set in .env.local")
        sys.exit(1)
    pfr_to_gsis, sleeper_to_gsis = ingest_rosters(SEASONS)
    ingest_seasons(SEASONS)
    ingest_snaps(SEASONS, pfr_to_gsis)
    ingest_team_context(SEASONS)
    ingest_market_values(sleeper_to_gsis)
    print("Done.")


if __name__ == "__main__":
    main()
