import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildExecutionPlan,
  ORDER_STRATEGY,
  summarizeAttempts
} from "./benchmark-core.mjs";
import {
  compilers,
  parseExtendedDiagnostics,
  root,
  run
} from "./lib.mjs";
import {
  createResourceMeasurer,
  unavailableResourceUsage
} from "./resource-measurement.mjs";
import { resultStore } from "./result-store.mjs";
import {
  LOCAL_PROJECT_SCHEMA_VERSION,
  validateLocalProjectManifestDocument,
  validateLocalProjectResultDocument,
  validateResultDocument
} from "./schema.mjs";

const outputFlags = new Set([
  "--declaration",
  "--declarationdir",
  "--emitdeclarationonly",
  "--generatetrace",
  "--outdir",
  "--outfile",
  "--tsbuildinfofile"
]);

export const localProjectVariants = [
  { name: "ts6", compiler: "ts6", extraArgs: [] },
  {
    name: "ts7-single",
    compiler: "ts7",
    extraArgs: ["--singleThreaded"]
  },
  { name: "ts7-default", compiler: "ts7", extraArgs: [] }
];

function hasPathTraversal(value) {
  return value.split(/[\\/]+/).includes("..");
}

function validateCompilerArgs(name, args) {
  if (args.some((argument) =>
    argument.includes("\0") || argument.includes("\n") || argument.includes("\r")
  )) {
    throw new Error(`${name} arguments cannot contain control characters.`);
  }
  const pathCandidates = args.flatMap((argument) => {
    const equalsIndex = argument.indexOf("=");
    return equalsIndex === -1
      ? [argument]
      : [argument, argument.slice(equalsIndex + 1)];
  });
  if (pathCandidates.some((argument) =>
    path.isAbsolute(argument) || path.win32.isAbsolute(argument) ||
    hasPathTraversal(argument)
  )) {
    throw new Error(`${name} arguments must stay within the project root.`);
  }
  if (args.some((argument) =>
    outputFlags.has(argument.split("=")[0].toLowerCase())
  )) {
    throw new Error(`${name} cannot configure compiler output paths.`);
  }
  if (args.some((argument) => ["--watch", "-w"].includes(
    argument.split("=")[0].toLowerCase()
  ))) {
    throw new Error(`${name} cannot use watch mode.`);
  }
}

function booleanFlagEnabled(args, longName, shortName = null) {
  const names = [longName, shortName].filter(Boolean);
  let enabled = false;
  for (let index = 0; index < args.length; index += 1) {
    for (const name of names) {
      const argument = args[index].toLowerCase();
      const normalizedName = name.toLowerCase();
      if (argument === normalizedName) {
        enabled = args[index + 1]?.toLowerCase() !== "false";
      }
      if (argument === `${normalizedName}=true`) enabled = true;
      if (argument === `${normalizedName}=false`) enabled = false;
    }
  }
  return enabled;
}

export function validateReadOnlyManifest(manifest) {
  validateLocalProjectManifestDocument(manifest);
  const { typecheck, build } = manifest.commands;
  validateCompilerArgs("typecheck", typecheck.args);
  validateCompilerArgs("build", build.args);
  if (!booleanFlagEnabled(typecheck.args, "--noEmit")) {
    throw new Error("typecheck must include --noEmit.");
  }
  if (booleanFlagEnabled(typecheck.args, "--build", "-b")) {
    throw new Error("typecheck cannot use build mode.");
  }
  if (
    !booleanFlagEnabled(build.args, "--build", "-b") ||
    !booleanFlagEnabled(build.args, "--dry")
  ) {
    throw new Error("build must use --build and --dry.");
  }
  return manifest;
}

