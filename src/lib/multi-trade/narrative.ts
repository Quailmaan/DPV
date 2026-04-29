// Plain-English narrative for a multi-team trade analysis.
//
// The deterministic pricing has already produced the verdicts (winner /
// fair / loser, sell-window flags, totals). This module's job is purely
// linguistic: turn that JSON into something a casual user can read in
// 30 seconds.
//
// Design constraints:
//   - The model NEVER changes verdicts. We pass it the verdicts and ask
//     it to phrase them. If it fabricates a different conclusion the UI
//     still shows the numeric badges next to it, which catches drift.
//   - The system prompt is locked. The only "user text" we pass is a
//     structured JSON payload — there's no free-form input box wired
//     to this, so prompt injection surface is limited to the names of
//     Sleeper rosters and players (which we sanitize lightly).
//   - Tool-use forces the output shape. We tell Claude to call exactly
//     one `summarize_trade` tool; that gives us reliable parsing without
//     having to babysit "respond in JSON" prompting.
//   - Failure is non-fatal. If the API key is missing, the call fails,
//     or the response is malformed, we return null and the UI renders
//     the numeric verdicts alone.

import Anthropic from "@anthropic-ai/sdk";
import type {
  AnalyzeTradeResult,
  TradeNarrative,
  PricedAsset,
  TeamSummary,
} from "./types";

// ---- prompt --------------------------------------------------------------

// Locked system prompt. Anything user-controlled (player names, team
// names) goes into the structured payload — never spliced into this
// string.
const SYSTEM_PROMPT = `You are Pylon, a fantasy football dynasty trade explainer.

You receive a deterministic trade analysis as JSON. Your job is to phrase it in plain English for a casual fantasy manager who doesn't follow advanced analytics. The math is already done — you do not change verdicts, percentages, or values.

Style rules:
- Write like a friendly analyst, not a sports broadcaster. No hype, no "blockbuster", no exclamation marks.
- Plain language. If you must mention values, say "by about 20%" or "by ~1,200 points", not "20.34%".
- Mention assets by name. Reference age and position when it matters (e.g., a 30-year-old RB on a winning side warrants a note).
- If a player has a SELL_NOW or SELL_SOON flag, work that into the team's take — it's the most actionable signal.
- If a player has a young-player guard note (rookie/2nd-year being acquired), call out the long-term upside.
- Never recommend the user accept or reject the trade in absolute terms. Frame it as "this side projects ahead because..." rather than "you should do this."
- Do not invent stats. Only use the numbers in the input.

Output: call the summarize_trade tool exactly once. Do not write prose outside the tool call.`;

// Tool schema — Claude will fill this in. Strict shape so the parse step
// can trust it.
const TOOL = {
  name: "summarize_trade",
  description:
    "Emit the plain-English narrative for the trade. Call this once.",
  input_schema: {
    type: "object" as const,
    required: ["overall", "teams"],
    properties: {
      overall: {
        type: "string" as const,
        description:
          "2–4 sentence summary of the trade as a whole. Mention which side(s) come out ahead and the headline reason.",
      },
      teams: {
        type: "array" as const,
        description:
          "One entry per team in the trade. Same rosterId values as the input. Order doesn't matter.",
        items: {
          type: "object" as const,
          required: ["rosterId", "summary"],
          properties: {
            rosterId: {
              type: "number" as const,
              description: "Matches a rosterId from the input.",
            },
            summary: {
              type: "string" as const,
              description:
                "1–2 sentences explaining this team's verdict in plain language. Reference specific assets and any sell-window flags.",
            },
          },
        },
      },
    },
  },
};

// ---- payload shaping -----------------------------------------------------

// Sanitize a string we're about to embed in the JSON payload. We're not
// trying to be paranoid (tool-use makes injection mostly inert), just
// trimming weird whitespace/control chars that make the model's life
// harder.
function clean(s: string | null | undefined): string {
  if (!s) return "";
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80);
}

function compactAsset(a: PricedAsset) {
  return {
    name: clean(a.name),
    position: a.position,
    age: a.age !== null ? Math.round(a.age * 10) / 10 : null,
    yearsPro: a.yearsPro,
    blendedValue: Math.round(a.blended),
    sellWindow: a.sellWindow
      ? {
          verdict: a.sellWindow.verdict,
          reason: clean(a.sellWindow.reason),
        }
      : null,
  };
}

