import { readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const contractsDir = join("packages", "contracts");
const schemaFiles = readdirSync(contractsDir)
  .filter((file) => file.endsWith(".schema.json"))
  .map((file) => join(contractsDir, file));

if (schemaFiles.length === 0) {
  console.log("No *.schema.json files found under packages/contracts.");
  process.exit(0);
}

for (const schemaPath of schemaFiles) {
  console.log(`Validating ${schemaPath}`);
  execSync(`npx ajv compile --spec=draft2020 -c ajv-formats -s \"${schemaPath}\"`, {
    stdio: "inherit",
  });
}

console.log(`Validated ${schemaFiles.length} schema file(s).`);
