import type { OpenAPIV3 } from "openapi-types";
import type { JSONSchema7 } from "json-schema";
import type {
  CompactEndpoint,
  EndpointParameterSchemas,
  FullEndpoint,
  GetFullEndpointsResult,
} from "../parser/types.js";
import { assertSafeSpecUrl, dereferenceSpec } from "../parser/spec-fetch.js";
import { mapOpenApiSchemaToJsonSchema } from "../parser/schema-mapper.js";
import type { WorkflowDefinition } from "../workflow/types.js";
import type { GeneratorEndpoint } from "../generator/types.js";
import { httpTransportEnvBlock } from "../generator/scaffold.js";
import { escapeBlockComment, escapeMarkdownCell } from "../generator/escape.js";
import type { PlatformAdapter } from "./adapter.js";

/** Spec names reach generated source, so they are matched against narrow patterns, not escaped. */
const SAFE_ENV_VAR_RE = /^[A-Z_][A-Z0-9_]*$/;
/** Injection-safe subset of RFC 7230 token characters (`api_key` is a real header). */
const SAFE_HEADER_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

function assertSafeEnvVarName(name: string): void {
  if (!SAFE_ENV_VAR_RE.test(name)) {
    throw new Error(
      `Invalid environment variable name: "${name}". Must match ${String(SAFE_ENV_VAR_RE)}.`,
    );
  }
}

/** Query and cookie names: as above, plus the dotted forms specs commonly use. */
const SAFE_PARAM_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/;

function assertSafeHeaderName(name: string): void {
  if (!SAFE_HEADER_RE.test(name)) {
    throw new Error(
      `Invalid HTTP header name: "${name}". Must match ${String(SAFE_HEADER_RE)}.`,
    );
  }
}

function assertSafeQueryParamName(name: string): void {
  if (!SAFE_PARAM_NAME_RE.test(name)) {
    throw new Error(
      `Invalid query/cookie parameter name: "${name}". Must match ${String(SAFE_PARAM_NAME_RE)}.`,
    );
  }
}

type ApiKeyLocation = "header" | "query" | "cookie";

interface AuthConfig {
  type: "bearer" | "api-key" | "basic" | "none";
  /** For `api-key` only: the location the spec declares. */
  in?: ApiKeyLocation;
  /** For `api-key` only: the spec's own header / query / cookie name. */
  parameterName?: string;
  envVarName: string;
  envVarDescription: string;
}

/** Raw, not `JSONSchema7`: a dereferenced recursive `$ref` is a cycle only the mapper handles. */
type RawSchema = OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject;

interface EndpointEntry {
  operationId: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  tag: string;
  parameters: OpenAPIV3.ParameterObject[];
  requestBody?: { contentType: string; schema: RawSchema; required: boolean };
  responseSchema?: RawSchema;
  security: OpenAPIV3.SecurityRequirementObject[];
}

const HTTP_METHODS = ["get", "post", "put", "delete", "patch"] as const;

/** Derives routes, tags, and auth from any OpenAPI 3 spec at runtime. {@link init} runs first. */
export class GenericOpenAPIAdapter implements PlatformAdapter {
  platformName: string;

  private readonly specUrl: string;
  private cachedSpec: OpenAPIV3.Document | null = null;
  /** Coalesces concurrent loads so overlapping callers share one fetch. */
  private specPromise: Promise<OpenAPIV3.Document> | null = null;
  private readonly endpointMap = new Map<string, EndpointEntry>();
  private tags: string[] = [];
  private authConfig: AuthConfig = {
    type: "none",
    envVarName: "API_KEY",
    envVarDescription: "",
  };
  private platformNameFromSpec = false;
  private loaded = false;

  /** Off by default: a cross-origin `$ref` in third-party spec input is an SSRF proxy. */
  private readonly allowCrossOriginRefs: boolean;

