import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compilers, root, run, writeJson } from "./lib.mjs";

const diagnosticFixtures = [
  { name: "small" },
  { name: "type-heavy" },
  { name: "jsx" },
  { name: "jsdoc" },
  { name: "diagnostics" },
  { name: "legacy-options", expectedDifference: true }
];

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
  const ts6Lines = normalizeDiagnostics(ts6.stdout + ts6.stderr);
  const ts7Lines = normalizeDiagnostics(ts7.stdout + ts7.stderr);
  const sameDiagnostics = JSON.stringify(ts6Lines) === JSON.stringify(ts7Lines);
  let status = "DIFFERENT";
  if (sameDiagnostics && ts6.exitCode === ts7.exitCode) status = "IDENTICAL";
  else if (sameDiagnostics) status = "SAME_DIAGNOSTICS_EXIT_DIFFERENT";
  else if (fixtureConfig.expectedDifference) status = "EXPECTED_DIFFERENCE";

  diagnosticResults.push({
    fixture,
    status,
    expectedDifference: fixtureConfig.expectedDifference ?? false,
    ts6: { exitCode: ts6.exitCode, diagnostics: ts6Lines },
    ts7: { exitCode: ts7.exitCode, diagnostics: ts7Lines }
  });
  console.log(`${fixture.padEnd(16)} ${status}`);
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

  await writeJson("comparison.json", {
    generatedAt: new Date().toISOString(),
    diagnostics: diagnosticResults,
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
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log("Wrote results/comparison.json.");
