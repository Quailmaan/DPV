export default function MethodologyPage() {
  return (
    <div className="prose prose-zinc dark:prose-invert max-w-none">
      <h1 className="text-2xl font-semibold tracking-tight">Methodology</h1>
      <p className="text-zinc-500 text-sm mt-1">
        How the DPV (Dynasty Player Valuation) score is computed.
      </p>

      <section className="mt-6 space-y-4 text-sm leading-6">
        <div>
          <h2 className="font-semibold text-base">Core formula</h2>
          <pre className="bg-zinc-100 dark:bg-zinc-900 rounded-md p-3 overflow-x-auto text-xs">
{`DPV_raw = BPS × AgeMod × Opportunity × OLineMod × QBQuality × BBCS × ScoringFmt
DPV_final = DPV_raw × PositionalScarcity
DPV_normalized = round(DPV_final × 380)  // scaled to 0-10000`}
          </pre>
        </div>

        <div>
          <h2 className="font-semibold text-base">Base Production Score (BPS)</h2>
          <p>
            Recency-weighted fantasy PPG over the last 3 qualifying seasons.
            Weights are position-specific: RB 55/30/15, WR 50/30/20, TE/QB
            45/30/25. A season must have 7+ games played to qualify.
          </p>
        </div>

        <div>
          <h2 className="font-semibold text-base">Age Modifier</h2>
          <p>
            Position-specific aging curves derived from historical peak-season
            data (2000-2025). RBs peak at 24 (mod 1.22), WRs peak 24-25 (1.25),
            TEs peak at 26 (1.22). Curves account for WRs holding ~88% of peak
            through age 30 and the TE "late bloomer" pattern.
          </p>
        </div>

        <div>
          <h2 className="font-semibold text-base">Opportunity Score</h2>
          <p>
            Weighted combination of snap share, target/touch share, and
            vacated-target inheritance. For RBs, "opportunity share" =
            (carries + targets) / team total. For WRs/TEs, target share is the
            stickiest predictor.
          </p>
        </div>

        <div>
          <h2 className="font-semibold text-base">Situation Modifiers</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li>
              <b>O-Line Quality:</b> team rank (1-32 per season) derived from
              RB yards-per-carry (min 50 carries to qualify). Strong effect on
              RBs, weak on QBs/WRs. Note: YPC confounds RB talent and OL
              quality; a future pass will add yards-before-contact from Next
              Gen Stats.
            </li>
            <li>
              <b>QB Quality:</b> 5 tiers by starter fantasy PPG. Strong effect
              on WRs/TEs, near-zero on RBs. Multiplier is damped when QB tier
              is stable across the BPS window to avoid double-counting.
            </li>
            <li>
              <b>Boom/Bust Consistency (BBCS):</b> coefficient of variation on
              weekly fantasy points. Rewards floor, penalizes volatility.
            </li>
          </ul>
        </div>

        <div>
          <h2 className="font-semibold text-base">Positional Scarcity</h2>
          <p>
            Top 3 at position × 1.18, Top 6 × 1.10, Top 12 × 1.00, Top 24 ×
            0.92, below × 0.80. Calibrated to 12-team 1QB leagues.
          </p>
        </div>

        <div>
          <h2 className="font-semibold text-base">Market Calibration</h2>
          <p>
            FantasyCalc dynasty trade values (1QB, same PPR setting) are
            fetched per format and displayed alongside DPV with a delta column.
            Green delta = DPV values the player higher than the market
            (potential buy); red = market values higher (potential sell).
          </p>
        </div>

        <div>
          <h2 className="font-semibold text-base">Planned (v2)</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li>Historical Situation Matching (HSM) — cosine similarity comps</li>
            <li>Multi-year projections with age-adjusted composite</li>
            <li>Percentile-based market delta (normalized across scale gap)</li>
            <li>Yards-before-contact (NGS) as truer OL signal</li>
          </ul>
        </div>
      </section>
    </div>
  );
}
