// NFL season + week resolver. Maps a calendar Date to the (season, week)
// it represents so dpv_history rows can be grouped two ways:
//   • by season — for the "career arc" view of a player's value over time
//   • by week within a season — for the in-season "live" trend
//
// Season anchoring rules:
//   • Sept-Dec of year Y          → season Y (regular season)
//   • Jan + Feb 1-15 of year Y+1  → still season Y (playoffs / Super Bowl)
//   • Feb 16+ through August Y+1  → season Y+1 (offseason looking forward;
//                                   week is null because no games yet)
//
// Week numbering within an active season:
//   • Week 1 starts at kickoff (Thursday after Labor Day)
//   • Each week = 7 days starting from kickoff
//   • Caps at week 22 (Super Bowl week). Anything after = offseason
//     (week null, season rolls forward)

export type NflContext = {
  /** NFL season year. 2025 = the 2025-26 season starting Sept 2025. */
  season: number;
  /** 1-22 during the season (1-18 regular, 19-22 playoffs), or null
   *  during the offseason. Null also means "use the season as a single
   *  bucket" — useful for the career-arc view. */
  week: number | null;
};

// First Monday of September for the given year.
function laborDay(year: number): Date {
  const d = new Date(Date.UTC(year, 8, 1)); // Sept 1
  const dow = d.getUTCDay(); // 0 = Sun, 1 = Mon, …, 6 = Sat
  const offset = dow === 1 ? 0 : (8 - dow) % 7;
  d.setUTCDate(1 + offset);
  return d;
}

// NFL Kickoff is the Thursday after Labor Day.
export function nflKickoff(season: number): Date {
  const ld = laborDay(season);
  const k = new Date(ld);
  k.setUTCDate(k.getUTCDate() + 3); // Monday → Thursday
  return k;
}

/** Compute the NFL (season, week) for a given Date. Defaults to now. */
export function nflContext(now: Date = new Date()): NflContext {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0 = Jan
  const d = now.getUTCDate();

  // Jan 1 – Feb 15 → still inside the previous season's playoff window.
  if (m === 0 || (m === 1 && d <= 15)) {
    return { season: y - 1, week: weekWithinSeason(y - 1, now) };
  }

  // Sept – Dec → the current calendar year's regular season.
  if (m >= 8) {
    return { season: y, week: weekWithinSeason(y, now) };
  }

  // Feb 16 – Aug 31 → offseason. Anchor to the upcoming season; null
  // week means "no game data yet, this is a forward-looking snapshot."
  return { season: y, week: null };
}

// How many weeks past kickoff are we? Returns null if the snapshot
// falls outside the active 22-week window for the given season.
//
// The "weeks from kickoff" math doesn't perfectly align with official
// NFL week numbers because there's a Pro Bowl bye between the
// Conference Championship (NFL week 21) and the Super Bowl (NFL week
// 22). So a naive (days/7)+1 calculation puts the Super Bowl at
// "week 23." We clamp that single off-by-one case down to 22 so
// Super Bowl snapshots aren't silently dropped.
function weekWithinSeason(season: number, now: Date): number | null {
  const kickoff = nflKickoff(season);
  const diffMs = now.getTime() - kickoff.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  if (diffDays < 0) return null; // Pre-kickoff (e.g., very early September)
  const week = Math.floor(diffDays / 7) + 1;
  if (week < 1) return null;
  if (week > 23) return null; // Past Super Bowl — true offseason
  return Math.min(week, 22); // Clamp the Pro-Bowl-bye off-by-one
}
