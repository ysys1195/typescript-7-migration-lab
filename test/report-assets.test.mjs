import assert from "node:assert/strict";
import test from "node:test";
import { createPerformanceSvg } from "../scripts/report-assets.mjs";

const fixtures = [
  "startup-only",
  "parse-heavy",
  "many-files",
  "type-heavy-scaled",
  "emit-heavy",
  "module-resolution",
  "incremental-edit",
  "project-references-dag"
];

function benchmark() {
  return {
    runId: "123e4567-e89b-42d3-a456-426614174000",
    metadata: {
      compilers: { ts6: { version: "6.0.3" }, ts7: { version: "7.0.2" } },
      hardware: { cpuModel: "Test CPU" }
    },
    configuration: {
      runs: 10,
      warmups: 2,
      fixturePreset: { name: "medium" }
    },
    results: fixtures.flatMap((fixture) => [
      { fixture, variant: "ts6", statistics: { medianMs: 300 } },
      { fixture, variant: "ts7-single", statistics: { medianMs: 150 } },
      { fixture, variant: "ts7-default", statistics: { medianMs: 100 } }
    ])
  };
}

test("report graph is generated from the representative result matrix", () => {
  const svg = createPerformanceSvg(benchmark());
  assert.match(svg, /TS6 to TS7 median wall-clock speedup/);
  assert.match(svg, /project-references-dag/);
  assert.match(svg, /2\.00x/);
  assert.match(svg, /3\.00x/);
  assert.match(svg, /123e4567-e89b-42d3-a456-426614174000/);
});

test("report graph rejects an incomplete result matrix", () => {
  const value = benchmark();
  value.results = value.results.filter((result) =>
    result.fixture !== "parse-heavy" || result.variant !== "ts7-default"
  );
  assert.throws(
    () => createPerformanceSvg(value),
    /complete representative fixture matrix/
  );
});
