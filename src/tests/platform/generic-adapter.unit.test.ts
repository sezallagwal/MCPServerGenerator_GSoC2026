import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GenericOpenAPIAdapter } from "../../platform/generic-adapter.js";

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

/** A misread spec yields a server that looks right and then fails at every call. */

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

async function adapterFor(spec: unknown): Promise<GenericOpenAPIAdapter> {
  const srv = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(spec));
  });
  await new Promise<void>((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve()),
  );
  const port = (srv.address() as { port: number }).port;
  try {
    const adapter = new GenericOpenAPIAdapter({
      specUrl: `http://127.0.0.1:${port}/openapi.json`,
    });
    await adapter.init();
    return adapter;
  } finally {
    srv.close();
  }
}

const OK = { "200": { description: "ok" } };

function spec(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    openapi: "3.0.0",
    info: { title: "Test API", version: "1.0.0" },
    paths: {},
    ...overrides,
  };
}

describe("auth scheme selection follows what the spec requires", () => {
  /** Taking the first recognised declaration wired a retired scheme and 401'd every call. */
  it("prefers a scheme named in the top-level security block over declaration order", async () => {
    const adapter = await adapterFor(
      spec({
        components: {
          securitySchemes: {
            legacyBasic: { type: "http", scheme: "basic" },
            bearerAuth: { type: "http", scheme: "bearer" },
          },
        },
        security: [{ bearerAuth: [] }],
        paths: {
          "/a": { get: { operationId: "a", tags: ["a"], responses: OK } },
        },
      }),
    );
    const client = adapter.generateRestClientCode();
    assert.match(client, /"Bearer "/);
    assert.ok(
      !client.includes('"Basic "'),
      "the declared-but-unrequired basic scheme must not be wired",
    );
  });

  it("picks the required scheme even when a better-supported one is merely declared", async () => {
    // Ranking is not enough: declaring bearer but requiring a query key must get the key.
    const adapter = await adapterFor(
      spec({
        components: {
          securitySchemes: {
            bearerAuth: { type: "http", scheme: "bearer" },
            apiKeyQuery: { type: "apiKey", in: "query", name: "api_key" },
          },
        },
        security: [{ apiKeyQuery: [] }],
        paths: {
          "/a": { get: { operationId: "a", tags: ["a"], responses: OK } },
        },
      }),
    );
    const client = adapter.generateRestClientCode();
    assert.match(client, /"api_key" \+ "="/);
    assert.ok(
      !client.includes('"Bearer "'),
      "a declared-but-unrequired bearer scheme must not win on preference alone",
    );
  });

  it("prefers a scheme required by an operation when there is no global requirement", async () => {
    const adapter = await adapterFor(
      spec({
        components: {
          securitySchemes: {
            legacyBasic: { type: "http", scheme: "basic" },
            bearerAuth: { type: "http", scheme: "bearer" },
          },
        },
        paths: {
          "/a": {
            get: {
              operationId: "a",
              tags: ["a"],
              security: [{ bearerAuth: [] }],
              responses: OK,
            },
          },
        },
      }),
    );
    assert.match(adapter.generateRestClientCode(), /"Bearer "/);
  });

  it("generates an unauthenticated client for a scheme it cannot wire", async () => {
    const adapter = await adapterFor(
      spec({
        components: {
          securitySchemes: {
            oauth: { type: "oauth2", flows: {} },
          },
        },
        security: [{ oauth: [] }],
        paths: {
          "/a": { get: { operationId: "a", tags: ["a"], responses: OK } },
        },
      }),
    );
    const client = adapter.generateRestClientCode();
    assert.ok(!client.includes("process.env.API_BEARER_TOKEN"));
    assert.ok(!client.includes("process.env.API_KEY"));
  });
});

