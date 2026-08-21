import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveRequiredPermissions } from "../../generator/permissions.js";
import type { WorkflowDefinition } from "../../workflow/types.js";

/** A purely category-wide map both over-granted and under-granted. Presence/absence only. */
function permissionsFor(...operationIds: string[]): string[] {
  const workflow: WorkflowDefinition = {
    name: "wf",
    description: "d",
    params: { type: "object", properties: {} },
    steps: [],
    requiredEndpoints: operationIds,
    usesSampling: false,
    usesElicitation: false,
  };
  return deriveRequiredPermissions([workflow]);
}

const DESTRUCTIVE = [
  "clean-channel-history",
  "archive-room",
  "unarchive-room",
  "delete-c",
  "delete-p",
  "delete-message",
  "edit-message",
  "remove-user",
  "set-readonly",
  "edit-room",
];

describe("read-only operations ask for no destructive rights", () => {
  for (const operationId of [
    "get-api-v1-channels_info",
    "get-api-v1-channels_list",
    "get-api-v1-channels_history",
    "get-api-v1-groups_info",
    "get-api-v1-chat_getMessage",
    "get-api-v1-users_info",
  ]) {
    it(operationId, () => {
      const granted = permissionsFor(operationId);
      for (const right of DESTRUCTIVE) {
        assert.ok(
          !granted.includes(right),
          `reading via ${operationId} must not require "${right}" — got: ${granted.join(", ")}`,
        );
      }
    });
  }

  it("still grants the view rights a read needs", () => {
    const granted = permissionsFor("get-api-v1-channels_info");
    assert.ok(granted.includes("view-c-room"));
    assert.ok(granted.includes("view-joined-room"));
  });
});

describe("privileged rights are granted only to the operation that needs them", () => {
  const cases: Array<[string, string]> = [
    ["post-api-v1-channels_create", "create-c"],
    ["post-api-v1-groups_create", "create-p"],
    ["post-api-v1-channels_archive", "archive-room"],
    ["post-api-v1-channels_unarchive", "unarchive-room"],
    ["post-api-v1-channels_delete", "delete-c"],
    ["post-api-v1-groups_delete", "delete-p"],
    ["post-api-v1-channels_kick", "remove-user"],
    ["post-api-v1-channels_setReadOnly", "set-readonly"],
    ["post-api-v1-channels_rename", "edit-room"],
    ["post-api-v1-chat_delete", "delete-message"],
    ["post-api-v1-chat_update", "edit-message"],
    ["post-api-v1-rooms_muteUser", "mute-user"],
  ];

  for (const [operationId, right] of cases) {
    it(`${operationId} -> ${right}`, () => {
      assert.ok(
        permissionsFor(operationId).includes(right),
        `${operationId} must request "${right}"`,
      );
    });
  }

  it("archive does not match unarchive, and vice versa", () => {
    assert.ok(
      !permissionsFor("post-api-v1-channels_archive").includes(
        "unarchive-room",
      ),
    );
    assert.ok(
      !permissionsFor("post-api-v1-channels_unarchive").includes(
        "archive-room",
      ),
    );
  });

  it("adding a member does not also request the right to remove one", () => {
    const granted = permissionsFor("post-api-v1-channels_invite");
    assert.ok(granted.includes("add-user-to-joined-room"));
    assert.ok(
      !granted.includes("remove-user"),
      "invite and kick are separate authorities",
    );
  });
});

describe("history wipe is reachable through every family that offers it", () => {
  /** `rooms.cleanHistory` is the cross-type route the category-wide map never covered. */
  for (const operationId of [
    "post-api-v1-rooms_cleanHistory",
    "post-api-v1-channels_cleanHistory",
    "post-api-v1-groups_cleanHistory",
  ]) {
    it(operationId, () => {
      assert.ok(
        permissionsFor(operationId).includes("clean-channel-history"),
        `${operationId} must request "clean-channel-history"`,
      );
    });
  }
});

describe("message operations", () => {
  it("posting requests the rights it actually uses", () => {
    const granted = permissionsFor("post-api-v1-chat_postMessage");
    // postMessage resolves `@user` into a DM and expands @here/@all.
    assert.ok(granted.includes("create-d"));
    assert.ok(granted.includes("mention-all"));
  });

  it("starring a message requests no privileged right", () => {
    const granted = permissionsFor("post-api-v1-chat_starMessage");
    assert.ok(
      !granted.includes("pin-message"),
      "starring is per-user and needs no permission; it must not borrow pin-message",
    );
  });

  it("pinning and unpinning both request pin-message", () => {
    assert.ok(
      permissionsFor("post-api-v1-chat_pinMessage").includes("pin-message"),
    );
    assert.ok(
      permissionsFor("post-api-v1-chat_unPinMessage").includes("pin-message"),
    );
  });
});

describe("the result is a de-duplicated set", () => {
  it("does not repeat a right shared by two operations", () => {
    const granted = permissionsFor(
      "get-api-v1-channels_info",
      "get-api-v1-channels_list",
    );
    assert.equal(new Set(granted).size, granted.length);
  });
});
