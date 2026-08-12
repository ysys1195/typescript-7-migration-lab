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
  const resourceEnabled = [
    "3.0.0",
    "3.1.0",
    "4.0.0",
    "4.1.0",
    "4.2.0"
  ].includes(
    value.schemaVersion
  );
  const scalingEnabled = ["3.1.0", "4.0.0", "4.1.0", "4.2.0"].includes(
    value.schemaVersion
  );
  if (resourceEnabled && !configuration.resourceMeasurement) {
    semanticError("Schema 3 benchmark requires resourceMeasurement configuration.");
  }
  if (!resourceEnabled && configuration.resourceMeasurement) {
    semanticError("Schema 2 benchmark cannot contain schema 3 resource fields.");
  }
  if (value.schemaVersion === "4.2.0") {
    if (!configuration.fixturePreset) {
      semanticError("Schema 4.2 benchmark requires fixturePreset configuration.");
    }
    if (configuration.replay.environment.LAB_FIXTURE_PRESET !==
      configuration.fixturePreset.name) {
      semanticError("Fixture preset and replay environment are inconsistent.");
    }
    const generatedManyFiles = Number.parseInt(
      configuration.replay.environment.LAB_FILE_COUNT,
      10
    );
    if (generatedManyFiles !== configuration.fixturePreset.values.manyFiles) {
      semanticError("many-files scale and fixture preset metadata are inconsistent.");
    }
  } else if (configuration.fixturePreset ||
    configuration.replay.environment.LAB_FIXTURE_PRESET) {
    semanticError("Schema versions before 4.2 cannot contain fixture presets.");
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
  for (const fixture of configuration.fixtures) {
    if (fixture.measurement === "incremental" && !fixture.state) {
      semanticError(`Incremental fixture ${fixture.name} requires a state.`);
    }
    if (fixture.measurement === "watch" && fixture.state) {
      semanticError(`Watch fixture ${fixture.name} cannot contain incremental state.`);
    }
    if (!fixture.measurement && fixture.state) {
      semanticError(`Standard fixture ${fixture.name} cannot contain state.`);
    }
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

function diagnosticMultisetDifference(left, right) {
  const keyFor = (diagnostic) => JSON.stringify([
    diagnostic.code,
    diagnostic.category,
    diagnostic.file,
    diagnostic.line,
    diagnostic.column,
    diagnostic.message
  ]);
  const counts = new Map();
  for (const diagnostic of right) {
    const key = keyFor(diagnostic);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return left.filter((diagnostic) => {
    const key = keyFor(diagnostic);
    const count = counts.get(key) ?? 0;
    if (count === 0) return true;
    counts.set(key, count - 1);
    return false;
  });
}

function validateComparisonV4(value) {
  const configured = value.configuration.diagnosticFixtures.map(
    (fixture) => fixture.name
  );
  const observed = value.diagnostics.map((result) => result.fixture);
  if (
    new Set(configured).size !== configured.length ||
    new Set(observed).size !== observed.length ||
    !isDeepStrictEqual([...configured].sort(), [...observed].sort())
  ) {
    semanticError("Comparison fixtures must be non-empty, unique, and complete.");
  }

  for (const result of value.diagnostics) {
    const label = `Diagnostic comparison ${result.fixture}`;
    const expectedOnlyTs6 = diagnosticMultisetDifference(
      result.ts6.diagnostics,
      result.ts7.diagnostics
    );
    const expectedOnlyTs7 = diagnosticMultisetDifference(
      result.ts7.diagnostics,
      result.ts6.diagnostics
    );
    if (
      !isDeepStrictEqual(result.difference.diagnostics.onlyTs6, expectedOnlyTs6) ||
      !isDeepStrictEqual(result.difference.diagnostics.onlyTs7, expectedOnlyTs7)
    ) {
      semanticError(`${label} has inconsistent structured differences.`);
    }
    const diagnosticsDiffer = expectedOnlyTs6.length > 0 || expectedOnlyTs7.length > 0;
    const exitCodesDiffer = result.ts6.exitCode !== result.ts7.exitCode;
    if (
      result.difference.diagnostics.status !==
        (diagnosticsDiffer ? "DIFFERENT" : "IDENTICAL") ||
      result.difference.exitCode.status !==
        (exitCodesDiffer ? "DIFFERENT" : "IDENTICAL") ||
      result.difference.exitCode.ts6 !== result.ts6.exitCode ||
      result.difference.exitCode.ts7 !== result.ts7.exitCode
    ) {
      semanticError(`${label} has inconsistent diagnostic or exit-code status.`);
    }

    const hasDifference = diagnosticsDiffer || exitCodesDiffer;
    if (result.classification === "SUPPORTED_IDENTICALLY" && (
      hasDifference || result.knownDifferences.length !== 0
    )) {
      semanticError(`${label} cannot be identical when a difference is present.`);
    }
    if (result.classification === "SUPPORTED_WITH_DIFFERENCE" && (
      !hasDifference || result.knownDifferences.length === 0
    )) {
      semanticError(`${label} requires a documented known difference.`);
    }
    if (result.classification === "POSSIBLE_REGRESSION" && (
      !hasDifference || result.knownDifferences.length !== 0
    )) {
      semanticError(`${label} must contain only unmatched differences.`);
    }
  }
}

function compilerOptionOutcomeSummary(outcome) {
  return {
    exitCode: outcome.exitCode,
    diagnosticCodes: outcome.diagnostics.map((diagnostic) => diagnostic.code)
      .sort((left, right) => left - right),
    emittedFiles: outcome.emittedFiles
  };
}

function validateCompilerOptionsV41(value) {
  if (!value.configuration.compilerOptionCatalog || !value.compilerOptions) {
    semanticError("Schema 4.1 comparison requires the compiler option catalog.");
  }
  const ids = value.compilerOptions.map((result) => result.id);
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    semanticError("Compiler option catalog result IDs must be non-empty and unique.");
  }
  for (const result of value.compilerOptions) {
    const ts6Matches = isDeepStrictEqual(
      compilerOptionOutcomeSummary(result.ts6),
      result.probe.expected.ts6
    );
    const ts7Matches = isDeepStrictEqual(
      compilerOptionOutcomeSummary(result.ts7),
      result.probe.expected.ts7
    );
    const expectedStatus = ts6Matches && ts7Matches
      ? "MATCHED_EXPECTATION"
      : "POSSIBLE_REGRESSION";
    if (result.status !== expectedStatus) {
      semanticError(`Compiler option ${result.id} status must be ${expectedStatus}.`);
    }
    const expectedClassifications = result.transition ===
      "TS6_DEPRECATION_TO_TS7_REMOVAL"
      ? ["DEPRECATED_IN_TS6", "REMOVED_IN_TS7"]
      : ["DEFAULT_CHANGED"];
    if (!isDeepStrictEqual(result.classifications, expectedClassifications)) {
      semanticError(`Compiler option ${result.id} classifications are inconsistent.`);
    }
  }
}

export function validateResultDocument(value) {
  if (validate(value)) {
    if (value.kind === "benchmark" && value.schemaVersion !== "1.0.0") {
      validateBenchmarkV2(value);
    }
    if (value.kind === "comparison" && ["4.0.0", "4.1.0", "4.2.0"].includes(
      value.schemaVersion
    )) {
      validateComparisonV4(value);
    }
    if (value.kind === "comparison" && value.schemaVersion === "4.0.0" && (
      value.compilerOptions || value.configuration.compilerOptionCatalog
    )) {
      semanticError("Schema 4.0 comparison cannot contain compiler option results.");
    }
    if (value.kind === "comparison" && ["4.1.0", "4.2.0"].includes(
      value.schemaVersion
    )) {
      validateCompilerOptionsV41(value);
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