export async function readLocalProjectManifest(filename) {
  let value;
  try {
    value = JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read local project manifest: ${filename}`, {
      cause: error
    });
  }
  return validateReadOnlyManifest(value);
}

function normalizeSourceUrl(value) {
  let normalized = value.trim();
  const sshMatch = normalized.match(/^git@github\.com:(.+)$/);
  if (sshMatch) normalized = `https://github.com/${sshMatch[1]}`;
  return normalized.replace(/\.git$/, "").replace(/\/$/, "");
}

async function git(projectRoot, args) {
  const result = await run("git", args, { cwd: projectRoot });
  if (result.exitCode !== 0) {
    throw new Error(`Git project verification failed for: git ${args.join(" ")}`);
  }
  return result.stdout.trim();
}

export async function verifyProjectIdentity(projectPath, manifest) {
  const resolvedProject = await realpath(projectPath);
  const gitRoot = await realpath(await git(resolvedProject, [
    "rev-parse",
    "--show-toplevel"
  ]));
  if (gitRoot !== resolvedProject) {
    throw new Error("--project must point to the Git repository root.");
  }
  const [commit, origin, status] = await Promise.all([
    git(gitRoot, ["rev-parse", "HEAD"]),
    git(gitRoot, ["remote", "get-url", "origin"]),
    git(gitRoot, ["status", "--porcelain=v1", "--untracked-files=all"])
  ]);
  if (commit !== manifest.source.commit) {
    throw new Error(
      `Project commit ${commit} does not match manifest commit ` +
      `${manifest.source.commit}.`
    );
  }
  if (normalizeSourceUrl(origin) !== normalizeSourceUrl(manifest.source.url)) {
    throw new Error("Project origin does not match manifest source URL.");
  }
  if (status !== "") {
    throw new Error("Local project must have a clean working tree before measurement.");
  }
  return { projectRoot: gitRoot, commit, origin: normalizeSourceUrl(origin) };
}

async function assertProjectRemainsClean(projectRoot) {
  const status = await git(projectRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all"
  ]);
  if (status !== "") {
    throw new Error(
      "A benchmark command changed the local project. " +
      "The adapter stopped without deleting or restoring user files."
    );
  }
}

function digest(value) {
  const text = String(value ?? "");
  return {
    bytes: Buffer.byteLength(text),
    sha256: createHash("sha256").update(text).digest("hex")
  };
}

function attemptFromOutcome(planItem, outcome) {
  const status = outcome.timedOut
    ? "timeout"
    : outcome.exitCode === 0
      ? "success"
      : "compiler-error";
  return {
    phase: planItem.phase,
    round: planItem.round,
    sequence: planItem.sequence,
    status,
    elapsedMs: outcome.elapsedMs,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    errorCode: null,
    output: {
      stdout: digest(outcome.stdout),
      stderr: digest(outcome.stderr)
    },
    resourceUsage: outcome.resourceUsage ?? unavailableResourceUsage(
      outcome.timedOut ? "attempt-timeout" : "measurement-not-returned"
    )
  };
}

function attemptFromError(planItem, error, collector) {
  return {
    phase: planItem.phase,
    round: planItem.round,
    sequence: planItem.sequence,
    status: "runner-error",
    elapsedMs: null,
    exitCode: null,
    signal: null,
    errorCode: typeof error?.code === "string" ? error.code : "RUNNER_ERROR",
    output: { stdout: digest(""), stderr: digest("") },
    resourceUsage: unavailableResourceUsage("runner-error", collector)
  };
}

function resultStatus(attempts, statistics) {
  if (statistics.successfulSamples === 0) return "failed";
  return attempts.some((attempt) => attempt.status !== "success")
    ? "partial"
    : "complete";
}

function nullSpeedups() {
  return { native: null, parallel: null, overall: null };
}

export function calculateSpeedups(results, keyName, keyValue) {
  const medianFor = (variant) => results.find((result) =>
    result[keyName] === keyValue && result.variant === variant
  )?.statistics?.medianMs ?? null;
  const ts6 = medianFor("ts6");
  const single = medianFor("ts7-single");
  const parallel = medianFor("ts7-default");
  if (
    ![ts6, single, parallel].every((value) =>
      typeof value === "number" && Number.isFinite(value) && value > 0
    )
  ) {
    return nullSpeedups();
  }
  return {
    native: ts6 / single,
    parallel: single / parallel,
    overall: ts6 / parallel
  };
}

function direction(value) {
  if (value > 1.05) return "faster";
  if (value < 0.95) return "slower";
  return "similar";
}

function compareAlignment(project, synthetic) {
  if ([...Object.values(project), ...Object.values(synthetic)].some(
    (value) => value === null
  )) {
    return "unavailable";
  }
  return ["native", "parallel", "overall"].every(
    (key) => direction(project[key]) === direction(synthetic[key])
  )
    ? "aligned"
    : "mixed";
}

export function createTrendComparisons(manifest, projectResults, syntheticRun) {
  return manifest.syntheticComparisons.map((mapping) => {
    const projectSpeedups = calculateSpeedups(
      projectResults,
      "workload",
      mapping.workload
    );
    if (!syntheticRun) {
      return {
        ...mapping,
        status: "synthetic-run-not-provided",
        projectSpeedups,
        syntheticSpeedups: nullSpeedups(),
        alignment: "unavailable"
      };
    }
    const syntheticSpeedups = calculateSpeedups(
      syntheticRun.results,
      "fixture",
      mapping.fixture
    );
    const alignment = compareAlignment(projectSpeedups, syntheticSpeedups);
    return {
      ...mapping,
      status: alignment === "unavailable" ? "data-unavailable" : "compared",
      projectSpeedups,
      syntheticSpeedups,
      alignment
    };
  });
}

