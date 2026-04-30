// Landing-spot analyzer: turns the same inputs the rookie prior already
// uses (draft round, O-line, QB tier, age) plus a depth-chart competition
// signal into human-readable pro/con bullets.
//
// Pure function — no DB calls. The page passes in current_team teammates
// (same position) and the most-recent team_seasons row. Capital weighting
// is built in: a 1st-round WR landing in a stacked room reads "crowded but
// will play"; a 6th-round WR in the same room reads "buried."

export type LandingSpotTone = "pro" | "con" | "neutral";

export type LandingSpotBullet = {
  tone: LandingSpotTone;
  title: string;
  detail: string;
  /** Higher = more important. UI sorts desc and shows top N. */
  weight: number;
};

export type LandingSpotInput = {
  position: string;
  team: string | null;
  draftRound: number | null;
  draftYear: number | null;
  /** Decimal years; pass null if we don't have birthdate. */
  age: number | null;
  /** Same-position teammates on `team`. Do not include the subject player. */
  teammates: Array<{
    name: string;
    age: number | null;
    dpv: number;
  }>;
  /** Most recent team_seasons row for `team`. Null if missing. */
  teamContext: {
    /** 1 (best) … 32 (worst). */
    olineRank: number | null;
    /** 1 (best) … 5 (worst). */
    qbTier: number | null;
  } | null;
  /** True for rookies + 2nd-year players with no qualifying NFL season. */
  isRookieProfile: boolean;
  /** Subject player's own DPV. Used so the depth-chart logic only flags
   *  teammates as "ahead" when their DPV is meaningfully above the
   *  subject's — otherwise an established alpha (e.g., Amon-Ra) gets
   *  incorrectly told a clearly-lesser teammate is "the incumbent."
   *  Default 0 = treat the subject as a non-factor (correct for raw
   *  pre-draft prospects with no production yet). */
  subjectDpv?: number;
};

// DPV thresholds for "starter-caliber" by position. Calibrated against the
// current snapshot scale where a fantasy WR3 (top-36) sits ~2500, a clear
// WR1 ~5000+, an RB1 ~4500+, a TE1 ~3500+. We pick a level that means
// "this player has a real role in the offense" — so a rookie behind them
// has to displace, not just walk in.
const STARTER_DPV: Record<string, number> = {
  QB: 3000,
  RB: 2500,
  WR: 2500,
  TE: 2000,
};

// Age at which an incumbent starts to look replaceable in dynasty.
const VETERAN_AGE: Record<string, number> = {
  QB: 33,
  RB: 28,
  WR: 30,
  TE: 30,
};

