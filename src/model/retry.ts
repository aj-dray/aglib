/**
 * Waiting out a provider that said "not yet".
 *
 * A request can fail before the provider has begun to answer it, and some of
 * those failures are the provider asking for a moment rather than refusing the
 * request: a rate limit, an overloaded upstream, a connection that never
 * opened, a router whose credit is spoken for by our own other requests until
 * they finish. Nothing about the request was wrong, so the right response is to
 * wait and send it again. The loop continues past a retryable failure only when
 * it already has new input to send, so without this a wait that would have
 * cleared in seconds ends the activation instead.
 *
 * This sits at the `fetch` seam rather than around the generation because that
 * is where "before the first delta" is exact: a status has been read and no
 * body has. Once a body is open, partial output has already reached the
 * caller, and whether to ask again is the loop's decision rather than the
 * wire's. The bounds are stated in `INTERFACE.md`; this is where they are.
 */

/** How many times one request is sent again after a wait. */
export const retries = 4;
/** The ceiling of the first backoff; each retry's ceiling doubles the last, up to the cap. */
const backoffBaseMs = 1_000;
const backoffCapMs = 30_000;
/** The longest `Retry-After` honoured; a provider asking for more is waited for this long. */
const retryAfterCapMs = 120_000;
/** The most time one request spends waiting altogether; a wait that would pass it is not taken. */
const totalWaitCapMs = 180_000;

/** What an adapter calls: `fetch`'s signature without the runtime extras Bun hangs on the global. */
export type Call = (...args: Parameters<typeof fetch>) => Promise<Response>;

export interface RetryOptions {
  /**
   * Whether a refused response is this endpoint's way of asking for a wait,
   * beyond the statuses every HTTP wire means so. Asked only for a response
   * `isWaitStatus` did not already decide; it may read a clone of the body.
   */
  isWait?: (response: Response) => Promise<boolean> | boolean;
  /** Injectable for tests, which cannot wait out a backoff schedule for real. */
  sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  random?: () => number;
}

/**
 * The statuses that mean "not yet" on any HTTP wire.
 *
 * 408 and 425 are the request arriving at the wrong moment, 409 is a lock the
 * provider will release, 429 is a rate limit and 5xx is the provider's own
 * trouble. Everything else is a statement about the request, and sending it
 * again unchanged asks for the same answer.
 */
export function isWaitStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

/**
 * A `fetch` that waits and asks again when the answer is a wait.
 *
 * Returned to the adapter as the last response or the last transport error, so
 * an exhausted retry is reported exactly as a single failure would have been —
 * with a retryable code, because the provider never said the request was
 * wrong. An abort of the request's signal ends a wait at once and is thrown as
 * the abort it is.
 */
export function retrying(call: Call, options: RetryOptions = {}): Call {
  const { isWait, sleep = pause, random = Math.random } = options;
  return async (input, init) => {
    const signal = init?.signal ?? undefined;
    let waited = 0;
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      let delay: number;
      try {
        response = await call(input, init);
      } catch (error) {
        if (signal?.aborted || attempt >= retries) throw error;
        delay = backoff(attempt, random);
        if (waited + delay > totalWaitCapMs) throw error;
        waited += delay;
        await sleep(delay, signal);
        continue;
      }
      if (response.ok || attempt >= retries) return response;
      if (!isWaitStatus(response.status) && !(await isWait?.(response))) return response;
      delay = retryAfter(response.headers.get("retry-after")) ?? backoff(attempt, random);
      if (waited + delay > totalWaitCapMs) return response;
      // The connection is not needed again, and holding a body nobody reads
      // keeps it open for the whole wait.
      await response.body?.cancel().catch(() => undefined);
      waited += delay;
      await sleep(delay, signal);
    }
  };
}

/** Full jitter over a doubling ceiling: the standard cure for retries that arrive together. */
const backoff = (attempt: number, random: () => number): number =>
  Math.round(random() * Math.min(backoffBaseMs * 2 ** attempt, backoffCapMs));

/** `Retry-After` as seconds or an HTTP date, clamped to what will be waited; absent when unparseable. */
function retryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(header) - Date.now();
  if (!Number.isFinite(ms)) return undefined;
  return Math.min(Math.max(ms, 0), retryAfterCapMs);
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(aborted(signal)); return; }
    const onAbort = () => { clearTimeout(timer); reject(aborted(signal!)); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const aborted = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("This operation was aborted", "AbortError");
