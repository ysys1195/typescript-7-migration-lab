import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const resultPath = path.join(
  projectRoot,
  "compatibility",
  "ecosystem-results.json"
);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

export const ecosystemTools = [
  {
    name: "typescript-eslint",
    version: "8.67.0",
    classification: "TS6_COEXISTENCE_REQUIRED",
    blocker: "PROGRAMMATIC_API_WAITING",
    migrationNote:
      "Keep the stable TS6 package at the bare typescript import and install the TS7 compiler under a separate alias. ESLint uses the TS6 programmatic API while type checking can run through either tsc6 or the TS7 tsc binary.",
    scenarios: [
      {
        id: "typescript-eslint-ts7-only",
        fixture: "fixtures/ecosystem/typescript-eslint-ts7-only",
        commands: [
          {
            id: "install-with-supported-peer-rules",
            args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
            expected: "failure"
          },
          {
            id: "force-install-for-api-probe",
            args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--force"],
            expected: "success"
          },
          { id: "ts7-cli-typecheck", args: ["run", "typecheck"], expected: "success" },
          { id: "typescript-eslint-api-probe", args: ["run", "lint"], expected: "failure" }
        ]
      },
      {
        id: "typescript-eslint-ts6-coexistence",
        fixture: "fixtures/ecosystem/typescript-eslint",
        commands: [
          {
            id: "install",
            args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
            expected: "success"
          },
          { id: "lint-with-ts6-api", args: ["run", "lint"], expected: "success" },
          { id: "ts6-cli-typecheck", args: ["run", "typecheck:ts6"], expected: "success" },
          { id: "ts7-cli-typecheck", args: ["run", "typecheck:ts7"], expected: "success" }
        ]
      }
    ]
  },
  {
    name: "Vite",
    version: "6.4.3",
    classification: "TS7_STANDALONE",
    blocker: null,
    migrationNote:
      "Vite transpiles TypeScript with esbuild and does not consume the TypeScript programmatic API. Run the TS7 tsc command separately for type checking.",
    scenarios: [
      {
        id: "vite-ts7-only",
        fixture: "fixtures/ecosystem/vite",
        commands: [
          {
            id: "install",
            args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
            expected: "success"
          },
          { id: "ts7-cli-typecheck", args: ["run", "typecheck"], expected: "success" },
          { id: "vite-build", args: ["run", "build"], expected: "success" }
        ]
      }
    ]
  },
  {
    name: "Vitest",
    version: "4.1.10",
    classification: "TS7_STANDALONE",
    blocker: null,
    migrationNote:
      "Vitest executes TypeScript through the Vite transform pipeline rather than the TypeScript programmatic API. Keep a separate TS7 tsc step because the test run itself is not a type check.",
    scenarios: [
      {
        id: "vitest-ts7-only",
        fixture: "fixtures/ecosystem/vitest",
        commands: [
          {
            id: "install",
            args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
            expected: "success"
          },
          { id: "ts7-cli-typecheck", args: ["run", "typecheck"], expected: "success" },
          { id: "vitest-run", args: ["test"], expected: "success" }
        ]
      }
    ]
  }
];

function normalizeOutput(output) {
  return String(output ?? "")
    .replaceAll(projectRoot, "<repo>")
    .replaceAll(os.homedir(), "<home>")
    .replaceAll("\\", "/")
    .replaceAll("\r\n", "\n")
    .trimEnd();
}

function commandText(args) {
  return ["npm", ...args].map((value) =>
    /^[a-zA-Z0-9:./@_-]+$/.test(value) ? value : JSON.stringify(value)
  ).join(" ");
}

function runCommand(fixture, command) {
  const cwd = path.join(projectRoot, fixture);
  const execution = spawnSync(npmCommand, command.args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      CI: "1",
      NO_COLOR: "1",
      npm_config_color: "false"
    },
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000
  });
  const exitCode = execution.status;
  const outcome = exitCode === 0 ? "success" : "failure";
  return {
    id: command.id,
    command: commandText(command.args),
    expected: command.expected,
    outcome,
    expectationMet: outcome === command.expected,
    exitCode,
    signal: execution.signal,
    error: execution.error?.message ?? null,
    stdout: normalizeOutput(execution.stdout),
    stderr: normalizeOutput(execution.stderr)
  };
}

