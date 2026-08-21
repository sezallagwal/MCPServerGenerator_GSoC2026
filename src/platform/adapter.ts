import type { OpenAPIV3 } from "openapi-types";
import type {
  CapabilityGuideSource,
  EndpointDetailSource,
} from "../parser/types.js";
import type { WorkflowDefinition } from "../workflow/types.js";
import type { GeneratorEndpoint } from "../generator/types.js";
import type { CapabilityGuideHints } from "../tools/capability-guide.js";

/** The seam to the target platform. Extends the discovery interfaces so one adapter backs both. */
export interface PlatformAdapter
  extends CapabilityGuideSource, EndpointDetailSource {
  readonly platformName: string;

  getSpec(domain: string): Promise<OpenAPIV3.Document>;

  /** Must return `null` rather than guess: a fabricated route only fails at run time. */
  deriveEndpointFromOperationId(
    operationId: string,
  ): Omit<GeneratorEndpoint, "operationId" | "summary"> | null;

  generateRestClientCode(): string;

  clientFileName(): string;

  generateEnvExample(options?: {
    usesSampling?: boolean;
    transport?: "stdio" | "http";
  }): string;

  generateReadme(
    serverName: string,
    workflows: WorkflowDefinition[],
    endpoints: GeneratorEndpoint[],
  ): string;

  deriveRequiredPermissions(workflows: WorkflowDefinition[]): string[];

  /** Rewrite operationIds when the requested inputs imply a different endpoint variant. */
  normalizeOperations(workflows: WorkflowDefinition[]): void;

  /** Optional, so one platform's vocabulary cannot leak into another's guide. */
  capabilityGuideHints?(): CapabilityGuideHints;

  /** Cannot see `inputMapping`: field shape says nothing about whether a retry is harmless. */
  shouldContinueOnError(operationId: string): boolean;
}
