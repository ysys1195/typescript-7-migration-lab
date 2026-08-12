import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ecosystemTools,
  readRecordedEcosystemResult
} from "../scripts/ecosystem-compatibility.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

test("recorded ecosystem results contain successful expected observations", async () => {
  const result = await readRecordedEcosystemResult();
  assert.deepEqual(
    result.tools.map(({ name, classification, blocker }) => ({
      name,
      classification,
      blocker
    })),
    [
      {
        name: "typescript-eslint",
        classification: "TS6_COEXISTENCE_REQUIRED",
        blocker: "PROGRAMMATIC_API_WAITING"
      },
      { name: "Vite", classification: "TS7_STANDALONE", blocker: null },
      { name: "Vitest", classification: "TS7_STANDALONE", blocker: null }
    ]
  );
  assert.equal(
    result.tools.flatMap((tool) => tool.scenarios)
      .flatMap((scenario) => scenario.commands)
      .every((command) => command.expectationMet),
    true
  );
});

test("ecosystem fixture manifests pin every tool version exactly", async () => {
  for (const tool of ecosystemTools) {
    for (const scenario of tool.scenarios) {
      const manifest = JSON.parse(await readFile(
        path.join(projectRoot, scenario.fixture, "package.json"),
        "utf8"
      ));
      for (const [dependency, version] of Object.entries(manifest.devDependencies)) {
        assert.match(version, /^(?:npm:.+@)?\d+\.\d+\.\d+$/);
        assert.ok(dependency.length > 0);
      }
    }
  }
});