function validateCommand(command, location) {
  if (typeof command.command !== "string" || !command.command.startsWith("npm ")) {
    throw new Error(`${location}.command must record an npm invocation.`);
  }
  if (!Number.isInteger(command.exitCode)) {
    throw new Error(`${location}.exitCode must be an integer.`);
  }
  if (command.expectationMet !== true) {
    throw new Error(`${location} did not match its expected outcome.`);
  }
}

export function validateEcosystemResult(result) {
  if (result.schemaVersion !== "1.0.0" || result.kind !== "ecosystem-compatibility") {
    throw new Error("Unsupported ecosystem compatibility result.");
  }
  if (!Array.isArray(result.tools) || result.tools.length !== ecosystemTools.length) {
    throw new Error("The ecosystem result must contain every configured tool.");
  }
  for (const configuredTool of ecosystemTools) {
    const tool = result.tools.find((candidate) => candidate.name === configuredTool.name);
    if (!tool || tool.version !== configuredTool.version) {
      throw new Error(`${configuredTool.name} does not use the configured version.`);
    }
    if (tool.classification !== configuredTool.classification) {
      throw new Error(`${configuredTool.name} has an unexpected classification.`);
    }
    if (tool.blocker !== configuredTool.blocker) {
      throw new Error(`${configuredTool.name} has an unexpected blocker.`);
    }
    for (const configuredScenario of configuredTool.scenarios) {
      const scenario = tool.scenarios.find(
        (candidate) => candidate.id === configuredScenario.id
      );
      if (!scenario) throw new Error(`Missing scenario ${configuredScenario.id}.`);
      if (scenario.commands.length !== configuredScenario.commands.length) {
        throw new Error(`${configuredScenario.id} has an unexpected command count.`);
      }
      for (const configuredCommand of configuredScenario.commands) {
        const command = scenario.commands.find(
          (candidate) => candidate.id === configuredCommand.id
        );
        if (!command || command.expected !== configuredCommand.expected) {
          throw new Error(
            `${configuredScenario.id}/${configuredCommand.id} is missing or changed.`
          );
        }
        validateCommand(command, `${configuredScenario.id}/${configuredCommand.id}`);
      }
    }
  }
  return result;
}

export async function runEcosystemCompatibility(options = {}) {
  const npmVersionProbe = spawnSync(npmCommand, ["--version"], {
    encoding: "utf8"
  });
  const result = {
    schemaVersion: "1.0.0",
    kind: "ecosystem-compatibility",
    recordedAt: new Date().toISOString(),
    environment: {
      nodeVersion: process.version,
      npmVersion: String(npmVersionProbe.stdout).trim(),
      platform: process.platform,
      arch: process.arch
    },
    normalization: [
      "repository path replaced with <repo>",
      "home directory replaced with <home>",
      "path separators and line endings normalized to forward slash and LF"
    ],
    tools: ecosystemTools.map((tool) => ({
      name: tool.name,
      version: tool.version,
      classification: tool.classification,
      blocker: tool.blocker,
      migrationNote: tool.migrationNote,
      scenarios: tool.scenarios.map((scenario) => ({
        id: scenario.id,
        fixture: scenario.fixture,
        commands: scenario.commands.map((command) =>
          runCommand(scenario.fixture, command)
        )
      }))
    }))
  };
  validateEcosystemResult(result);
  if (options.record) {
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  return result;
}

export async function readRecordedEcosystemResult() {
  return validateEcosystemResult(JSON.parse(await readFile(resultPath, "utf8")));
}

function printSummary(result) {
  for (const tool of result.tools) {
    console.log(`${tool.name} ${tool.version}: ${tool.classification}`);
    for (const scenario of tool.scenarios) {
      for (const command of scenario.commands) {
        console.log(
          `  ${scenario.id}/${command.id}: ${command.outcome} ` +
          `(expected ${command.expected})`
        );
      }
    }
  }
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  if (args.some((argument) => argument !== "--record")) {
    throw new Error("Usage: node scripts/ecosystem-compatibility.mjs [--record]");
  }
  const record = args.includes("--record");
  const result = await runEcosystemCompatibility({ record });
  printSummary(result);
  if (record) console.log("Wrote compatibility/ecosystem-results.json.");
}
