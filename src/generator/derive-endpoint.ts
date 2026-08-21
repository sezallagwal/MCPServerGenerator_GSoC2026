const KNOWN_METHODS = new Set([
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "head",
  "options",
]);

/**
 * `post-api-v1-channels_create` -> `POST /api/v1/channels.create`. Returns `null` rather
 * than guess, so the caller refuses to generate instead of emitting a failing route.
 */
export function deriveEndpointFromOperationId(
  operationId: string,
): { method: string; path: string } | null {
  const match = /^([a-z]+)-api-v1-(.+)$/.exec(operationId);
  if (!match) return null;

  const [, method, pathSegment] = match;
  if (!KNOWN_METHODS.has(method)) return null;

  return {
    method: method.toUpperCase(),
    path: `/api/v1/${pathSegment.replace(/_/g, ".")}`,
  };
}
