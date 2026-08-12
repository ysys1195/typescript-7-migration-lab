const state = {
  runs: [],
  latest: null,
  manifest: null,
  benchmark: null,
  comparison: null,
  historical: null,
  view: "overview"
};

const viewCopy = {
  overview: ["Latest evidence", "Overview"],
  performance: ["Compiler timings", "Performance"],
  compatibility: ["Migration surface", "Compatibility"],
  diagnostics: ["Structured comparison", "Diagnostics Diff"],
  emit: ["Generated output", "Emit Diff"],
  history: ["Evidence over time", "Run History"],
  environment: ["Reproducibility", "Environment"]
};
const standardVariants = new Set(["ts6", "ts7-single", "ts7-default"]);

function element(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function shortId(value) {
  return value ? `${value.slice(0, 8)}…${value.slice(-4)}` : "—";
}

function dateTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function formatMs(value) {
  return finite(value) ? `${value.toFixed(1)} ms` : "—";
}

function formatBytes(value) {
  return finite(value) ? `${(value / (1024 ** 2)).toFixed(1)} MiB` : "—";
}

function formatRatio(value) {
  return finite(value) && value > 0 ? `${value.toFixed(2)}×` : "—";
}

function formatPercent(value) {
  if (!finite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function median(values) {
  const sorted = values.filter(finite).slice().sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function statistics(result) {
  if (!result) return null;
  const samples = result.statistics?.samplesMs ?? result.samplesMs ?? [];
  return {
    status: result.status ?? "complete",
    medianMs: result.statistics?.medianMs ?? result.medianMs ?? null,
    meanMs: result.statistics?.meanMs ?? (
      samples.length
        ? samples.reduce((sum, value) => sum + value, 0) / samples.length
        : null
    ),
    p95Ms: result.statistics?.p95Ms ?? result.p95Ms ?? null,
    successfulSamples: result.statistics?.successfulSamples ?? samples.length,
    plannedSamples: result.statistics?.plannedSamples ?? samples.length,
    resources: result.statistics?.resourceStatistics ?? null
  };
}

function standardGroups() {
  const groups = new Map();
  for (const result of state.benchmark.results) {
    if (!standardVariants.has(result.variant)) {
      continue;
    }
    const group = groups.get(result.fixture) ?? {};
    group[result.variant] = result;
    groups.set(result.fixture, group);
  }
  return groups;
}

function ratio(left, right) {
  const leftValue = statistics(left)?.medianMs;
  const rightValue = statistics(right)?.medianMs;
  return finite(leftValue) && finite(rightValue) && rightValue > 0
    ? leftValue / rightValue
    : null;
}

function statusTone(status) {
  if ([
    "SUPPORTED_IDENTICALLY",
    "IDENTICAL",
    "MATCHED_EXPECTATION",
    "complete",
    "clean",
    "STABLE",
    "IMPROVEMENT",
    "UNCHANGED"
  ].includes(status)) return "good";
  if (["POSSIBLE_REGRESSION", "REGRESSION", "failed", "DIFFERENT", "dirty"].includes(status)) {
    return "bad";
  }
  if (["SUPPORTED_WITH_DIFFERENCE", "partial", "CAUTION", "CHANGED"].includes(status)) {
    return "warn";
  }
  return "info";
}

function badge(status) {
  return `<span class="badge ${statusTone(status)}">${escapeHtml(status)}</span>`;
}

function metricCard(label, value, note, alert = false) {
  return `<article class="metric-card${alert ? " alert" : ""}">
    <span class="label">${escapeHtml(label)}</span>
    <strong>${escapeHtml(value)}</strong>
    <small>${escapeHtml(note)}</small>
  </article>`;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `Request failed: ${response.status}`);
  return value;
}

function showError(error) {
  const banner = element("error-banner");
  banner.textContent = error instanceof Error ? error.message : String(error);
  banner.hidden = false;
}

function clearError() {
  element("error-banner").hidden = true;
}

function diagnosticStatus(item) {
  return item.classification ?? item.status ?? "UNKNOWN";
}

function diagnosticCounts(item) {
  if (item.difference?.diagnostics) {
    return {
      onlyTs6: item.difference.diagnostics.onlyTs6.length,
      onlyTs7: item.difference.diagnostics.onlyTs7.length,
      diagnostics: item.difference.diagnostics.status,
      exitCode: item.difference.exitCode.status
    };
  }
  const ts6 = item.ts6?.diagnostics ?? [];
  const ts7 = item.ts7?.diagnostics ?? [];
  return {
    onlyTs6: item.status === "IDENTICAL" ? 0 : ts6.length,
    onlyTs7: item.status === "IDENTICAL" ? 0 : ts7.length,
    diagnostics: item.status,
    exitCode: item.ts6?.exitCode === item.ts7?.exitCode ? "IDENTICAL" : "DIFFERENT"
  };
}

function renderOverview() {
  const groups = standardGroups();
  const nativeRatios = [];
  const defaultRatios = [];
  const parallelRatios = [];
  for (const variants of groups.values()) {
    nativeRatios.push(ratio(variants.ts6, variants["ts7-single"]));
    defaultRatios.push(ratio(variants.ts6, variants["ts7-default"]));
    parallelRatios.push(ratio(variants["ts7-single"], variants["ts7-default"]));
  }
  const nativeMedian = median(nativeRatios);
  const defaultMedian = median(defaultRatios);
  const parallelMedian = median(parallelRatios);
  const diagnostics = state.comparison.diagnostics ?? [];
  const options = state.comparison.compilerOptions ?? [];
  const possibleRegressions = diagnostics.filter(
    (item) => diagnosticStatus(item) === "POSSIBLE_REGRESSION"
  ).length + options.filter((item) => item.status === "POSSIBLE_REGRESSION").length;
  const failedResults = state.benchmark.results.filter(
    (result) => (result.status ?? "complete") !== "complete"
  ).length;
  const observedFixtures = [...groups.values()].filter(
    (variants) => variants.ts6 && variants["ts7-default"]
  ).length;

  element("overview-lead").textContent = finite(defaultMedian)
    ? `Across ${observedFixtures} standard fixtures, the median TS6-to-TS7 default speedup is ${formatRatio(defaultMedian)}. Read each fixture in context: startup, checking, emit, resolution, and editor loops expose different work.`
    : "This run does not contain enough standard variant pairs for an aggregate speedup.";
  element("overview-stamp").innerHTML = `
    <strong>${escapeHtml(shortId(state.benchmark.runId))}</strong><br>
    schema ${escapeHtml(state.benchmark.schemaVersion)}<br>
    ${escapeHtml(dateTime(state.benchmark.generatedAt))}<br>
    ${escapeHtml(state.benchmark.configuration.fixturePreset?.name ?? "legacy scale")} preset`;
  element("overview-metrics").innerHTML = [
    metricCard("TS6 → TS7 default", formatRatio(defaultMedian), "median speedup across comparable standard fixtures"),
    metricCard("TS6 → TS7 single", formatRatio(nativeMedian), "native implementation approximation"),
    metricCard("TS7 single → default", formatRatio(parallelMedian), "parallel contribution approximation"),
    metricCard("Possible regressions", String(possibleRegressions), `${failedResults} incomplete performance result${failedResults === 1 ? "" : "s"}`, possibleRegressions > 0 || failedResults > 0)
  ].join("");

  const preferred = [
    "startup-only",
    "parse-heavy",
    "type-heavy-scaled",
    "emit-heavy",
    "module-resolution",
    "incremental-edit",
    "watch-edit",
    "project-references-dag"
  ];
  const selected = preferred.filter((name) => groups.has(name));
  if (selected.length === 0) selected.push(...[...groups.keys()].slice(0, 8));
  element("overview-performance").innerHTML = selected.map((fixture) => {
    const variants = groups.get(fixture);
    const speedup = ratio(variants.ts6, variants["ts7-default"]);
    const width = finite(speedup) ? Math.min(100, 35 + speedup * 18) : 0;
    return `<div class="mini-comparison">
      <span class="fixture">${escapeHtml(fixture)}</span>
      <progress class="mini-progress" max="100" value="${width.toFixed(1)}">${width.toFixed(1)}%</progress>
      <span class="value">${escapeHtml(formatRatio(speedup))}</span>
    </div>`;
  }).join("") || '<div class="empty-state">No standard performance pairs.</div>';

  const classificationCounts = new Map();
  for (const item of diagnostics) {
    const status = diagnosticStatus(item);
    classificationCounts.set(status, (classificationCounts.get(status) ?? 0) + 1);
  }
  const signals = [
    ...[...classificationCounts].map(([label, count]) => [label, `${count} fixture${count === 1 ? "" : "s"}`]),
    [state.comparison.emit.status, `${state.comparison.emit.files.length} emit artifact${state.comparison.emit.files.length === 1 ? "" : "s"}`],
    [options.length ? "OPTION_CATALOG" : "NO_OPTION_CATALOG", `${options.length} recorded option probe${options.length === 1 ? "" : "s"}`]
  ];
  element("overview-compatibility").innerHTML = `<div class="signal-list">${signals.map(
    ([label, description]) => `<div class="signal-row"><span>${escapeHtml(description)}</span>${badge(label)}</div>`
  ).join("")}</div>`;
}

function renderPerformance() {
  const groups = standardGroups();
  element("performance-chart").innerHTML = [...groups].map(([fixture, variants]) => {
    const entries = [
      ["TS6", variants.ts6, "ts6"],
      ["TS7 single", variants["ts7-single"], "single"],
      ["TS7 default", variants["ts7-default"], "default"]
    ].filter(([, result]) => result);
    const max = Math.max(...entries.map(([, result]) => statistics(result)?.medianMs ?? 0), 1);
    const bars = entries.map(([label, result, className]) => {
      const value = statistics(result)?.medianMs;
      const width = finite(value) ? value / max * 100 : 0;
      return `<div class="bar-row">
        <span>${escapeHtml(label)}</span>
        <progress class="bar-progress ${className}" max="100" value="${width.toFixed(2)}">${width.toFixed(2)}%</progress>
        <span class="bar-value">${escapeHtml(formatMs(value))}</span>
      </div>`;
    }).join("");
    return `<article class="fixture-chart"><h4>${escapeHtml(fixture)}</h4><div class="bar-stack">${bars}</div></article>`;
  }).join("");

  const rows = state.benchmark.results.map((result) => {
    const value = statistics(result);
    const cpu = value?.resources?.cpuTimeMs?.median;
    const rss = value?.resources?.peakRssBytes?.median;
    return `<tr>
      <td><strong>${escapeHtml(result.fixture)}</strong></td>
      <td>${escapeHtml(result.variant)}</td>
      <td>${escapeHtml(formatMs(value?.medianMs))}</td>
      <td>${escapeHtml(formatMs(value?.meanMs))}</td>
      <td>${escapeHtml(formatMs(value?.p95Ms))}</td>
      <td>${escapeHtml(formatMs(cpu))}</td>
      <td>${escapeHtml(formatBytes(rss))}</td>
      <td>${value?.successfulSamples ?? 0}/${value?.plannedSamples ?? 0}</td>
      <td>${badge(value?.status ?? "unknown")}</td>
    </tr>`;
  }).join("");
  element("performance-table").innerHTML = `<thead><tr>
    <th>Fixture</th><th>Variant</th><th>Median</th><th>Mean</th><th>P95</th>
    <th>Median CPU</th><th>Peak RSS</th><th>Samples</th><th>Status</th>
  </tr></thead><tbody>${rows}</tbody>`;
}

function renderCompatibility() {
  const diagnostics = state.comparison.diagnostics ?? [];
  const options = state.comparison.compilerOptions ?? [];
  const identical = diagnostics.filter(
    (item) => diagnosticStatus(item) === "SUPPORTED_IDENTICALLY" || item.status === "IDENTICAL"
  ).length;
  const known = diagnostics.filter(
    (item) => diagnosticStatus(item) === "SUPPORTED_WITH_DIFFERENCE" || item.status === "EXPECTED_DIFFERENCE"
  ).length;
  const regressions = diagnostics.filter(
    (item) => diagnosticStatus(item) === "POSSIBLE_REGRESSION"
  ).length + options.filter((item) => item.status === "POSSIBLE_REGRESSION").length;
  element("compatibility-metrics").innerHTML = [
    metricCard("Supported identically", String(identical), "diagnostic fixtures"),
    metricCard("Known differences", String(known), "classified separately from regressions"),
    metricCard("Needs investigation", String(regressions), "possible regressions", regressions > 0)
  ].join("");
  element("compatibility-diagnostics").innerHTML = `<div class="signal-list">${diagnostics.map((item) =>
    `<div class="signal-row"><span>${escapeHtml(item.fixture)}</span>${badge(diagnosticStatus(item))}</div>`
  ).join("")}</div>`;

  if (options.length === 0) {
    element("options-table").innerHTML = '<tbody><tr><td class="empty-state">Compiler option catalog is unavailable for this schema version.</td></tr></tbody>';
    return;
  }
  element("options-table").innerHTML = `<thead><tr>
    <th>Option</th><th>Classification</th><th>Observation</th><th>Migration</th>
  </tr></thead><tbody>${options.map((item) => `<tr>
    <td><strong>${escapeHtml(item.option)}</strong></td>
    <td>${escapeHtml(item.classifications.join(", "))}</td>
    <td>${badge(item.status)}</td>
    <td>${escapeHtml(item.migration)}</td>
  </tr>`).join("")}</tbody>`;
}

function renderDiagnostics() {
  element("diagnostics-list").innerHTML = (state.comparison.diagnostics ?? []).map((item) => {
    const counts = diagnosticCounts(item);
    const evidence = {
      ts6: item.ts6,
      ts7: item.ts7,
      difference: item.difference ?? null,
      knownDifferences: item.knownDifferences ?? []
    };
    return `<article class="detail-card">
      <header><h4>${escapeHtml(item.fixture)}</h4>${badge(diagnosticStatus(item))}</header>
      <div class="detail-meta">
        <div><span>Diagnostics</span><strong>${escapeHtml(counts.diagnostics)}</strong></div>
        <div><span>Exit code</span><strong>${escapeHtml(counts.exitCode)}</strong></div>
        <div><span>TS6 only</span><strong>${counts.onlyTs6}</strong></div>
        <div><span>TS7 only</span><strong>${counts.onlyTs7}</strong></div>
      </div>
      <details><summary>Recorded structured and raw evidence</summary><pre>${escapeHtml(JSON.stringify(evidence, null, 2))}</pre></details>
    </article>`;
  }).join("") || '<div class="empty-state">No diagnostic comparisons.</div>';
}

function renderEmit() {
  const emit = state.comparison.emit;
  const files = emit.files ?? [];
  element("emit-content").innerHTML = `<div class="emit-hero">
    <div><span class="section-index">Comparison result</span><br><strong>${escapeHtml(emit.status)}</strong></div>
    ${badge(emit.status)}
  </div>
  <div class="file-list">${files.map((file) => `<div class="file-item">
    <span>${escapeHtml(file.filename)}</span>${badge(file.identical ? "IDENTICAL" : "DIFFERENT")}
  </div>`).join("") || '<div class="empty-state">No emitted files recorded.</div>'}</div>
  <article class="panel table-panel">
    <details><summary>Compiler output and full emit evidence</summary><pre>${escapeHtml(JSON.stringify(emit, null, 2))}</pre></details>
  </article>`;
}

function renderRunControls() {
  const select = element("run-select");
  const selected = state.benchmark?.runId ?? state.latest?.runId;
  select.innerHTML = state.runs.map((run) =>
    `<option value="${escapeHtml(run.runId)}"${run.runId === selected ? " selected" : ""}>${escapeHtml(dateTime(run.completedAt))} · ${escapeHtml(shortId(run.runId))}</option>`
  ).join("");
  const baseline = element("baseline-select");
  const priorSelection = baseline.value;
  baseline.innerHTML = state.runs.map((run) =>
    `<option value="${escapeHtml(run.runId)}">${escapeHtml(dateTime(run.completedAt))} · ${escapeHtml(shortId(run.runId))}</option>`
  ).join("");
  const preferred = state.runs.find((run) => run.runId !== selected)?.runId;
  baseline.value = state.runs.some((run) => run.runId === priorSelection)
    ? priorSelection
    : preferred ?? selected;
  element("run-detail").textContent = state.benchmark
    ? `${state.benchmark.schemaVersion} · TS6 ${state.benchmark.metadata.compilers.ts6.version} · TS7 ${state.benchmark.metadata.compilers.ts7.version}`
    : "No run selected";
}

function renderHistoryComparison() {
  const target = element("history-comparison");
  if (!state.historical) {
    target.innerHTML = '<div class="comparison-notice">Choose a baseline to calculate a read-only comparison against the displayed run.</div>';
    return;
  }
  const comparison = state.historical;
  const counts = comparison.summary.performanceClassifications;
  const warnings = comparison.comparability.warnings.length
    ? `<div class="comparison-notice">${comparison.comparability.warnings.map(escapeHtml).join("<br>")}</div>`
    : "";
  const interesting = comparison.performance.filter(
    (row) => row.classification !== "STABLE"
  );
  target.innerHTML = `${warnings}<div class="metric-grid compact">
    ${metricCard("Regressions", String(counts.REGRESSION), `>${comparison.thresholdPercent}% slower`, counts.REGRESSION > 0)}
    ${metricCard("Improvements", String(counts.IMPROVEMENT), `>${comparison.thresholdPercent}% faster`)}
    ${metricCard("Not comparable", String(counts.NOT_COMPARABLE), comparison.comparability.status, counts.NOT_COMPARABLE > 0)}
  </div>
  <article class="panel table-panel"><div class="panel-heading"><h3>Changes outside the stable band</h3>${badge(comparison.comparability.status)}</div>
    <div class="table-scroll"><table><thead><tr><th>Fixture</th><th>Variant</th><th>Baseline</th><th>Target</th><th>Change</th><th>Classification</th></tr></thead>
      <tbody>${interesting.map((row) => `<tr><td><strong>${escapeHtml(row.fixture)}</strong></td><td>${escapeHtml(row.variant)}</td><td>${escapeHtml(formatMs(row.baseline?.medianMs))}</td><td>${escapeHtml(formatMs(row.target?.medianMs))}</td><td>${escapeHtml(formatPercent(row.deltaPercent))}</td><td>${badge(row.classification)}</td></tr>`).join("") || '<tr><td colspan="6" class="empty-state">All shared rows are stable at this threshold.</td></tr>'}</tbody>
    </table></div>
  </article>`;
}

function renderHistory() {
  const selected = state.benchmark.runId;
  element("history-table").innerHTML = `<thead><tr>
    <th>Completed</th><th>Run</th><th>TS6</th><th>TS7</th><th>Machine</th><th>State</th>
  </tr></thead><tbody>${state.runs.map((run) => `<tr data-run-id="${escapeHtml(run.runId)}">
    <td>${escapeHtml(dateTime(run.completedAt))}</td>
    <td><strong>${escapeHtml(shortId(run.runId))}</strong>${run.runId === selected ? " · displayed" : ""}</td>
    <td>${escapeHtml(run.metadata.compilers.ts6.version)}</td>
    <td>${escapeHtml(run.metadata.compilers.ts7.version)}</td>
    <td>${escapeHtml(run.metadata.hardware.cpuModel)}</td>
    <td>${badge(run.metadata.git.dirty ? "dirty" : "clean")}</td>
  </tr>`).join("")}</tbody>`;
  renderHistoryComparison();
}

function definitionList(entries) {
  return `<dl>${entries.map(([term, description]) =>
    `<dt>${escapeHtml(term)}</dt><dd>${escapeHtml(description)}</dd>`
  ).join("")}</dl>`;
}

function renderEnvironment() {
  const metadata = state.benchmark.metadata;
  const preset = state.benchmark.configuration.fixturePreset;
  element("environment-grid").innerHTML = `
    <article class="environment-card"><h4>Compilers</h4>${definitionList([
      ["TypeScript 6", metadata.compilers.ts6.version],
      ["TypeScript 7", metadata.compilers.ts7.version],
      ["Result schema", state.benchmark.schemaVersion],
      ["Run", state.benchmark.runId]
    ])}</article>
    <article class="environment-card"><h4>Runtime & machine</h4>${definitionList([
      ["Node", metadata.runtime.nodeVersion],
      ["Platform", `${metadata.runtime.platform} / ${metadata.runtime.arch}`],
      ["CPU", metadata.hardware.cpuModel],
      ["Logical CPUs", metadata.hardware.logicalCpuCount],
      ["Memory", formatBytes(metadata.hardware.totalMemoryBytes)]
    ])}</article>
    <article class="environment-card"><h4>Source & input</h4>${definitionList([
      ["Commit", metadata.git.commitSha ?? "unavailable"],
      ["Branch", metadata.git.branch ?? "detached"],
      ["Worktree", metadata.git.dirty ? "dirty" : "clean"],
      ["Preset", preset?.name ?? "legacy / custom"],
      ["Measured runs", state.benchmark.configuration.runs],
      ["Warm-ups", state.benchmark.configuration.warmups]
    ])}</article>`;
  element("configuration-json").textContent = JSON.stringify(
    state.benchmark.configuration,
    null,
    2
  );
}

function renderAll() {
  renderRunControls();
  renderOverview();
  renderPerformance();
  renderCompatibility();
  renderDiagnostics();
  renderEmit();
  renderHistory();
  renderEnvironment();
}

function setView(view) {
  state.view = view;
  for (const button of document.querySelectorAll("[data-view]")) {
    button.classList.toggle("is-active", button.dataset.view === view);
  }
  for (const panel of document.querySelectorAll("[data-view-panel]")) {
    const active = panel.dataset.viewPanel === view;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  }
  element("view-kicker").textContent = viewCopy[view][0];
  element("view-title").textContent = viewCopy[view][1];
  element("main-content").focus({ preventScroll: true });
}

async function loadRun(runId) {
  clearError();
  const documents = await fetchJson(`/api/run/${encodeURIComponent(runId)}`);
  const manifest = documents.find((document) => document.kind === "run-manifest");
  const benchmark = documents.find((document) => document.kind === "benchmark");
  const comparison = documents.find((document) => document.kind === "comparison");
  if (!manifest || !benchmark?.schemaVersion || !comparison?.schemaVersion) {
    throw new Error("The selected run is missing a versioned result document.");
  }
  state.manifest = manifest;
  state.benchmark = benchmark;
  state.comparison = comparison;
  state.historical = null;
  renderAll();
}

async function compareHistory() {
  const baseline = element("baseline-select").value;
  const target = state.benchmark.runId;
  const threshold = element("threshold-input").value;
  if (!baseline) throw new Error("Select a baseline run.");
  const parameters = new URLSearchParams({ baseline, target, threshold });
  state.historical = await fetchJson(`/api/compare?${parameters}`);
  renderHistoryComparison();
}

function attachEvents() {
  for (const button of document.querySelectorAll("[data-view]")) {
    button.addEventListener("click", () => setView(button.dataset.view));
  }
  element("run-select").addEventListener("change", async (event) => {
    try {
      await loadRun(event.target.value);
    } catch (error) {
      showError(error);
    }
  });
  element("history-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      clearError();
      await compareHistory();
    } catch (error) {
      showError(error);
    }
  });
  element("history-table").addEventListener("click", async (event) => {
    const row = event.target.closest("tr[data-run-id]");
    if (!row) return;
    try {
      await loadRun(row.dataset.runId);
    } catch (error) {
      showError(error);
    }
  });
}

async function initialize() {
  attachEvents();
  try {
    [state.latest, state.runs] = await Promise.all([
      fetchJson("/api/latest"),
      fetchJson("/api/runs")
    ]);
    if (state.runs.length === 0) {
      throw new Error("No complete runs are available. Run the lab first.");
    }
    await loadRun(state.latest.runId);
  } catch (error) {
    showError(error);
  }
}

initialize();
