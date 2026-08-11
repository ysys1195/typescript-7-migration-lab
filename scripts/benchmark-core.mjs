import { median, percentile } from "./lib.mjs";
import { unavailableResourceUsage } from "./resource-measurement.mjs";

export const ORDER_STRATEGY = "rotating-v1";

export function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function populationStandardDeviation(values) {
  if (values.length === 0) return null;
  const average = mean(values);
  return Math.sqrt(
    values.reduce((total, value) => total + (value - average) ** 2, 0) /
      values.length
  );
}

function interpolatedQuantile(sortedValues, fraction) {
  const position = (sortedValues.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  const weight = position - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

export function detectOutliers(samples) {
  if (samples.length < 4) return [];
  const sorted = samples.map(({ elapsedMs }) => elapsedMs).sort((a, b) => a - b);
  const q1 = interpolatedQuantile(sorted, 0.25);
  const q3 = interpolatedQuantile(sorted, 0.75);
  const iqr = q3 - q1;
  const lowerFence = q1 - 1.5 * iqr;
  const upperFence = q3 + 1.5 * iqr;
  return samples
    .map((sample, sampleIndex) => ({ sample, sampleIndex }))
    .filter(({ sample }) =>
      sample.elapsedMs < lowerFence || sample.elapsedMs > upperFence
    )
    .map(({ sample, sampleIndex }) => ({
      sampleIndex,
      round: sample.round,
      elapsedMs: sample.elapsedMs,
      lowerFence,
      upperFence
    }));
}

export function summarizeAttempts(measurementAttempts, plannedSamples) {
  const successful = measurementAttempts.filter(
    (attempt) => attempt.status === "success"
  );
  const samplesMs = successful.map((attempt) => attempt.elapsedMs);
  if (samplesMs.length === 0) {
    return {
      plannedSamples,
      successfulSamples: 0,
      failedSamples: measurementAttempts.length,
      samplesMs: [],
      meanMs: null,
      standardDeviationMs: null,
      medianMs: null,
      p95Ms: null,
      minMs: null,
      maxMs: null,
      outliers: [],
      resourceStatistics: summarizeResourceUsage(measurementAttempts)
    };
  }
  return {
    plannedSamples,
    successfulSamples: samplesMs.length,
    failedSamples: measurementAttempts.length - samplesMs.length,
    samplesMs,
    meanMs: mean(samplesMs),
    standardDeviationMs: populationStandardDeviation(samplesMs),
    medianMs: median(samplesMs),
    p95Ms: percentile(samplesMs, 0.95),
    minMs: Math.min(...samplesMs),
    maxMs: Math.max(...samplesMs),
    outliers: detectOutliers(successful),
    resourceStatistics: summarizeResourceUsage(measurementAttempts)
  };
}

function summarizeMetric(measurementAttempts, metricName, valueSelector) {
  const successful = measurementAttempts.filter(
    (attempt) => attempt.status === "success"
  );
  const available = successful.filter(
    (attempt) => attempt.resourceUsage[metricName].status === "available"
  );
  const samples = available.map((attempt) =>
    valueSelector(attempt.resourceUsage[metricName])
  );
  if (samples.length === 0) {
    return {
      availableSamples: 0,
      unavailableSamples: successful.length,
      samples: [],
      mean: null,
      median: null,
      min: null,
      max: null
    };
  }
  return {
    availableSamples: samples.length,
    unavailableSamples: successful.length - samples.length,
    samples,
    mean: mean(samples),
    median: median(samples),
    min: Math.min(...samples),
    max: Math.max(...samples)
  };
}

export function summarizeResourceUsage(measurementAttempts) {
  return {
    cpuTimeMs: summarizeMetric(
      measurementAttempts,
      "cpuTime",
      (metric) => metric.totalMs
    ),
    peakRssBytes: summarizeMetric(
      measurementAttempts,
      "peakRss",
      (metric) => metric.bytes
    )
  };
}

export function buildExecutionPlan({ fixtures, variants, warmups, runs }) {
  const phases = [
    { phase: "cold", count: 1, baseRound: 0 },
    { phase: "warmup", count: warmups, baseRound: 1 },
    { phase: "measured", count: runs, baseRound: 1 + warmups }
  ];
  const plan = [];
  let sequence = 0;

  fixtures.forEach((fixture, fixtureIndex) => {
    for (const { phase, count, baseRound } of phases) {
      for (let round = 0; round < count; round += 1) {
        const offset = (fixtureIndex + baseRound + round) % variants.length;
        for (let position = 0; position < variants.length; position += 1) {
          const variant = variants[(offset + position) % variants.length];
          plan.push({
            sequence,
            phase,
            round,
            fixture: fixture.name,
            variant: variant.name
          });
          sequence += 1;
        }
      }
    }
  });
  return plan;
}

function createAttempt(planItem, result) {
  const status = result.timedOut
    ? "timeout"
    : result.exitCode === 0
      ? "success"
      : "compiler-error";
  return {
    phase: planItem.phase,
    round: planItem.round,
    sequence: planItem.sequence,
    status,
    elapsedMs: result.elapsedMs,
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    error: null,
    resourceUsage: result.resourceUsage ?? unavailableResourceUsage(
      result.timedOut ? "attempt-timeout" : "measurement-not-returned"
    )
  };
}

function createRunnerErrorAttempt(planItem, error, resourceUsage) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    phase: planItem.phase,
    round: planItem.round,
    sequence: planItem.sequence,
    status: "runner-error",
    elapsedMs: null,
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    error: message || "Unknown runner error",
    resourceUsage
  };
}

