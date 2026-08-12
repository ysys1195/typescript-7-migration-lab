import assert from "node:assert/strict";
import test from "node:test";
import { validateResultDocument } from "../scripts/schema.mjs";
import {
  createBenchmarkResult,
  createComparisonResult,
  createLegacyBenchmarkResult,
  createScalingBenchmarkResult,
  createVersion2BenchmarkResult
} from "./helpers/result-documents.mjs";

const benchmark = createBenchmarkResult();
const comparison = createComparisonResult();

test("benchmark result follows schema version 3.0.0", () => {
  assert.equal(validateResultDocument(benchmark), benchmark);
});

test("scaling benchmark result follows schema version 3.1.0", () => {
  const scaling = createScalingBenchmarkResult();
  assert.equal(validateResultDocument(scaling), scaling);
});

test("current benchmark result follows schema version 4.0.0", () => {
  const current = createScalingBenchmarkResult();
  current.schemaVersion = "4.0.0";
  assert.equal(validateResultDocument(current), current);
});

test("schema version 3.1 requires complete checker and builder matrices", () => {
  const invalid = createScalingBenchmarkResult();
  const removed = invalid.configuration.variants.pop();
  invalid.results = invalid.results.filter(
    (result) => result.variant !== removed.name
  );
  const keptSequences = new Set(invalid.results.flatMap((result) => [
    result.coldRun,
    ...result.warmupAttempts,
    ...result.measurementAttempts
  ]).map((attempt) => attempt.sequence));
  invalid.configuration.executionPlan = invalid.configuration.executionPlan
    .filter((item) => keptSequences.has(item.sequence));
  assert.throws(
    () => validateResultDocument(invalid),
    /semantic validation failed/
  );
});

test("schema version 3.1 rejects unknown applicable fixtures", () => {
  const invalid = createScalingBenchmarkResult();
  invalid.configuration.variants[0].applicableFixtures = ["missing"];
  assert.throws(
    () => validateResultDocument(invalid),
    /semantic validation failed/
  );
});

test("schema version 3.1 retains schema 3 resource requirements", () => {
  const invalid = createScalingBenchmarkResult();
  delete invalid.configuration.resourceMeasurement;
  assert.throws(
    () => validateResultDocument(invalid),
    /semantic validation failed/
  );
});

test("legacy benchmark result remains readable", () => {
  const legacy = createLegacyBenchmarkResult();
  assert.equal(validateResultDocument(legacy), legacy);
});

test("schema version 2 benchmark remains readable", () => {
  const version2 = createVersion2BenchmarkResult();
  assert.equal(validateResultDocument(version2), version2);
});

test("schema version 3 benchmark requires resource fields", () => {
  const invalid = structuredClone(benchmark);
  delete invalid.configuration.resourceMeasurement;
  delete invalid.results[0].coldRun.resourceUsage;
  delete invalid.results[0].statistics.resourceStatistics;
  assert.throws(
    () => validateResultDocument(invalid),
    /semantic validation failed/
  );
});

test("schema version 3 preserves unavailable metrics without zero values", () => {
  const unavailable = structuredClone(benchmark);
  for (const attempt of unavailable.results[0].measurementAttempts) {
    attempt.resourceUsage.cpuTime = {
      status: "unavailable",
      reason: "collector-probe-failed"
    };
    attempt.resourceUsage.peakRss = {
      status: "unavailable",
      reason: "collector-probe-failed"
    };
  }
  for (const metric of Object.values(
    unavailable.results[0].statistics.resourceStatistics
  )) {
    metric.availableSamples = 0;
    metric.unavailableSamples = 3;
    metric.samples = [];
    metric.mean = null;
    metric.median = null;
    metric.min = null;
    metric.max = null;
  }
  assert.equal(validateResultDocument(unavailable), unavailable);
  assert.equal(
    "totalMs" in unavailable.results[0].measurementAttempts[0]
      .resourceUsage.cpuTime,
    false
  );
});

test("schema version 3 rejects inconsistent resource coverage", () => {
  const invalid = structuredClone(benchmark);
  invalid.results[0].statistics.resourceStatistics.cpuTimeMs.availableSamples = 99;
  assert.throws(
    () => validateResultDocument(invalid),
    /semantic validation failed/
  );
});

