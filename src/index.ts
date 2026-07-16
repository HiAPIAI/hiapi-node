/**
 * HiAPI Node.js SDK — a zero-dependency client for the unified async task API.
 *
 * ```ts
 * import { HiAPI } from "hiapi";
 *
 * const client = new HiAPI({ apiKey: "sk-..." }); // or set HIAPI_API_KEY
 * const task = await client.tasks.run({
 *   model: "seedance-2-0",
 *   input: { prompt: "...", resolution: "1080p" },
 * });
 * console.log(task.output[0].url);
 * ```
 */

export { HiAPI, DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_RETRIES } from "./client.js";
export type { HiAPIOptions } from "./client.js";

export { CreatedTask, Output, Task, TaskError, TaskPage, TERMINAL_STATUSES } from "./models.js";
export type { JSONObject, TaskStatus } from "./models.js";

export { Tasks, DEFAULT_POLL_INTERVAL_MS, DEFAULT_POLL_TIMEOUT_MS } from "./tasks.js";
export type { CreateTaskParams, ListParams, RunParams, WaitOptions } from "./tasks.js";

export {
  verifyWebhook,
  Webhooks,
  DEFAULT_TOLERANCE,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from "./webhooks.js";
export type { HeadersLike, VerifyWebhookOptions } from "./webhooks.js";

export {
  HiAPIError,
  APIError,
  APIConnectionError,
  AuthenticationError,
  NotFoundError,
  ServiceUnavailableError,
  InvalidRequestError,
  ModelUnavailableError,
  TaskFailedSyncError,
  TaskTimeoutError,
  StorageUnavailableError,
  IdempotencyKeyProcessingError,
  IdempotencyKeyMismatchError,
  TaskFailedError,
  PollTimeoutError,
  RunAbortedError,
  RunFailedError,
  WebhookVerificationError,
} from "./errors.js";

export type { FetchLike } from "./transport.js";

export { VERSION } from "./version.js";
