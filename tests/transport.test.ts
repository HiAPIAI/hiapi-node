import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import {
  APIConnectionError,
  APIError,
  AuthenticationError,
  HiAPI,
  HiAPIError,
  IdempotencyKeyMismatchError,
  IdempotencyKeyProcessingError,
  InvalidRequestError,
  ModelUnavailableError,
  NotFoundError,
  ServiceUnavailableError,
  StorageUnavailableError,
  TaskFailedSyncError,
  TaskTimeoutError,
  VERSION,
} from "../src/index.js";
import type { FetchLike } from "../src/index.js";
import { normalizeBaseUrl, retryDelayMs } from "../src/transport.js";
import { jsonReply, MockServer, startMock } from "./_server.js";

let mock: MockServer;

before(async () => {
  mock = await startMock();
});
after(async () => {
  await mock.close();
});
beforeEach(() => {
  mock.reset(() => jsonReply({ data: {} }));
});

function client(overrides: Partial<ConstructorParameters<typeof HiAPI>[0]> = {}): HiAPI {
  return new HiAPI({
    apiKey: "sk-test",
    baseUrl: mock.url,
    timeoutMs: 5_000,
    maxRetries: 2,
    ...overrides,
  });
}

describe("request framing", () => {
  test("sends auth, accept and user-agent headers; content-type only with a body", async () => {
    mock.reset(() => jsonReply({ data: { taskId: "t1", model: "m", status: "queued" } }));
    await client().tasks.retrieve("t1");
    const get = mock.requests[0];
    assert.equal(get.headers.authorization, "Bearer sk-test");
    assert.equal(get.headers.accept, "application/json");
    assert.equal(get.headers["user-agent"], `hiapi-node/${VERSION}`);
    assert.equal(get.headers["content-type"], undefined);

    mock.reset(() => jsonReply({ data: { taskId: "t2" } }));
    await client().tasks.create({ model: "m", input: {} });
    const post = mock.requests[0];
    assert.equal(post.headers["content-type"], "application/json");
  });

  test("normalizes the base URL so /v1 is always present exactly once", async () => {
    for (const suffix of ["", "/", "/v1", "/v1/"]) {
      mock.reset(() => jsonReply({ data: { taskId: "t", model: "m", status: "queued" } }));
      await client({ baseUrl: mock.url + suffix }).tasks.retrieve("t");
      assert.equal(mock.requests[0].path, "/v1/tasks/t");
    }
  });

  test("normalizeBaseUrl handles bare and versioned forms", () => {
    assert.equal(normalizeBaseUrl("https://api.hiapi.ai"), "https://api.hiapi.ai/v1");
    assert.equal(normalizeBaseUrl("https://api.hiapi.ai/"), "https://api.hiapi.ai/v1");
    assert.equal(normalizeBaseUrl("https://api.hiapi.ai/v1"), "https://api.hiapi.ai/v1");
    assert.equal(normalizeBaseUrl("https://api.hiapi.ai/v1//"), "https://api.hiapi.ai/v1");
  });

  test("query params are encoded and undefined values dropped", async () => {
    await client().tasks.list({ page: 2, size: 5 });
    assert.equal(mock.requests[0].path, "/v1/tasks?page=2&size=5");
  });

  test("empty 2xx body decodes to an empty envelope without crashing, but retrieve() still rejects it", async () => {
    // decodeJson itself must not throw on an empty body (it's valid to
    // receive one, e.g. for future no-content responses) — but tasks.ts's
    // own taskId-match check (not transport-level) correctly still refuses
    // to hand back a Task that doesn't describe the task that was asked for.
    mock.reset(() => ({ status: 200, body: "" }));
    await assert.rejects(client().tasks.retrieve("t"), (err: unknown) => {
      assert.ok(err instanceof HiAPIError);
      assert.match(err.message, /does not match the requested/);
      return true;
    });
  });

  test("malformed 2xx JSON raises APIError, not a crash", async () => {
    mock.reset(() => ({ status: 200, body: "not json" }));
    await assert.rejects(client().tasks.retrieve("t"), (err: unknown) => {
      assert.ok(err instanceof APIError);
      assert.match(err.message, /could not decode/);
      return true;
    });

    mock.reset(() => ({ status: 200, body: "[1,2]" }));
    await assert.rejects(client().tasks.retrieve("t"), (err: unknown) => {
      assert.ok(err instanceof APIError);
      assert.match(err.message, /expected a JSON object/);
      return true;
    });
  });
});