export function analyzeLandingSpot(
  input: LandingSpotInput,
): LandingSpotBullet[] {
  const bullets: LandingSpotBullet[] = [];
  const pos = input.position.toUpperCase();

  // ── A. Draft Capital ────────────────────────────────────────────────
  // Only meaningful for rookies + early-career players still searching
  // for a qualifying season. Once a player has produced ≥1 real NFL
  // year, draft round is stale signal — their BPS / opportunity score
  // already encodes everything it tried to predict. Surfacing
  // "Round-4 pick" on a 5th-year alpha is just noise.
  if (input.isRookieProfile && input.draftRound !== null) {
    const r = input.draftRound;
    if (r === 1) {
      bullets.push({
        tone: "pro",
        weight: 9,
        title: "First-round capital",
        detail:
          "Teams play first-rounders through rough starts — high job security and an early role baked in.",
      });
    } else if (r === 2) {
      bullets.push({
        tone: "pro",
        weight: 7,
        title: "Second-round capital",
        detail:
          "Solid investment — expect early opportunity, even if it isn't a featured role year 1.",
      });
    } else if (r === 3) {
      bullets.push({
        tone: "neutral",
        weight: 5,
        title: "Day-2 capital",
        detail:
          "Drafted with a real role in mind, but the players above on the depth chart still have priority.",
      });
    } else if (r <= 5) {
      bullets.push({
        tone: "neutral",
        weight: 4,
        title: `Round-${r} pick`,
        detail:
          "Has to earn touches — production-dependent path to a meaningful role.",
      });
    } else {
      bullets.push({
        tone: "con",
        weight: 5,
        title: `Late-round flier (R${r})`,
        detail:
          "Dynasty bench bet; needs an injury, scheme fit, or breakout camp to matter.",
      });
    }
  }

  // ── B. Depth Chart Competition ─────────────────────────────────────
  // The headline insight: a 1st-rounder buried on a deep chart still
  // plays; a 4th-rounder behind one starter probably doesn't.
  //
  // A teammate is only a "blocker" when (a) they're starter-caliber for
  // the position AND (b) their DPV is meaningfully above the subject's.
  // The second condition is what stops Amon-Ra (6421 DPV) from being
  // told Jameson Williams (~3000 DPV) is "ahead" of him — the established
  // alpha doesn't have anyone ahead of him on his own depth chart.
  const threshold = STARTER_DPV[pos] ?? 4500;
  const subjectDpv = input.subjectDpv ?? 0;
  const blockers = input.teammates
    .filter((t) => t.dpv >= threshold && t.dpv > subjectDpv)
    .sort((a, b) => b.dpv - a.dpv);
  const hasCapital =
    input.draftRound !== null && input.draftRound <= 2;

  if (blockers.length === 0) {
    bullets.push({
      tone: "pro",
      weight: 8,
      title: "Open depth chart",
      detail: `No starter-caliber ${pos} ahead on the roster — pathway to immediate volume.`,
    });
  } else if (blockers.length === 1) {
    const top = blockers[0];
    if (hasCapital) {
      bullets.push({
        tone: "neutral",
        weight: 6,
        title: "One starter ahead",
        detail: `${top.name} is the incumbent. Capital says you'll get a real role anyway; displacement plausible within 1–2 years.`,
      });
    } else {
      bullets.push({
        tone: "con",
        weight: 5,
        title: "One starter ahead",
        detail: `${top.name} is the incumbent. Without high draft capital, hard to dislodge without an injury.`,
      });
    }
    // Incumbent age — when the starter is aging, it's a successor-path pro.
    const vetAge = VETERAN_AGE[pos] ?? 30;
    if (top.age !== null && top.age >= vetAge) {
      bullets.push({
        tone: "pro",
        weight: 6,
        title: "Aging incumbent",
        detail: `${top.name} is ${top.age.toFixed(0)} — successor path opens within 1–2 seasons.`,
      });
    }
  } else {
    // 2+ blockers
    const names = blockers
      .slice(0, 2)
      .map((b) => b.name)
      .join(" + ");
    if (hasCapital) {
      bullets.push({
        tone: "con",
        weight: 6,
        title: "Crowded depth chart",
        detail: `Two starter-grade ${pos}s ahead (${names}). Capital should still net snaps, but year-1 volume is capped.`,
      });
    } else {
      bullets.push({
        tone: "con",
        weight: 7,
        title: "Buried on depth chart",
        detail: `${blockers.length} starter-grade ${pos}s ahead (${names}). Without high capital, no obvious path to touches.`,
      });
    }
  }

  // ── C. O-Line (RB only — barely moves WR/TE/QB in our model) ───────
  if (
    pos === "RB" &&
    input.teamContext?.olineRank !== null &&
    input.teamContext?.olineRank !== undefined
  ) {
    const rank = input.teamContext.olineRank;
    if (rank <= 8) {
      bullets.push({
        tone: "pro",
        weight: 6,
        title: "Top-tier run-blocking",
        detail: `O-line ranks #${rank} — yards before contact well above average, the back gets honest looks.`,
      });
    } else if (rank >= 25) {
      bullets.push({
        tone: "con",
        weight: 5,
        title: "Bottom-tier run-blocking",
        detail: `O-line ranks #${rank} — yards before contact below average, ceiling capped regardless of talent.`,
      });
    }
  }

  // ── D. QB Quality (WR/TE — biggest target on receiving outcomes) ───
  if (
    (pos === "WR" || pos === "TE") &&
    input.teamContext?.qbTier !== null &&
    input.teamContext?.qbTier !== undefined
  ) {
    const tier = input.teamContext.qbTier;
    if (tier <= 2) {
      bullets.push({
        tone: "pro",
        weight: 6,
        title: tier === 1 ? "Elite QB inflates targets" : "Above-average QB",
        detail:
          tier === 1
            ? "Tier-1 starter — receiving fantasy lifts with the QB's ceiling."
            : "Tier-2 QB room; receiving ceiling held up by passing efficiency.",
      });
    } else if (tier >= 4) {
      bullets.push({
        tone: "con",
        weight: 6,
        title:
          tier === 5 ? "Bottom-tier QB caps ceiling" : "Below-average QB",
        detail:
          "Receiving production capped until the QB room improves — talent alone can't carry inefficient passing.",
      });
    }
  }

  // ── E. Age profile (rookie/no-production only) ─────────────────────
  // Vets get aging baked into BPS via the age curve already; surfacing
  // it here would just be noise.
  if (input.isRookieProfile && input.age !== null) {
    if (input.age < 22) {
      bullets.push({
        tone: "pro",
        weight: 4,
        title: "Young entry",
        detail: `Age ${input.age.toFixed(1)} — extra runway on the dynasty arc.`,
      });
    } else if (input.age >= 24) {
      bullets.push({
        tone: "con",
        weight: 4,
        title: "Older entry",
        detail: `Age ${input.age.toFixed(1)} — dynasty discount; window is narrower than a 21-year-old's.`,
      });
    }
  }

  return bullets;
}

// Convenience: net tone summary across all bullets, weighted. Useful for a
// header pill ("Strong landing", "Mixed", "Tough spot"). Returns null if
// there are no bullets.
export function summarizeLandingSpot(
  bullets: LandingSpotBullet[],
): { label: string; tone: LandingSpotTone } | null {
  if (bullets.length === 0) return null;
  let score = 0;
  let totalWeight = 0;
  for (const b of bullets) {
    const sign = b.tone === "pro" ? 1 : b.tone === "con" ? -1 : 0;
    score += sign * b.weight;
    totalWeight += b.weight;
  }
  const norm = totalWeight === 0 ? 0 : score / totalWeight;
  if (norm >= 0.35) return { label: "Strong landing", tone: "pro" };
  if (norm >= 0.1) return { label: "Favorable landing", tone: "pro" };
  if (norm > -0.1) return { label: "Mixed landing", tone: "neutral" };
  if (norm > -0.35) return { label: "Difficult landing", tone: "con" };
  return { label: "Tough spot", tone: "con" };
}
