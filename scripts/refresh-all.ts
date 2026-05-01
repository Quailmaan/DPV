import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// DPV refresh orchestrator — runs every ingest + compute script in dependency
// order so a full data refresh is a single command. Each step is independent
// and safe to re-run. Skip individual steps with --skip=name1,name2. Any
// failure halts the pipeline (exit 1) so stale downstream data isn't written
// on top of a broken upstream step.
//
// Usage:
//   npx tsx scripts/refresh-all.ts
//   npx tsx scripts/refresh-all.ts --skip=ingest,sync-teams

type Step = {
  name: string;
  cmd: string;
  args: string[];
  note: string;
};

// Python entrypoint — prefers the repo's .venv if present (matches the setup
// documented at the top of scripts/ingest.py), falls back to system Python.
function resolvePython(): string {
  const venvWin = resolve(".venv/Scripts/python.exe");
  const venvUnix = resolve(".venv/bin/python");
  if (existsSync(venvWin)) return venvWin;
  if (existsSync(venvUnix)) return venvUnix;
  return process.platform === "win32" ? "python" : "python3";
}

const PY = resolvePython();
const TSX = ["npx", "tsx"] as const;

const STEPS: Step[] = [
  {
    name: "ingest",
    cmd: PY,
    args: ["scripts/ingest.py"],
    note: "nflverse rosters, weekly stats, snaps, team context, market values (populates draft_round from draft_picks.csv)",
  },
  {
    name: "sync-teams",
    cmd: TSX[0],
    args: [TSX[1], "scripts/sync-teams.ts"],
    note: "Sleeper current_team refresh — catches free agency + trades + newly-drafted rookies",
  },
  {
    name: "sync-draft-capital",
    cmd: TSX[0],
    args: [TSX[1], "scripts/sync-draft-capital.ts"],
    note: "Belt-and-suspenders draft_round/draft_year sync for anyone ingest missed",
  },
  {
    name: "ingest-combine",
    cmd: TSX[0],
    args: [TSX[1], "scripts/ingest-combine.ts"],
    note: "NFL combine + pro-day measurables → athleticism_score",
  },
  {
    name: "sync-nflverse-draft",
    cmd: TSX[0],
    args: [TSX[1], "scripts/sync-nflverse-draft.ts"],
    note: "Pull actual draft results for the incoming class from nflverse — replaces speculative seed entries with ground truth (no-op pre-draft each year, ground truth post-draft)",
  },
  {
    name: "ingest-prospects",
    cmd: TSX[0],
    args: [TSX[1], "scripts/ingest-prospects.ts", "data/prospects.csv"],
    note: "Upsert manually-curated prospect rows from data/prospects.csv into the prospects table — required so commits to the CSV (e.g. adding a new mock-draft source) flow through to the rookies page automatically",
  },
  {
    name: "compute-prospect-consensus",
    cmd: TSX[0],
    args: [TSX[1], "scripts/compute-prospect-consensus.ts"],
    note: "Aggregate per-source prospect grades into cross-source consensus",
  },
  {
    name: "compute-class-strength",
    cmd: TSX[0],
    args: [TSX[1], "scripts/compute-class-strength.ts"],
    note: "Per-year class strength aggregate (R1 / top-15 offensive counts)",
  },
  {
    name: "compute-hsm",
    cmd: TSX[0],
    args: [TSX[1], "scripts/compute-hsm.ts"],
    note: "Veteran HSM — similarity-weighted Y+1/Y+2/Y+3 PPG projections",
  },
  {
    name: "compute-rookie-hsm",
    cmd: TSX[0],
    args: [TSX[1], "scripts/compute-rookie-hsm.ts"],
    note: "Rookie HSM — pre-draft-profile nearest-neighbor projections",
  },
  {
    name: "compute-dpv",
    cmd: TSX[0],
    args: [TSX[1], "scripts/compute-dpv.ts"],
    note: "Final DPV snapshots (veterans + rookie priors, with scarcity)",
  },
];

function parseSkip(): Set<string> {
  const arg = process.argv.find((a) => a.startsWith("--skip="));
  if (!arg) return new Set();
  return new Set(
    arg
      .slice("--skip=".length)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = (s - m * 60).toFixed(1);
  return `${m}m${rem}s`;
}

type Result = { name: string; status: "ok" | "failed" | "skipped"; ms: number };

async function main() {
  const skip = parseSkip();
  const knownNames = new Set(STEPS.map((s) => s.name));
  for (const s of skip) {
    if (!knownNames.has(s)) {
      console.warn(`WARN: --skip contains unknown step "${s}" (ignored)`);
    }
  }

  console.log("DPV refresh pipeline");
  console.log(`  steps: ${STEPS.length}, skipping: ${skip.size ? [...skip].join(", ") : "(none)"}`);
  console.log(`  python: ${PY}`);
  console.log();

  const results: Result[] = [];
  const totalStart = Date.now();

  for (const step of STEPS) {
    if (skip.has(step.name)) {
      console.log(`[skip] ${step.name} — ${step.note}`);
      results.push({ name: step.name, status: "skipped", ms: 0 });
      continue;
    }
    console.log(`[run ] ${step.name} — ${step.note}`);
    const start = Date.now();
    // shell:true is needed on Windows only for bare command names (so PATHEXT
    // resolves `npx` → `npx.cmd`). For absolute paths like the venv python,
    // shell:true routes through cmd.exe and breaks on spaces in the repo path
    // (e.g. "C:\Users\billy\Desktop\FF Site\..."). Detect by looking for any
    // path separator in cmd. Safe either way: every cmd/arg in STEPS is a
    // hardcoded literal, no user input.
    const isAbsolutePath = step.cmd.includes("\\") || step.cmd.includes("/");
    const useShell = process.platform === "win32" && !isAbsolutePath;
    const r = spawnSync(step.cmd, step.args, {
      stdio: "inherit",
      shell: useShell,
    });
    const ms = Date.now() - start;

    if (r.status !== 0) {
      console.error(
        `[fail] ${step.name} exited with status ${r.status} after ${formatDuration(ms)}`,
      );
      results.push({ name: step.name, status: "failed", ms });
      printSummary(results, Date.now() - totalStart);
      process.exit(1);
    }
    console.log(`[ok  ] ${step.name} (${formatDuration(ms)})\n`);
    results.push({ name: step.name, status: "ok", ms });
  }

  printSummary(results, Date.now() - totalStart);
}

function printSummary(results: Result[], totalMs: number) {
  console.log("─".repeat(60));
  console.log("Summary");
  for (const r of results) {
    const marker =
      r.status === "ok" ? "ok " : r.status === "skipped" ? "skip" : "FAIL";
    const dur = r.status === "skipped" ? "" : ` ${formatDuration(r.ms)}`;
    console.log(`  [${marker}] ${r.name}${dur}`);
  }
  console.log(`  total: ${formatDuration(totalMs)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