describe("an apiKey is sent where the spec says it goes", () => {
  /** An invented `X-API-Key` default sent a header the API never reads, skipping the query. */
  async function clientFor(scheme: Record<string, unknown>): Promise<string> {
    const adapter = await adapterFor(
      spec({
        components: { securitySchemes: { k: scheme } },
        security: [{ k: [] }],
        paths: {
          "/pets": {
            get: { operationId: "listPets", tags: ["p"], responses: OK },
          },
        },
      }),
    );
    return adapter.generateRestClientCode();
  }

  it("in: header uses the spec's own header name, never an invented default", async () => {
    const client = await clientFor({
      type: "apiKey",
      in: "header",
      name: "X-Custom-Key",
    });
    assert.match(client, /headers\["X-Custom-Key"\]/);
    assert.ok(!client.includes("X-API-Key"), "no invented header name");
  });

  it("in: query builds a query parameter and no header", async () => {
    const client = await clientFor({
      type: "apiKey",
      in: "query",
      name: "api_key",
    });
    assert.match(client, /"api_key" \+ "="/);
    assert.ok(
      !/headers\[[^\]]*\] = process\.env\.API_KEY/.test(client),
      "a query credential must not be emitted as a header",
    );
  });

  it("in: cookie sends a Cookie header", async () => {
    const client = await clientFor({
      type: "apiKey",
      in: "cookie",
      name: "SESSION",
    });
    assert.match(client, /headers\["Cookie"\]/);
    assert.match(client, /"SESSION"/);
  });

  it("refuses to generate for an apiKey scheme with no name", async () => {
    const adapter = await adapterFor(
      spec({
        components: {
          securitySchemes: { k: { type: "apiKey", in: "header" } },
        },
        security: [{ k: [] }],
        paths: {
          "/a": { get: { operationId: "a", tags: ["a"], responses: OK } },
        },
      }),
    );
    assert.throws(
      () => adapter.generateRestClientCode(),
      /missing its required `name`/,
    );
  });

  it("puts a query credential on the wire, merged with an existing query string", async () => {
    // Emitting the snippet is not the same as the credential reaching the server.
    const seen: string[] = [];
    const echo = createServer((req, res) => {
      seen.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve) =>
      echo.listen(0, "127.0.0.1", () => resolve()),
    );
    const echoPort = (echo.address() as { port: number }).port;

    // Under the project root because the file is imported, so tsx has to transform it.
    const dir = mkdtempSync(join(repoRoot, ".tmp-generic-client-"));
    tempDirs.push(dir);
    const saved = { ...process.env };
    try {
      const source = await clientFor({
        type: "apiKey",
        in: "query",
        name: "api_key",
      });
      const file = join(dir, "api-client.ts");
      writeFileSync(file, source, "utf-8");

      // The generated client reads API_BASE_URL at module load.
      process.env.API_BASE_URL = `http://127.0.0.1:${echoPort}`;
      process.env.API_KEY = "SECRET123";
      const mod = (await import(pathToFileURL(file).href)) as {
        client: {
          request: (
            m: string,
            p: string,
            o?: { auth?: boolean },
          ) => Promise<{ ok: boolean }>;
        };
      };

      await mod.client.request("GET", "/pets?limit=5", { auth: true });
      assert.equal(seen[0], "/pets?limit=5&api_key=SECRET123");

      await mod.client.request("GET", "/pets", { auth: false });
      assert.equal(
        seen[1],
        "/pets",
        "an unauthenticated call must not leak the credential",
      );
    } finally {
      process.env = saved;
      echo.close();
    }
  });
});

describe("operationIds are indexed without losing endpoints", () => {
  /** One `map.set` pass collapsed duplicate ids and let a synthesized id win over an explicit. */
  it("keeps the first of two duplicate operationIds and reports the collision", async () => {
    const adapter = await adapterFor(
      spec({
        paths: {
          "/pets": {
            get: { operationId: "list", tags: ["pets"], responses: OK },
          },
          "/stores": {
            get: { operationId: "list", tags: ["stores"], responses: OK },
          },
        },
      }),
    );
    const derived = adapter.deriveEndpointFromOperationId("list");
    assert.equal(derived?.method, "GET");
    assert.equal(
      derived?.path,
      "/pets",
      "the first declaration wins, deterministically",
    );
  });

  it("never lets a synthesized id displace an explicit one", async () => {
    const adapter = await adapterFor(
      spec({
        paths: {
          // No operationId: synthesized from the route as `get-pets--id-`.
          "/pets/{id}": { get: { tags: ["pets"], responses: OK } },
          // Explicitly claims the id the synthesizer would produce.
          "/other": {
            get: {
              operationId: "get-pets--id-",
              tags: ["pets"],
              responses: OK,
            },
          },
        },
      }),
    );
    const endpoints = await adapter.listEndpoints(
      adapter.getAvailableDomains(),
    );
    assert.equal(
      endpoints.length,
      2,
      "both operations must remain addressable",
    );
    assert.equal(
      adapter.deriveEndpointFromOperationId("get-pets--id-")?.path,
      "/other",
      "the explicit id keeps its route; the synthesized one is suffixed",
    );
  });

  it("returns null for an operationId the spec does not contain", async () => {
    const adapter = await adapterFor(
      spec({
        paths: {
          "/a": { get: { operationId: "a", tags: ["a"], responses: OK } },
        },
      }),
    );
    assert.equal(adapter.deriveEndpointFromOperationId("notInSpec"), null);
  });
});

