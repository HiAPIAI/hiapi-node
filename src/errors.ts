/**
 * Error hierarchy for the HiAPI SDK.
 *
 *     HiAPIError                       base for everything thrown by this SDK
 *     ├── APIError                     the server returned a non-2xx HTTP response
 *     │   ├── AuthenticationError      401 — missing / invalid API key
 *     │   ├── NotFoundError            404 — task does not exist or not yours
 *     │   ├── ServiceUnavailableError  503 — platform temporarily unavailable
 *     │   ├── InvalidRequestError      error_code=INVALID_REQUEST
 *     │   ├── ModelUnavailableError    error_code=MODEL_UNAVAILABLE
 *     │   ├── TaskFailedSyncError      error_code=TASK_FAILED (synchronous rejection)
 *     │   ├── TaskTimeoutError         error_code=TASK_TIMEOUT
 *     │   ├── StorageUnavailableError  error_code=STORAGE_UNAVAILABLE
 *     │   ├── IdempotencyKeyProcessingError 409 — first request in flight; retryable
 *     │   └── IdempotencyKeyMismatchError   422 — key reused with a different body
 *     ├── APIConnectionError           network failure / DNS / connection reset / timeout
 *     ├── TaskFailedError              a polled task reached terminal status=fail
 *     ├── PollTimeoutError             run()/wait() exceeded the client-side timeout
 *     ├── RunAbortedError              run()'s signal was aborted immediately after task creation
 *     ├── RunFailedError               run()'s task exists but failed some other way while polling
 *     └── WebhookVerificationError     callback signature / timestamp check failed
 */

import type { Task } from "./models.js";

/**
 * Structurally identical to the built-in `ErrorOptions` (`{ cause?: unknown }`),
 * defined locally instead of referencing that global type directly. `ErrorOptions`
 * is only declared by TypeScript's ES2022 lib — a consumer project compiling
 * against an older `lib` (ES2020/ES2021, common for Node 18 targets) has no
 * global of that name in scope, and since our public `.d.ts` output would
 * otherwise reference it unqualified, TS reports `TS2552: Cannot find name
 * 'ErrorOptions'` on every constructor that exposes it — confirmed by compiling
 * the built `dist/esm/errors.d.ts` under `"lib": ["ES2020", "DOM"]`. Our own
 * runtime `target`/`lib` stay ES2022 (verified structurally compatible via
 * TS's structural typing when passed to `super(message, options)`); only the
 * publicly-exported parameter type changes.
 */
export interface CauseOptions {
  cause?: unknown;
}

/** Base class for every error thrown by the SDK. */
export class HiAPIError extends Error {
  constructor(message: string, options?: CauseOptions) {
    super(message, options);
    this.name = "HiAPIError";
  }
}

/**
 * `cause`: set when this error was constructed FROM another one (e.g. the
 * response body itself failed to read) rather than parsed from a real
 * response body — absent for the normal "parsed the body, no/unrecognized
 * error_code" case.
 */
export interface APIErrorOptions {
  status: number;
  errorCode?: string;
  body?: string;
  cause?: unknown;
}

/**
 * The server returned a non-2xx response.
 *
 * `status` is the HTTP status code, `errorCode` the business error code from
 * the response envelope (if any), and `body` the raw decoded response body.
 */
export class APIError extends HiAPIError {
  readonly status: number;
  readonly errorCode?: string;
  readonly body?: string;

  constructor(message: string, opts: APIErrorOptions) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "APIError";
    this.status = opts.status;
    this.errorCode = opts.errorCode;
    this.body = opts.body;
  }
}

/** 401 — the API key is missing or invalid. */
export class AuthenticationError extends APIError {
  constructor(message: string, opts: APIErrorOptions) {
    super(message, opts);
    this.name = "AuthenticationError";
  }
}

/** 404 — the task does not exist or does not belong to this account. */
export class NotFoundError extends APIError {
  constructor(message: string, opts: APIErrorOptions) {
    super(message, opts);
    this.name = "NotFoundError";
  }
}

/** 503 — the platform is temporarily unavailable; retry with backoff. */
export class ServiceUnavailableError extends APIError {
  constructor(message: string, opts: APIErrorOptions) {
    super(message, opts);
    this.name = "ServiceUnavailableError";
  }
}

