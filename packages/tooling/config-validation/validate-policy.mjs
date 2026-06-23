import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const contractsDir = join(repoRoot, "packages", "contracts");
const fixturesDir = join(import.meta.dirname, "fixtures");

const policySchemaPath = join(contractsDir, "transcript-quality-policy.schema.json");
const policyPath = join(contractsDir, "transcript-quality-policy.json");
const defaultPolicyPath = join(contractsDir, "default-policy.json");
const feDefaultsPath = join(repoRoot, "FE-Audiomind", "src", "config", "transcriptQualityDefaults.json");
const feFallbackPath = join(repoRoot, "FE-Audiomind", "src", "config", "fallback-policy.ts");
const processingPrimaryPath = join(
  repoRoot,
  "demoRecordAUDIOMID",
  "processing-service",
  "src",
  "main",
  "resources",
  "transcript-quality-policy.json",
);
const processingDefaultPath = join(
  repoRoot,
  "demoRecordAUDIOMID",
  "processing-service",
  "src",
  "main",
  "resources",
  "default-policy.json",
);

const canonicalRowSchema = {
  type: "object",
  required: ["segment_id", "text", "speaker", "start_time", "end_time", "term_frequency"],
  additionalProperties: false,
  properties: {
    segment_id: { type: "string", minLength: 1 },
    text: { type: "string" },
    speaker: { type: "string", minLength: 1 },
    start_time: { type: "number" },
    end_time: { type: "number" },
    term_frequency: {
      type: "object",
      additionalProperties: { type: "integer", minimum: 0 },
    },
  },
};

const evidenceStatsSchema = {
  type: "object",
  required: ["idf", "segment_count", "computed_at", "canonical_version"],
  additionalProperties: false,
  properties: {
    idf: {
      type: "object",
      additionalProperties: { type: "number" },
    },
    segment_count: { type: "integer", minimum: 0 },
    computed_at: { type: "string", minLength: 1 },
    canonical_version: { type: "string", minLength: 1 },
  },
};

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function assertValid(validate, label, data) {
  const valid = validate(data);
  if (!valid) {
    console.error(`Validation failed for ${label}:`);
    console.error(validate.errors);
    process.exit(1);
  }
}

function assertJsonEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`Drift detected for ${label}`);
    process.exit(1);
  }
}

function extractFallbackPolicyFromTs(path) {
  const content = readFileSync(path, "utf-8");
  const marker = "export const FALLBACK_POLICY = ";
  const start = content.indexOf(marker);
  if (start < 0) {
    throw new Error(`Missing FALLBACK_POLICY export in ${path}`);
  }
  const jsonStart = start + marker.length;
  const jsonEnd = content.indexOf(" as const", jsonStart);
  if (jsonEnd < 0) {
    throw new Error(`Missing 'as const' suffix in ${path}`);
  }
  return JSON.parse(content.slice(jsonStart, jsonEnd));
}

const policySchema = loadJson(policySchemaPath);
const validatePolicy = ajv.compile(policySchema);
const validateCanonicalRow = ajv.compile(canonicalRowSchema);
const validateEvidenceStats = ajv.compile(evidenceStatsSchema);

const policy = loadJson(policyPath);
const defaultPolicy = loadJson(defaultPolicyPath);

console.log("Validating transcript-quality-policy.json");
assertValid(validatePolicy, "transcript-quality-policy.json", policy);

console.log("Validating default-policy.json");
assertValid(validatePolicy, "default-policy.json", defaultPolicy);

console.log("Validating FE transcriptQualityDefaults.json");
const feDefaults = loadJson(feDefaultsPath);
assertValid(validatePolicy, "transcriptQualityDefaults.json", feDefaults);
assertJsonEqual(feDefaults, defaultPolicy, "FE transcriptQualityDefaults.json vs default-policy.json");

console.log("Validating FE fallback-policy.ts");
const fallbackPolicy = extractFallbackPolicyFromTs(feFallbackPath);
assertValid(validatePolicy, "fallback-policy.ts", fallbackPolicy);
assertJsonEqual(fallbackPolicy, defaultPolicy, "FE fallback-policy.ts vs default-policy.json");

console.log("Validating processing-service classpath policy artifacts");
const processingPrimary = loadJson(processingPrimaryPath);
const processingDefault = loadJson(processingDefaultPath);
assertValid(validatePolicy, "processing transcript-quality-policy.json", processingPrimary);
assertValid(validatePolicy, "processing default-policy.json", processingDefault);
assertJsonEqual(processingPrimary, policy, "processing primary vs packages/contracts/transcript-quality-policy.json");
assertJsonEqual(processingDefault, defaultPolicy, "processing default vs packages/contracts/default-policy.json");

console.log("Checking JSONB fixture schemas");
assertValid(validateCanonicalRow, "canonical-transcript-row fixture", loadJson(join(fixturesDir, "canonical-transcript-row.json")));
assertValid(validateEvidenceStats, "evidence-stats fixture", loadJson(join(fixturesDir, "evidence-stats.json")));

console.log("Transcript quality policy validation passed.");
