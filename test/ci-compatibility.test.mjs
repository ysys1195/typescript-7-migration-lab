import assert from "node:assert/strict";
import test from "node:test";
import {
  diagnosticFixtures,
  normalizeGoldenText,
  readCiGolden,
  smokeFixtures
} from "../scripts/ci-compatibility.mjs";

test("CI golden covers smoke, diagnostics, and emit independently", async () => {
  const golden = await readCiGolden();
  assert.deepEqual(golden.smoke.map((entry) => entry.fixture), smokeFixtures);
  assert.deepEqual(
    golden.diagnostics.map((entry) => entry.fixture),
    diagnosticFixtures
  );
  assert.deepEqual(golden.emit.ts6.files.map((file) => file.filename), [
    "index.d.ts",
    "index.js"
  ]);
  assert.deepEqual(golden.emit.ts7.files.map((file) => file.filename), [
    "index.d.ts",
    "index.js"
  ]);
});

test("emit golden normalization removes platform line-ending differences", () => {
  assert.equal(normalizeGoldenText("first\r\nsecond\r\n"), "first\nsecond\n");
  assert.equal(normalizeGoldenText("first\nsecond\n"), "first\nsecond\n");
});
