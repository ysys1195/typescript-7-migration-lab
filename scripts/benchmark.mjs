import path from "node:path";
import {
  compilers,
  createResultEnvelope,
  median,
  parseExtendedDiagnostics,
  percentile,
  root,
  run,
  writeResultJson
} from "./lib.mjs";

const runs = Number.parseInt(process.env.LAB_RUNS ?? "10", 10);
const warmups = Number.parseInt(process.env.LAB_WARMUPS ?? "2", 10);

if (!Number.isSafeInteger(runs) || runs < 1 || runs > 100) {
  throw new Error("LAB_RUNS must be an integer between 1 and 100.");
}
if (!Number.isSafeInteger(warmups) || warmups < 0 || warmups > 20) {
  throw new Error("LAB_WARMUPS must be an integer between 0 and 20.");
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

const output = {
  ...await createResultEnvelope("benchmark", {
    runs,
    warmups,
    fixtures: fixtures.map(({ name, args }) => ({ name, args })),
    variants: variants.map(({ name, extraArgs }) => ({
      name,
      compiler: name === "ts6" ? "ts6" : "ts7",
      extraArgs
    }))
  }),
  results: []
};

for (const fixture of fixtures) {
  console.log(`\n[${fixture.name}]`);
  for (const variant of variants) {
    const args = [...fixture.args, ...variant.extraArgs, "--pretty", "false"];
    for (let index = 0; index < warmups; index += 1) {
      await run(variant.compiler, args);
    }

    const samples = [];
    let lastDiagnostics = {};
    for (let index = 0; index < runs; index += 1) {
      const result = await run(variant.compiler, args);
      if (result.exitCode !== 0) {
        throw new Error(
          `${variant.name} failed for ${fixture.name}:\n${result.stdout}${result.stderr}`
        );
      }
      samples.push(result.elapsedMs);
      lastDiagnostics = parseExtendedDiagnostics(result.stdout + result.stderr);
    }

    const summary = {
      fixture: fixture.name,
      variant: variant.name,
      medianMs: median(samples),
      p95Ms: percentile(samples, 0.95),
      minMs: Math.min(...samples),
      maxMs: Math.max(...samples),
      samplesMs: samples,
      compilerDiagnostics: lastDiagnostics
    };
    output.results.push(summary);
    console.log(
      `  ${variant.name.padEnd(12)} median ${summary.medianMs.toFixed(1)} ms`
    );
  }
}

await writeResultJson("benchmark.json", output);
console.log(`\nWrote ${path.relative(root, path.join(root, "results", "benchmark.json"))}.`);
