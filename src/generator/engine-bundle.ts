import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GeneratedFile } from "./types.js";

/**
 * Vendored verbatim, so a generated server runs the exact engine this package tests.
 * `index.ts`/`types.ts` are excluded because the barrel re-exports the composer.
 */
export const ENGINE_MODULES = [
  "types.ts",
  "expression-security.ts",
  "templates.ts",
  "api-call.ts",
  "sampling.ts",
  "executor.ts",
] as const;

const ENGINE_INDEX = `export * from "./types.js";
export * from "./expression-security.js";
export * from "./templates.js";
export * from "./api-call.js";
export * from "./sampling.js";
export * from "./executor.js";
`;

function findPackageRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return startDir;
    dir = parent;
  }
}

/** First candidate holding the engine sources wins: tsx `src/`, built `dist/`, then `src/`. */
export function workflowDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "workflow"),
    join(findPackageRoot(here), "src", "workflow"),
  ];
  const probe = ENGINE_MODULES[0];
  for (const dir of candidates) {
    if (existsSync(join(dir, probe))) return dir;
  }
  // Return the primary candidate, so the caller's ENOENT names the missing engine source.
  return candidates[0];
}

/** The engine sources as generated files under `src/engine/`, plus a slim barrel. */
export function bundleEngine(): GeneratedFile[] {
  const dir = workflowDir();
  const files: GeneratedFile[] = ENGINE_MODULES.map((name) => ({
    path: `src/engine/${name}`,
    content: readFileSync(join(dir, name), "utf8"),
  }));
  files.push({ path: "src/engine/index.ts", content: ENGINE_INDEX });
  return files;
}
