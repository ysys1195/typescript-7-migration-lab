import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  compilers,
  createResultEnvelope,
  root,
  run,
  writeResultJson
} from "./lib.mjs";
import {
  classifyDiagnosticDifference,
  createDiagnosticDifference,
  createDiagnosticOutcome,
  manifestPath,
  readKnownDifferenceManifest
} from "./diagnostics.mjs";
import {
  compilerOptionCatalogPath,
  runCompilerOptionCatalog
} from "./compiler-options.mjs";

const diagnosticFixtures = [
  { name: "small" },
  { name: "type-heavy" },
  { name: "jsx" },
  { name: "jsdoc" },
  { name: "diagnostics" },
  { name: "legacy-options" }
];
const knownDifferenceManifestPath = manifestPath(root);
const knownDifferenceManifest = await readKnownDifferenceManifest(
  knownDifferenceManifestPath
);

function normalizeDiagnostics(output) {
  return output
    .replaceAll(root, "<ROOT>")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => !/^Version \d/.test(line))
    .filter((line) => !/Found \d+ errors?/.test(line))
    .sort();
}

const diagnosticResults = [];
for (const fixtureConfig of diagnosticFixtures) {
  const fixture = fixtureConfig.name;
  const args = ["-p", `fixtures/${fixture}`, "--pretty", "false"];
  const [ts6, ts7] = await Promise.all([
    run(compilers.ts6, args),
    run(compilers.ts7, args)
  ]);
  const ts6Outcome = createDiagnosticOutcome(ts6, { rootDirectory: root });
  const ts7Outcome = createDiagnosticOutcome(ts7, { rootDirectory: root });
  const difference = createDiagnosticDifference(ts6Outcome, ts7Outcome);
  const classification = classifyDiagnosticDifference(
    fixture,
    difference,
    knownDifferenceManifest
  );

  diagnosticResults.push({
    fixture,
    ...classification,
    difference,
    ts6: ts6Outcome,
    ts7: ts7Outcome
  });
  console.log(`${fixture.padEnd(16)} ${classification.classification}`);
}

const compilerOptionCatalog = await runCompilerOptionCatalog();
for (const result of compilerOptionCatalog.results) {
  console.log(`${result.id.padEnd(42)} ${result.status}`);
}

async function listFiles(directory, base = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(absolute, base));
    else files.push(path.relative(base, absolute));
  }
  return files.sort();
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ts7-lab-"));
const ts6Out = path.join(temporaryRoot, "ts6");
const ts7Out = path.join(temporaryRoot, "ts7");

try {
  const argsFor = (outDir) => [
    "-p", "fixtures/emit",
    "--outDir", outDir,
    "--pretty", "false"
  ];
  const [ts6Emit, ts7Emit] = await Promise.all([
    run(compilers.ts6, argsFor(ts6Out)),
    run(compilers.ts7, argsFor(ts7Out))
  ]);

  const ts6Files = ts6Emit.exitCode === 0 ? await listFiles(ts6Out) : [];
  const ts7Files = ts7Emit.exitCode === 0 ? await listFiles(ts7Out) : [];
  const namesMatch = JSON.stringify(ts6Files) === JSON.stringify(ts7Files);
  const fileComparisons = [];

  for (const filename of [...new Set([...ts6Files, ...ts7Files])].sort()) {
    const [left, right] = await Promise.all([
      ts6Files.includes(filename)
        ? readFile(path.join(ts6Out, filename), "utf8")
        : Promise.resolve(null),
      ts7Files.includes(filename)
        ? readFile(path.join(ts7Out, filename), "utf8")
        : Promise.resolve(null)
    ]);
    fileComparisons.push({ filename, identical: left === right, ts6: left, ts7: right });
  }

  const stored = await writeResultJson("comparison.json", {
    ...await createResultEnvelope("comparison", {
      diagnosticFixtures,
      knownDiagnosticDifferences: {
        path: path.relative(root, knownDifferenceManifestPath),
        version: knownDifferenceManifest.version
      },
      compilerOptionCatalog: {
        path: path.relative(root, compilerOptionCatalogPath),
        version: compilerOptionCatalog.version
      },
      emitFixture: "emit"
    }),
    diagnostics: diagnosticResults,
    compilerOptions: compilerOptionCatalog.results,
    emit: {
      status:
        ts6Emit.exitCode === 0 &&
        ts7Emit.exitCode === 0 &&
        namesMatch &&
        fileComparisons.every((file) => file.identical)
          ? "IDENTICAL"
          : "DIFFERENT",
      ts6ExitCode: ts6Emit.exitCode,
      ts7ExitCode: ts7Emit.exitCode,
      ts6Output: normalizeDiagnostics(ts6Emit.stdout + ts6Emit.stderr),
      ts7Output: normalizeDiagnostics(ts7Emit.stdout + ts7Emit.stderr),
      files: fileComparisons
    }
  });
  console.log(`Wrote ${path.relative(root, stored.path)}.`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
