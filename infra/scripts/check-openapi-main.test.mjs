import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { runOpenApiDiff } from "./check-openapi-main.mjs";

const treeRef = "#/components/schemas/StudyFolderTreeNode";

function contractFixture() {
  return {
    openapi: "3.0.3",
    info: { title: "Checker fixture", version: "1.0.0" },
    paths: {
      "/study-folders/tree": {
        get: {
          responses: {
            200: {
              description: "Tree",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/StudyFolderTreeResponse" },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        SubjectSummaryResponse: {
          type: "object",
          required: ["id", "name"],
          properties: {
            id: { type: "integer", format: "int64" },
            name: { type: "string" },
          },
        },
        StudyFolderTreeNode: {
          type: "object",
          required: ["id", "name", "children", "subjects"],
          properties: {
            id: { type: "integer", format: "int64" },
            name: { type: "string" },
            children: {
              type: "array",
              items: { $ref: treeRef },
            },
            subjects: {
              type: "array",
              items: { $ref: "#/components/schemas/SubjectSummaryResponse" },
            },
          },
        },
        StudyFolderTreeResponse: {
          type: "object",
          required: ["folders", "rootSubjects"],
          properties: {
            folders: {
              type: "array",
              items: { $ref: treeRef },
            },
            rootSubjects: {
              type: "array",
              items: { $ref: "#/components/schemas/SubjectSummaryResponse" },
            },
          },
        },
      },
    },
  };
}

async function withTempDir(callback) {
  // Keep fixtures on the repository drive: openapi-diff 0.24.1 treats
  // cross-drive Windows absolute paths as unsupported URL protocols.
  const dir = mkdtempSync(join(process.cwd(), "tmp-openapi-check-"));
  try {
    return await callback(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeContract(path, document) {
  writeFileSync(path, JSON.stringify(document));
}

async function assertBreakingChange(mutator) {
  await withTempDir(async (dir) => {
    const baseline = contractFixture();
    const current = structuredClone(baseline);
    mutator(current);
    const baselinePath = join(dir, "baseline.json");
    const currentPath = join(dir, "current.json");
    writeContract(baselinePath, baseline);
    writeContract(currentPath, current);
    await assert.rejects(() => runOpenApiDiff(baselinePath, currentPath, {
      printOutput: false,
    }));
  });
}

test("unchanged recursive tree passes", async () => {
  await withTempDir(async (dir) => {
    const baselinePath = join(dir, "baseline.json");
    const currentPath = join(dir, "current.json");
    const fixture = contractFixture();
    writeContract(baselinePath, fixture);
    writeContract(currentPath, fixture);
    await assert.doesNotReject(() => runOpenApiDiff(baselinePath, currentPath, {
      printOutput: false,
    }));
  });
});

test("removing a required subject field remains a breaking change", async () => {
  await assertBreakingChange((current) => {
    delete current.components.schemas.SubjectSummaryResponse.properties.name;
  });
});

test("changing an endpoint method remains a breaking change", async () => {
  await assertBreakingChange((current) => {
    const operation = current.paths["/study-folders/tree"].get;
    delete current.paths["/study-folders/tree"].get;
    current.paths["/study-folders/tree"].post = operation;
  });
});

test("removing a response property remains a breaking change", async () => {
  await assertBreakingChange((current) => {
    delete current.components.schemas.StudyFolderTreeResponse.properties.rootSubjects;
  });
});

test("unrelated parser errors are not swallowed", async () => {
  await withTempDir(async (dir) => {
    const validPath = join(dir, "valid.json");
    const invalidPath = join(dir, "invalid.json");
    writeContract(validPath, contractFixture());
    writeFileSync(invalidPath, "{ definitely-not-openapi");
    await assert.rejects(() => runOpenApiDiff(validPath, invalidPath, {
      printOutput: false,
    }));
  });
});

test("removing a recursive child property remains a breaking change", async () => {
  await assertBreakingChange((current) => {
    delete current.components.schemas.StudyFolderTreeNode.properties.subjects;
  });
});
