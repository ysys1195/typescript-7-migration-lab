import assert from "node:assert/strict";
import test from "node:test";
import {
  parseDashboardArguments,
  startDashboardServer
} from "../scripts/dashboard-server.mjs";
import {
  createComparisonResult,
  createCurrentBenchmarkResult,
  defaultRunId
} from "./helpers/result-documents.mjs";

const targetRunId = "223e4567-e89b-42d3-b456-426614174001";

function run(runId, completedAt) {
  const benchmark = createCurrentBenchmarkResult({ runId });
  const comparison = createComparisonResult({ runId });
  return {
    manifest: {
      storageVersion: "1.0.0",
      kind: "run-manifest",
      runId,
      status: "complete",
      createdAt: benchmark.generatedAt,
      updatedAt: completedAt,
      completedAt,
      metadata: benchmark.metadata,
      artifacts: {
        benchmark: "benchmark.json",
        comparison: "comparison.json"
      }
    },
    benchmark,
    comparison
  };
}

function fakeStore() {
  const baseline = run(defaultRunId, "2026-08-12T12:00:00.000Z");
  const target = run(targetRunId, "2026-08-12T13:00:00.000Z");
  const runs = new Map([
    [defaultRunId, baseline],
    [targetRunId, target]
  ]);
  return {
    async listRuns() {
      return [target.manifest, baseline.manifest];
    },
    async readLatestPointer() {
      return {
        storageVersion: "1.0.0",
        kind: "latest-pointer",
        runId: targetRunId,
        manifest: `runs/${targetRunId}/manifest.json`,
        updatedAt: target.manifest.completedAt
      };
    },
    async readLatestRun() {
      return target;
    },
    async readRun(runId) {
      const value = runs.get(runId);
      if (!value) throw new Error(`Run ${runId} does not exist.`);
      return value;
    }
  };
}

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) =>
    error ? reject(error) : resolve()
  ));
}

test("dashboard arguments keep the server on loopback and validate ports", () => {
  assert.deepEqual(parseDashboardArguments([], {}), {
    host: "127.0.0.1",
    port: 4173
  });
  assert.deepEqual(parseDashboardArguments(["--port", "5000"], {}), {
    host: "127.0.0.1",
    port: 5000
  });
  assert.throws(
    () => parseDashboardArguments(["--host", "0.0.0.0"], {}),
    /Usage/
  );
  assert.throws(
    () => parseDashboardArguments(["--port", "invalid"], {}),
    /integer/
  );
});

test("dashboard serves only static assets and versioned read-only APIs", async (t) => {
  const server = await startDashboardServer({
    host: "127.0.0.1",
    port: 0,
    store: fakeStore(),
    now: () => "2026-08-12T14:00:00.000Z"
  });
  t.after(() => closeServer(server));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
  const html = await page.text();
  assert.match(html, /<title>TypeScript 7 Migration Lab<\/title>/);
  assert.match(html, /data-view-panel="performance"/);
  assert.match(html, /data-view-panel="environment"/);

  const latest = await fetch(`${baseUrl}/api/latest`).then((response) =>
    response.json()
  );
  assert.equal(latest.kind, "latest-pointer");
  assert.equal(latest.runId, targetRunId);

  const manifests = await fetch(`${baseUrl}/api/runs`).then((response) =>
    response.json()
  );
  assert.equal(manifests.length, 2);
  assert.equal(manifests.every((manifest) => manifest.storageVersion === "1.0.0"), true);

  const documents = await fetch(`${baseUrl}/api/run/${defaultRunId}`).then(
    (response) => response.json()
  );
  assert.deepEqual(
    documents.map((document) => document.kind),
    ["run-manifest", "benchmark", "comparison"]
  );
  assert.equal(documents[1].schemaVersion, "4.2.0");

  const comparisonUrl = new URL("/api/compare", baseUrl);
  comparisonUrl.searchParams.set("baseline", defaultRunId);
  comparisonUrl.searchParams.set("target", targetRunId);
  comparisonUrl.searchParams.set("threshold", "5");
  const comparison = await fetch(comparisonUrl).then((response) =>
    response.json()
  );
  assert.equal(comparison.kind, "run-comparison");
  assert.equal(comparison.schemaVersion, "1.0.0");
  assert.equal(comparison.thresholdPercent, 5);

  const rejectedWrite = await fetch(`${baseUrl}/api/runs`, { method: "POST" });
  assert.equal(rejectedWrite.status, 405);
  assert.match((await rejectedWrite.json()).error, /Read-only/);

  assert.equal((await fetch(`${baseUrl}/package.json`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/run/not-a-run`)).status, 404);
  assert.equal((await fetch(
    `${baseUrl}/api/compare?baseline=${defaultRunId}&threshold=invalid`
  )).status, 400);

  const head = await fetch(`${baseUrl}/app.js`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});
