// Position-specific aging cliffs. Shared by the roster report card
// (Window sub-score) and the sell-window indicator. Centralizing here
// so both features stay in lockstep — if we re-tune RB's cliff to 26
// because of a year of new data, both features see it immediately.
//
// Numbers come from positional career-arc literature on PPR fantasy
// production: RBs cliff hardest and earliest, QBs play forever, TEs
// peak slightly later than WRs because route trees grow with experience.
//
//   full  = inside this age, full DPV holds
//   cliff = decline window starts; value tapers
//   gone  = past this, value approximates zero in 2-yr horizon

export type Position = "QB" | "RB" | "WR" | "TE";

export const AGE_CLIFFS: Record<
  Position,
  { full: number; cliff: number; gone: number }
> = {
  QB: { full: 35, cliff: 38, gone: 40 },
  RB: { full: 27, cliff: 29, gone: 31 },
  WR: { full: 30, cliff: 32, gone: 34 },
  TE: { full: 31, cliff: 33, gone: 35 },
};
