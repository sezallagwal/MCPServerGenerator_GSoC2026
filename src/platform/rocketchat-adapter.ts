import type { OpenAPIV3 } from "openapi-types";
import type {
  CompactEndpoint,
  GetFullEndpointsResult,
  SpecParserInterface,
  SpecSource,
} from "../parser/types.js";
import { VALID_DOMAINS } from "../parser/types.js";
import { assertDomains, SpecParser } from "../parser/spec-parser.js";
import { OpenApiSpecSource } from "../parser/spec-source.js";
import type { WorkflowDefinition } from "../workflow/types.js";
import type { GeneratorEndpoint } from "../generator/types.js";
import { deriveEndpointFromOperationId } from "../generator/derive-endpoint.js";
import { deriveRequiredPermissions } from "../generator/permissions.js";
import type { CapabilityGuideHints } from "../tools/capability-guide.js";
import {
  ROCKETCHAT_DOMAIN_NOTES,
  ROCKETCHAT_ENDPOINT_ANNOTATIONS,
} from "../tools/capability-guide.js";
import {
  generateEnvExample,
  generateReadme,
  generateRcClient,
} from "../generator/scaffold.js";
import type { PlatformAdapter } from "./adapter.js";

/** Rocket.Chat splits public rooms ("channels") from private ("groups"); these are the pairs. */
const CHANNEL_GROUP_PAIRS: Record<string, string> = {
  "post-api-v1-channels_create": "post-api-v1-groups_create",
  "post-api-v1-channels_invite": "post-api-v1-groups_invite",
  "get-api-v1-channels_info": "get-api-v1-groups_info",
  "post-api-v1-groups_create": "post-api-v1-channels_create",
  "post-api-v1-groups_invite": "post-api-v1-channels_invite",
  "get-api-v1-groups_info": "get-api-v1-channels_info",
};

// `channels_join` has no counterpart: Rocket.Chat has no self-join for a private group.

/** Tolerable only where re-running against an already-applied state is a no-op. */
const TOLERABLE_FAILURE_OPS = new Set([
  // Creating a room that already exists is, in intent, "ensure it exists".
  "post-api-v1-channels_create",
  "post-api-v1-groups_create",
  // Muting an already-muted user is a server-side no-op that still reports an error.
  "post-api-v1-rooms_muteUser",
  "post-api-v1-rooms_unmuteUser",
]);

/** Swap in the counterpart and drop `type`: Rocket.Chat ignores `type` and gets visibility wrong. */
export function normalizeRocketChatOperations(
  workflows: WorkflowDefinition[],
): void {
  for (const wf of workflows) {
    for (const step of wf.steps) {
      if (step.config.type !== "api_call") continue;
      const cfg = step.config;
      if (!cfg.inputMapping) continue;

      const mapping = cfg.inputMapping;
      const typeVal =
        typeof mapping.type === "string" ? mapping.type.toLowerCase() : "";
      if (!typeVal) continue;

      const counterpart = CHANNEL_GROUP_PAIRS[cfg.operationId];
      if (!counterpart) continue;

      const isChannelOp = cfg.operationId.includes("channels_");
      const isGroupOp = cfg.operationId.includes("groups_");
      const wantsPrivate = typeVal === "p" || typeVal === "private";
      const wantsPublic = typeVal === "c" || typeVal === "public";

      if ((isChannelOp && wantsPrivate) || (isGroupOp && wantsPublic)) {
        cfg.operationId = counterpart;
        delete mapping.type;
      }
    }
  }
}

/** Called after a remap, so the endpoint map has no stale entries and no missing swaps. */
function syncRequiredEndpoints(workflows: WorkflowDefinition[]): void {
  for (const wf of workflows) {
    wf.requiredEndpoints = [
      ...new Set(
        wf.steps
          .filter((s) => s.config.type === "api_call")
          .map((s) => (s.config as { operationId: string }).operationId),
      ),
    ];
  }
}

export class RocketChatAdapter implements PlatformAdapter {
  readonly platformName = "Rocket.Chat";

  private readonly specSource: SpecSource;
  private readonly parser: SpecParserInterface;

  constructor(
    options: { parser?: SpecParserInterface; specSource?: SpecSource } = {},
  ) {
    // Shared with the parser so a domain is fetched and cached once per adapter.
    this.specSource = options.specSource ?? new OpenApiSpecSource();
    this.parser =
      options.parser ?? new SpecParser({ specSource: this.specSource });
  }

  // ── API discovery ──────────────────────────────────────────────────────────

  getAvailableDomains(): string[] {
    return [...VALID_DOMAINS];
  }

  async getSpec(domain: string): Promise<OpenAPIV3.Document> {
    const [validated] = assertDomains([domain]);
    return this.specSource.getSpec(validated);
  }

  async listEndpoints(domains: readonly string[]): Promise<CompactEndpoint[]> {
    return this.parser.listEndpoints(assertDomains(domains));
  }

  async getFullEndpoints(
    operationIds: string[],
    domains?: readonly string[],
    maxDepth?: number,
  ): Promise<GetFullEndpointsResult> {
    return this.parser.getFullEndpoints(
      operationIds,
      domains === undefined ? undefined : assertDomains(domains),
      maxDepth,
    );
  }

  /** No locations without a spec; the engine's verb-based placement fits Rocket.Chat anyway. */
  deriveEndpointFromOperationId(
    operationId: string,
  ): Omit<GeneratorEndpoint, "operationId" | "summary"> | null {
    return deriveEndpointFromOperationId(operationId);
  }

  // ── Generated project code ─────────────────────────────────────────────────

  generateRestClientCode(): string {
    return generateRcClient();
  }

  clientFileName(): string {
    return "rc-client.ts";
  }

  generateEnvExample(options?: {
    usesSampling?: boolean;
    transport?: "stdio" | "http";
  }): string {
    return generateEnvExample(
      options?.usesSampling ?? false,
      options?.transport ?? "stdio",
    );
  }

  generateReadme(
    serverName: string,
    workflows: WorkflowDefinition[],
    endpoints: GeneratorEndpoint[],
  ): string {
    return generateReadme(serverName, workflows, endpoints, {
      platformName: this.platformName,
      clientFileName: this.clientFileName(),
      permissions: this.deriveRequiredPermissions(workflows),
    });
  }

  capabilityGuideHints(): CapabilityGuideHints {
    return {
      endpointAnnotations: ROCKETCHAT_ENDPOINT_ANNOTATIONS,
      domainNotes: ROCKETCHAT_DOMAIN_NOTES,
    };
  }

  deriveRequiredPermissions(workflows: WorkflowDefinition[]): string[] {
    return deriveRequiredPermissions(workflows);
  }

  // ── Workflow adjustments ───────────────────────────────────────────────────

  normalizeOperations(workflows: WorkflowDefinition[]): void {
    normalizeRocketChatOperations(workflows);
    syncRequiredEndpoints(workflows);
  }

  shouldContinueOnError(operationId: string): boolean {
    return TOLERABLE_FAILURE_OPS.has(operationId);
  }
}