describe("schemas come from the media type the client actually speaks", () => {
  it("prefers application/json over a media type listed first", async () => {
    const adapter = await adapterFor(
      spec({
        paths: {
          "/x": {
            post: {
              operationId: "x",
              tags: ["x"],
              requestBody: {
                required: true,
                content: {
                  "application/xml": {
                    schema: {
                      type: "object",
                      properties: { xmlOnly: { type: "string" } },
                    },
                  },
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { jsonField: { type: "string" } },
                    },
                  },
                },
              },
              responses: OK,
            },
          },
        },
      }),
    );
    const { endpoints } = await adapter.getFullEndpoints(["x"]);
    assert.equal(endpoints[0].requestBody?.contentType, "application/json");
    assert.deepEqual(Object.keys(endpoints[0].inputSchema.properties ?? {}), [
      "jsonField",
    ]);
  });

  it("recognises a +json vendor media type", async () => {
    const adapter = await adapterFor(
      spec({
        paths: {
          "/x": {
            get: {
              operationId: "x",
              tags: ["x"],
              responses: {
                "200": {
                  description: "ok",
                  content: {
                    "application/vnd.api+json": {
                      schema: {
                        type: "object",
                        properties: { id: { type: "string" } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );
    const { endpoints } = await adapter.getFullEndpoints(["x"]);
    assert.ok(
      endpoints[0].responseSchema,
      "a vendor JSON response must still yield a schema for {{steps.X.result.Y}}",
    );
  });

  it("recognises a 2XX range response code", async () => {
    const adapter = await adapterFor(
      spec({
        paths: {
          "/x": {
            get: {
              operationId: "x",
              tags: ["x"],
              responses: {
                "2XX": {
                  description: "ok",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: { n: { type: "number" } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );
    const { endpoints } = await adapter.getFullEndpoints(["x"]);
    assert.ok(endpoints[0].responseSchema);
  });

  it("returns a serializable schema for a recursive $ref", async () => {
    // A dereferenced recursive $ref is a real cycle, and get_endpoint_schemas serializes it.
    const adapter = await adapterFor(
      spec({
        components: {
          schemas: {
            Node: {
              type: "object",
              properties: {
                name: { type: "string" },
                children: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Node" },
                },
              },
            },
          },
        },
        paths: {
          "/nodes": {
            post: {
              operationId: "createNode",
              tags: ["nodes"],
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Node" },
                  },
                },
              },
              responses: OK,
            },
          },
        },
      }),
    );
    const { endpoints } = await adapter.getFullEndpoints(
      ["createNode"],
      undefined,
      5,
    );
    assert.doesNotThrow(
      () => JSON.stringify(endpoints[0]),
      "a cyclic schema must be broken before it reaches a consumer that serializes",
    );
  });
});

describe("codegen refuses to run before the spec is loaded", () => {
  /** Without the guard, codegen emitted a project pointing at localhost:8080 with no auth. */
  it("throws from every method that reads the spec", () => {
    const cold = new GenericOpenAPIAdapter({
      specUrl: "http://127.0.0.1:1/openapi.json",
    });
    assert.throws(
      () => cold.generateRestClientCode(),
      /before the spec was loaded/,
    );
    assert.throws(
      () => cold.generateEnvExample(),
      /before the spec was loaded/,
    );
    assert.throws(
      () => cold.generateReadme("s", [], []),
      /before the spec was loaded/,
    );
  });

  it("still answers for a constant that does not depend on the spec", () => {
    const cold = new GenericOpenAPIAdapter({
      specUrl: "http://127.0.0.1:1/openapi.json",
    });
    assert.equal(cold.clientFileName(), "api-client.ts");
  });
});

describe("the generated client bounds a response by streaming it", () => {
  it("reads the body through a reader rather than buffering it whole", async () => {
    // `res.text()` buffers everything first, so a chunked body defeats a later cap.
    const adapter = await adapterFor(
      spec({
        paths: {
          "/a": { get: { operationId: "a", tags: ["a"], responses: OK } },
        },
      }),
    );
    const client = adapter.generateRestClientCode();
    assert.match(client, /getReader\(\)/);
    assert.match(client, /MAX_RESPONSE_BYTES/);
    assert.ok(
      !client.includes("await res.text()"),
      "res.text() cannot be size-capped after the fact",
    );
  });
});
