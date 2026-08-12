import assert from "node:assert/strict";
import test from "node:test";
import {
  compilerExecutableName,
  shouldUseCommandShell
} from "../scripts/lib.mjs";

test("compiler shims use Windows command wrappers only on Windows", () => {
  assert.equal(compilerExecutableName("tsc", "win32"), "tsc.cmd");
  assert.equal(compilerExecutableName("tsc6", "linux"), "tsc6");
  assert.equal(shouldUseCommandShell("C:\\repo\\node_modules\\.bin\\tsc.cmd", "win32"), true);
  assert.equal(shouldUseCommandShell("/repo/node_modules/.bin/tsc", "linux"), false);
  assert.equal(shouldUseCommandShell("C:\\node.exe", "win32"), false);
});
