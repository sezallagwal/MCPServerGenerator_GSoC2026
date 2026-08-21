import type { OpenAPIV3 } from "openapi-types";
import type { JSONSchema7, JSONSchema7TypeName } from "json-schema";

const OPENAPI_ONLY_KEYS = new Set([
  "nullable",
  "discriminator",
  "xml",
  "externalDocs",
  "example",
]);

const RECURSIVE_KEYS = new Set([
  "properties",
  "additionalProperties",
  "items",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
]);

export function mapOpenApiSchemaToJsonSchema(
  schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject,
  seen: WeakSet<object> = new WeakSet(),
  maxDepth: number = Infinity,
  currentDepth: number = 0,
): JSONSchema7 {
  if (currentDepth >= maxDepth) {
    return { type: "object" };
  }

  if (typeof schema === "boolean") {
    return { type: "object" };
  }

  if ("$ref" in schema) {
    return { type: "object" };
  }

  if (seen.has(schema)) {
    return { type: "object" };
  }
  seen.add(schema);

  try {
    const jsonSchema: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema)) {
      if (OPENAPI_ONLY_KEYS.has(key) || RECURSIVE_KEYS.has(key)) continue;
      jsonSchema[key] = value;
    }

    if (schema.nullable && typeof jsonSchema.type === "string") {
      jsonSchema.type = [jsonSchema.type as JSONSchema7TypeName, "null"];
    }

    const schemaAny = schema as Record<string, unknown>;
    if (schemaAny.example !== undefined) {
      const existing = Array.isArray(schemaAny.examples)
        ? schemaAny.examples
        : [];
      jsonSchema.examples = [schemaAny.example, ...existing];
    }

    if (typeof jsonSchema.exclusiveMinimum !== "number") {
      delete jsonSchema.exclusiveMinimum;
    }
    if (typeof jsonSchema.exclusiveMaximum !== "number") {
      delete jsonSchema.exclusiveMaximum;
    }

    if (schema.type === "object" && schema.properties) {
      jsonSchema.properties = {};
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (typeof propSchema === "object" && propSchema !== null) {
          (jsonSchema.properties as Record<string, JSONSchema7>)[key] =
            mapOpenApiSchemaToJsonSchema(
              propSchema as OpenAPIV3.SchemaObject,
              seen,
              maxDepth,
              currentDepth + 1,
            );
        }
      }
    }

    if (schema.additionalProperties !== undefined) {
      jsonSchema.additionalProperties =
        typeof schema.additionalProperties === "object"
          ? mapOpenApiSchemaToJsonSchema(
              schema.additionalProperties as OpenAPIV3.SchemaObject,
              seen,
              maxDepth,
              currentDepth + 1,
            )
          : schema.additionalProperties;
    }

    if (
      schema.type === "array" &&
      typeof schema.items === "object" &&
      schema.items !== null
    ) {
      jsonSchema.items = mapOpenApiSchemaToJsonSchema(
        schema.items as OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject,
        seen,
        maxDepth,
        currentDepth + 1,
      );
    }

    for (const key of ["oneOf", "anyOf", "allOf"] as const) {
      if (!schema[key]) continue;
      jsonSchema[key] = schema[key].map((s) =>
        mapOpenApiSchemaToJsonSchema(
          s as OpenAPIV3.SchemaObject,
          seen,
          maxDepth,
          currentDepth,
        ),
      );
    }

    if (typeof schemaAny.not === "object" && schemaAny.not !== null) {
      jsonSchema.not = mapOpenApiSchemaToJsonSchema(
        schemaAny.not as OpenAPIV3.SchemaObject,
        seen,
        maxDepth,
        currentDepth,
      );
    }

    return jsonSchema as JSONSchema7;
  } finally {
    seen.delete(schema);
  }
}
