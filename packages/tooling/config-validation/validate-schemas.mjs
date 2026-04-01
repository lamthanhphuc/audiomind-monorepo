import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const schemaDir = join("packages", "contracts");
const schemaFiles = readdirSync(schemaDir).filter((name) => name.endsWith(".schema.json"));

if (schemaFiles.length === 0) {
  console.error("No schema files found in packages/contracts");
  process.exit(1);
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

let hasError = false;

for (const file of schemaFiles) {
  const fullPath = join(schemaDir, file);
  const content = readFileSync(fullPath, "utf8");

  try {
    const schema = JSON.parse(content);
    ajv.compile(schema);
    console.log(`schema ${fullPath} is valid`);
  } catch (error) {
    hasError = true;
    console.error(`schema ${fullPath} is invalid`);
    console.error(error instanceof Error ? error.message : String(error));
  }
}

if (hasError) {
  process.exit(1);
}
