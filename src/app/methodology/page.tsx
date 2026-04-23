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
            through age 30 and the TE &ldquo;late bloomer&rdquo; pattern.
          </p>
        </div>

        <div>
          <h2 className="font-semibold text-base">Opportunity Score</h2>
          <p>
            Weighted combination of snap share, target/touch share, and
            vacated-target inheritance. For RBs, &ldquo;opportunity share&rdquo; =
            (carries + targets) / team total. For WRs/TEs, target share is the
            stickiest predictor.
          </p>
        </div>

        <div>
          <h2 className="font-semibold text-base">Situation Modifiers</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li>
              <b>O-Line Quality:</b> team rank (1-32 per season) derived from
              yards-before-contact per rush attempt, pulled from PFR advanced
              stats via nflverse. YBC strips out what the RB does AFTER the
              OL&apos;s job, so it isolates the front-five signal far better
              than raw YPC. Coverage: 2018+, min 100 team attempts; earlier
              seasons fall back to YPC. Strong effect on RBs; we hide the
              row for WR/TE/QB since the multiplier barely moves them.
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

        <div className="pt-4 border-t border-zinc-200 dark:border-zinc-800">
          <h2 className="font-semibold text-base">Dynasty Rookie Picks</h2>
          <p>
            Three draft years are tradeable at any time: the upcoming class
            plus the following two. The window rolls forward on September 1 —
            once the NFL season begins, the nearest class&apos;s rookies
            graduate into the player pool (priced via the rookie prior, below)
            and a new +3 year enters.
          </p>
          <pre className="bg-zinc-100 dark:bg-zinc-900 rounded-md p-3 overflow-x-auto text-xs">
{`pick_dpv = BASELINE_1_01 × curve(round, slot) × year_distance × class_mult(slot)
year_distance: { current: 1.0, +1 year: 0.75, +2 years: 0.55 }`}
          </pre>
          <p>
            The curve is steep through R1 (1.01 → 1.0, 1.06 → 0.50, 1.12 →
            0.29) and flattens through R3 (3.01 → 0.06, 3.12 → 0.018),
            calibrated to typical dynasty market shape.
          </p>
        </div>

        <div>
          <h2 className="font-semibold text-base">Class Strength (slot-aware)</h2>
          <p>
            Within-year rankings are zero-sum — they can&apos;t tell us whether
            2027 is deeper than 2026. Instead, we use two cross-year anchors
            derived from public big boards and mock drafts:
          </p>
          <ul className="list-disc pl-6 space-y-1">
            <li>
              <b>r1_offensive_count</b> — QB/RB/WR/TE prospects whose averaged
              projected NFL overall pick is ≤ 32.
            </li>
            <li>
              <b>top15_offensive_count</b> — same, with pick ≤ 15 (elite tier).
            </li>
          </ul>
          <p>
            An NFL R1 means the same thing in every class, so these counts
            genuinely compare across years. They feed a per-slot multiplier:
          </p>
          <ul className="list-disc pl-6 space-y-1">
            <li>
              Picks up to the class&apos;s R1 offensive depth hold baseline value.
            </li>
            <li>
              Past that cliff, each slot loses 4% (floor 0.5).
            </li>
            <li>
              Top 5 slots get a head boost (or penalty) scaled to top-15 count
              vs the 3-prospect baseline. Capped at 1.15×.
            </li>
          </ul>
          <p>
            Effect: a class with 5 projected R1 offensive prospects keeps
            1.01-1.05 at full value but bleeds 1.06 onward; a class with 10
            holds the entire first round at baseline.
          </p>
        </div>

        <div>
          <h2 className="font-semibold text-base">Prospect Consensus</h2>
          <p>
            Class counts ride on a multi-source prospects table (Drafttek,
            WalterFootball, NBA Draft Room, etc.). Sites use wildly different
            grade scales — scout grades 60-100, KTC in the thousands, some
            just rank — so we convert each source&apos;s grades to ranks within
            the draft year, average ranks per prospect across sources, and map
            back to a normalized 0-100 grade via exponential decay (rank 1 →
            100, rank 10 → ~64, rank 25 → ~29). Projected pick and round
            average across sources that provide them. Prospects appearing in
            only one source still contribute, with source_count = 1.
          </p>
        </div>

        <div>
          <h2 className="font-semibold text-base">Rookie Prior Model</h2>
          <p>
            Drafted rookies with no NFL production are priced via a separate
            prior — DPV can&apos;t run on seasons that don&apos;t exist yet. The
            prior starts from a base value per position and NFL draft round,
            then applies landing-spot modifiers:
          </p>
          <pre className="bg-zinc-100 dark:bg-zinc-900 rounded-md p-3 overflow-x-auto text-xs">
{`prior_dpv = base(position, draft_round)
          × oLineMult(team oline rank)
          × qbTierMult(team qb tier)   // WR / TE only
          × ageMult(prospect age)
          × formatMult(scoring_format, position)`}
          </pre>
          <p>
            Base values descend by NFL round: QB R1 ≈ 5500, RB R1 ≈ 5200, WR
            R1 ≈ 4800, TE R1 ≈ 3400, falling roughly 40% per round. Format
            multipliers adjust for scoring — RBs gain in standard, WRs gain in
            full PPR. A prior stays in effect until the rookie accumulates a
            qualifying season of real production, at which point the standard
            DPV path takes over.
          </p>
        </div>

        <div>
          <h2 className="font-semibold text-base">Draft Capital Sync</h2>
          <p>
            Rookie priors require each player&apos;s actual NFL draft round
            and year. These come from nflverse&apos;s{" "}
            <code className="text-xs">draft_picks</code> release (matched on
            gsis_id), synced twice daily alongside the standard refresh.
            Missing draft capital is backfilled before each DPV compute run,
            so priors begin scoring new rookies the moment nflverse publishes
            the class.
          </p>
        </div>

        <div className="pt-4 border-t border-zinc-200 dark:border-zinc-800">
          <h2 className="font-semibold text-base">Planned (v2)</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li>Multi-year projections with age-adjusted composite</li>
            <li>Percentile-based market delta (normalized across scale gap)</li>
            <li>
              More prospect sources (NFL.com, ESPN, PFF) to reduce consensus
              noise on 2027/2028 classes
            </li>
            <li>Dedicated rookie board view once 2026 class is drafted</li>
          </ul>
        </div>
      </section>
    </div>
  );
}
