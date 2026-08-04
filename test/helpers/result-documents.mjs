export const defaultRunId = "123e4567-e89b-42d3-a456-426614174000";

export const defaultMetadata = {
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

function common(overrides) {
  return {
    schemaVersion: "1.0.0",
    runId: defaultRunId,
    generatedAt: "2026-07-30T12:00:00.000Z",
    metadata: structuredClone(defaultMetadata),
    ...overrides
  };
}

export function createBenchmarkResult(overrides = {}) {
  return {
    ...common(overrides),
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
}

export function createComparisonResult(overrides = {}) {
  return {
    ...common(overrides),
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
}
