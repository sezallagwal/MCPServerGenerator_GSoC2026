/** Fingerprints are how the generator tells its own output from a user's edits. */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MANIFEST_FILENAME = ".mcp-gen-manifest.json";

export const MANIFEST_VERSION = 1;

export interface ManifestEntry {
  /** Relative path using POSIX `/` separators. */
  path: string;
  fingerprint: string;
}

export interface Manifest {
  manifestVersion: number;
  /** Canonical form: sorted ascending by {@link ManifestEntry.path}. */
  files: ManifestEntry[];
}

/** Callers must pass exactly what reaches disk, or the record stops describing the file. */
export function computeFingerprint(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/** Not `localeCompare`: its host-dependent result would make one project differ per machine. */
function compareManifestPaths(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Sorted so identical inputs always yield an identical manifest. */
export function buildManifest(fingerprints: Map<string, string>): Manifest {
  const files: ManifestEntry[] = [...fingerprints].map(
    ([path, fingerprint]) => ({ path, fingerprint }),
  );
  files.sort((a, b) => compareManifestPaths(a.path, b.path));
  return { manifestVersion: MANIFEST_VERSION, files };
}

/** Canonical form only, so a parse round-trip stays byte-identical and shows no diff. */
export function serializeManifest(manifest: Manifest): string {
  const canonical: Manifest = {
    manifestVersion: manifest.manifestVersion,
    files: [...manifest.files].sort((a, b) =>
      compareManifestPaths(a.path, b.path),
    ),
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

/** `null`, never a throw: callers treat it as "no manifest" and preserve the user's files. */
export function parseManifest(text: string): Manifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }

  const obj = raw as { manifestVersion?: unknown; files?: unknown };
  if (obj.manifestVersion !== MANIFEST_VERSION) return null;
  if (!Array.isArray(obj.files)) return null;

  const files: ManifestEntry[] = [];
  for (const entry of obj.files) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return null;
    }
    const candidate = entry as { path?: unknown; fingerprint?: unknown };
    if (
      typeof candidate.path !== "string" ||
      typeof candidate.fingerprint !== "string"
    ) {
      return null;
    }
    files.push({ path: candidate.path, fingerprint: candidate.fingerprint });
  }

  return { manifestVersion: obj.manifestVersion, files };
}

/** `null` when missing, unreadable, or unparseable. Read-only and never throws. */
export function readManifest(outDir: string): Manifest | null {
  let text: string;
  try {
    text = readFileSync(join(outDir, MANIFEST_FILENAME), "utf-8");
  } catch {
    return null;
  }
  return parseManifest(text);
}

export function writeManifest(outDir: string, manifest: Manifest): void {
  writeFileSync(
    join(outDir, MANIFEST_FILENAME),
    serializeManifest(manifest),
    "utf-8",
  );
}
