import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SpecParser } from "../../parser/index.js";
import type { Domain, SpecSource } from "../../parser/index.js";
import type { OpenAPIV3 } from "openapi-types";

function makeSpec(paths?: OpenAPIV3.PathsObject): OpenAPIV3.Document {
  return {
    openapi: "3.0.0",
    info: { title: "Injected", version: "1.0.0" },
    paths: paths ?? {
      "/api/v1/login": {
        post: {
          operationId: "post-api-v1-login",
          summary: "Injected login",
          responses: {
            "200": { description: "OK" },
          },
        },
      },
    },
  };
}

function makeMessagingSpec(): OpenAPIV3.Document {
  return makeSpec({
    "/api/v1/chat.postMessage": {
      post: {
        operationId: "send-message",
        summary: "Send message",
        responses: {
          "200": { description: "OK" },
        },
      },
    },
  });
}

describe("SpecParser", () => {
  it("uses an injected SpecSource", async () => {
    const requestedDomains: Domain[] = [];
    const specSource: SpecSource = {
      async getSpec(domain) {
        requestedDomains.push(domain);
        return makeSpec();
      },
    };

    const parser = new SpecParser({ specSource });
    const endpoints = await parser.listEndpoints(["authentication"]);

    assert.deepStrictEqual(requestedDomains, ["authentication"]);
    assert.deepStrictEqual(endpoints, [
      {
        operationId: "post-api-v1-login",
        summary: "Injected login",
        domain: "authentication",
        path: "/api/v1/login",
        method: "post",
      },
    ]);
  });

  it("fetches only the requested domains in listEndpoints", async () => {
    const requestedDomains: Domain[] = [];
    const specSource: SpecSource = {
      async getSpec(domain) {
        requestedDomains.push(domain);
        return makeSpec();
      },
    };

    const parser = new SpecParser({ specSource });
    const endpoints = await parser.listEndpoints(["messaging"]);

    assert.deepStrictEqual(requestedDomains, ["messaging"]);
    assert.deepStrictEqual(endpoints, [
      {
        operationId: "post-api-v1-login",
        summary: "Injected login",
        domain: "messaging",
        path: "/api/v1/login",
        method: "post",
      },
    ]);
  });

  it("uses indexed locations when getFullEndpoints follows listEndpoints", async () => {
    const requestedDomains: Domain[] = [];
    const specSource: SpecSource = {
      async getSpec(domain) {
        requestedDomains.push(domain);
        return makeSpec();
      },
    };

    const parser = new SpecParser({ specSource });
    await parser.listEndpoints(["authentication"]);
    requestedDomains.length = 0;

    const result = await parser.getFullEndpoints(["post-api-v1-login"]);

    assert.deepStrictEqual(requestedDomains, ["authentication"]);
    assert.deepStrictEqual(
      result.endpoints.map((endpoint) => ({
        operationId: endpoint.operationId,
        domain: endpoint.domain,
        path: endpoint.path,
        method: endpoint.method,
      })),
      [
        {
          operationId: "post-api-v1-login",
          domain: "authentication",
          path: "/api/v1/login",
          method: "POST",
        },
      ],
    );
  });

  it("falls back for unindexed IDs while reusing cached indexed specs", async () => {
    const requestedDomains: Domain[] = [];
    const specSource: SpecSource = {
      async getSpec(domain) {
        requestedDomains.push(domain);
        return domain === "messaging" ? makeMessagingSpec() : makeSpec();
      },
    };

    const parser = new SpecParser({ specSource });
    await parser.listEndpoints(["authentication"]);
    requestedDomains.length = 0;

    const result = await parser.getFullEndpoints(
      ["post-api-v1-login", "send-message"],
      ["authentication", "messaging"],
    );

    assert.deepStrictEqual(requestedDomains, ["authentication", "messaging"]);
    assert.deepStrictEqual(
      result.endpoints.map((endpoint) => endpoint.operationId).sort(),
      ["post-api-v1-login", "send-message"],
    );
  });
});
