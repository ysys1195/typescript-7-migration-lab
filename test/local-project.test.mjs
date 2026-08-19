import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createTrendComparisons,
  parseLocalProjectArguments,
  runLocalProjectBenchmark,
  validateReadOnlyManifest
} from "../scripts/local-project.mjs";
import { createResultStore } from "../scripts/result-store.mjs";
import { unavailableResourceUsage } from "../scripts/resource-measurement.mjs";

const runId = "123e4567-e89b-42d3-a456-426614174000";
const timestamp = "2026-08-20T00:00:00.000Z";
const sourceUrl = "https://github.com/example/read-only-project";
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function createManifest(commit) {
  return {
    schemaVersion: "1.0.0",
    kind: "local-project-manifest",
    id: "read-only-project",
    name: "Read-only project",
    source: { url: sourceUrl, license: "MIT", commit },
    commands: {
      install: {
        executable: "npm",
        args: ["ci", "--ignore-scripts"],
        execution: "manual-only"
      },
      typecheck: {
        args: ["--project", "tsconfig.json", "--noEmit", "--extendedDiagnostics"]
      },
      build: {
        args: ["--build", "tsconfig.json", "--dry", "--extendedDiagnostics"]
      }
    },
    syntheticComparisons: [
      {
        workload: "typecheck",
        fixture: "type-heavy",
        rationale: "Both inputs exercise type checking."
      },
      {
        workload: "build",
        fixture: "project-references-dag",
        rationale: "Both inputs use build mode."
      }
    ]
  };
}

async function createProject(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ts7-local-project-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    path.join(directory, "tsconfig.json"),
    `${JSON.stringify({ compilerOptions: { strict: true }, files: ["index.ts"] })}\n`
  );
  await writeFile(path.join(directory, "index.ts"), "export const value = 1;\n");
  git(directory, ["init"]);
  git(directory, ["config", "user.name", "Local Project Test"]);
  git(directory, ["config", "user.email", "test@example.com"]);
  git(directory, ["add", "."]);
  git(directory, ["commit", "-m", "fixture"]);
  git(directory, ["remote", "add", "origin", `${sourceUrl}.git`]);
  return { directory, commit: git(directory, ["rev-parse", "HEAD"]) };
}

function fakeResourceMeasurer(options = {}) {
  const capability = {
    collector: "direct-spawn",
    scope: "timed-process",
    cpuTime: { status: "unavailable", reason: "test" },
    peakRss: { status: "unavailable", reason: "test" }
  };
  return {
    capability,
    execute: async (command, args, runOptions) => {
      if (options.mutate) {
        await writeFile(path.join(runOptions.cwd, "generated.txt"), "changed\n");
      }
      const single = args.includes("--singleThreaded");
      const elapsedMs = command === "fake-ts6" ? 30 : single ? 15 : 10;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        elapsedMs,
        stdout: "TOP_SECRET_OUTPUT\nTotal time: 0.01s\n",
        stderr: "",
        resourceUsage: unavailableResourceUsage("test", "direct-spawn")
      };
    },
    dispose: async () => {}
  };
}

async function runFixture(t, options = {}) {
  const project = await createProject(t);
  const manifest = createManifest(project.commit);
  const result = await runLocalProjectBenchmark({
    manifest,
    projectPath: project.directory,
    runs: 1,
    warmups: 0,
    timeoutMs: 1_000,
    compilers: { ts6: "fake-ts6", ts7: "fake-ts7" },
    compilerVersions: { ts6: "6.0.3", ts7: "7.0.2" },
    resourceMeasurer: fakeResourceMeasurer(options),
    runId,
    now: () => timestamp
  });
  return { ...project, manifest, result };
}

test("local project manifest requires read-only compiler commands", () => {
  const valid = createManifest("a".repeat(40));
  assert.equal(validateReadOnlyManifest(valid), valid);

  const emitting = structuredClone(valid);
  emitting.commands.typecheck.args = ["--project", "tsconfig.json"];
  assert.throws(() => validateReadOnlyManifest(emitting), /--noEmit/);

  const explicitlyEmitting = structuredClone(valid);
  explicitlyEmitting.commands.typecheck.args = [
    "--project",
    "tsconfig.json",
    "--noEmit",
    "false",
    "--extendedDiagnostics"
  ];
  assert.throws(() => validateReadOnlyManifest(explicitlyEmitting), /--noEmit/);

  const writingBuild = structuredClone(valid);
  writingBuild.commands.build.args = ["--build", "tsconfig.json"];
  assert.throws(() => validateReadOnlyManifest(writingBuild), /--dry/);

  const escaped = structuredClone(valid);
  escaped.commands.typecheck.args[1] = "../outside/tsconfig.json";
  assert.throws(() => validateReadOnlyManifest(escaped), /project root/);

  const escapedWithEquals = structuredClone(valid);
  escapedWithEquals.commands.typecheck.args = [
    "--project=../outside/tsconfig.json",
    "--noEmit",
    "--extendedDiagnostics"
  ];
  assert.throws(() => validateReadOnlyManifest(escapedWithEquals), /project root/);

  const caseVariantOutput = structuredClone(valid);
  caseVariantOutput.commands.typecheck.args.push("--outdir=generated");
  assert.throws(() => validateReadOnlyManifest(caseVariantOutput), /output paths/);
});

