import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyCompilerOptionOutcome,
  readCompilerOptionCatalog,
  runCompilerOptionCatalog
} from "../scripts/compiler-options.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("catalog covers removed options and adopted TS6 defaults", async () => {
  const catalog = await readCompilerOptionCatalog();
  const classifications = new Set(catalog.entries.flatMap(
    (entry) => entry.classifications
  ));
  assert.deepEqual(classifications, new Set([
    "DEPRECATED_IN_TS6",
    "REMOVED_IN_TS7",
    "DEFAULT_CHANGED"
  ]));
  for (const entry of catalog.entries) {
    await access(path.join(root, entry.fixture, "tsconfig.json"));
    assert.equal(entry.reproduction, `npm run options -- --id ${entry.id}`);
  }
});

test("catalog probes record diagnostics and default emit layout", async () => {
  const { results } = await runCompilerOptionCatalog({
    ids: ["target-es5", "root-dir-default"]
  });
  assert.deepEqual(
    results.map((result) => [result.id, result.status]),
    [
      ["target-es5", "MATCHED_EXPECTATION"],
      ["root-dir-default", "MATCHED_EXPECTATION"]
    ]
  );
  assert.deepEqual(results[0].ts6.diagnostics.map(({ code }) => code), [5107]);
  assert.deepEqual(results[0].ts7.diagnostics.map(({ code }) => code), [5108]);
  assert.deepEqual(results[1].ts6.emittedFiles, ["src/index.js"]);
  assert.deepEqual(results[1].ts7.emittedFiles, ["src/index.js"]);
});

test("unexpected compiler observations become possible regressions", () => {
  const expected = {
    ts6: { exitCode: 0, diagnosticCodes: [], emittedFiles: [] },
    ts7: { exitCode: 0, diagnosticCodes: [], emittedFiles: [] }
  };
  const outcome = {
    exitCode: 0,
    diagnostics: [],
    emittedFiles: []
  };
  assert.equal(
    classifyCompilerOptionOutcome(expected, outcome, outcome),
    "MATCHED_EXPECTATION"
  );
  assert.equal(
    classifyCompilerOptionOutcome(expected, outcome, {
      ...outcome,
      diagnostics: [{ code: 9999 }]
    }),
    "POSSIBLE_REGRESSION"
  );
});
