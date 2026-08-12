import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import {
  RUN_COMPARISON_SCHEMA_VERSION,
  validateRunComparisonDocument
} from "./schema.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const CLASSIFICATIONS = [
  "IMPROVEMENT",
  "STABLE",
  "REGRESSION",
  "NOT_COMPARABLE",
  "ADDED",
  "REMOVED",
  "UNAVAILABLE"
];

function threshold(value) {
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) {
    throw new Error("Regression threshold must be a number between 0 and 1000.");
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1000) {
    throw new Error("Regression threshold must be a number between 0 and 1000.");
  }
  return parsed;
}

export function parseHistoricalComparisonArguments(
  args,
  environment = process.env
) {
  const values = new Map();
  const supported = new Set(["--baseline", "--target", "--threshold"]);
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!supported.has(option)) throw new Error(`Unknown option: ${option}`);
    if (values.has(option)) throw new Error(`Duplicate option: ${option}`);
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${option} requires a value.`);
    }
    values.set(option, value);
  }
  if (!values.has("--baseline")) {
    throw new Error("--baseline requires a run ID.");
  }
  return {
    baselineRunId: values.get("--baseline"),
    targetRunId: values.get("--target") ?? null,
    thresholdPercent: threshold(
      values.get("--threshold") ??
      environment.LAB_REGRESSION_THRESHOLD_PERCENT ??
      "10"
    )
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [
      key,
      canonicalize(value[key])
    ]));
  }
  return value;
}

function fingerprint(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function machineDetails(metadata) {
  return {
    platform: metadata.runtime.platform,
    arch: metadata.runtime.arch,
    cpuModel: metadata.hardware.cpuModel,
    logicalCpuCount: metadata.hardware.logicalCpuCount,
    totalMemoryBytes: metadata.hardware.totalMemoryBytes
  };
}

function runReference(run) {
  const { benchmark } = run;
  return {
    runId: benchmark.runId,
    generatedAt: benchmark.generatedAt,
    schemaVersion: benchmark.schemaVersion,
    nodeVersion: benchmark.metadata.runtime.nodeVersion,
    compilers: {
      ts6: benchmark.metadata.compilers.ts6.version,
      ts7: benchmark.metadata.compilers.ts7.version
    },
    git: benchmark.metadata.git
  };
}

function measurementConfiguration(benchmark) {
  const configuration = benchmark.configuration;
  return {
    runs: configuration.runs,
    warmups: configuration.warmups,
    coldRuns: configuration.coldRuns ?? null,
    timeoutMs: configuration.timeoutMs ?? null,
    orderStrategy: configuration.orderStrategy ?? null,
    resourceMeasurement: configuration.resourceMeasurement ?? null
  };
}

function inputConfiguration(benchmark) {
  return {
    fixtures: benchmark.configuration.fixtures,
    variants: benchmark.configuration.variants,
    fixturePreset: benchmark.configuration.fixturePreset ?? null
  };
}

function difference(field, baseline, target) {
  return { field, baseline: baseline ?? null, target: target ?? null };
}

function compareEnvironment(baseline, target) {
  const baselineMachine = machineDetails(baseline.metadata);
  const targetMachine = machineDetails(target.metadata);
  const baselineMachineFingerprint = fingerprint(baselineMachine);
  const targetMachineFingerprint = fingerprint(targetMachine);
  const machineMatch = baselineMachineFingerprint === targetMachineFingerprint;
  const nodeVersionMatch = baseline.metadata.runtime.nodeVersion ===
    target.metadata.runtime.nodeVersion;
  const baselineMeasurement = measurementConfiguration(baseline);
  const targetMeasurement = measurementConfiguration(target);
  const measurementConfigurationMatch = isDeepStrictEqual(
    baselineMeasurement,
    targetMeasurement
  );
  const baselineInputs = inputConfiguration(baseline);
  const targetInputs = inputConfiguration(target);
  const inputConfigurationMatch = isDeepStrictEqual(
    baselineInputs,
    targetInputs
  );
  const sourceStateClean = !baseline.metadata.git.dirty &&
    !target.metadata.git.dirty;
  const differences = [];
  for (const [field, baselineValue, targetValue] of [
    ["metadata.runtime.platform", baselineMachine.platform, targetMachine.platform],
    ["metadata.runtime.arch", baselineMachine.arch, targetMachine.arch],
    ["metadata.hardware.cpuModel", baselineMachine.cpuModel, targetMachine.cpuModel],
    [
      "metadata.hardware.logicalCpuCount",
      baselineMachine.logicalCpuCount,
      targetMachine.logicalCpuCount
    ],
    [
      "metadata.hardware.totalMemoryBytes",
      baselineMachine.totalMemoryBytes,
      targetMachine.totalMemoryBytes
    ],
    [
      "metadata.runtime.nodeVersion",
      baseline.metadata.runtime.nodeVersion,
      target.metadata.runtime.nodeVersion
    ]
  ]) {
    if (!isDeepStrictEqual(baselineValue, targetValue)) {
      differences.push(difference(field, baselineValue, targetValue));
    }
  }
  if (!measurementConfigurationMatch) {
    differences.push(difference(
      "benchmark.measurementConfiguration",
      fingerprint(baselineMeasurement),
      fingerprint(targetMeasurement)
    ));
  }
  if (!inputConfigurationMatch) {
    differences.push(difference(
      "benchmark.inputConfiguration",
      fingerprint(baselineInputs),
      fingerprint(targetInputs)
    ));
  }

  const warnings = [];
  if (!machineMatch) {
    warnings.push(
      "Machine fingerprints differ; performance deltas are descriptive only."
    );
  }
  if (!nodeVersionMatch) {
    warnings.push(
      "Node.js versions differ; JavaScript compiler performance is not directly comparable."
    );
  }
  if (!measurementConfigurationMatch) {
    warnings.push(
      "Measurement configuration differs; threshold classifications are suppressed."
    );
  }
  if (!inputConfigurationMatch) {
    warnings.push(
      "At least one fixture, variant, or size preset differs; affected rows are not comparable."
    );
  }
  if (!sourceStateClean) {
    warnings.push(
      "One or both runs were recorded from a dirty working tree; inspect their Git metadata."
    );
  }
  const performanceComparable = machineMatch && nodeVersionMatch &&
    measurementConfigurationMatch && inputConfigurationMatch;
  return {
    status: warnings.length === 0 ? "COMPARABLE" : "CAUTION",
    performanceComparable,
    machineMatch,
    nodeVersionMatch,
    measurementConfigurationMatch,
    inputConfigurationMatch,
    sourceStateClean,
    baselineMachineFingerprint,
    targetMachineFingerprint,
    baselineMachine,
    targetMachine,
    differences,
    warnings
  };
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function performanceObservation(result) {
  if (!result) return null;
  const statistics = result.statistics;
  const samples = statistics?.samplesMs ?? result.samplesMs ?? [];
  return {
    status: result.status ?? "complete",
    medianMs: statistics?.medianMs ?? result.medianMs ?? null,
    meanMs: statistics?.meanMs ?? mean(samples),
    p95Ms: statistics?.p95Ms ?? result.p95Ms ?? null,
    successfulSamples: statistics?.successfulSamples ?? samples.length,
    plannedSamples: statistics?.plannedSamples ?? samples.length
  };
}

function definitions(benchmark) {
  return {
    fixtures: new Map(
      benchmark.configuration.fixtures.map((fixture) => [fixture.name, fixture])
    ),
    variants: new Map(
      benchmark.configuration.variants.map((variant) => [variant.name, variant])
    ),
    fixturePreset: benchmark.configuration.fixturePreset ?? null
  };
}

function validMedian(observation) {
  return observation && typeof observation.medianMs === "number" &&
    Number.isFinite(observation.medianMs) && observation.medianMs >= 0;
}

function comparisonNotes({
  environment,
  inputsMatch,
  baseline,
  target
}) {
  const notes = [];
  if (!environment.machineMatch) notes.push("machine fingerprint differs");
  if (!environment.nodeVersionMatch) notes.push("Node.js version differs");
  if (!environment.measurementConfigurationMatch) {
    notes.push("measurement configuration differs");
  }
  if (!inputsMatch) notes.push("fixture, variant, or preset input differs");
  if (!environment.sourceStateClean) notes.push("dirty Git worktree recorded");
  if (baseline && baseline.status !== "complete") {
    notes.push(`baseline status is ${baseline.status}`);
  }
  if (target && target.status !== "complete") {
    notes.push(`target status is ${target.status}`);
  }
  return notes;
}

function collectPerformance(baseline, target, thresholdPercent, environment) {
  const baselineResults = new Map(baseline.results.map((result) => [
    `${result.fixture}\0${result.variant}`,
    result
  ]));
  const targetResults = new Map(target.results.map((result) => [
    `${result.fixture}\0${result.variant}`,
    result
  ]));
  const baselineDefinitions = definitions(baseline);
  const targetDefinitions = definitions(target);
  const presetMatch = isDeepStrictEqual(
    baselineDefinitions.fixturePreset,
    targetDefinitions.fixturePreset
  );
  const keys = new Set([...baselineResults.keys(), ...targetResults.keys()]);
  return [...keys].sort().map((key) => {
    const separator = key.indexOf("\0");
    const fixture = key.slice(0, separator);
    const variant = key.slice(separator + 1);
    const baselineObservation = performanceObservation(baselineResults.get(key));
    const targetObservation = performanceObservation(targetResults.get(key));
    const inputsMatch = presetMatch && isDeepStrictEqual(
      baselineDefinitions.fixtures.get(fixture),
      targetDefinitions.fixtures.get(fixture)
    ) && isDeepStrictEqual(
      baselineDefinitions.variants.get(variant),
      targetDefinitions.variants.get(variant)
    );
    const resultStatusesComparable = baselineObservation?.status === "complete" &&
      targetObservation?.status === "complete";
    const comparable = environment.machineMatch &&
      environment.nodeVersionMatch &&
      environment.measurementConfigurationMatch &&
      inputsMatch &&
      resultStatusesComparable;
    const notes = comparisonNotes({
      environment,
      inputsMatch,
      baseline: baselineObservation,
      target: targetObservation
    });

    let classification;
    let deltaMs = null;
    let deltaPercent = null;
    if (!baselineObservation) {
      classification = "ADDED";
    } else if (!targetObservation) {
      classification = "REMOVED";
    } else if (
      !validMedian(baselineObservation) ||
      !validMedian(targetObservation) ||
      baselineObservation.medianMs === 0
    ) {
      classification = "UNAVAILABLE";
      notes.push("a finite non-zero baseline median is unavailable");
    } else {
      deltaMs = targetObservation.medianMs - baselineObservation.medianMs;
      deltaPercent = deltaMs / baselineObservation.medianMs * 100;
      if (!comparable) {
        classification = "NOT_COMPARABLE";
      } else if (deltaPercent > thresholdPercent) {
        classification = "REGRESSION";
      } else if (deltaPercent < -thresholdPercent) {
        classification = "IMPROVEMENT";
      } else {
        classification = "STABLE";
      }
    }
    return {
      fixture,
      variant,
      classification,
      comparable,
      inputsMatch,
      baseline: baselineObservation,
      target: targetObservation,
      deltaMs,
      deltaPercent,
      notes
    };
  });
}

function compatibilityObservation(status, evidence) {
  return { status, fingerprint: fingerprint(evidence) };
}

function collectCompatibilityObservations(comparison) {
  const observations = new Map();
  for (const diagnostic of comparison.diagnostics) {
    const status = diagnostic.classification ?? diagnostic.status;
    const evidence = {
      status,
      ts6: diagnostic.ts6,
      ts7: diagnostic.ts7,
      difference: diagnostic.difference ?? null,
      knownDifferences: diagnostic.knownDifferences ?? []
    };
    observations.set(
      `diagnostics\0${diagnostic.fixture}`,
      compatibilityObservation(status, evidence)
    );
  }
  observations.set(
    "emit\0emit",
    compatibilityObservation(comparison.emit.status, comparison.emit)
  );
  for (const option of comparison.compilerOptions ?? []) {
    const evidence = {
      status: option.status,
      classifications: option.classifications,
      ts6: option.ts6,
      ts7: option.ts7,
      migration: option.migration
    };
    observations.set(
      `compiler-options\0${option.id}`,
      compatibilityObservation(option.status, evidence)
    );
  }
  return observations;
}

function collectCompatibility(baseline, target) {
  const baselineObservations = collectCompatibilityObservations(baseline);
  const targetObservations = collectCompatibilityObservations(target);
  const keys = new Set([
    ...baselineObservations.keys(),
    ...targetObservations.keys()
  ]);
  return [...keys].sort().map((compoundKey) => {
    const separator = compoundKey.indexOf("\0");
    const area = compoundKey.slice(0, separator);
    const key = compoundKey.slice(separator + 1);
    const baselineObservation = baselineObservations.get(compoundKey) ?? null;
    const targetObservation = targetObservations.get(compoundKey) ?? null;
    const change = !baselineObservation
      ? "ADDED"
      : !targetObservation
        ? "REMOVED"
        : baselineObservation.fingerprint === targetObservation.fingerprint
          ? "UNCHANGED"
          : "CHANGED";
    return {
      area,
      key,
      change,
      baseline: baselineObservation,
      target: targetObservation
    };
  });
}

function summarize(performance, compatibility) {
  const performanceClassifications = Object.fromEntries(
    CLASSIFICATIONS.map((classification) => [classification, 0])
  );
  for (const row of performance) {
    performanceClassifications[row.classification] += 1;
  }
  return {
    performanceRows: performance.length,
    performanceClassifications,
    compatibilityRows: compatibility.length,
    compatibilityChanges: compatibility.filter(
      (row) => row.change !== "UNCHANGED"
    ).length
  };
}

export function createHistoricalComparison(
  baselineRun,
  targetRun,
  options = {}
) {
  const thresholdPercent = options.thresholdPercent ?? 10;
  if (
    typeof thresholdPercent !== "number" ||
    !Number.isFinite(thresholdPercent) ||
    thresholdPercent < 0 ||
    thresholdPercent > 1000
  ) {
    throw new Error("Regression threshold must be between 0 and 1000 percent.");
  }
  const comparability = compareEnvironment(
    baselineRun.benchmark,
    targetRun.benchmark
  );
  const performance = collectPerformance(
    baselineRun.benchmark,
    targetRun.benchmark,
    thresholdPercent,
    comparability
  );
  const compatibility = collectCompatibility(
    baselineRun.comparison,
    targetRun.comparison
  );
  const comparison = {
    schemaVersion: RUN_COMPARISON_SCHEMA_VERSION,
    kind: "run-comparison",
    generatedAt: (options.now ?? (() => new Date().toISOString()))(),
    thresholdPercent,
    baseline: runReference(baselineRun),
    target: runReference(targetRun),
    comparability,
    summary: summarize(performance, compatibility),
    performance,
    compatibility
  };
  return validateRunComparisonDocument(comparison);
}

function formatDuration(value) {
  return typeof value === "number" ? `${value.toFixed(1)} ms` : "—";
}

function formatPercent(value) {
  if (typeof value !== "number") return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

export function formatHistoricalComparisonMarkdown(comparison) {
  const warningBlock = comparison.comparability.warnings.length
    ? comparison.comparability.warnings.map((warning) => `- ${warning}`).join("\n")
    : "No environment or input warnings were detected.";
  const performanceRows = comparison.performance.map((row) =>
    `| ${row.fixture} | ${row.variant} | ` +
    `${formatDuration(row.baseline?.medianMs)} | ` +
    `${formatDuration(row.target?.medianMs)} | ` +
    `${formatPercent(row.deltaPercent)} | ${row.classification} | ` +
    `${row.comparable ? "yes" : "no"} | ` +
    `${row.baseline?.successfulSamples ?? 0}/${row.baseline?.plannedSamples ?? 0} → ` +
    `${row.target?.successfulSamples ?? 0}/${row.target?.plannedSamples ?? 0} |`
  ).join("\n");
  const compatibilityRows = comparison.compatibility.map((row) =>
    `| ${row.area} | ${row.key} | ${row.baseline?.status ?? "—"} | ` +
    `${row.target?.status ?? "—"} | ${row.change} |`
  ).join("\n");
  const counts = comparison.summary.performanceClassifications;
  return `# Historical Run Comparison