test("the Vite example pins source, license, commit, and all commands", async () => {
  const manifest = JSON.parse(await readFile(
    path.join(projectRoot, "local-projects", "vite-6.4.3.json"),
    "utf8"
  ));
  assert.equal(validateReadOnlyManifest(manifest), manifest);
  assert.deepEqual(manifest.source, {
    url: "https://github.com/vitejs/vite",
    license: "MIT",
    commit: "6c2c881f15495738ff03bc1d67cc052c07e0cac4"
  });
  assert.deepEqual(Object.keys(manifest.commands), ["install", "typecheck", "build"]);
});

test("adapter records statistics without project paths, secrets, or raw output", async (t) => {
  const { directory, result } = await runFixture(t);
  assert.equal(result.results.length, 6);
  assert.deepEqual(
    result.results.filter((row) => row.workload === "typecheck")
      .map((row) => [row.variant, row.statistics.medianMs]),
    [["ts6", 30], ["ts7-single", 15], ["ts7-default", 10]]
  );
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(directory), false);
  assert.equal(serialized.includes("TOP_SECRET_OUTPUT"), false);
  assert.equal(serialized.includes("stdout"), true);
  assert.match(
    result.results[0].coldRun.output.stdout.sha256,
    /^[0-9a-f]{64}$/
  );
  assert.equal(result.configuration.installPolicy, "recorded-but-never-executed");
});

test("adapter rejects dirty projects and stops if a command writes", async (t) => {
  const dirty = await createProject(t);
  const dirtyManifest = createManifest(dirty.commit);
  await writeFile(path.join(dirty.directory, "untracked.txt"), "dirty\n");
  await assert.rejects(
    runLocalProjectBenchmark({
      manifest: dirtyManifest,
      projectPath: dirty.directory,
      runs: 1,
      warmups: 0,
      timeoutMs: 1_000,
      compilers: { ts6: "fake-ts6", ts7: "fake-ts7" },
      compilerVersions: { ts6: "6.0.3", ts7: "7.0.2" },
      resourceMeasurer: fakeResourceMeasurer()
    }),
    /clean working tree/
  );

  const changed = await createProject(t);
  await assert.rejects(
    runLocalProjectBenchmark({
      manifest: createManifest(changed.commit),
      projectPath: changed.directory,
      runs: 1,
      warmups: 0,
      timeoutMs: 1_000,
      compilers: { ts6: "fake-ts6", ts7: "fake-ts7" },
      compilerVersions: { ts6: "6.0.3", ts7: "7.0.2" },
      resourceMeasurer: fakeResourceMeasurer({ mutate: true })
    }),
    /changed the local project/
  );
});

test("project speedups can be compared with synthetic fixture trends", async (t) => {
  const { manifest, result } = await runFixture(t);
  const syntheticResults = result.results.map((row) => ({
    ...row,
    fixture: row.workload === "typecheck"
      ? "type-heavy"
      : "project-references-dag"
  }));
  const comparisons = createTrendComparisons(
    manifest,
    result.results,
    { results: syntheticResults }
  );
  assert.deepEqual(
    comparisons.map(({ status, alignment }) => ({ status, alignment })),
    [
      { status: "compared", alignment: "aligned" },
      { status: "compared", alignment: "aligned" }
    ]
  );
});

test("local project results coexist in the canonical run directory", async (t) => {
  const { result } = await runFixture(t);
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "ts7-local-store-test-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  let tick = 0;
  const store = createResultStore({
    baseDir,
    compatibilityMirrors: false,
    now: () => `2026-08-20T00:00:0${tick++}.000Z`
  });
  const stored = await store.writeLocalProjectRun(result);
  assert.equal(path.basename(stored.path), "local-project.json");
  assert.deepEqual((await store.readLocalProjectRun(runId)).result, result);
  assert.deepEqual(
    (await store.listRuns()).map(({ kind, status }) => ({ kind, status })),
    [{ kind: "local-project-run-manifest", status: "complete" }]
  );
});

test("local project CLI requires explicit manifest and project paths", () => {
  assert.deepEqual(
    parseLocalProjectArguments([
      "--manifest",
      "project.json",
      "--project",
      "/tmp/project",
      "--runs",
      "3",
      "--warmups",
      "1"
    ]),
    {
      manifestPath: "project.json",
      projectPath: "/tmp/project",
      runs: 3,
      warmups: 1
    }
  );
  assert.throws(() => parseLocalProjectArguments([]), /required/);
});
