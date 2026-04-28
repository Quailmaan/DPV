import { PylonGlyph, PylonWordmark } from "@/components/PylonLogo";

// Brand mockup playground — not linked from production nav. Shows wordmark
// variants, favicon scales, color experiments, in-context header preview,
// a re-skinned player card with the candidate "PYV" metric, and the metric
// abbreviation comparison table for the rename decision.

export default function MockupPage() {
  return (
    <div className="space-y-12">
      <div className="text-xs uppercase tracking-wider text-zinc-500">
        Brand mockup — not linked from nav
      </div>

      {/* Hero */}
      <section className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-12 flex flex-col items-center justify-center gap-4">
        <PylonWordmark variant="default" size="xl" />
        <p className="text-sm text-zinc-500 italic">
          Dynasty fantasy, on the line.
        </p>
      </section>

      {/* Wordmark variants */}
      <section>
        <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-4">
          Wordmark variants
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-8 flex items-center justify-center min-h-[140px]">
            <PylonWordmark variant="default" size="lg" />
          </div>
          <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-8 flex items-center justify-center min-h-[140px]">
            <PylonWordmark variant="accent" size="lg" />
          </div>
          <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-8 flex items-center justify-center min-h-[140px]">
            <PylonWordmark variant="stacked" size="lg" />
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-2 text-xs text-zinc-500">
          <div className="text-center">
            <b className="text-zinc-700 dark:text-zinc-300">A · Glyph + wordmark</b>
            <br />
            Most flexible. Glyph reusable as favicon.
          </div>
          <div className="text-center">
            <b className="text-zinc-700 dark:text-zinc-300">B · Accent Y</b>
            <br />
            No glyph. Letterform-only, type-driven.
          </div>
          <div className="text-center">
            <b className="text-zinc-700 dark:text-zinc-300">C · Stacked</b>
            <br />
            Square avatar. Profile / app icon shape.
          </div>
        </div>
      </section>

      {/* Favicon / scale */}
      <section>
        <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-4">
          Favicon / glyph scale
        </h2>
        <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-8 flex items-end justify-center gap-10 flex-wrap">
          {[16, 24, 32, 48, 64, 96].map((px) => (
            <div key={px} className="flex flex-col items-center gap-2">
              <PylonGlyph
                size={px}
                className="text-orange-600 dark:text-orange-500"
              />
              <span className="text-xs text-zinc-500 tabular-nums">{px}px</span>
            </div>
          ))}
        </div>
      </section>

      {/* Brand color experiments */}
      <section>
        <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-4">
          Brand color
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { color: "text-orange-600", label: "Orange 600", note: "NFL pylon" },
            { color: "text-orange-500", label: "Orange 500", note: "Brighter" },
            { color: "text-red-600", label: "Red 600", note: "Heavier" },
            { color: "text-amber-500", label: "Amber 500", note: "Softer" },
          ].map((c) => (
            <div
              key={c.label}
              className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 flex flex-col items-center gap-3"
            >
              <PylonGlyph size={48} className={c.color} />
              <div className="text-center">
                <div className="text-sm font-medium">{c.label}</div>
                <div className="text-xs text-zinc-500">{c.note}</div>
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs text-zinc-500 mt-2">
          Recommend <b>Orange 600</b> — matches the visual reference of an actual
          pylon and reads cleanly in both light and dark mode.
        </p>
      </section>

      {/* In-context header */}
      <section>
        <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-4">
          In context — site header
        </h2>
        <div className="rounded-md overflow-hidden border border-zinc-200 dark:border-zinc-800">
          <div className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-6 py-4 flex items-center justify-between">
            <PylonWordmark variant="default" size="md" />
            <nav className="flex gap-5 text-sm text-zinc-600 dark:text-zinc-400">
              <span className="hover:text-zinc-900 dark:hover:text-zinc-100">
                Rankings
              </span>
              <span className="hover:text-zinc-900 dark:hover:text-zinc-100">
                Rookies
              </span>
              <span className="hover:text-zinc-900 dark:hover:text-zinc-100">
                Leagues
              </span>
              <span className="hover:text-zinc-900 dark:hover:text-zinc-100">
                Trade
              </span>
              <span className="hover:text-zinc-900 dark:hover:text-zinc-100">
                Methodology
              </span>
            </nav>
          </div>
          <div className="bg-zinc-50 dark:bg-zinc-950 px-6 py-8 text-sm text-zinc-500">
            Sample page chrome — your existing pages drop in below.
          </div>
        </div>
      </section>

      {/* Player card with new metric */}
      <section>
        <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-4">
          Player card with new metric (PYV)
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Elite tier card with foil-style gradient border */}
          <div className="relative rounded-md p-[1px] bg-gradient-to-br from-orange-500/60 via-amber-400/30 to-emerald-500/40">
            <div className="rounded-md bg-white dark:bg-zinc-900 p-5 h-full">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wider bg-orange-100 dark:bg-orange-950/40 text-orange-800 dark:text-orange-300 px-1.5 py-0.5 rounded">
                    WR
                  </span>
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                    CIN
                  </span>
                </div>
                <span className="text-[10px] font-semibold uppercase tracking-wider bg-orange-600 text-white px-1.5 py-0.5 rounded">
                  Elite
                </span>
              </div>
              <div className="text-lg font-semibold">Ja&apos;Marr Chase</div>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                  PYV
                </span>
                <span className="text-3xl font-bold tabular-nums">6,389</span>
              </div>
              {/* tier rail */}
              <div className="mt-3 grid grid-cols-5 gap-1">
                {["Bench", "Rotational", "Starter", "Top-12", "Elite"].map(
                  (label, i) => (
                    <div
                      key={label}
                      className={`h-1.5 rounded-full ${
                        i === 4
                          ? "bg-orange-600"
                          : "bg-zinc-200 dark:bg-zinc-800"
                      }`}
                      title={label}
                    />
                  ),
                )}
              </div>
            </div>
          </div>

          {/* Weekly Starter tier (no foil border) */}
          <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wider bg-sky-100 dark:bg-sky-950/40 text-sky-800 dark:text-sky-300 px-1.5 py-0.5 rounded">
                  WR
                </span>
                <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  NYJ
                </span>
              </div>
              <span className="text-[10px] font-semibold uppercase tracking-wider bg-zinc-200 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 px-1.5 py-0.5 rounded">
                Weekly Starter
              </span>
            </div>
            <div className="text-lg font-semibold">Garrett Wilson</div>
            <div className="mt-3 flex items-baseline gap-2">
              <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                PYV
              </span>
              <span className="text-3xl font-bold tabular-nums">3,193</span>
            </div>
            <div className="mt-3 grid grid-cols-5 gap-1">
              {["Bench", "Rotational", "Starter", "Top-12", "Elite"].map(
                (label, i) => (
                  <div
                    key={label}
                    className={`h-1.5 rounded-full ${
                      i === 2
                        ? "bg-sky-600"
                        : "bg-zinc-200 dark:bg-zinc-800"
                    }`}
                    title={label}
                  />
                ),
              )}
            </div>
          </div>
        </div>
        <p className="text-xs text-zinc-500 mt-2">
          Adds a colored position pill (QB amber, RB emerald, WR sky, TE
          violet), a tier rail beneath the score, and a subtle gradient-border
          &ldquo;foil&rdquo; treatment on Elite-tier rows. The metric label{" "}
          <code className="text-xs">PYV</code> sits inline with the number,
          uppercase mono.
        </p>
      </section>

      {/* Metric abbreviation candidates */}
      <section>
        <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-4">
          Metric abbreviation
        </h2>
        <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-zinc-500 bg-zinc-50 dark:bg-zinc-950">
              <tr>
                <th className="px-4 py-2 text-left">Label</th>
                <th className="px-4 py-2 text-left">Stands for</th>
                <th className="px-4 py-2 text-left">Vibes / drawbacks</th>
                <th className="px-4 py-2 text-left">Pick?</th>
              </tr>
            </thead>
            <tbody>
              {[
                {
                  label: "PYV",
                  full: "Pylon Value",
                  note: "Three-letter, brand-aligned (P-Y matches Pylon, V matches Value), sounds like a real proprietary metric (KTC, ADP, PFF).",
                  rec: "★ Top pick",
                },
                {
                  label: "MARK",
                  full: "Pylon Mark",
                  note: "Standalone word — feels like \"trademark / benchmark.\" Very memorable. Most opinionated choice.",
                  rec: "Strong alt",
                },
                {
                  label: "PYL",
                  full: "Pylon",
                  note: "Brand-as-metric (\"his PYL is 5,400\"). Tight fusion. Risk: harder to differentiate brand from score in writing.",
                  rec: "Solid",
                },
                {
                  label: "PV",
                  full: "Pylon Value",
                  note: "Your suggestion. Cleanest two letters. Drawback: PV is heavily overloaded (present value, photovoltaic, page view).",
                  rec: "Workable",
                },
                {
                  label: "GLV",
                  full: "Goal-Line Value",
                  note: "Football-native angle — pylons mark the goal line. Doesn't echo the brand name in letters though.",
                  rec: "Clever, off-brand",
                },
                {
                  label: "PVI",
                  full: "Pylon Value Index",
                  note: "Index framing implies relative measurement. A bit corporate.",
                  rec: "Backup",
                },
              ].map((row) => (
                <tr
                  key={row.label}
                  className="border-t border-zinc-100 dark:border-zinc-800"
                >
                  <td className="px-4 py-3 font-mono font-semibold tabular-nums">
                    {row.label}
                  </td>
                  <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                    {row.full}
                  </td>
                  <td className="px-4 py-3 text-zinc-500 text-xs leading-snug">
                    {row.note}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <span
                      className={
                        row.rec.startsWith("★")
                          ? "text-orange-700 dark:text-orange-400 font-medium"
                          : "text-zinc-500"
                      }
                    >
                      {row.rec}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-zinc-500 mt-2">
          My pick is <b>PYV</b>. It reads as a real metric, the letters track
          the brand, and it&apos;s not overloaded. <b>MARK</b> is the most
          interesting alternative if you want the metric to have its own
          standalone identity (&ldquo;Chase&apos;s Mark is 6,389&rdquo;) — more
          editorial, more opinionated.
        </p>
      </section>

      {/* Color palette */}
      <section>
        <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-4">
          Proposed palette
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
          {[
            { c: "bg-orange-600", t: "text-white", label: "Brand" },
            { c: "bg-zinc-900", t: "text-white", label: "Foreground" },
            { c: "bg-zinc-50 dark:bg-zinc-950", t: "", label: "Background" },
            { c: "bg-emerald-500", t: "text-white", label: "Buy / Up" },
            { c: "bg-rose-500", t: "text-white", label: "Sell / Down" },
            { c: "bg-amber-500", t: "text-white", label: "Caution" },
          ].map((s) => (
            <div
              key={s.label}
              className="rounded-md overflow-hidden border border-zinc-200 dark:border-zinc-800"
            >
              <div className={`h-16 ${s.c} ${s.t}`} />
              <div className="p-2 text-xs">{s.label}</div>
            </div>
          ))}
        </div>
        <p className="text-xs text-zinc-500 mt-2">
          Position pills (small bg-tinted badges in the rankings table): QB
          amber, RB emerald, WR sky, TE violet — distinct enough that you can
          read a rankings page by color without reading the position column.
        </p>
      </section>
    </div>
  );
}
