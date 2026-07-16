/** The `client.tasks` resource — the unified async task API (/v1/tasks). */

import {
  HiAPIError,
  PollTimeoutError,
  RunAbortedError,
  RunFailedError,
  TaskFailedError,
} from "./errors.js";
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
  /**
   * Webhook target, e.g. `{ url: "https://...", when: "final" }`.
   *
   * Typed as plain `object`, not `Record<string, unknown>` — same reason as
   * `input` above: a named `interface` (no index signature) isn't otherwise
   * structurally assignable here without a cast.
   */
  callback?: object;
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
   * Sent as the `Idempotency-Key` header: printable ASCII only, at most 255
   * characters (a non-ASCII character — e.g. `"订单-8472"` — is rejected
   * before the request is sent, since the underlying `fetch` header value
   * can only hold Latin-1 bytes and would otherwise throw a raw `TypeError`
   * deep inside the transport instead of a clear, immediate error). Makes
   * retries safe: resending the same key + body returns the original task
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
  /**
   * Called once per status change while waiting; receives the latest Task.
   *
   * Its result is awaited before the poll loop continues — deliberately
   * still typed as returning plain `void` (not `void | Promise<void>`,
   * which — confirmed via `tsc` — stops TypeScript from also permitting a
   * *synchronous* callback that returns a non-void value, e.g. the common
   * `onUpdate: (t) => seen.push(t.status)`; `void` alone keeps accepting
   * both, since TS's "ignore the return value" rule for a `void`-typed
   * callback already covers a `Promise` too). Passing an `async` function
   * therefore still type-checks with no ceremony, and at runtime it's
   * actually awaited: a rejection propagates out of `wait()`/`run()` instead
   * of becoming an unhandled promise rejection, and two status changes
   * firing back-to-back settle in order rather than racing (confirmed by
   * reproducing both without awaiting). The wait is also raced against
   * `signal` — an abort stops it promptly instead of leaving it pending
   * (confirmed by reproducing exactly that with a callback that never
   * resolves). For a NON-terminal status, it's additionally raced against
   * the remaining `timeoutMs` budget, rejecting with {@link PollTimeoutError}
   * if the callback outlasts it. A *terminal* (`success`/`fail`) status's
   * call is NOT raced against `timeoutMs`, only `signal`: at that point
   * `wait()` already has the real, final answer in hand, and there is no
   * safe way to "give up" on an in-flight callback call without either
   * hanging anyway or silently discarding whatever it was about to do or
   * report (confirmed both ways) — so it always runs to completion (or
   * until aborted). If you need to bound a terminal `onUpdate` call
   * specifically, pass `signal` (e.g. from `AbortSignal.timeout(...)`).
   */
  onUpdate?: (task: Task) => void;
  /**
   * Aborts the poll loop (not the task) when triggered. Forwarded into the
   * transport, so it interrupts an in-flight HTTP request, a pending
   * retry-backoff sleep, and any subsequent retry attempt's request — an
   * abort landing mid-retry (during a 429/503's `Retry-After` wait, say) is
   * honoured promptly rather than only once the whole `retrieve` call,
   * retries included, finally settles. Never resurrects a network-error
   * retry the request's own idempotency rules wouldn't already allow: this
   * only interrupts requests `wait()`/`retrieve()` were already making
   * safely.
   */
  signal?: AbortSignal;
}

export type RunParams = CreateTaskParams & WaitOptions;

