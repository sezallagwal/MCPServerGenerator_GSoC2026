import type { ApiCallStep, WorkflowStep } from "./types.js";
import type {
  EndpointInfo,
  ExecutionState,
  WorkflowClient,
} from "./executor.js";
import { evaluateExpression, resolveMapping } from "./templates.js";

const DEFAULT_FOREACH_CONCURRENCY = 5;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB

/** Walk a dotted path into a parsed value, returning null on any miss. */
export function extractPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc != null && typeof acc === "object" && !Array.isArray(acc)) {
      return (acc as Record<string, unknown>)[key] ?? null;
    }
    return null;
  }, value);
}

/** Consumed keys are removed so they are not resent; a placeholder with no value throws. */
function substitutePathParams(
  path: string,
  payload: Record<string, unknown>,
  operationId: string,
): string {
  return path.replace(/\{([^}]+)\}/g, (_match, rawName: string) => {
    const name = rawName.trim();
    const value = payload[name];
    if (value === undefined || value === null || value === "") {
      throw new Error(
        `API call "${operationId}" is missing required path parameter "${name}".`,
      );
    }
    delete payload[name];
    return typeof value === "object"
      ? encodeURIComponent(JSON.stringify(value))
      : encodeURIComponent(String(value));
  });
}

function buildGetUrl(path: string, payload: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(payload)) {
    search.append(
      k,
      typeof v === "object" && v !== null ? JSON.stringify(v) : String(v ?? ""),
    );
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

/** With no declared locations (offline) the verb decides: GET -> query string, else body. */
function splitByLocation(
  endpoint: EndpointInfo,
  payload: Record<string, unknown>,
): {
  headers: Record<string, string>;
  query: Record<string, unknown>;
  body: Record<string, unknown>;
} {
  const headers: Record<string, string> = {};
  const query: Record<string, unknown> = {};
  const body: Record<string, unknown> = {};

  const declaredQuery = new Set(endpoint.queryParams ?? []);
  const declaredHeader = new Set(endpoint.headerParams ?? []);
  const isGet = endpoint.method.toUpperCase() === "GET";

  for (const [key, value] of Object.entries(payload)) {
    if (declaredHeader.has(key)) {
      // Headers are a flat string channel; objects are serialized so a mistake is visible.
      if (value !== undefined && value !== null) {
        headers[key] =
          typeof value === "object" ? JSON.stringify(value) : String(value);
      }
      continue;
    }
    if (declaredQuery.has(key)) {
      query[key] = value;
      continue;
    }
    // Undeclared: fall back to the verb.
    if (isGet) query[key] = value;
    else body[key] = value;
  }

  return { headers, query, body };
}

/** An absent source drops an optional param; a source that exists but resolved empty throws. */
function pruneEmptyParams(
  step: ApiCallStep,
  payload: Record<string, unknown>,
  state: ExecutionState,
): void {
  for (const [key, raw] of Object.entries(step.inputMapping)) {
    if (typeof raw !== "string" || !raw.includes("{{")) continue;
    const resolved = payload[key];
    if (resolved !== "" && resolved !== undefined && resolved !== null)
      continue;

    const paramMatch = raw.match(/\{\{\s*params\.(\w+)/);
    const stepMatch = raw.match(/\{\{\s*steps\.(\w+)/);
    if (paramMatch && !(paramMatch[1] in state.params)) {
      delete payload[key];
    } else if (stepMatch && !(stepMatch[1] in state.steps)) {
      delete payload[key];
    } else {
      throw new Error(
        `Parameter "${key}" resolved to empty (template: ${raw}).`,
      );
    }
  }
}

async function callOnce(
  step: ApiCallStep,
  payload: Record<string, unknown>,
  state: ExecutionState,
  client: WorkflowClient,
  endpoints: Record<string, EndpointInfo>,
): Promise<unknown> {
  const endpoint: EndpointInfo | undefined = endpoints[step.operationId];
  if (!endpoint) {
    throw new Error(
      `No endpoint registered for operationId "${step.operationId}". ` +
        `The workflow references an operationId that is not in the endpoint map.`,
    );
  }
  const method = endpoint.method.toUpperCase();
  const rawPath = endpoint.path;

  pruneEmptyParams(step, payload, state);

  const path = substitutePathParams(rawPath, payload, step.operationId);

  if (method === "GET") {
    // Decode JSON-looking string values so they ride along as query params.
    for (const [k, v] of Object.entries(payload)) {
      if (typeof v === "string" && /^[[{]/.test(v)) {
        try {
          payload[k] = JSON.parse(v);
        } catch {
          // keep as string
        }
      }
    }
  }

  // Header params have nowhere else to go: by-verb routing put them in the body.
  const { headers, query, body } = splitByLocation(endpoint, payload);

  const hasQuery = Object.keys(query).length > 0;
  const sendsBody = method !== "GET" && Object.keys(body).length > 0;

  const response = await client.request(
    method,
    hasQuery ? buildGetUrl(path, query) : path,
    {
      // Anything the spec has not marked credential-free stays authenticated.
      auth: endpoint.auth !== false,
      ...(sendsBody ? { body } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    },
  );

  if (!response.ok) {
    const detail =
      typeof response.data === "string"
        ? response.data
        : JSON.stringify(response.data);
    throw new Error(
      `API call "${step.operationId}" failed (status ${response.status}): ${detail}`,
    );
  }

  if (
    typeof response.data === "string" &&
    response.data.length > MAX_RESPONSE_BYTES
  ) {
    throw new Error(
      `API response for "${step.operationId}" exceeds the 10 MB limit.`,
    );
  }

  return step.outputPath
    ? extractPath(response.data, step.outputPath)
    : response.data;
}

export async function executeApiCall(
  step: WorkflowStep,
  state: ExecutionState,
  client: WorkflowClient,
  endpoints: Record<string, EndpointInfo>,
  maxForEachIterations: number,
): Promise<void> {
  const config = step.config as ApiCallStep;

  if (config.forEach && config.as) {
    const itemVar = config.as;
    // The composer stores forEach bare; residual `{{ }}` is tolerated defensively.
    const expr = config.forEach.trim();
    const cleaned =
      expr.startsWith("{{") && expr.endsWith("}}")
        ? expr.slice(2, -2).trim()
        : expr;
    let raw: unknown;
    try {
      raw = evaluateExpression(cleaned, state.params, state.steps);
    } catch {
      raw = [];
    }
    const collection = Array.isArray(raw) ? raw : [];
    if (collection.length > maxForEachIterations) {
      throw new Error(
        `Step "${step.id}" forEach has ${collection.length} items, ` +
          `exceeding the maximum of ${maxForEachIterations}.`,
      );
    }

    const results: unknown[] = new Array(collection.length).fill(null);
    const failures: Array<{ index: number; error: string }> = [];
    for (let i = 0; i < collection.length; i += DEFAULT_FOREACH_CONCURRENCY) {
      const slice = collection.slice(i, i + DEFAULT_FOREACH_CONCURRENCY);
      const settled = await Promise.allSettled(
        slice.map((item) => {
          const locals = { [itemVar]: item };
          const augmentedSteps = { ...state.steps, [itemVar]: item };
          const payload = resolveMapping(
            config.inputMapping,
            state.params,
            augmentedSteps,
            locals,
          );
          return callOnce(config, payload, state, client, endpoints);
        }),
      );
      for (let j = 0; j < settled.length; j++) {
        const r = settled[j];
        const index = i + j;
        if (r.status === "fulfilled") {
          results[index] = r.value;
        } else {
          failures.push({
            index,
            error:
              r.reason instanceof Error ? r.reason.message : String(r.reason),
          });
        }
      }
    }

    if (failures.length > 0) {
      const summary = failures
        .map((f) => `item ${f.index}: ${f.error}`)
        .join("; ");
      // Default: a bulk action must not report success when any side effect failed.
      if (!config.continueOnError) {
        throw new Error(
          `forEach had ${failures.length}/${collection.length} failed ` +
            `iteration(s): ${summary}`,
        );
      }
      // Failed items stay `null` and per-item errors are recorded, so this stays explicit.
      state.errors[step.id] =
        `${failures.length}/${collection.length} iteration(s) failed: ${summary}`;
    }

    state.steps[step.id] = results;
    state.status[step.id] = failures.length > 0 ? "partial" : "success";
    state.completed.push(step.id);
    return;
  }

  const payload = resolveMapping(
    config.inputMapping,
    state.params,
    state.steps,
  );
  const result = await callOnce(config, payload, state, client, endpoints);
  state.steps[step.id] = result;
  state.status[step.id] = "success";
  state.completed.push(step.id);
}
