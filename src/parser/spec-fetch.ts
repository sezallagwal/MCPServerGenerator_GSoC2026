import SwaggerParser from "@apidevtools/swagger-parser";
import { withRetry } from "../utils/retry.js";

/** Shared spec network layer, so the Rocket.Chat source and the generic adapter cannot drift. */

export const FETCH_TIMEOUT_MS = 30_000;
export const MAX_FETCH_RETRIES = 3;
const RETRY_BASE_MS = 300;

/** Matches the cap the generated client applies to API responses. */
export const MAX_SPEC_BYTES = 25 * 1024 * 1024;

const ALLOWED_SPEC_SCHEMES = new Set(["http:", "https:"]);

/** Cloud metadata: no spec lives here, and reaching one typically yields IAM credentials. */
const BLOCKED_HOSTS = new Set([
  "169.254.169.254",
  "[fd00:ec2::254]",
  "fd00:ec2::254",
  "metadata.google.internal",
  "metadata.goog",
]);

function isBlockedHost(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) return true;
  return /^169\.254\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Carries the HTTP status so the retry policy can branch on it. */
export class SpecFetchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SpecFetchError";
  }
}

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Matched on the message; no status digits, which also matched the URL the message embeds. */
const RETRYABLE_TRANSPORT_RE =
  /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network|aborted|timed out|rate.?limit/i;

function isRetryableFetchError(err: unknown): boolean {
  if (err instanceof SpecFetchError && err.status !== undefined) {
    return RETRYABLE_STATUSES.has(err.status);
  }
  // An oversized body will be oversized again.
  if (err instanceof SpecFetchError) return false;
  return RETRYABLE_TRANSPORT_RE.test(
    err instanceof Error ? err.message : String(err),
  );
}

/** Only the caller's URL. Private IPs stay allowed: blocking them belongs to a hosted deploy. */
export function assertSafeSpecUrl(specUrl: string): URL {
  let url: URL;
  try {
    url = new URL(specUrl);
  } catch {
    throw new Error(
      `Invalid spec URL: "${specUrl}". Provide an absolute http(s) URL.`,
    );
  }
  if (!ALLOWED_SPEC_SCHEMES.has(url.protocol)) {
    throw new Error(
      `Unsupported spec URL scheme "${url.protocol}" in "${specUrl}". ` +
        `Only http and https are allowed.`,
    );
  }
  if (isBlockedHost(url)) {
    throw new Error(
      `Refusing to fetch a spec from link-local host "${url.hostname}". ` +
        `That address range serves cloud instance metadata, not API specifications.`,
    );
  }
  return url;
}

/**
 * `safeUrlResolver: false` lets an operator target an internal API they typed; the `$ref`s
 * they never see are policed here. `canRead` is explicit because the built-in gates on it.
 */
export function dereferenceOptionsFor(
  entryUrl: string,
  options: { allowCrossOriginRefs?: boolean } = {},
): {
  options: SwaggerParser.Options;
  /** SwaggerParser discards resolver errors, so a security refusal would look like a fetch fault. */
  refusal: () => Error | null;
} {
  const entryOrigin = (() => {
    try {
      return new URL(entryUrl).origin;
    } catch {
      return null;
    }
  })();

  let refused: Error | null = null;

  const assertRefAllowed = (rawUrl: string): void => {
    let url: URL;
    try {
      url = assertSafeSpecUrl(rawUrl);
    } catch (err) {
      refused = err instanceof Error ? err : new Error(String(err));
      throw refused;
    }
    if (options.allowCrossOriginRefs) return;
    if (entryOrigin && url.origin !== entryOrigin) {
      refused = new SpecFetchError(
        `Refusing to resolve a $ref pointing at a different origin: ` +
          `"${url.origin}" (the spec itself was loaded from "${entryOrigin}"). ` +
          `A spec that pulls schemas from another host can be used to make this ` +
          `process fetch arbitrary internal URLs and inline the responses into ` +
          `the generated project. If this spec is trusted and genuinely split ` +
          `across origins, set allowCrossOriginRefs.`,
      );
      throw refused;
    }
  };

  return {
    refusal: () => refused,
    options: {
      resolve: {
        file: false,
        http: {
          order: 100,
          safeUrlResolver: false,
          canRead: (file: SwaggerParser.FileInfo) => /^https?:/i.test(file.url),
          read: (file: SwaggerParser.FileInfo) => {
            assertRefAllowed(file.url);
            return fetchSpecContent(file.url);
          },
        },
      },
    },
  };
}

/** Dereference under this project's resolver policy, surfacing a `$ref` refusal. */
export async function dereferenceSpec(
  specUrl: string,
  options: { allowCrossOriginRefs?: boolean } = {},
): Promise<unknown> {
  const { options: parserOptions, refusal } = dereferenceOptionsFor(
    specUrl,
    options,
  );
  try {
    return await SwaggerParser.dereference(specUrl, parserOptions);
  } catch (err) {
    throw refusal() ?? err;
  }
}

/** Streamed, because `res.text()` buffers everything before a size check can run. */
async function readCappedText(res: Response, url: string): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_SPEC_BYTES) {
    await res.body?.cancel();
    throw new SpecFetchError(
      `Spec at ${url} declares ${declared} bytes, over the ${MAX_SPEC_BYTES}-byte limit.`,
    );
  }

  if (!res.body) return "";

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_SPEC_BYTES) {
      await reader.cancel();
      throw new SpecFetchError(
        `Spec at ${url} exceeds the ${MAX_SPEC_BYTES}-byte limit.`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** One {@link AbortController} per attempt, so a timeout tears the socket down. */
export async function fetchSpecContent(url: string): Promise<string> {
  return withRetry(
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      timer.unref();
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          redirect: "follow",
          headers: {
            Accept:
              "application/json, application/yaml, text/yaml, text/plain, */*",
          },
        });
        if (!res.ok) {
          await res.body?.cancel();
          throw new SpecFetchError(
            `HTTP ${res.status} ${res.statusText} while fetching ${url}`,
            res.status,
          );
        }
        return await readCappedText(res, url);
      } finally {
        clearTimeout(timer);
      }
    },
    {
      maxRetries: MAX_FETCH_RETRIES,
      baseDelayMs: RETRY_BASE_MS,
      isRetryable: isRetryableFetchError,
    },
  );
}
