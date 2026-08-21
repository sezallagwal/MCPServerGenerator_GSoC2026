import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runWorkflow } from "../../workflow/executor.js";
import type {
  ApiResponse,
  EndpointInfo,
  WorkflowClient,
  WorkflowServer,
} from "../../workflow/executor.js";
import type { WorkflowDefinition } from "../../workflow/types.js";

/** By-verb routing put a query parameter in a POST body; both halves are pinned here. */

interface Seen {
  method: string;
  path: string;
  auth?: boolean;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
}

const server: WorkflowServer = {
  async createMessage() {
    return { content: { type: "text", text: "" } };
  },
};

/** Run a single api_call step and report exactly what reached the client. */
async function callOnce(
  endpoint: EndpointInfo,
  inputMapping: Record<string, unknown>,
): Promise<Seen> {
  const seen: Seen[] = [];
  const client: WorkflowClient = {
    async request(method, path, options): Promise<ApiResponse> {
      seen.push({
        method,
        path,
        auth: options?.auth,
        body: options?.body,
        headers: options?.headers,
      });
      return { ok: true, status: 200, data: { ok: true } };
    },
  };
  const workflow: WorkflowDefinition = {
    name: "wf",
    description: "d",
    params: { type: "object", properties: {} },
    steps: [
      {
        id: "s",
        label: "s",
        config: { type: "api_call", operationId: "op", inputMapping },
      },
    ],
    requiredEndpoints: ["op"],
    usesSampling: false,
    usesElicitation: false,
  };
  await runWorkflow(
    workflow,
    {},
    { client, server, endpoints: { op: endpoint } },
  );
  assert.equal(seen.length, 1, "expected exactly one request");
  return seen[0];
}

describe("declared parameter locations are honoured", () => {
  it("sends a declared query parameter on the query string of a POST", async () => {
    const seen = await callOnce(
      { method: "POST", path: "/pets", queryParams: ["dryRun"] },
      { name: "Rex", dryRun: "true" },
    );
    assert.equal(seen.path, "/pets?dryRun=true");
    assert.deepEqual(
      seen.body,
      { name: "Rex" },
      "a declared query parameter must not also land in the body",
    );
  });

  it("sends a declared header parameter as a request header", async () => {
    const seen = await callOnce(
      { method: "POST", path: "/pets", headerParams: ["X-Request-Id"] },
      { name: "Rex", "X-Request-Id": "abc123" },
    );
    assert.deepEqual(seen.headers, { "X-Request-Id": "abc123" });
    assert.deepEqual(seen.body, { name: "Rex" });
    assert.ok(
      !seen.path.includes("X-Request-Id"),
      "a header parameter must not leak into the query string",
    );
  });

  it("splits query, header and body in one call", async () => {
    const seen = await callOnce(
      {
        method: "POST",
        path: "/pets",
        queryParams: ["dryRun"],
        headerParams: ["X-Request-Id"],
      },
      { name: "Rex", dryRun: "true", "X-Request-Id": "abc123" },
    );
    assert.equal(seen.path, "/pets?dryRun=true");
    assert.deepEqual(seen.headers, { "X-Request-Id": "abc123" });
    assert.deepEqual(seen.body, { name: "Rex" });
  });

  it("keeps a declared query parameter on the query string for a GET too", async () => {
    const seen = await callOnce(
      { method: "GET", path: "/pets", queryParams: ["limit"] },
      { limit: 5 },
    );
    assert.equal(seen.path, "/pets?limit=5");
    assert.equal(seen.body, undefined);
  });

  it("substitutes path parameters and does not resend them elsewhere", async () => {
    const seen = await callOnce(
      { method: "GET", path: "/pets/{petId}", queryParams: ["limit"] },
      { petId: "p-1", limit: 2 },
    );
    assert.equal(seen.path, "/pets/p-1?limit=2");
  });

  it("sends no body when every value belongs on the query string", async () => {
    const seen = await callOnce(
      { method: "POST", path: "/pets", queryParams: ["dryRun"] },
      { dryRun: "true" },
    );
    assert.equal(seen.body, undefined);
  });
});

describe("an endpoint with no declared locations keeps the verb-based fallback", () => {
  it("puts everything in the body for a POST", async () => {
    const seen = await callOnce(
      { method: "POST", path: "/legacy" },
      { a: "1", b: "2" },
    );
    assert.equal(seen.path, "/legacy");
    assert.deepEqual(seen.body, { a: "1", b: "2" });
    assert.equal(seen.headers, undefined);
  });

  it("puts everything on the query string for a GET", async () => {
    const seen = await callOnce({ method: "GET", path: "/legacy" }, { a: "1" });
    assert.equal(seen.path, "/legacy?a=1");
    assert.equal(seen.body, undefined);
  });
});

describe("per-endpoint authentication", () => {
  it("omits credentials for an operation the spec marks public", async () => {
    const seen = await callOnce(
      { method: "GET", path: "/public", auth: false },
      {},
    );
    assert.equal(seen.auth, false);
  });

  it("authenticates anything not explicitly marked public", async () => {
    for (const endpoint of [
      { method: "GET", path: "/a" },
      { method: "GET", path: "/b", auth: true },
    ] satisfies EndpointInfo[]) {
      const seen = await callOnce(endpoint, {});
      assert.equal(
        seen.auth,
        true,
        "an unclassified operation must stay authenticated",
      );
    }
  });
});
