import { PylonMark, PylonWordmark } from "@/components/PylonLogo";

// Brand mockup — locked-in spec page (not options). Wordmark variant B
// (accent Y), PYV metric, no pylon glyph. The Y is the brand mark; it
// doubles as a goalpost shape, which is enough football resonance without
// needing a separate icon asset.

export default function MockupPage() {
  return (
    <div className="space-y-12">
      <div className="rounded-md border border-emerald-300 dark:border-emerald-900/60 bg-emerald-50/40 dark:bg-emerald-950/20 p-3 text-xs text-emerald-900 dark:text-emerald-200">
        <b>Decisions locked.</b> Wordmark = accent Y. Metric = PYV. No glyph
        / pictographic mark. The Y carries the brand and doubles as a
        goalpost — football-native without an extra image.
      </div>

      {/* Hero */}
      <section className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-12 flex flex-col items-center justify-center gap-4">
        <PylonWordmark size="xl" />
        <p className="text-sm text-zinc-500 italic">
          Dynasty fantasy, on the line.
        </p>
      </section>

      {/* Wordmark scale */}
      <section>
        <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-4">
          Wordmark — sizes
        </h2>
        <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-8 flex flex-col items-start gap-6">
          <PylonWordmark size="xl" />
          <PylonWordmark size="lg" />
          <PylonWordmark size="md" />
          <PylonWordmark size="sm" />
        </div>
      </section>

      {/* The Mark */}
      <section>
        <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-4">
          The mark — Y as monogram / favicon
        </h2>
        <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-8">
          <p className="text-sm text-zinc-600 dark:text-zinc-300 mb-6 max-w-2xl">
            The capital Y is already a goalpost shape — vertical post with two
            arms reaching up. That&apos;s enough football native-ness for a
            brand mark; no separate icon needed. The Y is also the only
            colored letter in the wordmark, so the favicon, app icon, and
            wordmark all share one visual hook.
          </p>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-6 mb-6">
            {/* Plain orange Y on transparent */}
            <div className="flex flex-col items-center gap-3 p-6 rounded-md bg-zinc-50 dark:bg-zinc-950">
              <PylonMark size={64} />
              <div className="text-xs text-zinc-500 text-center">
                <div className="font-medium text-zinc-700 dark:text-zinc-300">
                  Y · transparent
                </div>
                Inline use, light backgrounds
              </div>
            </div>

            {/* Y on filled orange square — app icon */}
            <div className="flex flex-col items-center gap-3 p-6 rounded-md bg-zinc-50 dark:bg-zinc-950">
              <PylonMark size={64} filled />
              <div className="text-xs text-zinc-500 text-center">
                <div className="font-medium text-zinc-700 dark:text-zinc-300">
                  Y · filled
                </div>
                App icon, social avatar
              </div>
            </div>

            {/* Y on dark zinc square — alt avatar */}
            <div className="flex flex-col items-center gap-3 p-6 rounded-md bg-zinc-50 dark:bg-zinc-950">
              <PylonMark size={64} dark />
              <div className="text-xs text-zinc-500 text-center">
                <div className="font-medium text-zinc-700 dark:text-zinc-300">
                  Y · dark
                </div>
                Dark-theme contexts
              </div>
            </div>
          </div>

          {/* Favicon scale */}
          <div className="border-t border-zinc-100 dark:border-zinc-800 pt-6">
            <div className="text-xs uppercase tracking-wider text-zinc-500 mb-4">
              Scale — does the Y survive at 16px?
            </div>
            <div className="flex items-end justify-center gap-10 flex-wrap">
              {[16, 24, 32, 48, 64, 96].map((px) => (
                <div key={px} className="flex flex-col items-center gap-2">
                  <PylonMark size={px} filled />
                  <span className="text-xs text-zinc-500 tabular-nums">
                    {px}px
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* In-context header */}
      <section>
        <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-4">
          In context — site header
        </h2>
        <div className="rounded-md overflow-hidden border border-zinc-200 dark:border-zinc-800">
          <div className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-6 py-4 flex items-center justify-between">
            <PylonWordmark size="md" />
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

      {/* Player card with PYV metric and red-600 sell */}
      <section>
        <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-4">
          Player cards · PYV metric · red-600 sells
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Elite tier card with foil-style gradient border */}
          <div className="relative rounded-md p-[1px] bg-gradient-to-br from-orange-500/60 via-amber-400/30 to-emerald-500/40">
            <div className="rounded-md bg-white dark:bg-zinc-900 p-5 h-full">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wider bg-sky-100 dark:bg-sky-950/40 text-sky-800 dark:text-sky-300 px-1.5 py-0.5 rounded">
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
                <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-mono">
                  PYV
                </span>
                <span className="text-3xl font-bold tabular-nums">6,389</span>
                <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400 tabular-nums">
                  ▲ +412 vs market
                </span>
              </div>
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

          {/* Weekly Starter card with red sell signal */}
          <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wider bg-emerald-100 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 px-1.5 py-0.5 rounded">
                  RB
                </span>
                <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  SF
                </span>
              </div>
              <span className="text-[10px] font-semibold uppercase tracking-wider bg-zinc-200 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 px-1.5 py-0.5 rounded">
                Weekly Starter
              </span>
            </div>
            <div className="text-lg font-semibold">Christian McCaffrey</div>
            <div className="mt-3 flex items-baseline gap-2">
              <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-mono">
                PYV
              </span>
              <span className="text-3xl font-bold tabular-nums">3,847</span>
              <span className="text-xs font-medium text-red-600 dark:text-red-500 tabular-nums">
                ▼ -738 vs market
              </span>
            </div>
            <div className="mt-3 grid grid-cols-5 gap-1">
              {["Bench", "Rotational", "Starter", "Top-12", "Elite"].map(
                (label, i) => (
                  <div
                    key={label}
                    className={`h-1.5 rounded-full ${
                      i === 2
                        ? "bg-emerald-600"
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
          Position pills (QB amber / RB emerald / WR sky / TE violet),{" "}
          <code className="text-xs">PYV</code> metric label in mono uppercase,
          tier rail beneath the score, and a foil-style gradient border on
          Elite-tier rows. Buy / sell deltas in emerald (▲) and{" "}
          <span className="text-red-600 dark:text-red-500 font-medium">
            red-600 (▼)
          </span>
          .
        </p>
      </section>

      {/* Palette */}
      <section>
        <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-4">
          Palette
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
          {[
            { c: "bg-orange-600", t: "text-white", label: "Brand" },
            { c: "bg-zinc-900", t: "text-white", label: "Foreground" },
            {
              c: "bg-zinc-50 dark:bg-zinc-950",
              t: "",
              label: "Background",
            },
            { c: "bg-emerald-500", t: "text-white", label: "Buy / Up" },
            { c: "bg-red-600", t: "text-white", label: "Sell / Down" },
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

      {/* Spec summary */}
      <section className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-6">
        <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-3">
          Rollout spec
        </h2>
        <ul className="text-sm space-y-1 text-zinc-700 dark:text-zinc-300">
          <li>
            • Header brand: <code>&lt;PylonWordmark size=&quot;md&quot; /&gt;</code>
          </li>
          <li>
            • Favicon: <code>app/icon.tsx</code> renders the filled-orange Y
            via Next.js <code>ImageResponse</code>
          </li>
          <li>
            • <code>metadata.title</code> →{" "}
            <code>&quot;Pylon — Dynasty Player Valuation&quot;</code>
          </li>
          <li>
            • Find/replace: <code>DPV</code> → <code>PYV</code> across UI
            strings, column headers, methodology copy
          </li>
          <li>
            • Add Tailwind brand color token (<code>--color-brand</code> = orange-600)
          </li>
          <li>
            • Sell/Down delta color:{" "}
            <code>text-rose-500</code> → <code>text-red-600</code>
          </li>
          <li>
            • README + methodology page intro updated to reflect the rename
          </li>
        </ul>
      </section>
    </div>
  );
}
