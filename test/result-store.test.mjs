import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createResultStore } from "../scripts/result-store.mjs";
import {
  createComparisonResult,
  createScalingBenchmarkResult,
  defaultMetadata,
  defaultRunId
} from "./helpers/result-documents.mjs";

const secondRunId = "223e4567-e89b-42d3-b456-426614174001";

function createCurrentBenchmarkResult(overrides = {}) {
  return {
    ...createScalingBenchmarkResult(),
    schemaVersion: "4.0.0",
    ...overrides
  };
}

async function createTestStore(t, options = {}) {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "ts7-result-store-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  let tick = 0;
  return {
    baseDir,
    store: createResultStore({
      baseDir,
      compatibilityMirrors: options.compatibilityMirrors ?? false,
      now: () => `2026-08-02T00:00:0${tick++}.000Z`
    })
  };
}

async function writeCompleteRun(store, runId) {
  await store.writeRunResult(createCurrentBenchmarkResult({ runId }));
  await store.writeRunResult(createComparisonResult({ runId }));
  await store.finalizeRun(runId);
}

test("multiple runs coexist and latest changes only after finalize", async (t) => {
  const { store } = await createTestStore(t);
  await writeCompleteRun(store, defaultRunId);

  await store.writeRunResult(createCurrentBenchmarkResult({ runId: secondRunId }));
  assert.equal((await store.readLatestPointer()).runId, defaultRunId);

  const partialRuns = await store.listRuns();
  assert.deepEqual(
    partialRuns.map(({ runId, status }) => ({ runId, status })),
    [
      { runId: secondRunId, status: "partial" },
      { runId: defaultRunId, status: "complete" }
    ]
  );

  await store.writeRunResult(createComparisonResult({ runId: secondRunId }));
  await store.finalizeRun(secondRunId);

  assert.equal((await store.readLatestPointer()).runId, secondRunId);
  assert.equal((await store.readLatestRun()).benchmark.runId, secondRunId);
  assert.equal((await store.readRun(defaultRunId)).benchmark.runId, defaultRunId);
});

test("partial or mismatched runs do not replace latest", async (t) => {
  const { store } = await createTestStore(t);
  await writeCompleteRun(store, defaultRunId);
  await store.writeRunResult(createCurrentBenchmarkResult({ runId: secondRunId }));

  const changedMetadata = structuredClone(defaultMetadata);
  changedMetadata.compilers.ts7.version = "7.0.3";
  await assert.rejects(
    store.writeRunResult(createComparisonResult({
      runId: secondRunId,
      metadata: changedMetadata
    })),
    /metadata does not match/
  );
  await assert.rejects(store.finalizeRun(secondRunId), /does not exist/);
  assert.equal((await store.readLatestPointer()).runId, defaultRunId);
});

test("finalized artifacts cannot be overwritten", async (t) => {
  const { store } = await createTestStore(t);
  await writeCompleteRun(store, defaultRunId);
  await assert.rejects(
    store.writeRunResult(createCurrentBenchmarkResult()),
    /finalized and cannot be changed/
  );
});

test("invalid run IDs are rejected before path construction", async (t) => {
  const { store } = await createTestStore(t);
  const invalid = createCurrentBenchmarkResult({ runId: "../outside" });
  await assert.rejects(
    store.writeRunResult(invalid),
    /Result schema validation failed|Invalid run ID/
  );
  await assert.rejects(store.readRun("../outside"), /Invalid run ID/);
});

test("dangling latest pointer produces a clear error", async (t) => {
  const { baseDir, store } = await createTestStore(t);
  await writeFile(path.join(baseDir, "latest.json"), `${JSON.stringify({
    storageVersion: "1.0.0",
    kind: "latest-pointer",
    runId: defaultRunId,
    manifest: `runs/${defaultRunId}/manifest.json`,
    updatedAt: "2026-08-02T00:00:00.000Z"
  })}\n`);

  await assert.rejects(store.readLatestRun(), /manifest.*does not exist/i);
});

test("run listing surfaces invalid directories", async (t) => {
  const { baseDir, store } = await createTestStore(t);
  await mkdir(path.join(baseDir, "runs", "not-a-run-id"), { recursive: true });
  const runs = await store.listRuns();
  assert.deepEqual(runs, [{
    runId: "not-a-run-id",
    status: "invalid",
    error: "Directory name is not a valid run ID."
  }]);
});

test("compatibility mirrors move only when a run is finalized", async (t) => {
  const { baseDir, store } = await createTestStore(t, {
    compatibilityMirrors: true
  });
  await writeCompleteRun(store, defaultRunId);

  await store.writeRunResult(createCurrentBenchmarkResult({ runId: secondRunId }));
  const partialMirror = JSON.parse(
    await readFile(path.join(baseDir, "benchmark.json"), "utf8")
  );
  assert.equal(partialMirror.runId, defaultRunId);

  await store.writeRunResult(createComparisonResult({ runId: secondRunId }));
  await store.finalizeRun(secondRunId);
  const [benchmarkMirror, comparisonMirror] = await Promise.all([
    readFile(path.join(baseDir, "benchmark.json"), "utf8").then(JSON.parse),
    readFile(path.join(baseDir, "comparison.json"), "utf8").then(JSON.parse)
  ]);
  assert.equal(benchmarkMirror.runId, secondRunId);
  assert.equal(comparisonMirror.runId, secondRunId);
});

test("an artifact published before its manifest update can be recovered", async (t) => {
  const { baseDir, store } = await createTestStore(t);
  const benchmark = createCurrentBenchmarkResult();
  const runDir = path.join(baseDir, "runs", defaultRunId);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "manifest.json"), `${JSON.stringify({
    storageVersion: "1.0.0",
    kind: "run-manifest",
    runId: defaultRunId,
    status: "partial",
    createdAt: benchmark.generatedAt,
    updatedAt: "2026-08-02T00:00:00.000Z",
    completedAt: null,
    metadata: benchmark.metadata,
    artifacts: { benchmark: null, comparison: null }
  })}\n`);
  await writeFile(
    path.join(runDir, "benchmark.json"),
    `${JSON.stringify(benchmark)}\n`
  );

  await store.writeRunResult(benchmark);
  const manifest = JSON.parse(
    await readFile(path.join(runDir, "manifest.json"), "utf8")
  );
  assert.equal(manifest.artifacts.benchmark, "benchmark.json");
});

test("readRun rejects manifest metadata that differs from artifacts", async (t) => {
  const { baseDir, store } = await createTestStore(t);
  await writeCompleteRun(store, defaultRunId);
  const filename = path.join(baseDir, "runs", defaultRunId, "manifest.json");
  const manifest = JSON.parse(await readFile(filename, "utf8"));
  manifest.metadata.compilers.ts7.version = "7.0.999";
  await writeFile(filename, `${JSON.stringify(manifest)}\n`);

  await assert.rejects(store.readRun(defaultRunId), /metadata does not match/);
});
