import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveEndpointFromOperationId } from "../../generator/derive-endpoint.js";
import { deriveEndpoints } from "../../generator/pipeline.js";
import { RocketChatAdapter } from "../../platform/rocketchat-adapter.js";
import type { WorkflowDefinition } from "../../workflow/types.js";

/** Must fail closed: a guessed route looks plausible in the map and only fails at runtime. */

function workflowRequiring(...operationIds: string[]): WorkflowDefinition {
  return {
    name: "wf",
    description: "d",
    params: { type: "object", properties: {} },
    steps: [],
    requiredEndpoints: operationIds,
    usesSampling: false,
    usesElicitation: false,
  };
}

describe("deriveEndpointFromOperationId", () => {
  it("reverses a well-formed Rocket.Chat operationId", () => {
    assert.deepEqual(
      deriveEndpointFromOperationId("post-api-v1-channels_create"),
      { method: "POST", path: "/api/v1/channels.create" },
    );
    assert.deepEqual(
      deriveEndpointFromOperationId("get-api-v1-chat_getPinnedMessages"),
      { method: "GET", path: "/api/v1/chat.getPinnedMessages" },
    );
    assert.deepEqual(deriveEndpointFromOperationId("post-api-v1-login"), {
      method: "POST",
      path: "/api/v1/login",
    });
  });

  it("returns null rather than guessing for an id with no method prefix", () => {
    // This used to fall through to `GET /api/v1/<id>`: wrong verb and wrong path.
    assert.equal(deriveEndpointFromOperationId("channels_create"), null);
    assert.equal(deriveEndpointFromOperationId("chat.postMessage"), null);
  });

  it("returns null for an unknown HTTP method or a missing api-v1 segment", () => {
    assert.equal(deriveEndpointFromOperationId("fetch-api-v1-thing"), null);
    assert.equal(deriveEndpointFromOperationId("post-v2-thing"), null);
    assert.equal(deriveEndpointFromOperationId(""), null);
  });
});

describe("deriveEndpoints fails closed", () => {
  const adapter = new RocketChatAdapter();

  it("resolves every id it can", () => {
    const endpoints = deriveEndpoints(
      [workflowRequiring("post-api-v1-chat_postMessage")],
      adapter,
    );
    assert.deepEqual(endpoints, [
      {
        operationId: "post-api-v1-chat_postMessage",
        method: "POST",
        path: "/api/v1/chat.postMessage",
      },
    ]);
  });

  it("throws naming every unresolvable id instead of emitting a guess", () => {
    assert.throws(
      () =>
        deriveEndpoints(
          [workflowRequiring("chat.postMessage", "channels_create")],
          adapter,
        ),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        assert.match(message, /chat\.postMessage/);
        assert.match(message, /channels_create/);
        assert.match(message, /Rocket\.Chat/);
        return true;
      },
    );
  });

  it("throws even when only one id out of several is unresolvable", () => {
    assert.throws(
      () =>
        deriveEndpoints(
          [workflowRequiring("post-api-v1-chat_postMessage", "bogus")],
          adapter,
        ),
      /bogus/,
    );
  });

  it("de-duplicates ids across workflows", () => {
    const endpoints = deriveEndpoints(
      [
        workflowRequiring("post-api-v1-chat_postMessage"),
        workflowRequiring("post-api-v1-chat_postMessage"),
      ],
      adapter,
    );
    assert.equal(endpoints.length, 1);
  });
});
