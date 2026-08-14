import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createResourceMeasurer,
  parseDarwinTimeOutput,
  parseGnuTimeOutput
} from "../scripts/resource-measurement.mjs";

test("Darwin time output preserves RSS bytes and converts CPU seconds", () => {
  const usage = parseDarwinTimeOutput(`real 0.30
user 0.20
sys 0.05
  73400320  maximum resident set size
`);
  assert.deepEqual(usage.cpuTime, {
    status: "available",
    userMs: 200,
    systemMs: 50,
    totalMs: 250
  });
  assert.deepEqual(usage.peakRss, {
    status: "available",
    bytes: 73_400_320
  });
});

test("GNU time output converts peak RSS from KiB to bytes", () => {
  const usage = parseGnuTimeOutput(`User time (seconds): 0.12
System time (seconds): 0.03
Maximum resident set size (kbytes): 1234
`);
  assert.equal(usage.cpuTime.totalMs, 150);
  assert.equal(usage.peakRss.bytes, 1_263_616);
});

test("missing metrics are unavailable instead of being replaced with zero", () => {
  const usage = parseDarwinTimeOutput("user 0.00\nsys 0.00\n");
  assert.equal(usage.cpuTime.status, "available");
  assert.equal(usage.cpuTime.totalMs, 0);
  assert.deepEqual(usage.peakRss, {
    status: "unavailable",
    reason: "collector-output-invalid"
  });
});

test("an explicit zero RSS is unavailable while explicit zero CPU remains valid", () => {
  const usage = parseDarwinTimeOutput(`user 0.00
sys 0.00
  0  maximum resident set size
`);
  assert.equal(usage.cpuTime.status, "available");
  assert.equal(usage.cpuTime.totalMs, 0);
  assert.equal(usage.peakRss.status, "unavailable");
});

test("unsupported platforms run the command directly and record unavailable", async () => {
  const calls = [];
  const measurer = await createResourceMeasurer({
    platform: "win32",
    executeCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        elapsedMs: 1,
        stdout: "ok",
        stderr: ""
      };
    }
  });
  const outcome = await measurer.execute("compiler", ["--version"], {
    timeoutMs: 1000
  });
  assert.equal(calls[0].command, "compiler");
  assert.equal(outcome.resourceUsage.cpuTime.status, "unavailable");
  assert.equal(
    outcome.resourceUsage.cpuTime.reason,
    "unsupported-platform"
  );
});

test("successful probe wraps commands, isolates output, and forces C locale", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ts7-resource-test-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const calls = [];
  const executeCommand = async (command, args, options) => {
    calls.push({ command, args, options });
    const outputPath = args[args.indexOf("-o") + 1];
    await writeFile(outputPath, `real 0.03
user 0.02
sys 0.01
  4096  maximum resident set size
`);
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      elapsedMs: 30,
      stdout: "compiler stdout",
      stderr: "compiler stderr"
    };
  };
  const measurer = await createResourceMeasurer({
    platform: "darwin",
    timeCommand: process.execPath,
    executeCommand,
    temporaryRoot
  });
  t.after(() => measurer.dispose());
  const outcome = await measurer.execute("compiler", ["--check"], {
    timeoutMs: 1000
  });

  assert.equal(measurer.capability.cpuTime.status, "available");
  assert.equal(calls.at(-1).command, process.execPath);
  assert.equal(calls.at(-1).options.env.LC_ALL, "C");
  assert.equal(calls.at(-1).options.killProcessGroup, true);
  assert.equal(outcome.stdout, "compiler stdout");
  assert.equal(outcome.resourceUsage.cpuTime.totalMs, 30);
  assert.equal(outcome.resourceUsage.peakRss.bytes, 4096);
});

test("probe capability keeps an independently available CPU metric", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ts7-resource-test-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const measurer = await createResourceMeasurer({
    platform: "darwin",
    timeCommand: process.execPath,
    temporaryRoot,
    executeCommand: async (command, args) => {
      const outputPath = args[args.indexOf("-o") + 1];
      await writeFile(outputPath, "user 0.01\nsys 0.01\n");
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        elapsedMs: 20,
        stdout: "",
        stderr: ""
      };
    }
  });
  t.after(() => measurer.dispose());
  assert.equal(measurer.capability.cpuTime.status, "available");
  assert.equal(measurer.capability.peakRss.status, "unavailable");
  const outcome = await measurer.execute("compiler", []);
  assert.equal(outcome.resourceUsage.cpuTime.status, "available");
  assert.equal(outcome.resourceUsage.peakRss.status, "unavailable");
});

