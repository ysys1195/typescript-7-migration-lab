import { isDeepStrictEqual } from "node:util";

export const FIXTURE_GENERATION_MANIFEST = "fixtures/.generated-preset.json";

export const FIXTURE_PRESETS = Object.freeze({
  small: Object.freeze({
    manyFiles: 100,
    parseFiles: 12,
    parseStatementsPerFile: 120,
    typeFiles: 8,
    typeInstantiationsPerFile: 30,
    emitFiles: 20,
    declarationFiles: 16,
    modulePackages: 20,
    incrementalFiles: 40,
    watchFiles: 20,
    dagLayers: 3,
    dagWidth: 2
  }),
  medium: Object.freeze({
    manyFiles: 400,
    parseFiles: 48,
    parseStatementsPerFile: 240,
    typeFiles: 24,
    typeInstantiationsPerFile: 80,
    emitFiles: 80,
    declarationFiles: 64,
    modulePackages: 80,
    incrementalFiles: 160,
    watchFiles: 80,
    dagLayers: 4,
    dagWidth: 3
  }),
  large: Object.freeze({
    manyFiles: 1_600,
    parseFiles: 160,
    parseStatementsPerFile: 480,
    typeFiles: 80,
    typeInstantiationsPerFile: 180,
    emitFiles: 320,
    declarationFiles: 240,
    modulePackages: 320,
    incrementalFiles: 640,
    watchFiles: 320,
    dagLayers: 6,
    dagWidth: 4
  })
});

export function readFixturePreset(environment = process.env) {
  const name = environment.LAB_FIXTURE_PRESET ?? "medium";
  const preset = FIXTURE_PRESETS[name];
  if (!preset) {
    throw new Error(
      `LAB_FIXTURE_PRESET must be one of: ${Object.keys(FIXTURE_PRESETS).join(", ")}.`
    );
  }
  const manyFilesOverride = environment.LAB_FILE_COUNT;
  if (manyFilesOverride === undefined) return { name, values: preset };
  const manyFiles = /^\d+$/.test(manyFilesOverride)
    ? Number.parseInt(manyFilesOverride, 10)
    : Number.NaN;
  if (!Number.isSafeInteger(manyFiles) || manyFiles < 2 || manyFiles > 10_000) {
    throw new Error("LAB_FILE_COUNT must be an integer between 2 and 10000.");
  }
  return { name, values: Object.freeze({ ...preset, manyFiles }) };
}

export function createFixtureGenerationManifest(preset) {
  return {
    generationVersion: "1.0.0",
    preset: preset.name,
    values: preset.values
  };
}

export function assertFixtureGenerationMatches(actual, preset) {
  const expected = createFixtureGenerationManifest(preset);
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(
      "Generated fixture scale does not match the requested preset. " +
      "Run npm run fixtures:generate with the same environment first."
    );
  }
  return actual;
}
