import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { createDiagnosticOutcome } from "./diagnostics.mjs";
import { compilers, root, run } from "./lib.mjs";

export const compilerOptionCatalogPath = path.join(
  root,
  "compatibility",
  "compiler-options.json"
);

function validateExpectation(value) {
  return value &&
    (value.exitCode === null || Number.isInteger(value.exitCode)) &&
    Array.isArray(value.diagnosticCodes) &&
    value.diagnosticCodes.every(Number.isInteger) &&
    Array.isArray(value.emittedFiles) &&
    value.emittedFiles.every((filename) => typeof filename === "string");
}

function validateCatalog(value) {
  const validClassifications = new Set([
    "DEPRECATED_IN_TS6",
    "REMOVED_IN_TS7",
    "DEFAULT_CHANGED"
  ]);
  const ids = Array.isArray(value?.entries)
    ? value.entries.map((entry) => entry?.id)
    : [];
  const invalid = !value || value.version !== 1 || !Array.isArray(value.entries) ||
    value.entries.length === 0 || new Set(ids).size !== ids.length ||
    value.entries.some((entry) =>
      !entry ||
      typeof entry.id !== "string" || entry.id.length === 0 ||
      typeof entry.option !== "string" || entry.option.length === 0 ||
      !Array.isArray(entry.classifications) || entry.classifications.length === 0 ||
      entry.classifications.some((item) => !validClassifications.has(item)) ||
      typeof entry.transition !== "string" || entry.transition.length === 0 ||
      typeof entry.fixture !== "string" || entry.fixture.length === 0 ||
      typeof entry.rationale !== "string" || entry.rationale.length === 0 ||
      typeof entry.migration !== "string" || entry.migration.length === 0 ||
      typeof entry.source !== "string" || !entry.source.startsWith("https://") ||
      typeof entry.reproduction !== "string" || entry.reproduction.length === 0 ||
      !["diagnostics", "emit-files"].includes(entry.probe?.kind) ||
      !validateExpectation(entry.probe?.expected?.ts6) ||
      !validateExpectation(entry.probe?.expected?.ts7)
    );
  if (invalid) throw new Error("Invalid compiler option catalog.");
  return value;
}

export async function readCompilerOptionCatalog() {
  return validateCatalog(JSON.parse(
    await readFile(compilerOptionCatalogPath, "utf8")
  ));
}

function parseEmittedFiles(output, temporaryOutDir) {
  return output.split(/\r?\n/)
    .map((line) => line.match(/^TSFILE:\s*(.+)$/)?.[1])
    .filter(Boolean)
    .map((filename) => path.relative(temporaryOutDir, filename).replaceAll("\\", "/"))
    .sort();
}

async function runProbe(entry, compilerName) {
  let temporaryOutDir = null;
  try {
    const args = ["-p", entry.fixture, "--pretty", "false"];
    if (entry.probe.kind === "emit-files") {
      temporaryOutDir = await mkdtemp(path.join(os.tmpdir(), "ts7-option-emit-"));
      args.push("--outDir", temporaryOutDir, "--listEmittedFiles");
    }
    const executed = await run(compilers[compilerName], args);
    const outcome = createDiagnosticOutcome(executed, { rootDirectory: root });
    const emittedFiles = temporaryOutDir
      ? parseEmittedFiles(executed.stdout + executed.stderr, temporaryOutDir)
      : [];
    return { ...outcome, emittedFiles };
  } finally {
    if (temporaryOutDir) {
      await rm(temporaryOutDir, { recursive: true, force: true });
    }
  }
}

function summarizeOutcome(outcome) {
  return {
    exitCode: outcome.exitCode,
    diagnosticCodes: outcome.diagnostics.map((diagnostic) => diagnostic.code)
      .sort((left, right) => left - right),
    emittedFiles: outcome.emittedFiles
  };
}

export function classifyCompilerOptionOutcome(expected, ts6, ts7) {
  const ts6Matches = isDeepStrictEqual(summarizeOutcome(ts6), expected.ts6);
  const ts7Matches = isDeepStrictEqual(summarizeOutcome(ts7), expected.ts7);
  return ts6Matches && ts7Matches
    ? "MATCHED_EXPECTATION"
    : "POSSIBLE_REGRESSION";
}

async function runEntry(entry) {
  const [ts6, ts7] = await Promise.all([
    runProbe(entry, "ts6"),
    runProbe(entry, "ts7")
  ]);
  return {
    id: entry.id,
    option: entry.option,
    classifications: entry.classifications,
    transition: entry.transition,
    fixture: entry.fixture,
    rationale: entry.rationale,
    migration: entry.migration,
    source: entry.source,
    reproduction: entry.reproduction,
    probe: {
      kind: entry.probe.kind,
      expected: entry.probe.expected
    },
    status: classifyCompilerOptionOutcome(entry.probe.expected, ts6, ts7),
    ts6,
    ts7
  };
}

export async function runCompilerOptionCatalog({ ids } = {}) {
  const catalog = await readCompilerOptionCatalog();
  const requested = ids ? new Set(ids) : null;
  const entries = requested
    ? catalog.entries.filter((entry) => requested.has(entry.id))
    : catalog.entries;
  if (requested && entries.length !== requested.size) {
    const found = new Set(entries.map((entry) => entry.id));
    const missing = [...requested].filter((id) => !found.has(id));
    throw new Error(`Unknown compiler option catalog id: ${missing.join(", ")}`);
  }
  const results = [];
  for (const entry of entries) results.push(await runEntry(entry));
  return { version: catalog.version, results };
}

function readRequestedIds(args) {
  const ids = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--id") throw new Error(`Unknown argument: ${args[index]}`);
    if (!args[index + 1]) throw new Error("--id requires a value.");
    ids.push(args[index + 1]);
    index += 1;
  }
  return ids.length ? ids : undefined;
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { results } = await runCompilerOptionCatalog({
    ids: readRequestedIds(process.argv.slice(2))
  });
  for (const result of results) {
    console.log(
      `${result.id.padEnd(42)} ${result.status} ` +
      `(TS6 ${result.ts6.exitCode}, TS7 ${result.ts7.exitCode})`
    );
  }
  if (results.some((result) => result.status === "POSSIBLE_REGRESSION")) {
    process.exitCode = 1;
  }
}
