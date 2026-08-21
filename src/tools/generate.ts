import { join } from "node:path";
import type { FullEndpoint } from "../parser/types.js";
import { applyPlatformTransforms, composeDsl } from "../generator/pipeline.js";
import { generateProject, sanitizeServerName } from "../generator/project.js";
import type { Transport } from "../generator/codegen.js";
import type { GeneratorEndpoint } from "../generator/types.js";
import {
  isWriteMode,
  writeProjectFiles,
  type WriteMode,
} from "../generator/write-project.js";
import type { PlatformAdapter } from "../platform/adapter.js";
import { RocketChatAdapter } from "../platform/rocketchat-adapter.js";

export interface GenerateArgs {
  dsl: string;
  /** Default: "./generated". */
  outputDir?: string;
  /** `additive` never overwrites a file the user has edited. Default `overwrite`. */
  writeMode?: WriteMode;
  /** `http` emits a Streamable HTTP server; `stdio` (default) emits a stdio one. */
  transport?: Transport;
  /** Target platform. Defaults to {@link RocketChatAdapter}. */
  adapter?: PlatformAdapter;
}

/** Locations are resolved here, where the spec is available, so the engine never guesses. */
function toGeneratorEndpoint(ep: FullEndpoint): GeneratorEndpoint {
  const queryParams = ep.parameters
    .filter((p) => p.in === "query")
    .map((p) => p.name);
  const headerParams = ep.parameters
    .filter((p) => p.in === "header")
    .map((p) => p.name);

  return {
    operationId: ep.operationId,
    method: ep.method,
    path: ep.path,
    summary: ep.summary,
    ...(queryParams.length > 0 ? { queryParams } : {}),
    ...(headerParams.length > 0 ? { headerParams } : {}),
    // An explicit empty `security: []` is the spec saying this one operation is public.
    ...(Array.isArray(ep.security) && ep.security.length === 0
      ? { auth: false }
      : {}),
  };
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

/** Endpoints resolve through the same adapter that drives codegen, so the two cannot diverge. */
export async function handleGenerate(args: GenerateArgs) {
  const adapter = args.adapter ?? new RocketChatAdapter();

  let composed;
  try {
    composed = composeDsl(args.dsl);
  } catch (err) {
    return fail(
      `DSL error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (composed.workflows.length === 0) {
    return fail("The DSL declared no workflows.");
  }

  // Before endpoint resolution: these rewrite operationIds the endpoint map must cover.
  try {
    applyPlatformTransforms(composed.workflows, adapter);
  } catch (err) {
    return fail(
      `${adapter.platformName} workflow adjustment failed: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const operationIds = [
    ...new Set(composed.workflows.flatMap((w) => w.requiredEndpoints)),
  ].filter(Boolean);

  let endpoints: GeneratorEndpoint[];
  let correctedIds: ReadonlyMap<string, string>;
  try {
    const resolved = await adapter.getFullEndpoints(operationIds);
    endpoints = resolved.endpoints.map(toGeneratorEndpoint);
    correctedIds = resolved.correctedIds;
  } catch (err) {
    return fail(
      `Failed to resolve endpoints: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // The parser auto-corrects near-misses, so map requested ids to what actually resolved.
  const resolvedIds = new Set(endpoints.map((ep) => ep.operationId));
  const actualFor = (id: string): string => correctedIds.get(id) ?? id;

  // Fail closed: generating anyway yields api_call steps that fall back to an empty GET.
  const unresolved = operationIds.filter(
    (id) => !resolvedIds.has(actualFor(id)),
  );
  if (unresolved.length > 0) {
    return fail(
      `Cannot generate: ${unresolved.length} operationId(s) could not be resolved to an endpoint: ` +
        `${unresolved.join(", ")}. ` +
        `Verify them with get_endpoint_schemas and fix the OPERATION lines in the DSL.`,
    );
  }

  // Rewrite corrected ids into the workflows, or the endpoint map will not contain them.
  const corrected: string[] = [];
  for (const workflow of composed.workflows) {
    for (const step of workflow.steps) {
      if (step.config.type === "api_call") {
        const actual = actualFor(step.config.operationId);
        if (actual !== step.config.operationId) {
          corrected.push(`${step.config.operationId} -> ${actual}`);
          step.config.operationId = actual;
        }
      }
    }
    // Two distinct ids can correct to the same endpoint, so re-deduplicate.
    workflow.requiredEndpoints = [
      ...new Set(workflow.requiredEndpoints.map(actualFor)),
    ];
  }

  let result;
  try {
    result = generateProject({
      serverName: composed.projectName,
      workflows: composed.workflows,
      endpoints,
      adapter,
      transport: args.transport,
    });
  } catch (err) {
    return fail(
      `Generation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const root = join(args.outputDir ?? "generated", result.summary.serverName);

  const writeMode = args.writeMode ?? "overwrite";
  if (!isWriteMode(writeMode)) {
    return fail(
      `Invalid writeMode: ${JSON.stringify(args.writeMode)}. ` +
        `Expected "overwrite" or "additive".`,
    );
  }

  let write;
  try {
    write = writeProjectFiles(root, result.files, writeMode);
  } catch (err) {
    return fail(
      `Failed to write project: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const lines = [
    `Generated MCP server "${result.summary.serverName}" at ${root}`,
    `  Platform: ${result.summary.platformName}`,
    `  Workflows: ${result.summary.workflowCount}`,
    `  Endpoints: ${result.summary.endpointCount}`,
    `  Files: ${result.files.length}`,
    `  Sampling: ${result.summary.usesSampling ? "yes" : "no"}, Elicitation: ${
      result.summary.usesElicitation ? "yes" : "no"
    }`,
    `  Transport: ${result.summary.transport}`,
    `  Write mode: ${write.writeMode}`,
  ];

  if (result.summary.transport === "http") {
    lines.push(
      `  NOTE: the HTTP server binds to 127.0.0.1 and has no authentication until ` +
        `MCP_AUTH_TOKEN is set in .env. Set it before exposing the port.`,
    );
  }

  if (write.writeMode === "additive") {
    lines.push(
      `  Added: ${write.added.length}, refreshed: ${write.overwritten.length}, ` +
        `preserved: ${write.preserved.length}, conflicts: ${write.conflicts.length}`,
    );
    if (write.added.length > 0) {
      lines.push(`  New files: ${write.added.join(", ")}`);
    }
    if (write.conflicts.length > 0) {
      lines.push(
        `  Kept your edits (not overwritten) — review if you want the new version:`,
      );
      for (const path of write.conflicts) lines.push(`    - ${path}`);
    }
    // Reported apart from user edits: nobody edited these, and a new tool needs them fresh.
    if (write.staleScaffold.length > 0) {
      lines.push(
        `  This project has no generator manifest, so generator-owned files could`,
        `  not be safely refreshed and are now STALE. Any newly added tool will`,
        `  fail until you re-run with writeMode "overwrite" (after saving edits):`,
      );
      for (const path of write.staleScaffold) lines.push(`    - ${path}`);
    }
    // A removed workflow leaves its tool and test behind, and that test now fails.
    if (write.orphaned.length > 0) {
      lines.push(
        `  No longer generated (left in place — delete them if the workflow is gone;`,
        `  the orphaned test will fail against the new endpoint map):`,
      );
      for (const path of write.orphaned) lines.push(`    - ${path}`);
    }
  }
  if (corrected.length > 0) {
    lines.push(`  Auto-corrected operationIds: ${corrected.join(", ")}`);
  }
  if (composed.warnings.length > 0) {
    lines.push(
      `  Composer notes (${composed.warnings.length}) — informational:`,
    );
    for (const w of composed.warnings.slice(0, 10)) {
      lines.push(`    - [${w.code}] ${w.message}`);
    }
  }

  return ok(lines.join("\n"));
}

export { sanitizeServerName };