/** error_code=INVALID_REQUEST — fix the request; do not retry as-is. */
export class InvalidRequestError extends APIError {
  constructor(message: string, opts: APIErrorOptions) {
    super(message, opts);
    this.name = "InvalidRequestError";
  }
}

/** error_code=MODEL_UNAVAILABLE — retry shortly or switch models. */
export class ModelUnavailableError extends APIError {
  constructor(message: string, opts: APIErrorOptions) {
    super(message, opts);
    this.name = "ModelUnavailableError";
  }
}

/**
 * error_code=TASK_FAILED on a synchronous response — the submission itself was
 * rejected. Distinct from {@link TaskFailedError}, which is thrown when a task
 * that was accepted later reaches the terminal `fail` status while polling.
 */
export class TaskFailedSyncError extends APIError {
  constructor(message: string, opts: APIErrorOptions) {
    super(message, opts);
    this.name = "TaskFailedSyncError";
  }
}

/** error_code=TASK_TIMEOUT — the upstream task timed out; retryable. */
export class TaskTimeoutError extends APIError {
  constructor(message: string, opts: APIErrorOptions) {
    super(message, opts);
    this.name = "TaskTimeoutError";
  }
}

/** error_code=STORAGE_UNAVAILABLE — output storage error; retryable. */
export class StorageUnavailableError extends APIError {
  constructor(message: string, opts: APIErrorOptions) {
    super(message, opts);
    this.name = "StorageUnavailableError";
  }
}

/**
 * error_code=IDEMPOTENCY_KEY_PROCESSING (409) — the first request with this
 * `Idempotency-Key` is still in flight. Retryable: wait `Retry-After` seconds
 * and resend the identical request; it will replay the original task once
 * created. The transport already retries this automatically up to `maxRetries`
 * before letting it surface.
 */
export class IdempotencyKeyProcessingError extends APIError {
  constructor(message: string, opts: APIErrorOptions) {
    super(message, opts);
    this.name = "IdempotencyKeyProcessingError";
  }
}

/**
 * error_code=IDEMPOTENCY_KEY_MISMATCH (422) — this `Idempotency-Key` was
 * already used with a different request body. Not retryable: the key
 * construction is buggy (two distinct requests derived the same key).
 */
export class IdempotencyKeyMismatchError extends APIError {
  constructor(message: string, opts: APIErrorOptions) {
    super(message, opts);
    this.name = "IdempotencyKeyMismatchError";
  }
}

/** A network-level failure (or client-side timeout) prevented the request from completing. */
export class APIConnectionError extends HiAPIError {
  constructor(message: string, options?: CauseOptions) {
    super(message, options);
    this.name = "APIConnectionError";
  }
}

/**
 * A task being polled reached the terminal `fail` status.
 *
 * `task` is the full {@link Task} in its failed state; `code` is the task's
 * `error.code` when present.
 */
export class TaskFailedError extends HiAPIError {
  readonly task: Task;
  readonly code?: string;

  constructor(task: Task) {
    const message = task.error?.message || "task failed";
    super(`task ${task.taskId || "?"} failed: ${message}`);
    this.name = "TaskFailedError";
    this.task = task;
    this.code = task.error?.code;
  }
}

/**
 * `run()` / `wait()` gave up before the task reached a terminal state. The
 * task itself is NOT cancelled — it may still complete (and bill); poll
 * `tasks.retrieve(taskId)` later to pick up the result.
 */
export class PollTimeoutError extends HiAPIError {
  readonly taskId: string;
  /** The client-side timeout in milliseconds that was exceeded. */
  readonly timeoutMs: number;

