/** The `client.tasks` resource — the unified async task API (/v1/tasks). */

import { PollTimeoutError, TaskFailedError } from "./errors.js";
import { CreatedTask, Task, TaskPage } from "./models.js";
import type { JSONObject } from "./models.js";
import { IDEMPOTENCY_KEY_HEADER, sleep, Transport } from "./transport.js";

export const DEFAULT_POLL_INTERVAL_MS = 3_000;
export const DEFAULT_POLL_TIMEOUT_MS = 600_000;

export interface CreateTaskParams<TInput extends object = Record<string, unknown>> {
  model: string;
  /**
   * The model's business parameters (fields vary per model). Do not put
   * callback/webhook fields inside `input` — pass `callback` separately or
   * the request is rejected.
   *
   * Typed as a generic `object` (not `Record<string, unknown>` directly) so a
   * plain named `interface` — which TypeScript does not consider structurally
   * assignable to an index-signature type without an explicit `[key: string]:
   * unknown` — can be passed here without a cast.
   */
  input: TInput;
  /** Webhook target, e.g. `{ url: "https://...", when: "final" }`. */
  callback?: JSONObject;
  /**
   * Selects a model route (e.g. `"ext"`) without writing the `model@route`
   * suffix form: `model: "x", route: "ext"` is the preferred spelling of
   * `model: "x@ext"`. Omitted / `"default"` both mean the default route. An
   * unknown route is rejected with a 400 listing the available routes.
   */
  route?: string;
  /**
   * Sent as the `Idempotency-Key` header (at most 255 bytes); makes retries
   * safe. Resending the same key + body returns the original task
   * (`CreatedTask.idempotentReplay` is then `true`) instead of creating and
   * billing a second one. The transport also becomes willing to retry this
   * POST on network errors. Reusing a key with a *different* body throws
   * `IdempotencyKeyMismatchError`.
   */
  idempotencyKey?: string;
}

export interface WaitOptions {
  /** Delay between polls. Default 3000 ms. */
  pollIntervalMs?: number;
  /**
   * Client-side budget for the poll loop, checked between polls (not a hard
   * per-request cutoff — see {@link Tasks.wait}). Default 600000 ms (10
   * minutes). Reaching it throws {@link PollTimeoutError} — the task itself
   * is NOT cancelled and may still complete (and bill).
   */
  timeoutMs?: number;
  /** Called once per status change while waiting; receives the latest Task. */
  onUpdate?: (task: Task) => void;
  /**
   * Aborts the poll loop (not the task) when triggered. Checked between polls
   * and before each `retrieve` call — not forwarded into the in-flight HTTP
   * request, so aborting while a poll's request is already underway lets that
   * one request finish before the loop stops.
   */
  signal?: AbortSignal;
}

export type RunParams<TInput extends object = Record<string, unknown>> = CreateTaskParams<TInput> &
  WaitOptions;

export interface ListParams {
  page?: number;
  size?: number;
}

export class Tasks {
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /** Submit a task and return immediately with its `taskId`. */
  async create<TInput extends object = Record<string, unknown>>(
    params: CreateTaskParams<TInput>,
  ): Promise<CreatedTask> {
    const body: JSONObject = { model: params.model, input: params.input };
    // An empty string means "no route" — omit it, matching the other SDKs and
    // the server's "'' ≡ absent ≡ default" rule. Keeping the field out also
    // keeps the idempotency hash (over the raw body) identical whether the
    // caller passes route: "" or omits it.
    if (params.route) {
      body.route = params.route;
    }
    if (params.callback !== undefined) {
      body.callback = params.callback;
    }
    // A whitespace-only key (e.g. " ") is truthy in JS but gets normalized
    // away to an empty header value on the wire (HTTP strips leading/trailing
    // whitespace from header values), which a server treats as "no key" —
    // trim before deciding this POST is idempotency-safe, or a network error
    // could be retried under the false belief that duplicates collapse
    // server-side, creating (and billing) a second task.
    const idempotencyKey = params.idempotencyKey?.trim();
    const extraHeaders = idempotencyKey
      ? { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey }
      : undefined;
    const [env, respHeaders] = await this.transport.requestWithHeaders("POST", "/tasks", {
      body,
      extraHeaders,
    });
    const replay = (respHeaders.get("idempotent-replay") ?? "").toLowerCase() === "true";
    return CreatedTask.fromJSON(data(env), replay);
  }