  constructor(options: {
    specUrl: string;
    platformName?: string;
    allowCrossOriginRefs?: boolean;
  }) {
    // Validated before any network access; the parsed URL also seeds the platform name.
    const url = assertSafeSpecUrl(options.specUrl);
    this.specUrl = options.specUrl;
    // Whole hostname, not its first label: `api.example.com` -> "api" identifies nothing.
    this.platformName =
      options.platformName ?? url.hostname.replace(/^www\./, "") ?? "API";
    // A hostname-derived name is only a placeholder that `info.title` may improve on.
    this.platformNameFromSpec = options.platformName === undefined;
    this.allowCrossOriginRefs = options.allowCrossOriginRefs ?? false;
  }

  /** Load and index the spec. Safe to call repeatedly. */
  async init(): Promise<void> {
    await this.loadSpec();
  }

  private async loadSpec(): Promise<OpenAPIV3.Document> {
    if (this.cachedSpec) return this.cachedSpec;
    // Share an in-flight load instead of duplicating it; cleared on failure so a retry works.
    if (this.specPromise) return this.specPromise;
    this.specPromise = this.doLoadSpec().finally(() => {
      this.specPromise = null;
    });
    return this.specPromise;
  }

  private async doLoadSpec(): Promise<OpenAPIV3.Document> {
    const spec = (await dereferenceSpec(this.specUrl, {
      allowCrossOriginRefs: this.allowCrossOriginRefs,
    })) as OpenAPIV3.Document;

    this.cachedSpec = spec;
    if (this.platformNameFromSpec && spec.info?.title) {
      this.platformName = spec.info.title;
    }
    this.indexEndpoints(spec);
    this.detectAuth(spec);
    this.loaded = true;
    return spec;
  }

  /** Codegen is synchronous, so without this it emits a project with no auth and no endpoints. */
  private assertLoaded(method: string): void {
    if (this.loaded) return;
    throw new Error(
      `GenericOpenAPIAdapter.${method}() was called before the spec was loaded. ` +
        `Await adapter.init() before generating — the base URL, auth wiring, and ` +
        `endpoint list all come from the spec.`,
    );
  }

  /** Two passes so a synthesized id never displaces an explicit one; duplicates keep the first. */
  private indexEndpoints(spec: OpenAPIV3.Document): void {
    const tagSet = new Set<string>();
    const collisions: string[] = [];

    type Located = {
      path: string;
      method: (typeof HTTP_METHODS)[number];
      op: OpenAPIV3.OperationObject;
      pathItem: OpenAPIV3.PathItemObject;
    };
    const explicit: Located[] = [];
    const anonymous: Located[] = [];

    for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
      if (!pathItem) continue;
      for (const method of HTTP_METHODS) {
        const op = pathItem[method];
        if (!op) continue;
        (op.operationId ? explicit : anonymous).push({
          path,
          method,
          op,
          pathItem,
        });
      }
    }

    const register = (located: Located, operationId: string): void => {
      const { path, method, op, pathItem } = located;
      const tag = op.tags?.[0] ?? "default";
      tagSet.add(tag);

      const existing = this.endpointMap.get(operationId);
      if (existing) {
        collisions.push(
          `"${operationId}" (keeping ${existing.method} ${existing.path}, ` +
            `dropping ${method.toUpperCase()} ${path})`,
        );
        return;
      }

      const parameters: OpenAPIV3.ParameterObject[] = [];
      for (const p of [
        ...(pathItem.parameters ?? []),
        ...(op.parameters ?? []),
      ]) {
        // The spec is dereferenced, so a `name` means a real parameter, not a leftover $ref.
        if ("name" in p) parameters.push(p as OpenAPIV3.ParameterObject);
      }

      this.endpointMap.set(operationId, {
        operationId,
        method: method.toUpperCase(),
        path,
        summary: op.summary ?? "",
        description: op.description ?? "",
        tag,
        parameters,
        requestBody: extractRequestBody(op),
        responseSchema: extractResponseSchema(op),
        security: op.security ?? spec.security ?? [],
      });
    };

    for (const located of explicit) {
      register(located, located.op.operationId!);
    }

