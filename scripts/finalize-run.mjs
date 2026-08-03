import { resultStore } from "./result-store.mjs";

const runId = process.argv[2] ?? process.env.LAB_RUN_ID;
if (!runId) {
  throw new Error("Provide a run ID or set LAB_RUN_ID.");
}

await resultStore.finalizeRun(runId);
console.log(`${runId}: finalized and marked as latest`);
