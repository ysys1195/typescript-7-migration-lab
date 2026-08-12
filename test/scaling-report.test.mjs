import assert from "node:assert/strict";
import test from "node:test";
import {
  collectScalingRows,
  formatScalingReport
} from "../scripts/scaling-report.mjs";

function result(variant, medianMs, rssMedian, workers) {
  return {
    fixture: variant.startsWith("checker") ? "many-files" : "builder-scaling",
    variant,
    statistics: {
      medianMs,
      successfulSamples: 3,
      plannedSamples: 3,
      resourceStatistics: {
        cpuTimeMs: {
          median: medianMs * workers,
          availableSamples: 3,
          unavailableSamples: 0
        },
        peakRssBytes: {
          median: rssMedian,
          availableSamples: rssMedian === null ? 0 : 3,
          unavailableSamples: rssMedian === null ? 3 : 0
        }
      }
    }
  };
}

const benchmark = {
  metadata: { hardware: { logicalCpuCount: 2 } },
  configuration: {
    variants: [
      ...[1, 2, 4, 8].map((workers) => ({
        name: `checker-${workers}`,
        scaling: {
          axis: "checkers",
          requestedWorkers: workers,
          baselineWorkers: 1
        }
      })),
      ...[1, 2, 4].map((workers) => ({
        name: `builder-${workers}`,
        scaling: {
          axis: "builders",
          requestedWorkers: workers,
          baselineWorkers: 1,
          fixedCheckers: 1
        }
      }))
    ]
  },
  results: [
    result("checker-1", 100, 100 * 1024 ** 2, 1),
    result("checker-2", 60, 120 * 1024 ** 2, 2),
    result("checker-4", 50, null, 4),
    result("checker-8", 40, 180 * 1024 ** 2, 8),
    result("builder-1", 200, 200 * 1024 ** 2, 1),
    result("builder-2", 120, 240 * 1024 ** 2, 2),
    result("builder-4", 100, 300 * 1024 ** 2, 4)
  ]
};

test("scaling rows use worker 1 as speed and RSS baseline", () => {
  const rows = collectScalingRows(benchmark);
  const checker2 = rows.find((row) =>
    row.axis === "checkers" && row.requestedWorkers === 2
  );
  assert.ok(Math.abs(checker2.speedup - 100 / 60) < 1e-12);
  assert.equal(checker2.rssDeltaBytes, 20 * 1024 ** 2);
  assert.equal(checker2.rssRatio, 1.2);
  assert.equal(checker2.oversubscribed, false);
  assert.equal(rows.find((row) => row.requestedWorkers === 8).oversubscribed, true);
});

test("scaling report keeps unavailable RSS and marks actual oversubscription", () => {
  const report = formatScalingReport(benchmark);
  assert.match(report, /### checkers/);
  assert.match(report, /### builders/);
  assert.match(report, /1\.67x/);
  assert.match(report, /unavailable \(0\/3\)/);
  assert.match(report, /request more workers than the recorded logical CPU count/);
  assert.match(report, /Checker concurrency is fixed at 1/);
});

test("missing or zero baselines do not produce infinity", () => {
  const invalidBaseline = structuredClone(benchmark);
  invalidBaseline.results[0].statistics.medianMs = 0;
  const rows = collectScalingRows(invalidBaseline);
  assert.equal(rows.find((row) =>
    row.axis === "checkers" && row.requestedWorkers === 2
  ).speedup, null);
  assert.doesNotMatch(formatScalingReport(invalidBaseline), /Infinity|NaN/);
});