Generated: ${comparison.generatedAt}
Baseline: ${comparison.baseline.runId} (TS6 ${comparison.baseline.compilers.ts6}, TS7 ${comparison.baseline.compilers.ts7}, Node ${comparison.baseline.nodeVersion}, Git ${comparison.baseline.git.commitSha ?? "unavailable"})
Target: ${comparison.target.runId} (TS6 ${comparison.target.compilers.ts6}, TS7 ${comparison.target.compilers.ts7}, Node ${comparison.target.nodeVersion}, Git ${comparison.target.git.commitSha ?? "unavailable"})
Regression threshold: ${comparison.thresholdPercent}%

## Comparability

Status: **${comparison.comparability.status}**

- Machine fingerprint: ${comparison.comparability.machineMatch ? "match" : "different"}
- Node.js version: ${comparison.comparability.nodeVersionMatch ? "match" : "different"}
- Measurement configuration: ${comparison.comparability.measurementConfigurationMatch ? "match" : "different"}
- Fixture and variant inputs: ${comparison.comparability.inputConfigurationMatch ? "match" : "different"}
- Clean source states: ${comparison.comparability.sourceStateClean ? "yes" : "no"}

${warningBlock}

Performance deltas remain visible when conditions differ, but threshold-based
regression or improvement labels are emitted only for comparable rows.
Positive percentages mean the target is slower.

