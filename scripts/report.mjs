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

function statisticsFor(result) {
  if (result.statistics) return result.statistics;
  return {
    plannedSamples: result.samplesMs.length,
    successfulSamples: result.samplesMs.length,
    failedSamples: 0,
    meanMs: result.samplesMs.reduce((sum, value) => sum + value, 0) /
      result.samplesMs.length,
    standardDeviationMs: null,
    medianMs: result.medianMs,
    outliers: []
  };
}

function formatMean(result) {
  if (!result) return "—";
  const statistics = statisticsFor(result);
  if (statistics.meanMs === null) return "failed";
  const deviation = statistics.standardDeviationMs === null
    ? ""
    : ` ± ${statistics.standardDeviationMs.toFixed(1)}`;
  return `${statistics.meanMs.toFixed(1)}${deviation}`;
}

const byFixture = new Map();
for (const result of benchmark.results) {
  const fixture = byFixture.get(result.fixture) ?? {};
  fixture[result.variant] = result;
  byFixture.set(result.fixture, fixture);
}

const rows = [];
for (const [fixture, variants] of byFixture) {
  const ts6 = variants.ts6 ? statisticsFor(variants.ts6).medianMs : null;
  const single = variants["ts7-single"]
    ? statisticsFor(variants["ts7-single"]).medianMs
    : null;
  const native = variants["ts7-default"]
    ? statisticsFor(variants["ts7-default"]).medianMs
    : null;
  const completion = benchmark.schemaVersion === "1.0.0"
    ? `${benchmark.configuration.runs}/${benchmark.configuration.runs}`
    : Object.values(variants).map((result) => {
      const statistics = statisticsFor(result);
      return `${result.variant}:${statistics.successfulSamples}/${statistics.plannedSamples}`;
    }).join(", ");
  const outlierCount = Object.values(variants).reduce(
    (total, result) => total + statisticsFor(result).outliers.length,
    0
  );
  rows.push([
    fixture,
    formatMean(variants.ts6),
    formatMean(variants["ts7-single"]),
    formatMean(variants["ts7-default"]),
    ts6 !== null && native !== null && native > 0
      ? `${(ts6 / native).toFixed(2)}x`
      : "—",
    single !== null && native !== null && native > 0
      ? `${(single / native).toFixed(2)}x`
      : "—",
    completion,
    String(outlierCount)
  ]);
}

const benchmarkFailures = benchmark.results.flatMap((result) => {
  if (!result.measurementAttempts) return [];
  return [result.coldRun, ...result.warmupAttempts, ...result.measurementAttempts]
    .filter((attempt) => attempt.status !== "success")
    .map((attempt) =>
      `- \`${result.fixture}/${result.variant}\` ${attempt.phase} #${attempt.round}: ` +
      `${attempt.status} (exit ${attempt.exitCode ?? "—"}, signal ${attempt.signal ?? "—"})`
    );
});

const coldRows = benchmark.results
  .filter((result) => result.coldRun)
  .map((result) =>
    `| ${result.fixture} | ${result.variant} | ${result.coldRun.status} | ` +
    `${result.coldRun.elapsedMs?.toFixed(1) ?? "—"} |`
  );

const outlierDetails = benchmark.results.flatMap((result) =>
  (result.statistics?.outliers ?? []).map((outlier) =>
    `- \`${result.fixture}/${result.variant}\` measured #${outlier.round}: ` +
    `${outlier.elapsedMs.toFixed(1)} ms ` +
    `(fence ${outlier.lowerFence.toFixed(1)}–${outlier.upperFence.toFixed(1)} ms)`
  )
);

function formatResourceMetric(metric, unit) {
  if (!metric || metric.median === null) return "unavailable";
  const value = unit === "MiB"
    ? metric.median / (1024 ** 2)
    : metric.median;
  return `${value.toFixed(1)} ${unit}`;
}