    for (const located of anonymous) {
      const base = `${located.method}-${located.path.replace(/[^a-zA-Z0-9]/g, "-")}`;
      let candidate = base;
      let n = 2;
      while (this.endpointMap.has(candidate)) candidate = `${base}-${n++}`;
      register(located, candidate);
    }

    // The client only sends JSON, so a body with no JSON representation cannot be called.
    const nonJsonBodies: string[] = [];
    for (const entry of this.endpointMap.values()) {
      const ct = entry.requestBody?.contentType;
      if (ct && !/json/i.test(ct)) {
        nonJsonBodies.push(`${entry.operationId} (${ct})`);
      }
    }
    if (nonJsonBodies.length > 0) {
      console.error(
        `[generic-adapter] ${nonJsonBodies.length} operation(s) declare a request ` +
          `body with no JSON representation, but the generated client sends JSON: ` +
          `${nonJsonBodies.join(", ")}. Those calls will not work without editing ` +
          `the generated client.`,
      );
    }

    if (collisions.length > 0) {
      console.error(
        `[generic-adapter] Spec reuses ${collisions.length} operationId(s), ` +
          `which OpenAPI does not allow. Only the first occurrence of each is ` +
          `addressable: ${collisions.join("; ")}. ` +
          `Give the duplicates distinct operationIds to reach them.`,
      );
    }

