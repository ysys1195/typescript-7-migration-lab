import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(
  readFileSync(path.join(root, "schemas", "result.schema.json"), "utf8")
);
const storageSchema = JSON.parse(
  readFileSync(path.join(root, "schemas", "run-storage.schema.json"), "utf8")
);
export const RESULT_SCHEMA_VERSION = schema.properties.schemaVersion.const;
export const RESULT_STORAGE_VERSION =
  storageSchema.$defs.runManifest.properties.storageVersion.const;

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(schema);
const validate = ajv.getSchema(schema.$id);
const validateStorage = ajv.compile(storageSchema);

function formatErrors(errors) {
  return errors
    ?.map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("\n");
}

export function validateResultDocument(value) {
  if (validate(value)) return value;

  const details = formatErrors(validate.errors);
  throw new Error(`Result schema validation failed:\n${details}`);
}

export function validateStorageDocument(value) {
  if (validateStorage(value)) return value;

  const details = formatErrors(validateStorage.errors);
  throw new Error(`Run storage schema validation failed:\n${details}`);
}
