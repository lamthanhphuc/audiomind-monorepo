import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const specs = ["meeting-api.yaml", "processing-api.yaml", "ai-api.yaml"];

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
    const heads = run("git ls-remote --heads origin main").trim();
    if (!heads) {
      return false;
    }
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

function main() {
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

      execSync(`npx openapi-diff \"${baselinePath}\" \"${current}\"`, {
        stdio: "inherit"
      });
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main();
