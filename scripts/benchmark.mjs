import path from "node:path";
import { readdir } from "node:fs/promises";
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

const fixtures = [
  { name: "small", args: ["-p", "fixtures/small", "--extendedDiagnostics"] },
  { name: "type-heavy", args: ["-p", "fixtures/type-heavy", "--extendedDiagnostics"] },
  { name: "many-files", args: ["-p", "fixtures/many-files", "--extendedDiagnostics"] },
  { name: "jsx", args: ["-p", "fixtures/jsx", "--extendedDiagnostics"] },
  { name: "jsdoc", args: ["-p", "fixtures/jsdoc", "--extendedDiagnostics"] },
  {
    name: "monorepo",
    args: ["--build", "fixtures/monorepo", "--force", "--extendedDiagnostics"]
  }
];

const variants = [
  { name: "ts6", compiler: compilers.ts6, extraArgs: [] },
  { name: "ts7-single", compiler: compilers.ts7, extraArgs: ["--singleThreaded"] },
  { name: "ts7-default", compiler: compilers.ts7, extraArgs: [] }
];

const generatedFiles = await readdir(
  path.join(root, "fixtures", "many-files", "src")
);
const generatedFileCount = generatedFiles.filter((filename) =>
  filename.endsWith(".ts")
).length;
if (generatedFileCount < 2) {
  throw new Error("Generate the many-files fixture before running the benchmark.");
}

const executionPlan = buildExecutionPlan({ fixtures, variants, warmups, runs });
const replayEnvironment = {
  LAB_RUNS: String(runs),
  LAB_WARMUPS: String(warmups),
  LAB_FIXTURE_TIMEOUT_MS: String(timeoutMs),
  LAB_FILE_COUNT: String(generatedFileCount)
};

console.log(`Execution order: ${ORDER_STRATEGY}`);
console.log(`Per-invocation timeout: ${timeoutMs} ms`);

const output = {
  ...await createResultEnvelope("benchmark", {
    runs,
    warmups,
    coldRuns: 1,
    timeoutMs,
    orderStrategy: ORDER_STRATEGY,
    fixtures: fixtures.map(({ name, args }) => ({ name, args })),
    variants: variants.map(({ name, extraArgs }) => ({
      name,
      compiler: name === "ts6" ? "ts6" : "ts7",
      extraArgs
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
  execute: run,
  parseDiagnostics: parseExtendedDiagnostics
});

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