    this.tags = [...tagSet].sort();
  }

  /** `securitySchemes` only declares; what is required comes from the `security` blocks. */
  private collectRequiredSchemeNames(spec: OpenAPIV3.Document): Set<string> {
    const names = new Set<string>();
    const add = (reqs?: OpenAPIV3.SecurityRequirementObject[]) => {
      for (const req of reqs ?? []) {
        for (const name of Object.keys(req)) names.add(name);
      }
    };

    add(spec.security);
    for (const pathItem of Object.values(spec.paths ?? {})) {
      if (!pathItem) continue;
      for (const method of HTTP_METHODS) {
        add(pathItem[method]?.security);
      }
    }
    return names;
  }

  private detectAuth(spec: OpenAPIV3.Document): void {
    const schemes = spec.components?.securitySchemes ?? {};
    const concrete = Object.entries(schemes).filter(
      (entry): entry is [string, OpenAPIV3.SecuritySchemeObject] =>
        !!entry[1] && !("$ref" in entry[1]),
    );
    if (concrete.length === 0) return;

    const required = this.collectRequiredSchemeNames(spec);

    // Prefer a required scheme; if none is required, use all declared rather than wiring none.
    const candidates = concrete.filter(([name]) => required.has(name));
    const pool = candidates.length > 0 ? candidates : concrete;

    // Rank by how well the generated client can honour the scheme, not by declaration order.
    const rank = ([, scheme]: [string, OpenAPIV3.SecuritySchemeObject]) => {
      if (scheme.type === "http" && scheme.scheme === "bearer") return 0;
      if (scheme.type === "apiKey" && scheme.in === "header") return 1;
      if (scheme.type === "apiKey" && scheme.in === "query") return 2;
      if (scheme.type === "http" && scheme.scheme === "basic") return 3;
      if (scheme.type === "apiKey") return 4; // cookie, or an unknown location
      return 99; // oauth2 / openIdConnect: not wireable from a spec alone
    };

    const ordered = [...pool].sort((a, b) => rank(a) - rank(b));
    const best = ordered[0];
    if (!best || rank(best) === 99) {
      const kinds = pool.map(([n, s]) => `${n} (${s.type})`).join(", ");
      console.error(
        `[generic-adapter] No security scheme this generator can wire: ${kinds}. ` +
          `Generating an unauthenticated client; add the credential handling the ` +
          `API needs to the generated client.`,
      );
      return;
    }

    const [chosen, scheme] = best;
    this.authConfig = this.toAuthConfig(scheme);

    if (this.authConfig.type === "api-key" && this.authConfig.in === "cookie") {
      console.error(
        `[generic-adapter] Scheme "${chosen}" is a cookie API key ` +
          `("${this.authConfig.parameterName}"). The generated client sends it as a ` +
          `Cookie header, which works for a simple token but not for a session ` +
          `flow that expects a prior login.`,
      );
    }

    // The client wires exactly one scheme, so name the others rather than leave a silent gap.
    const notWired = pool.map(([n]) => n).filter((n) => n !== chosen);
    if (notWired.length > 0) {
      console.error(
        `[generic-adapter] Spec ${candidates.length > 0 ? "requires" : "declares"} ` +
          `${pool.length} security schemes; wiring "${chosen}" only. ` +
          `Not wired: ${notWired.join(", ")}. ` +
          `Edit the generated client if a different scheme is required.`,
      );
    }
  }

  private toAuthConfig(scheme: OpenAPIV3.SecuritySchemeObject): AuthConfig {
    if (scheme.type === "http" && scheme.scheme === "bearer") {
      return {
        type: "bearer",
        envVarName: "API_BEARER_TOKEN",
        envVarDescription: "Bearer token for authentication",
      };
    }
    if (scheme.type === "http" && scheme.scheme === "basic") {
      return {
        type: "basic",
        envVarName: "API_BASIC_AUTH",
        envVarDescription: "Basic auth credentials (user:password)",
      };
    }
    // Recording the location, not just a header name, stops a query key becoming a header.
    const where: ApiKeyLocation =
      scheme.type === "apiKey" &&
      (scheme.in === "query" || scheme.in === "cookie")
        ? scheme.in
        : "header";
    const parameterName = scheme.type === "apiKey" ? scheme.name : undefined;
    return {
      type: "api-key",
      in: where,
      parameterName,
      envVarName: "API_KEY",
      envVarDescription: `API key (${where}: ${parameterName})`,
    };
  }

  // ── API discovery ──────────────────────────────────────────────────────────

  /** OpenAPI tags, or a single catch-all group when the spec has none. */
  getAvailableDomains(): string[] {
    return this.tags.length > 0 ? this.tags : ["all"];
  }

  /** One document, so any tag resolves to it, but an unknown tag still has to error. */
  async getSpec(domain?: string): Promise<OpenAPIV3.Document> {
    const spec = await this.loadSpec();
    if (
      domain !== undefined &&
      domain !== "all" &&
      !this.tags.includes(domain)
    ) {
      throw new Error(
        `Unknown domain "${domain}" for ${this.platformName}. ` +
          `Available: ${this.getAvailableDomains().join(", ")}`,
      );
    }
    return spec;
  }

  async listEndpoints(domains: readonly string[]): Promise<CompactEndpoint[]> {
    await this.loadSpec();
    const wanted = new Set(domains);
    const all = wanted.has("all") || wanted.size === 0;

    const results: CompactEndpoint[] = [];
    for (const entry of this.endpointMap.values()) {
      if (!all && !wanted.has(entry.tag)) continue;
      results.push({
        operationId: entry.operationId,
        summary: entry.summary || `${entry.method} ${entry.path}`,
        domain: entry.tag,
      });
    }
    return results;
  }

  /** `maxDepth` bounds expansion: a dereferenced spec's recursive schemas are cyclic. */
  async getFullEndpoints(
    operationIds: string[],
    domains?: readonly string[],
    maxDepth?: number,
  ): Promise<GetFullEndpointsResult> {
    await this.loadSpec();
    const endpoints: FullEndpoint[] = [];
    const tagFilter = domains ? new Set(domains) : undefined;

    for (const id of operationIds) {
      const entry = this.endpointMap.get(id);
      if (!entry) continue;
      if (tagFilter && !tagFilter.has(entry.tag)) continue;
      endpoints.push({
        operationId: entry.operationId,
        method: entry.method,
        path: entry.path,
        summary: entry.summary,
        description: entry.description,
        domain: entry.tag,
        parameters: entry.parameters,
        requestBody: entry.requestBody
          ? {
              contentType: entry.requestBody.contentType,
              schema: toJsonSchema(entry.requestBody.schema, maxDepth),
              required: entry.requestBody.required,
            }
          : undefined,
        responseSchema: entry.responseSchema
          ? toJsonSchema(entry.responseSchema, maxDepth)
          : undefined,
        security: entry.security,
        inputSchema: buildInputSchema(entry, maxDepth),
        parameterSchemas: buildParameterSchemas(entry, maxDepth),
      });
    }

    // A generic spec has no fuzzy-matching layer, so nothing is auto-corrected.
    return { endpoints, correctedIds: new Map<string, string>() };
  }

  /** A generic operationId carries no route, so an unindexed id is reported unresolved. */
  deriveEndpointFromOperationId(
    operationId: string,
  ): Omit<GeneratorEndpoint, "operationId" | "summary"> | null {
    const entry = this.endpointMap.get(operationId);
    if (!entry) return null;

    // Declared locations travel with the route, so the offline path stops placing by verb.
    const queryParams = entry.parameters
      .filter((p) => p.in === "query")
      .map((p) => p.name);
    const headerParams = entry.parameters
      .filter((p) => p.in === "header")
      .map((p) => p.name);

    return {
      method: entry.method,
      path: entry.path,
      ...(queryParams.length > 0 ? { queryParams } : {}),
      ...(headerParams.length > 0 ? { headerParams } : {}),
      ...(entry.security.length === 0 ? { auth: false } : {}),
    };
  }

  // ── Generated project code ─────────────────────────────────────────────────

  clientFileName(): string {
    // Not guarded: the name is a constant, so it is safe to ask for before the spec loads.
    return "api-client.ts";
  }

  generateRestClientCode(): string {
    this.assertLoaded("generateRestClientCode");
    const defaultBase =
      this.cachedSpec?.servers?.[0]?.url ?? "http://localhost:8080";

    if (this.authConfig.type !== "none") {
      assertSafeEnvVarName(this.authConfig.envVarName);
    }

    const { authHeaders, authQuery, authEnvCheck } = this.buildAuthSnippets();

    return `/**
 * ${escapeBlockComment(this.platformName)} HTTP client for the engine's WorkflowClient contract.
 * Generated by mcp-server-generator; auth comes from the spec's security scheme.
 */
const config = {
  // Trimmed because spec paths start with "/": "https://host/v1/" would build "/v1//pets".
  baseUrl: (process.env.API_BASE_URL || ${JSON.stringify(defaultBase)}).replace(/\\/+$/, ""),
};

const REQUEST_TIMEOUT_MS = Number(process.env.API_REQUEST_TIMEOUT_MS) || 30000;

/** Hard cap on one response body, so a misbehaving server cannot exhaust memory. */
const MAX_RESPONSE_BYTES = 25 * 1024 * 1024; // 25 MB

export interface ApiResponse {
  ok: boolean;
  status: number;
  data: unknown;
}

/** Cancels past MAX_RESPONSE_BYTES; res.text() would buffer it all before any check runs. */
async function readCappedText(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await res.body?.cancel();
    throw new Error(
      "Response too large: " + declared + " bytes (max " + MAX_RESPONSE_BYTES + ").",
    );
  }
  if (!res.body) return "";

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Response body exceeds " + MAX_RESPONSE_BYTES + " bytes.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A proxy can return an HTML error page, so only parse when the content type says to. */
async function parseBody(res: Response): Promise<unknown> {
  const raw = await readCappedText(res);
  if (raw.length === 0) return null;

  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("json")) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

let initialized = false;

export async function initAuth(): Promise<void> {
  if (initialized) return;
  initialized = true;
${authEnvCheck || "  // This API requires no authentication."}
  console.error(${JSON.stringify(this.platformName)} + " client initialized.");
}

function buildUrl(path: string): string {
  return /^https?:\\/\\//i.test(path) ? path : config.baseUrl + path;
}

/** The credential as "name=value", or null when auth travels in a header. */
function authQueryParam(): string | null {
${authQuery}
}

function withQueryParam(url: string, param: string): string {
  return url + (url.includes("?") ? "&" : "?") + param;
}

class ApiClient {
  async request(
    method: string,
    path: string,
    options: {
      auth?: boolean;
      body?: Record<string, unknown>;
      headers?: Record<string, string>;
    } = {},
  ): Promise<ApiResponse> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options.auth) {
${authHeaders || "      // No auth headers required."}
    }
    // Applied after auth so a workflow cannot overwrite the credential headers.
    const RESERVED = new Set(["authorization", "cookie"]);
    for (const [k, v] of Object.entries(options.headers ?? {})) {
      if (RESERVED.has(k.toLowerCase())) continue;
      headers[k] = v;
    }

    let url = buildUrl(path);
    if (options.auth) {
      const param = authQueryParam();
      if (param) url = withQueryParam(url, param);
    }

    // Bound every request so a hung server cannot wedge the MCP process.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: controller.signal,
      });
      const data = await parseBody(res);
      return { ok: res.ok, status: res.status, data };
    } catch (err) {
      const reason =
        err instanceof Error && err.name === "AbortError"
          ? "Request to " + path + " timed out after " + REQUEST_TIMEOUT_MS + "ms"
          : err instanceof Error
            ? err.message
            : String(err);
      return { ok: false, status: 0, data: reason };
    } finally {
      clearTimeout(timer);
    }
  }
}

export const client = new ApiClient();
`;
  }

  /** Split because an `apiKey` scheme with `in: "query"` must not be forced into a header. */
  private buildAuthSnippets(): {
    authHeaders: string;
    authQuery: string;
    authEnvCheck: string;
  } {
    const envVar = this.authConfig.envVarName;
    const warn =
      `  if (!process.env.${envVar}) {\n` +
      `    console.error("Warning: ${envVar} is not set; authenticated calls will fail.");\n` +
      `  }`;
    const none = {
      authHeaders: "",
      authQuery: "  return null;",
      authEnvCheck: "",
    };

    switch (this.authConfig.type) {
      case "bearer":
        return {
          ...none,
          authHeaders: `      headers["Authorization"] = "Bearer " + (process.env.${envVar} || "");`,
          authEnvCheck: warn,
        };
      case "api-key": {
        // The spec's own name: a wrong name fails exactly as silently as a wrong location.
        const name = this.authConfig.parameterName;
        if (!name) {
          throw new Error(
            "OpenAPI apiKey security scheme is missing its required `name`; " +
              "cannot generate a client for it.",
          );
        }
        switch (this.authConfig.in) {
          case "query":
            assertSafeQueryParamName(name);
            return {
              ...none,
              authQuery:
                `  const key = process.env.${envVar};\n` +
                `  if (!key) return null;\n` +
                `  return ${JSON.stringify(name)} + "=" + encodeURIComponent(key);`,
              authEnvCheck: warn,
            };
          case "cookie":
            assertSafeQueryParamName(name);
            return {
              ...none,
              authHeaders:
                `      headers["Cookie"] = ${JSON.stringify(name)} + "=" + ` +
                `encodeURIComponent(process.env.${envVar} || "");`,
              authEnvCheck: warn,
            };
          default:
            assertSafeHeaderName(name);
            return {
              ...none,
              authHeaders: `      headers[${JSON.stringify(name)}] = process.env.${envVar} || "";`,
              authEnvCheck: warn,
            };
        }
      }
      case "basic":
        return {
          ...none,
          authHeaders:
            `      const creds = process.env.${envVar} || "";\n` +
            `      headers["Authorization"] = "Basic " + Buffer.from(creds).toString("base64");`,
          authEnvCheck: warn,
        };
      case "none":
        return none;
    }
  }

  generateEnvExample(options?: {
    usesSampling?: boolean;
    transport?: "stdio" | "http";
  }): string {
    this.assertLoaded("generateEnvExample");
    const defaultBase =
      this.cachedSpec?.servers?.[0]?.url ?? "http://localhost:8080";

    let env = `# ${this.platformName} connection
API_BASE_URL=${defaultBase}

# Per-request timeout in milliseconds (optional)
# API_REQUEST_TIMEOUT_MS=30000
`;

    if (this.authConfig.type !== "none") {
      assertSafeEnvVarName(this.authConfig.envVarName);
      env += `\n# Authentication — ${this.authConfig.envVarDescription}\n`;
      env += `${this.authConfig.envVarName}=your-${this.authConfig.type}-value-here\n`;
    }

    if (options?.usesSampling) {
      env += `
# Sampling steps request the MCP client's LLM, so no extra key is required when
# your MCP client supports sampling.
`;
    }

    if (options?.transport === "http") {
      env += httpTransportEnvBlock();
    }

    return env;
  }

  generateReadme(
    serverName: string,
    workflows: WorkflowDefinition[],
    endpoints: GeneratorEndpoint[],
  ): string {
    this.assertLoaded("generateReadme");
    const date = new Date().toISOString().split("T")[0];

    const workflowRows = workflows
      .map((w) => {
        const features: string[] = [];
        if (w.usesSampling) features.push("AI");
        if (w.usesElicitation) features.push("Human-in-loop");
        const badge = features.length > 0 ? features.join(", ") : "Automation";
        return `| \`${escapeMarkdownCell(w.name)}\` | ${escapeMarkdownCell(
          w.description,
        )} | ${w.steps.length} | ${badge} |`;
      })
      .join("\n");

    const endpointRows = endpoints
      .map(
        (ep) =>
          `| \`${escapeMarkdownCell(ep.operationId)}\` | \`${escapeMarkdownCell(
            ep.method.toUpperCase(),
          )}\` | \`${escapeMarkdownCell(ep.path)}\` | ${escapeMarkdownCell(
            ep.summary || "—",
          )} |`,
      )
      .join("\n");

    const authSection =
      this.authConfig.type === "none"
        ? "This API requires no authentication."
        : `Set \`${this.authConfig.envVarName}\` in your \`.env\` file — ` +
          `${this.authConfig.envVarDescription || this.authConfig.type}.`;

    return `# ${serverName}

A workflow-based [MCP](https://modelcontextprotocol.io/) server for
**${this.platformName}**, generated by **mcp-server-generator** from its OpenAPI
specification. Each tool runs a multi-step workflow that chains API calls, AI
sampling, and user confirmation behind one call.

> Generated on ${date}

## Quick start

\`\`\`bash
npm install
cp .env.example .env   # fill in the values below
npm start
\`\`\`

## Authentication

${authSection}

## Development

\`\`\`bash
npm test         # run the generated workflow smoke tests
npm run build    # type-check and compile to dist/
\`\`\`

## Workflow tools

| Tool | Description | Steps | Features |
|------|-------------|-------|----------|
${workflowRows}

## API endpoints used

| operationId | Method | Path | Summary |
|-------------|--------|------|---------|
${endpointRows}

## Project layout

\`\`\`
${serverName}/
├── src/
│   ├── server.ts       # entry point — wires tools to stdio transport
│   ├── ${this.clientFileName()}   # ${this.platformName} HTTP client
│   ├── endpoints.ts    # operationId -> method + path
│   ├── engine/         # vendored workflow engine
│   ├── tools/          # one file per workflow
│   └── tests/          # one smoke test per workflow + shared setup
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
\`\`\`

---

*Generated by mcp-server-generator.*
`;
  }

  /** A generic spec carries no platform permission model. */
  deriveRequiredPermissions(): string[] {
    return [];
  }

  // ── Workflow adjustments ───────────────────────────────────────────────────

  /** No endpoint-variant remapping on a generic API. */
  normalizeOperations(): void {
    // Intentionally empty.
  }

  /** No platform knowledge means no basis for calling a failure ignorable; the DSL opts in. */
  shouldContinueOnError(): boolean {
    return false;
  }
}