function compactTeam(t: TeamSummary) {
  return {
    rosterId: t.rosterId,
    name: clean(t.teamName ?? t.ownerName) || `Team ${t.rosterId}`,
    verdict: t.verdict, // "winner" | "fair" | "loser"
    failsGate: t.failsGate,
    imbalancePctRounded: Math.round(t.imbalancePct * 1000) / 10, // e.g. 20.3
    receiveTotal: Math.round(t.receiveTotal),
    sendTotal: Math.round(t.sendTotal),
    netBlend: Math.round(t.netBlend),
    receives: t.receive.map(compactAsset),
    sends: t.send.map(compactAsset),
  };
}

function buildPayload(result: AnalyzeTradeResult) {
  return {
    gateThresholdPct: Math.round(result.gateThreshold * 100), // e.g. 15
    teams: result.teams.map(compactTeam),
    notes: result.notes.slice(0, 8).map(clean),
  };
}

// ---- entry point ---------------------------------------------------------

export async function generateTradeNarrative(
  result: AnalyzeTradeResult,
): Promise<TradeNarrative | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn(
      "[multi-trade narrative] ANTHROPIC_API_KEY not set — skipping narrative.",
    );
    return null;
  }

  // Default to the current production Haiku. Anthropic retired the
  // `-latest` aliases for the 3.5 line on Feb 19 2026; the
  // post-deprecation generation uses bare semver IDs
  // (claude-haiku-4-5). Override via ANTHROPIC_MODEL when a newer
  // Haiku ships.
  const model = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";
  const client = new Anthropic({ apiKey });

  const payload = buildPayload(result);

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 700,
      system: SYSTEM_PROMPT,
      tools: [TOOL],
      // Force a tool call so we get structured output instead of prose.
      tool_choice: { type: "tool", name: TOOL.name },
      messages: [
        {
          role: "user",
          content: `Deterministic trade analysis follows as JSON. Summarize it via the summarize_trade tool.\n\n\`\`\`json\n${JSON.stringify(
            payload,
            null,
            2,
          )}\n\`\`\``,
        },
      ],
    });

    // Find the tool_use block. With tool_choice forced this should always
    // be present, but be defensive.
    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      console.warn(
        `[multi-trade narrative] no tool_use block in response (model=${model}).`,
      );
      return null;
    }

    const parsed = parseToolInput(toolUse.input, result);
    if (!parsed) {
      console.warn(
        `[multi-trade narrative] tool input failed validation (model=${model}).`,
      );
    }
    return parsed;
  } catch (err) {
    // Non-fatal: log loudly so a misconfigured deploy is obvious in
    // Vercel logs, then let the UI fall back to numbers-only.
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(
      `[multi-trade narrative] generation failed (model=${model}): ${detail}`,
    );
    return null;
  }
}

// ---- parsing -------------------------------------------------------------

// Validate the model's output. We trust the schema because tool-use
// enforces it server-side, but we still want graceful handling of the
// model returning empty strings or rosterIds that don't match.
function parseToolInput(
  raw: unknown,
  result: AnalyzeTradeResult,
): TradeNarrative | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const overall = typeof r.overall === "string" ? r.overall.trim() : "";
  if (!overall) return null;

  const teamsRaw = Array.isArray(r.teams) ? r.teams : [];
  const validRosterIds = new Set(result.teams.map((t) => t.rosterId));

  const teams = teamsRaw
    .map((t): { rosterId: number; summary: string } | null => {
      if (!t || typeof t !== "object") return null;
      const tt = t as Record<string, unknown>;
      const rosterId =
        typeof tt.rosterId === "number" ? tt.rosterId : Number(tt.rosterId);
      const summary =
        typeof tt.summary === "string" ? tt.summary.trim() : "";
      if (!Number.isFinite(rosterId) || !validRosterIds.has(rosterId))
        return null;
      if (!summary) return null;
      return { rosterId, summary };
    })
    .filter((x): x is { rosterId: number; summary: string } => x !== null);

  // Require coverage: if the model skipped a team, fall back to numbers.
  // (Better to show no narrative than a partial one that confuses users.)
  if (teams.length !== result.teams.length) return null;

  return { overall, teams };
}
