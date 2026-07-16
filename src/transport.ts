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
  IdempotencyKeyMismatchError,
  IdempotencyKeyProcessingError,
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
  /**
   * Aborts the CURRENT attempt's in-flight request and any pending
   * retry-backoff sleep — but never a request already known to have
   * completed successfully (2xx is always returned, never discarded).
   * Without this, `tasks.wait()`'s `signal` had no way to reach the
   * transport at all: an abort during a retry-after sleep, or while a
   * subsequent retry attempt's request was in flight, was silently ignored
   * — the poll loop's own `throwIfAborted()` checks only run BETWEEN
   * `retrieve()` calls, so the caller's abort could sit unhonoured for the
   * full remaining retry budget (confirmed by reproducing an abort landing
   * during a 429's `Retry-After` sleep: two more HTTP attempts happened
   * before the abort was ever observed).
   */
  signal?: AbortSignal;
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
      // A per-attempt, explicitly disposed signal — NOT AbortSignal.any(),
      // which an earlier revision recreated on every attempt against the
      // SAME long-lived caller `signal`. Each composed signal registers a
      // real "abort" listener on every one of its sources for as long as
      // neither side is aborted or garbage-collected — repeatedly composing
      // against one long-lived `signal` (exactly what a long `wait()` poll
      // loop, `signal`'s primary real-world use, does on every retry
      // attempt) accumulates one live listener/composite-signal object per
      // attempt: confirmed via a targeted micro-benchmark that 100k such
      // compositions against one shared caller signal retained ~213MB after
      // a forced GC, vs. ~80MB for `AbortSignal.timeout()` alone.
      // `createAttemptSignal`'s `dispose()` (called in the `finally` below,
      // every iteration) detaches both listeners and clears the timer
      // immediately once this attempt is done, so nothing accumulates no
      // matter how many attempts a call ends up making.
      const { signal: attemptSignal, causedByCaller, dispose } = createAttemptSignal(
        opts.signal,
        this.timeoutMs,
      );
      try {
        // Set as soon as headers arrive (before the body is even read), NOT
        // typed as definitely-assigned `let status: number` the way an
        // earlier revision had it — that version couldn't reference `status`
        // from inside the catch below without a "used before assigned"
        // compile error, which is exactly why the fix below didn't exist
        // yet: there was no type-safe way to recover the ALREADY-KNOWN
        // status once the body read itself was what failed.
        let knownStatus: number | undefined;
        let knownHeaders: Headers | undefined;
        let rawText: string;
        try {
          const resp = await this.fetchImpl(url, {
            method,
            headers,
            body: bodyText,
            signal: attemptSignal,
          });
          if (resp.ok) {
            const text = await resp.text();
            return [decodeJson(text, resp.status), resp.headers];
          }
          knownStatus = resp.status;
          knownHeaders = resp.headers;
          rawText = await resp.text();
        } catch (err) {
          // decodeJson signals malformed 2xx bodies with an APIError — that is a
          // final answer from the server, not a network failure; never retry it.
          if (err instanceof HiAPIError) {
            throw err;
          }
          // The CALLER's abort (not the per-attempt timeout, which produces
          // the identical DOMException shape) must surface as a plain
          // abort, not get wrapped in APIConnectionError or retried — the
          // caller asked to stop, not "the network failed, try again".
          // `causedByCaller()` — not a fresh `opts.signal?.aborted` check —
          // because the caller's signal can become aborted AFTER the
          // timeout already fired and legitimately caused this exact
          // failure (a slow-to-reject fetch can leave both true by the time
          // this runs); only the attempt signal's own recorded FIRST cause
          // reflects which one actually did.
          if (causedByCaller()) {
            throw opts.signal!.reason ?? new DOMException("This operation was aborted", "AbortError");
          }
          // A non-2xx status was already known — headers had arrived —
          // before THIS failure (reading the body itself, for ANY reason:
          // the per-attempt timeout firing mid-read, or a genuine stream
          // error unrelated to any signal) happened. Losing the READABLE
          // BODY doesn't mean losing the STATUS too:
          // - 429/503 are retried UNCONDITIONALLY regardless of method or
          //   idempotency (the server rejected the request before
          //   processing) — falling into the network-error gate below
          //   instead would, for a keyless POST (where that gate is
          //   `false`), silently discard a retry the known status alone
          //   already made safe (confirmed by reproducing a keyless POST's
          //   429 going unretried at maxRetries=1 when its own body read
          //   timed out).
          // - A 409 with an idempotency key is safe to retry even without
          //   confirming the body's error_code was specifically
          //   IDEMPOTENCY_KEY_PROCESSING: per this API's own contract, that
          //   is the ONLY documented error_code 409 is ever used for —
          //   IDEMPOTENCY_KEY_MISMATCH is served on a completely different
          //   status (422, not 409; see ERROR_CODE_TO_CLASS/STATUS_TO_CLASS
          //   in errors.ts), so there's no plausible non-retryable meaning
          //   for a 409 this SDK doesn't already know how to read a body for.
          //   A keyed request never creates a second task on retry either
          //   way, and refusing to retry just because the body happened to
          //   be unreadable surfaced a misleadingly generic error instead
          //   of a real chance at the safe replay path (confirmed by
          //   reproducing a 409 whose body read failed for a non-abort
          //   reason skipping this retry entirely, unlike the otherwise-
          //   identical case where the body read had succeeded).
          if (knownStatus !== undefined) {
            const retryableKnownStatus =
              RETRY_STATUSES.has(knownStatus) || (hasIdempotencyKey && knownStatus === 409);
            if (retryableKnownStatus && attempt < this.maxRetries) {
              await sleep(retryDelayMs(attempt, knownHeaders ?? null), opts.signal);
              attempt += 1;
              continue;
            }
            // Not retryable, or retries exhausted — still a status-aware
            // error, not the ambiguous APIConnectionError below: there's
            // simply no body to include, since that's what failed to read.
            // NOT routed through errorFromResponse()'s error_code-then-
            // STATUS_TO_CLASS guessing, though — with no error_code to read
            // (the body itself is what's missing), that fallback would
            // often guess WRONG: a single status can carry several distinct
            // business meanings (400 is both INVALID_REQUEST and
            // MODEL_UNAVAILABLE; TASK_TIMEOUT/STORAGE_UNAVAILABLE aren't
            // documented to one fixed status either) — confirmed by
            // reproducing an unreadable 400 body that was actually
            // MODEL_UNAVAILABLE surfacing as InvalidRequestError instead.
            // The exact original read failure is preserved as `.cause`.
            throw errorForUnreadableBody(knownStatus, hasIdempotencyKey, err);
          }
          // Anything else fetch throws is network-level: DNS, refused/reset
          // connections, TLS failures, or the per-attempt timeout firing —
          // and no status was ever established at all (the fetch call
          // itself is what failed). Only retry when the request is safe to
          // repeat (see gate above).
          if (retryOnNetworkError && attempt < this.maxRetries) {
            await sleep(retryDelayMs(attempt, null), opts.signal);
            attempt += 1;
            continue;
          }
          throw new APIConnectionError(`request to ${url} failed: ${describeError(err)}`, {
            cause: err,
          });
        }
        const status = knownStatus;
        const respHeaders = knownHeaders!;

        if (RETRY_STATUSES.has(status) && attempt < this.maxRetries) {
          await sleep(retryDelayMs(attempt, respHeaders), opts.signal);
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
          await sleep(retryDelayMs(attempt, respHeaders), opts.signal);
          attempt += 1;
          continue;
        }
        throw err;
      } finally {
        dispose();
      }
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
 * Builds the signal for one request attempt — aborted by either `callerSignal`
 * or the per-attempt `timeoutMs` budget, whichever fires first — as a plain
 * `AbortController` with manually managed listeners and a manually managed
 * `setTimeout`, NOT `AbortSignal.any([callerSignal, AbortSignal.timeout(...)])`.
 * That composition has no way to be torn down early: neither
 * `AbortSignal.any()`'s internal "abort" listeners on its sources nor
 * `AbortSignal.timeout()`'s own internal timer can be released before they'd
 * naturally fire, so recreating one on every retry attempt against the SAME
 * long-lived `callerSignal` (exactly what a long `wait()` poll loop does)
 * accumulates listeners and pending timers that live for the FULL original
 * `timeoutMs` regardless of how quickly each individual attempt actually
 * completes — confirmed via a targeted benchmark showing substantial retained
 * memory after high-volume use. `dispose()` (call once the attempt is
 * settled, success or failure) removes both listeners and clears the timer
 * immediately, so nothing outlives the attempt it belongs to.
 */
function createAttemptSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; causedByCaller: () => boolean; dispose: () => void } {
  const controller = new AbortController();
  // Recorded atomically, at the exact moment each source actually wins the
  // race — NOT re-derived later from `callerSignal.aborted`. A later check
  // of that flag can't tell "the timeout fired first, and the caller
  // happened to abort afterward, before the fetch's rejection even
  // surfaced" apart from "the caller's abort is what actually caused this
  // failure": confirmed by reproducing exactly the former with a custom
  // fetch that delays its rejection — `callerSignal.aborted` was already
  // `true` by the time the catch block ran, so the LATER caller reason won
  // out over the timeout that had genuinely fired first, and skipped a
  // retry the timeout would otherwise have been eligible for.
  let causedByCaller = false;
  const timer = setTimeout(() => {
    if (controller.signal.aborted) return;
    controller.abort(new DOMException(`signal timed out after ${timeoutMs}ms`, "TimeoutError"));
  }, timeoutMs);
  // Doesn't itself keep the process alive — this timer exists to bound an
  // already-pending request, not to schedule work of its own.
  timer.unref?.();
  const onCallerAbort = () => {
    if (controller.signal.aborted) return;
    causedByCaller = true;
    controller.abort(callerSignal!.reason);
  };
  if (callerSignal?.aborted) {
    causedByCaller = true;
    clearTimeout(timer);
    controller.abort(callerSignal.reason);
  } else {
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  }
  return {
    signal: controller.signal,
    causedByCaller: () => causedByCaller,
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
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
      // `String(...)` applied explicitly: `err.message`/`err.name` are typed
      // `string` by TypeScript's `Error` interface, but that's compile-time
      // only — nothing stops either from being redefined as a non-string
      // getter at runtime. Returning either AS-IS on the strength of that
      // type alone (an earlier revision did) meant the actual ToString
      // conversion only happened later, in the caller's own template
      // literal — outside this function's `try` — reproducing the exact
      // escape this function exists to prevent, one level removed
      // (confirmed the same way: a `message` getter returning an object
      // with a throwing `toString()`).
      return String(err.message || err.name);
    }
    return String(err);
  } catch {
    return `<un-stringifiable ${typeof err}>`;
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

/**
 * Builds the error for a KNOWN status whose body could not be read at all —
 * deliberately NOT via `errorFromResponse()`'s error_code-then-
 * `STATUS_TO_CLASS` guessing, which exists for "the body parsed fine but had
 * no/unrecognized error_code," a different situation from "there's no body
 * to even attempt reading." Guessing a specific subclass from status alone
 * here is often wrong, since one status can carry several distinct business
 * meanings (see the call site's comment) — a plain `APIError` is the honest
 * answer in general. The one exception is `POST /tasks` with an
 * `idempotencyKey`: per this API's own contract, 409 there is used for
 * EXACTLY `IDEMPOTENCY_KEY_PROCESSING` and 422 for EXACTLY
 * `IDEMPOTENCY_KEY_MISMATCH` (see `ERROR_CODE_TO_CLASS`/`STATUS_TO_CLASS`
 * above) — nothing else is documented to use either status on that
 * endpoint, so those two keep their specific, actionable classes even
 * without the body confirming it. The original read failure is always
 * preserved as `cause`.
 */
function errorForUnreadableBody(
  status: number,
  hasIdempotencyKey: boolean,
  cause: unknown,
): APIError {
  if (hasIdempotencyKey && status === 409) {
    return new IdempotencyKeyProcessingError(`HTTP 409 (response body could not be read)`, {
      status,
      errorCode: IDEMPOTENCY_PROCESSING_CODE,
      cause,
    });
  }
  if (hasIdempotencyKey && status === 422) {
    return new IdempotencyKeyMismatchError(`HTTP 422 (response body could not be read)`, {
      status,
      cause,
    });
  }
  return new APIError(`HTTP ${status} (response body could not be read)`, { status, cause });
}