  /** Fetch a task's current status and (when `success`) its output. */
  async retrieve(taskId: string): Promise<Task> {
    const env = await this.transport.request("GET", "/tasks/" + encodeURIComponent(taskId));
    return Task.fromJSON(data(env));
  }

  /** List your tasks, newest first (paginated). */
  async list(params: ListParams = {}): Promise<TaskPage> {
    const page = params.page ?? 1;
    const size = params.size ?? 20;
    const env = await this.transport.request("GET", "/tasks", { params: { page, size } });
    let d: unknown = env.data;
    if (Array.isArray(d)) {
      d = { items: d, page, size };
    } else if (typeof d !== "object" || d === null) {
      d = {};
    }
    return TaskPage.fromJSON(d as JSONObject);
  }

  /**
   * Poll `taskId` until it reaches a terminal state.
   *
   * Resolves with the {@link Task} on `success`. Throws
   * {@link TaskFailedError} on `fail` and {@link PollTimeoutError} once
   * `timeoutMs` milliseconds have elapsed *between polls* — the deadline is
   * only checked before each `retrieve` call, so a slow individual request
   * (network retries, a large `Retry-After`) can push the actual wall-clock
   * time somewhat past `timeoutMs` before it's caught. It is a budget for the
   * polling loop, not a hard per-call cutoff.
   */
  async wait(taskId: string, options: WaitOptions = {}): Promise<Task> {
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    // Inverted comparisons (rather than `<= 0` / `< 0`) so a NaN value fails
    // the check too — a bare `NaN <= 0` is `false`, which would otherwise let
    // NaN slip through and turn the loop below into a zero-delay busy poll.
    if (!(pollIntervalMs > 0)) {
      throw new RangeError("pollIntervalMs must be > 0");
    }
    if (!(timeoutMs >= 0)) {
      throw new RangeError("timeoutMs must be >= 0");
    }
    const deadline = performance.now() + timeoutMs;
    let lastStatus: string | undefined;
    for (;;) {
      options.signal?.throwIfAborted();
      const task = await this.retrieve(taskId);
      if (options.onUpdate && task.status !== lastStatus) {
        lastStatus = task.status;
        options.onUpdate(task);
      }
      if (task.status === "success") {
        return task;
      }
      if (task.status === "fail") {
        throw new TaskFailedError(task);
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw new PollTimeoutError(taskId, timeoutMs);
      }
      // Sleep the smaller of the poll interval and the time left, so the last
      // poll lands right at the deadline rather than before it.
      await sleep(Math.min(pollIntervalMs, remaining), options.signal);
    }
  }

  /**
   * Create a task and wait until it finishes — the one-call workflow.
   *
   * Equivalent to {@link create} followed by {@link wait}. `callback` is
   * optional and independent of polling; set it if you also want a webhook.
   */
  async run<TInput extends object = Record<string, unknown>>(
    params: RunParams<TInput>,
  ): Promise<Task> {
    const created = await this.create(params);
    return this.wait(created.taskId, {
      pollIntervalMs: params.pollIntervalMs,
      timeoutMs: params.timeoutMs,
      onUpdate: params.onUpdate,
      signal: params.signal,
    });
  }
}

function data(env: JSONObject): JSONObject {
  const d = env.data;
  return typeof d === "object" && d !== null && !Array.isArray(d) ? (d as JSONObject) : {};
}
