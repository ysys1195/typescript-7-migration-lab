import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildExecutionPlan,
  detectOutliers,
  executeBenchmarkPlan,
  mean,
  populationStandardDeviation,
  summarizeAttempts,
  summarizeResourceUsage
} from "../scripts/benchmark-core.mjs";
import { run } from "../scripts/lib.mjs";

const fixtures = [
  { name: "first", args: ["--first"] },
  { name: "second", args: ["--second"] }
];
const variants = [
  { name: "ts6", compiler: "ts6", extraArgs: [] },
  { name: "ts7-single", compiler: "ts7", extraArgs: ["--singleThreaded"] },
  { name: "ts7-default", compiler: "ts7", extraArgs: [] }
];

test("mean and population standard deviation use all samples", () => {
  assert.equal(mean([1, 2, 3]), 2);
  assert.equal(populationStandardDeviation([1]), 0);
  assert.ok(Math.abs(populationStandardDeviation([1, 2, 3]) - 0.81649658) < 1e-8);
});

test("outlier candidates use the 1.5 IQR rule without removing samples", () => {
  const samples = [10, 10, 11, 100].map((elapsedMs, round) => ({
    elapsedMs,
    round
  }));
  const outliers = detectOutliers(samples);
  assert.equal(outliers.length, 1);
  assert.equal(outliers[0].sampleIndex, 3);
  assert.equal(outliers[0].elapsedMs, 100);
  assert.deepEqual(samples.map(({ elapsedMs }) => elapsedMs), [10, 10, 11, 100]);
});

test("zero successful measurements produce nullable statistics", () => {
  const statistics = summarizeAttempts([
    { status: "timeout", elapsedMs: 100, round: 0 }
  ], 1);
  assert.equal(statistics.successfulSamples, 0);
  assert.equal(statistics.failedSamples, 1);
  assert.equal(statistics.meanMs, null);
  assert.equal(statistics.medianMs, null);
});

test("resource statistics use successful measured attempts and preserve coverage", () => {
  const available = {
    status: "success",
    resourceUsage: {
      cpuTime: { status: "available", totalMs: 20 },
      peakRss: { status: "available", bytes: 1_024 }
    }
  };
  const partial = {
    status: "success",
    resourceUsage: {
      cpuTime: { status: "available", totalMs: 30 },
      peakRss: { status: "unavailable", reason: "missing" }
    }
  };
  const failed = {
    status: "compiler-error",
    resourceUsage: {
      cpuTime: { status: "available", totalMs: 999 },
      peakRss: { status: "available", bytes: 999_999 }
    }
  };
  const statistics = summarizeResourceUsage([available, partial, failed]);
  assert.deepEqual(statistics.cpuTimeMs.samples, [20, 30]);
  assert.equal(statistics.cpuTimeMs.availableSamples, 2);
  assert.equal(statistics.cpuTimeMs.unavailableSamples, 0);
  assert.deepEqual(statistics.peakRssBytes.samples, [1_024]);
  assert.equal(statistics.peakRssBytes.availableSamples, 1);
  assert.equal(statistics.peakRssBytes.unavailableSamples, 1);
});

test("execution plan rotates variant order and is deterministic", () => {
  const first = buildExecutionPlan({ fixtures, variants, warmups: 1, runs: 3 });
  const second = buildExecutionPlan({ fixtures, variants, warmups: 1, runs: 3 });
  assert.deepEqual(first, second);

  const measuredFirst = first.filter(
    (item) => item.fixture === "first" && item.phase === "measured"
  );
  const leaders = [0, 1, 2].map((round) =>
    measuredFirst.find((item) => item.round === round).variant
  );
  assert.deepEqual(leaders, ["ts7-default", "ts6", "ts7-single"]);
  for (let round = 0; round < 3; round += 1) {
    assert.deepEqual(
      new Set(measuredFirst.filter((item) => item.round === round).map(
        (item) => item.variant
      )),
      new Set(variants.map((variant) => variant.name))
    );
  }
});

test("cold and warmup attempts are excluded and failures do not stop the plan", async () => {
  const oneFixture = [fixtures[0]];
  const twoVariants = variants.slice(0, 2);
  const executionPlan = buildExecutionPlan({
    fixtures: oneFixture,
    variants: twoVariants,
    warmups: 1,
    runs: 2
  });
  const visited = [];
  const outcomes = new Map([
    [0, { exitCode: 0, elapsedMs: 100 }],
    [1, { exitCode: 0, elapsedMs: 200 }],
    [2, { exitCode: 0, elapsedMs: 300 }],
    [3, { exitCode: 0, elapsedMs: 400 }],
    [4, { exitCode: 1, elapsedMs: 500, stderr: "failed" }],
    [5, { exitCode: 0, elapsedMs: 10 }],
    [6, { exitCode: 0, elapsedMs: 20 }],
    [7, { exitCode: 0, elapsedMs: 30 }]
  ]);
  let call = 0;
  const results = await executeBenchmarkPlan({
    executionPlan,
    fixtures: oneFixture,
    variants: twoVariants,
    runs: 2,
    timeoutMs: 1000,
    execute: async (command, args, options) => {
      visited.push({ command, args, options });
      const outcome = outcomes.get(call++);
      return {
        timedOut: false,
        signal: null,
        stdout: "Files: 1",
        stderr: "",
        ...outcome
      };
    },
    parseDiagnostics: () => ({ Files: { value: 1, unit: "" } })
  });

  assert.equal(visited.length, executionPlan.length);
  const first = results.find((result) => result.variant === "ts6");
  assert.notEqual(first.statistics.samplesMs[0], 100);
  assert.notEqual(first.statistics.samplesMs[0], 300);
  assert.equal(results.some((result) => result.status === "partial"), true);
  assert.equal(
    results.flatMap((result) => result.measurementAttempts)
      .some((attempt) => attempt.stderr === "failed"),
    true
  );
});

