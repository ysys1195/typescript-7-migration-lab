import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDiagnosticDifference,
  createDiagnosticDifference,
  parseDiagnostics,
  readKnownDifferenceManifest
} from "../scripts/diagnostics.mjs";

const located = {
  code: 2322,
  category: "error",
  file: "fixtures/example/src/index.ts",
  line: 7,
  column: 3,
  message: "Type 'number' is not assignable to type 'string'."
};

test("parseDiagnostics extracts locations, codes, and multiline messages", () => {
  const output = [
    "/repo/fixtures/example/src/index.ts(7,3): error TS2322: " +
      "Type 'number' is not assignable to type 'string'.",
    "  Additional context.",
    "error TS18003: No inputs were found.",
    "Found 2 errors."
  ].join("\n");

  assert.deepEqual(parseDiagnostics(output, { rootDirectory: "/repo" }), [
    {
      code: 18003,
      category: "error",
      file: null,
      line: null,
      column: null,
      message: "No inputs were found."
    },
    { ...located, message: `${located.message}\nAdditional context.` }
  ]);
});

test("parseDiagnostics normalizes Windows separators without dropping evidence", () => {
  const output = "C:\\repo\\fixtures\\example\\src\\index.ts(7,3): error TS2322: " +
    located.message;
  assert.deepEqual(
    parseDiagnostics(output, { rootDirectory: "C:\\repo" }),
    [located]
  );
});

test("createDiagnosticDifference compares diagnostic multisets", () => {
  const extra = { ...located, code: 2339, message: "Missing property." };
  const difference = createDiagnosticDifference(
    { exitCode: 2, diagnostics: [located, located] },
    { exitCode: 1, diagnostics: [located, extra] }
  );
  assert.deepEqual(difference, {
    diagnostics: {
      status: "DIFFERENT",
      onlyTs6: [located],
      onlyTs7: [extra]
    },
    exitCode: { status: "DIFFERENT", ts6: 2, ts7: 1 }
  });
});

test("known differences are classified separately from possible regressions", () => {
  const difference = createDiagnosticDifference(
    { exitCode: 2, diagnostics: [located] },
    { exitCode: 1, diagnostics: [located] }
  );
  const expected = {
    exitCodes: { ts6: 2, ts7: 1 },
    onlyTs6: [],
    onlyTs7: []
  };
  const known = classifyDiagnosticDifference("example", difference, {
    version: 1,
    differences: [{
      id: "known-exit-code",
      fixture: "example",
      rationale: "Documented CLI behavior.",
      expected
    }]
  });
  assert.deepEqual(known, {
    classification: "SUPPORTED_WITH_DIFFERENCE",
    knownDifferences: [{
      id: "known-exit-code",
      rationale: "Documented CLI behavior."
    }]
  });

  assert.deepEqual(
    classifyDiagnosticDifference("other", difference, {
      version: 1,
      differences: []
    }),
    { classification: "POSSIBLE_REGRESSION", knownDifferences: [] }
  );
});

test("the checked-in known-difference manifest is valid", async () => {
  const manifest = await readKnownDifferenceManifest(new URL(
    "../compatibility/known-diagnostic-differences.json",
    import.meta.url
  ));
  assert.equal(manifest.version, 1);
  assert.deepEqual(
    manifest.differences.map((difference) => difference.id),
    ["compiler-error-exit-code", "legacy-options-removed-in-ts7"]
  );
});
