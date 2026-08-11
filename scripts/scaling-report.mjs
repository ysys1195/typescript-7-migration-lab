function validPositive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function collectScalingRows(benchmark) {
  const variants = new Map(
    benchmark.configuration.variants.map((variant) => [variant.name, variant])
  );
  const candidates = benchmark.results.flatMap((result) => {
    const variant = variants.get(result.variant);
    if (!variant?.scaling) return [];
    const resources = result.statistics?.resourceStatistics;
    return [{
      axis: variant.scaling.axis,
      fixture: result.fixture,
      variant: result.variant,
      requestedWorkers: variant.scaling.requestedWorkers,
      baselineWorkers: variant.scaling.baselineWorkers,
      fixedCheckers: variant.scaling.fixedCheckers ?? null,
      logicalCpuCount: benchmark.metadata.hardware.logicalCpuCount,
      oversubscribed: variant.scaling.requestedWorkers >
        benchmark.metadata.hardware.logicalCpuCount,
      medianWallMs: result.statistics?.medianMs ?? null,
      medianCpuMs: resources?.cpuTimeMs.median ?? null,
      cpuCoverage: resources?.cpuTimeMs
        ? `${resources.cpuTimeMs.availableSamples}/` +
          `${resources.cpuTimeMs.availableSamples + resources.cpuTimeMs.unavailableSamples}`
        : "unavailable",
      medianRssBytes: resources?.peakRssBytes.median ?? null,
      rssCoverage: resources?.peakRssBytes
        ? `${resources.peakRssBytes.availableSamples}/` +
          `${resources.peakRssBytes.availableSamples + resources.peakRssBytes.unavailableSamples}`
        : "unavailable",
      successfulSamples: result.statistics?.successfulSamples ?? 0,
      plannedSamples: result.statistics?.plannedSamples ?? 0
    }];
  });

  const baselines = new Map(candidates
    .filter((row) => row.requestedWorkers === row.baselineWorkers)
    .map((row) => [`${row.axis}\0${row.fixture}`, row]));

  return candidates.map((row) => {
    const baseline = baselines.get(`${row.axis}\0${row.fixture}`);
    return {
      ...row,
      speedup: validPositive(baseline?.medianWallMs) && validPositive(row.medianWallMs)
        ? baseline.medianWallMs / row.medianWallMs
        : null,
      rssDeltaBytes: validPositive(baseline?.medianRssBytes) &&
        validPositive(row.medianRssBytes)
        ? row.medianRssBytes - baseline.medianRssBytes
        : null,
      rssRatio: validPositive(baseline?.medianRssBytes) &&
        validPositive(row.medianRssBytes)
        ? row.medianRssBytes / baseline.medianRssBytes
        : null
    };
  }).sort((left, right) =>
    left.axis.localeCompare(right.axis) ||
    left.fixture.localeCompare(right.fixture) ||
    left.requestedWorkers - right.requestedWorkers
  );
}

function number(value, suffix = "") {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value.toFixed(2)}${suffix}`
    : "—";
}

function memory(row) {
  if (row.medianRssBytes === null) return `unavailable (${row.rssCoverage})`;
  return `${(row.medianRssBytes / (1024 ** 2)).toFixed(1)} MiB ` +
    `(${row.rssCoverage})`;
}

function memoryTradeoff(row) {
  if (row.rssDeltaBytes === null || row.rssRatio === null) return "unavailable";
  const delta = row.rssDeltaBytes / (1024 ** 2);
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta.toFixed(1)} MiB / ${row.rssRatio.toFixed(2)}x`;
}

function axisSection(rows, axis) {
  const selected = rows.filter((row) => row.axis === axis);
  if (selected.length === 0) return `### ${axis}\n\nNo ${axis} scaling data.`;
  const table = selected.map((row) =>
    `| ${row.fixture} | ${row.requestedWorkers} | ` +
    `${(row.requestedWorkers / row.logicalCpuCount).toFixed(2)}x | ` +
    `${row.oversubscribed ? "yes" : "no"} | ` +
    `${number(row.medianWallMs, " ms")} | ${number(row.speedup, "x")} | ` +
    `${number(row.medianCpuMs, " ms")} (${row.cpuCoverage}) | ` +
    `${memory(row)} | ${memoryTradeoff(row)} | ` +
    `${row.successfulSamples}/${row.plannedSamples} |`
  ).join("\n");
  const oversubscription = selected.some((row) => row.oversubscribed)
    ? "Rows marked `yes` request more workers than the recorded logical CPU count."
    : "No configured point requests more workers than the recorded logical CPU count.";
  const fixed = axis === "builders"
    ? " Checker concurrency is fixed at 1 for every builder point."
    : "";
  return `### ${axis}\n\n` +
    `| Fixture | Workers | Workers / logical CPUs | Oversubscribed | ` +
    `Median wall | Speedup vs 1 | Median CPU (coverage) | ` +
    `Median peak RSS (coverage) | RSS vs 1 | Successful |\n` +
    `|---|---:|---:|---|---:|---:|---:|---:|---:|---:|\n${table}\n\n` +
    `${oversubscription}${fixed}`;
}

export function formatScalingReport(benchmark) {
  const rows = collectScalingRows(benchmark);
  if (rows.length === 0) {
    return "Scaling experiment data is unavailable for this schema version.";
  }
  return `${axisSection(rows, "checkers")}\n\n${axisSection(rows, "builders")}`;
}
