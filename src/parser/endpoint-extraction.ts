import { OpenAPIV3 } from "openapi-types";
import type { JSONSchema7 } from "json-schema";
import { mapOpenApiSchemaToJsonSchema } from "./schema-mapper.js";
import { INPUT_SCHEMA_BODY_KEY } from "./types.js";
import type { Domain, FullEndpoint, IndexedCompactEndpoint } from "./types.js";

const AUTH_HEADER_PARAMS = new Set(["X-Auth-Token", "X-User-Id"]);
const PARAMETER_SCHEMA_LOCATIONS = ["path", "query", "header"] as const;
type ParameterSchemaLocation = (typeof PARAMETER_SCHEMA_LOCATIONS)[number];
type ResolvedMediaContent = {
  contentType: string;
  schema: OpenAPIV3.SchemaObject;
  examples?: Record<string, unknown>;
};
type ResponseContent = {
  schema?: JSONSchema7;
  examples?: Record<string, unknown>;
};

export function extractCompactEndpoints(
  api: OpenAPIV3.Document,
  domain: Domain,
): IndexedCompactEndpoint[] {
  const results: IndexedCompactEndpoint[] = [];
  if (!api.paths) return results;

  const usedIds = new Set<string>();

  for (const [path, pathItem] of Object.entries(api.paths)) {
    if (!pathItem) continue;

    for (const method of Object.values(OpenAPIV3.HttpMethods)) {
      const safeMethod = method as OpenAPIV3.HttpMethods;
      const operation = pathItem[safeMethod];
      if (!operation) continue;

      const operationId = deduplicateId(
        sanitizeOperationId(operation.operationId, method, path),
        usedIds,
      );

      results.push({
        operationId,
        summary:
          operation.summary ||
          operation.description?.slice(0, 80) ||
          `${method.toUpperCase()} ${path}`,
        domain,
        path,
        method,
      });
    }
  }

  return results;
}

export function extractFullEndpoints(
  api: OpenAPIV3.Document,
  domain: Domain,
  filterIds?: Set<string>,
  maxDepth?: number,
): FullEndpoint[] {
  const results: FullEndpoint[] = [];
  if (!api.paths) return results;

  const globalSecurity = api.security || [];
  const usedIds = new Set<string>();

  for (const [path, pathItem] of Object.entries(api.paths)) {
    if (!pathItem) continue;

    for (const method of Object.values(OpenAPIV3.HttpMethods)) {
      const safeMethod = method as OpenAPIV3.HttpMethods;
      const operation = pathItem[safeMethod];
      if (!operation) continue;

      const operationId = deduplicateId(
        sanitizeOperationId(operation.operationId, method, path),
        usedIds,
      );

      if (filterIds && !filterIds.has(operationId)) continue;

      results.push(
        buildFullEndpoint(
          domain,
          operationId,
          path,
          method,
          pathItem,
          operation,
          globalSecurity,
          maxDepth,
        ),
      );
    }
  }

  return results;
}

export function extractEndpointByLocation(
  api: OpenAPIV3.Document,
  domain: Domain,
  operationId: string,
  path: string,
  method: string,
  maxDepth?: number,
): FullEndpoint | null {
  const pathItem = api.paths?.[path];
  if (!pathItem) return null;

  const operation = pathItem[method as OpenAPIV3.HttpMethods];
  if (!operation) return null;

  return buildFullEndpoint(
    domain,
    operationId,
    path,
    method,
    pathItem,
    operation,
    api.security || [],
    maxDepth,
  );
}