test("schema version 3 rejects resource summaries that do not match samples", () => {
  const invalid = structuredClone(benchmark);
  invalid.results[0].statistics.resourceStatistics.cpuTimeMs.mean = 999;
  assert.throws(
    () => validateResultDocument(invalid),
    /semantic validation failed/
  );
});

test("schema version 3 rejects metrics unavailable in run capability", () => {
  const invalid = structuredClone(benchmark);
  invalid.configuration.resourceMeasurement.cpuTime = {
    status: "unavailable",
    reason: "collector-output-invalid"
  };
  assert.throws(
    () => validateResultDocument(invalid),
    /semantic validation failed/
  );
});

test("schema version 3 rejects an inconsistent CPU total", () => {
  const invalid = structuredClone(benchmark);
  invalid.results[0].measurementAttempts[0].resourceUsage.cpuTime.totalMs = 999;
  assert.throws(
    () => validateResultDocument(invalid),
    /semantic validation failed/
  );
});

test("all-failed benchmark remains valid without non-finite statistics", () => {
  const failed = structuredClone(benchmark);
  const result = failed.results[0];
  result.status = "failed";
  for (const attempt of [result.coldRun, ...result.warmupAttempts,
    ...result.measurementAttempts]) {
    attempt.status = "timeout";
    attempt.exitCode = null;
    attempt.signal = "SIGTERM";
    attempt.resourceUsage = {
      collector: "darwin-time-l",
      scope: "timed-process",
      cpuTime: { status: "unavailable", reason: "attempt-timeout" },
      peakRss: { status: "unavailable", reason: "attempt-timeout" }
    };
  }
  result.statistics = {
    ...result.statistics,
    successfulSamples: 0,
    failedSamples: result.statistics.plannedSamples,
    samplesMs: [],
    meanMs: null,
    standardDeviationMs: null,
    medianMs: null,
    p95Ms: null,
    minMs: null,
    maxMs: null,
    outliers: [],
    resourceStatistics: {
      cpuTimeMs: {
        availableSamples: 0,
        unavailableSamples: 0,
        samples: [],
        mean: null,
        median: null,
        min: null,
        max: null
      },
      peakRssBytes: {
        availableSamples: 0,
        unavailableSamples: 0,
        samples: [],
        mean: null,
        median: null,
        min: null,
        max: null
      }
    }
  };
  assert.equal(validateResultDocument(failed), failed);
});

test("version 3 benchmark rejects the legacy result shape", () => {
  const invalid = createLegacyBenchmarkResult();
  invalid.schemaVersion = "3.0.0";
  assert.throws(
    () => validateResultDocument(invalid),
    /Result schema validation failed/
  );
});

test("version 3 benchmark rejects an attempt in the wrong phase", () => {
  const invalid = structuredClone(benchmark);
  invalid.results[0].measurementAttempts[0].phase = "cold";
  assert.throws(
    () => validateResultDocument(invalid),
    /semantic validation failed/
  );
});

test("version 3 benchmark rejects inconsistent success fields", () => {
  const invalid = structuredClone(benchmark);
  invalid.results[0].measurementAttempts[0].exitCode = 7;
  assert.throws(
    () => validateResultDocument(invalid),
    /semantic validation failed/
  );
});

test("version 3 benchmark rejects inconsistent statistics counts", () => {
  const invalid = structuredClone(benchmark);
  invalid.results[0].statistics.successfulSamples = 99;
  assert.throws(
    () => validateResultDocument(invalid),
    /semantic validation failed/
  );
});