const resourceRows = benchmark.results
  .filter((result) => result.statistics?.resourceStatistics)
  .map((result) => {
    const { cpuTimeMs, peakRssBytes } = result.statistics.resourceStatistics;
    return `| ${result.fixture} | ${result.variant} | ` +
      `${formatResourceMetric(cpuTimeMs, "ms")} | ` +
      `${formatResourceMetric(peakRssBytes, "MiB")} | ` +
      `${cpuTimeMs.availableSamples}/${cpuTimeMs.availableSamples + cpuTimeMs.unavailableSamples} | ` +
      `${peakRssBytes.availableSamples}/${peakRssBytes.availableSamples + peakRssBytes.unavailableSamples} |`;
  });

const resourceReasons = [...new Set(benchmark.results.flatMap((result) => {
  if (!result.measurementAttempts) return [];
  return result.measurementAttempts.flatMap((attempt) => [
    attempt.resourceUsage?.cpuTime,
    attempt.resourceUsage?.peakRss
  ]).filter((metric) => metric?.status === "unavailable")
    .map((metric) => metric.reason);
}))];

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
- Runs: ${benchmark.configuration.runs} measured, ${benchmark.configuration.warmups} warm-up, ${benchmark.configuration.coldRuns ?? 0} cold
${benchmark.configuration.timeoutMs
  ? `- Timeout: ${benchmark.configuration.timeoutMs} ms per compiler invocation\n- Order: ${benchmark.configuration.orderStrategy}`
  : ""}

## Performance

Durations are wall-clock mean ± population standard deviation. Speedups use medians.
Outliers are Tukey 1.5×IQR candidates and remain included in every statistic.
“Parallel gain” compares TS7 single-threaded with TS7's default worker configuration.

| Fixture | TS6 mean ± SD (ms) | TS7 single | TS7 default | TS7 speedup | Parallel gain | Successful | Outliers |
|---|---:|---:|---:|---:|---:|---|---:|
${rows.map((row) => `| ${row.join(" | ")} |`).join("\n")}

### Cold invocations

${coldRows.length
  ? `| Fixture | Variant | Status | Duration (ms) |\n|---|---|---|---:|\n${coldRows.join("\n")}`
  : "Cold invocation data is unavailable for this schema version."}

### Outlier candidates

${outlierDetails.length ? outlierDetails.join("\n") : "No outlier candidates were detected."}

### Benchmark failures

${benchmarkFailures.length ? benchmarkFailures.join("\n") : "No benchmark attempts failed."}

## CPU time and peak RSS

${benchmark.configuration.resourceMeasurement
  ? `Collector: \`${benchmark.configuration.resourceMeasurement.collector}\`. ` +
    `Scope: \`${benchmark.configuration.resourceMeasurement.scope}\`.`
  : "Resource measurement is unavailable for this schema version."}

${resourceRows.length
  ? `| Fixture | Variant | Median CPU | Median peak RSS | CPU coverage | RSS coverage |\n|---|---|---:|---:|---:|---:|\n${resourceRows.join("\n")}`
  : "CPU time and peak RSS statistics are unavailable."}

${resourceReasons.length
  ? `Unavailable reasons: ${resourceReasons.map((reason) => `\`${reason}\``).join(", ")}.`
  : resourceRows.length
    ? "All successful measured attempts include both resource metrics."
    : "Resource coverage is unavailable for this schema version."}

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
- “Cold” is the first invocation for a fixture/variant in this lab run; it does not
  clear operating-system filesystem caches.
- CPU time is user plus system CPU time and may exceed wall-clock time when work
  runs in parallel. Peak RSS is normalized to bytes but its OS-specific scope may differ.
- A DIFFERENT result is a prompt to inspect \`${comparisonPath}\`; it is not
  automatically a regression.
`;

await ensureOutputDirs();
await writeFile(path.join(reportsDir, "latest.md"), markdown);
console.log("Wrote reports/latest.md.");
