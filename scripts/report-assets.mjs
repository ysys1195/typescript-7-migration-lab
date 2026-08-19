import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resultStore } from "./result-store.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(
  root,
  "docs",
  "assets",
  "final-report",
  "performance-speedups.svg"
);
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

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function medianFor(results, fixture, variant) {
  return results.find((result) =>
    result.fixture === fixture && result.variant === variant
  )?.statistics?.medianMs ?? null;
}

function speedup(numerator, denominator) {
  return typeof numerator === "number" && typeof denominator === "number" &&
    numerator > 0 && denominator > 0
    ? numerator / denominator
    : null;
}

function formatRatio(value) {
  return value === null ? "unavailable" : `${value.toFixed(2)}x`;
}

export function createPerformanceSvg(benchmark) {
  const rows = fixtures.map((fixture) => {
    const ts6 = medianFor(benchmark.results, fixture, "ts6");
    const single = medianFor(benchmark.results, fixture, "ts7-single");
    const parallel = medianFor(benchmark.results, fixture, "ts7-default");
    return {
      fixture,
      native: speedup(ts6, single),
      overall: speedup(ts6, parallel)
    };
  });
  if (rows.some((row) => row.native === null || row.overall === null)) {
    throw new Error("Latest run lacks a complete representative fixture matrix.");
  }

  const width = 1280;
  const top = 196;
  const rowHeight = 64;
  const height = top + rows.length * rowHeight + 92;
  const labelX = 48;
  const plotX = 315;
  const plotWidth = 850;
  const rawMaximum = Math.max(...rows.flatMap((row) => [row.native, row.overall]));
  const axisMaximum = Math.max(4, Math.ceil(rawMaximum * 2) / 2);
  const scale = (value) => value / axisMaximum * plotWidth;
  const ticks = Array.from({ length: 5 }, (_, index) =>
    axisMaximum * index / 4
  );

  const grid = ticks.map((tick) => {
    const x = plotX + scale(tick);
    return `<line x1="${x}" y1="${top - 18}" x2="${x}" y2="${height - 70}" class="grid"/>\n` +
      `<text x="${x}" y="${height - 38}" class="tick" text-anchor="middle">${tick.toFixed(1)}x</text>`;
  }).join("\n");
  const bars = rows.map((row, index) => {
    const y = top + index * rowHeight;
    return `<text x="${labelX}" y="${y + 25}" class="fixture">${escapeXml(row.fixture)}</text>
      <rect x="${plotX}" y="${y + 3}" width="${scale(row.native)}" height="16" class="native"/>
      <rect x="${plotX}" y="${y + 25}" width="${scale(row.overall)}" height="16" class="overall"/>
      <text x="${plotX + scale(row.native) + 10}" y="${y + 16}" class="value">${formatRatio(row.native)}</text>
      <text x="${plotX + scale(row.overall) + 10}" y="${y + 38}" class="value strong">${formatRatio(row.overall)}</text>`;
  }).join("\n");
  const metadata = benchmark.metadata;
  const configuration = benchmark.configuration;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">TS6 to TS7 median wall-clock speedup</title>
  <desc id="description">Representative fixture speedups comparing TypeScript 6 with TypeScript 7 single-threaded and default configurations.</desc>
  <style>
    .background { fill: #0d1110; }
    text { fill: #f4f2ea; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .eyebrow { fill: #9ce3be; font: 700 14px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 2px; }
    .heading { font-size: 35px; font-weight: 620; letter-spacing: -1px; }
    .subheading, .note, .tick, .value { fill: #9eaaa6; }
    .subheading { font-size: 17px; }
    .legend { font-size: 14px; }
    .fixture { font-size: 16px; font-weight: 590; }
    .value { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .value.strong { fill: #9ce3be; }
    .tick { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .note { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .grid { stroke: #2b3531; stroke-width: 1; }
    .native { fill: #7ec8ff; }
    .overall { fill: #45c98b; }
  </style>
  <rect width="100%" height="100%" class="background"/>
  <text x="48" y="38" class="eyebrow">STANDARD LAB RUN / MEDIAN WALL-CLOCK</text>
  <text x="48" y="82" class="heading">Where TypeScript 7 changes the work</text>
  <text x="48" y="112" class="subheading">Higher is faster. Native approximates TS6 / TS7 single; overall is TS6 / TS7 default.</text>
  <rect x="48" y="139" width="16" height="16" class="native"/><text x="74" y="152" class="legend">native approximation</text>
  <rect x="254" y="139" width="16" height="16" class="overall"/><text x="280" y="152" class="legend">overall observed speedup</text>
  ${grid}
  ${bars}
  <text x="48" y="${height - 18}" class="note">Run ${escapeXml(benchmark.runId)} | ${escapeXml(configuration.fixturePreset.name)} preset | ${configuration.runs} measured + ${configuration.warmups} warm-up | ${escapeXml(metadata.hardware.cpuModel)} | TS6 ${escapeXml(metadata.compilers.ts6.version)} / TS7 ${escapeXml(metadata.compilers.ts7.version)}</text>
</svg>\n`;
}

async function main() {
  const { benchmark } = await resultStore.readLatestRun();
  const svg = createPerformanceSvg(benchmark);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, svg);
  console.log(`Wrote ${path.relative(root, outputPath)} from run ${benchmark.runId}.`);
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