test("Darwin falls back to CPU-only time when RSS collection makes probe fail", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ts7-resource-test-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const calls = [];
  const measurer = await createResourceMeasurer({
    platform: "darwin",
    timeCommand: process.execPath,
    temporaryRoot,
    executeCommand: async (command, args) => {
      calls.push(args);
      const outputPath = args[args.indexOf("-o") + 1];
      await writeFile(outputPath, "user 0.01\nsys 0.01\n");
      return {
        exitCode: args.includes("-l") ? 1 : 0,
        signal: null,
        timedOut: false,
        elapsedMs: 20,
        stdout: "",
        stderr: args.includes("-l") ? "RSS unavailable" : ""
      };
    }
  });
  t.after(() => measurer.dispose());
  assert.equal(measurer.capability.collector, "darwin-time-p");
  assert.equal(measurer.capability.cpuTime.status, "available");
  assert.equal(measurer.capability.peakRss.status, "unavailable");
  const outcome = await measurer.execute("compiler", []);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.resourceUsage.cpuTime.status, "available");
  assert.equal(calls.at(-1).includes("-l"), false);
});

test("failed probes fall back without changing the compiler result", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ts7-resource-test-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  let call = 0;
  const measurer = await createResourceMeasurer({
    platform: "darwin",
    timeCommand: process.execPath,
    temporaryRoot,
    executeCommand: async (command) => {
      call += 1;
      if (call === 1) {
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          elapsedMs: 1,
          stdout: "",
          stderr: "probe failed"
        };
      }
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        elapsedMs: 2,
        stdout: command,
        stderr: ""
      };
    }
  });
  t.after(() => measurer.dispose());
  const outcome = await measurer.execute("compiler", []);
  assert.equal(measurer.capability.collector, "direct-spawn");
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.stdout, "compiler");
  assert.equal(outcome.resourceUsage.peakRss.status, "unavailable");
});

test("missing collectors fall back and preserve an explicit reason", async () => {
  const measurer = await createResourceMeasurer({
    platform: "darwin",
    timeCommand: "/definitely/missing/time",
    executeCommand: async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      elapsedMs: 1,
      stdout: "",
      stderr: ""
    })
  });
  const outcome = await measurer.execute("compiler", []);
  assert.equal(measurer.capability.cpuTime.reason, "collector-not-found");
  assert.equal(outcome.resourceUsage.peakRss.reason, "collector-not-found");
});

test("temporary directory setup failures fall back to direct execution", async () => {
  const measurer = await createResourceMeasurer({
    platform: "darwin",
    timeCommand: process.execPath,
    temporaryRoot: "/definitely/missing/resource-root",
    executeCommand: async (command) => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      elapsedMs: 1,
      stdout: command,
      stderr: ""
    })
  });
  const outcome = await measurer.execute("compiler", []);
  assert.equal(measurer.capability.cpuTime.reason, "collector-setup-failed");
  assert.equal(outcome.stdout, "compiler");
  assert.equal(outcome.resourceUsage.peakRss.reason, "collector-setup-failed");
});

test("timeout discards incomplete metrics after a successful probe", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ts7-resource-test-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  let call = 0;
  const measurer = await createResourceMeasurer({
    platform: "darwin",
    timeCommand: process.execPath,
    temporaryRoot,
    executeCommand: async (command, args) => {
      call += 1;
      const outputPath = args[args.indexOf("-o") + 1];
      if (call === 1) {
        await writeFile(outputPath, `user 0.01
sys 0.01
  4096  maximum resident set size
`);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          elapsedMs: 20,
          stdout: "",
          stderr: ""
        };
      }
      return {
        exitCode: null,
        signal: "SIGTERM",
        timedOut: true,
        elapsedMs: 100,
        stdout: "partial",
        stderr: ""
      };
    }
  });
  t.after(() => measurer.dispose());
  const outcome = await measurer.execute("compiler", []);
  assert.equal(outcome.resourceUsage.cpuTime.status, "unavailable");
  assert.equal(outcome.resourceUsage.cpuTime.reason, "attempt-timeout");
  assert.equal(outcome.resourceUsage.peakRss.reason, "attempt-timeout");
});
