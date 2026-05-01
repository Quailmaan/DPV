// Weekly digest content generator. Pure function: hand it a user's
// roster context, get back `{ subject, html, text }`. The cron route
// loads the data from Supabase and feeds this; tests can construct
// inputs by hand.
//
// We render BOTH html and text so deliverability stays high (Gmail's
// spam scoring penalises text-less email) and so users on text-only
// clients still get a readable digest.
//
// Style: the email is intentionally plain. No tracking pixels, no
// dark-mode CSS, no images — table-based layout that survives Gmail's
// CSS pruning. The CTA button is a wide <a> with inline styles.

import type { SellWindow } from "@/lib/dpv/sellWindow";
import type { TradeIdea } from "@/lib/league/tradeFinder";
import type { ReportCard } from "@/lib/league/reportCard";

export type DigestPlayer = {
  name: string;
  position: string;
  dpv: number;
  sellWindow: SellWindow;
};

// One player's week-over-week PYV change. Used by the "this week"
// section to surface biggest risers/fallers on the user's roster.
export type DigestMover = {
  name: string;
  position: string;
  /** Current snapshot's PYV. */
  dpv: number;
  /** Signed delta vs the prior snapshot used for the WoW window. */
  delta: number;
};

// Per-position context for the focused roster — explicit "where do I
// stand" surface that the prior digest only hinted at via report-card
// composite. Rank is 1-indexed within the league (1 = strongest at
// that position); deltaPct is the user's total PYV at the position
// vs. the league-wide per-team average, signed (positive = surplus,
// negative = need).
export type DigestPositionRank = {
  position: "QB" | "RB" | "WR" | "TE";
  rank: number;
  totalRosters: number;
  pyv: number;
  deltaPct: number;
};

// Other rosters with surplus at the user's weakest position. Names
// the would-be trade partners so the user knows who to message
// instead of just "consider trading for a TE".
export type DigestTradePartner = {
  ownerName: string;
  /** Top 1-3 players the partner has at the target position. */
  topPlayers: { name: string; dpv: number }[];
  /** Surplus pct vs league average at the target position. */
  surplusPct: number;
};

export type DigestLeague = {
  leagueId: string;
  leagueName: string;
  /** Focused team's report card. Always present — we generate a card per league. */
  card: Pick<ReportCard, "composite" | "verdict">;
  /** 1-indexed report-card rank within the league. Optional — older
   * payloads built before this field landed render without it. */
  cardRank?: number;
  /** Strongest position (highest in-league rank). */
  strongest?: DigestPositionRank;
  /** Weakest position (lowest in-league rank). */
  weakest?: DigestPositionRank;
  /** Up to 3 biggest risers on the focused roster this week. */
  topRisers?: DigestMover[];
  /** Up to 3 biggest fallers on the focused roster this week. */
  topFallers?: DigestMover[];
  /** Up to 3 rosters with surplus at the user's weakest position. */
  tradePartners?: DigestTradePartner[];
  /** Up to 3 SELL_NOW or SELL_SOON players on the focused team. */
  topSells: DigestPlayer[];
  /** Up to 2 trade ideas surfaced by the trade finder. */
  topTrades: TradeIdea[];
};

export type DigestInput = {
  /** Recipient address — only used to format the greeting line. */
  email: string;
  /** Display name for the greeting. Falls back to "manager" if null. */
  username: string | null;
  /** One block per synced league. We render up to N (cap inside). */
  leagues: DigestLeague[];
  /** Absolute origin used to build all CTA links. */
  appBaseUrl: string;
  /** Token-bearing one-click unsubscribe URL. */
  unsubscribeUrl: string;
};

export type DigestOutput = {
  subject: string;
  html: string;
  text: string;
};

// Cap number of leagues per email — Pro users may have 8+, but a long
// scrolling email gets ignored. 3 leagues fits in one screen.
const MAX_LEAGUES = 3;

export function buildWeeklyDigest(input: DigestInput): DigestOutput {
  const greeting = input.username ?? "manager";
  const leagues = input.leagues.slice(0, MAX_LEAGUES);

  const subject = buildSubject(leagues);
  const html = buildHtml({ ...input, leagues, greeting });
  const text = buildText({ ...input, leagues, greeting });

  return { subject, html, text };
}

// ---- Subject -------------------------------------------------------------

