import type { WorkflowDefinition } from "../workflow/types.js";

/**
 * Read rules are category-wide, privileged rules per-operation, and every match unions in.
 * `[._-]` matches both `channels.create` and `post-api-v1-channels_create`.
 */
const OPERATION_PERMISSION_MAP: Array<{
  pattern: RegExp;
  permissions: string[];
}> = [
  // Read tier — matched by any operation in the family.
  {
    pattern: /channels[._-]/,
    permissions: ["view-c-room", "view-joined-room"],
  },
  { pattern: /groups[._-]/, permissions: ["view-p-room", "view-joined-room"] },
  {
    pattern: /im[._-]|dm[._-]/,
    permissions: ["view-d-room", "view-joined-room"],
  },
  {
    pattern: /rooms[._-]/,
    permissions: ["view-c-room", "view-p-room", "view-joined-room"],
  },
  { pattern: /users[._-]/, permissions: ["view-full-other-user-info"] },

  // Privileged tier — matched only by the specific operation.
  { pattern: /channels[._-]create/, permissions: ["create-c"] },
  { pattern: /groups[._-]create/, permissions: ["create-p"] },
  { pattern: /(im|dm)[._-](create|open)/, permissions: ["create-d"] },
  {
    pattern:
      /(channels|groups)[._-](rename|setTopic|setAnnouncement|setDescription|setPurpose|setCustomFields|setDefault|setType|setJoinCode)/,
    permissions: ["edit-room"],
  },
  {
    pattern: /(channels|groups)[._-]setReadOnly/,
    permissions: ["set-readonly", "post-readonly"],
  },
  // The separator class before the verb keeps `archive` off `unarchive`.
  { pattern: /(channels|groups)[._-]archive/, permissions: ["archive-room"] },
  {
    pattern: /(channels|groups)[._-]unarchive/,
    permissions: ["unarchive-room"],
  },
  {
    pattern: /(channels|groups|rooms)[._-]cleanHistory/,
    permissions: ["clean-channel-history"],
  },
  { pattern: /channels[._-]delete/, permissions: ["delete-c"] },
  { pattern: /groups[._-]delete/, permissions: ["delete-p"] },
  {
    pattern: /(channels|groups)[._-](invite|addAll|addOwner|addModerator)/,
    permissions: [
      "add-user-to-joined-room",
      "add-user-to-any-c-room",
      "add-user-to-any-p-room",
    ],
  },
  {
    pattern: /(channels|groups)[._-]kick/,
    permissions: ["remove-user"],
  },
  { pattern: /rooms[._-](muteUser|unmuteUser)/, permissions: ["mute-user"] },
  // `postMessage` resolves `@user` into a DM, hence `create-d`; mentions cover @here/@all.
  {
    pattern: /chat[._-](postMessage|sendMessage)/,
    permissions: ["create-d", "post-readonly", "mention-here", "mention-all"],
  },
  { pattern: /chat[._-]update/, permissions: ["edit-message"] },
  { pattern: /chat[._-]delete/, permissions: ["delete-message"] },
  // Starring is per-user, so it needs no permission of its own.
  { pattern: /chat[._-](un)?[Pp]in/, permissions: ["pin-message"] },
  {
    pattern: /users[._-](create|update|delete|setActiveStatus)/,
    permissions: [
      "create-user",
      "edit-other-user-info",
      "edit-other-user-active-status",
    ],
  },
  { pattern: /[Dd]iscussions[._-]create/, permissions: ["start-discussion"] },
  {
    pattern: /roles[._-]|permissions[._-]/,
    permissions: ["access-permissions"],
  },
  { pattern: /emoji[._-]custom/, permissions: ["manage-emoji"] },
];

/** Permissions every generated Rocket.Chat server needs, regardless of workflow. */
const BASE_BOT_PERMISSIONS = [
  "create-personal-access-tokens",
  "view-outside-room",
];

/** Permissions the server's Rocket.Chat account needs for the endpoints it calls. */
export function deriveRequiredPermissions(
  workflows: WorkflowDefinition[],
): string[] {
  const perms = new Set<string>(BASE_BOT_PERMISSIONS);

  const allOps = new Set<string>();
  for (const wf of workflows) {
    for (const operationId of wf.requiredEndpoints) allOps.add(operationId);
  }

  for (const operationId of allOps) {
    for (const rule of OPERATION_PERMISSION_MAP) {
      if (rule.pattern.test(operationId)) {
        for (const permission of rule.permissions) perms.add(permission);
      }
    }
  }

  return [...perms];
}