async function compilerVersion(command) {
  const result = await run(command, ["--version"]);
  if (result.exitCode !== 0) throw new Error("Compiler version probe failed.");
  return result.stdout.trim().replace(/^Version\s+/, "");
}

async function readLabGitMetadata() {
  const [commitSha, branch, status] = await Promise.all([
    git(root, ["rev-parse", "HEAD"]),
    git(root, ["branch", "--show-current"]),
    git(root, ["status", "--porcelain=v1"])
  ]);
  return { commitSha, branch: branch || null, dirty: status !== "" };
}

function validateCounts({ runs, warmups, timeoutMs }) {
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 100) {
    throw new Error("runs must be an integer between 1 and 100.");
  }
  if (!Number.isSafeInteger(warmups) || warmups < 0 || warmups > 20) {
    throw new Error("warmups must be an integer between 0 and 20.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600_000) {
    throw new Error("timeoutMs must be an integer between 100 and 600000.");
  }
}

export async function runLocalProjectBenchmark(options) {
  const manifest = validateReadOnlyManifest(options.manifest);
  const runs = options.runs ?? 10;
  const warmups = options.warmups ?? 2;
  const timeoutMs = options.timeoutMs ?? 120_000;
  validateCounts({ runs, warmups, timeoutMs });
  const identity = await verifyProjectIdentity(options.projectPath, manifest);
  const compilerPaths = options.compilers ?? compilers;
  const fixtures = ["typecheck", "build"].map((name) => ({
    name,
    args: manifest.commands[name].args
  }));
  const executableVariants = localProjectVariants.map((variant) => ({
    ...variant,
    compilerPath: compilerPaths[variant.compiler]
  }));
  const executionPlan = buildExecutionPlan({
    fixtures,
    variants: executableVariants,
    runs,
    warmups
  });
  const ownMeasurer = options.resourceMeasurer === undefined;
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ts7-local-project-"));
  let resourceMeasurer = options.resourceMeasurer;
  const grouped = new Map();

  try {
    resourceMeasurer ??= await createResourceMeasurer();
    for (const item of executionPlan) {
      const key = `${item.fixture}\0${item.variant}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          workload: item.fixture,
          variant: item.variant,
          coldRun: null,
          warmupAttempts: [],
          measurementAttempts: [],
          compilerDiagnostics: {}
        });
      }
      const fixture = fixtures.find((candidate) => candidate.name === item.fixture);
      const variant = executableVariants.find(
        (candidate) => candidate.name === item.variant
      );
      const invocationArgs = [
        ...fixture.args,
        ...variant.extraArgs,
        "--pretty",
        "false"
      ];
      if (item.fixture === "typecheck") {
        invocationArgs.push(
          "--tsBuildInfoFile",
          path.join(temporaryRoot, `${item.sequence}.tsbuildinfo`)
        );
      }
      let attempt;
      let rawOutput = "";
      try {
        const outcome = await resourceMeasurer.execute(
          variant.compilerPath,
          invocationArgs,
          { cwd: identity.projectRoot, timeoutMs }
        );
        rawOutput = `${outcome.stdout ?? ""}${outcome.stderr ?? ""}`;
        attempt = attemptFromOutcome(item, outcome);
      } catch (error) {
        attempt = attemptFromError(
          item,
          error,
          resourceMeasurer.capability.collector
        );
      }
      await assertProjectRemainsClean(identity.projectRoot);
      const result = grouped.get(key);
      if (item.phase === "cold") result.coldRun = attempt;
      if (item.phase === "warmup") result.warmupAttempts.push(attempt);
      if (item.phase === "measured") {
        result.measurementAttempts.push(attempt);
        result.compilerDiagnostics = parseExtendedDiagnostics(rawOutput);
      }
    }
  } finally {
    if (ownMeasurer && resourceMeasurer) await resourceMeasurer.dispose();
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  const results = [...grouped.values()].map((result) => {
    const statistics = summarizeAttempts(result.measurementAttempts, runs);
    const attempts = [
      result.coldRun,
      ...result.warmupAttempts,
      ...result.measurementAttempts
    ];
    return {
      ...result,
      status: resultStatus(attempts, statistics),
      statistics
    };
  });
  const compilerVersions = options.compilerVersions ?? {
    ts6: await compilerVersion(compilerPaths.ts6),
    ts7: await compilerVersion(compilerPaths.ts7)
  };
  const labGit = options.labGit ?? await readLabGitMetadata();
  const syntheticRun = options.syntheticRun
    ? validateResultDocument(options.syntheticRun)
    : null;
  if (syntheticRun && syntheticRun.kind !== "benchmark") {
    throw new Error("Synthetic comparison input must be a benchmark result.");
  }
  const value = {
    schemaVersion: LOCAL_PROJECT_SCHEMA_VERSION,
    kind: "local-project-benchmark",
    runId: options.runId ?? randomUUID(),
    generatedAt: (options.now ?? (() => new Date().toISOString()))(),
    project: {
      id: manifest.id,
      name: manifest.name,
      source: manifest.source
    },
    environment: {
      compilers: compilerVersions,
      runtime: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch
      },
      hardware: {
        cpuModel: os.cpus()[0]?.model ?? "unknown",
        logicalCpuCount: os.cpus().length,
        totalMemoryBytes: os.totalmem()
      },
      labGit,
      resourceMeasurement: resourceMeasurer.capability
    },
    configuration: {
      runs,
      warmups,
      coldRuns: 1,
      timeoutMs,
      orderStrategy: ORDER_STRATEGY,
      commands: manifest.commands,
      variants: localProjectVariants,
      executionPlan,
      installPolicy: "recorded-but-never-executed",
      outputPolicy: "sha256-and-byte-count-only",
      syntheticBaseline: syntheticRun
        ? {
            runId: syntheticRun.runId,
            schemaVersion: syntheticRun.schemaVersion
          }
        : null,
      replay: {
        command:
          "npm run project:benchmark -- --manifest <manifest.json> " +
          "--project <project-path>",
        projectPathPolicy: "omitted-from-result"
      }
    },
    results,
    trendComparisons: createTrendComparisons(manifest, results, syntheticRun)
  };
  return validateLocalProjectResultDocument(value);
}

function parseInteger(value, option) {
  const parsed = Number.parseInt(value, 10);
  if (String(parsed) !== value) throw new Error(`${option} must be an integer.`);
  return parsed;
}

export function parseLocalProjectArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--help") return { help: true };
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${name}.`);
    }
    index += 1;
    if (name === "--manifest") options.manifestPath = value;
    else if (name === "--project") options.projectPath = value;
    else if (name === "--synthetic-run") options.syntheticRunPath = value;
    else if (name === "--runs") options.runs = parseInteger(value, name);
    else if (name === "--warmups") options.warmups = parseInteger(value, name);
    else if (name === "--timeout-ms") options.timeoutMs = parseInteger(value, name);
    else throw new Error(`Unknown option: ${name}`);
  }
  if (!options.manifestPath || !options.projectPath) {
    throw new Error("--manifest and --project are required.");
  }
  return options;
}

