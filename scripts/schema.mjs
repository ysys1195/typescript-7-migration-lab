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

function validateBenchmarkV2(value) {
  const { configuration } = value;
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
  const expectedPairs = new Set(
    fixtureNames.flatMap((fixture) =>
      variantNames.map((variant) => `${fixture}\0${variant}`)
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
    if (value.kind === "benchmark" && value.schemaVersion === "2.0.0") {
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
