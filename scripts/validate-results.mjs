import { readResultJson } from "./lib.mjs";
import { resultStore } from "./result-store.mjs";

function readRunId(args) {
  const index = args.indexOf("--run-id");
  if (index === -1) return null;
  if (!args[index + 1]) throw new Error("--run-id requires a value.");
  if (args.length !== 2) {
    throw new Error("--run-id cannot be combined with result filenames.");
  }
  return args[index + 1];
}

const args = process.argv.slice(2);
const requestedRunId = readRunId(args) ?? process.env.LAB_RUN_ID ?? null;

if (!args.includes("--run-id") && args.length > 0) {
  for (const filename of args) {
    if (!["benchmark.json", "comparison.json"].includes(filename)) {
      throw new Error(`Unknown result filename: ${filename}`);
    }
    await readResultJson(filename);
    console.log(`${filename}: valid`);
  }
  process.exit(0);
}

const run = requestedRunId
  ? await resultStore.readRun(requestedRunId, { requireComplete: false })
  : await resultStore.readLatestRun();

console.log(`${run.benchmark.runId}/benchmark.json: valid`);
console.log(`${run.comparison.runId}/comparison.json: valid`);
