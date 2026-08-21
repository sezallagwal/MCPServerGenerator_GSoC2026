/** Single source of truth for JSON-mode detection, shared by the composer and the executor. */

export interface JsonIntentInput {
  prompt?: string;
  systemPrompt?: string;
}

export function detectJsonIntent(step: JsonIntentInput): boolean {
  const haystack =
    `${step.systemPrompt || ""} ${step.prompt || ""}`.toLowerCase();
  return (
    haystack.includes("json") ||
    haystack.includes("respond with a json") ||
    haystack.includes("respond only with") ||
    haystack.includes("return a json") ||
    haystack.includes("output format:")
  );
}