test("run marks a hanging process as timed out", async () => {
  const result = await run(
    process.execPath,
    ["-e", "setTimeout(() => {}, 10000)"],
    { timeoutMs: 100 }
  );
  assert.equal(result.timedOut, true);
  assert.ok(result.signal === "SIGTERM" || result.signal === "SIGKILL");
});

test("process-group timeout kills a descendant that ignores SIGTERM", {
  skip: process.platform === "win32"
}, async (t) => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "ts7-process-group-test-")
  );
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const markerPath = path.join(temporaryDirectory, "descendant-survived");
  const descendantScript = `
    const { writeFileSync } = require("node:fs");
    process.on("SIGTERM", () => {});
    setTimeout(() => writeFileSync(${JSON.stringify(markerPath)}, "alive"), 1300);
    setInterval(() => {}, 1000);
  `;
  const script = `
    const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { stdio: "ignore" });
    process.on("SIGTERM", () => process.exit(0));
    setInterval(() => {}, 1000);
  `;
  const started = Date.now();
  const result = await run(process.execPath, ["-e", script], {
    timeoutMs: 100,
    killProcessGroup: true
  });
  const waitedMs = Date.now() - started;
  assert.equal(result.timedOut, true);
  assert.ok(waitedMs >= 1_000);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await assert.rejects(access(markerPath), { code: "ENOENT" });
});

test("timeout and runner errors are recorded while later attempts continue", async () => {
  const oneFixture = [fixtures[0]];
  const twoVariants = variants.slice(0, 2);
  const executionPlan = buildExecutionPlan({
    fixtures: oneFixture,
    variants: twoVariants,
    warmups: 0,
    runs: 1
  });
  let call = 0;
  const results = await executeBenchmarkPlan({
    executionPlan,
    fixtures: oneFixture,
    variants: twoVariants,
    runs: 1,
    timeoutMs: 100,
    execute: async () => {
      call += 1;
      if (call === 1) {
        return {
          timedOut: true,
          exitCode: null,
          signal: "SIGTERM",
          elapsedMs: 100,
          stdout: "partial",
          stderr: ""
        };
      }
      if (call === 3) throw new Error("spawn failed");
      return {
        timedOut: false,
        exitCode: 0,
        signal: null,
        elapsedMs: 10,
        stdout: "Files: 1",
        stderr: ""
      };
    },
    parseDiagnostics: () => ({}),
    runnerErrorResourceUsage: {
      collector: "darwin-time-l",
      scope: "timed-process",
      cpuTime: { status: "unavailable", reason: "runner-error" },
      peakRss: { status: "unavailable", reason: "runner-error" }
    }
  });

  assert.equal(call, executionPlan.length);
  const attempts = results.flatMap((result) => [
    result.coldRun,
    ...result.measurementAttempts
  ]);
  assert.equal(attempts.some((attempt) => attempt.status === "timeout"), true);
  assert.equal(
    attempts.find((attempt) => attempt.status === "timeout")
      .resourceUsage.cpuTime.reason,
    "attempt-timeout"
  );
  assert.equal(
    attempts.some((attempt) =>
      attempt.status === "runner-error" && attempt.error === "spawn failed"
    ),
    true
  );
  assert.equal(
    attempts.find((attempt) => attempt.status === "runner-error")
      .resourceUsage.peakRss.reason,
    "runner-error"
  );
  assert.equal(
    attempts.find((attempt) => attempt.status === "runner-error")
      .resourceUsage.collector,
    "darwin-time-l"
  );
  assert.equal(
    attempts.toSorted((left, right) => left.sequence - right.sequence).at(-1).status,
    "success"
  );
  assert.equal(results.some((result) => result.status === "failed"), true);
});

test("signal termination is recorded as a compiler error", async () => {
  const oneFixture = [fixtures[0]];
  const oneVariant = variants.slice(0, 1);
  const executionPlan = buildExecutionPlan({
    fixtures: oneFixture,
    variants: oneVariant,
    warmups: 0,
    runs: 1
  });
  const results = await executeBenchmarkPlan({
    executionPlan,
    fixtures: oneFixture,
    variants: oneVariant,
    runs: 1,
    timeoutMs: 1000,
    execute: async () => ({
      timedOut: false,
      exitCode: null,
      signal: "SIGSEGV",
      elapsedMs: 5,
      stdout: "",
      stderr: "compiler crashed"
    }),
    parseDiagnostics: () => ({})
  });
  assert.equal(results[0].measurementAttempts[0].status, "compiler-error");
  assert.equal(results[0].measurementAttempts[0].signal, "SIGSEGV");
});
