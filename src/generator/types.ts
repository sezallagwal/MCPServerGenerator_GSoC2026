import type { WorkflowDefinition } from "../workflow/types.js";
import type { Transport } from "./codegen.js";
import type { PlatformAdapter } from "../platform/adapter.js";

/** `path` is project-relative, with POSIX separators. */
export interface GeneratedFile {
  path: string;
  content: string;
}

export interface GeneratorEndpoint {
  operationId: string;
  method: string;
  path: string;
  summary?: string;
  /** From the spec, so the engine places values by declaration, not by verb. Absent offline. */
  queryParams?: string[];
  headerParams?: string[];
  /** `false` when the spec says this operation needs no credentials. */
  auth?: boolean;
}

export interface GenerateProjectInput {
  /** Lowercase, e.g. "rocketchat_ops". */
  serverName: string;
  workflows: WorkflowDefinition[];
  endpoints: GeneratorEndpoint[];
  /** Defaults to {@link RocketChatAdapter}. */
  adapter?: PlatformAdapter;
  /** Defaults to `stdio`. */
  transport?: Transport;
}

export interface GenerateProjectResult {
  files: GeneratedFile[];
  summary: {
    serverName: string;
    platformName: string;
    transport: Transport;
    workflowCount: number;
    endpointCount: number;
    usesSampling: boolean;
    usesElicitation: boolean;
  };
}