test("version 3 benchmark accepts signal-terminated compiler attempts", () => {
  const crashed = structuredClone(benchmark);
  const attempt = crashed.results[0].measurementAttempts[0];
  attempt.status = "compiler-error";
  attempt.exitCode = null;
  attempt.signal = "SIGSEGV";
  const successful = crashed.results[0].measurementAttempts.slice(1);
  crashed.results[0].status = "partial";
  crashed.results[0].statistics = {
    ...crashed.results[0].statistics,
    successfulSamples: successful.length,
    failedSamples: 1,
    samplesMs: successful.map((item) => item.elapsedMs),
    resourceStatistics: {
      cpuTimeMs: {
        availableSamples: successful.length,
        unavailableSamples: 0,
        samples: successful.map((item) => item.resourceUsage.cpuTime.totalMs),
        mean: 6.5,
        median: 6.5,
        min: 6,
        max: 7
      },
      peakRssBytes: {
        availableSamples: successful.length,
        unavailableSamples: 0,
        samples: successful.map((item) => item.resourceUsage.peakRss.bytes),
        mean: 1_150,
        median: 1_150,
        min: 1_100,
        max: 1_200
      }
    }
  };
  assert.equal(validateResultDocument(crashed), crashed);
});

test("version 3 benchmark rejects contradictory compiler failure fields", () => {
  const invalid = structuredClone(benchmark);
  const attempt = invalid.results[0].measurementAttempts[0];
  attempt.status = "compiler-error";
  attempt.exitCode = 0;
  attempt.signal = "SIGSEGV";
  assert.throws(
    () => validateResultDocument(invalid),
    /semantic validation failed/
  );
});

test("version 3 benchmark rejects missing fixture results", () => {
  const invalid = structuredClone(benchmark);
  invalid.results = [];
  invalid.configuration.executionPlan = [];
  assert.throws(
    () => validateResultDocument(invalid),
    /semantic validation failed/
  );
});

test("comparison result follows schema version 4.0.0", () => {
  assert.equal(validateResultDocument(comparison), comparison);
});

test("legacy comparison results remain readable", () => {
  const legacy = {
    ...structuredClone(comparison),
    schemaVersion: "3.1.0",
    configuration: {
      diagnosticFixtures: [{ name: "small" }],
      emitFixture: "emit"
    },
    diagnostics: [{
      fixture: "small",
      status: "IDENTICAL",
      expectedDifference: false,
      ts6: { exitCode: 0, diagnostics: [] },
      ts7: { exitCode: 0, diagnostics: [] }
    }]
  };
  assert.equal(validateResultDocument(legacy), legacy);
});

test("version 4 comparison separates diagnostic and exit-code differences", () => {
  const different = structuredClone(comparison);
  different.diagnostics[0].classification = "POSSIBLE_REGRESSION";
  different.diagnostics[0].ts7.exitCode = 1;
  different.diagnostics[0].difference.exitCode = {
    status: "DIFFERENT",
    ts6: 0,
    ts7: 1
  };
  assert.equal(validateResultDocument(different), different);
});

test("version 4 comparison rejects inconsistent structured differences", () => {
  const invalid = structuredClone(comparison);
  invalid.diagnostics[0].difference.diagnostics.onlyTs7.push({
    code: 2322,
    category: "error",
    file: "fixtures/small/src/index.ts",
    line: 1,
    column: 1,
    message: "Unexpected diagnostic"
  });
  assert.throws(
    () => validateResultDocument(invalid),
    /semantic validation failed/
  );
});

test("version 4 comparison requires evidence for known differences", () => {
  const invalid = structuredClone(comparison);
  invalid.diagnostics[0].classification = "SUPPORTED_WITH_DIFFERENCE";
  assert.throws(
    () => validateResultDocument(invalid),
    /semantic validation failed/
  );
});

test("missing schemaVersion is rejected", () => {
  const invalid = structuredClone(benchmark);
  delete invalid.schemaVersion;
  assert.throws(
    () => validateResultDocument(invalid),
    /Result schema validation failed/
  );
});

test("unsupported schemaVersion is rejected", () => {
  const invalid = structuredClone(benchmark);
  invalid.schemaVersion = "5.0.0";
  assert.throws(
    () => validateResultDocument(invalid),
    /Result schema validation failed/
  );
});

test("incomplete compiler metadata is rejected", () => {
  const invalid = structuredClone(comparison);
  delete invalid.metadata.compilers.ts7;
  assert.throws(
    () => validateResultDocument(invalid),
    /Result schema validation failed/
  );
});
