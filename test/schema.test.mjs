import assert from "node:assert/strict";
import test from "node:test";
import { validateResultDocument } from "../scripts/schema.mjs";
import {
  createBenchmarkResult,
  createComparisonResult,
  createLegacyBenchmarkResult
} from "./helpers/result-documents.mjs";

const benchmark = createBenchmarkResult();
const comparison = createComparisonResult();

test("benchmark result follows schema version 2.0.0", () => {
  assert.equal(validateResultDocument(benchmark), benchmark);
});

test("legacy benchmark result remains readable", () => {
  const legacy = createLegacyBenchmarkResult();
  assert.equal(validateResultDocument(legacy), legacy);
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
    outliers: []
  };
  assert.equal(validateResultDocument(failed), failed);
});

test("version 2 benchmark rejects the legacy result shape", () => {
  const invalid = createLegacyBenchmarkResult();
  invalid.schemaVersion = "2.0.0";
  assert.throws(
    () => validateResultDocument(invalid),
    /Result schema validation failed/
  );
});

test("version 2 benchmark rejects an attempt in the wrong phase", () => {
  const invalid = structuredClone(benchmark);
  invalid.results[0].measurementAttempts[0].phase = "cold";
  assert.throws(
    () => validateResultDocument(invalid),
    /semantic validation failed/
  );
});

test("version 2 benchmark rejects inconsistent success fields", () => {
  const invalid = structuredClone(benchmark);
  invalid.results[0].measurementAttempts[0].exitCode = 7;
  assert.throws(
    () => validateResultDocument(invalid),
    /semantic validation failed/
  );
});

test("version 2 benchmark rejects inconsistent statistics counts", () => {
  const invalid = structuredClone(benchmark);
  invalid.results[0].statistics.successfulSamples = 99;
  assert.throws(
    () => validateResultDocument(invalid),
    /semantic validation failed/
  );
});

test("version 2 benchmark accepts signal-terminated compiler attempts", () => {
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
    samplesMs: successful.map((item) => item.elapsedMs)
  };
  assert.equal(validateResultDocument(crashed), crashed);
});

test("version 2 benchmark rejects contradictory compiler failure fields", () => {
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

test("version 2 benchmark rejects missing fixture results", () => {
  const invalid = structuredClone(benchmark);
  invalid.results = [];
  invalid.configuration.executionPlan = [];
  assert.throws(
    () => validateResultDocument(invalid),
    /semantic validation failed/
  );
});

test("comparison result follows schema version 2.0.0", () => {
  assert.equal(validateResultDocument(comparison), comparison);
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
  invalid.schemaVersion = "3.0.0";
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
