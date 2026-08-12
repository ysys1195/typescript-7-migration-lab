import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import {
  buildExecutionPlan,
  executeBenchmarkPlan,
  ORDER_STRATEGY
} from "./benchmark-core.mjs";
import {
  compilers,
  createResultEnvelope,
  parseExtendedDiagnostics,
  root,
  run,
  writeResultJson
} from "./lib.mjs";
import {
  createResourceMeasurer,
  unavailableResourceUsage
} from "./resource-measurement.mjs";
import {
  assertFixtureGenerationMatches,
  FIXTURE_GENERATION_MANIFEST,
  readFixturePreset
} from "./fixture-presets.mjs";
import { createFixtureExecutor } from "./fixture-execution.mjs";

const runs = Number.parseInt(process.env.LAB_RUNS ?? "10", 10);
const warmups = Number.parseInt(process.env.LAB_WARMUPS ?? "2", 10);
const timeoutMs = Number.parseInt(
  process.env.LAB_FIXTURE_TIMEOUT_MS ?? "120000",
  10
);

if (!Number.isSafeInteger(runs) || runs < 1 || runs > 100) {
  throw new Error("LAB_RUNS must be an integer between 1 and 100.");
}
if (!Number.isSafeInteger(warmups) || warmups < 0 || warmups > 20) {
  throw new Error("LAB_WARMUPS must be an integer between 0 and 20.");
}
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600_000) {
  throw new Error(
    "LAB_FIXTURE_TIMEOUT_MS must be an integer between 100 and 600000."
  );
}

const standardFixtureNames = [
  "small",
  "type-heavy",
  "many-files",
  "jsx",
  "jsdoc",
  "monorepo",
  "startup-only",
  "parse-heavy",
  "type-heavy-scaled",
  "emit-heavy",
  "declaration-heavy",
  "module-resolution",
  "incremental-initial",
  "incremental-no-change",
  "incremental-edit",
  "watch-edit",
  "project-references-dag"
];
const fixtures = [
  { name: "small", args: ["-p", "fixtures/small", "--extendedDiagnostics"] },
  { name: "type-heavy", args: ["-p", "fixtures/type-heavy", "--extendedDiagnostics"] },
  { name: "many-files", args: ["-p", "fixtures/many-files", "--extendedDiagnostics"] },
  { name: "jsx", args: ["-p", "fixtures/jsx", "--extendedDiagnostics"] },
  { name: "jsdoc", args: ["-p", "fixtures/jsdoc", "--extendedDiagnostics"] },
  {
    name: "monorepo",
    args: ["--build", "fixtures/monorepo", "--force", "--extendedDiagnostics"]
  },
  { name: "startup-only", args: ["--version"] },
  {
    name: "parse-heavy",
    args: ["-p", "fixtures/parse-heavy", "--extendedDiagnostics"]
  },
  {
    name: "type-heavy-scaled",
    args: ["-p", "fixtures/type-heavy-scaled", "--extendedDiagnostics"]
  },
  {
    name: "emit-heavy",
    args: ["-p", "fixtures/emit-heavy", "--extendedDiagnostics"],
    resetPaths: ["fixtures/emit-heavy/dist"]
  },
  {
    name: "declaration-heavy",
    args: ["-p", "fixtures/declaration-heavy", "--extendedDiagnostics"],
    resetPaths: ["fixtures/declaration-heavy/dist"]
  },
  {
    name: "module-resolution",
    args: ["-p", "fixtures/module-resolution", "--extendedDiagnostics"]
  },
  {
    name: "incremental-initial",
    args: ["--extendedDiagnostics"],
    measurement: "incremental",
    state: "initial"
  },
  {
    name: "incremental-no-change",
    args: ["--extendedDiagnostics"],
    measurement: "incremental",
    state: "no-change"
  },
  {
    name: "incremental-edit",
    args: ["--extendedDiagnostics"],
    measurement: "incremental",
    state: "edit"
  },
  {
    name: "watch-edit",
    args: [],
    measurement: "watch"
  },
  {
    name: "project-references-dag",
    args: [
      "--build",
      "fixtures/project-references-dag/generated",
      "--force",
      "--extendedDiagnostics"
    ]
  },
  {
    name: "builder-scaling",
    args: [
      "--build",
      "fixtures/builder-scaling",
      "--force",
      "--extendedDiagnostics"
    ]
  }
];

