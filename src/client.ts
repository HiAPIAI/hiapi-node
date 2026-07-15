/** The {@link HiAPI} client — the entry point to the SDK. */

import { HiAPIError } from "./errors.js";
import { Tasks } from "./tasks.js";
import { Transport } from "./transport.js";
import type { FetchLike } from "./transport.js";
import { Webhooks } from "./webhooks.js";

export const DEFAULT_BASE_URL = "https://api.hiapi.ai/v1";
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RETRIES = 2;

export interface HiAPIOptions {
  /** Account API key (`sk-...`). Falls back to the `HIAPI_API_KEY` environment variable. */
  apiKey?: string;
  /** API base URL, including the `/v1` prefix. */
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Default 60000. */
  timeoutMs?: number;
  /**
   * Retries for 429/503 (always) and network errors (exponential backoff).
   * Default 2. Network-error retries are conditional: a `GET`/`HEAD`/`PUT`/
   * `DELETE`, or a `POST` carrying `idempotencyKey`, retries on a network
   * failure — a keyless `POST` (e.g. plain `tasks.create()`) does not, since
   * the request may have already reached the server and there is no safe way
   * to tell without an idempotency key.
   */
  maxRetries?: number;
  /**
   * Default signing key for `client.webhooks.verify`; falls back to the
   * `HIAPI_WEBHOOK_SECRET` environment variable.
   */
  webhookSecret?: string;
  /** Custom fetch implementation (for testing or instrumentation). */
  fetch?: FetchLike;
}

/**
 * Client for the HiAPI unified async task API.
 *
 * ```ts
 * import { HiAPI } from "hiapi";
 *
 * const client = new HiAPI({ apiKey: "sk-..." }); // or set HIAPI_API_KEY
 * const task = await client.tasks.run({
 *   model: "seedance-2-0",
 *   input: { prompt: "a cyan glass data center", resolution: "1080p" },
 *   onUpdate: (t) => console.log(t.status),
 * });
 * console.log(task.output[0].url);
 * ```
 */
export class HiAPI {
  readonly baseUrl: string;
  readonly tasks: Tasks;
  readonly webhooks: Webhooks;

  constructor(options: HiAPIOptions = {}) {
    // `||`, not `??`: an explicit empty string should fall back to the
    // environment variable too (matching the Python SDK), not be treated as
    // "an API key was provided". Either way `if (!key)` below still rejects
    // an empty result — this only changes whether a set HIAPI_API_KEY is
    // tried first.
    const key = options.apiKey || process.env.HIAPI_API_KEY;
    if (!key) {
      throw new HiAPIError(
        "missing API key: pass apiKey or set the HIAPI_API_KEY environment variable",
      );
    }
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    const transport = new Transport(
      key,
      this.baseUrl,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      options.maxRetries ?? DEFAULT_MAX_RETRIES,
      options.fetch,
    );
    this.tasks = new Tasks(transport);
    this.webhooks = new Webhooks(options.webhookSecret || process.env.HIAPI_WEBHOOK_SECRET);
  }
}
