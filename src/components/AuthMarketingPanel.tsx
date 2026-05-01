// Marketing panel that sits beside the sign-up / sign-in forms. Without
// this, anyone who clicks "Create free account" from the home hero hits
// a bare email-and-password form with no reminder of why they're doing
// it — total context drop right at the conversion moment. Restating the
// value props next to the form keeps them oriented.
//
// Server Component on purpose: this is purely presentational with no
// client state, so we skip the JS bundle. Used by both /login and
// /signup so the experience reads as one continuous funnel rather than
// two unrelated screens.

const FREE_FEATURES = [
  "Full PYV board — every dynasty player scored on production, age, and opportunity",
  "Rookie consensus board — for startups and rookie drafts",
  "1 synced Sleeper league with power rankings and roster strength",
  "Universal trade calculator — works without a league synced",
];

const PRO_FEATURES = [
  "Sell-window flags on every player — sell now, peak hold, buy",
  "Roster report card with composite 0-100 contender vs. rebuild score",
  "Trade finder — fair-value ideas tailored to your roster + opponents' needs",
  "League-aware trade calc with traded picks + league scoring",
];

export default function AuthMarketingPanel() {
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 sm:p-6 shadow-sm">
      <div className="text-[11px] uppercase tracking-wider font-semibold text-emerald-700 dark:text-emerald-400 mb-2">
        Dynasty fantasy values, calibrated to your league
      </div>
      <h2 className="text-lg font-semibold tracking-tight mb-1">
        What you&apos;ll get
      </h2>
      <p className="text-sm text-zinc-500 mb-4">
        Free tier covers everything you need to make decisions. No card
        required.
      </p>

      <div className="text-xs uppercase tracking-wide font-semibold text-zinc-700 dark:text-zinc-300 mb-2">
        Free
      </div>
      <ul className="text-sm space-y-2 mb-5">
        {FREE_FEATURES.map((f) => (
          <Bullet key={f}>{f}</Bullet>
        ))}
      </ul>

      <div className="text-xs uppercase tracking-wide font-semibold text-zinc-700 dark:text-zinc-300 mb-2">
        Pro <span className="text-zinc-400 font-normal normal-case">— $7/mo</span>
      </div>
      <ul className="text-sm space-y-2">
        {PRO_FEATURES.map((f) => (
          <Bullet key={f}>{f}</Bullet>
        ))}
      </ul>
    </div>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <svg
        className="h-4 w-4 flex-shrink-0 mt-0.5 text-emerald-600"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M5 12l5 5L20 7" />
      </svg>
      <span className="text-zinc-700 dark:text-zinc-300">{children}</span>
    </li>
  );
}
