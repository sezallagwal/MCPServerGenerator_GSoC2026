import type { OpenAPIV3 } from "openapi-types";
import type { JSONSchema7 } from "json-schema";

export const VALID_DOMAINS = [
  "authentication",
  "messaging",
  "rooms",
  "user-management",
  "omnichannel",
  "integrations",
  "settings",
  "statistics",
  "notifications",
  "content-management",
  "marketplace-apps",
  "miscellaneous",
] as const;

export type Domain = (typeof VALID_DOMAINS)[number];

export const INPUT_SCHEMA_BODY_KEY = "requestBody" as const;

export interface CompactEndpoint {
  operationId: string;
  summary: string;
  /** A plain string, not {@link Domain}: a generic spec groups by its own tags. */
  domain: string;
}

export interface OperationLocation {
  domain: Domain;
  path: string;
  method: string;
}

/** Only the Rocket.Chat path produces it, so `domain` narrows back to a {@link Domain}. */
export interface IndexedCompactEndpoint extends CompactEndpoint {
  domain: Domain;
  path: string;
  method: string;
}

export interface EndpointParameterSchemas {
  path?: JSONSchema7;
  query?: JSONSchema7;
  header?: JSONSchema7;
}

export interface FullEndpoint {
  operationId: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  /** Spec grouping — a {@link Domain} for Rocket.Chat, an OpenAPI tag otherwise. */
  domain: string;
  parameters: OpenAPIV3.ParameterObject[];
  requestBody?: {
    contentType: string;
    schema: JSONSchema7;
    required: boolean;
  };
  responseSchema?: JSONSchema7;
  deprecated?: boolean;
  requestExamples?: Record<string, unknown>;
  responseExamples?: Record<string, unknown>;
  errorResponses?: Record<
    string,
    { description: string; schema?: JSONSchema7 }
  >;
  security: OpenAPIV3.SecurityRequirementObject[];
  inputSchema: JSONSchema7;
  parameterSchemas: EndpointParameterSchemas;
}

export interface GetFullEndpointsResult {
  endpoints: FullEndpoint[];
  correctedIds: ReadonlyMap<string, string>;
}

/** Domains are plain strings: a generic spec groups by its own tags, so implementations check. */
export interface CapabilityGuideSource {
  getAvailableDomains(): string[];
  listEndpoints(domains: readonly string[]): Promise<CompactEndpoint[]>;
}

export interface EndpointDetailSource {
  getFullEndpoints(
    operationIds: string[],
    domains?: readonly string[],
    maxDepth?: number,
  ): Promise<GetFullEndpointsResult>;
}

export interface SpecParserInterface
  extends CapabilityGuideSource, EndpointDetailSource {}

export interface SpecParserOptions {
  cacheDir?: string;
  cacheTtlMs?: number;
  fallbackCacheDirs?: string[];
  specSource?: SpecSource;
}

export interface SpecSource {
  getSpec(domain: Domain): Promise<OpenAPIV3.Document>;
}

export interface SpecSourceOptions {
  cacheDir?: string;
  cacheTtlMs?: number;
  fallbackCacheDirs?: string[];
}
export class ParserError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ParserError";
  }
}
