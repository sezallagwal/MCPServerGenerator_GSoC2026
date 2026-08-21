import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyOutputDir,
  planAdditiveWrite,
  type ProjectClassification,
} from "../../generator/additive-write.js";
import {
  buildManifest,
  computeFingerprint,
  MANIFEST_FILENAME,
} from "../../generator/manifest.js";
import { writeProjectFiles } from "../../generator/write-project.js";

/** Pinned at both levels: the data-loss defect was in the caller that bypassed the planner. */

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mcpgen-additive-"));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function planInput(
  writeSet: Record<string, string>,
  classification: ProjectClassification,
  onDisk: Record<string, string> = {},
  scaffoldPaths: string[] = [],
) {
  const set = new Map(Object.entries(writeSet));
  const fingerprints = new Map(
    [...set].map(([p, c]) => [p, computeFingerprint(c)]),
  );
  return {
    writeSet: set,
    fingerprints,
    classification,
    scaffoldPaths: new Set(scaffoldPaths),
    readOnDisk: (path: string) =>
      Object.prototype.hasOwnProperty.call(onDisk, path) ? onDisk[path] : null,
  };
}

function manifestFor(entries: Record<string, string>): ProjectClassification {
  return {
    kind: "with-manifest",
    manifest: buildManifest(
      new Map(
        Object.entries(entries).map(([p, c]) => [p, computeFingerprint(c)]),
      ),
    ),
  };
}

describe("planAdditiveWrite decision table", () => {
  it("adds a file that is absent on disk, whatever the classification", () => {
    for (const classification of [
      { kind: "none" } as const,
      { kind: "legacy" } as const,
      manifestFor({}),
    ]) {
      const plan = planAdditiveWrite(
        planInput({ "src/new.ts": "fresh" }, classification),
      );
      assert.deepEqual(plan.report.added, ["src/new.ts"]);
      assert.deepEqual(plan.actions, [
        { kind: "add", path: "src/new.ts", content: "fresh" },
      ]);
    }
  });

  it("overwrites a file whose bytes still match the recorded fingerprint", () => {
    const plan = planAdditiveWrite(
      planInput(
        { "src/tool.ts": "next" },
        manifestFor({ "src/tool.ts": "generated" }),
        { "src/tool.ts": "generated" },
      ),
    );
    assert.deepEqual(plan.report.overwritten, ["src/tool.ts"]);
    assert.deepEqual(plan.report.conflicts, []);
  });

  it("conflicts on a file that no longer matches its fingerprint", () => {
    const plan = planAdditiveWrite(
      planInput(
        { "src/tool.ts": "next" },
        manifestFor({ "src/tool.ts": "generated" }),
        { "src/tool.ts": "generated\n// my edit\n" },
      ),
    );
    assert.deepEqual(plan.report.conflicts, ["src/tool.ts"]);
    assert.deepEqual(plan.report.overwritten, []);
  });

  it("conflicts on a file the manifest does not mention", () => {
    const plan = planAdditiveWrite(
      planInput({ "src/mine.ts": "next" }, manifestFor({}), {
        "src/mine.ts": "hand written",
      }),
    );
    assert.deepEqual(plan.report.conflicts, ["src/mine.ts"]);
  });

  it("retains the PRIOR fingerprint for a conflict, so the next run still preserves it", () => {
    const priorFingerprint = computeFingerprint("generated");
    const plan = planAdditiveWrite(
      planInput(
        { "src/tool.ts": "next" },
        manifestFor({ "src/tool.ts": "generated" }),
        { "src/tool.ts": "edited by the user" },
      ),
    );
    const entry = plan.nextManifest.files.find((f) => f.path === "src/tool.ts");
    assert.equal(
      entry?.fingerprint,
      priorFingerprint,
      "recording the freshly generated fingerprint would make the next run " +
        "believe the user's file was generator-written and overwrite it",
    );
  });
});

describe("planAdditiveWrite never overwrites an unrecognized directory", () => {
  /** `none` is not "empty": an unrelated directory lands here, so overwriting destroys work. */
  it("conflicts on an existing file rather than replacing it", () => {
    const plan = planAdditiveWrite(
      planInput(
        { "src/a.ts": "GENERATED" },
        { kind: "none" },
        {
          "src/a.ts": "MY IMPORTANT WORK",
        },
      ),
    );
    assert.deepEqual(plan.report.conflicts, ["src/a.ts"]);
    assert.deepEqual(plan.report.overwritten, []);
    assert.ok(
      !plan.actions.some((a) => a.kind === "overwrite"),
      "an unrecognized directory must never produce an overwrite action",
    );
  });

  it("still writes everything into a genuinely empty directory", () => {
    const plan = planAdditiveWrite(
      planInput({ "src/a.ts": "one", "src/b.ts": "two" }, { kind: "none" }, {}),
    );
    assert.deepEqual(plan.report.added.sort(), ["src/a.ts", "src/b.ts"]);
    assert.deepEqual(plan.report.conflicts, []);
  });
});

