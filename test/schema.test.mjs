import assert from "node:assert/strict";
import test from "node:test";
import { validateResultDocument } from "../scripts/schema.mjs";
import {
  createBenchmarkResult,
  createComparisonResult
} from "./helpers/result-documents.mjs";

const benchmark = createBenchmarkResult();
const comparison = createComparisonResult();

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
