/** Directory classification and the merge planner. {@link planAdditiveWrite} does no I/O. */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  buildManifest,
  computeFingerprint,
  readManifest,
  type Manifest,
} from "./manifest.js";

export type ProjectClassification =
  | { kind: "with-manifest"; manifest: Manifest }
  /** Predates the manifest, or its manifest is corrupt. */
  | { kind: "legacy" }
  | { kind: "none" };

/** Manifest -> `with-manifest`; else a `src/server.ts` -> `legacy`; else `none`. Never throws. */
export function classifyOutputDir(outDir: string): ProjectClassification {
  const manifest = readManifest(outDir);
  if (manifest !== null) {
    return { kind: "with-manifest", manifest };
  }
  if (existsSync(join(outDir, "src", "server.ts"))) {
    return { kind: "legacy" };
  }
  return { kind: "none" };
}

/** Disjoint outcome lists partitioning the visited write set, by relative path. */
export interface WriteReport {
  added: string[];
  /** Existing files replaced, having matched their recorded fingerprint. */
  overwritten: string[];
  preserved: string[];
  /** Left alone because they could not be proven generator-written. */
  conflicts: string[];
  /** Unedited generator scaffold, stale for want of a manifest: a new tool needs it refreshed. */
  staleScaffold: string[];
  /** Recorded last run but no longer generated. Left on disk, reported because its test fails. */
  orphaned: string[];
}

export type FileAction =
  | { kind: "add"; path: string; content: string }
  | { kind: "overwrite"; path: string; content: string }
  | { kind: "preserve"; path: string }
  | { kind: "conflict"; path: string }
  | { kind: "stale-scaffold"; path: string };

export interface AdditivePlan {
  /** In write-set iteration order. */
  actions: FileAction[];
  report: WriteReport;
  /** Record only after every action has been applied. */
  nextManifest: Manifest;
}

export interface PlanAdditiveWriteInput {
  writeSet: Map<string, string>;
  fingerprints: Map<string, string>;
  classification: ProjectClassification;
  scaffoldPaths: ReadonlySet<string>;
  /** `null` when the file is absent. */
  readOnDisk: (path: string) => string | null;
}

/** Only replace a file whose bytes still match its recorded fingerprint; the rest is conflict. */
export function planAdditiveWrite(input: PlanAdditiveWriteInput): AdditivePlan {
  const { writeSet, fingerprints, classification, scaffoldPaths, readOnDisk } =
    input;

  const priorEntries = new Map<string, string>();
  if (classification.kind === "with-manifest") {
    for (const entry of classification.manifest.files) {
      priorEntries.set(entry.path, entry.fingerprint);
    }
  }

  const actions: FileAction[] = [];
  const report: WriteReport = {
    added: [],
    overwritten: [],
    preserved: [],
    conflicts: [],
    staleScaffold: [],
    orphaned: [],
  };
  const nextFingerprints = new Map<string, string>();

  // Left on disk but reported, so a removed workflow leaves no silently failing test.
  for (const path of priorEntries.keys()) {
    if (!writeSet.has(path) && readOnDisk(path) !== null) {
      report.orphaned.push(path);
    }
  }

  for (const [path, content] of writeSet) {
    const newFingerprint =
      fingerprints.get(path) ?? computeFingerprint(content);
    const onDisk = readOnDisk(path);

    // Nothing to lose: this is what lets new tools land without disturbing old ones.
    if (onDisk === null) {
      actions.push({ kind: "add", path, content });
      report.added.push(path);
      nextFingerprints.set(path, newFingerprint);
      continue;
    }

    if (classification.kind === "none") {
      // `none` does not mean empty: overwriting an unrelated directory destroys real work.
      actions.push({ kind: "conflict", path });
      report.conflicts.push(path);
      continue;
    }

    if (classification.kind === "legacy") {
      // Nothing is provable without a manifest, but nobody edits scaffold, so report it apart.
      if (scaffoldPaths.has(path)) {
        actions.push({ kind: "stale-scaffold", path });
        report.staleScaffold.push(path);
      } else {
        // Not listed per file: here everything is preserved, so the counts suffice.
        actions.push({ kind: "preserve", path });
        report.preserved.push(path);
      }
      // Omitted from the next manifest, so it stays preserved on future runs.
      continue;
    }

    const recorded = priorEntries.get(path);
    if (recorded === undefined) {
      // Unmentioned by the manifest, so the user created it.
      actions.push({ kind: "conflict", path });
      report.conflicts.push(path);
      continue;
    }

    if (computeFingerprint(onDisk) === recorded) {
      actions.push({ kind: "overwrite", path, content });
      report.overwritten.push(path);
      nextFingerprints.set(path, newFingerprint);
    } else {
      actions.push({ kind: "conflict", path });
      report.conflicts.push(path);
      // The PRIOR fingerprint: a fresh one would make the next run claim the user's file.
      nextFingerprints.set(path, recorded);
    }
  }

  return { actions, report, nextManifest: buildManifest(nextFingerprints) };
}
