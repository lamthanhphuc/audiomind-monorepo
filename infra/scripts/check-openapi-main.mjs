import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runOasdiffBreaking } from "@oasdiff-js/oasdiff-js";

const specs = ["meeting-api.yaml", "processing-api.yaml", "ai-api.yaml", "user-api.yaml"];

function run(cmd, options = {}) {
  return execSync(cmd, { stdio: "pipe", encoding: "utf8", ...options });
}

function canUseGitOriginMain() {
  try {
    run("git rev-parse --is-inside-work-tree");
  } catch {
    return false;
  }

  try {
    run("git rev-parse --verify origin/main");
    return true;
  } catch {
    try {
      run("git fetch origin main", { stdio: "inherit" });
      return true;
    } catch {
      return false;
    }
  }
}

export async function runOpenApiDiff(baselinePath, currentPath, options = {}) {
  const result = await runOasdiffBreaking(baselinePath, currentPath);
  if (options.printOutput !== false) {
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
  }
  if (result.exitCode !== 0 || result.changes.length > 0) {
    const detail = result.stderr
      || result.stdout
      || JSON.stringify(result.changes, null, 2)
      || "breaking changes detected";
    throw new Error(
      `oasdiff found ${result.changes.length} breaking change(s), exit code ${result.exitCode}: ${detail}`,
    );
  }
  return result;
}

export async function main() {
  const hasGitBaseline = canUseGitOriginMain();
  const tempDir = join("packages", "contracts", ".openapi-baseline");
  mkdirSync(tempDir, { recursive: true });

  try {
    for (const spec of specs) {
      const current = `packages/contracts/${spec}`;
      const baselinePath = `${tempDir}/${spec}`;

      if (hasGitBaseline) {
        try {
          const baselineContent = run(`git show origin/main:packages/contracts/${spec}`);
          writeFileSync(baselinePath, baselineContent, "utf8");
        } catch {
          console.log(`No baseline file found on origin/main for ${spec}. Trying snapshot baseline.`);
        }
      }

      if (!existsSync(baselinePath)) {
        const snapshotPath = join("packages", "contracts", "snapshots", spec);
        if (!existsSync(snapshotPath)) {
          console.log(`No baseline available for ${spec}. Skipping breaking check for this spec.`);
          continue;
        }
        copyFileSync(snapshotPath, baselinePath);
      }

      await runOpenApiDiff(baselinePath, current);
      console.log(`No breaking OpenAPI changes: ${spec}`);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  await main();
}
