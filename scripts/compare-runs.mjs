import path from "node:path";
import {
  createHistoricalComparison,
  parseHistoricalComparisonArguments,
  writeHistoricalComparison
} from "./historical-comparison.mjs";
import { root } from "./lib.mjs";
import { resultStore } from "./result-store.mjs";

const options = parseHistoricalComparisonArguments(process.argv.slice(2));
const [baselineRun, targetRun] = await Promise.all([
  resultStore.readRun(options.baselineRunId),
  options.targetRunId
    ? resultStore.readRun(options.targetRunId)
    : resultStore.readLatestRun()
]);
const comparison = createHistoricalComparison(baselineRun, targetRun, {
  thresholdPercent: options.thresholdPercent
});
const paths = await writeHistoricalComparison(comparison);

console.log(
  `Compared ${comparison.baseline.runId} -> ${comparison.target.runId} ` +
  `with a ${comparison.thresholdPercent}% regression threshold.`
);
console.log(`Comparability: ${comparison.comparability.status}`);
for (const warning of comparison.comparability.warnings) {
  console.log(`Warning: ${warning}`);
}
for (const [format, filename] of Object.entries(paths)) {
  console.log(`${format}: ${path.relative(root, filename)}`);
}
