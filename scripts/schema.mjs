import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(
  readFileSync(path.join(root, "schemas", "result.schema.json"), "utf8")
);
const storageSchema = JSON.parse(
  readFileSync(path.join(root, "schemas", "run-storage.schema.json"), "utf8")
);
export const RESULT_SCHEMA_VERSION = schema.properties.schemaVersion.enum.at(-1);
export const RESULT_STORAGE_VERSION =
  storageSchema.$defs.runManifest.properties.storageVersion.const;

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(schema);
const validate = ajv.getSchema(schema.$id);
const validateStorage = ajv.compile(storageSchema);

function formatErrors(errors) {
  return errors
    ?.map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("\n");
}

function semanticError(message) {
  throw new Error(`Result semantic validation failed:\n${message}`);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function validateAttemptSemantics(attempt, expectedPhase, label) {
  if (attempt.phase !== expectedPhase) {
    semanticError(`${label} must use phase ${expectedPhase}.`);
  }
  if (attempt.status === "success" && (
    typeof attempt.elapsedMs !== "number" ||
    attempt.exitCode !== 0 ||
    attempt.signal !== null ||
    attempt.error !== null
  )) {
    semanticError(`${label} has inconsistent success fields.`);
  }
  if (attempt.status === "compiler-error" && (
    typeof attempt.elapsedMs !== "number" ||
    !(
      (Number.isInteger(attempt.exitCode) &&
        attempt.exitCode !== 0 &&
        attempt.signal === null) ||
      (attempt.exitCode === null && typeof attempt.signal === "string")
    ) ||
    attempt.error !== null
  )) {
    semanticError(`${label} has inconsistent compiler-error fields.`);
  }
  if (attempt.status === "timeout" && (
    typeof attempt.elapsedMs !== "number" || attempt.error !== null
  )) {
    semanticError(`${label} has inconsistent timeout fields.`);
  }
  if (attempt.status === "runner-error" && (
    attempt.elapsedMs !== null ||
    attempt.exitCode !== null ||
    attempt.signal !== null ||
    typeof attempt.error !== "string"
  )) {
    semanticError(`${label} has inconsistent runner-error fields.`);
  }
}

function validateResourceUsageSemantics(attempt, capability, label) {
  const usage = attempt.resourceUsage;
  if (
    usage.collector !== capability.collector ||
    usage.scope !== capability.scope
  ) {
    semanticError(`${label} resource collector or scope is inconsistent.`);
  }
  const { cpuTime, peakRss } = attempt.resourceUsage;
  if (
    (cpuTime.status === "available" && capability.cpuTime.status !== "available") ||
    (peakRss.status === "available" && capability.peakRss.status !== "available")
  ) {
    semanticError(`${label} has a metric unavailable in run capability.`);
  }
  if (
    cpuTime.status === "available" &&
    cpuTime.totalMs !== cpuTime.userMs + cpuTime.systemMs
  ) {
    semanticError(`${label} CPU total does not equal user plus system time.`);
  }
  if (["timeout", "runner-error"].includes(attempt.status) && (
    cpuTime.status !== "unavailable" || peakRss.status !== "unavailable"
  )) {
    semanticError(`${label} cannot retain resource metrics after ${attempt.status}.`);
  }
}

function validateResourceMetricStatistics(
  attempts,
  metricName,
  statistics,
  valueSelector,
  label
) {
  const successful = attempts.filter((attempt) => attempt.status === "success");
  const available = successful.filter(
    (attempt) => attempt.resourceUsage[metricName].status === "available"
  );
  const samples = available.map((attempt) =>
    valueSelector(attempt.resourceUsage[metricName])
  );
  if (
    statistics.availableSamples !== samples.length ||
    statistics.unavailableSamples !== successful.length - samples.length ||
    !isDeepStrictEqual(statistics.samples, samples)
  ) {
    semanticError(`${label} resource coverage or samples are inconsistent.`);
  }
  const summary = [
    statistics.mean,
    statistics.median,
    statistics.min,
    statistics.max
  ];
  if (samples.length === 0 && summary.some((item) => item !== null)) {
    semanticError(`${label} unavailable resource statistics must be null.`);
  }
  if (samples.length > 0 && summary.some((item) => item === null)) {
    semanticError(`${label} available resource statistics must be numeric.`);
  }
  if (samples.length > 0) {
    const expected = {
      mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
      median: median(samples),
      min: Math.min(...samples),
      max: Math.max(...samples)
    };
    if (Object.entries(expected).some(
      ([name, value]) => statistics[name] !== value
    )) {
      semanticError(`${label} resource summaries are inconsistent.`);
    }
  }
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? null;
}

function validateScalingConfiguration(configuration, fixtureNames) {
  const groups = new Map();
  for (const variant of configuration.variants) {
    if (!variant.applicableFixtures) {
      semanticError(`Variant ${variant.name} requires applicableFixtures.`);
    }
    for (const fixture of variant.applicableFixtures) {
      if (!fixtureNames.includes(fixture)) {
        semanticError(`Variant ${variant.name} references unknown fixture ${fixture}.`);
      }
    }
    if (!variant.scaling) continue;
    if (variant.compiler !== "ts7") {
      semanticError(`Scaling variant ${variant.name} must use TS7.`);
    }
    const { axis, requestedWorkers, fixedCheckers } = variant.scaling;
    const expectedOption = axis === "checkers" ? "--checkers" : "--builders";
    if (optionValue(variant.extraArgs, expectedOption) !== String(requestedWorkers)) {
      semanticError(`Scaling variant ${variant.name} does not match its worker count.`);
    }
    if (axis === "checkers" && variant.extraArgs.includes("--builders")) {
      semanticError(`Checker scaling variant ${variant.name} cannot set builders.`);
    }
    if (axis === "builders" &&
      optionValue(variant.extraArgs, "--checkers") !== String(fixedCheckers)) {
      semanticError(`Builder scaling variant ${variant.name} must fix checkers.`);
    }
    for (const fixtureName of variant.applicableFixtures) {
      const fixture = configuration.fixtures.find(
        (candidate) => candidate.name === fixtureName
      );
      const isBuild = fixture.args.includes("--build");
      if (axis === "builders" && !isBuild) {
        semanticError(`Builder scaling fixture ${fixtureName} must use build mode.`);
      }
      if (axis === "checkers" && isBuild) {
        semanticError(`Checker scaling fixture ${fixtureName} must not use build mode.`);
      }
      const key = `${axis}\0${fixtureName}`;
      const points = groups.get(key) ?? [];
      points.push(requestedWorkers);
      groups.set(key, points);
    }
  }

  const expectedByAxis = {
    checkers: [1, 2, 4, 8],
    builders: [1, 2, 4]
  };
  for (const axis of Object.keys(expectedByAxis)) {
    const axisGroups = [...groups].filter(([key]) => key.startsWith(`${axis}\0`));
    if (axisGroups.length === 0) {
      semanticError(`Scaling configuration requires a ${axis} matrix.`);
    }
    for (const [key, points] of axisGroups) {
      const sorted = [...points].sort((a, b) => a - b);
      if (!isDeepStrictEqual(sorted, expectedByAxis[axis])) {
        semanticError(`Scaling group ${key.replace("\0", "/")} has an invalid matrix.`);
      }
    }
  }
}

function validateBenchmarkV2(value) {
  const { configuration } = value;
  const resourceEnabled = ["3.0.0", "3.1.0"].includes(value.schemaVersion);
  const scalingEnabled = value.schemaVersion === "3.1.0";
  if (resourceEnabled && !configuration.resourceMeasurement) {
    semanticError("Schema 3 benchmark requires resourceMeasurement configuration.");
  }
  if (!resourceEnabled && configuration.resourceMeasurement) {
    semanticError("Schema 2 benchmark cannot contain schema 3 resource fields.");
  }
  const fixtureNames = configuration.fixtures.map((fixture) => fixture.name);
  const variantNames = configuration.variants.map((variant) => variant.name);
  if (
    fixtureNames.length === 0 ||
    variantNames.length === 0 ||
    new Set(fixtureNames).size !== fixtureNames.length ||
    new Set(variantNames).size !== variantNames.length
  ) {
    semanticError("Fixture and variant names must be non-empty and unique.");
  }
  if (scalingEnabled) {
    validateScalingConfiguration(configuration, fixtureNames);
  } else if (configuration.variants.some(
    (variant) => variant.applicableFixtures || variant.scaling
  )) {
    semanticError("Schema versions before 3.1 cannot contain scaling fields.");
  }
  const expectedPairs = new Set(
    configuration.variants.flatMap((variant) =>
      (variant.applicableFixtures ?? fixtureNames).map(
        (fixture) => `${fixture}\0${variant.name}`
      )
    )
  );
  const planBySequence = new Map();
  for (const item of configuration.executionPlan) {
    if (planBySequence.has(item.sequence)) {
      semanticError(`Execution sequence ${item.sequence} is duplicated.`);
    }
    planBySequence.set(item.sequence, item);
  }
  const attemptsPerPair = 1 + configuration.warmups + configuration.runs;
  if (configuration.executionPlan.length !== expectedPairs.size * attemptsPerPair) {
    semanticError("Execution plan does not cover every fixture/variant pair.");
  }
  for (let sequence = 0; sequence < configuration.executionPlan.length; sequence += 1) {
    if (!planBySequence.has(sequence)) {
      semanticError("Execution plan sequences must be contiguous from zero.");
    }
  }

  const observedSequences = new Set();
  for (const result of value.results) {
    const label = `${result.fixture}/${result.variant}`;
    const pairKey = `${result.fixture}\0${result.variant}`;
    if (!expectedPairs.delete(pairKey)) {
      semanticError(`${label} is duplicated or absent from configuration.`);
    }
    if (result.warmupAttempts.length !== configuration.warmups) {
      semanticError(`${label} warmup count does not match configuration.`);
    }
    if (result.measurementAttempts.length !== configuration.runs) {
      semanticError(`${label} measurement count does not match configuration.`);
    }

    const attempts = [
      { attempt: result.coldRun, phase: "cold", name: "coldRun" },
      ...result.warmupAttempts.map((attempt, index) => ({
        attempt,
        phase: "warmup",
        name: `warmupAttempts[${index}]`
      })),
      ...result.measurementAttempts.map((attempt, index) => ({
        attempt,
        phase: "measured",
        name: `measurementAttempts[${index}]`
      }))
    ];

    for (const { attempt, phase, name } of attempts) {
      validateAttemptSemantics(attempt, phase, `${label} ${name}`);
      if (resourceEnabled && !attempt.resourceUsage) {
        semanticError(`${label} ${name} requires resourceUsage.`);
      }
      if (!resourceEnabled && attempt.resourceUsage) {
        semanticError(`${label} ${name} cannot contain schema 3 resource fields.`);
      }
      if (resourceEnabled) {
        validateResourceUsageSemantics(
          attempt,
          configuration.resourceMeasurement,
          `${label} ${name}`
        );
      }
      const planned = planBySequence.get(attempt.sequence);
      if (!planned ||
        planned.phase !== attempt.phase ||
        planned.round !== attempt.round ||
        planned.fixture !== result.fixture ||
        planned.variant !== result.variant) {
        semanticError(`${label} ${name} does not match executionPlan.`);
      }
      if (observedSequences.has(attempt.sequence)) {
        semanticError(`Attempt sequence ${attempt.sequence} is duplicated.`);
      }
      observedSequences.add(attempt.sequence);
    }

    const successful = result.measurementAttempts.filter(
      (attempt) => attempt.status === "success"
    );
    const samplesMs = successful.map((attempt) => attempt.elapsedMs);
    const statistics = result.statistics;
    if (
      statistics.plannedSamples !== configuration.runs ||
      statistics.successfulSamples !== successful.length ||
      statistics.failedSamples !== configuration.runs - successful.length ||
      !isDeepStrictEqual(statistics.samplesMs, samplesMs)
    ) {
      semanticError(`${label} statistics counts or samples are inconsistent.`);
    }
    const statisticValues = [
      statistics.meanMs,
      statistics.standardDeviationMs,
      statistics.medianMs,
      statistics.p95Ms,
      statistics.minMs,
      statistics.maxMs
    ];
    if (successful.length === 0 && statisticValues.some((item) => item !== null)) {
      semanticError(`${label} failed statistics must be null.`);
    }
    if (successful.length > 0 && statisticValues.some((item) => item === null)) {
      semanticError(`${label} successful statistics must be numeric.`);
    }

    const hasFailure = attempts.some(
      ({ attempt }) => attempt.status !== "success"
    );
    const expectedStatus = successful.length === 0
      ? "failed"
      : hasFailure
        ? "partial"
        : "complete";
    if (result.status !== expectedStatus) {
      semanticError(`${label} status must be ${expectedStatus}.`);
    }

    if (resourceEnabled && !statistics.resourceStatistics) {
      semanticError(`${label} requires resourceStatistics.`);
    }
    if (!resourceEnabled && statistics.resourceStatistics) {
      semanticError(`${label} cannot contain schema 3 resource statistics.`);
    }
    if (resourceEnabled) {
      validateResourceMetricStatistics(
        result.measurementAttempts,
        "cpuTime",
        statistics.resourceStatistics.cpuTimeMs,
        (metric) => metric.totalMs,
        `${label} CPU time`
      );
      validateResourceMetricStatistics(
        result.measurementAttempts,
        "peakRss",
        statistics.resourceStatistics.peakRssBytes,
        (metric) => metric.bytes,
        `${label} peak RSS`
      );
    }
  }

  if (
    expectedPairs.size !== 0 ||
    observedSequences.size !== configuration.executionPlan.length ||
    [...planBySequence.keys()].some((sequence) => !observedSequences.has(sequence))
  ) {
    semanticError("executionPlan and recorded attempts do not contain the same runs.");
  }
}

export function validateResultDocument(value) {
  if (validate(value)) {
    if (value.kind === "benchmark" && value.schemaVersion !== "1.0.0") {
      validateBenchmarkV2(value);
    }
    return value;
  }

  const details = formatErrors(validate.errors);
  throw new Error(`Result schema validation failed:\n${details}`);
}

export function validateStorageDocument(value) {
  if (validateStorage(value)) return value;

  const details = formatErrors(validateStorage.errors);
  throw new Error(`Run storage schema validation failed:\n${details}`);
}