export interface ListParams {
  page?: number;
  size?: number;
  /**
   * Aborts this request (including any pending retry-backoff sleep). Unlike
   * `create()`, a GET has no billing/idempotency ambiguity to worry about,
   * so there's no reason to leave it uncancellable the way `create()`
   * deliberately is.
   */
  signal?: AbortSignal;
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
    // went wrong: the server didn't return a task id. Trimmed, not a bare
    // truthiness check — a whitespace-only id (e.g. "   ") is truthy but
    // would produce the same nonsense request (`/tasks/%20%20%20`).
    if (!created.taskId.trim()) {
      throw new HiAPIError(
        "task creation succeeded but the response did not include a taskId",
      );
    }
    return created;
  }

  /**
   * Fetch a task's current status and (when `success`) its output.
   *
   * `signal`, if given, aborts this specific request (including any pending
   * retry-backoff sleep) — used internally by {@link wait} so an abort lands
   * promptly even mid-retry, not just between polls.
   */
  async retrieve(taskId: string, signal?: AbortSignal): Promise<Task> {
    const env = await this.transport.request("GET", "/tasks/" + encodeURIComponent(taskId), {
      signal,
    });
    const task = Task.fromJSON(data(env));
    // A 2xx here is only trustworthy if it's actually describing the task we
    // asked about — without this check, a malformed/mismatched response
    // (missing taskId, or a caching/routing bug on the server returning a
    // DIFFERENT task's data) would be silently accepted: wait() would either
    // poll forever toward a timeout (status/output never matching what the
    // caller expects) or, worse, misattribute another task's output as this
    // one's. One comparison catches both the "empty" and "wrong" cases.
    if (task.taskId !== taskId) {
      throw new HiAPIError(
        `task detail response taskId "${task.taskId}" does not match the requested "${taskId}"`,
      );
    }
    // A missing/non-string `status` parses to `""` (see `Task.fromJSON`) —
    // deliberately kept as a plain string, not the `TaskStatus` union,
    // precisely so a future *real* status the server adds still parses
    // instead of breaking an older SDK. An empty one is different: it's not
    // a forward-compatible unknown value, it's the field being absent
    // entirely. Without this check, `{data:{taskId:"t"}}` parses as a
    // "successfully retrieved", non-terminal task — `wait()` would keep
    // polling it forever (or time out) instead of surfacing the real
    // problem: a malformed response.
    if (!task.status.trim()) {
      throw new HiAPIError(`task ${taskId} detail response did not include a status`);
    }
    return task;
  }

  /** List your tasks, newest first (paginated). */
  async list(params: ListParams = {}): Promise<TaskPage> {
    const page = params.page ?? 1;
    const size = params.size ?? 20;
    const env = await this.transport.request("GET", "/tasks", {
      params: { page, size },
      signal: params.signal,
    });
    const rawData = env.data;
    let d: JSONObject;
    if (Array.isArray(rawData)) {
      d = { items: rawData, page, size };
    } else if (typeof rawData === "object" && rawData !== null) {
      d = rawData as JSONObject;
    } else {
      // Neither an array nor an object (null, a string, a number, a
      // boolean) — TaskPage.fromJSON needs a JSONObject to extract items
      // from; `.raw` below is what actually preserves it for diagnosis, not
      // this substitute.
      d = {};
    }
    // `.raw` is the full response envelope, not just `env.data` — an earlier
    // revision passed only the (possibly-substituted) `data` value through,
    // so a sibling top-level field (e.g. a trace id) sent alongside `data`
    // was silently discarded, and if the server's shape drifted entirely
    // (the task list moved to a differently-named top-level key instead of
    // `data`) the real payload was lost along with it — confirmed by
    // reproducing both `{data:null,traceId:"..."}` and
    // `{payload:{tasks:[...]},traceId:"..."}` against the earlier version.
    // Passing `env` itself means `.raw` always matches what TaskPage's own
    // doc comment already promised.
    return TaskPage.fromJSON(d, env);
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
    validateWaitOptions(pollIntervalMs, timeoutMs);
    const deadline = performance.now() + timeoutMs;
    let lastStatus: string | undefined;
    for (;;) {
      options.signal?.throwIfAborted();
      // `options.signal` passed straight through to retrieve() — without
      // this, an abort landing mid-retry (during a 429/503's Retry-After
      // sleep, or while a subsequent retry attempt's request is in flight)
      // wasn't observed until this call finally settled, since the
      // throwIfAborted() checks in this loop only run BETWEEN calls
      // (confirmed by reproducing an abort during a Retry-After sleep: two
      // more HTTP attempts happened before it was honoured).
      const task = await this.retrieve(taskId, options.signal);
      // Re-checked here, not just at the top of the loop: the signal could
      // have been aborted while the `await` above was in flight, and without
      // this the abort wouldn't be honoured until after onUpdate fires and a
      // terminal result (if any) is fully returned/thrown.
      options.signal?.throwIfAborted();
      if (options.onUpdate && task.status !== lastStatus) {
        lastStatus = task.status;
        // The polling `deadline` deliberately does NOT apply to a
        // *terminal* status's onUpdate call — only `signal` does. `timeoutMs`
        // bounds the POLLING loop's budget; `retrieve()` above already has
        // the real answer (success/fail) in hand once we're here, so a
        // merely-slow callback racing past the deadline must never turn an
        // already-finished task into a false PollTimeoutError (confirmed by
        // reproducing exactly that in an earlier revision). A prior revision
        // tried an "abandon at the deadline, but keep the poll's overall
        // timeoutMs as a ceiling anyway" middle ground for this — that
        // turned out to have no correct answer: giving up on WAITING for
        // onUpdate necessarily means *some* eventual outcome (a rejection,
        // in particular) has nowhere left to go once wait() has already
        // moved on, so any such "give up but stay safe" scheme either hangs
        // anyway or silently swallows a real callback failure — confirmed by
        // reproducing exactly the latter (a terminal onUpdate rejecting
        // right at an already-elapsed deadline was silently discarded,
        // `wait()` still resolving with the terminal task as if nothing had
        // gone wrong). Full completion is therefore always awaited: if you
        // need to bound a terminal onUpdate call specifically, pass `signal`
        // (e.g. from `AbortSignal.timeout(...)`) — the one mechanism that
        // can end the wait safely, without discarding anything.
        await raceOnUpdate(
          () => options.onUpdate!(task),
          options.signal,
          taskId,
          timeoutMs,
          task.isTerminal ? Infinity : deadline,
        );
        // Re-checked once more: onUpdate settling normally doesn't itself
        // prove the signal wasn't aborted in the same tick it resolved —
        // without this, an abort landing right as a terminal-status
        // onUpdate call finishes could still fall through to `return task`
        // below (confirmed by reproducing exactly that: an abort fired
        // during a "success" onUpdate still returned the stale success
        // result instead of the abort).
        options.signal?.throwIfAborted();
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
   *
   * `signal` is checked before `create()` is ever called and again right
   * after, and `pollIntervalMs`/`timeoutMs` are validated up front too —
   * `create()` has no signal awareness of its own (there is no in-flight
   * request to cancel; a `POST /tasks` is not safe to abandon mid-flight
   * since it may already have billed), so without all of this an
   * already-aborted `signal`, or a `wait()`-bound config mistake (e.g.
   * `pollIntervalMs: 0`), would still let the task get created before ever
   * discovering it can't actually be polled for. Once the task exists, every
   * other way `run()` can fail (an abort landing later, a network/API error
   * while polling, an `onUpdate` rejection) is wrapped in
   * {@link RunFailedError} so the `taskId` is never lost — except
   * `TaskFailedError` and `PollTimeoutError` **for this same task**, which
   * already carry it and are re-thrown unchanged. See {@link RunAbortedError}
   * for the immediate post-creation case.
   */
  async run(params: RunParams): Promise<Task> {
    params.signal?.throwIfAborted();
    validateWaitOptions(
      params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      params.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
    );
    const created = await this.create(params);
    if (params.signal?.aborted) {
      throw new RunAbortedError(created.taskId, { cause: params.signal.reason });
    }
    try {
      return await this.wait(created.taskId, {
        pollIntervalMs: params.pollIntervalMs,
        timeoutMs: params.timeoutMs,
        onUpdate: params.onUpdate,
        signal: params.signal,
      });
    } catch (err) {
      // Two checks, not just taskId matching: an `onUpdate` is arbitrary
      // caller code and could itself call into this SDK — including a
      // NESTED wait()/run() for the very same task, whose own
      // TaskFailedError/PollTimeoutError would then have a taskId that
      // matches `created.taskId` too, yet isn't actually about the outer
      // wait() loop this run() call owns (confirmed by reproducing exactly
      // that: a same-taskId PollTimeoutError thrown from inside onUpdate
      // otherwise passed straight through unwrapped). `CALLBACK_ORIGINATED`
      // — set only where raceOnUpdate observes onUpdate's own promise
      // rejecting, not for the outer loop's own errors — resolves that;
      // taskId matching alone was the round-9 fix and stays as a second,
      // belt-and-suspenders check.
      const fromCallback = err !== null && typeof err === "object" && CALLBACK_ORIGINATED.has(err);
      if (
        !fromCallback &&
        ((err instanceof TaskFailedError && err.task.taskId === created.taskId) ||
          (err instanceof PollTimeoutError && err.taskId === created.taskId))
      ) {
        throw err;
      }
      throw new RunFailedError(created.taskId, err);
    }
  }
}

/**
 * Validates `wait()`'s own options with no side effects, so `run()` can call
 * it *before* `create()` — a caller mistake here (or a bad dynamically-built
 * config) must not still create, and possibly bill, a task the SDK then
 * immediately discovers it cannot poll for.
 */
function validateWaitOptions(pollIntervalMs: number, timeoutMs: number): void {
  // Inverted comparisons (rather than `<= 0` / `< 0`) so a NaN value fails
  // the check too — a bare `NaN <= 0` is `false`, which would otherwise let
  // NaN slip through and turn wait()'s loop into a zero-delay busy poll.
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
  // `Number("Infinity") >= 0` and passes, but `deadline + timeoutMs` in
  // wait() uses `+`, which for a string operand does concatenation instead
  // of addition, producing a garbage value that later coerces to NaN and
  // reproduces the exact zero-delay busy-poll this function guards against
  // elsewhere. Confirmed by tracing the actual `+`/`-` coercion rules.
  if (typeof timeoutMs !== "number" || Number.isNaN(timeoutMs) || timeoutMs < 0) {
    throw new RangeError("timeoutMs must be a number >= 0");
  }
}

/**
 * Calls `onUpdate` and awaits its result, but loses the race to whichever
 * comes first: `signal` aborting, or `deadline` elapsing. A plain `await
 * onUpdate()` does neither — it doesn't listen for the signal at all, and
 * doesn't race the deadline either, so a hanging (never-settling) `onUpdate`
 * — or merely one slower than the remaining budget — blocked `wait()` past
 * both controls entirely (confirmed by reproducing exactly that: a
 * never-settling callback stayed pending well past both an already-elapsed
 * `timeoutMs` and a `signal` aborted during the call).
 *
 * Takes a THUNK (`() => onUpdate(task)`), not the already-called result —
 * `options.onUpdate(task)` evaluated as a plain argument runs BEFORE this
 * function's body ever does, so a synchronous throw (a caller re-raising an
 * SDK error, say) would escape entirely uncaught by anything in here,
 * bypassing both the deadline/signal race and the {@link CALLBACK_ORIGINATED}
 * marking below — confirmed by reproducing a synchronously-thrown, same-
 * taskId `PollTimeoutError` passing straight through unmarked. Calling the
 * thunk inside this function's own `try` normalizes a synchronous throw into
 * the same rejected-Promise path as an asynchronous one.
 */
function raceOnUpdate(
  callback: () => void | Promise<void>,
  signal: AbortSignal | undefined,
  taskId: string,
  timeoutMs: number,
  deadline: number,
): Promise<void> {
  let settledResult: Promise<void>;
  try {
    settledResult = Promise.resolve(callback());
  } catch (err) {
    settledResult = Promise.reject(err);
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
    const onAbort = () => {
      if (settled) return;
      cleanup();
      reject(signal!.reason ?? new DOMException("This operation was aborted", "AbortError"));
    };
    // The `settledResult.then()` handler below is attached UNCONDITIONALLY,
    // before any early return for an already-aborted signal — an earlier
    // revision returned `Promise.reject(...)` immediately for that case
    // without ever attaching a handler to `settledResult` (which, since the
    // caller's `onUpdate` already ran to produce it, could itself already be
    // a rejected Promise): that rejection then had no handler at all,
    // surfacing as a process-level `unhandledRejection` (confirmed: an
    // onUpdate that synchronously aborted `signal` and then returned a
    // rejected Promise produced exactly that, even though `wait()` itself
    // correctly threw `AbortError`).
    //
    // The abort listener is registered BEFORE arming the deadline timer
    // below, not after, for a separate reason: arming can synchronously
    // detect an already-elapsed deadline on its very first call and call
    // cleanup() immediately — cleanup() calls removeEventListener for a
    // listener that, had this ordering been reversed, wouldn't exist yet.
    // Execution would then fall through to registering the listener AFTER
    // settled was already true, leaking it forever (confirmed by
    // reproducing one `AbortController` reused across several
    // already-timed-out waits, each leaking one more listener on it).
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      cleanup();
      reject(signal.reason ?? new DOMException("This operation was aborted", "AbortError"));
    } else if (Number.isFinite(deadline)) {
      // A single `setTimeout` can't span more than Node's real (signed
      // 32-bit) timer limit (`MAX_TIMER_DELAY_MS`, ~24.85 days) — clamping
      // just the FIRST segment's duration and treating its firing as "the
      // deadline passed" would reject with PollTimeoutError up to ~24.85
      // days early for any `timeoutMs` beyond that (an explicitly supported
      // value — `wait()` allows `timeoutMs: Infinity`, and any long-running
      // `timeoutMs` in between): confirmed by tracing a 30-day `timeoutMs`
      // through an earlier single-`setTimeout` version. Re-arming against
      // the true remaining time on each firing — instead of one clamped
      // `setTimeout` — makes an arbitrarily long `timeoutMs` wait out its
      // full, correct duration.
      const armTimer = () => {
        const remainingMs = deadline - performance.now();
        if (remainingMs <= 0) {
          if (settled) return;
          cleanup();
          reject(new PollTimeoutError(taskId, timeoutMs));
          return;
        }
        timer = setTimeout(armTimer, Math.min(remainingMs, MAX_TIMER_DELAY_MS));
      };
      armTimer();
    }
    settledResult.then(
      (value) => {
        if (settled) return;
        cleanup();
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        cleanup();
        // Marked here specifically — not for the PollTimeoutError/
        // AbortError raceOnUpdate itself produces above for a genuine
        // deadline/signal reason — because this is precisely "onUpdate's
        // own promise rejected" (or, per the thunk change above, "onUpdate
        // threw synchronously"): the only place that distinction can be
        // made. run()'s catch needs it to tell an error that came from
        // INSIDE onUpdate (even an SDK error type with a matching taskId —
        // e.g. onUpdate does its own nested wait() for the very same task,
        // and that throws its own PollTimeoutError) apart from the outer
        // wait() loop's own TaskFailedError/PollTimeoutError, which taskId
        // matching alone can't distinguish (confirmed by reproducing a
        // same-taskId nested PollTimeoutError passing straight through
        // run() unwrapped).
        if (err !== null && typeof err === "object") {
          CALLBACK_ORIGINATED.add(err);
        }
        reject(err);
      },
    );
  });
}

/**
 * Marks an error/rejection value as having originated from inside an
 * `onUpdate` callback's own execution, so `run()`'s catch block can tell it
 * apart from an error the outer `wait()` loop's own control flow produced
 * directly — see the marking site in {@link raceOnUpdate} and the check in
 * {@link Tasks.run} for why `instanceof`/`taskId` matching alone can't make
 * that distinction. A `WeakSet` avoids retaining anything once the error
 * itself is no longer referenced elsewhere.
 */
const CALLBACK_ORIGINATED = new WeakSet<object>();

function data(env: JSONObject): JSONObject {
  const d = env.data;
  return typeof d === "object" && d !== null && !Array.isArray(d) ? (d as JSONObject) : {};
}
