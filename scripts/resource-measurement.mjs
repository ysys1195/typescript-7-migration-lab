import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "./lib.mjs";

const TIME_COMMAND = "/usr/bin/time";

function unavailableMetric(reason) {
  return { status: "unavailable", reason };
}

function availableCpuTime(userMs, systemMs) {
  return {
    status: "available",
    userMs,
    systemMs,
    totalMs: userMs + systemMs
  };
}

function availablePeakRss(bytes) {
  return { status: "available", bytes };
}

export function unavailableResourceUsage(reason, collector = "direct-spawn") {
  return {
    collector,
    scope: "timed-process",
    cpuTime: unavailableMetric(reason),
    peakRss: unavailableMetric(reason)
  };
}

function parseNumber(match) {
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function parseDarwinTimeOutput(output) {
  const userSeconds = parseNumber(output.match(/^user\s+([\d.]+)\s*$/m));
  const systemSeconds = parseNumber(output.match(/^sys\s+([\d.]+)\s*$/m));
  const peakRssBytes = parseNumber(
    output.match(/^\s*(\d+)\s+maximum resident set size\s*$/m)
  );
  return {
    collector: "darwin-time-l",
    scope: "timed-process",
    cpuTime: userSeconds === null || systemSeconds === null
      ? unavailableMetric("collector-output-invalid")
      : availableCpuTime(userSeconds * 1_000, systemSeconds * 1_000),
    peakRss: peakRssBytes === null ||
      peakRssBytes <= 0 ||
      !Number.isSafeInteger(peakRssBytes)
      ? unavailableMetric("collector-output-invalid")
      : availablePeakRss(peakRssBytes)
  };
}

export function parseGnuTimeOutput(output) {
  const userSeconds = parseNumber(
    output.match(/^User time \(seconds\):\s*([\d.]+)\s*$/m)
  );
  const systemSeconds = parseNumber(
    output.match(/^System time \(seconds\):\s*([\d.]+)\s*$/m)
  );
  const peakRssKib = parseNumber(
    output.match(/^Maximum resident set size \(kbytes\):\s*(\d+)\s*$/m)
  );
  const peakRssBytes = peakRssKib === null ? null : peakRssKib * 1_024;
  return {
    collector: "gnu-time-v",
    scope: "timed-process",
    cpuTime: userSeconds === null || systemSeconds === null
      ? unavailableMetric("collector-output-invalid")
      : availableCpuTime(userSeconds * 1_000, systemSeconds * 1_000),
    peakRss: peakRssBytes === null ||
      peakRssBytes <= 0 ||
      !Number.isSafeInteger(peakRssBytes)
      ? unavailableMetric("collector-output-invalid")
      : availablePeakRss(peakRssBytes)
  };
}

function capabilityFromUsage(usage, reason = null) {
  return {
    collector: usage.collector,
    scope: usage.scope,
    cpuTime: usage.cpuTime.status === "available"
      ? { status: "available" }
      : unavailableMetric(reason ?? usage.cpuTime.reason),
    peakRss: usage.peakRss.status === "available"
      ? { status: "available" }
      : unavailableMetric(reason ?? usage.peakRss.reason)
  };
}

function unavailableCapability(reason) {
  return capabilityFromUsage(unavailableResourceUsage(reason), reason);
}

function collectorForPlatform(platform) {
  if (platform === "darwin") {
    return {
      name: "darwin-time-l",
      argumentsFor: (outputPath, command, args) =>
        ["-p", "-l", "-o", outputPath, command, ...args],
      parse: parseDarwinTimeOutput
    };
  }
  if (platform === "linux") {
    return {
      name: "gnu-time-v",
      argumentsFor: (outputPath, command, args) =>
        ["-v", "-o", outputPath, command, ...args],
      parse: parseGnuTimeOutput
    };
  }
  return null;
}

function darwinCpuOnlyCollector() {
  return {
    name: "darwin-time-p",
    argumentsFor: (outputPath, command, args) =>
      ["-p", "-o", outputPath, command, ...args],
    parse: parseDarwinTimeOutput
  };
}

export async function createResourceMeasurer(options = {}) {
  const platform = options.platform ?? process.platform;
  const executeCommand = options.executeCommand ?? run;
  const timeCommand = options.timeCommand ?? TIME_COMMAND;
  let collector = collectorForPlatform(platform);
  let temporaryDirectory = null;

  async function directExecute(command, args, runOptions, reason) {
    const outcome = await executeCommand(command, args, runOptions);
    return {
      ...outcome,
      resourceUsage: unavailableResourceUsage(reason)
    };
  }

  if (!collector) {
    const reason = "unsupported-platform";
    return {
      capability: unavailableCapability(reason),
      execute: (command, args, runOptions = {}) =>
        directExecute(command, args, runOptions, reason),
      dispose: async () => {}
    };
  }

  try {
    await access(timeCommand);
  } catch {
    const reason = "collector-not-found";
    return {
      capability: unavailableCapability(reason),
      execute: (command, args, runOptions = {}) =>
        directExecute(command, args, runOptions, reason),
      dispose: async () => {}
    };
  }

  try {
    temporaryDirectory = await mkdtemp(
      path.join(options.temporaryRoot ?? os.tmpdir(), "ts7-resource-")
    );
  } catch {
    const reason = "collector-setup-failed";
    return {
      capability: unavailableCapability(reason),
      execute: (command, args, runOptions = {}) =>
        directExecute(command, args, runOptions, reason),
      dispose: async () => {}
    };
  }

  async function measuredExecute(command, args, runOptions = {}) {
    const outputPath = path.join(temporaryDirectory, `${randomUUID()}.txt`);
    let outcome;
    let usage;
    try {
      outcome = await executeCommand(
        timeCommand,
        collector.argumentsFor(outputPath, command, args),
        {
          ...runOptions,
          env: { ...runOptions.env, LC_ALL: "C" },
          killProcessGroup: true
        }
      );
      if (outcome.timedOut) {
        usage = unavailableResourceUsage("attempt-timeout", collector.name);
      } else {
        try {
          usage = {
            ...collector.parse(await readFile(outputPath, "utf8")),
            collector: collector.name
          };
        } catch {
          usage = unavailableResourceUsage(
            "collector-output-invalid",
            collector.name
          );
        }
      }
      return { ...outcome, resourceUsage: usage };
    } finally {
      await rm(outputPath, { force: true });
    }
  }

  let probe = await measuredExecute(
    process.execPath,
    ["-e", "process.exit(0)"],
    { timeoutMs: 5_000 }
  ).catch(() => null);
  if (
    platform === "darwin" &&
    probe?.exitCode !== 0 &&
    probe?.resourceUsage.cpuTime.status === "available"
  ) {
    collector = darwinCpuOnlyCollector();
    probe = await measuredExecute(
      process.execPath,
      ["-e", "process.exit(0)"],
      { timeoutMs: 5_000 }
    ).catch(() => null);
  }
  const probeSucceeded = probe &&
    probe.exitCode === 0 &&
    !probe.timedOut &&
    (
      probe.resourceUsage.cpuTime.status === "available" ||
      probe.resourceUsage.peakRss.status === "available"
    );

  if (!probeSucceeded) {
    const reason = "collector-probe-failed";
    return {
      capability: unavailableCapability(reason),
      execute: (command, args, runOptions = {}) =>
        directExecute(command, args, runOptions, reason),
      dispose: async () => {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    };
  }

  return {
    capability: capabilityFromUsage(probe.resourceUsage),
    execute: measuredExecute,
    dispose: async () => {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  };
}