// ── Spec extraction helpers ───────────────────────────────────────────────────

/** The client only sends JSON, so the JSON variant is the real schema; `+json` counts too. */
function pickJsonMediaType(
  content: Record<string, OpenAPIV3.MediaTypeObject>,
): string | undefined {
  const types = Object.keys(content);
  return (
    types.find((t) => /^application\/json\b/i.test(t)) ??
    types.find((t) => /^application\/[\w.+-]*\+json\b/i.test(t)) ??
    types.find((t) => /\bjson\b/i.test(t)) ??
    types[0]
  );
}

function extractRequestBody(
  op: OpenAPIV3.OperationObject,
): EndpointEntry["requestBody"] {
  if (!op.requestBody || !("content" in op.requestBody)) return undefined;
  const rb = op.requestBody as OpenAPIV3.RequestBodyObject;
  const contentType = pickJsonMediaType(rb.content);
  if (!contentType) return undefined;
  const schema = rb.content[contentType]?.schema;
  if (!schema) return undefined;
  return { contentType, schema, required: rb.required ?? false };
}

/** Backs `{{steps.X.result.Y}}`. Matched loosely so `2XX` and vendor JSON types resolve. */
function extractResponseSchema(
  op: OpenAPIV3.OperationObject,
): RawSchema | undefined {
  const responses = op.responses ?? {};
  const key =
    ["200", "201", "202", "2XX", "2xx", "default"].find(
      (k) => k in responses,
    ) ?? Object.keys(responses).find((k) => /^2\d\d$/.test(k));
  if (!key) return undefined;

  const response = responses[key];
  if (!response || !("content" in response)) return undefined;
  const content = (response as OpenAPIV3.ResponseObject).content;
  if (!content) return undefined;

  const mediaType = pickJsonMediaType(content);
  return mediaType ? content[mediaType]?.schema : undefined;
}