export async function executeBenchmarkPlan({
  executionPlan,
  fixtures,
  variants,
  runs,
  timeoutMs,
  execute,
  parseDiagnostics,
  runnerErrorResourceUsage = unavailableResourceUsage("runner-error")
}) {
  const fixtureByName = new Map(fixtures.map((fixture) => [fixture.name, fixture]));
  const variantByName = new Map(variants.map((variant) => [variant.name, variant]));
  const results = new Map();

  for (const fixture of fixtures) {
    for (const variant of variants) {
      results.set(`${fixture.name}\0${variant.name}`, {
        fixture: fixture.name,
        variant: variant.name,
        coldRun: null,
        warmupAttempts: [],
        measurementAttempts: [],
        compilerDiagnostics: {}
      });
    }
  }

  for (const planItem of executionPlan) {
    const fixture = fixtureByName.get(planItem.fixture);
    const variant = variantByName.get(planItem.variant);
    const args = [...fixture.args, ...variant.extraArgs, "--pretty", "false"];
    let attempt;
    try {
      const outcome = await execute(variant.compiler, args, { timeoutMs });
      attempt = createAttempt(planItem, outcome);
    } catch (error) {
      attempt = createRunnerErrorAttempt(
        planItem,
        error,
        structuredClone(runnerErrorResourceUsage)
      );
    }

    const result = results.get(`${planItem.fixture}\0${planItem.variant}`);
    if (planItem.phase === "cold") result.coldRun = attempt;
    if (planItem.phase === "warmup") result.warmupAttempts.push(attempt);
    if (planItem.phase === "measured") {
      result.measurementAttempts.push(attempt);
      if (attempt.status === "success") {
        result.compilerDiagnostics = parseDiagnostics(
          attempt.stdout + attempt.stderr
        );
      }
    }
  }

  return [...results.values()].map((result) => {
    const statistics = summarizeAttempts(result.measurementAttempts, runs);
    const allAttempts = [
      result.coldRun,
      ...result.warmupAttempts,
      ...result.measurementAttempts
    ];
    const hasFailure = allAttempts.some(
      (attempt) => attempt?.status !== "success"
    );
    const status = statistics.successfulSamples === 0
      ? "failed"
      : hasFailure
        ? "partial"
        : "complete";
    return { ...result, status, statistics };
  });
}
