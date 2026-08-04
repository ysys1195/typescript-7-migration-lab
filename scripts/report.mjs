import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ensureOutputDirs,
  reportsDir
} from "./lib.mjs";
import { resultStore } from "./result-store.mjs";

function readRunId(args) {
  const index = args.indexOf("--run-id");
  if (index === -1) return process.env.LAB_RUN_ID ?? null;
  if (!args[index + 1]) throw new Error("--run-id requires a value.");
  return args[index + 1];
}

const requestedRunId = readRunId(process.argv.slice(2));
const run = requestedRunId
  ? await resultStore.readRun(requestedRunId, { requireComplete: true })
  : await resultStore.readLatestRun();
const { benchmark, comparison } = run;
const comparisonPath = `results/runs/${comparison.runId}/comparison.json`;

const byFixture = new Map();
for (const result of benchmark.results) {
  const fixture = byFixture.get(result.fixture) ?? {};
  fixture[result.variant] = result;
  byFixture.set(result.fixture, fixture);
}

const rows = [];
for (const [fixture, variants] of byFixture) {
  const ts6 = variants.ts6?.medianMs;
  const single = variants["ts7-single"]?.medianMs;
  const native = variants["ts7-default"]?.medianMs;
  rows.push([
    fixture,
    ts6?.toFixed(1) ?? "—",
    single?.toFixed(1) ?? "—",
    native?.toFixed(1) ?? "—",
    ts6 && native ? `${(ts6 / native).toFixed(2)}x` : "—",
    single && native ? `${(single / native).toFixed(2)}x` : "—"
  ]);
}

const diagnosticRows = comparison.diagnostics.map((item) =>
  `| ${item.fixture} | ${item.status} | ${item.ts6.exitCode} | ${item.ts7.exitCode} |`
);

const diagnosticNotes = comparison.diagnostics
  .filter((item) => item.status !== "IDENTICAL")
  .map((item) => {
    if (item.status === "SAME_DIAGNOSTICS_EXIT_DIFFERENT") {
      return `- \`${item.fixture}\`: diagnostics are identical; only the process exit code differs.`;
    }
    if (item.status === "EXPECTED_DIFFERENCE") {
      return `- \`${item.fixture}\`: expected difference; TS6 reports deprecations while TS7 reports removals.`;
    }
    return `- \`${item.fixture}\`: inspect \`${comparisonPath}\` for the exact difference.`;
  });

const markdown = `# TypeScript 6 vs 7 Lab Report

Generated: ${benchmark.generatedAt}
Schema: ${benchmark.schemaVersion}
Benchmark run: ${benchmark.runId}
Comparison run: ${comparison.runId}

## Environment

- Platform: ${benchmark.metadata.runtime.platform} ${benchmark.metadata.runtime.arch}
- Node: ${benchmark.metadata.runtime.nodeVersion}
- TypeScript 6: ${benchmark.metadata.compilers.ts6.version}
- TypeScript 7: ${benchmark.metadata.compilers.ts7.version}
- CPU: ${benchmark.metadata.hardware.cpuModel}
- Logical CPUs: ${benchmark.metadata.hardware.logicalCpuCount}
- Memory: ${benchmark.metadata.hardware.totalMemoryBytes} bytes
- Git: ${benchmark.metadata.git.commitSha ?? "unavailable"} (${benchmark.metadata.git.branch ?? "detached"}, ${benchmark.metadata.git.dirty ? "dirty" : "clean"})
- Runs: ${benchmark.configuration.runs} measured, ${benchmark.configuration.warmups} warm-up

## Performance

All durations are wall-clock medians. “Parallel gain” compares TS7 single-threaded
with TS7's default worker configuration.

| Fixture | TS6 (ms) | TS7 single (ms) | TS7 default (ms) | TS7 speedup | Parallel gain |
|---|---:|---:|---:|---:|---:|
${rows.map((row) => `| ${row.join(" | ")} |`).join("\n")}

## Diagnostics

| Fixture | Result | TS6 exit | TS7 exit |
|---|---|---:|---:|
${diagnosticRows.join("\n")}

${diagnosticNotes.join("\n")}

## Emit

Result: **${comparison.emit.status}**

${comparison.emit.files.map((file) =>
  `- \`${file.filename}\`: ${file.identical ? "identical" : "different"}`
).join("\n")}

${comparison.emit.ts6Output.length || comparison.emit.ts7Output.length
  ? `Compiler output is recorded in \`${comparisonPath}\`.`
  : ""}

## Reading the results

- TS6 vs TS7 single-threaded approximates the benefit of the native implementation.
- TS7 single-threaded vs default approximates the additional benefit of parallelism.
- Small fixtures are dominated by process startup; larger fixtures are more representative.
- A DIFFERENT result is a prompt to inspect \`${comparisonPath}\`; it is not
  automatically a regression.
`;

await ensureOutputDirs();
await writeFile(path.join(reportsDir, "latest.md"), markdown);
console.log("Wrote reports/latest.md.");