describe("HTTP status retries (429/503)", () => {
  test("retries 429 with Retry-After and then succeeds", async () => {
    mock.reset((_req, index) =>
      index === 0
        ? jsonReply({ message: "slow down" }, 429, { "Retry-After": "0" })
        : jsonReply({ data: { taskId: "t-ok", model: "m", status: "queued" } }),
    );
    const task = await client().tasks.retrieve("t-ok");
    assert.equal(task.taskId, "t-ok");
    assert.equal(mock.requests.length, 2);
  });

  test("gives up after maxRetries and surfaces the API error", async () => {
    mock.reset(() => jsonReply({ message: "still limited" }, 429, { "Retry-After": "0" }));
    await assert.rejects(client().tasks.retrieve("t"), (err: unknown) => {
      assert.ok(err instanceof APIError);
      assert.equal(err.status, 429);
      return true;
    });
    assert.equal(mock.requests.length, 3); // initial + 2 retries
  });

  test("retries 503 the same way", async () => {
    mock.reset((_req, index) =>
      index === 0
        ? jsonReply({ message: "unavailable" }, 503, { "Retry-After": "0" })
        : jsonReply({ data: { taskId: "up", model: "m", status: "queued" } }),
    );
    const task = await client().tasks.retrieve("up");
    assert.equal(task.taskId, "up");
    assert.equal(mock.requests.length, 2);
  });

  test("maxRetries 0 disables retrying", async () => {
    mock.reset(() => jsonReply({ message: "unavailable" }, 503, { "Retry-After": "0" }));
    await assert.rejects(
      client({ maxRetries: 0 }).tasks.retrieve("t"),
      ServiceUnavailableError,
    );
    assert.equal(mock.requests.length, 1);
  });

  test("a keyless POST also retries on 429/503 (status-based retry is unconditional)", async () => {
    mock.reset((_req, index) =>
      index === 0
        ? jsonReply({ message: "slow down" }, 429, { "Retry-After": "0" })
        : jsonReply({ data: { taskId: "post-ok" } }),
    );
    const created = await client().tasks.create({ model: "m", input: {} });
    assert.equal(created.taskId, "post-ok");
    assert.equal(mock.requests.length, 2);
  });

  test("a keyless POST's known 429 still retries even when its own body read times out", async () => {
    // Headers (status 429, Retry-After) arrive and are captured — then the
    // BODY read itself hangs until the per-attempt timeout fires. That
    // timeout-caused failure must not be treated as an ordinary network
    // error: for a keyless POST, retryOnNetworkError is false, so falling
    // into that gate (an earlier revision did) meant an ALREADY-KNOWN,
    // always-retryable 429 went unretried, surfacing as an unretried
    // APIConnectionError instead of the correct retry-then-succeed.
    mock.reset(() => jsonReply({ data: { taskId: "post-ok" } }));
    let callCount = 0;
    const impl: FetchLike = async (input, init) => {
      callCount += 1;
      if (callCount === 1) {
        const signal = init?.signal;
        return {
          ok: false,
          status: 429,
          headers: new Headers({ "Retry-After": "0" }),
          text: () =>
            new Promise<string>((_, reject) => {
              const onAbort = () =>
                reject(signal!.reason ?? new DOMException("timed out", "TimeoutError"));
              if (signal?.aborted) {
                onAbort();
                return;
              }
              signal?.addEventListener("abort", onAbort, { once: true });
            }),
        } as unknown as Response;
      }
      return fetch(input, init);
    };
    const created = await client({ fetch: impl, timeoutMs: 30, maxRetries: 1 }).tasks.create({
      model: "m",
      input: {},
    });
    assert.equal(created.taskId, "post-ok");
    assert.equal(callCount, 2);
  });

  test("an exhausted known-429 retry surfaces a status-aware error, not a bare APIConnectionError", async () => {
    // When the known-status retry budget runs out (or the status isn't
    // retryable at all), an earlier revision fell all the way through to
    // the generic network-error gate and threw APIConnectionError — losing
    // the fact that the status was ALREADY definitively known, misrepresenting
    // a genuine "server rejected this before processing" 429/503 as an
    // ambiguous connection failure. Confirmed by reproducing exactly that
    // with two known-429 responses (maxRetries: 0, so no retry budget at
    // all) — the fix surfaces the real, status-mapped error instead.
    const impl: FetchLike = async (_input, init) => {
      const signal = init?.signal;
      return {
        ok: false,
        status: 429,
        headers: new Headers({ "Retry-After": "0" }),
        text: () =>
          new Promise<string>((_, reject) => {
            const onAbort = () =>
              reject(signal!.reason ?? new DOMException("timed out", "TimeoutError"));
            if (signal?.aborted) {
              onAbort();
              return;
            }
            signal?.addEventListener("abort", onAbort, { once: true });
          }),
      } as unknown as Response;
    };
    await assert.rejects(
      client({ fetch: impl, timeoutMs: 10, maxRetries: 0 }).tasks.create({ model: "m", input: {} }),
      (err: unknown) => {
        assert.ok(err instanceof APIError);
        assert.equal((err as APIError).status, 429);
        return true;
      },
    );
  });

  test("an HTTP-date Retry-After on a real 429 is honoured through the full retry loop", async () => {
    // toUTCString() truncates to whole seconds, so a target under ~1s out can
    // round down to "now" or even the past. 1800ms guarantees a real wait
    // (>=~800ms after worst-case truncation) without slowing the suite much.
    const future = new Date(Date.now() + 1_800).toUTCString();
    mock.reset((_req, index) =>
      index === 0
        ? jsonReply({ message: "slow down" }, 429, { "Retry-After": future })
        : jsonReply({ data: { taskId: "t-date", model: "m", status: "queued" } }),
    );
    const started = performance.now();
    const task = await client().tasks.retrieve("t-date");
    assert.equal(task.taskId, "t-date");
    assert.equal(mock.requests.length, 2);
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 700, `should have waited close to the Retry-After delay, got ${elapsed}ms`);
  });
});