describe("planAdditiveWrite reporting", () => {
  it("reports files the previous manifest recorded but this run no longer generates", () => {
    const plan = planAdditiveWrite(
      planInput(
        { "src/tools/one.ts": "next" },
        manifestFor({
          "src/tools/one.ts": "generated",
          "src/tools/two.ts": "generated",
          "src/tests/two.test.ts": "generated",
        }),
        {
          "src/tools/one.ts": "generated",
          "src/tools/two.ts": "generated",
          "src/tests/two.test.ts": "generated",
        },
      ),
    );
    assert.deepEqual(plan.report.orphaned.sort(), [
      "src/tests/two.test.ts",
      "src/tools/two.ts",
    ]);
    assert.ok(
      !plan.actions.some((a) => a.path.includes("two")),
      "orphans are reported, never touched",
    );
  });

  it("does not report an orphan that is already gone from disk", () => {
    const plan = planAdditiveWrite(
      planInput(
        { "src/tools/one.ts": "next" },
        manifestFor({
          "src/tools/one.ts": "generated",
          "src/tools/two.ts": "generated",
        }),
        { "src/tools/one.ts": "generated" },
      ),
    );
    assert.deepEqual(plan.report.orphaned, []);
  });

  it("separates stale generator scaffold from the user's own edits", () => {
    const plan = planAdditiveWrite(
      planInput(
        { "src/endpoints.ts": "next", "README.md": "next" },
        { kind: "legacy" },
        { "src/endpoints.ts": "old", "README.md": "old" },
        ["src/endpoints.ts"],
      ),
    );
    assert.deepEqual(plan.report.staleScaffold, ["src/endpoints.ts"]);
    assert.deepEqual(
      plan.report.conflicts,
      [],
      "generator-owned scaffold must not be reported as the user's edits",
    );
    assert.deepEqual(plan.report.preserved, ["README.md"]);
  });
});

describe("classifyOutputDir", () => {
  it("returns with-manifest when a parseable manifest is present", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, MANIFEST_FILENAME),
      JSON.stringify({ manifestVersion: 1, files: [] }),
      "utf-8",
    );
    assert.equal(classifyOutputDir(dir).kind, "with-manifest");
  });

  it("falls back to legacy — not none — when the manifest is corrupt", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "server.ts"), "// generated", "utf-8");
    writeFileSync(join(dir, MANIFEST_FILENAME), "{ not json", "utf-8");
    assert.equal(
      classifyOutputDir(dir).kind,
      "legacy",
      "a corrupt manifest must degrade to preserving files, not to overwriting them",
    );
  });

  it("returns none for a directory holding no generated project", () => {
    assert.equal(classifyOutputDir(tempDir()).kind, "none");
  });
});

describe("writeProjectFiles in additive mode", () => {
  /** Additive short-circuited `none` into a blanket overwrite and reported zero conflicts. */
  it("preserves existing work in a directory that is not a generated project", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "MY IMPORTANT WORK", "utf-8");
    writeFileSync(join(dir, "notes.txt"), "keep me", "utf-8");

    const result = writeProjectFiles(
      dir,
      [{ path: "src/a.ts", content: "GENERATED" }],
      "additive",
    );

    assert.equal(
      readFileSync(join(dir, "src", "a.ts"), "utf-8"),
      "MY IMPORTANT WORK",
    );
    assert.deepEqual(result.conflicts, ["src/a.ts"]);
    assert.deepEqual(result.overwritten, []);
    assert.equal(
      readFileSync(join(dir, "notes.txt"), "utf-8"),
      "keep me",
      "a file outside the write set is never visited",
    );
  });

  it("writes everything into an empty directory and records a manifest", () => {
    const dir = tempDir();
    const result = writeProjectFiles(
      dir,
      [{ path: "src/a.ts", content: "one" }],
      "additive",
    );
    assert.deepEqual(result.added, ["src/a.ts"]);
    assert.equal(readFileSync(join(dir, "src", "a.ts"), "utf-8"), "one");
    assert.equal(classifyOutputDir(dir).kind, "with-manifest");
  });

  it("round-trips: a generated file is refreshed, an edited one is preserved", () => {
    const dir = tempDir();
    writeProjectFiles(
      dir,
      [
        { path: "src/keep.ts", content: "v1" },
        { path: "src/edited.ts", content: "v1" },
      ],
      "overwrite",
    );
    writeFileSync(join(dir, "src", "edited.ts"), "v1 + my edit", "utf-8");

    const second = writeProjectFiles(
      dir,
      [
        { path: "src/keep.ts", content: "v2" },
        { path: "src/edited.ts", content: "v2" },
      ],
      "additive",
    );

    assert.deepEqual(second.overwritten, ["src/keep.ts"]);
    assert.deepEqual(second.conflicts, ["src/edited.ts"]);
    assert.equal(readFileSync(join(dir, "src", "keep.ts"), "utf-8"), "v2");
    assert.equal(
      readFileSync(join(dir, "src", "edited.ts"), "utf-8"),
      "v1 + my edit",
    );

    // Idempotency: the retained prior fingerprint must keep the edit safe.
    const third = writeProjectFiles(
      dir,
      [
        { path: "src/keep.ts", content: "v2" },
        { path: "src/edited.ts", content: "v2" },
      ],
      "additive",
    );
    assert.deepEqual(third.conflicts, ["src/edited.ts"]);
    assert.equal(
      readFileSync(join(dir, "src", "edited.ts"), "utf-8"),
      "v1 + my edit",
    );
  });

  it("refuses a path that escapes the output directory, before writing anything", () => {
    const dir = tempDir();
    assert.throws(
      () =>
        writeProjectFiles(
          dir,
          [
            { path: "src/ok.ts", content: "fine" },
            { path: "../escaped.ts", content: "hostile" },
          ],
          "overwrite",
        ),
      /Path traversal/,
    );
    assert.equal(
      classifyOutputDir(dir).kind,
      "none",
      "validation runs before any file is written",
    );
  });
});
