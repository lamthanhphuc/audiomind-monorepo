import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const schemaPath = path.resolve("packages/contracts/config.schema.json");
const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

const schemaProps = Object.keys(schema.properties || {});
const config = Object.fromEntries(
  schemaProps
    .map((name) => [name, process.env[name]])
    .filter(([, value]) => value !== undefined)
);
const valid = validate(config);

if (!valid) {
  console.error("Invalid runtime config:");
  console.error(validate.errors);
  process.exit(1);
}

console.log("Runtime config validation passed.");