function buildSubject(leagues: DigestLeague[]): string {
  if (leagues.length === 0) return "Your weekly Pylon update";
  // Lead with the most actionable signal: a sell-now flag in the user's
  // first league. Fall back to verdict + composite score.
  const first = leagues[0];
  const sellNow = first.topSells.find(
    (p) => p.sellWindow.verdict === "SELL_NOW",
  );
  if (sellNow) {
    return `Sell now: ${sellNow.name} — Pylon weekly digest`;
  }
  return `${first.leagueName}: ${first.card.verdict} — Pylon weekly digest`;
}

// ---- HTML ----------------------------------------------------------------

function buildHtml(args: DigestInput & { greeting: string }): string {
  const blocks = args.leagues.map((l) => leagueBlockHtml(l, args.appBaseUrl));
  const tail = args.leagues.length === 0 ? noLeaguesBlockHtml() : "";

  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#18181b;">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f4f4f5;padding:24px 0;">
  <tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e4e4e7;">
      <tr>
        <td style="padding:24px 28px 8px;">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#16a34a;font-weight:600;">Pylon · Weekly Digest</div>
          <h1 style="font-size:20px;line-height:1.3;margin:8px 0 4px;font-weight:600;">Hi ${escapeHtml(args.greeting)},</h1>
          <p style="font-size:14px;color:#52525b;margin:0 0 8px;">Here's how your dynasty rosters moved this week — where you stand, what changed, who to call.</p>
        </td>
      </tr>
      ${blocks.join("\n")}
      ${tail}
      <tr>
        <td style="padding:20px 28px 28px;border-top:1px solid #e4e4e7;font-size:11px;color:#71717a;">
          You're getting this because you opted in to Pylon's weekly
          digest.
          <a href="${escapeHtml(args.unsubscribeUrl)}" style="color:#71717a;text-decoration:underline;">Unsubscribe</a>
          · <a href="${escapeHtml(args.appBaseUrl)}/account" style="color:#71717a;text-decoration:underline;">Manage preferences</a>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

// Position-strength summary line: "Strongest: WR — 1st of 12 (+38%)".
// We word the top/bottom-of-league cases since "1st of 12" reads cleaner
// than "1 (top)", and a flat "+0%" mostly lands as noise.
function positionSummaryHtml(label: string, p: DigestPositionRank): string {
  const ordinal = ordinalSuffix(p.rank);
  const cmp =
    p.deltaPct === 0
      ? ""
      : ` <span style="color:${p.deltaPct > 0 ? "#16a34a" : "#dc2626"};">(${p.deltaPct > 0 ? "+" : ""}${p.deltaPct}%)</span>`;
  return `
    <tr>
      <td style="padding:3px 0;font-size:13px;">
        <span style="display:inline-block;width:90px;color:#71717a;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;font-weight:600;">${escapeHtml(label)}</span>
        <strong>${escapeHtml(p.position)}</strong>
        <span style="color:#52525b;"> — ${ordinal} of ${p.totalRosters}</span>${cmp}
      </td>
    </tr>`;
}

function ordinalSuffix(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function moverRowHtml(m: DigestMover, kind: "up" | "down"): string {
  const sign = m.delta > 0 ? "+" : "";
  const arrow = kind === "up" ? "↑" : "↓";
  const color = kind === "up" ? "#16a34a" : "#dc2626";
  return `
    <tr>
      <td style="padding:4px 0;font-size:13px;">
        <span style="color:${color};font-weight:600;">${arrow}</span>
        <strong>${escapeHtml(m.name)}</strong>
        <span style="color:#71717a;"> · ${escapeHtml(m.position)}</span>
      </td>
      <td style="padding:4px 0;font-size:13px;text-align:right;tabular-nums;color:${color};font-weight:600;">
        ${sign}${m.delta} PYV
      </td>
    </tr>`;
}

function leagueBlockHtml(league: DigestLeague, base: string): string {
  // Position summary — only render if we have the new data shape (back-
  // compat with legacy DigestLeague payloads that pre-date these fields).
  const positionsRow =
    league.strongest && league.weakest
      ? `
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#71717a;font-weight:600;margin-top:16px;margin-bottom:4px;">Position strength</div>
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
          ${positionSummaryHtml("Strongest", league.strongest)}
          ${positionSummaryHtml("Weakest", league.weakest)}
        </table>`
      : "";

  // This-week movers — risers + fallers in two columns.
  const moversRow =
    (league.topRisers && league.topRisers.length > 0) ||
    (league.topFallers && league.topFallers.length > 0)
      ? `
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#71717a;font-weight:600;margin-top:16px;margin-bottom:4px;">This week</div>
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
          ${(league.topRisers ?? []).map((m) => moverRowHtml(m, "up")).join("")}
          ${(league.topFallers ?? []).map((m) => moverRowHtml(m, "down")).join("")}
        </table>`
      : "";

  // Trade-partner section — only when we have a weakest position AND
  // partners with surplus there. A league where everyone's flat at TE
  // (no clear surplus team) gets no section, which is honest.
  const tradePartnerRow =
    league.weakest && league.tradePartners && league.tradePartners.length > 0
      ? `
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#71717a;font-weight:600;margin-top:16px;margin-bottom:4px;">
          Trade partners at ${escapeHtml(league.weakest.position)}
        </div>
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
          ${league.tradePartners
            .map(
              (tp) => `
                <tr>
                  <td style="padding:4px 0;font-size:13px;">
                    <strong>@${escapeHtml(tp.ownerName)}</strong>
                    <span style="color:#16a34a;"> · +${tp.surplusPct}%</span>
                    <div style="font-size:12px;color:#71717a;margin-top:1px;">
                      ${tp.topPlayers
                        .map(
                          (p) =>
                            `${escapeHtml(p.name)} (${p.dpv})`,
                        )
                        .join(" · ")}
                    </div>
                  </td>
                </tr>`,
            )
            .join("")}
        </table>`
      : "";

  // Existing sell + trade rows — kept but moved below the new sections
  // since the new content is the lead, not the supporting cast.
  const sellRows = league.topSells
    .map(
      (p) => `
        <tr>
          <td style="padding:6px 0;font-size:13px;">
            <strong>${escapeHtml(p.name)}</strong>
            <span style="color:#71717a;"> · ${escapeHtml(p.position)} · PYV ${p.dpv}</span>
          </td>
          <td style="padding:6px 0;font-size:12px;text-align:right;">
            <span style="display:inline-block;padding:2px 8px;border-radius:4px;background:${toneBg(p.sellWindow.tone)};color:${toneFg(p.sellWindow.tone)};font-weight:600;">${escapeHtml(p.sellWindow.label)}</span>
          </td>
        </tr>`,
    )
    .join("");

  const tradeRows = league.topTrades
    .map(
      (t) => `
        <tr>
          <td style="padding:8px 0;font-size:13px;">
            Send <strong>${escapeHtml(t.give.name)}</strong> →
            Receive <strong>${escapeHtml(t.receive.name)}</strong>
            <div style="font-size:11px;color:#71717a;margin-top:2px;">${escapeHtml(t.rationale)}</div>
          </td>
        </tr>`,
    )
    .join("");

  // Header line — verdict + composite + rank within the league.
  // totalRosters comes from any positionRank entry (they all share it);
  // fall back to a plain rank if we don't have positions populated.
  const totalRosters =
    league.strongest?.totalRosters ?? league.weakest?.totalRosters;
  const rankSuffix =
    league.cardRank !== undefined
      ? totalRosters
        ? ` · ${ordinalSuffix(league.cardRank)} of ${totalRosters}`
        : ` · ${ordinalSuffix(league.cardRank)}`
      : "";

  return `
    <tr>
      <td style="padding:16px 28px 8px;">
        <div style="border:1px solid #e4e4e7;border-radius:6px;padding:16px 18px;">
          <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:10px;">
            <h2 style="font-size:15px;font-weight:600;margin:0;">${escapeHtml(league.leagueName)}</h2>
            <span style="font-size:12px;color:#52525b;">
              ${escapeHtml(league.card.verdict)} · ${league.card.composite}/100${rankSuffix}
            </span>
          </div>

          ${positionsRow}
          ${moversRow}
          ${tradePartnerRow}

          ${
            tradeRows
              ? `<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#71717a;font-weight:600;margin-top:18px;margin-bottom:4px;">Top trade idea</div>
                 <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${tradeRows}</table>`
              : ""
          }

          ${
            sellRows
              ? `<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#71717a;font-weight:600;margin-top:14px;margin-bottom:4px;">Sell-window flags</div>
                 <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${sellRows}</table>`
              : ""
          }

          <div style="margin-top:16px;">
            <a href="${escapeHtml(base)}/league/${escapeHtml(league.leagueId)}"
               style="display:inline-block;padding:8px 14px;background:#16a34a;color:#ffffff;text-decoration:none;border-radius:4px;font-size:13px;font-weight:500;">
              Open league →
            </a>
          </div>
        </div>
      </td>
    </tr>`;
}

function noLeaguesBlockHtml(): string {
  return `
    <tr>
      <td style="padding:16px 28px;font-size:13px;color:#52525b;">
        You haven't synced a Sleeper league yet. Once you do, we'll
        surface sell-window flags, trade ideas, and your team's report
        card here every week.
      </td>
    </tr>`;
}

// ---- Plain text ----------------------------------------------------------

function buildText(args: DigestInput & { greeting: string }): string {
  const lines: string[] = [];
  lines.push(`Pylon · Weekly Digest`);
  lines.push("");
  lines.push(`Hi ${args.greeting},`);
  lines.push(`Here's how your dynasty rosters moved this week.`);
  lines.push("");
  if (args.leagues.length === 0) {
    lines.push(
      "You haven't synced a Sleeper league yet. Visit your Pylon dashboard to get started.",
    );
  } else {
    for (const l of args.leagues) {
      lines.push(`— ${l.leagueName} —`);
      const total =
        l.strongest?.totalRosters ?? l.weakest?.totalRosters ?? null;
      const rankPart =
        l.cardRank !== undefined
          ? total
            ? ` · ${ordinalSuffix(l.cardRank)} of ${total}`
            : ` · ${ordinalSuffix(l.cardRank)}`
          : "";
      lines.push(`${l.card.verdict} · ${l.card.composite}/100${rankPart}`);

      if (l.strongest && l.weakest) {
        lines.push("");
        lines.push(
          `Strongest: ${l.strongest.position} — ${ordinalSuffix(l.strongest.rank)} of ${l.strongest.totalRosters}${l.strongest.deltaPct !== 0 ? ` (${l.strongest.deltaPct > 0 ? "+" : ""}${l.strongest.deltaPct}% vs avg)` : ""}`,
        );
        lines.push(
          `Weakest:   ${l.weakest.position} — ${ordinalSuffix(l.weakest.rank)} of ${l.weakest.totalRosters}${l.weakest.deltaPct !== 0 ? ` (${l.weakest.deltaPct > 0 ? "+" : ""}${l.weakest.deltaPct}% vs avg)` : ""}`,
        );
      }

      const hasMovers =
        (l.topRisers && l.topRisers.length > 0) ||
        (l.topFallers && l.topFallers.length > 0);
      if (hasMovers) {
        lines.push("");
        lines.push("This week:");
        for (const m of l.topRisers ?? []) {
          lines.push(
            `  ↑ ${m.name} (${m.position}) +${m.delta} PYV`,
          );
        }
        for (const m of l.topFallers ?? []) {
          lines.push(`  ↓ ${m.name} (${m.position}) ${m.delta} PYV`);
        }
      }

      if (
        l.weakest &&
        l.tradePartners &&
        l.tradePartners.length > 0
      ) {
        lines.push("");
        lines.push(`Trade partners at ${l.weakest.position}:`);
        for (const tp of l.tradePartners) {
          const players = tp.topPlayers
            .map((p) => `${p.name} (${p.dpv})`)
            .join(", ");
          lines.push(
            `  • @${tp.ownerName} (+${tp.surplusPct}%) — ${players}`,
          );
        }
      }

      if (l.topTrades.length > 0) {
        lines.push("");
        lines.push("Top trade idea:");
        for (const t of l.topTrades) {
          lines.push(
            `  • Send ${t.give.name} → Receive ${t.receive.name}`,
          );
          lines.push(`    ${t.rationale}`);
        }
      }

      if (l.topSells.length > 0) {
        lines.push("");
        lines.push("Sell-window flags:");
        for (const p of l.topSells) {
          lines.push(
            `  • ${p.sellWindow.label}: ${p.name} (${p.position}, PYV ${p.dpv})`,
          );
        }
      }

      lines.push("");
      lines.push(`Open league: ${args.appBaseUrl}/league/${l.leagueId}`);
      lines.push("");
    }
  }
  lines.push("---");
  lines.push(`Unsubscribe: ${args.unsubscribeUrl}`);
  lines.push(`Manage preferences: ${args.appBaseUrl}/account`);
  return lines.join("\n");
}

// ---- helpers -------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toneBg(tone: SellWindow["tone"]): string {
  switch (tone) {
    case "bad":
      return "#fee2e2";
    case "warn":
      return "#fef3c7";
    case "good":
      return "#dbeafe";
    case "elite":
      return "#dcfce7";
    case "neutral":
    default:
      return "#f4f4f5";
  }
}

function toneFg(tone: SellWindow["tone"]): string {
  switch (tone) {
    case "bad":
      return "#991b1b";
    case "warn":
      return "#92400e";
    case "good":
      return "#1e40af";
    case "elite":
      return "#166534";
    case "neutral":
    default:
      return "#3f3f46";
  }
}
