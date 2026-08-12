import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { run, root } from "./lib.mjs";
import { unavailableResourceUsage } from "./resource-measurement.mjs";

function directUsage(reason, collector) {
  return unavailableResourceUsage(reason, collector);
}

async function resetOutput(pathname) {
  await rm(pathname, { recursive: true, force: true });
}

async function runStandardFixture({
  compiler,
  args,
  timeoutMs,
  resourceMeasurer,
  fixture
}) {
  if (fixture.resetPaths) {
    await Promise.all(fixture.resetPaths.map((pathname) =>
      resetOutput(path.join(root, pathname))
    ));
  }
  return resourceMeasurer.execute(compiler, args, { timeoutMs });
}

async function withFixtureCopy(name, callback) {
  const temporaryRoot = path.join(root, ".tmp", `fixture-${name}-${randomUUID()}`);
  await mkdir(path.dirname(temporaryRoot), { recursive: true });
  await cp(path.join(root, "fixtures", name), temporaryRoot, { recursive: true });
  try {
    return await callback(temporaryRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function withoutPrettyArgs(args) {
  const cleaned = [...args];
  const index = cleaned.lastIndexOf("--pretty");
  if (index !== -1) cleaned.splice(index, 2);
  return cleaned;
}

async function runIncrementalFixture({
  compiler,
  args,
  timeoutMs,
  fixture,
  collector,
  resourceMeasurer
}) {
  return withFixtureCopy("incremental", async (temporaryRoot) => {
    const buildInfo = path.join(temporaryRoot, "cache.tsbuildinfo");
    const projectArgs = [
      "-p",
      temporaryRoot,
      "--pretty",
      "false",
      "--tsBuildInfoFile",
      buildInfo,
      ...withoutPrettyArgs(args)
    ];
    if (fixture.state !== "initial") {
      const initial = await run(compiler, projectArgs, { timeoutMs });
      if (initial.exitCode !== 0 || initial.timedOut) {
        return {
          ...initial,
          resourceUsage: directUsage("incremental-preparation-failed", collector)
        };
      }
      if (fixture.state === "edit") {
        const sourcePath = path.join(temporaryRoot, "src", "file-0.ts");
        const source = await readFile(sourcePath, "utf8");
        await writeFile(sourcePath, `${source}\nexport const edited = true;\n`);
      }
    }
    return resourceMeasurer.execute(compiler, projectArgs, { timeoutMs });
  });
}

function terminateChild(child, signal = "SIGTERM") {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") child.kill(signal);
  }
}

function waitForChildClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const onClose = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    const timeout = setTimeout(() => {
      child.off("close", onClose);
      resolve(false);
    }, timeoutMs);
    child.once("close", onClose);
  });
}

async function stopChild(child) {
  terminateChild(child);
  if (await waitForChildClose(child, 1_000)) return;
  terminateChild(child, "SIGKILL");
  await waitForChildClose(child, 1_000);
}

async function runWatchFixture({ compiler, args, timeoutMs, collector }) {
  return withFixtureCopy("watch", (temporaryRoot) => new Promise((resolve, reject) => {
    const commandArgs = [
      "-p",
      temporaryRoot,
      "--watch",
      "--preserveWatchOutput",
      "--pretty",
      "false",
      ...withoutPrettyArgs(args)
    ];
    const child = spawn(compiler, commandArgs, {
      cwd: root,
      detached: process.platform !== "win32",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let stage = "initial";
    let editStarted = null;
    let settled = false;
    let timeout;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      stopChild(child).then(() => resolve(value), reject);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      stopChild(child).then(() => reject(error), reject);
    };
    let handlingOutput = false;
    const handleOutput = async () => {
      if (handlingOutput || settled) return;
      handlingOutput = true;
      const output = stdout + stderr;
      try {
        if (stage === "initial" && /Found 0 errors\. Watching for file changes\./.test(output)) {
          stage = "edited";
          stdout = "";
          stderr = "";
          const sourcePath = path.join(temporaryRoot, "src", "file-0.ts");
          const source = await readFile(sourcePath, "utf8");
          editStarted = process.hrtime.bigint();
          await writeFile(sourcePath, `${source}\nexport const edited = true;\n`);
          return;
        }
        if (stage === "edited" && /Found 0 errors\. Watching for file changes\./.test(output)) {
          const elapsedMs = Number(process.hrtime.bigint() - editStarted) / 1e6;
          finish({
            exitCode: 0,
            signal: null,
            timedOut: false,
            elapsedMs,
            stdout,
            stderr,
            resourceUsage: directUsage(
              "watch-process-terminated-after-update",
              collector
            )
          });
        }
      } finally {
        handlingOutput = false;
      }
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      handleOutput().catch(fail);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      handleOutput().catch(fail);
    });
    child.on("error", fail);
    child.on("close", (exitCode, signal) => {
      if (!settled) {
        finish({
          exitCode,
          signal,
          timedOut: false,
          elapsedMs: editStarted
            ? Number(process.hrtime.bigint() - editStarted) / 1e6
            : 0,
          stdout,
          stderr,
          resourceUsage: directUsage(
            "watch-process-exited-before-update",
            collector
          )
        });
      }
    });
    timeout = setTimeout(() => finish({
      exitCode: null,
      signal: null,
      timedOut: true,
      elapsedMs: editStarted
        ? Number(process.hrtime.bigint() - editStarted) / 1e6
        : timeoutMs,
      stdout,
      stderr,
      resourceUsage: directUsage("watch-timeout", collector)
    }), timeoutMs);
  }));
}

export function createFixtureExecutor(resourceMeasurer) {
  return async (compiler, args, options = {}) => {
    const fixture = options.fixture;
    if (fixture?.measurement === "incremental") {
      return runIncrementalFixture({
        compiler,
        args,
        timeoutMs: options.timeoutMs,
        fixture,
        collector: resourceMeasurer.capability.collector,
        resourceMeasurer
      });
    }
    if (fixture?.measurement === "watch") {
      return runWatchFixture({
        compiler,
        args,
        timeoutMs: options.timeoutMs,
        collector: resourceMeasurer.capability.collector
      });
    }
    return runStandardFixture({
      compiler,
      args,
      timeoutMs: options.timeoutMs,
      resourceMeasurer,
      fixture
    });
  };
}
