import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  RocketChatAdapter,
  normalizeRocketChatOperations,
} from "../../platform/rocketchat-adapter.js";
import type { ApiCallStep, WorkflowDefinition } from "../../workflow/types.js";

function apiWorkflow(
  steps: Array<{
    id: string;
    operationId: string;
    inputMapping?: Record<string, unknown>;
  }>,
): WorkflowDefinition {
  return {
    name: "wf",
    description: "d",
    params: { type: "object", properties: {} },
    steps: steps.map((s) => ({
      id: s.id,
      label: s.id,
      config: {
        type: "api_call",
        operationId: s.operationId,
        inputMapping: s.inputMapping ?? {},
      },
    })),
    requiredEndpoints: steps.map((s) => s.operationId),
    usesSampling: false,
    usesElicitation: false,
  };
}

const opOf = (wf: WorkflowDefinition, i = 0) =>
  (wf.steps[i].config as ApiCallStep).operationId;
const mappingOf = (wf: WorkflowDefinition, i = 0) =>
  (wf.steps[i].config as ApiCallStep).inputMapping;

describe("shouldContinueOnError only tolerates genuine no-ops", () => {
  /** Tolerance was inferred from a step's fields, so deletions reported success after failing. */
  const adapter = new RocketChatAdapter();

  const tolerated = [
    "post-api-v1-channels_create",
    "post-api-v1-groups_create",
    "post-api-v1-rooms_muteUser",
    "post-api-v1-rooms_unmuteUser",
  ];

  const mustFailTheRun = [
    "post-api-v1-channels_delete",
    "post-api-v1-groups_delete",
    "post-api-v1-chat_delete",
    "post-api-v1-rooms_cleanHistory",
    "post-api-v1-channels_archive",
    "post-api-v1-channels_kick",
    "post-api-v1-chat_postMessage",
    "post-api-v1-chat_update",
    "get-api-v1-channels_info",
  ];

  for (const operationId of tolerated) {
    it(`tolerates ${operationId}`, () => {
      assert.equal(adapter.shouldContinueOnError(operationId), true);
    });
  }

  for (const operationId of mustFailTheRun) {
    it(`does not tolerate ${operationId}`, () => {
      assert.equal(
        adapter.shouldContinueOnError(operationId),
        false,
        `${operationId} must abort the workflow when it fails`,
      );
    });
  }

  it("tolerates exactly four operations and no more", () => {
    // Pins the allowlist size, so a broad heuristic cannot come back unnoticed.
    const probes = [...tolerated, ...mustFailTheRun];
    const allowed = probes.filter((op) => adapter.shouldContinueOnError(op));
    assert.deepEqual(allowed.sort(), [...tolerated].sort());
  });
});

describe("normalizeOperations remaps channel/group by requested visibility", () => {
  const adapter = new RocketChatAdapter();

  it("swaps a channels_* create asking for a private room, dropping the redundant type", () => {
    const wf = apiWorkflow([
      {
        id: "s",
        operationId: "post-api-v1-channels_create",
        inputMapping: { name: "x", type: "p" },
      },
    ]);
    adapter.normalizeOperations([wf]);
    assert.equal(opOf(wf), "post-api-v1-groups_create");
    assert.deepEqual(mappingOf(wf), { name: "x" });
  });

  it("swaps a groups_* create asking for a public room", () => {
    const wf = apiWorkflow([
      {
        id: "s",
        operationId: "post-api-v1-groups_create",
        inputMapping: { name: "x", type: "c" },
      },
    ]);
    adapter.normalizeOperations([wf]);
    assert.equal(opOf(wf), "post-api-v1-channels_create");
  });

  it("leaves an operation alone when no type is requested", () => {
    const wf = apiWorkflow([
      {
        id: "s",
        operationId: "post-api-v1-channels_create",
        inputMapping: { name: "x" },
      },
    ]);
    adapter.normalizeOperations([wf]);
    assert.equal(opOf(wf), "post-api-v1-channels_create");
  });

  it("never rewrites channels_join, which has no valid counterpart", () => {
    // `groups_invite` needs a userId a join never supplies, and self-joining a group is barred.
    const wf = apiWorkflow([
      {
        id: "s",
        operationId: "post-api-v1-channels_join",
        inputMapping: { roomId: "R", type: "p" },
      },
    ]);
    adapter.normalizeOperations([wf]);
    assert.equal(opOf(wf), "post-api-v1-channels_join");
    assert.deepEqual(
      mappingOf(wf),
      { roomId: "R", type: "p" },
      "an unmapped operation must be left exactly as authored so it fails visibly",
    );
  });

  it("keeps requiredEndpoints in step with a remap", () => {
    const wf = apiWorkflow([
      {
        id: "s",
        operationId: "post-api-v1-channels_create",
        inputMapping: { name: "x", type: "p" },
      },
    ]);
    adapter.normalizeOperations([wf]);
    assert.deepEqual(wf.requiredEndpoints, ["post-api-v1-groups_create"]);
  });

  it("is callable directly and behaves identically", () => {
    const wf = apiWorkflow([
      {
        id: "s",
        operationId: "post-api-v1-channels_create",
        inputMapping: { name: "x", type: "private" },
      },
    ]);
    normalizeRocketChatOperations([wf]);
    assert.equal(opOf(wf), "post-api-v1-groups_create");
  });
});

describe("requiredEndpoints is a set, not a call log", () => {
  /** A duplicate entry leaked into every generated tool's workflow JSON and its smoke test. */
  it("de-duplicates when several steps share an endpoint", () => {
    const wf = apiWorkflow([
      {
        id: "a",
        operationId: "post-api-v1-chat_postMessage",
        inputMapping: { channel: "#a" },
      },
      {
        id: "b",
        operationId: "post-api-v1-chat_postMessage",
        inputMapping: { channel: "#b" },
      },
    ]);
    new RocketChatAdapter().normalizeOperations([wf]);
    assert.deepEqual(wf.requiredEndpoints, ["post-api-v1-chat_postMessage"]);
  });
});
