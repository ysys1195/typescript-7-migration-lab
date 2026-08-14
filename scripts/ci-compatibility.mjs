import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { createDiagnosticOutcome } from "./diagnostics.mjs";
import { compilers, root, run } from "./lib.mjs";

export const ciGoldenPath = path.join(root, "compatibility", "ci-golden.json");

export const diagnosticFixtures = [
  "small",
  "type-heavy",
  "jsx",
  "jsdoc",
  "diagnostics",
  "legacy-options"
];

export const smokeFixtures = [
  "small",
  "type-heavy",
  "many-files",
  "jsx",
  "jsdoc",
  "diagnostics",
  "legacy-options",
  "module-resolution"
];

function normalizedPath(filename) {
  return filename.replaceAll("\\", "/");
}

export function normalizeGoldenText(value) {
  return value.replaceAll("\r\n", "\n");
}

async function compilerVersion(compiler) {
  const result = await run(compiler, ["--version"]);
  if (result.exitCode !== 0) {
    throw new Error(`Compiler version probe failed: ${result.stdout}${result.stderr}`);
  }
  return result.stdout.trim().replace(/^Version\s+/, "");
}

async function executeFixture(fixture) {
  const args = ["-p", `fixtures/${fixture}`, "--pretty", "false", "--noEmit"];
  const [ts6, ts7] = await Promise.all([
    run(compilers.ts6, args),
    run(compilers.ts7, args)
  ]);
  return { ts6, ts7 };
}

function diagnosticExpectation(result) {
  const outcome = createDiagnosticOutcome(result, { rootDirectory: root });
  return {
    exitCode: outcome.exitCode,
    diagnostics: outcome.diagnostics
  };
}

async function listFiles(directory, base = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(absolute, base));
    else files.push(normalizedPath(path.relative(base, absolute)));
  }
  return files.sort();
}

async function readEmit(directory, execution) {
  const files = execution.exitCode === 0 ? await listFiles(directory) : [];
  return {
    exitCode: execution.exitCode,
    files: await Promise.all(files.map(async (filename) => ({
      filename,
      content: normalizeGoldenText(await readFile(
        path.join(directory, ...filename.split("/")),
        "utf8"
      ))
    })))
  };
}

async function createEmitExpectation() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ts7-ci-emit-"));
  const ts6Out = path.join(temporaryRoot, "ts6");
  const ts7Out = path.join(temporaryRoot, "ts7");
  try {
    const argsFor = (outDir) => [
      "-p",
      "fixtures/emit",
      "--outDir",
      outDir,
      "--pretty",
      "false"
    ];
    const [ts6Execution, ts7Execution] = await Promise.all([
      run(compilers.ts6, argsFor(ts6Out)),
      run(compilers.ts7, argsFor(ts7Out))
    ]);
    const [ts6, ts7] = await Promise.all([
      readEmit(ts6Out, ts6Execution),
      readEmit(ts7Out, ts7Execution)
    ]);
    return { fixture: "emit", ts6, ts7 };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export function validateCiGolden(value) {
  const validCompiler = (compiler) =>
    compiler && typeof compiler.version === "string" && compiler.version.length > 0;
  const validOutcome = (outcome) => outcome && Number.isInteger(outcome.exitCode);
  const invalid = !value ||
    value.schemaVersion !== "1.0.0" ||
    value.kind !== "ci-compatibility-golden" ||
    !validCompiler(value.compilers?.ts6) ||
    !validCompiler(value.compilers?.ts7) ||
    !Array.isArray(value.smoke) ||
    value.smoke.map((entry) => entry.fixture).join("\n") !== smokeFixtures.join("\n") ||
    value.smoke.some((entry) => !validOutcome(entry.ts6) || !validOutcome(entry.ts7)) ||
    !Array.isArray(value.diagnostics) ||
    value.diagnostics.map((entry) => entry.fixture).join("\n") !==
      diagnosticFixtures.join("\n") ||
    value.diagnostics.some((entry) =>
      !validOutcome(entry.ts6) || !validOutcome(entry.ts7) ||
      !Array.isArray(entry.ts6.diagnostics) || !Array.isArray(entry.ts7.diagnostics)
    ) ||
    value.emit?.fixture !== "emit" ||
    !validOutcome(value.emit.ts6) || !validOutcome(value.emit.ts7) ||
    !Array.isArray(value.emit.ts6.files) || !Array.isArray(value.emit.ts7.files);
  if (invalid) throw new Error("Invalid CI compatibility golden file.");
  return value;
}

export async function createCiCompatibilitySnapshot() {
  const versions = await Promise.all([
    compilerVersion(compilers.ts6),
    compilerVersion(compilers.ts7)
  ]);
  const executions = new Map();
  for (const fixture of smokeFixtures) {
    executions.set(fixture, await executeFixture(fixture));
  }
  return validateCiGolden({
    schemaVersion: "1.0.0",
    kind: "ci-compatibility-golden",
    compilers: {
      ts6: { version: versions[0] },
      ts7: { version: versions[1] }
    },
    normalization: {
      diagnosticPaths: "repository-relative forward-slash paths",
      emitPaths: "forward-slash paths",
      emitLineEndings: "LF"
    },
    smoke: smokeFixtures.map((fixture) => {
      const execution = executions.get(fixture);
      return {
        fixture,
        ts6: { exitCode: execution.ts6.exitCode },
        ts7: { exitCode: execution.ts7.exitCode }
      };
    }),
    diagnostics: diagnosticFixtures.map((fixture) => {
      const execution = executions.get(fixture);
      return {
        fixture,
        ts6: diagnosticExpectation(execution.ts6),
        ts7: diagnosticExpectation(execution.ts7)
      };
    }),
    emit: await createEmitExpectation()
  });
}

export async function readCiGolden() {
  return validateCiGolden(JSON.parse(await readFile(ciGoldenPath, "utf8")));
}

function compareSection(name, expected, actual) {
  if (isDeepStrictEqual(expected, actual)) {
    console.log(`${name}: matched`);
    return;
  }
  throw new Error(
    `${name} differs from the checked-in golden.\n` +
    `Expected:\n${JSON.stringify(expected, null, 2)}\n` +
    `Actual:\n${JSON.stringify(actual, null, 2)}`
  );
}

export async function verifyCiCompatibility() {
  const [expected, actual] = await Promise.all([
    readCiGolden(),
    createCiCompatibilitySnapshot()
  ]);
  compareSection("compiler versions", expected.compilers, actual.compilers);
  compareSection("fixture smoke", expected.smoke, actual.smoke);
  compareSection("diagnostic expectations", expected.diagnostics, actual.diagnostics);
  compareSection("emit golden", expected.emit, actual.emit);
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] && args[0] !== "--record")) {
    throw new Error("Usage: node scripts/ci-compatibility.mjs [--record]");
  }
  if (args[0] === "--record") {
    const result = await createCiCompatibilitySnapshot();
    await writeFile(ciGoldenPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.log("Wrote compatibility/ci-golden.json.");
  } else {
    await verifyCiCompatibility();
  }
}
