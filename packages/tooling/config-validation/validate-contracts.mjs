import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const contractsDir = join("packages", "contracts");
const protoFiles = readdirSync(contractsDir).filter((file) => file.endsWith(".proto"));
const openApiFiles = readdirSync(contractsDir).filter((file) => file.endsWith(".yaml"));

let failed = false;

for (const protoPath of protoFiles.map((file) => join(contractsDir, file))) {
  const content = readFileSync(protoPath, "utf-8");
  if (!content.includes('syntax = "proto3";')) {
    console.error(`Invalid proto header in ${protoPath}`);
    failed = true;
    continue;
  }
  if (!/message\s+\w+\s*\{/.test(content)) {
    console.error(`No protobuf messages found in ${protoPath}`);
    failed = true;
    continue;
  }
  console.log(`Validated proto ${protoPath}`);
}

for (const openApiPath of openApiFiles.map((file) => join(contractsDir, file))) {
  const content = readFileSync(openApiPath, "utf-8");
  if (!/^openapi:\s*['"]?3\./m.test(content)) {
    console.error(`Missing OpenAPI 3 header in ${openApiPath}`);
    failed = true;
    continue;
  }
  if (!/^\s*paths:\s*$/m.test(content)) {
    console.error(`Missing paths section in ${openApiPath}`);
    failed = true;
    continue;
  }
  console.log(`Validated OpenAPI ${openApiPath}`);
}

if (failed) {
  process.exit(1);
}

console.log(`Validated ${protoFiles.length} proto file(s) and ${openApiFiles.length} OpenAPI file(s).`);
