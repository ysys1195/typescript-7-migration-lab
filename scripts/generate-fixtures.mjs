import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { root } from "./lib.mjs";

const sourceDir = path.join(root, "fixtures", "many-files", "src");
const fileCount = Number.parseInt(process.env.LAB_FILE_COUNT ?? "400", 10);

if (!Number.isSafeInteger(fileCount) || fileCount < 2 || fileCount > 10_000) {
  throw new Error("LAB_FILE_COUNT must be an integer between 2 and 10000.");
}

await rm(sourceDir, { recursive: true, force: true });
await mkdir(sourceDir, { recursive: true });

const writes = [];
for (let index = 0; index < fileCount; index += 1) {
  const previousImport = index === 0
    ? ""
    : `import { value${index - 1} } from "./file-${index - 1}.js";\n`;
  const previousValue = index === 0 ? "0" : `value${index - 1}`;
  const source = `${previousImport}
export type Item${index} = {
  id: \`item-${index}-\${string}\`;
  value: number;
  metadata: { createdAt: Date; tags: readonly string[] };
};

export const value${index}: number = ${previousValue} + 1;
`;
  writes.push(writeFile(path.join(sourceDir, `file-${index}.ts`), source));
}

await Promise.all(writes);
console.log(`Generated ${fileCount} TypeScript files in fixtures/many-files/src.`);
