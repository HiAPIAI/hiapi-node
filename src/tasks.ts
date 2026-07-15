/** The `client.tasks` resource — the unified async task API (/v1/tasks). */

import { HiAPIError, PollTimeoutError, TaskFailedError } from "./errors.js";
import { CreatedTask, Task, TaskPage } from "./models.js";
import type { JSONObject } from "./models.js";
import { IDEMPOTENCY_KEY_HEADER, MAX_TIMER_DELAY_MS, sleep, Transport } from "./transport.js";

export const DEFAULT_POLL_INTERVAL_MS = 3_000;
export const DEFAULT_POLL_TIMEOUT_MS = 600_000;

export interface CreateTaskParams {
  model: string;
  /**
   * The model's business parameters (fields vary per model). Do not put
   * callback/webhook fields inside `input` — pass `callback` separately or
   * the request is rejected.
   *
   * Typed as plain `object` (not `Record<string, unknown>`) so a named
   * `interface` — which TypeScript does not consider structurally assignable
   * to an index-signature type without an explicit `[key: string]: unknown` —
   * can be passed here without a cast, including through a pre-declared
   * `CreateTaskParams`-typed variable (a generic default type parameter only
   * helps at a direct call site, where inference can override it; a plain
   * `object` constraint has no such gap).
   */
  input: object;
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
   * Output storage tier: `"temp"` (default, kept ~7 days) or `"persistent"`
   * (kept long-term, billed by size). Insufficient balance or exceeding your
   * storage cap silently downgrades to `"temp"` — the actual tier used is
   * reflected on the task detail response (`Task.storage`). Can also be
   * promoted after the fact; see the Output Storage docs.
   */
  storage?: "temp" | "persistent";
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
   * Aborts the poll loop (not the task) when triggered. Not forwarded into
   * the in-flight HTTP request, so aborting while a `retrieve` call is
   * already underway lets that one request finish — but the abort is then
   * honoured immediately once it resolves, before `onUpdate` fires or a
   * terminal result is returned/thrown.
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
    if (params.storage) {
      body.storage = params.storage;
    }
    if (params.callback !== undefined) {
      body.callback = params.callback;
    }
    // Whitespace-only key handling lives in Transport (the single funnel
    // every request goes through), not here — see its comment.
    const extraHeaders = params.idempotencyKey
      ? { [IDEMPOTENCY_KEY_HEADER]: params.idempotencyKey }
      : undefined;
    const [env, respHeaders] = await this.transport.requestWithHeaders("POST", "/tasks", {
      body,
      extraHeaders,
    });
    const replay = (respHeaders.get("idempotent-replay") ?? "").toLowerCase() === "true";
    const created = CreatedTask.fromJSON(data(env), replay);
    // A 2xx response is only meaningful if it actually carries a task id —
    // without this check, a malformed/anomalous `{data:{}}` response would
    // silently produce a CreatedTask with taskId: "", and a subsequent
    // run()/wait() would poll `GET /tasks/` (empty id) — surfacing as a
    // confusing NotFoundError or PollTimeoutError instead of what actually
    // went wrong: the server didn't return a task id.
    if (!created.taskId) {
      throw new HiAPIError(
        "task creation succeeded but the response did not include a taskId",
      );
    }
    return created;
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
   * {@link TaskFailedError} on `fail`. Throws {@link PollTimeoutError} once
   * `timeoutMs` milliseconds have elapsed *between polls* — but only if the
   * task is still non-terminal at that point: the deadline is checked once
   * per iteration, after `retrieve` resolves and only once success/fail have
   * already been ruled out, so a task that actually finished is always
   * returned/thrown rather than discarded for being "late". A slow
   * individual request (network retries, a large `Retry-After`) can
   * similarly push the actual wall-clock time somewhat past `timeoutMs`
   * before a timeout is caught. It is a budget for the polling loop, not a
   * hard per-call cutoff.
   */
  async wait(taskId: string, options: WaitOptions = {}): Promise<Task> {
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    // Inverted comparisons (rather than `<= 0` / `< 0`) so a NaN value fails
    // the check too — a bare `NaN <= 0` is `false`, which would otherwise let
    // NaN slip through and turn the loop below into a zero-delay busy poll.
    // pollIntervalMs must additionally be finite and within Node's real timer
    // range (unlike timeoutMs, which may be Infinity to mean "no timeout"):
    // confirmed via `node -e` that both `Infinity` and values above
    // MAX_TIMER_DELAY_MS get silently clamped to ~1ms rather than waited out
    // in full, which would turn a large/infinite interval into the same
    // zero-delay busy-poll NaN causes.
    if (
      !Number.isFinite(pollIntervalMs) ||
      !(pollIntervalMs > 0) ||
      pollIntervalMs > MAX_TIMER_DELAY_MS
    ) {
      throw new RangeError(`pollIntervalMs must be a finite number in (0, ${MAX_TIMER_DELAY_MS}]`);
    }
    // `typeof` first, not `Number.isFinite` (which would also reject the
    // legitimate `Infinity` value): a bare `>= 0` comparison coerces a
    // non-number — e.g. a plain-JS caller (no compile-time protection)
    // passing the STRING "Infinity" — since `"Infinity" >= 0` reads as
    // `Number("Infinity") >= 0` and passes, but `deadline + timeoutMs` below
    // uses `+`, which for a string operand does concatenation instead of
    // addition, producing a garbage value that later coerces to NaN and
    // reproduces the exact zero-delay busy-poll this function guards against
    // elsewhere. Confirmed by tracing the actual `+`/`-` coercion rules.
    if (typeof timeoutMs !== "number" || Number.isNaN(timeoutMs) || timeoutMs < 0) {
      throw new RangeError("timeoutMs must be a number >= 0");
    }
    const deadline = performance.now() + timeoutMs;
    let lastStatus: string | undefined;
    for (;;) {
      options.signal?.throwIfAborted();
      const task = await this.retrieve(taskId);
      // Re-checked here, not just at the top of the loop: the signal could
      // have been aborted while the `await` above was in flight, and without
      // this the abort wouldn't be honoured until after onUpdate fires and a
      // terminal result (if any) is fully returned/thrown.
      options.signal?.throwIfAborted();
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
