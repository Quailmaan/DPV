/**
 * Quick status of the "Refresh rankings" GitHub Actions workflow.
 * Prints the last few runs (conclusion, duration, commit) and, for the
 * most recent run, which step failed. Uses the public GitHub API — no
 * auth, no gh CLI needed (works because run/job metadata is public on a
 * public repo). Log *bodies* still require auth; read those in the
 * Actions UI.
 *
 *   npx tsx scripts/check-ci.ts          # last 8 runs
 *   npx tsx scripts/check-ci.ts 20       # last 20
 */
export {}; // module marker so top-level fns don't collide with other scripts

const REPO = "Quailmaan/DPV";
const WORKFLOW = "refresh.yml";
const H = { "User-Agent": "pylon-ci-check", Accept: "application/vnd.github+json" };

type Run = {
  run_number: number;
  conclusion: string | null;
  status: string;
  run_started_at: string;
  updated_at: string;
  head_sha: string;
  jobs_url: string;
  head_commit: { message: string };
};

async function api<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: H });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${url}`);
  return (await res.json()) as T;
}

function dur(start: string, end: string): string {
  const s = Math.max(0, Math.round((+new Date(end) - +new Date(start)) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}

async function main() {
  const limit = Math.max(1, parseInt(process.argv[2] ?? "8", 10) || 8);
  const { workflow_runs: runs } = await api<{ workflow_runs: Run[] }>(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=${limit}`,
  );

  console.log(`Last ${runs.length} "Refresh rankings" runs:\n`);
  for (const r of runs) {
    const mark =
      r.conclusion === "success"
        ? "ok  "
        : r.conclusion === null
          ? "... "
          : "FAIL";
    const d = r.conclusion ? dur(r.run_started_at, r.updated_at) : r.status;
    console.log(
      `  [${mark}] #${String(r.run_number).padEnd(4)} ${d.padEnd(7)} ${r.head_sha.slice(0, 7)}  ${r.head_commit.message.split("\n")[0].slice(0, 54)}`,
    );
  }

  // For the latest run, show which step failed (the actionable bit).
  const latest = runs[0];
  if (latest && latest.conclusion && latest.conclusion !== "success") {
    const { jobs } = await api<{
      jobs: Array<{
        name: string;
        conclusion: string | null;
        steps: Array<{ name: string; conclusion: string | null; number: number }>;
      }>;
    }>(latest.jobs_url);
    console.log(`\nLatest run #${latest.run_number} step breakdown:`);
    for (const j of jobs) {
      for (const s of j.steps) {
        const flag =
          s.conclusion === "failure"
            ? "  ← FAILED HERE"
            : s.conclusion === "skipped"
              ? " (skipped)"
              : "";
        console.log(`  [${s.conclusion}] ${s.name}${flag}`);
      }
    }
    console.log(
      `\nRead the error log in the Actions UI: that failed step → scroll to the bottom.`,
    );
  } else if (latest?.conclusion === "success") {
    console.log(`\nLatest run is green. 🎉`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
