// Sanity-check the two new signals against the user's reference scenarios.
// Does not touch the DB — pure function calls.
import {
  intraClassDepthAdjust,
  computeRookiePrior,
} from "../src/lib/dpv/rookie-prior";
import { rookieDisplacementModifier } from "../src/lib/dpv/situation";

console.log("\nintraClassDepthAdjust:");
for (const d of [0, 1, 2, 3]) {
  console.log(`  depthIdx=${d} → ${intraClassDepthAdjust(d)}`);
}

console.log("\nrookieDisplacementModifier (priorShare=0.6 workhorse):");
const shares = [0.6, 0.25];
const threats = [
  { label: "R1 top-10 RB arrives (~15.8 PPG threat)", ppg: 15.8 },
  { label: "R3 RB arrives (~3.5 PPG threat)", ppg: 3.5 },
  { label: "R6 RB arrives (~1.2 PPG threat)", ppg: 1.2 },
];
for (const s of shares) {
  console.log(`  priorShare=${s}:`);
  for (const t of threats) {
    const m = rookieDisplacementModifier(t.ppg, s);
    console.log(`    ${t.label} → mult=${m.toFixed(3)} (${((1 - m) * 100).toFixed(0)}% dock)`);
  }
}

console.log("\nSample rookie-prior scenarios (HALF_PPR, R1 RB, age 21.5, OL=10, QB tier 3):");
const base = {
  position: "RB" as const,
  draftRound: 1,
  ageAtDraft: 21.5,
  teamOLineRank: 10,
  qbTier: 3 as const,
  scoringFormat: "HALF_PPR" as const,
  missedSeasons: 0,
  maxGamesPlayed: 0,
};
const a = computeRookiePrior({ ...base, intraClassDepthIdx: 0 });
const b = computeRookiePrior({ ...base, intraClassDepthIdx: 1 });
console.log(`  Alone at position: dpv=${a.dpv}`);
console.log(`  Stacked behind another R1 RB in class: dpv=${b.dpv}`);

console.log("\nLapsed R5 WR with R1 WR arriving on same team (missed=1):");
const lapsedBase = {
  position: "WR" as const,
  draftRound: 5,
  ageAtDraft: 23,
  teamOLineRank: 16,
  qbTier: 3 as const,
  scoringFormat: "HALF_PPR" as const,
  missedSeasons: 1,
  maxGamesPlayed: 4,
};
const noDisplace = computeRookiePrior({
  ...lapsedBase,
  rookieDisplacementMult: 1.0,
});
const r1Arriving = computeRookiePrior({
  ...lapsedBase,
  rookieDisplacementMult: rookieDisplacementModifier(8.5, 0.15),
});
console.log(`  No new rookie: dpv=${noDisplace.dpv}`);
console.log(`  R1 WR (8.5 PPG threat) arrives on team: dpv=${r1Arriving.dpv}`);
