import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PlatformAdapter } from "./platform/adapter.js";
import { RocketChatAdapter } from "./platform/rocketchat-adapter.js";
import { handleGetCapabilityGuide } from "./tools/get-capability-guide.js";
import { handleGetEndpointSchemas } from "./tools/get-endpoint-schemas.js";
import { handleGenerate } from "./tools/generate.js";

/** The adapter is the single source of truth, so discovery and generation cannot diverge. */
export function createMcpServer(adapter?: PlatformAdapter): {
  server: McpServer;
  adapter: PlatformAdapter;
} {
  const resolvedAdapter = adapter ?? new RocketChatAdapter();

  const server = new McpServer({
    name: "mcp-server-generator",
    version: "0.1.0",
  });

  server.registerTool(
    "get_capability_guide",
    {
      description:
        "Returns ALL Rocket.Chat API endpoints (with operationIds) in one guide. " +
        "This is the discovery tool — call it FIRST. " +
        "API entries show 'summary → operationId' — use operationIds in workflow steps. " +
        "After picking ALL needed operationIds, call get_endpoint_schemas ONCE with ALL of them in a single call BEFORE writing workflows.",
    },
    async () => handleGetCapabilityGuide(resolvedAdapter),
  );

  server.registerTool(
    "get_endpoint_schemas",
    {
      description:
        "Get exact request/response schemas for chosen operationIds. " +
        "Call this AFTER get_capability_guide, BEFORE writing your DSL for generate. " +
        "IMPORTANT: Pass ALL operationIds you need in a SINGLE call — do NOT split across multiple calls. There is no limit on array size. " +
        "Returns request body schemas (exact field names for inputMapping) and response shape summaries (for {{steps.X.result.Y}} references). " +
        "If you need both channels_* and groups_* variants, request both explicitly.",
      inputSchema: {
        operationIds: z.array(z.string()),
      },
      outputSchema: {
        endpoints: z.record(z.string(), z.record(z.string(), z.unknown())),
        correctedOperationIds: z.record(z.string(), z.string()).optional(),
        unmatchedOperationIds: z.array(z.string()).optional(),
      },
    },
    async ({ operationIds }) =>
      handleGetEndpointSchemas(resolvedAdapter, operationIds),
  );

  server.registerTool(
    "generate",
    {
      description:
        "Generate a complete, runnable MCP server project from a workflow DSL document. " +
        "Call this LAST, after get_capability_guide and get_endpoint_schemas. " +
        "Pass the full DSL in one call; the endpoints referenced by the workflows are resolved automatically. " +
        "Writes the project (server entry, Rocket.Chat client, vendored workflow engine, one tool per workflow, README) to disk. " +
        'Pass writeMode "additive" to add workflows to an existing generated project without overwriting files the user has since edited. ' +
        'Pass transport "http" to emit a Streamable HTTP server instead of a stdio one.',
      inputSchema: {
        dsl: z.string(),
        outputDir: z.string().optional(),
        writeMode: z.enum(["overwrite", "additive"]).optional(),
        transport: z.enum(["stdio", "http"]).optional(),
      },
    },
    async ({ dsl, outputDir, writeMode, transport }) =>
      handleGenerate({
        dsl,
        outputDir,
        writeMode,
        transport,
        adapter: resolvedAdapter,
      }),
  );

  return { server, adapter: resolvedAdapter };
}
