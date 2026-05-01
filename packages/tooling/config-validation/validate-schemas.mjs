import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const contractsDir = join("packages", "contracts");
const schemaFiles = readdirSync(contractsDir)
  .filter((file) => file.endsWith(".schema.json"))
  .map((file) => join(contractsDir, file));

if (schemaFiles.length === 0) {
  console.log("No *.schema.json files found under packages/contracts.");
  process.exit(0);
}

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

for (const schemaPath of schemaFiles) {
  console.log(`Validating ${schemaPath}`);
  const schema = JSON.parse(readFileSync(schemaPath, "utf-8"));
  try {
    ajv.compile(schema);
  } catch (error) {
    console.error(`Schema validation failed for ${schemaPath}`);
    console.error(error);
    process.exit(1);
  }
}

console.log(`Validated ${schemaFiles.length} schema file(s).`);
