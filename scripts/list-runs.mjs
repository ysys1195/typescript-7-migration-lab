import { resultStore } from "./result-store.mjs";

const completeOnly = process.argv.includes("--complete-only");
const runs = await resultStore.listRuns({ includeIncomplete: !completeOnly });

if (runs.length === 0) {
  console.log("No runs found.");
} else {
  console.table(runs.map((run) => ({
    runId: run.runId,
    status: run.status,
    createdAt: run.createdAt ?? "—",
    completedAt: run.completedAt ?? "—",
    error: run.error ?? ""
  })));
}