function printHelp() {
  console.log(`Usage:
  npm run project:benchmark -- --manifest <file> --project <directory>
    [--synthetic-run <benchmark.json>] [--runs <n>] [--warmups <n>]
    [--timeout-ms <ms>]

The install command is recorded but never executed. The supplied project must be a
clean Git checkout whose origin and commit match the manifest.`);
}

async function main() {
  const options = parseLocalProjectArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const manifest = await readLocalProjectManifest(
    path.resolve(root, options.manifestPath)
  );
  const syntheticRun = options.syntheticRunPath
    ? JSON.parse(await readFile(path.resolve(options.syntheticRunPath), "utf8"))
    : null;
  console.log(
    `Install is manual only: ${manifest.commands.install.executable} ` +
    manifest.commands.install.args.join(" ")
  );
  const result = await runLocalProjectBenchmark({
    ...options,
    manifest,
    syntheticRun
  });
  const stored = await resultStore.writeLocalProjectRun(result);
  for (const workload of ["typecheck", "build"]) {
    console.log(`\n[${workload}]`);
    for (const row of result.results.filter((item) => item.workload === workload)) {
      const median = row.statistics.medianMs === null
        ? "no successful samples"
        : `${row.statistics.medianMs.toFixed(1)} ms median`;
      console.log(`  ${row.variant.padEnd(12)} ${median} (${row.status})`);
    }
  }
  console.log(`\nWrote ${path.relative(root, stored.path)}.`);
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