## Performance

| Fixture | Variant | Baseline median | Target median | Change | Classification | Comparable | Successful samples |
|---|---|---:|---:|---:|---|---|---|
${performanceRows}

Summary: ${counts.REGRESSION} regression, ${counts.IMPROVEMENT} improvement,
${counts.STABLE} stable, ${counts.NOT_COMPARABLE} not comparable,
${counts.ADDED} added, ${counts.REMOVED} removed, ${counts.UNAVAILABLE} unavailable.

## Compatibility

Compatibility rows compare normalized observation fingerprints. \`CHANGED\` means
the status or recorded evidence changed; it does not automatically mean regression.

| Area | Key | Baseline | Target | Change |
|---|---|---|---|---|
${compatibilityRows}
`;
}

function csvCell(value) {
  const source = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(source)
    ? `"${source.replaceAll('"', '""')}"`
    : source;
}

export function formatHistoricalComparisonCsv(comparison) {
  const rows = [[
    "type",
    "area",
    "fixture",
    "variant",
    "baseline",
    "target",
    "deltaPercent",
    "status",
    "comparable",
    "notes"
  ]];
  for (const row of comparison.performance) {
    rows.push([
      "performance",
      "wall-time",
      row.fixture,
      row.variant,
      row.baseline?.medianMs ?? null,
      row.target?.medianMs ?? null,
      row.deltaPercent,
      row.classification,
      row.comparable,
      row.notes.join("; ")
    ]);
  }
  for (const row of comparison.compatibility) {
    rows.push([
      "compatibility",
      row.area,
      row.key,
      "",
      row.baseline?.status ?? null,
      row.target?.status ?? null,
      null,
      row.change,
      "",
      ""
    ]);
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

export async function writeHistoricalComparison(comparison, options = {}) {
  validateRunComparisonDocument(comparison);
  const outputRoot = options.outputRoot ?? path.join(
    projectRoot,
    "reports",
    "comparisons"
  );
  const outputDirectory = path.join(
    outputRoot,
    `${comparison.baseline.runId}--${comparison.target.runId}`
  );
  await mkdir(outputDirectory, { recursive: true });
  const paths = {
    json: path.join(outputDirectory, "comparison.json"),
    markdown: path.join(outputDirectory, "comparison.md"),
    csv: path.join(outputDirectory, "comparison.csv")
  };
  await Promise.all([
    writeFile(paths.json, `${JSON.stringify(comparison, null, 2)}\n`),
    writeFile(paths.markdown, formatHistoricalComparisonMarkdown(comparison)),
    writeFile(paths.csv, formatHistoricalComparisonCsv(comparison))
  ]);
  return paths;
}
