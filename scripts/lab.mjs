import { randomUUID } from "node:crypto";
import { compilers, run } from "./lib.mjs";

process.env.LAB_RUN_ID = randomUUID();

async function step(label, command, args) {
  console.log(`\n=== ${label} ===`);
  const result = await run(command, args, { env: process.env });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.exitCode !== 0) {
    process.exitCode = result.exitCode ?? 1;
    throw new Error(`${label} failed.`);
  }
}

await step("Generate fixtures", process.execPath, ["scripts/generate-fixtures.mjs"]);

for (const [name, compiler] of Object.entries(compilers)) {
  const version = await run(compiler, ["--version"]);
  if (version.exitCode !== 0) {
    throw new Error(`${name} compiler is unavailable. Run npm install first.`);
  }
  console.log(`${name}: ${version.stdout.trim()}`);
}

await step("Benchmark", process.execPath, ["scripts/benchmark.mjs"]);
await step("Compare diagnostics and emit", process.execPath, ["scripts/compare.mjs"]);
await step("Validate result schema", process.execPath, ["scripts/validate-results.mjs"]);
await step("Build report", process.execPath, ["scripts/report.mjs"]);

console.log("\nLab complete. Open reports/latest.md.");
