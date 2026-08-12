import assert from "node:assert/strict";
import test from "node:test";
import {
  assertFixtureGenerationMatches,
  createFixtureGenerationManifest,
  FIXTURE_PRESETS,
  readFixturePreset
} from "../scripts/fixture-presets.mjs";

test("fixture presets grow monotonically from small to large", () => {
  for (const key of Object.keys(FIXTURE_PRESETS.small)) {
    assert.ok(FIXTURE_PRESETS.small[key] < FIXTURE_PRESETS.medium[key], key);
    assert.ok(FIXTURE_PRESETS.medium[key] < FIXTURE_PRESETS.large[key], key);
  }
});

test("fixture preset defaults to medium and supports a many-files override", () => {
  assert.deepEqual(readFixturePreset({}), {
    name: "medium",
    values: FIXTURE_PRESETS.medium
  });
  assert.equal(readFixturePreset({
    LAB_FIXTURE_PRESET: "small",
    LAB_FILE_COUNT: "222"
  }).values.manyFiles, 222);
});

test("fixture preset rejects unknown names and non-integer overrides", () => {
  assert.throws(
    () => readFixturePreset({ LAB_FIXTURE_PRESET: "tiny" }),
    /must be one of/
  );
  for (const value of ["1", "10001", "20files", ""]) {
    assert.throws(
      () => readFixturePreset({ LAB_FILE_COUNT: value }),
      /integer between 2 and 10000/
    );
  }
});

test("generation manifest must exactly match the requested preset", () => {
  const preset = readFixturePreset({ LAB_FIXTURE_PRESET: "small" });
  const manifest = createFixtureGenerationManifest(preset);
  assert.equal(assertFixtureGenerationMatches(manifest, preset), manifest);

  const changed = structuredClone(manifest);
  changed.values.watchFiles += 1;
  assert.throws(
    () => assertFixtureGenerationMatches(changed, preset),
    /does not match/
  );
});
