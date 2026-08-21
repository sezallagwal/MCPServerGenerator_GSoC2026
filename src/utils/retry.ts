/** Kept out of `src/workflow/`, which is vendored verbatim into generated projects. */

export interface RetryOptions {
  /** Retries *after* the initial attempt. Default 3. */
  maxRetries?: number;
  /** Attempt N's uncapped backoff is `base * 2**N`. Default 200. */
  baseDelayMs?: number;
  /** Caps the backoff before jitter. Default 30_000. */
  maxDelayMs?: number;
  /** Equal jitter, so concurrent callers do not re-collide in lockstep. False for tests. */
  jitter?: boolean;
  /** RNG in [0, 1), injectable for deterministic tests. */
  random?: () => number;
  isRetryable: (err: unknown) => boolean;
  /** Called before each sleep, with the post-jitter duration. */
  onRetry?: (info: {
    attempt: number;
    delayMs: number;
    error: unknown;
  }) => void;
}

/** Exponential growth capped at `maxDelayMs`, then equal jitter into `[d/2, d]`. */
export function computeBackoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitter: boolean,
  random: () => number,
): number {
  const capped = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
  if (!jitter) return capped;
  const half = capped / 2;
  return Math.round(half + random() * half);
}

// Not unref'd: a pending sleep is the operation in progress and must keep the loop alive.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Non-retryable errors and the final attempt's error propagate unchanged. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  // Clamped so `fn` always runs once; a negative value threw `undefined` downstream.
  const maxRetries = Math.max(0, Math.trunc(options.maxRetries ?? 3));
  const baseDelayMs = options.baseDelayMs ?? 200;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const jitter = options.jitter ?? true;
  const random = options.random ?? Math.random;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries || !options.isRetryable(err)) throw err;
      const delayMs = computeBackoffDelay(
        attempt,
        baseDelayMs,
        maxDelayMs,
        jitter,
        random,
      );
      options.onRetry?.({ attempt, delayMs, error: err });
      await sleep(delayMs);
    }
  }
}
