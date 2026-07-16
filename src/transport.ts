/**
 * Zero-dependency HTTP transport built on the global `fetch` (Node >= 18).
 *
 * Handles JSON request/response framing, authentication, retries with
 * exponential backoff (honouring `Retry-After`), and mapping non-2xx
 * responses onto the typed error hierarchy in `errors.ts`.
 */

import {
  APIConnectionError,
  APIError,
  ERROR_CODE_TO_CLASS,
  HiAPIError,
  STATUS_TO_CLASS,
} from "./errors.js";
import type { JSONObject } from "./models.js";
import { VERSION } from "./version.js";

// Statuses worth retrying: rate limiting and transient platform unavailability.
// These mean the server rejected the request *before* processing, so retrying
// is safe even for a non-idempotent POST (no duplicate task is created).
export const RETRY_STATUSES: ReadonlySet<number> = new Set([429, 503]);
// Methods safe to retry after a network error, where the outcome is unknown.
// A POST /tasks must NOT be retried on a network error — it might have created
// a task the SDK never saw the response for, double-charging the account. The
// exception: a request carrying an Idempotency-Key header IS safe to retry
// (the server collapses duplicates into the first task).
export const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "PUT", "DELETE"]);
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
// error_code of the retryable 409 the server returns while the first request
// with the same Idempotency-Key is still in flight (honours Retry-After).
export const IDEMPOTENCY_PROCESSING_CODE = "IDEMPOTENCY_KEY_PROCESSING";

const MAX_BACKOFF_MS = 8_000;
const MAX_RETRY_AFTER_MS = 60_000;
// A merely-finite maxRetries (e.g. 1e9 or Number.MAX_VALUE — both pass
// `Number.isFinite`) still lets a persistent 429/503/network failure retry
// for an absurd, effectively-unbounded duration at the ~8s backoff cap
// (confirmed: 1e9 retries is on the order of centuries). Neither the sibling
// SDKs nor the wire protocol depend on this value — it's a purely local,
// client-side retry-loop knob — so capping it here doesn't affect
// cross-language contract parity, only how long a misconfigured client can
// spin.
const MAX_RETRIES_CAP = 1_000;
// The largest delay Node's timers actually honour without clamping. NOT the
// 4294967295 (2^32-1, unsigned 32-bit max) that AbortSignal.timeout()'s own
// input validation allows through — that's a red herring: Node's underlying
// timer implementation uses a SIGNED 32-bit int, so a delay between
// 2147483648 and 4294967295 passes validation but still gets silently
// clamped to ~1ms (verified via `node -e`: AbortSignal.timeout(3_000_000_000)
// fires within 50ms instead of ~34.7 days later — 3e9ms ≈ 34.7 days, not the
// ~50 minutes an earlier revision of this comment mistakenly claimed).
// 2147483647 (2^31-1) is the real, safe boundary.
// Exported so tasks.ts's pollIntervalMs validation (same underlying risk,
// via plain setTimeout in sleep()) uses the identical, single-sourced value.
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type FetchLike = typeof fetch;

export interface RequestOptions {
  body?: JSONObject;
  params?: Record<string, string | number | boolean | undefined>;
  extraHeaders?: Record<string, string>;
}

export class Transport {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  private readonly fetchImpl: FetchLike;

