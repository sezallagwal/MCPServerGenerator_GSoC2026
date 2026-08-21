import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  classifyOutputDir,
  planAdditiveWrite,
  type WriteReport,
} from "./additive-write.js";
import {
  buildManifest,
  computeFingerprint,
  writeManifest,
} from "./manifest.js";
import type { GeneratedFile } from "./types.js";

export type WriteMode = "overwrite" | "additive";

export const WRITE_MODES = ["overwrite", "additive"] as const;

export function isWriteMode(value: unknown): value is WriteMode {
  return value === "overwrite" || value === "additive";
}

/** Only matters with no manifest, where stale scaffold still has to be reported. */
export function isScaffoldPath(path: string): boolean {
  return path === "src/endpoints.ts" || path.startsWith("src/engine/");
}

export interface WriteProjectResult extends WriteReport {
  outDir: string;
  writeMode: WriteMode;
}

/** The manifest is written last, so a partial failure leaves the previous one intact. */
export function writeProjectFiles(
  outDir: string,
  files: GeneratedFile[],
  writeMode: WriteMode = "overwrite",
): WriteProjectResult {
  if (typeof outDir !== "string" || outDir.trim() === "") {
    throw new Error(`Invalid output directory: ${JSON.stringify(outDir)}`);
  }
  if (!isWriteMode(writeMode)) {
    throw new Error(
      `Invalid write mode: ${JSON.stringify(writeMode)}. ` +
        `Expected "overwrite" or "additive".`,
    );
  }

  const writeSet = new Map(files.map((f) => [f.path, f.content]));
  const fingerprints = new Map<string, string>();
  for (const [path, content] of writeSet) {
    fingerprints.set(path, computeFingerprint(content));
  }

  const resolvedOutDir = resolve(outDir);

  const resolveInside = (relPath: string): string => {
    const full = resolve(join(outDir, relPath));
    if (full !== resolvedOutDir && !full.startsWith(resolvedOutDir + sep)) {
      throw new Error(
        `Path traversal detected: "${relPath}" resolves outside the output directory.`,
      );
    }
    return full;
  };

  const writeFile = (relPath: string, content: string): void => {
    const full = resolveInside(relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf-8");
  };

  // Validate everything first, so a hostile path cannot write before the next is rejected.
  for (const path of writeSet.keys()) resolveInside(path);

  const readOnDisk = (path: string): string | null => {
    try {
      return readFileSync(resolveInside(path), "utf-8");
    } catch {
      return null;
    }
  };

  if (writeMode === "overwrite") {
    // Report only genuinely new paths, so a first run does not claim to have "refreshed".
    const added: string[] = [];
    const overwritten: string[] = [];
    for (const [path, content] of writeSet) {
      (existsSync(resolveInside(path)) ? overwritten : added).push(path);
      writeFile(path, content);
    }
    writeManifest(outDir, buildManifest(fingerprints));
    return {
      outDir,
      writeMode,
      added,
      overwritten,
      preserved: [],
      conflicts: [],
      staleScaffold: [],
      orphaned: [],
    };
  }

  // Always through the planner: blanket-overwriting a non-generated directory destroys work.
  const classification = classifyOutputDir(outDir);

  const scaffoldPaths = new Set<string>();
  for (const path of writeSet.keys()) {
    if (isScaffoldPath(path)) scaffoldPaths.add(path);
  }

  const plan = planAdditiveWrite({
    writeSet,
    fingerprints,
    classification,
    scaffoldPaths,
    readOnDisk,
  });

  for (const action of plan.actions) {
    if (action.kind === "add" || action.kind === "overwrite") {
      writeFile(action.path, action.content);
    }
  }

  writeManifest(outDir, plan.nextManifest);

  return { outDir, writeMode, ...plan.report };
}
