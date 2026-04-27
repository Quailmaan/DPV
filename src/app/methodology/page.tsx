export default function MethodologyPage() {
  return (
    <div className="prose prose-zinc dark:prose-invert max-w-none">
      <h1 className="text-2xl font-semibold tracking-tight">Methodology</h1>
      <p className="text-zinc-500 text-sm mt-1">
        The shape of how DPV (Dynasty Player Valuation) is computed — what
        goes in, why each piece is there, and how they combine.
      </p>

      <section className="mt-6 space-y-4 text-sm leading-6">
        <div>
          <h2 className="font-semibold text-base">The short version</h2>
          <p>
            DPV blends what a player is producing right now, how that
            production tends to age, the size of the role they&apos;re
            stepping into, the team context around them, and a positional
            scarcity adjustment that respects league construction. Each
            piece nudges the score up or down. The final number lands on a
            stable scale that&apos;s comparable across positions and across
            scoring formats.
          </p>
          <p>
            The components below are listed roughly in the order they enter
            the calculation. Specific weights, thresholds, and curve shapes
            are tuned against historical hit rates and aren&apos;t published
            here.
          </p>
        </div>

        <div>
          <h2 className="font-semibold text-base">Recent production</h2>
          <p>
            The starting point is a player&apos;s fantasy points per game
            across their last few qualifying seasons, weighted toward the
            most recent. Position-specific weighting reflects how stable
            each position is year-over-year — RB usage swings the most, QBs
            and TEs the least. A season needs enough games played to be
            informative; partial seasons get partial credit.
          </p>
          <p>
            For established players who had one disrupted year (injury,
            suspension), the role inputs blend across the qualifying
            window so that a single torn ACL doesn&apos;t collapse the
            score for a player whose role hasn&apos;t actually changed.
          </p>
        </div>

        <div>
          <h2 className="font-semibold text-base">Aging curves</h2>
          <p>
            Production gets adjusted by where a player sits on their
            position&apos;s aging curve. The curves come from two-plus
            decades of historical peak-season data: RBs peak earliest and
            fall hardest, WRs hold a high plateau into their late twenties,
            TEs ramp later and hold their value longer, QBs are the most
            forgiving of the four. The curve shape matters more than any
            single multiplier — DPV reflects the trajectory, not just the
            current snapshot.
          </p>
        </div>

        <div>
          <h2 className="font-semibold text-base">Role / opportunity</h2>
          <p>
            How much of the team&apos;s offense actually runs through this
            player. The mix is position-aware: snap share is the floor,
            touch volume captures the ground game, and target share is the
            stickiest predictor for receivers. Open opportunity ahead of
            the player — vacancies on the depth chart, recently departed
            primary backs, lost target volume — gets partial credit too,
            because somebody is going to absorb that work.
          </p>
        </div>

        <div>
          <h2 className="font-semibold text-base">Team context</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li>
              <b>Offensive line.</b> Front-five strength is derived from
              yards-before-contact data rather than raw rushing average —
              YBC strips out what the back does after contact and isolates
              the line&apos;s actual job. Strong effect on RB scoring,
              near-zero on receivers and QBs, so the row is hidden for
              non-RBs.
            </li>
            <li>
              <b>QB tier.</b> Quarterback play is bucketed by recent
              starter production. Strong effect on the receivers they
              throw to, near-zero on the backs behind them. The bump is
              damped when a player has been with the same QB tier for
              multiple seasons, so the model isn&apos;t double-counting
              context that&apos;s already baked into past production.
            </li>
            <li>
              <b>Boom/bust.</b> Weekly variance gets a small adjustment —
              floor is rewarded, ceiling-or-zero scoring is penalized.
              Useful at the margins for cash-game lineups; deliberately
              not the dominant signal.
            </li>
          </ul>
        </div>

        <div>
          <h2 className="font-semibold text-base">Positional scarcity</h2>
          <p>
            A top-3 player at a thin position is worth more than a top-3
            player at a deep one — that&apos;s the whole point of trading
            across positions in dynasty. DPV applies a scarcity adjustment
            that boosts the top of each position group and discounts the
            deep bench. The default scaling assumes standard 12-team
            league construction; on the trade page, values recalibrate to
            your actual roster setup when a Sleeper league is connected
            (Superflex, TE-premium, larger or smaller leagues all shift
            the curve).
          </p>
        </div>

        <div>
          <h2 className="font-semibold text-base">Market calibration</h2>
          <p>
            FantasyCalc dynasty trade values are pulled per scoring format
            and shown alongside DPV with a delta column. Where the two
            disagree, the delta flags potential buys (DPV values the
            player higher than the market) and potential sells (market
            higher than DPV) — a value-vs-perception read, not a price
            replacement.
          </p>
        </div>

        <div>
          <h2 className="font-semibold text-base">
            Historical comparables
          </h2>
          <p>
            For each active player, we identify their closest historical
            comparables: players at the same position who, at a similar
            age and role profile, faced a similar situation. The
            comparison runs on a multi-dimensional similarity metric —
            position, age, usage, context, and the year-over-year
            trajectory of their production, so a 22-year-old trending up
            doesn&apos;t get matched to a 22-year-old who&apos;s flat.
          </p>
          <p>
            What happened to those comps over the next three NFL seasons
            blends into a forward projection that nudges DPV. The closer
            the comp set, the more weight the trajectory carries; loose
            matches contribute little. In the common case the production
            and context model still dominates, but the long-horizon
            history has a voice.
          </p>
        </div>

        <div className="pt-4 border-t border-zinc-200 dark:border-zinc-800">
          <h2 className="font-semibold text-base">Rookie picks</h2>
          <p>
            Three rookie draft years are tradeable at any time — the
            upcoming class plus the next two. The window rolls forward
            when the NFL season begins: that year&apos;s class graduates
            into the player pool (priced via the rookie prior, below) and
            a new +3 year enters.
          </p>
          <p>
            Pick value follows a steep curve through the first round,
            flattens through the second and third, and discounts future
            years on a per-year decay. The curve is then scaled by{" "}
            <i>class strength</i> so a deep class doesn&apos;t hit the
            same value cliff as a thin one.
          </p>
        </div>

        <div>
          <h2 className="font-semibold text-base">Class strength</h2>
          <p>
            Within-year rankings are zero-sum — they can&apos;t tell us
            whether next year&apos;s class is deeper than this
            year&apos;s. To make cross-year comparisons honest, class
            strength is anchored on how many prospects projected NFL
            top-15 and top-32 boards see — those tiers mean roughly the
            same thing every year, so the counts genuinely compare across
            classes.
          </p>
          <p>
            The result feeds a per-slot multiplier: picks within a
            class&apos;s projected R1 offensive depth hold full value;
            past that cliff, each slot loses ground. A class with double
            the usual R1 talent holds the entire first round at full
            value; a thin class bleeds value starting halfway through R1.
          </p>
        </div>

        <div>
          <h2 className="font-semibold text-base">Prospect consensus</h2>
          <p>
            Class counts ride on a multi-source prospects table — major
            draft boards plus a handful of independent rankers. Sites
            grade on wildly different scales (some 60-100, some in the
            thousands, some rank-only), so each source is normalized to
            ranks within the draft year, ranks are averaged across
            sources per prospect, and the average is mapped back to a
            single 0-100 grade. Prospects covered by only one source
            still surface, with the single-source caveat reflected in the
            source count.
          </p>
        </div>

        <div>
          <h2 className="font-semibold text-base">Rookie prior</h2>
          <p>
            Drafted rookies with no NFL production yet get priced through
            a separate prior — there&apos;s no production history to
            weight. The prior starts from a position-and-NFL-draft-round
            baseline (capital is one of the strongest available signals
            on rookie fantasy outcomes), then folds in the landing
            spot&apos;s offensive line, the QB tier for receivers, the
            prospect&apos;s age, the scoring format, and any displacement
            from same-position competition on the new roster.
          </p>
          <p>
            QB priors flip into a much higher tier in Superflex /
            two-QB league setups, since a rookie QB who locks in even an
            average starter job is suddenly a top-of-class asset.
          </p>
          <p>
            The prior assumes NFL capital will translate into production.
            Each post-draft season that passes without a meaningful
            workload is strong evidence against that assumption, so the
            prior fades. A player who logged only a handful of games
            across their first two seasons gets priced as a depth flier,
            not a fresh rookie. Once a qualifying season of real
            production lands, the standard DPV pipeline takes over.
          </p>
        </div>

        <div>
          <h2 className="font-semibold text-base">Draft capital sync</h2>
          <p>
            Rookie priors require each player&apos;s actual NFL draft
            round and year. Those come from nflverse&apos;s draft-picks
            release, matched on player ID and synced twice daily
            alongside the standard refresh. Missing draft capital is
            backfilled before each compute run, so priors begin scoring
            new rookies the moment the class is published. In the gap
            between the actual NFL draft and nflverse&apos;s roster
            release (typically 1-3 days), Sleeper&apos;s live rosters
            stand in so the player&apos;s landing spot still reads on the
            page.
          </p>
        </div>

        <div className="pt-4 border-t border-zinc-200 dark:border-zinc-800">
          <h2 className="font-semibold text-base">A note on tuning</h2>
          <p>
            Specific weights, thresholds, and curve constants are tuned
            against historical year-over-year hit rates — the goal is
            calibration, not novelty. Where two reasonable choices
            produced similar out-of-sample fits, the simpler one wins.
            Where the data forced a less obvious shape (the WR aging
            plateau into the late twenties, the RB cliff at 28, the TE
            late-bloom pattern), the curve follows the data even when it
            disagrees with conventional dynasty wisdom.
          </p>
        </div>

        <div>
          <h2 className="font-semibold text-base">Planned</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li>
              Percentile-based market delta to neutralize scale gaps
              between DPV and FantasyCalc
            </li>
            <li>
              More prospect sources (NFL.com, ESPN, PFF) to reduce
              consensus noise on out-year classes
            </li>
            <li>
              League-shape calibration on the rookies page, mirroring the
              trade page&apos;s Sleeper-aware scarcity
            </li>
          </ul>
        </div>
      </section>
    </div>
  );
}