  constructor(
    apiKey: string,
    baseUrl: string,
    timeoutMs: number,
    maxRetries: number,
    fetchImpl?: FetchLike,
  ) {
    // Fail fast and clearly at construction time. Left unvalidated, a bad
    // timeoutMs (NaN, non-integer, or out of Node's timer range) throws deep
    // inside AbortSignal.timeout() on every attempt (surfacing as a
    // misleading APIConnectionError after wasted retries), and an Infinity
    // maxRetries turns a persistent 429/503/network failure into an infinite
    // retry loop.
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > MAX_TIMER_DELAY_MS
    ) {
      throw new RangeError(
        `timeoutMs must be an integer in (0, ${MAX_TIMER_DELAY_MS}], got ${timeoutMs}`,
      );
    }
    if (!Number.isFinite(maxRetries) || maxRetries > MAX_RETRIES_CAP) {
      throw new RangeError(
        `maxRetries must be a finite number <= ${MAX_RETRIES_CAP}, got ${maxRetries}`,
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.timeoutMs = timeoutMs;
    this.maxRetries = Math.max(0, Math.trunc(maxRetries));
    // A dedicated reference avoids depending on ambient global state and lets
    // tests (or frameworks) inject their own fetch.
    this.fetchImpl = fetchImpl ?? fetch;
  }

  /**
   * Perform a request and return the parsed JSON envelope (an object).
   *
   * Throws an {@link APIError} subclass on non-2xx responses and
   * {@link APIConnectionError} on network failure or client-side timeout.
   */
  async request(method: string, path: string, opts: RequestOptions = {}): Promise<JSONObject> {
    const [env] = await this.requestWithHeaders(method, path, opts);
    return env;
  }

  /** Like {@link request}, but also returns the response headers. */
  async requestWithHeaders(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<[JSONObject, Headers]> {
    const url = this.buildUrl(path, opts.params);
    const bodyText = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      "User-Agent": `hiapi-node/${VERSION}`,
    };
    if (bodyText !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    Object.assign(headers, opts.extraHeaders);
    // A whitespace-only key (e.g. " ") is truthy as a plain string, but HTTP
    // strips leading/trailing whitespace from header values on the wire, so
    // the server would see an empty value and treat it as "no key" — trimmed
    // here, at the single point every caller's request funnels through, so a
    // future resource can't reintroduce the "retries a non-idempotent POST"
    // risk by skipping this check the way a per-caller trim would allow.
    //
    // Only ASCII space/tab are trimmed here — NOT `String.prototype.trim()`,
    // which strips a much wider Unicode whitespace set (including NBSP,
    // U+00A0) than HTTP's own OWS (RFC 7230: SP/HTAB only). Trimming with the
    // former let a non-ASCII character sneak past the ASCII-range check
    // below entirely: confirmed via `node -e` that `" ".trim()` (an NBSP-only key)
    // is `""` — silently treated as "no key" — and that
    // `" abc ".trim()` is `"abc"`, rewriting a caller's actual key
    // to a different, shorter one before validation ever saw the NBSP.
    const rawIdempotencyKey = opts.extraHeaders?.[IDEMPOTENCY_KEY_HEADER];
    const idempotencyKey = rawIdempotencyKey?.replace(/^[ \t]+|[ \t]+$/g, "");
    // An explicitly-empty string ("", exactly as authored) means "no key",
    // matching this SDK's established "'' ≡ absent" convention elsewhere
    // (e.g. route) — callers already treat it the same as "not set" before
    // it ever reaches here (see tasks.ts). A NON-empty value that trims down
    // to nothing is different: it's not a deliberate "no key" signal, it's
    // most likely a bug in dynamically-derived key-generation logic that
    // LOOKS like it should enable idempotency protection but silently
    // doesn't. Without this check, that config mistake sent the request
    // anyway with no key at all: the caller would believe protection was
    // active, and a retry after an ambiguous outcome (e.g. a client-side
    // timeout) could double-bill with no warning.
    if (rawIdempotencyKey !== undefined && rawIdempotencyKey !== "" && !idempotencyKey) {
      throw new RangeError(
        `idempotencyKey must not be entirely whitespace, got ${JSON.stringify(rawIdempotencyKey)}`,
      );
    }
    const hasIdempotencyKey = Boolean(idempotencyKey);
    if (idempotencyKey) {
      // Fetch header values are ByteString (Latin-1 only): a character
      // above U+00FF makes the underlying `fetch` call throw a raw
      // TypeError — confirmed via `node -e` — which is indistinguishable
      // from a real network failure to the catch block below, so it gets
      // misreported as APIConnectionError and, worse, retried pointlessly
      // (the same non-ASCII key fails identically every attempt). Rejected
      // with a clear, immediate, non-retryable error instead. Restricted to
      // printable ASCII (not the full Latin-1 range fetch would accept) to
      // sidestep runtime-specific header-validation differences entirely —
      // an opaque idempotency token has no reason to need anything wider.
      if (idempotencyKey.length > 255 || !/^[\x20-\x7E]+$/.test(idempotencyKey)) {
        throw new RangeError(
          `idempotencyKey must be a printable ASCII string of at most 255 characters, got ${JSON.stringify(idempotencyKey)}`,
        );
      }
      headers[IDEMPOTENCY_KEY_HEADER] = idempotencyKey;
    } else {
      delete headers[IDEMPOTENCY_KEY_HEADER];
    }
    const retryOnNetworkError =
      IDEMPOTENT_METHODS.has(method.toUpperCase()) || hasIdempotencyKey;

    let attempt = 0;
    for (;;) {
      let status: number;
      let respHeaders: Headers;
      let rawText: string;
      try {
        const resp = await this.fetchImpl(url, {
          method,
          headers,
          body: bodyText,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (resp.ok) {
          const text = await resp.text();
          return [decodeJson(text, resp.status), resp.headers];
        }
        status = resp.status;
        respHeaders = resp.headers;
        rawText = await safeText(resp);
      } catch (err) {
        // decodeJson signals malformed 2xx bodies with an APIError — that is a
        // final answer from the server, not a network failure; never retry it.
        if (err instanceof HiAPIError) {
          throw err;
        }
        // Anything else fetch throws is network-level: DNS, refused/reset
        // connections, TLS failures, or the AbortSignal.timeout firing. Only
        // retry when the request is safe to repeat (see gate above).
        if (retryOnNetworkError && attempt < this.maxRetries) {
          await sleep(retryDelayMs(attempt, null));
          attempt += 1;
          continue;
        }
        throw new APIConnectionError(`request to ${url} failed: ${describeError(err)}`, {
          cause: err,
        });
      }

      if (RETRY_STATUSES.has(status) && attempt < this.maxRetries) {
        await sleep(retryDelayMs(attempt, respHeaders));
        attempt += 1;
        continue;
      }
      const err = errorFromResponse(status, rawText);
      // A 409 IDEMPOTENCY_KEY_PROCESSING means the first request with this
      // key is still in flight; honour Retry-After and retry — the next
      // attempt hits the replay path and returns the task.
      if (
        hasIdempotencyKey &&
        status === 409 &&
        err.errorCode === IDEMPOTENCY_PROCESSING_CODE &&
        attempt < this.maxRetries
      ) {
        await sleep(retryDelayMs(attempt, respHeaders));
        attempt += 1;
        continue;
      }
      throw err;
    }
  }

  private buildUrl(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
  ): string {
    if (!path.startsWith("/")) {
      path = "/" + path;
    }
    let url = this.baseUrl + path;
    if (params) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          query.set(key, String(value));
        }
      }
      const encoded = query.toString();
      if (encoded) {
        url += "?" + encoded;
      }
    }
    return url;
  }
}

/**
 * Delay before the next retry, in milliseconds.
 *
 * `Retry-After` may be numeric seconds or an HTTP-date (RFC 7231), e.g.
 * `"Wed, 21 Oct 2026 07:28:00 GMT"`; both are honoured and clamped to
 * [0, 60s]. Without the header: exponential backoff capped at 8s.
 */
export function retryDelayMs(attempt: number, headers: Headers | null): number {
  const retryAfter = headers?.get("retry-after");
  if (retryAfter && retryAfter.trim() !== "") {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) {
      return Math.max(0, Math.min(secs * 1000, MAX_RETRY_AFTER_MS));
    }
    const when = Date.parse(retryAfter);
    if (!Number.isNaN(when)) {
      return Math.max(0, Math.min(when - Date.now(), MAX_RETRY_AFTER_MS));
    }
  }
  return Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS);
}

