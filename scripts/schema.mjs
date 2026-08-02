import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(
  readFileSync(path.join(root, "schemas", "result.schema.json"), "utf8")
);
export const RESULT_SCHEMA_VERSION = schema.properties.schemaVersion.const;

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(schema);

export function validateResultDocument(value) {
  if (validate(value)) return value;

  const details = validate.errors
    ?.map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("\n");
  throw new Error(`Result schema validation failed:\n${details}`);
}