  constructor(taskId: string, timeoutMs: number) {
    super(
      `task ${taskId} did not finish within ${timeoutMs}ms; ` +
        `it may still complete — poll tasks.retrieve("${taskId}") later`,
    );
    this.name = "PollTimeoutError";
    this.taskId = taskId;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * `run()`'s `signal` was already aborted — either before `create()` was
 * called, or while it was in flight — by the time the task had actually been
 * created. See {@link RunFailedError} for every other way `run()` can fail
 * once its task exists (a later abort, a network/API error while polling, an
 * `onUpdate` rejection): both carry `taskId` for the same reason — the task
 * exists and may still run and bill, so the caller must not be left unable
 * to find it.
 */
export class RunAbortedError extends HiAPIError {
  readonly taskId: string;

  constructor(taskId: string, options?: CauseOptions) {
    super(
      `run() was aborted after task ${taskId} was already created — it may ` +
        `still run and bill; poll tasks.retrieve("${taskId}") to check on it`,
      options,
    );
    this.name = "RunAbortedError";
    this.taskId = taskId;
  }
}

/**
 * `run()`'s task was created, but something other than a terminal `fail`
 * status or a client-side poll timeout kept it from finishing — a network or
 * API error while polling, an `onUpdate` callback rejecting, or the `signal`
 * aborting during (rather than immediately after) creation. Those errors
 * (`APIConnectionError`, `APIError` and subclasses, an arbitrary rejection,
 * a plain `AbortError`) don't carry a `taskId` of their own, and the task
 * this error is about already exists and may still run and bill — this
 * wraps whichever of them occurred as `cause` and exposes `taskId` so the
 * caller can still look the task up. `TaskFailedError` and
 * `PollTimeoutError` are NOT wrapped this way: both already carry `taskId`
 * (via `.task.taskId` and `.taskId` respectively) and are still thrown
 * directly, unchanged.
 */
export class RunFailedError extends HiAPIError {
  readonly taskId: string;

  constructor(taskId: string, cause: unknown) {
    super(
      `run() failed for task ${taskId} after it was created: ${describeCause(cause)} — it ` +
        `may still run and bill; poll tasks.retrieve("${taskId}") to check on it`,
      { cause },
    );
    this.name = "RunFailedError";
    this.taskId = taskId;
  }
}

/**
 * Describes an arbitrary rejection reason for an error message, without ever
 * throwing itself. A plain `String(cause)` (or a template literal, which
 * does the same ToString conversion) calls `cause`'s own `toString`/
 * `Symbol.toPrimitive` for a non-`Error` object — confirmed via `node -e`
 * that a plain object with a throwing `toString()` makes `String(...)`
 * itself throw. `cause.message` for an actual `Error` instance has the same
 * failure mode one level up: a `message` defined as a throwing getter
 * throws too, confirmed the same way.
 *
 * `cause.message` is typed `string` by TypeScript's `Error` interface, but
 * that's a compile-time-only guarantee — nothing stops a `message` getter
 * from returning a non-string value at runtime. An earlier revision of this
 * function `return`ed it as-is on the strength of that type alone, so the
 * ACTUAL ToString conversion only happened later, in {@link RunFailedError}'s
 * own template literal — outside this function's `try`, reproducing the
 * exact same escape one level removed (confirmed the same way: a `message`
 * getter returning an object with a throwing `toString()`). `String(...)`
 * is applied to it explicitly, inside this `try`, so the coercion — and any
 * throw it can produce — happens where it's actually caught.
 */
function describeCause(cause: unknown): string {
  try {
    if (cause instanceof Error) {
      return String(cause.message);
    }
    return String(cause);
  } catch {
    return `<un-stringifiable ${typeof cause}>`;
  }
}

/** A callback could not be verified (bad signature or stale timestamp). */
export class WebhookVerificationError extends HiAPIError {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

type APIErrorClass = new (message: string, opts: APIErrorOptions) => APIError;

/** Maps the API `error_code` enum onto the matching error class. */
export const ERROR_CODE_TO_CLASS: Record<string, APIErrorClass> = {
  INVALID_REQUEST: InvalidRequestError,
  MODEL_UNAVAILABLE: ModelUnavailableError,
  TASK_FAILED: TaskFailedSyncError,
  TASK_TIMEOUT: TaskTimeoutError,
  STORAGE_UNAVAILABLE: StorageUnavailableError,
  IDEMPOTENCY_KEY_PROCESSING: IdempotencyKeyProcessingError,
  IDEMPOTENCY_KEY_MISMATCH: IdempotencyKeyMismatchError,
};

/** Falls back to a status-based class when no (recognized) error_code is present. */
export const STATUS_TO_CLASS: Record<number, APIErrorClass> = {
  400: InvalidRequestError,
  401: AuthenticationError,
  404: NotFoundError,
  503: ServiceUnavailableError,
};
