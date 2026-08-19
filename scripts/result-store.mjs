import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RESULT_STORAGE_VERSION,
  validateLocalProjectResultDocument,
  validateResultDocument,
  validateStorageDocument
} from "./schema.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const runIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const artifactNames = {
  benchmark: "benchmark.json",
  comparison: "comparison.json"
};
const localProjectArtifactName = "local-project.json";

function assertRunId(runId) {
  if (!runIdPattern.test(runId)) {
    throw new Error(`Invalid run ID: ${runId}`);
  }
}

async function fileExists(filename) {
  try {
    await access(filename);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function readJsonFile(filename, description) {
  let source;
  try {
    source = await readFile(filename, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`${description} does not exist: ${filename}`);
    }
    throw error;
  }

  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${description} is not valid JSON: ${filename}`, {
      cause: error
    });
  }
}

async function atomicWriteJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = path.join(
    path.dirname(filename),
    `.${path.basename(filename)}.${process.pid}.${randomUUID()}.tmp`
  );

  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function createResultStore(options = {}) {
  const baseDir = options.baseDir ?? path.join(projectRoot, "results");
  const now = options.now ?? (() => new Date().toISOString());
  const compatibilityMirrors = options.compatibilityMirrors ?? true;
  const runsDir = path.join(baseDir, "runs");
  const latestPath = path.join(baseDir, "latest.json");

  function runDirectory(runId) {
    assertRunId(runId);
    return path.join(runsDir, runId);
  }

  function artifactPath(runId, kind) {
    const artifactName = artifactNames[kind];
    if (!artifactName) throw new Error(`Unknown result kind: ${kind}`);
    return path.join(runDirectory(runId), artifactName);
  }

  function manifestPath(runId) {
    return path.join(runDirectory(runId), "manifest.json");
  }

  async function readManifest(runId) {
    const manifest = await readJsonFile(
      manifestPath(runId),
      `Run manifest for ${runId}`
    );
    validateStorageDocument(manifest);
    if (
      !["run-manifest", "local-project-run-manifest"].includes(manifest.kind) ||
      manifest.runId !== runId
    ) {
      throw new Error(`Run manifest does not match directory ${runId}.`);
    }
    return manifest;
  }

  async function readManifestIfPresent(runId) {
    if (!(await fileExists(manifestPath(runId)))) return null;
    return readManifest(runId);
  }

  async function readRunResult(runId, kind) {
    assertRunId(runId);
    const value = await readJsonFile(
      artifactPath(runId, kind),
      `${kind} result for ${runId}`
    );
    validateResultDocument(value);
    if (value.runId !== runId) {
      throw new Error(`${kind} result runId does not match directory ${runId}.`);
    }
    if (value.kind !== kind) {
      throw new Error(`Expected ${kind} result, received ${value.kind}.`);
    }
    return value;
  }

  async function writeRunResult(value) {
    validateResultDocument(value);
    assertRunId(value.runId);

    const kind = value.kind;
    const filename = artifactPath(value.runId, kind);
    const existingManifest = await readManifestIfPresent(value.runId);
    if (existingManifest?.kind === "local-project-run-manifest") {
      throw new Error(`Run ${value.runId} belongs to a local project benchmark.`);
    }
    if (existingManifest?.status === "complete") {
      throw new Error(`Run ${value.runId} is finalized and cannot be changed.`);
    }
    if (
      existingManifest &&
      !isDeepStrictEqual(existingManifest.metadata, value.metadata)
    ) {
      throw new Error(`Result metadata does not match run ${value.runId}.`);
    }

    const timestamp = now();
    const partialManifest = existingManifest ?? {
      storageVersion: RESULT_STORAGE_VERSION,
      kind: "run-manifest",
      runId: value.runId,
      status: "partial",
      createdAt: value.generatedAt,
      updatedAt: timestamp,
      completedAt: null,
      metadata: value.metadata,
      artifacts: {
        benchmark: null,
        comparison: null
      }
    };
    validateStorageDocument(partialManifest);
    if (!existingManifest) {
      await atomicWriteJson(manifestPath(value.runId), partialManifest);
    }

    if (await fileExists(filename)) {
      if (partialManifest.artifacts[kind] !== null) {
        throw new Error(`${kind} result already exists for run ${value.runId}.`);
      }
      const existingResult = await readRunResult(value.runId, kind);
      if (!isDeepStrictEqual(existingResult, value)) {
        throw new Error(
          `${kind} result recovery content does not match run ${value.runId}.`
        );
      }
    } else {
      await atomicWriteJson(filename, value);
    }

    const manifest = {
      ...partialManifest,
      updatedAt: now(),
      artifacts: {
        ...partialManifest.artifacts,
        [kind]: artifactNames[kind]
      }
    };
    validateStorageDocument(manifest);
    await atomicWriteJson(manifestPath(value.runId), manifest);

    return { path: filename, manifest };
  }

  async function validateRunPair(runId) {
    const [benchmark, comparison] = await Promise.all([
      readRunResult(runId, "benchmark"),
      readRunResult(runId, "comparison")
    ]);
    if (benchmark.schemaVersion !== comparison.schemaVersion) {
      throw new Error(`Result schema versions do not match for run ${runId}.`);
    }
    if (!isDeepStrictEqual(benchmark.metadata, comparison.metadata)) {
      throw new Error(`Result metadata does not match for run ${runId}.`);
    }
    return { benchmark, comparison };
  }

  async function finalizeRun(runId) {
    assertRunId(runId);
    const currentManifest = await readManifest(runId);
    if (currentManifest.kind !== "run-manifest") {
      throw new Error(`Run ${runId} is not a lab benchmark/comparison run.`);
    }
    const { benchmark, comparison } = await validateRunPair(runId);
    const timestamp = now();
    const manifest = {
      ...currentManifest,
      status: "complete",
      updatedAt: timestamp,
      completedAt: currentManifest.completedAt ?? timestamp,
      metadata: benchmark.metadata,
      artifacts: {
        benchmark: artifactNames.benchmark,
        comparison: artifactNames.comparison
      }
    };
    validateStorageDocument(manifest);
    await atomicWriteJson(manifestPath(runId), manifest);

    if (compatibilityMirrors) {
      await atomicWriteJson(
        path.join(baseDir, artifactNames.benchmark),
        benchmark
      );
      await atomicWriteJson(
        path.join(baseDir, artifactNames.comparison),
        comparison
      );
    }

    const latest = {
      storageVersion: RESULT_STORAGE_VERSION,
      kind: "latest-pointer",
      runId,
      manifest: path.posix.join("runs", runId, "manifest.json"),
      updatedAt: timestamp
    };
    validateStorageDocument(latest);
    await atomicWriteJson(latestPath, latest);
    return manifest;
  }

  async function readRun(runId, options = {}) {
    const requireComplete = options.requireComplete ?? true;
    const manifest = await readManifest(runId);
    if (manifest.kind !== "run-manifest") {
      throw new Error(
        `Run ${runId} is a local project run; use readLocalProjectRun().`
      );
    }
    if (requireComplete && manifest.status !== "complete") {
      throw new Error(`Run ${runId} is ${manifest.status}, not complete.`);
    }
    const { benchmark, comparison } = await validateRunPair(runId);
    if (!isDeepStrictEqual(manifest.metadata, benchmark.metadata)) {
      throw new Error(`Run manifest metadata does not match artifacts for ${runId}.`);
    }
    if (
      manifest.artifacts.benchmark !== artifactNames.benchmark ||
      manifest.artifacts.comparison !== artifactNames.comparison
    ) {
      throw new Error(`Run manifest artifact references are incomplete for ${runId}.`);
    }
    return { manifest, benchmark, comparison };
  }

  async function readLocalProjectRun(runId) {
    assertRunId(runId);
    const manifest = await readManifest(runId);
    if (manifest.kind !== "local-project-run-manifest") {
      throw new Error(`Run ${runId} is not a local project run.`);
    }
    if (manifest.status !== "complete" || manifest.artifact !== localProjectArtifactName) {
      throw new Error(`Local project run ${runId} is not complete.`);
    }
    const value = await readJsonFile(
      path.join(runDirectory(runId), localProjectArtifactName),
      `Local project result for ${runId}`
    );
    validateLocalProjectResultDocument(value);
    if (value.runId !== runId) {
      throw new Error(`Local project result runId does not match directory ${runId}.`);
    }
    const expectedProject = {
      id: value.project.id,
      source: value.project.source
    };
    if (!isDeepStrictEqual(manifest.project, expectedProject)) {
      throw new Error(`Local project manifest metadata does not match ${runId}.`);
    }
    return { manifest, result: value };
  }

  async function writeLocalProjectRun(value) {
    validateLocalProjectResultDocument(value);
    assertRunId(value.runId);
    const filename = path.join(
      runDirectory(value.runId),
      localProjectArtifactName
    );
    const existingManifest = await readManifestIfPresent(value.runId);
    if (existingManifest?.status === "complete") {
      throw new Error(`Run ${value.runId} is finalized and cannot be changed.`);
    }
    if (existingManifest?.kind === "run-manifest") {
      throw new Error(`Run ${value.runId} belongs to a lab benchmark/comparison run.`);
    }

    const timestamp = now();
    const project = { id: value.project.id, source: value.project.source };
    const partialManifest = existingManifest ?? {
      storageVersion: RESULT_STORAGE_VERSION,
      kind: "local-project-run-manifest",
      runId: value.runId,
      status: "partial",
      createdAt: value.generatedAt,
      updatedAt: timestamp,
      completedAt: null,
      project,
      artifact: null
    };
    if (!isDeepStrictEqual(partialManifest.project, project)) {
      throw new Error(`Project metadata does not match run ${value.runId}.`);
    }
    validateStorageDocument(partialManifest);
    if (!existingManifest) {
      await atomicWriteJson(manifestPath(value.runId), partialManifest);
    }

    if (await fileExists(filename)) {
      const existing = await readJsonFile(
        filename,
        `Local project result for ${value.runId}`
      );
      validateLocalProjectResultDocument(existing);
      if (!isDeepStrictEqual(existing, value)) {
        throw new Error(
          `Local project result recovery content does not match run ${value.runId}.`
        );
      }
    } else {
      await atomicWriteJson(filename, value);
    }

    const completedAt = now();
    const manifest = {
      ...partialManifest,
      status: "complete",
      updatedAt: completedAt,
      completedAt,
      artifact: localProjectArtifactName
    };
    validateStorageDocument(manifest);
    await atomicWriteJson(manifestPath(value.runId), manifest);
    return { path: filename, manifest };
  }

  async function readLatestPointer() {
    const latest = await readJsonFile(latestPath, "Latest run pointer");
    validateStorageDocument(latest);
    if (latest.kind !== "latest-pointer") {
      throw new Error("Latest run pointer has an unexpected kind.");
    }
    const expectedManifest = path.posix.join(
      "runs",
      latest.runId,
      "manifest.json"
    );
    if (latest.manifest !== expectedManifest) {
      throw new Error(`Latest run pointer does not match run ${latest.runId}.`);
    }
    return latest;
  }

  async function readLatestRun() {
    const latest = await readLatestPointer();
    return readRun(latest.runId, { requireComplete: true });
  }

  async function listRuns(options = {}) {
    const includeIncomplete = options.includeIncomplete ?? true;
    let entries;
    try {
      entries = await readdir(runsDir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }

    const runs = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const runId = entry.name;
          if (!runIdPattern.test(runId)) {
            return {
              runId,
              status: "invalid",
              error: "Directory name is not a valid run ID."
            };
          }
          try {
            return await readManifest(runId);
          } catch (error) {
            return { runId, status: "invalid", error: error.message };
          }
        })
    );

    return runs
      .filter((run) => includeIncomplete || run.status === "complete")
      .sort((left, right) => {
        const leftTime = left.completedAt ?? left.updatedAt ?? left.createdAt ?? "";
        const rightTime = right.completedAt ?? right.updatedAt ?? right.createdAt ?? "";
        return rightTime.localeCompare(leftTime) || right.runId.localeCompare(left.runId);
      });
  }

  return {
    baseDir,
    finalizeRun,
    listRuns,
    readLatestPointer,
    readLatestRun,
    readLocalProjectRun,
    readRun,
    readRunResult,
    validateRunPair,
    writeLocalProjectRun,
    writeRunResult
  };
}

export const resultStore = createResultStore();