export function normalizeBaseUrl(baseUrl: string): string {
  // Strip trailing slashes and ensure the `/v1` version prefix is present, so
  // both `https://api.hiapi.ai` and `https://api.hiapi.ai/v1` work rather than
  // a missing `/v1` silently sending requests to the wrong path.
  let base = baseUrl.replace(/\/+$/, "");
  if (!base.endsWith("/v1")) {
    base += "/v1";
  }
  return base;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

/**
 * Describes an arbitrary thrown/rejected value for an error message,
 * without ever throwing itself. `fetch` is a documented, user-replaceable
 * option (see `HiAPIOptions.fetch`); a custom implementation can reject with
 * anything, including a non-Error object with a throwing `toString()`, or —
 * subtler — an `Error` whose own `message` is a throwing getter. Either one
 * used to make THIS function throw a completely different, secondary error
 * instead of the intended `APIConnectionError`, discarding `cause` — the
 * same class of bug `errors.ts`'s `describeCause` guards against for
 * `RunFailedError`, confirmed here via the same kind of reproduction.
 */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) {
      // Node's fetch wraps the interesting failure (ECONNREFUSED, DNS, ...) in
      // `cause`; surface it alongside the generic "fetch failed" message.
      const cause = (err as { cause?: unknown }).cause;
      if (cause instanceof Error && cause.message) {
        return `${err.message} (${cause.message})`;
      }
      return err.message || err.name;
    }
    return String(err);
  } catch {
    return `<un-stringifiable ${typeof err}>`;
  }
}

async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}

function decodeJson(text: string, status: number): JSONObject {
  if (text === "") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new APIError(`could not decode response body as JSON: ${describeError(err)}`, {
      status,
      body: text,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new APIError("expected a JSON object response", { status, body: text });
  }
  return parsed as JSONObject;
}

function errorFromResponse(status: number, rawText: string): APIError {
  let errorCode: string | undefined;
  let message: string | undefined;
  try {
    const parsed: unknown = JSON.parse(rawText);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const obj = parsed as JSONObject;
      if (typeof obj.error_code === "string") {
        errorCode = obj.error_code;
      }
      if (typeof obj.message === "string") {
        message = obj.message;
      }
    }
  } catch {
    // Non-JSON error body: fall through to the status-based message.
  }

  const cls = (errorCode && ERROR_CODE_TO_CLASS[errorCode]) || STATUS_TO_CLASS[status] || APIError;
  return new cls(message || `HTTP ${status}`, {
    status,
    errorCode,
    body: rawText || undefined,
  });
}
