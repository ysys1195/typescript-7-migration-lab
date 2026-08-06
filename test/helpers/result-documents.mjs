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
    schemaVersion: "2.0.0",
    runId: defaultRunId,
    generatedAt: "2026-07-30T12:00:00.000Z",
    metadata: structuredClone(defaultMetadata),
    ...overrides
  };
}

export function createBenchmarkResult(overrides = {}) {
  const coldRun = createAttempt({ phase: "cold", round: 0, sequence: 0 });
  const warmupAttempt = createAttempt({
    phase: "warmup",
    round: 0,
    sequence: 1
  });
  const measurementAttempts = [9, 10, 12].map((elapsedMs, round) =>
    createAttempt({
      phase: "measured",
      round,
      sequence: round + 2,
      elapsedMs
    })
  );
  return {
    ...common(overrides),
    kind: "benchmark",
    configuration: {
      runs: 3,
      warmups: 1,
      coldRuns: 1,
      timeoutMs: 120000,
      orderStrategy: "rotating-v1",
      fixtures: [{ name: "small", args: ["-p", "fixtures/small"] }],
      variants: [{ name: "ts6", compiler: "ts6", extraArgs: [] }],
      executionPlan: [
        { sequence: 0, phase: "cold", round: 0, fixture: "small", variant: "ts6" },
        { sequence: 1, phase: "warmup", round: 0, fixture: "small", variant: "ts6" },
        ...measurementAttempts.map(({ sequence, phase, round }) => ({
          sequence,
          phase,
          round,
          fixture: "small",
          variant: "ts6"
        }))
      ],
      replay: {
        command: "npm run lab",
        environment: {
          LAB_RUNS: "3",
          LAB_WARMUPS: "1",
          LAB_FIXTURE_TIMEOUT_MS: "120000",
          LAB_FILE_COUNT: "400"
        }
      }
    },
    results: [{
      fixture: "small",
      variant: "ts6",
      status: "complete",
      coldRun,
      warmupAttempts: [warmupAttempt],
      measurementAttempts,
      statistics: {
        plannedSamples: 3,
        successfulSamples: 3,
        failedSamples: 0,
        samplesMs: [9, 10, 12],
        meanMs: 31 / 3,
        standardDeviationMs: 1.247219128924647,
        medianMs: 10,
        p95Ms: 12,
        minMs: 9,
        maxMs: 12,
        outliers: []
      },
      compilerDiagnostics: { Files: { value: 64, unit: "" } }
    }]
  };
}

export function createAttempt(overrides = {}) {
  return {
    phase: "measured",
    round: 0,
    sequence: 0,
    status: "success",
    elapsedMs: 10,
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    error: null,
    ...overrides
  };
}

export function createLegacyBenchmarkResult() {
  return {
    ...common({ schemaVersion: "1.0.0" }),
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
      compilerDiagnostics: {}
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
