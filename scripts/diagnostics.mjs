import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

const summaryPatterns = [
  /^Version \d/,
  /^Found \d+ errors?\.?$/
];

function normalizeFile(file, rootDirectory) {
  const normalized = file.replaceAll("\\", "/");
  const normalizedRoot = rootDirectory?.replaceAll("\\", "/").replace(/\/$/, "");
  if (!normalizedRoot) return normalized;
  if (normalized === normalizedRoot) return "<ROOT>";
  if (normalized.startsWith(`${normalizedRoot}/`)) {
    return normalized.slice(normalizedRoot.length + 1);
  }
  return normalized;
}

function compareNullable(left, right) {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return left < right ? -1 : 1;
}

function compareStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function diagnosticKey(diagnostic) {
  return JSON.stringify([
    diagnostic.code,
    diagnostic.category,
    diagnostic.file,
    diagnostic.line,
    diagnostic.column,
    diagnostic.message
  ]);
}

export function compareDiagnostics(left, right) {
  return compareNullable(left.file, right.file) ||
    compareNullable(left.line, right.line) ||
    compareNullable(left.column, right.column) ||
    left.code - right.code ||
    compareStrings(left.category, right.category) ||
    compareStrings(left.message, right.message);
}

export function parseDiagnostics(output, { rootDirectory } = {}) {
  const diagnostics = [];
  let current = null;

  for (const line of output.split(/\r?\n/)) {
    const located = line.match(
      /^(.*)\((\d+),(\d+)\):\s+(error|warning|suggestion|message)\s+TS(\d+):\s*(.*)$/
    );
    const global = located
      ? null
      : line.match(/^(error|warning|suggestion|message)\s+TS(\d+):\s*(.*)$/);

    if (located) {
      current = {
        code: Number(located[5]),
        category: located[4],
        file: normalizeFile(located[1], rootDirectory),
        line: Number(located[2]),
        column: Number(located[3]),
        message: located[6]
      };
      diagnostics.push(current);
      continue;
    }
    if (global) {
      current = {
        code: Number(global[2]),
        category: global[1],
        file: null,
        line: null,
        column: null,
        message: global[3]
      };
      diagnostics.push(current);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed || summaryPatterns.some((pattern) => pattern.test(trimmed))) {
      continue;
    }
    if (current) current.message += `\n${trimmed}`;
  }

  return diagnostics.sort(compareDiagnostics);
}

function multisetDifference(left, right) {
  const counts = new Map();
  for (const diagnostic of right) {
    const key = diagnosticKey(diagnostic);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const difference = [];
  for (const diagnostic of left) {
    const key = diagnosticKey(diagnostic);
    const count = counts.get(key) ?? 0;
    if (count === 0) difference.push(diagnostic);
    else counts.set(key, count - 1);
  }
  return difference.sort(compareDiagnostics);
}

export function createDiagnosticDifference(ts6, ts7) {
  const onlyTs6 = multisetDifference(ts6.diagnostics, ts7.diagnostics);
  const onlyTs7 = multisetDifference(ts7.diagnostics, ts6.diagnostics);
  return {
    diagnostics: {
      status: onlyTs6.length === 0 && onlyTs7.length === 0
        ? "IDENTICAL"
        : "DIFFERENT",
      onlyTs6,
      onlyTs7
    },
    exitCode: {
      status: ts6.exitCode === ts7.exitCode ? "IDENTICAL" : "DIFFERENT",
      ts6: ts6.exitCode,
      ts7: ts7.exitCode
    }
  };
}

function validateKnownDifferenceManifest(value) {
  const validExitCode = (exitCode) => exitCode === null || Number.isInteger(exitCode);
  const validDiagnostic = (diagnostic) => {
    if (!diagnostic || typeof diagnostic !== "object") return false;
    const keys = Object.keys(diagnostic).sort();
    const expectedKeys = [
      "category",
      "code",
      "column",
      "file",
      "line",
      "message"
    ];
    const hasLocation = typeof diagnostic.file === "string" &&
      diagnostic.file.length > 0 &&
      Number.isInteger(diagnostic.line) && diagnostic.line > 0 &&
      Number.isInteger(diagnostic.column) && diagnostic.column > 0;
    const hasNoLocation = diagnostic.file === null &&
      diagnostic.line === null && diagnostic.column === null;
    return isDeepStrictEqual(keys, expectedKeys) &&
      Number.isInteger(diagnostic.code) && diagnostic.code >= 0 &&
      ["error", "warning", "suggestion", "message"].includes(
        diagnostic.category
      ) &&
      (hasLocation || hasNoLocation) &&
      typeof diagnostic.message === "string";
  };
  const ids = Array.isArray(value?.differences)
    ? value.differences.map((item) => item?.id)
    : [];
  if (
    !value ||
    value.version !== 1 ||
    !Array.isArray(value.differences) ||
    new Set(ids).size !== ids.length ||
    value.differences.some((item) =>
      !item ||
      typeof item.id !== "string" || item.id.length === 0 ||
      typeof item.fixture !== "string" || item.fixture.length === 0 ||
      typeof item.rationale !== "string" || item.rationale.length === 0 ||
      !item.expected ||
      !item.expected.exitCodes ||
      !Array.isArray(item.expected.onlyTs6) ||
      !Array.isArray(item.expected.onlyTs7) ||
      !validExitCode(item.expected.exitCodes.ts6) ||
      !validExitCode(item.expected.exitCodes.ts7) ||
      [...item.expected.onlyTs6, ...item.expected.onlyTs7].some(
        (diagnostic) => !validDiagnostic(diagnostic)
      )
    )
  ) {
    throw new Error("Invalid known diagnostic difference manifest.");
  }
  return value;
}

export async function readKnownDifferenceManifest(filename) {
  return validateKnownDifferenceManifest(
    JSON.parse(await readFile(filename, "utf8"))
  );
}

export function classifyDiagnosticDifference(fixture, difference, manifest) {
  const actual = {
    exitCodes: {
      ts6: difference.exitCode.ts6,
      ts7: difference.exitCode.ts7
    },
    onlyTs6: difference.diagnostics.onlyTs6,
    onlyTs7: difference.diagnostics.onlyTs7
  };
  const hasDifference = difference.diagnostics.status === "DIFFERENT" ||
    difference.exitCode.status === "DIFFERENT";
  if (!hasDifference) {
    return { classification: "SUPPORTED_IDENTICALLY", knownDifferences: [] };
  }

  const known = manifest.differences.find((item) =>
    item.fixture === fixture && isDeepStrictEqual(item.expected, actual)
  );
  if (known) {
    return {
      classification: "SUPPORTED_WITH_DIFFERENCE",
      knownDifferences: [{ id: known.id, rationale: known.rationale }]
    };
  }
  return { classification: "POSSIBLE_REGRESSION", knownDifferences: [] };
}

export function createDiagnosticOutcome(result, options) {
  const separator = result.stdout && result.stderr && !result.stdout.endsWith("\n")
    ? "\n"
    : "";
  return {
    exitCode: result.exitCode,
    diagnostics: parseDiagnostics(
      result.stdout + separator + result.stderr,
      options
    ),
    rawOutput: {
      stdout: result.stdout,
      stderr: result.stderr
    }
  };
}

export function manifestPath(rootDirectory) {
  return path.join(rootDirectory, "compatibility", "known-diagnostic-differences.json");
}
