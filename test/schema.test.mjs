import assert from "node:assert/strict";
import test from "node:test";
import { validateResultDocument } from "../scripts/schema.mjs";

const metadata = {
  compilers: {
    ts6: { version: "6.0.3", executable: "node_modules/.bin/tsc6" },
    ts7: { version: "7.0.2", executable: "node_modules/.bin/tsc" }
  },
  runtime: { nodeVersion: "v24.0.0", platform: "darwin", arch: "arm64" },
  hardware: {
    cpuModel: "Test CPU",
    logicalCpuCount: 8,
    totalMemoryBytes: 16_000_000_000
  },
  git: {
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    branch: "agent/test",
    dirty: false
  }
};

const common = {
  schemaVersion: "1.0.0",
  runId: "123e4567-e89b-42d3-a456-426614174000",
  generatedAt: "2026-07-30T12:00:00.000Z",
  metadata
};

const benchmark = {
  ...common,
  kind: "benchmark",
  configuration: {
    runs: 3,
    warmups: 1,
    fixtures: [{ name: "small", args: ["-p", "fixtures/small"] }],
    variants: [{ name: "ts6", compiler: "ts6", extraArgs: [] }]
  },
  results: [{
    fixture: "small",
    variant: "ts6",
    medianMs: 10,
    p95Ms: 12,
    minMs: 9,
    maxMs: 12,
    samplesMs: [9, 10, 12],
    compilerDiagnostics: { Files: { value: 64, unit: "" } }
  }]
};

const comparison = {
  ...common,
  kind: "comparison",
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
  }],
  emit: {
    status: "IDENTICAL",
    ts6ExitCode: 0,
    ts7ExitCode: 0,
    ts6Output: [],
    ts7Output: [],
    files: []
  }
};

test("benchmark result follows schema version 1.0.0", () => {
  assert.equal(validateResultDocument(benchmark), benchmark);
});

test("comparison result follows schema version 1.0.0", () => {
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
  invalid.schemaVersion = "2.0.0";
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
