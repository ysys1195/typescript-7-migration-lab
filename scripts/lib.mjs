import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const resultsDir = path.join(root, "results");
export const reportsDir = path.join(root, "reports");

export const compilers = {
  ts6: path.join(root, "node_modules", ".bin", "tsc6"),
  ts7: path.join(root, "node_modules", ".bin", "tsc")
};

export async function ensureOutputDirs() {
  await Promise.all([
    mkdir(resultsDir, { recursive: true }),
    mkdir(reportsDir, { recursive: true })
  ]);
}

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({ exitCode, signal, elapsedMs, stdout, stderr });
    });
  });
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

export function parseExtendedDiagnostics(output) {
  const diagnostics = {};
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*([^:]+):\s+([\d.]+)(s|K|M|G)?\s*$/);
    if (!match) continue;
    const [, label, rawValue, unit = ""] = match;
    diagnostics[label.trim()] = { value: Number(rawValue), unit };
  }
  return diagnostics;
}

export async function writeJson(filename, value) {
  await ensureOutputDirs();
  await writeFile(
    path.join(resultsDir, filename),
    `${JSON.stringify(value, null, 2)}\n`
  );
}

export async function readJson(filename) {
  return JSON.parse(await readFile(path.join(resultsDir, filename), "utf8"));
}
