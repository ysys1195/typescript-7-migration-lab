import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createFixtureGenerationManifest,
  FIXTURE_GENERATION_MANIFEST,
  readFixturePreset
} from "./fixture-presets.mjs";
import { root } from "./lib.mjs";

const { name: presetName, values: preset } = readFixturePreset();

async function resetDirectory(directory) {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
}

async function writeManyFiles() {
  const sourceDir = path.join(root, "fixtures", "many-files", "src");
  await resetDirectory(sourceDir);
  const writes = [];
  for (let index = 0; index < preset.manyFiles; index += 1) {
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
}

async function writeParseHeavy() {
  const sourceDir = path.join(root, "fixtures", "parse-heavy", "src");
  await resetDirectory(sourceDir);
  const writes = [];
  for (let file = 0; file < preset.parseFiles; file += 1) {
    const statements = [];
    for (let index = 0; index < preset.parseStatementsPerFile; index += 1) {
      statements.push(
        `export const value_${file}_${index} = ({ id: ${index}, ` +
        `label: \`item-${file}-${index}\`, flags: [true, false] } as const);`
      );
    }
    writes.push(writeFile(
      path.join(sourceDir, `file-${file}.ts`),
      `${statements.join("\n")}\n`
    ));
  }
  await Promise.all(writes);
}

async function writeTypeHeavyScaled() {
  const sourceDir = path.join(root, "fixtures", "type-heavy-scaled", "src");
  await resetDirectory(sourceDir);
  const writes = [];
  for (let file = 0; file < preset.typeFiles; file += 1) {
    const instantiations = [];
    for (let index = 0; index < preset.typeInstantiationsPerFile; index += 1) {
      instantiations.push(
        `export type Result_${file}_${index} = Expand<Model_${file}_${index}>;`
      );
      instantiations.push(
        `type Model_${file}_${index} = { ` +
        `[K in \`field_${index}_\${"a" | "b" | "c"}\`]: ` +
        `{ value: K; nested: readonly [K, K, K] } };`
      );
    }
    const source = `type Expand<T> = T extends object
  ? { [K in keyof T]: T[K] extends readonly unknown[]
      ? { [I in keyof T[K]]: Expand<T[K][I]> }
      : Expand<T[K]> }
  : T;

${instantiations.join("\n")}
`;
    writes.push(writeFile(path.join(sourceDir, `file-${file}.ts`), source));
  }
  await Promise.all(writes);
}

function moduleSource(index, declarationOnly = false) {
  const previousImport = index === 0
    ? ""
    : `import { create${index - 1} } from "./file-${index - 1}.js";\n`;
  const previousValue = index === 0
    ? "seed.length"
    : `create${index - 1}(seed).value`;
  const extra = declarationOnly
    ? `export type Deep${index}<T> = { readonly value: T; readonly nested: ` +
      `{ readonly index: ${index}; readonly payload: T } };\n`
    : "";
  return `${previousImport}${extra}
export interface Record${index}<T extends string> {
  readonly id: \`${index}-\${T}\`;
  readonly value: number;
  readonly tags: readonly T[];
}

export function create${index}<T extends string>(seed: T): Record${index}<T> {
  return { id: \`${index}-\${seed}\`, value: ${previousValue} + ${index}, tags: [seed] };
}
`;
}

async function writeModuleChain(fixtureName, fileCount, declarationOnly = false) {
  const sourceDir = path.join(root, "fixtures", fixtureName, "src");
  await resetDirectory(sourceDir);
  await Promise.all(Array.from({ length: fileCount }, (_, index) =>
    writeFile(
      path.join(sourceDir, `file-${index}.ts`),
      moduleSource(index, declarationOnly)
    )
  ));
}

async function writeModuleResolution() {
  const fixtureRoot = path.join(root, "fixtures", "module-resolution");
  const sourceDir = path.join(fixtureRoot, "src");
  const packagesDir = path.join(fixtureRoot, "node_modules");
  await Promise.all([resetDirectory(sourceDir), resetDirectory(packagesDir)]);
  const imports = [];
  const uses = [];
  const writes = [];
  for (let index = 0; index < preset.modulePackages; index += 1) {
    const packageName = `fixture-package-${index}`;
    const packageDir = path.join(packagesDir, packageName);
    await mkdir(packageDir, { recursive: true });
    writes.push(writeFile(path.join(packageDir, "package.json"), `${JSON.stringify({
      name: packageName,
      version: "1.0.0",
      types: "index.d.ts",
      exports: { ".": { types: "./index.d.ts" } }
    }, null, 2)}\n`));
    writes.push(writeFile(
      path.join(packageDir, "index.d.ts"),
      `export declare const value${index}: { readonly id: ${index} };\n`
    ));
    imports.push(`import { value${index} } from "${packageName}";`);
    uses.push(`value${index}`);
  }
  writes.push(writeFile(
    path.join(sourceDir, "index.ts"),
    `${imports.join("\n")}\n\nexport const values = [${uses.join(", ")}] as const;\n`
  ));
  await Promise.all(writes);
}

async function writeProjectReferencesDag() {
  const generatedRoot = path.join(
    root,
    "fixtures",
    "project-references-dag",
    "generated"
  );
  await resetDirectory(generatedRoot);
  const references = [];
  const writes = [];
  for (let layer = 0; layer < preset.dagLayers; layer += 1) {
    for (let node = 0; node < preset.dagWidth; node += 1) {
      const name = `layer-${layer}-node-${node}`;
      const packageDir = path.join(generatedRoot, name);
      await mkdir(path.join(packageDir, "src"), { recursive: true });
      const dependencies = layer === 0
        ? []
        : Array.from({ length: preset.dagWidth }, (_, dependency) =>
          `../layer-${layer - 1}-node-${dependency}`
        );
      const imports = dependencies.map((dependency, index) =>
        `import type { Value as Dependency${index} } from "../${dependency}/src/index.js";`
      );
      const dependencyType = dependencies.length
        ? dependencies.map((_, index) => `Dependency${index}`).join(" & ")
        : "{}";
      writes.push(writeFile(
        path.join(packageDir, "src", "index.ts"),
        `${imports.join("\n")}\nexport type Value = ${dependencyType} & ` +
        `{ readonly layer${layer}Node${node}: true };\n`
      ));
      writes.push(writeFile(
        path.join(packageDir, "tsconfig.json"),
        `${JSON.stringify({
          compilerOptions: {
            composite: true,
            strict: true,
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "bundler",
            declaration: true,
            rootDir: "src",
            outDir: "dist"
          },
          references: dependencies.map((dependency) => ({ path: dependency })),
          include: ["src"]
        }, null, 2)}\n`
      ));
      references.push({ path: `./${name}` });
    }
  }
  writes.push(writeFile(
    path.join(generatedRoot, "tsconfig.json"),
    `${JSON.stringify({ files: [], references }, null, 2)}\n`
  ));
  await Promise.all(writes);
}

await Promise.all([
  writeManyFiles(),
  writeParseHeavy(),
  writeTypeHeavyScaled(),
  writeModuleChain("emit-heavy", preset.emitFiles),
  writeModuleChain("declaration-heavy", preset.declarationFiles, true),
  writeModuleResolution(),
  writeModuleChain("incremental", preset.incrementalFiles),
  writeModuleChain("watch", preset.watchFiles),
  writeProjectReferencesDag()
]);

await writeFile(
  path.join(root, FIXTURE_GENERATION_MANIFEST),
  `${JSON.stringify(createFixtureGenerationManifest({
    name: presetName,
    values: preset
  }), null, 2)}\n`
);

console.log(
  `Generated performance fixtures with the ${presetName} preset: ` +
  `${preset.manyFiles} many-files, ${preset.parseFiles} parse files, ` +
  `${preset.typeFiles} type files, ${preset.emitFiles} emit files, ` +
  `${preset.declarationFiles} declaration files, ` +
  `${preset.modulePackages} packages, ${preset.incrementalFiles} incremental files, ` +
  `${preset.watchFiles} watch files, and ` +
  `${preset.dagLayers}x${preset.dagWidth} DAG projects.`
);
