/** The `client.tasks` resource — the unified async task API (/v1/tasks). */

import { PollTimeoutError, TaskFailedError } from "./errors.js";
import { CreatedTask, Task, TaskPage } from "./models.js";
import type { JSONObject } from "./models.js";
import { IDEMPOTENCY_KEY_HEADER, sleep, Transport } from "./transport.js";

export const DEFAULT_POLL_INTERVAL_MS = 3_000;
export const DEFAULT_POLL_TIMEOUT_MS = 600_000;

export interface CreateTaskParams {
  model: string;
  /**
   * The model's business parameters (fields vary per model). Do not put
   * callback/webhook fields inside `input` — pass `callback` separately or
   * the request is rejected.
   */
  input: JSONObject;
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
   * Client-side deadline for the poll loop. Default 600000 ms (10 minutes).
   * Reaching it throws {@link PollTimeoutError} — the task itself is NOT
   * cancelled and may still complete (and bill).
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

export type RunParams = CreateTaskParams & WaitOptions;

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
  async create(params: CreateTaskParams): Promise<CreatedTask> {
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
    const extraHeaders = params.idempotencyKey
      ? { [IDEMPOTENCY_KEY_HEADER]: params.idempotencyKey }
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
   * {@link TaskFailedError} on `fail` and {@link PollTimeoutError} only once
   * `timeoutMs` milliseconds have actually elapsed.
   */
  async wait(taskId: string, options: WaitOptions = {}): Promise<Task> {
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    if (pollIntervalMs <= 0) {
      throw new RangeError("pollIntervalMs must be > 0");
    }
    if (timeoutMs < 0) {
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
  async run(params: RunParams): Promise<Task> {
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
