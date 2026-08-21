export const VALID_STEP_TYPES = [
  "api_call",
  "sampling",
  "elicitation",
  "transform",
  "conditional",
] as const;

export const VALID_PARAM_TYPES = [
  "string",
  "number",
  "boolean",
  "object",
  "array",
] as const;

export const VALID_WEBHOOK_METHODS = ["get", "post"] as const;

export const VALID_RESPONSE_FORMATS = ["text", "json"] as const;

/** Workflow names become file paths and identifiers, so this blocks traversal and clobbering. */
export const WORKFLOW_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export const MAX_SCHEMA_SIZE = 100 * 1024;

/** Guards against a typo requesting an unreasonable or provider-rejected budget. */
export const MAX_TOKENS_LIMIT = 1_000_000;

/** Step-specific keywords; unlisted ones are generic. Wrong use fails at parse, not silently. */
export const STEP_KEYWORD_TYPES: Record<string, readonly string[]> = {
  OPERATION: ["api_call"],
  MAP: ["api_call"],
  PROMPT: ["sampling"],
  SYSTEM_PROMPT: ["sampling"],
  MAX_TOKENS: ["sampling"],
  RESPONSE_FORMAT: ["sampling"],
  CONTENT_TEXT: ["sampling"],
  CONTENT_IMAGE: ["sampling"],
  SCHEMA: ["sampling", "elicitation"],
  EXPRESSION: ["transform"],
  CONDITION: ["conditional"],
  THEN: ["conditional"],
  ELSE: ["conditional"],
  MESSAGE: ["elicitation"],
  ON_DECLINE: ["elicitation"],
};
