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

export type DigestLeague = {
  leagueId: string;
  leagueName: string;
  /** Focused team's report card. Always present — we generate a card per league. */
  card: Pick<ReportCard, "composite" | "verdict">;
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
          <p style="font-size:14px;color:#52525b;margin:0 0 8px;">Here's what changed across your dynasty rosters this week.</p>
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

function leagueBlockHtml(league: DigestLeague, base: string): string {
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

  return `
    <tr>
      <td style="padding:16px 28px 8px;">
        <div style="border:1px solid #e4e4e7;border-radius:6px;padding:16px 18px;">
          <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:10px;">
            <h2 style="font-size:15px;font-weight:600;margin:0;">${escapeHtml(league.leagueName)}</h2>
            <span style="font-size:12px;color:#52525b;">
              ${escapeHtml(league.card.verdict)} · ${league.card.composite}/100
            </span>
          </div>

          ${
            sellRows
              ? `<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#71717a;font-weight:600;margin-top:14px;margin-bottom:4px;">Sell-window flags</div>
                 <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${sellRows}</table>`
              : ""
          }

          ${
            tradeRows
              ? `<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#71717a;font-weight:600;margin-top:18px;margin-bottom:4px;">Trade ideas</div>
                 <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${tradeRows}</table>`
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
  lines.push(`Here's what changed across your dynasty rosters this week.`);
  lines.push("");
  if (args.leagues.length === 0) {
    lines.push(
      "You haven't synced a Sleeper league yet. Visit your Pylon dashboard to get started.",
    );
  } else {
    for (const l of args.leagues) {
      lines.push(`— ${l.leagueName} —`);
      lines.push(`${l.card.verdict} · ${l.card.composite}/100`);
      if (l.topSells.length > 0) {
        lines.push("");
        lines.push("Sell-window flags:");
        for (const p of l.topSells) {
          lines.push(
            `  • ${p.sellWindow.label}: ${p.name} (${p.position}, PYV ${p.dpv})`,
          );
        }
      }
      if (l.topTrades.length > 0) {
        lines.push("");
        lines.push("Trade ideas:");
        for (const t of l.topTrades) {
          lines.push(
            `  • Send ${t.give.name} → Receive ${t.receive.name}`,
          );
          lines.push(`    ${t.rationale}`);
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
