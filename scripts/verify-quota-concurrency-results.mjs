#!/usr/bin/env node
/**
 * Asserts Surefire results for QuotaConcurrencyTest:
 * tests=3, skipped=0, failures=0, errors=0.
 *
 * Usage (from repo root, after mvn -Pquota-postgres-it test):
 *   node scripts/verify-quota-concurrency-results.mjs
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const REPORT_DIRS = [
  join(ROOT, "demoRecordAUDIOMID", "user-service", "target", "surefire-reports"),
  join(ROOT, "demoRecordAUDIOMID", "target", "surefire-reports"),
];

const TEST_CLASS = "QuotaConcurrencyTest";
const EXPECTED = { tests: 3, skipped: 0, failures: 0, errors: 0 };

function findReportFiles() {
  const matches = [];
  for (const dir of REPORT_DIRS) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      if (
        name.includes(TEST_CLASS) &&
        (name.endsWith(".xml") || name.endsWith(".txt"))
      ) {
        matches.push(join(dir, name));
      }
    }
  }
  return matches;
}

function attrInt(tag, attr, fallback = null) {
  const m = tag.match(new RegExp(`\\b${attr}="(\\d+)"`));
  return m ? Number(m[1]) : fallback;
}

function parseXmlCounts(xml) {
  const open = xml.match(/<testsuite\b[^>]*>/);
  if (!open) return null;
  const tag = open[0];
  const tests = attrInt(tag, "tests");
  const failures = attrInt(tag, "failures");
  const errors = attrInt(tag, "errors");
  const skipped = attrInt(tag, "skipped", attrInt(tag, "ignored", 0));
  if (tests == null || failures == null || errors == null) return null;
  return { tests, skipped, failures, errors };
}

function parseTxtCounts(txt) {
  // e.g. "Tests run: 3, Failures: 0, Errors: 0, Skipped: 0"
  const m = txt.match(
    /Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)/i
  );
  if (!m) return null;
  return {
    tests: Number(m[1]),
    failures: Number(m[2]),
    errors: Number(m[3]),
    skipped: Number(m[4]),
  };
}

function parseCounts(filePath) {
  const body = readFileSync(filePath, "utf8");
  if (filePath.endsWith(".xml")) return parseXmlCounts(body);
  return parseTxtCounts(body);
}

function main() {
  const files = findReportFiles();
  if (files.length === 0) {
    console.error(
      `ERROR: No Surefire report found for ${TEST_CLASS}. Looked in:\n` +
        REPORT_DIRS.map((d) => `  - ${d}`).join("\n")
    );
    process.exit(1);
  }

  const xmlFiles = files.filter((f) => f.endsWith(".xml"));
  const chosen = xmlFiles[0] || files[0];
  const counts = parseCounts(chosen);

  if (!counts) {
    console.error(`ERROR: Could not parse Surefire counts from ${chosen}`);
    process.exit(1);
  }

  console.log(`Surefire report: ${chosen}`);
  console.log(
    `Parsed: tests=${counts.tests} skipped=${counts.skipped} failures=${counts.failures} errors=${counts.errors}`
  );

  const ok =
    counts.tests === EXPECTED.tests &&
    counts.skipped === EXPECTED.skipped &&
    counts.failures === EXPECTED.failures &&
    counts.errors === EXPECTED.errors;

  if (!ok) {
    console.error(
      `ERROR: Expected tests=${EXPECTED.tests}, skipped=${EXPECTED.skipped}, ` +
        `failures=${EXPECTED.failures}, errors=${EXPECTED.errors}; ` +
        `got tests=${counts.tests}, skipped=${counts.skipped}, ` +
        `failures=${counts.failures}, errors=${counts.errors}`
    );
    process.exit(1);
  }

  console.log(`OK: ${TEST_CLASS} Surefire gate passed`);
}

main();
