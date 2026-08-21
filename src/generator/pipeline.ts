import { composeWorkflowDefinition } from "../composer/index.js";
import type { ComposerWarning } from "../composer/types.js";
import { parseDsl } from "../dsl/index.js";
import type { WorkflowDefinition } from "../workflow/types.js";
import type { PlatformAdapter } from "../platform/adapter.js";
import { RocketChatAdapter } from "../platform/rocketchat-adapter.js";
import { dslWorkflowToComposeInput } from "./dsl-mapping.js";
import { generateProject } from "./project.js";
import type { Transport } from "./codegen.js";
import type { GeneratorEndpoint, GenerateProjectResult } from "./types.js";

export interface ComposeDslResult {
  projectName: string;
  description: string;
  workflows: WorkflowDefinition[];
  warnings: ComposerWarning[];
}

export function composeDsl(dsl: string): ComposeDslResult {
  const parsed = parseDsl(dsl);
  const workflows: WorkflowDefinition[] = [];
  const warnings: ComposerWarning[] = [];

  for (const wf of parsed.workflows) {
    const result = composeWorkflowDefinition(dslWorkflowToComposeInput(wf));
    workflows.push(result.workflow);
    warnings.push(...result.warnings);
  }

  return {
    projectName: parsed.projectName,
    description: parsed.description,
    workflows,
    warnings,
  };
}

/** Must run before endpoints resolve: a remap changes which operationIds the map must cover. */
export function applyPlatformTransforms(
  workflows: WorkflowDefinition[],
  adapter: PlatformAdapter,
): void {
  adapter.normalizeOperations(workflows);
}

/** Offline registry from operationIds alone. Fails closed: a guessed route only fails live. */
export function deriveEndpoints(
  workflows: WorkflowDefinition[],
  adapter: PlatformAdapter,
): GeneratorEndpoint[] {
  const ids = new Set<string>();
  for (const workflow of workflows) {
    for (const id of workflow.requiredEndpoints) {
      if (id) ids.add(id);
    }
  }

  const endpoints: GeneratorEndpoint[] = [];
  const unresolved: string[] = [];
  for (const operationId of ids) {
    const derived = adapter.deriveEndpointFromOperationId(operationId);
    if (!derived) {
      unresolved.push(operationId);
      continue;
    }
    endpoints.push({ operationId, ...derived });
  }

  if (unresolved.length > 0) {
    throw new Error(
      `Cannot derive endpoints for ${unresolved.length} operationId(s) against ` +
        `${adapter.platformName}: ${unresolved.join(", ")}. ` +
        `Fix the OPERATION lines in the DSL, or pass a resolved endpoint list.`,
    );
  }

  return endpoints;
}

export interface GenerateFromDslOptions {
  /** Derived from the operationIds through the adapter when omitted. */
  endpoints?: GeneratorEndpoint[];
  /** Override the server name (defaults to the DSL PROJECT name). */
  serverName?: string;
  /** Target platform. Defaults to {@link RocketChatAdapter}. */
  adapter?: PlatformAdapter;
  /** Transport the generated server should serve on. Defaults to `stdio`. */
  transport?: Transport;
}

export interface GenerateFromDslResult extends GenerateProjectResult {
  warnings: ComposerWarning[];
}

/** Full pipeline: DSL text -> parsed -> composed -> generated project files. */
export function generateFromDsl(
  dsl: string,
  options: GenerateFromDslOptions = {},
): GenerateFromDslResult {
  const adapter = options.adapter ?? new RocketChatAdapter();
  const composed = composeDsl(dsl);

  applyPlatformTransforms(composed.workflows, adapter);

  const endpoints =
    options.endpoints ?? deriveEndpoints(composed.workflows, adapter);

  const result = generateProject({
    serverName: options.serverName ?? composed.projectName,
    workflows: composed.workflows,
    endpoints,
    adapter,
    transport: options.transport,
  });
  return { ...result, warnings: composed.warnings };
}