function buildFullEndpoint(
  domain: Domain,
  operationId: string,
  path: string,
  method: string,
  pathItem: OpenAPIV3.PathItemObject,
  operation: OpenAPIV3.OperationObject,
  globalSecurity: OpenAPIV3.SecurityRequirementObject[],
  maxDepth?: number,
): FullEndpoint {
  const allParams = mergeParameters(
    toParameterObjects(pathItem.parameters),
    toParameterObjects(operation.parameters),
  );

  let requestBody: FullEndpoint["requestBody"];
  let requestBodySchema: JSONSchema7 | undefined;
  let requestBodyRequired = false;
  let requestExamples: Record<string, unknown> | undefined;
  if (operation.requestBody && !("$ref" in operation.requestBody)) {
    const rb = operation.requestBody;
    const resolved = resolveRequestBodyContent(rb);
    if (resolved) {
      requestBodySchema = mapOpenApiSchemaToJsonSchema(
        resolved.schema,
        undefined,
        maxDepth,
      );
      requestBodyRequired = rb.required ?? false;
      requestBody = {
        contentType: resolved.contentType,
        schema: requestBodySchema,
        required: requestBodyRequired,
      };
      requestExamples = resolved.examples;
    }
  }

  const { inputSchema, parameterSchemas } = buildInputSchemas(
    allParams,
    requestBodySchema,
    requestBodyRequired,
    maxDepth,
  );

  const successResponse = extractSuccessResponse(operation.responses, maxDepth);
  const errorResponses = extractErrorResponses(operation.responses, maxDepth);
  const security =
    operation.security === undefined
      ? globalSecurity
      : operation.security || [];

  const summary =
    operation.summary ||
    operation.description?.slice(0, 80) ||
    `${method.toUpperCase()} ${path}`;

  const ep: FullEndpoint = {
    operationId,
    method: method.toUpperCase(),
    path,
    summary,
    description: operation.description || summary,
    domain,
    parameters: allParams,
    requestBody,
    security,
    inputSchema,
    parameterSchemas,
  };
  if (successResponse.schema) ep.responseSchema = successResponse.schema;
  if (operation.deprecated) ep.deprecated = true;
  if (requestExamples) ep.requestExamples = requestExamples;
  if (successResponse.examples) ep.responseExamples = successResponse.examples;
  if (errorResponses) ep.errorResponses = errorResponses;
  return ep;
}

function sanitizeOperationId(
  raw: string | undefined,
  method: string,
  path: string,
): string {
  const base = raw || `${method}_${path.replace(/[^a-zA-Z0-9]/g, "_")}`;
  return base.replace(/\./g, "_").replace(/[^a-z0-9_-]/gi, "_");
}

function deduplicateId(id: string, usedIds: Set<string>): string {
  if (!usedIds.has(id)) {
    usedIds.add(id);
    return id;
  }
  let counter = 1;
  while (usedIds.has(`${id}_${counter}`)) counter++;
  const unique = `${id}_${counter}`;
  usedIds.add(unique);
  return unique;
}

function mergeParameters(
  pathParams?: OpenAPIV3.ParameterObject[],
  opParams?: OpenAPIV3.ParameterObject[],
): OpenAPIV3.ParameterObject[] {
  const path = pathParams || [];
  const op = opParams || [];
  const merged: OpenAPIV3.ParameterObject[] = [];

  path.concat(op).forEach((param) => {
    const idx = merged.findIndex(
      (p) => p.name === param.name && p.in === param.in,
    );
    if (idx >= 0) {
      merged[idx] = param;
    } else {
      merged.push(param);
    }
  });

  return merged;
}

function toParameterObjects(
  params?: (OpenAPIV3.ParameterObject | OpenAPIV3.ReferenceObject)[],
): OpenAPIV3.ParameterObject[] | undefined {
  if (!params) return undefined;

  return params.filter((param): param is OpenAPIV3.ParameterObject => {
    return !("$ref" in param);
  });
}

function isParameterSchemaLocation(
  location: OpenAPIV3.ParameterObject["in"],
): location is ParameterSchemaLocation {
  return PARAMETER_SCHEMA_LOCATIONS.includes(
    location as ParameterSchemaLocation,
  );
}

function buildObjectSchema(
  properties: Record<string, JSONSchema7>,
  required: string[],
): JSONSchema7 | undefined {
  if (Object.keys(properties).length === 0) return undefined;

  return {
    type: "object",
    properties,
    ...(required.length > 0 && { required }),
  };
}