function toJsonSchema(schema: RawSchema, maxDepth?: number): JSONSchema7 {
  return mapOpenApiSchemaToJsonSchema(
    schema,
    new WeakSet(),
    maxDepth ?? Infinity,
  );
}

/** Flattens parameters and body properties into the object schema `MAP` targets. */
function buildInputSchema(
  entry: EndpointEntry,
  maxDepth?: number,
): JSONSchema7 {
  const properties: Record<string, JSONSchema7> = {};
  const required: string[] = [];

  for (const param of entry.parameters) {
    if (param.in !== "path" && param.in !== "query") continue;
    properties[param.name] = param.schema
      ? toJsonSchema(param.schema, maxDepth)
      : { type: "string" };
    if (param.required) required.push(param.name);
  }

  const bodySchema = entry.requestBody?.schema;
  if (bodySchema && !("$ref" in bodySchema) && bodySchema.properties) {
    for (const [key, value] of Object.entries(bodySchema.properties)) {
      properties[key] = toJsonSchema(value, maxDepth);
    }
    if (Array.isArray(bodySchema.required)) {
      required.push(...bodySchema.required);
    }
  }

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required: [...new Set(required)] } : {}),
  };
}

/** Group parameters by location, matching the Rocket.Chat parser's output. */
function buildParameterSchemas(
  entry: EndpointEntry,
  maxDepth?: number,
): EndpointParameterSchemas {
  const groups: Record<
    "path" | "query" | "header",
    Record<string, JSONSchema7>
  > = { path: {}, query: {}, header: {} };
  const requiredBy: Record<"path" | "query" | "header", string[]> = {
    path: [],
    query: [],
    header: [],
  };

  for (const param of entry.parameters) {
    if (param.in !== "path" && param.in !== "query" && param.in !== "header") {
      continue;
    }
    const where = param.in;
    groups[where][param.name] = param.schema
      ? toJsonSchema(param.schema, maxDepth)
      : { type: "string" };
    if (param.required) requiredBy[where].push(param.name);
  }

  const result: EndpointParameterSchemas = {};
  for (const where of ["path", "query", "header"] as const) {
    if (Object.keys(groups[where]).length === 0) continue;
    result[where] = {
      type: "object",
      properties: groups[where],
      ...(requiredBy[where].length > 0 ? { required: requiredBy[where] } : {}),
    };
  }
  return result;
}
