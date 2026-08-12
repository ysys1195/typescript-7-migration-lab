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
    schemaVersion: "3.0.0",
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
      resourceMeasurement: {
        collector: "darwin-time-l",
        scope: "timed-process",
        cpuTime: { status: "available" },
        peakRss: { status: "available" }
      },
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
        outliers: [],
        resourceStatistics: {
          cpuTimeMs: {
            availableSamples: 3,
            unavailableSamples: 0,
            samples: [5, 6, 7],
            mean: 6,
            median: 6,
            min: 5,
            max: 7
          },
          peakRssBytes: {
            availableSamples: 3,
            unavailableSamples: 0,
            samples: [1_000, 1_100, 1_200],
            mean: 1_100,
            median: 1_100,
            min: 1_000,
            max: 1_200
          }
        }
      },
      compilerDiagnostics: { Files: { value: 64, unit: "" } }
    }]
  };
}

export function createAttempt(overrides = {}) {
  const sequence = overrides.sequence ?? 0;
  return {
    phase: "measured",
    round: 0,
    sequence,
    status: "success",
    elapsedMs: 10,
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    error: null,
    resourceUsage: {
      collector: "darwin-time-l",
      scope: "timed-process",
      cpuTime: {
        status: "available",
        userMs: sequence + 2,
        systemMs: 1,
        totalMs: sequence + 3
      },
      peakRss: {
        status: "available",
        bytes: 800 + sequence * 100
      }
    },
    ...overrides
  };
}

export function createVersion2BenchmarkResult() {
  const result = createBenchmarkResult({ schemaVersion: "2.0.0" });
  delete result.configuration.resourceMeasurement;
  for (const benchmarkResult of result.results) {
    const attempts = [
      benchmarkResult.coldRun,
      ...benchmarkResult.warmupAttempts,
      ...benchmarkResult.measurementAttempts
    ];
    for (const attempt of attempts) delete attempt.resourceUsage;
    delete benchmarkResult.statistics.resourceStatistics;
  }
  return result;
}

export function createScalingBenchmarkResult() {
  const source = createBenchmarkResult({ schemaVersion: "3.1.0" });
  const definitions = [
    ...[1, 2, 4, 8].map((workers) => ({
      fixture: "many-files",
      variant: {
        name: `ts7-checkers-${workers}`,
        compiler: "ts7",
        extraArgs: ["--checkers", String(workers)],
        applicableFixtures: ["many-files"],
        scaling: {
          axis: "checkers",
          requestedWorkers: workers,
          baselineWorkers: 1
        }
      }
    })),
    ...[1, 2, 4].map((workers) => ({
      fixture: "builder-scaling",
      variant: {
        name: `ts7-builders-${workers}`,
        compiler: "ts7",
        extraArgs: ["--builders", String(workers), "--checkers", "1"],
        applicableFixtures: ["builder-scaling"],
        scaling: {
          axis: "builders",
          requestedWorkers: workers,
          baselineWorkers: 1,
          fixedCheckers: 1
        }
      }
    }))
  ];
  source.configuration.fixtures = [
    { name: "many-files", args: ["-p", "fixtures/many-files"] },
    {
      name: "builder-scaling",
      args: ["--build", "fixtures/builder-scaling", "--force"]
    }
  ];
  source.configuration.variants = definitions.map(({ variant }) => variant);
  source.configuration.executionPlan = [];
  source.results = [];
  let sequence = 0;
  for (const { fixture, variant } of definitions) {
    const result = structuredClone(createBenchmarkResult().results[0]);
    result.fixture = fixture;
    result.variant = variant.name;
    for (const attempt of [
      result.coldRun,
      ...result.warmupAttempts,
      ...result.measurementAttempts
    ]) {
      attempt.sequence = sequence;
      source.configuration.executionPlan.push({
        sequence,
        phase: attempt.phase,
        round: attempt.round,
        fixture,
        variant: variant.name
      });
      sequence += 1;
    }
    source.results.push(result);
  }
  return source;
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
    ...common({ schemaVersion: "4.1.0", ...overrides }),
    kind: "comparison",
    configuration: {
      diagnosticFixtures: [{ name: "small" }],
      knownDiagnosticDifferences: {
        path: "compatibility/known-diagnostic-differences.json",
        version: 1
      },
      compilerOptionCatalog: {
        path: "compatibility/compiler-options.json",
        version: 1
      },
      emitFixture: "emit"
    },
    diagnostics: [{
      fixture: "small",
      classification: "SUPPORTED_IDENTICALLY",
      knownDifferences: [],
      difference: {
        diagnostics: { status: "IDENTICAL", onlyTs6: [], onlyTs7: [] },
        exitCode: { status: "IDENTICAL", ts6: 0, ts7: 0 }
      },
      ts6: {
        exitCode: 0,
        diagnostics: [],
        rawOutput: { stdout: "", stderr: "" }
      },
      ts7: {
        exitCode: 0,
        diagnostics: [],
        rawOutput: { stdout: "", stderr: "" }
      }
    }],
    compilerOptions: [{
      id: "target-es5",
      option: "target=ES5",
      classifications: ["DEPRECATED_IN_TS6", "REMOVED_IN_TS7"],
      transition: "TS6_DEPRECATION_TO_TS7_REMOVAL",
      fixture: "fixtures/compiler-options/target-es5",
      rationale: "ES5 is below the supported target floor.",
      migration: "Choose ES2015 or newer.",
      source: "https://devblogs.microsoft.com/typescript/announcing-typescript-7-0-beta/",
      reproduction: "npm run options -- --id target-es5",
      probe: {
        kind: "diagnostics",
        expected: {
          ts6: { exitCode: 2, diagnosticCodes: [5107], emittedFiles: [] },
          ts7: { exitCode: 1, diagnosticCodes: [5108], emittedFiles: [] }
        }
      },
      status: "MATCHED_EXPECTATION",
      ts6: {
        exitCode: 2,
        diagnostics: [{
          code: 5107,
          category: "error",
          file: "fixtures/compiler-options/target-es5/tsconfig.json",
          line: 4,
          column: 15,
          message: "Deprecated target."
        }],
        rawOutput: { stdout: "TS6 output", stderr: "" },
        emittedFiles: []
      },
      ts7: {
        exitCode: 1,
        diagnostics: [{
          code: 5108,
          category: "error",
          file: "fixtures/compiler-options/target-es5/tsconfig.json",
          line: 4,
          column: 15,
          message: "Removed target."
        }],
        rawOutput: { stdout: "TS7 output", stderr: "" },
        emittedFiles: []
      }
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