const variants = [
  {
    name: "ts6",
    compiler: compilers.ts6,
    extraArgs: [],
    applicableFixtures: standardFixtureNames
  },
  {
    name: "ts7-single",
    compiler: compilers.ts7,
    extraArgs: ["--singleThreaded"],
    applicableFixtures: standardFixtureNames
  },
  {
    name: "ts7-default",
    compiler: compilers.ts7,
    extraArgs: [],
    applicableFixtures: standardFixtureNames
  },
  ...[1, 2, 4, 8].map((requestedWorkers) => ({
    name: `ts7-checkers-${requestedWorkers}`,
    compiler: compilers.ts7,
    extraArgs: ["--checkers", String(requestedWorkers)],
    applicableFixtures: ["many-files"],
    scaling: {
      axis: "checkers",
      requestedWorkers,
      baselineWorkers: 1
    }
  })),
  ...[1, 2, 4].map((requestedWorkers) => ({
    name: `ts7-builders-${requestedWorkers}`,
    compiler: compilers.ts7,
    extraArgs: [
      "--builders",
      String(requestedWorkers),
      "--checkers",
      "1"
    ],
    applicableFixtures: ["builder-scaling"],
    scaling: {
      axis: "builders",
      requestedWorkers,
      baselineWorkers: 1,
      fixedCheckers: 1
    }
  }))
];

const generatedFiles = await readdir(
  path.join(root, "fixtures", "many-files", "src")
);
const generatedFileCount = generatedFiles.filter((filename) =>
  filename.endsWith(".ts")
).length;
const fixturePreset = readFixturePreset();
if (generatedFileCount < 2) {
  throw new Error("Generate the many-files fixture before running the benchmark.");
}
let fixtureGenerationManifest;
try {
  fixtureGenerationManifest = JSON.parse(await readFile(
    path.join(root, FIXTURE_GENERATION_MANIFEST),
    "utf8"
  ));
} catch (error) {
  throw new Error(
    "Fixture generation metadata is missing or invalid. " +
    "Run npm run fixtures:generate before running the benchmark.",
    { cause: error }
  );
}
assertFixtureGenerationMatches(fixtureGenerationManifest, fixturePreset);

const executionPlan = buildExecutionPlan({ fixtures, variants, warmups, runs });
const replayEnvironment = {
  LAB_RUNS: String(runs),
  LAB_WARMUPS: String(warmups),
  LAB_FIXTURE_TIMEOUT_MS: String(timeoutMs),
  LAB_FILE_COUNT: String(generatedFileCount),
  LAB_FIXTURE_PRESET: fixturePreset.name
};

console.log(`Execution order: ${ORDER_STRATEGY}`);
console.log(`Per-invocation timeout: ${timeoutMs} ms`);
const resourceMeasurer = await createResourceMeasurer();
console.log(
  `Resource collector: ${resourceMeasurer.capability.collector} ` +
  `(CPU ${resourceMeasurer.capability.cpuTime.status}, ` +
  `RSS ${resourceMeasurer.capability.peakRss.status})`
);

let output;
try {
  output = {
    ...await createResultEnvelope("benchmark", {
      runs,
      warmups,
      coldRuns: 1,
      timeoutMs,
      orderStrategy: ORDER_STRATEGY,
      resourceMeasurement: resourceMeasurer.capability,
      fixturePreset: {
        name: fixturePreset.name,
        values: fixturePreset.values
      },
      fixtures: fixtures.map(({
        name,
        args,
        measurement,
        state,
        resetPaths
      }) => ({
        name,
        args,
        ...(measurement ? { measurement } : {}),
        ...(state ? { state } : {}),
        ...(resetPaths ? { resetPaths } : {})
      })),
      variants: variants.map(({
        name,
        extraArgs,
        applicableFixtures,
        scaling
      }) => ({
        name,
        compiler: name === "ts6" ? "ts6" : "ts7",
        extraArgs,
        applicableFixtures,
        ...(scaling ? { scaling } : {})
      })),
      executionPlan,
      replay: {
        command: "npm run lab",
        environment: replayEnvironment
      }
    }),
    results: []
  };
  output.results = await executeBenchmarkPlan({
    executionPlan,
    fixtures,
    variants,
    runs,
    timeoutMs,
    execute: createFixtureExecutor(resourceMeasurer),
    parseDiagnostics: parseExtendedDiagnostics,
    runnerErrorResourceUsage: unavailableResourceUsage(
      "runner-error",
      resourceMeasurer.capability.collector
    )
  });
} finally {
  await resourceMeasurer.dispose();
}

for (const fixture of fixtures) {
  console.log(`\n[${fixture.name}]`);
  for (const result of output.results.filter(
    (candidate) => candidate.fixture === fixture.name
  )) {
    const medianText = result.statistics.medianMs === null
      ? "no successful samples"
      : `median ${result.statistics.medianMs.toFixed(1)} ms`;
    console.log(
      `  ${result.variant.padEnd(12)} ${medianText} (${result.status}, ` +
      `${result.statistics.successfulSamples}/${runs})`
    );
  }
}

const stored = await writeResultJson("benchmark.json", output);
console.log(`\nWrote ${path.relative(root, stored.path)}.`);
