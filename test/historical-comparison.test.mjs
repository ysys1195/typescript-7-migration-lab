import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createHistoricalComparison,
  formatHistoricalComparisonCsv,
  formatHistoricalComparisonMarkdown,
  parseHistoricalComparisonArguments,
  writeHistoricalComparison
} from "../scripts/historical-comparison.mjs";
import { validateRunComparisonDocument } from "../scripts/schema.mjs";
import {
  createComparisonResult,
  createCurrentBenchmarkResult,
  createLegacyBenchmarkResult,
  defaultRunId
} from "./helpers/result-documents.mjs";

const targetRunId = "223e4567-e89b-42d3-b456-426614174001";
const generatedAt = "2026-08-12T12:00:00.000Z";

function currentRun(runId) {
  return {
    benchmark: createCurrentBenchmarkResult({ runId }),
    comparison: createComparisonResult({ runId })
  };
}

function historicalComparison(changeMedian = 12, options = {}) {
  const baseline = currentRun(defaultRunId);
  const target = currentRun(targetRunId);
  target.benchmark.results[0].statistics.medianMs = changeMedian;
  return createHistoricalComparison(baseline, target, {
    thresholdPercent: options.thresholdPercent ?? 10,
    now: () => generatedAt
  });
}

test("historical comparison classifies fixture and variant median changes", () => {
  const comparison = historicalComparison();
  const changed = comparison.performance.find((row) =>
    row.fixture === "many-files" && row.variant === "ts7-checkers-1"
  );
  assert.equal(changed.classification, "REGRESSION");
  assert.equal(changed.comparable, true);
  assert.equal(changed.deltaPercent, 20);
  assert.equal(comparison.summary.performanceClassifications.REGRESSION, 1);
  assert.equal(validateRunComparisonDocument(comparison), comparison);
});

test("historical comparison validator rejects inconsistent summaries", () => {
  const invalid = structuredClone(historicalComparison());
  invalid.summary.performanceClassifications.REGRESSION = 0;
  assert.throws(
    () => validateRunComparisonDocument(invalid),
    /semantic validation failed/
  );
});

test("regression threshold is inclusive of stable changes", () => {
  const changedRow = (comparison) => comparison.performance.find((row) =>
    row.fixture === "many-files" && row.variant === "ts7-checkers-1"
  );
  assert.equal(
    changedRow(historicalComparison(11)).classification,
    "STABLE"
  );
  assert.equal(
    changedRow(historicalComparison(8)).classification,
    "IMPROVEMENT"
  );
});

test("machine differences suppress threshold assertions", () => {
  const baseline = currentRun(defaultRunId);
  const target = currentRun(targetRunId);
  target.benchmark.metadata.hardware.cpuModel = "Different CPU";
  target.benchmark.results[0].statistics.medianMs = 20;
  const comparison = createHistoricalComparison(baseline, target, {
    thresholdPercent: 5,
    now: () => generatedAt
  });
  assert.equal(comparison.comparability.machineMatch, false);
  assert.equal(comparison.comparability.status, "CAUTION");
  assert.equal(comparison.performance[0].classification, "NOT_COMPARABLE");
  assert.match(comparison.comparability.warnings[0], /descriptive only/);
});

test("partial fixture results suppress threshold assertions", () => {
  const baseline = currentRun(defaultRunId);
  const target = currentRun(targetRunId);
  target.benchmark.results[0].status = "partial";
  target.benchmark.results[0].statistics.medianMs = 20;
  const comparison = createHistoricalComparison(baseline, target, {
    thresholdPercent: 5,
    now: () => generatedAt
  });
  const changed = comparison.performance.find((row) =>
    row.fixture === "many-files" && row.variant === "ts7-checkers-1"
  );
  assert.equal(changed.classification, "NOT_COMPARABLE");
  assert.match(changed.notes.join(" "), /target status is partial/);
});

test("fixture input differences affect only matching performance rows", () => {
  const baseline = currentRun(defaultRunId);
  const target = currentRun(targetRunId);
  target.benchmark.configuration.fixtures[0].args.push("--traceResolution");
  const comparison = createHistoricalComparison(baseline, target, {
    now: () => generatedAt
  });
  const manyFiles = comparison.performance.filter(
    (row) => row.fixture === "many-files"
  );
  const builder = comparison.performance.filter(
    (row) => row.fixture === "builder-scaling"
  );
  assert.equal(manyFiles.every((row) => !row.inputsMatch), true);
  assert.equal(builder.every((row) => row.inputsMatch), true);
  assert.equal(comparison.comparability.inputConfigurationMatch, false);
});

test("compatibility fingerprints detect evidence changes without naming regression", () => {
  const baseline = currentRun(defaultRunId);
  const target = currentRun(targetRunId);
  target.comparison.diagnostics[0].ts7.stdout = "changed raw evidence";
  const comparison = createHistoricalComparison(baseline, target, {
    now: () => generatedAt
  });
  const diagnostic = comparison.compatibility.find((row) =>
    row.area === "diagnostics" && row.key === "small"
  );
  assert.equal(diagnostic.change, "CHANGED");
  assert.equal(diagnostic.baseline.status, diagnostic.target.status);
  assert.equal(comparison.summary.compatibilityChanges, 1);
});

test("legacy benchmark statistics remain comparable", () => {
  const baseline = {
    benchmark: createLegacyBenchmarkResult(),
    comparison: createComparisonResult({ runId: defaultRunId })
  };
  const target = {
    benchmark: createLegacyBenchmarkResult(),
    comparison: createComparisonResult({ runId: targetRunId })
  };
  target.benchmark.runId = targetRunId;
  target.benchmark.results[0].medianMs = 15;
  const comparison = createHistoricalComparison(baseline, target, {
    now: () => generatedAt
  });
  assert.equal(comparison.performance[0].baseline.medianMs, 10);
  assert.equal(comparison.performance[0].target.medianMs, 15);
  assert.equal(comparison.performance[0].classification, "REGRESSION");
});

test("argument parser supports explicit target and environment threshold", () => {
  assert.deepEqual(parseHistoricalComparisonArguments([
    "--baseline",
    defaultRunId,
    "--target",
    targetRunId
  ], { LAB_REGRESSION_THRESHOLD_PERCENT: "7.5" }), {
    baselineRunId: defaultRunId,
    targetRunId,
    thresholdPercent: 7.5
  });
  assert.throws(
    () => parseHistoricalComparisonArguments([]),
    /--baseline/
  );
  assert.throws(
    () => parseHistoricalComparisonArguments([
      "--baseline",
      defaultRunId,
      "--threshold",
      "ten"
    ]),
    /must be a number/
  );
});

test("Markdown, JSON, and CSV exports preserve comparison status", async (t) => {
  const comparison = historicalComparison();
  const markdown = formatHistoricalComparisonMarkdown(comparison);
  const csv = formatHistoricalComparisonCsv(comparison);
  assert.match(markdown, /Historical Run Comparison/);
  assert.match(markdown, /REGRESSION/);
  assert.match(csv, /^type,area,fixture,variant,/);
  assert.match(csv, /performance,wall-time,many-files,ts7-checkers-1/);

  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "ts7-history-test-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const paths = await writeHistoricalComparison(comparison, { outputRoot });
  const stored = JSON.parse(await readFile(paths.json, "utf8"));
  assert.equal(stored.kind, "run-comparison");
  assert.equal(stored.summary.performanceClassifications.REGRESSION, 1);
  assert.equal(await readFile(paths.markdown, "utf8"), markdown);
  assert.equal(await readFile(paths.csv, "utf8"), csv);
});
