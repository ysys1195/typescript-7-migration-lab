import { readResultJson } from "./lib.mjs";

const filenames = process.argv.slice(2);
const targets = filenames.length
  ? filenames
  : ["benchmark.json", "comparison.json"];

for (const filename of targets) {
  await readResultJson(filename);
  console.log(`${filename}: valid`);
}