function buildInputSchemas(
  params: OpenAPIV3.ParameterObject[],
  requestBodySchema?: JSONSchema7,
  requestBodyRequired = false,
  maxDepth?: number,
): {
  inputSchema: JSONSchema7;
  parameterSchemas: FullEndpoint["parameterSchemas"];
} {
  const inputProperties: Record<string, JSONSchema7> = {};
  const inputRequired: string[] = [];
  const grouped = Object.fromEntries(
    PARAMETER_SCHEMA_LOCATIONS.map((location) => [
      location,
      {
        properties: {} as Record<string, JSONSchema7>,
        required: [] as string[],
      },
    ]),
  ) as Record<
    ParameterSchemaLocation,
    { properties: Record<string, JSONSchema7>; required: string[] }
  >;

  for (const param of params) {
    if (!param.name || !param.schema) continue;
    if (param.in === "header" && AUTH_HEADER_PARAMS.has(param.name)) continue;

    const paramSchema = mapOpenApiSchemaToJsonSchema(
      param.schema as OpenAPIV3.SchemaObject,
      undefined,
      maxDepth,
    );
    if (param.description && typeof paramSchema === "object") {
      paramSchema.description = param.description;
    }
    if (param.example !== undefined && typeof paramSchema === "object") {
      paramSchema.examples = [param.example];
    }

    inputProperties[param.name] = paramSchema;
    if (param.required) inputRequired.push(param.name);

    if (isParameterSchemaLocation(param.in)) {
      grouped[param.in].properties[param.name] = paramSchema;
      if (param.required) grouped[param.in].required.push(param.name);
    }
  }

  if (requestBodySchema) {
    inputProperties[INPUT_SCHEMA_BODY_KEY] = requestBodySchema;
    if (requestBodyRequired) inputRequired.push(INPUT_SCHEMA_BODY_KEY);
  }

  const parameterSchemas: FullEndpoint["parameterSchemas"] = {};
  for (const location of PARAMETER_SCHEMA_LOCATIONS) {
    const schema = buildObjectSchema(
      grouped[location].properties,
      grouped[location].required,
    );
    if (schema) parameterSchemas[location] = schema;
  }

  const inputSchema: JSONSchema7 = {
    type: "object",
    properties: inputProperties,
    ...(inputRequired.length > 0 && { required: inputRequired }),
  };

  return { inputSchema, parameterSchemas };
}

const CONTENT_TYPE_PRIORITY = [
  "application/json",
  "multipart/form-data",
] as const;

function resolveRequestBodyContent(
  rb: OpenAPIV3.RequestBodyObject,
): ResolvedMediaContent | undefined {
  for (const contentType of CONTENT_TYPE_PRIORITY) {
    const media = rb.content?.[contentType];
    if (media?.schema) {
      return {
        contentType,
        schema: media.schema as OpenAPIV3.SchemaObject,
        examples: extractMediaExamples(media),
      };
    }
  }

  if (rb.content) {
    for (const [contentType, media] of Object.entries(rb.content)) {
      if (media?.schema) {
        return {
          contentType,
          schema: media.schema as OpenAPIV3.SchemaObject,
          examples: extractMediaExamples(media),
        };
      }
    }
  }

  return undefined;
}

function extractSuccessResponse(
  responses: OpenAPIV3.ResponsesObject,
  maxDepth?: number,
): ResponseContent {
  const successCodes = Object.keys(responses)
    .filter((code) => /^2\d{2}$/.test(code))
    .sort();

  for (const code of successCodes) {
    const resp = responses[code];
    if (!resp || "$ref" in resp) continue;

    const media = resp.content?.["application/json"];
    if (!media?.schema) continue;

    return {
      schema: mapOpenApiSchemaToJsonSchema(
        media.schema as OpenAPIV3.SchemaObject,
        undefined,
        maxDepth,
      ),
      examples: extractMediaExamples(media),
    };
  }

  return {};
}

function extractErrorResponses(
  responses: OpenAPIV3.ResponsesObject,
  maxDepth?: number,
): FullEndpoint["errorResponses"] | undefined {
  const errors: NonNullable<FullEndpoint["errorResponses"]> = {};

  for (const code of Object.keys(responses).sort()) {
    if (!/^[45]\d{2}$/.test(code)) continue;

    const resp = responses[code];
    if (!resp || "$ref" in resp) continue;

    const error: { description: string; schema?: JSONSchema7 } = {
      description: resp.description,
    };
    const media = resp.content?.["application/json"];
    if (media?.schema) {
      error.schema = mapOpenApiSchemaToJsonSchema(
        media.schema as OpenAPIV3.SchemaObject,
        undefined,
        maxDepth,
      );
    }
    errors[code] = error;
  }

  return Object.keys(errors).length > 0 ? errors : undefined;
}

function extractMediaExamples(
  media: OpenAPIV3.MediaTypeObject,
): Record<string, unknown> | undefined {
  const examples: Record<string, unknown> = {};

  if (media.examples) {
    Object.assign(examples, media.examples);
  }

  if (media.example !== undefined) {
    const key = examples.default === undefined ? "default" : "example";
    examples[key] = media.example;
  }

  return Object.keys(examples).length > 0 ? examples : undefined;
}