describe("abort during retry", () => {
  // wait()'s own throwIfAborted() checks only run BETWEEN retrieve() calls —
  // without threading `signal` all the way into the transport, an abort
  // landing during a 429/503's Retry-After sleep, or while a subsequent
  // retry attempt's request was already in flight, went unnoticed until that
  // whole retrieve() call finally settled (confirmed by reproducing an abort
  // during a Retry-After sleep: two more HTTP attempts happened before it
  // was ever honoured).
  test("an abort during a 429's Retry-After sleep is honoured immediately — no further retry attempts", async () => {
    mock.reset(() => jsonReply({ message: "slow down" }, 429, { "Retry-After": "5" }));
    const controller = new AbortController();
    const started = performance.now();
    const waiting = client().tasks.wait("w1", { pollIntervalMs: 60_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(waiting, (err: unknown) => {
      assert.equal((err as Error).name, "AbortError");
      return true;
    });
    // The mocked Retry-After is 5s; if the abort weren't honoured until the
    // sleep finished naturally, this would take >=5000ms.
    assert.ok(performance.now() - started < 2_000);
    assert.equal(mock.requests.length, 1);
  });

  test("an abort during a network-error retry's backoff sleep is honoured immediately", async () => {
    const flaky: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    const controller = new AbortController();
    const started = performance.now();
    const waiting = client({ fetch: flaky }).tasks.wait("w1", {
      pollIntervalMs: 60_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(waiting, (err: unknown) => {
      assert.equal((err as Error).name, "AbortError");
      return true;
    });
    assert.ok(performance.now() - started < 5_000);
  });

  test("an abort during a non-2xx response body read surfaces as AbortError, not a wrongly-mapped status error", async () => {
    // An earlier revision's body-read helper (since removed — the catch
    // block below now handles every body-read failure uniformly, whatever
    // its cause) swallowed EVERY resp.text() failure, including one caused
    // by the request's own signal aborting mid-read — the caller-abort
    // check in the surrounding catch block never got a chance to run, since
    // the body-read failure never reached it. Confirmed by reproducing an
    // abort landing while a 404's body was still pending: the SDK produced
    // NotFoundError instead of AbortError, even though `signal.aborted` was
    // already true by the time status mapping ran. A hand-written fetch
    // stub simulates a real "headers arrived, body still pending" response
    // — the shared mock HTTP server can't hold a body open independently of
    // its headers.
    const controller = new AbortController();
    const impl: FetchLike = async (_input, init) => {
      const signal = init?.signal;
      return {
        ok: false,
        status: 404,
        headers: new Headers(),
        text: () =>
          new Promise<string>((_, reject) => {
            const onAbort = () =>
              reject(signal!.reason ?? new DOMException("This operation was aborted", "AbortError"));
            if (signal?.aborted) {
              onAbort();
              return;
            }
            signal?.addEventListener("abort", onAbort, { once: true });
          }),
      } as unknown as Response;
    };
    const waiting = client({ fetch: impl, maxRetries: 0 }).tasks.retrieve("t", controller.signal);
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(waiting, (err: unknown) => {
      assert.equal((err as Error).name, "AbortError");
      return true;
    });
  });

  test("a genuine per-request timeout still surfaces as APIConnectionError, not an AbortError, when signal is also present but not aborted", async () => {
    // Combining `opts.signal` with the per-attempt AbortSignal.timeout() via
    // AbortSignal.any() must not blur which one actually fired — a timeout
    // with signal present-but-never-aborted should behave identically to no
    // signal at all. Uses the real mock HTTP server (a genuine, unmocked
    // `fetch`, which — unlike a hand-written stub — actually honours
    // whatever AbortSignal it's given) with a handler that never responds,
    // so the per-attempt client-side timeout is what actually fires here.
    mock.reset(() => new Promise(() => {}));
    await assert.rejects(
      client({ timeoutMs: 30, maxRetries: 0 }).tasks.wait("w1", {
        pollIntervalMs: 60_000,
        signal: new AbortController().signal,
      }),
      APIConnectionError,
    );
  });

  test("a timeout that genuinely fired FIRST is still correctly classified even if the caller's signal also aborts before the fetch's rejection surfaces", async () => {
    // createAttemptSignal records which source won atomically, at the exact
    // moment each one fires — not re-derived later from a fresh
    // `callerSignal.aborted` check. That check can't tell "the timeout
    // genuinely fired first, and the caller's abort call — a no-op, since
    // AbortController.abort() on an already-aborted controller doesn't
    // change anything — merely happened to land afterward" apart from "the
    // caller's abort is what actually caused this failure": confirmed by
    // reproducing exactly the former with a custom fetch that delays its
    // rejection after the signal fires, letting a caller abort call land in
    // between — an earlier revision let the later caller reason win,
    // incorrectly skipping a retry the genuine timeout was eligible for.
    const controller = new AbortController();
    const impl: FetchLike = (_input, init) => {
      const signal = init?.signal;
      return new Promise((_, reject) => {
        signal?.addEventListener("abort", () => {
          // The caller's own abort call, landing in the same tick as the
          // timeout's "abort" event — but the timeout already won.
          controller.abort(new Error("caller abort — must NOT win"));
          setTimeout(() => reject(new TypeError("fetch failed")), 20);
        });
      });
    };
    await assert.rejects(
      client({ fetch: impl, timeoutMs: 10, maxRetries: 0 }).tasks.retrieve("t", controller.signal),
      (err: unknown) => {
        assert.ok(err instanceof APIConnectionError);
        return true;
      },
    );
  });

  test("many requests sharing one long-lived AbortSignal don't accumulate retained memory", async (t) => {
    // Regression for a real leak: an earlier revision composed each
    // attempt's signal via AbortSignal.any([callerSignal,
    // AbortSignal.timeout(...)]) — a composition with no way to be torn
    // down early, so recreating it on every attempt against the SAME
    // long-lived caller signal (exactly what a long wait() poll loop does)
    // accumulated one live listener/composite-signal object per attempt. A
    // targeted micro-benchmark showed ~213MB retained for 100k such
    // compositions against one shared signal, vs. ~80MB for
    // AbortSignal.timeout() alone — confirmed via `node --expose-gc`.
    if (typeof global.gc !== "function") {
      t.skip("requires --expose-gc (set in this package's own `npm test` script)");
      return;
    }
    mock.reset(() => jsonReply({ data: { taskId: "t", model: "m", status: "queued" } }));
    const controller = new AbortController();
    const c = client();
    const N = 15_000;
    global.gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < N; i++) {
      await c.tasks.retrieve("t", controller.signal);
    }
    global.gc();
    const after = process.memoryUsage().heapUsed;
    const deltaMB = (after - before) / 1024 / 1024;
    // Calibrated against the actual pre-fix code, not guessed: reverting to
    // the AbortSignal.any()-based composition retains ~29MB at this same
    // N=15,000 (~2KB/call) — this 15MB ceiling sits well below that real
    // regression while comfortably tolerating ordinary heap noise between
    // two single GC snapshots (the fixed version retains next to nothing).
    assert.ok(deltaMB < 15, `retained ${deltaMB.toFixed(1)}MB across ${N} calls sharing one signal`);
  });
});

describe("retryDelayMs", () => {
  test("numeric Retry-After in seconds, clamped to [0, 60s]", () => {
    assert.equal(retryDelayMs(0, new Headers({ "retry-after": "2" })), 2_000);
    assert.equal(retryDelayMs(0, new Headers({ "retry-after": "120" })), 60_000);
    assert.equal(retryDelayMs(0, new Headers({ "retry-after": "-5" })), 0);
    assert.equal(retryDelayMs(0, new Headers({ "retry-after": "0" })), 0);
  });

  test("HTTP-date Retry-After is honoured and clamped", () => {
    const future = new Date(Date.now() + 30_000).toUTCString();
    const delay = retryDelayMs(0, new Headers({ "retry-after": future }));
    assert.ok(delay > 25_000 && delay <= 30_500, `got ${delay}`);

    const past = new Date(Date.now() - 30_000).toUTCString();
    assert.equal(retryDelayMs(0, new Headers({ "retry-after": past })), 0);

    const farFuture = new Date(Date.now() + 300_000).toUTCString();
    assert.equal(retryDelayMs(0, new Headers({ "retry-after": farFuture })), 60_000);
  });

  test("garbage or missing Retry-After falls back to capped exponential backoff", () => {
    assert.equal(retryDelayMs(0, new Headers({ "retry-after": "soon" })), 500);
    assert.equal(retryDelayMs(0, null), 500);
    assert.equal(retryDelayMs(1, null), 1_000);
    assert.equal(retryDelayMs(4, null), 8_000);
    assert.equal(retryDelayMs(10, null), 8_000);
  });
});

describe("network-error retry gates", () => {
  function flakyFetch(failures: number): { impl: FetchLike; calls: () => number } {
    let count = 0;
    const impl: FetchLike = async (input, init) => {
      count += 1;
      if (count <= failures) {
        throw new TypeError("fetch failed");
      }
      return fetch(input, init);
    };
    return { impl, calls: () => count };
  }

  test("GET is retried after a network error", async () => {
    mock.reset(() => jsonReply({ data: { taskId: "t", model: "m", status: "queued" } }));
    const flaky = flakyFetch(1);
    const task = await client({ fetch: flaky.impl }).tasks.retrieve("t");
    assert.equal(task.taskId, "t");
    assert.equal(flaky.calls(), 2);
  });

  test("POST without an idempotency key is NOT retried", async () => {
    const flaky = flakyFetch(1);
    await assert.rejects(
      client({ fetch: flaky.impl }).tasks.create({ model: "m", input: {} }),
      APIConnectionError,
    );
    assert.equal(flaky.calls(), 1);
  });

  test("POST with an idempotency key IS retried", async () => {
    mock.reset(() => jsonReply({ data: { taskId: "t-idem" } }));
    const flaky = flakyFetch(1);
    const created = await client({ fetch: flaky.impl }).tasks.create({
      model: "m",
      input: {},
      idempotencyKey: "key-1",
    });
    assert.equal(created.taskId, "t-idem");
    assert.equal(flaky.calls(), 2);
  });

  test("persistent network failure surfaces APIConnectionError after maxRetries", async () => {
    const flaky = flakyFetch(10);
    await assert.rejects(
      client({ fetch: flaky.impl }).tasks.retrieve("t"),
      APIConnectionError,
    );
    assert.equal(flaky.calls(), 3); // initial + 2 retries
  });

  test("APIConnectionError preserves the original error as .cause", async () => {
    const original = new TypeError("fetch failed");
    const impl: FetchLike = async () => {
      throw original;
    };
    await assert.rejects(
      client({ fetch: impl, maxRetries: 0 }).tasks.retrieve("t"),
      (err: unknown) => {
        assert.ok(err instanceof APIConnectionError);
        assert.equal(err.cause, original);
        return true;
      },
    );
  });

  test("a custom fetch rejecting with a throwing-toString() reason still surfaces as APIConnectionError, not a secondary error", async () => {
    // `fetch` is a documented, user-replaceable option — a custom
    // implementation can reject with anything, including a non-Error object
    // with a throwing toString(). describeError() used to call String(err)
    // unguarded for exactly this case, making the transport itself throw a
    // completely different, unrelated error instead of APIConnectionError,
    // discarding the real cause.
    const throwingReason = {
      toString() {
        throw new Error("toString boom");
      },
    };
    const impl: FetchLike = async () => {
      throw throwingReason;
    };
    await assert.rejects(
      client({ fetch: impl, maxRetries: 0 }).tasks.retrieve("t"),
      (err: unknown) => {
        assert.ok(err instanceof APIConnectionError);
        assert.equal(err.cause, throwingReason);
        return true;
      },
    );
  });
});

describe("idempotencyKey validation", () => {
  // Fetch header values are ByteString (Latin-1 only): a character above
  // U+00FF makes the real `fetch` throw a raw TypeError from inside the
  // network-error catch block — confirmed via `node -e` — misreporting a
  // pure client-side validation problem as APIConnectionError, and (for a
  // GET-adjacent idempotent method, or with the key already attached) even
  // retrying it pointlessly, since the same key fails identically every
  // attempt. Rejected synchronously up front instead.
  test("a non-ASCII idempotencyKey is rejected before any request is sent, not miscategorized as a network error", async () => {
    await assert.rejects(
      client().tasks.create({ model: "m", input: {}, idempotencyKey: "订单-8472" }),
      RangeError,
    );
    assert.equal(mock.requests.length, 0);
  });

  test("an idempotencyKey over 255 characters is rejected the same way", async () => {
    await assert.rejects(
      client().tasks.create({ model: "m", input: {}, idempotencyKey: "a".repeat(256) }),
      RangeError,
    );
    assert.equal(mock.requests.length, 0);
  });

  test("a plain printable-ASCII idempotencyKey at the 255-char boundary is accepted", async () => {
    mock.reset(() => jsonReply({ data: { taskId: "t" } }));
    const key = "a".repeat(255);
    await client().tasks.create({ model: "m", input: {}, idempotencyKey: key });
    assert.equal(mock.requests[0].headers["idempotency-key"], key);
  });

  test("NBSP doesn't bypass ASCII validation the way String.prototype.trim() would let it", async () => {
    // `String.prototype.trim()` strips a much wider Unicode whitespace set
    // than HTTP's own OWS (RFC 7230: SP/HTAB only) — including NBSP,
    // U+00A0 — confirmed via `node -e` that `" ".trim() === ""` and
    // `" abc ".trim() === "abc"`. An earlier revision validated
    // the *trimmed* value, so an NBSP-only key silently became "no key",
    // and an NBSP-padded key was silently rewritten to a shorter, different
    // ASCII key than the one actually passed in.
    await assert.rejects(
      client().tasks.create({ model: "m", input: {}, idempotencyKey: " " }),
      RangeError,
    );
    assert.equal(mock.requests.length, 0);

    await assert.rejects(
      client().tasks.create({ model: "m", input: {}, idempotencyKey: " abc " }),
      RangeError,
    );
    assert.equal(mock.requests.length, 0);
  });
});

describe("409 IDEMPOTENCY_KEY_PROCESSING", () => {
  test("is retried automatically when the request carries a key", async () => {
    mock.reset((_req, index) =>
      index === 0
        ? jsonReply(
            { error_code: "IDEMPOTENCY_KEY_PROCESSING", message: "in flight" },
            409,
            { "Retry-After": "0" },
          )
        : jsonReply({ data: { taskId: "first" } }, 200, { "Idempotent-Replay": "true" }),
    );
    const created = await client().tasks.create({
      model: "m",
      input: {},
      idempotencyKey: "key-2",
    });
    assert.equal(created.taskId, "first");
    assert.equal(created.idempotentReplay, true);
    assert.equal(mock.requests.length, 2);
  });

  test("surfaces immediately without a key", async () => {
    mock.reset(() =>
      jsonReply({ error_code: "IDEMPOTENCY_KEY_PROCESSING", message: "in flight" }, 409),
    );
    await assert.rejects(
      client().tasks.create({ model: "m", input: {} }),
      IdempotencyKeyProcessingError,
    );
    assert.equal(mock.requests.length, 1);
  });

  test("surfaces after maxRetries even with a key", async () => {
    mock.reset(() =>
      jsonReply({ error_code: "IDEMPOTENCY_KEY_PROCESSING", message: "in flight" }, 409, {
        "Retry-After": "0",
      }),
    );
    await assert.rejects(
      client().tasks.create({ model: "m", input: {}, idempotencyKey: "key-3" }),
      IdempotencyKeyProcessingError,
    );
    assert.equal(mock.requests.length, 3);
  });

  test("a 409 whose body read fails for a non-abort reason still retries with a key, honouring the already-captured Retry-After", async () => {
    // The body-read helper this SDK used to have swallowed EVERY resp.text()
    // failure not caused by an abort into an empty string, so
    // errorFromResponse() could never discover error_code:
    // IDEMPOTENCY_KEY_PROCESSING from it — an idempotency-keyed create()
    // whose 409 body happened to fail reading (for a reason unrelated to
    // any signal — a genuine stream error) surfaced a generic, uninformative
    // 409 error instead of taking the safe replay path an otherwise-
    // identical request with a READABLE body would have. The 1s
    // Retry-After also verifies the retry uses the header already captured
    // from this exact response, not a fallback that ignores it — the
    // timing is the only way to tell those two apart.
    let callCount = 0;
    const impl: FetchLike = async (input, init) => {
      callCount += 1;
      if (callCount === 1) {
        return {
          ok: false,
          status: 409,
          headers: new Headers({ "Retry-After": "1" }),
          text: () => Promise.reject(new Error("stream reset")),
        } as unknown as Response;
      }
      return fetch(input, init);
    };
    mock.reset(() => jsonReply({ data: { taskId: "first" } }, 200, { "Idempotent-Replay": "true" }));
    const started = performance.now();
    const created = await client({ fetch: impl }).tasks.create({
      model: "m",
      input: {},
      idempotencyKey: "key-unreadable-409",
    });
    assert.equal(created.taskId, "first");
    assert.equal(created.idempotentReplay, true);
    assert.equal(callCount, 2);
    const elapsed = performance.now() - started;
    // The exponential-backoff fallback (used if Retry-After were ignored)
    // starts at 500ms — comfortably distinguishable from the ~1000ms this
    // Retry-After should have produced.
    assert.ok(elapsed >= 800, `should have waited close to the Retry-After delay, got ${elapsed}ms`);
  });

  test("an exhausted, unreadable 409 still surfaces IdempotencyKeyProcessingError (not a generic APIError), with the read failure as cause", async () => {
    // errorFromResponse()'s error_code-then-STATUS_TO_CLASS guessing has no
    // error_code to read here (the body itself is what's missing) — routing
    // an unreadable, exhausted-retries 409 through it anyway downgraded a
    // definite, contractually-unambiguous (this endpoint's 409 is ALWAYS
    // IDEMPOTENCY_KEY_PROCESSING) error into an uninformative plain
    // APIError, discarding both the specific class and the original read
    // failure a caller might want for diagnostics.
    const readFailure = new Error("stream reset");
    const impl: FetchLike = async () => ({
      ok: false,
      status: 409,
      headers: new Headers({ "Retry-After": "0" }),
      text: () => Promise.reject(readFailure),
    } as unknown as Response);
    await assert.rejects(
      client({ fetch: impl, maxRetries: 0 }).tasks.create({
        model: "m",
        input: {},
        idempotencyKey: "key-unreadable-409-exhausted",
      }),
      (err: unknown) => {
        assert.ok(err instanceof IdempotencyKeyProcessingError);
        assert.equal(err.status, 409);
        assert.equal(err.cause, readFailure);
        return true;
      },
    );
  });

  test("an unreadable 422 with a key surfaces IdempotencyKeyMismatchError, with the read failure as cause", async () => {
    const readFailure = new Error("stream reset");
    const impl: FetchLike = async () => ({
      ok: false,
      status: 422,
      headers: new Headers(),
      text: () => Promise.reject(readFailure),
    } as unknown as Response);
    await assert.rejects(
      client({ fetch: impl, maxRetries: 0 }).tasks.create({
        model: "m",
        input: {},
        idempotencyKey: "key-unreadable-422",
      }),
      (err: unknown) => {
        assert.ok(err instanceof IdempotencyKeyMismatchError);
        assert.equal(err.status, 422);
        assert.equal(err.cause, readFailure);
        return true;
      },
    );
  });

  test("a keyed 409 whose body reads successfully but empty still retries as IDEMPOTENCY_KEY_PROCESSING", async () => {
    // errorForUnreadableBody only covers resp.text() itself THROWING. A
    // proxy/gateway stripping the real JSON body (or the body genuinely
    // being empty) reaches errorFromResponse() successfully, but with no
    // error_code to parse — falling through to a plain, unretried APIError
    // the same way, for the same underlying reason. Confirmed by
    // reproducing exactly that: an empty-body 409 on a keyed request was
    // previously requested only once and thrown as plain APIError, even
    // though the second attempt would have succeeded via the replay path.
    let callCount = 0;
    const impl: FetchLike = async (input, init) => {
      callCount += 1;
      if (callCount === 1) {
        return {
          ok: false,
          status: 409,
          headers: new Headers({ "Retry-After": "0" }),
          text: () => Promise.resolve(""),
        } as unknown as Response;
      }
      return fetch(input, init);
    };
    mock.reset(() => jsonReply({ data: { taskId: "first" } }, 200, { "Idempotent-Replay": "true" }));
    const created = await client({ fetch: impl, maxRetries: 1 }).tasks.create({
      model: "m",
      input: {},
      idempotencyKey: "key-empty-409-body",
    });
    assert.equal(created.taskId, "first");
    assert.equal(created.idempotentReplay, true);
    assert.equal(callCount, 2);
  });

  test("a keyed 422 whose body reads successfully but empty still surfaces IdempotencyKeyMismatchError", async () => {
    const impl: FetchLike = async () =>
      ({
        ok: false,
        status: 422,
        headers: new Headers(),
        text: () => Promise.resolve(""),
      }) as unknown as Response;
    await assert.rejects(
      client({ fetch: impl, maxRetries: 0 }).tasks.create({
        model: "m",
        input: {},
        idempotencyKey: "key-empty-422-body",
      }),
      (err: unknown) => {
        assert.ok(err instanceof IdempotencyKeyMismatchError);
        assert.equal(err.status, 422);
        return true;
      },
    );
  });

  test("a keyed 409 whose body DOES parse with a different, explicit error_code is trusted as-is, not overridden", async () => {
    // The fix above only kicks in when errorCode is genuinely absent — an
    // explicit, different error_code the body actually carries must not be
    // silently replaced with an assumed IDEMPOTENCY_KEY_PROCESSING.
    mock.reset(() => jsonReply({ error_code: "INVALID_REQUEST", message: "nope" }, 409));
    await assert.rejects(
      client({ maxRetries: 0 }).tasks.create({
        model: "m",
        input: {},
        idempotencyKey: "key-conflicting-code",
      }),
      (err: unknown) => {
        assert.ok(err instanceof InvalidRequestError);
        assert.equal((err as APIError).errorCode, "INVALID_REQUEST");
        return true;
      },
    );
  });

  test("a keyed 409 with an empty or whitespace-only error_code still retries as IDEMPOTENCY_KEY_PROCESSING", async () => {
    // An earlier revision of this exact fix checked `err.errorCode ===
    // undefined` — but a body that parses fine with `error_code: ""` (or a
    // whitespace-only string) sets errorCode to that empty/blank string,
    // not undefined, so the strict check missed it. Confirmed by
    // reproducing a keyed 409 with error_code: "" surfacing as an
    // unretried, plain APIError.
    for (const errorCode of ["", "   "]) {
      let callCount = 0;
      const impl: FetchLike = async (input, init) => {
        callCount += 1;
        if (callCount === 1) {
          return {
            ok: false,
            status: 409,
            headers: new Headers({ "Retry-After": "0" }),
            text: () => Promise.resolve(JSON.stringify({ error_code: errorCode, message: "in flight" })),
          } as unknown as Response;
        }
        return fetch(input, init);
      };
      mock.reset(() => jsonReply({ data: { taskId: "first" } }, 200, { "Idempotent-Replay": "true" }));
      const created = await client({ fetch: impl, maxRetries: 1 }).tasks.create({
        model: "m",
        input: {},
        idempotencyKey: `key-blank-code-${JSON.stringify(errorCode)}`,
      });
      assert.equal(created.taskId, "first", `errorCode=${JSON.stringify(errorCode)}`);
      assert.equal(callCount, 2, `errorCode=${JSON.stringify(errorCode)}`);
    }
  });

  test("a keyed 422 with an empty or whitespace-only error_code still surfaces IdempotencyKeyMismatchError", async () => {
    for (const errorCode of ["", "   "]) {
      const impl: FetchLike = async () =>
        ({
          ok: false,
          status: 422,
          headers: new Headers(),
          text: () => Promise.resolve(JSON.stringify({ error_code: errorCode, message: "mismatch" })),
        }) as unknown as Response;
      await assert.rejects(
        client({ fetch: impl, maxRetries: 0 }).tasks.create({
          model: "m",
          input: {},
          idempotencyKey: `key-blank-code-422-${JSON.stringify(errorCode)}`,
        }),
        (err: unknown) => {
          assert.ok(err instanceof IdempotencyKeyMismatchError, `errorCode=${JSON.stringify(errorCode)}`);
          return true;
        },
      );
    }
  });

  test("an unreadable, ambiguous status (e.g. 400) never guesses a specific subclass — plain APIError, cause preserved", async () => {
    // A single status can carry SEVERAL distinct business meanings (400 is
    // both INVALID_REQUEST and MODEL_UNAVAILABLE) — with no error_code to
    // read (the body is what's missing), guessing via STATUS_TO_CLASS would
    // often be WRONG. Confirmed by reproducing an unreadable 400 that was
    // actually MODEL_UNAVAILABLE surfacing as InvalidRequestError instead —
    // the honest answer when the body can't be read is a plain APIError.
    const readFailure = new Error("stream reset");
    const impl: FetchLike = async () => ({
      ok: false,
      status: 400,
      headers: new Headers(),
      text: () => Promise.reject(readFailure),
    } as unknown as Response);
    await assert.rejects(
      client({ fetch: impl, maxRetries: 0 }).tasks.retrieve("t"),
      (err: unknown) => {
        // Precisely APIError, not any subclass (InvalidRequestError included).
        assert.equal(Object.getPrototypeOf(err), APIError.prototype);
        assert.equal((err as APIError).status, 400);
        assert.equal((err as APIError).cause, readFailure);
        return true;
      },
    );
  });
});

describe("error mapping", () => {
  const codeCases: Array<[string, unknown]> = [
    ["INVALID_REQUEST", InvalidRequestError],
    ["MODEL_UNAVAILABLE", ModelUnavailableError],
    ["TASK_FAILED", TaskFailedSyncError],
    ["TASK_TIMEOUT", TaskTimeoutError],
    ["STORAGE_UNAVAILABLE", StorageUnavailableError],
    ["IDEMPOTENCY_KEY_MISMATCH", IdempotencyKeyMismatchError],
  ];
  for (const [code, cls] of codeCases) {
    test(`error_code=${code} maps to its dedicated class`, async () => {
      mock.reset(() => jsonReply({ error_code: code, message: "nope" }, 400));
      await assert.rejects(
        client({ maxRetries: 0 }).tasks.retrieve("t"),
        (err: unknown) => {
          assert.ok(err instanceof (cls as new (...args: never[]) => APIError));
          const apiErr = err as APIError;
          assert.equal(apiErr.errorCode, code);
          assert.equal(apiErr.status, 400);
          assert.equal(apiErr.message, "nope");
          return true;
        },
      );
    });
  }

  test("status fallback when no error_code is present", async () => {
    const statusCases: Array<[number, unknown]> = [
      [400, InvalidRequestError],
      [401, AuthenticationError],
      [404, NotFoundError],
      [503, ServiceUnavailableError],
    ];
    for (const [status, cls] of statusCases) {
      mock.reset(() => jsonReply({ message: `err ${status}` }, status));
      await assert.rejects(
        client({ maxRetries: 0 }).tasks.retrieve("t"),
        cls as new (...args: never[]) => Error,
      );
    }
  });

  test("unknown status without error_code falls back to plain APIError", async () => {
    mock.reset(() => ({ status: 418, body: "short and stout" }));
    await assert.rejects(client().tasks.retrieve("t"), (err: unknown) => {
      assert.ok(err instanceof APIError);
      assert.equal((err as APIError).status, 418);
      assert.equal((err as APIError).message, "HTTP 418");
      assert.equal((err as APIError).body, "short and stout");
      return true;
    });
  });

  test("a recognized error_code wins over the status fallback", async () => {
    mock.reset(() => jsonReply({ error_code: "MODEL_UNAVAILABLE", message: "gone" }, 404));
    await assert.rejects(client().tasks.retrieve("t"), ModelUnavailableError);
  });
});

describe("mock server error handling (test infra self-check)", () => {
  // Regression test for _server.ts's try/catch + .catch() fix: a handler
  // that throws (sync) or rejects (async) used to leave the connection open
  // with no response, turning a test assertion thrown inside a handler into
  // a confusing timeout instead of a clear failure. Both paths must now
  // surface promptly as a connection error the client can see.
  test("a handler that throws synchronously does not hang the connection", async () => {
    mock.reset(() => {
      throw new Error("boom-sync");
    });
    await assert.rejects(client({ maxRetries: 0 }).tasks.retrieve("t"), APIConnectionError);
  });

  test("a handler that returns a rejected promise does not hang the connection", async () => {
    mock.reset(async () => {
      throw new Error("boom-async");
    });
    await assert.rejects(client({ maxRetries: 0 }).tasks.retrieve("t"), APIConnectionError);
  });

  test("start() rejects clearly when listen() fails, instead of hanging forever", async () => {
    // An earlier revision only ever wired listen()'s success callback — a
    // real failure (EADDRINUSE, EPERM in a restricted sandbox, etc.) left
    // the returned promise permanently pending, turning a genuine startup
    // error into a confusing hang indistinguishable from an unrelated
    // timeout. Binding a second server to an already-bound port reliably
    // reproduces a real listen() failure (EADDRINUSE).
    const busy = await new MockServer().start();
    try {
      await assert.rejects(new MockServer().start(busy.port));
    } finally {
      await busy.close();
    }
  });
});
