const { execFileSync } = require("node:child_process");
const path = require("node:path");

const scriptPath = path.join(__dirname, "validate-policy.mjs");

describe("validate-policy", () => {
  it("validates transcript quality policy contracts without drift", () => {
    expect(() => {
      execFileSync(process.execPath, [scriptPath], {
        cwd: path.join(__dirname, "..", "..", ".."),
        stdio: "pipe",
        encoding: "utf-8",
      });
    }).not.toThrow();
  });
});
