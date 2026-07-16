import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import {
  HiAPI,
  HiAPIError,
  PollTimeoutError,
  RunAbortedError,
  TaskFailedError,
} from "../src/index.js";
import { jsonReply, startMock, type MockServer } from "./_server.js";

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

function client(): HiAPI {
  return new HiAPI({ apiKey: "sk-test", baseUrl: mock.url, timeoutMs: 5_000, maxRetries: 0 });
}

describe("tasks.create", () => {
  test("sends exactly {model, input} when route/callback are omitted", async () => {
    mock.reset(() => jsonReply({ data: { taskId: "t1" } }));
    const created = await client().tasks.create({ model: "m", input: { prompt: "hi" } });
    assert.equal(created.taskId, "t1");
    assert.equal(created.idempotentReplay, false);
    assert.deepEqual(JSON.parse(mock.requests[0].body), { model: "m", input: { prompt: "hi" } });
    assert.equal(mock.requests[0].headers["idempotency-key"], undefined);
  });

  test("rejects an anomalous 2xx response with no (or whitespace-only) taskId", async () => {
    mock.reset(() => jsonReply({ data: {} }));
    await assert.rejects(
      client().tasks.create({ model: "m", input: {} }),
      (err: unknown) => {
        assert.ok(err instanceof HiAPIError);
        assert.match(err.message, /did not include a taskId/);
        return true;
      },
    );

    // Truthy but meaningless: a bare truthiness check on taskId wouldn't
    // catch this, and it would go on to poll `/tasks/%20%20%20`.
    mock.reset(() => jsonReply({ data: { taskId: "   " } }));
    await assert.rejects(client().tasks.create({ model: "m", input: {} }), HiAPIError);
  });

  test("route: '' is omitted like the other SDKs ('' ≡ absent ≡ default)", async () => {
    mock.reset(() => jsonReply({ data: { taskId: "t" } }));
    await client().tasks.create({ model: "m", input: {}, route: "" });
    assert.deepEqual(Object.keys(JSON.parse(mock.requests[0].body)), ["model", "input"]);
  });

  test("route and callback are forwarded when set", async () => {
    mock.reset(() => jsonReply({ data: { taskId: "t" } }));
    await client().tasks.create({
      model: "m",
      input: { a: 1 },
      route: "ext",
      callback: { url: "https://example.com/cb", when: "final" },
    });
    assert.deepEqual(JSON.parse(mock.requests[0].body), {
      model: "m",
      input: { a: 1 },
      route: "ext",
      callback: { url: "https://example.com/cb", when: "final" },
    });
  });

  test("storage is forwarded when set, omitted otherwise", async () => {
    mock.reset(() => jsonReply({ data: { taskId: "t" } }));
    await client().tasks.create({ model: "m", input: {}, storage: "persistent" });
    assert.equal(JSON.parse(mock.requests[0].body).storage, "persistent");

    mock.reset(() => jsonReply({ data: { taskId: "t" } }));
    await client().tasks.create({ model: "m", input: {} });
    assert.equal(Object.hasOwn(JSON.parse(mock.requests[0].body), "storage"), false);
  });

  test("idempotencyKey is sent as the Idempotency-Key header", async () => {
    mock.reset(() => jsonReply({ data: { taskId: "t" } }));
    await client().tasks.create({ model: "m", input: {}, idempotencyKey: "abc-123" });
    assert.equal(mock.requests[0].headers["idempotency-key"], "abc-123");
  });

  test("a whitespace-only idempotencyKey is treated as absent, not sent as a header", async () => {
    mock.reset(() => jsonReply({ data: { taskId: "t" } }));
    await client().tasks.create({ model: "m", input: {}, idempotencyKey: "   " });
    assert.equal(mock.requests[0].headers["idempotency-key"], undefined);
  });

  // Compile-time regression check for a real tsc error this SDK shipped with
  // earlier: a plain named interface, with no `[key: string]: unknown` index
  // signature, must be assignable to `input` without a cast at a direct call
  // site — `pretest` type-checks this file, so this only catches
  // `input: object` regressing back to an index-signature type. It does NOT
  // cover the pre-declared-`CreateTaskParams`-variable case (a generic
  // default type parameter passes here too, since inference applies at a
  // call site regardless) — that regression is caught by
  // scripts/smoke-types.mjs instead.
  interface SeedanceInput {
    prompt: string;
    resolution: string;
  }

  test("a named interface (no index signature) is accepted as input without a cast", async () => {
    mock.reset(() => jsonReply({ data: { taskId: "t" } }));
    const input: SeedanceInput = { prompt: "a cyan glass data center", resolution: "1080p" };
    const created = await client().tasks.create({ model: "seedance-2-0", input });
    assert.equal(created.taskId, "t");
    assert.deepEqual(JSON.parse(mock.requests[0].body).input, input);
  });

  // Same compile-time regression, through `callback`: it shipped typed as
  // `JSONObject` (`Record<string, unknown>`) even after `input` was fixed,
  // reintroducing the identical index-signature trap for this field alone —
  // confirmed via `tsc` before the fix.
  interface CallbackConfig {
    url: string;
    when: "final";
  }

  test("a named interface (no index signature) is accepted as callback without a cast", async () => {
    mock.reset(() => jsonReply({ data: { taskId: "t" } }));
    const callback: CallbackConfig = { url: "https://example.com/cb", when: "final" };
    const created = await client().tasks.create({ model: "m", input: {}, callback });
    assert.equal(created.taskId, "t");
    assert.deepEqual(JSON.parse(mock.requests[0].body).callback, callback);
  });

  test("Idempotent-Replay response header sets idempotentReplay", async () => {
    mock.reset(() => jsonReply({ data: { taskId: "t" } }, 200, { "Idempotent-Replay": "true" }));
    const created = await client().tasks.create({ model: "m", input: {}, idempotencyKey: "k" });
    assert.equal(created.idempotentReplay, true);
  });
});

describe("tasks.retrieve", () => {
  test("URL-encodes the task id", async () => {
    mock.reset(() => jsonReply({ data: { taskId: "a/b c", model: "m", status: "queued" } }));
    await client().tasks.retrieve("a/b c");
    assert.equal(mock.requests[0].path, "/v1/tasks/a%2Fb%20c");
  });

  test("parses the task from the data envelope", async () => {
    mock.reset(() =>
      jsonReply({
        data: {
          taskId: "t9",
          model: "m",
          status: "success",
          created: 1700000000,
          completed: 1700000100,
          output: [{ url: "https://cdn/x.png", type: "image", expireAt: 1700600000 }],
        },
      }),
    );
    const task = await client().tasks.retrieve("t9");
    assert.equal(task.taskId, "t9");
    assert.equal(task.succeeded, true);
    assert.equal(task.output[0].url, "https://cdn/x.png");
    assert.equal(task.output[0].expireAt, 1700600000);
  });

  test("rejects a response describing a different task (misattribution guard)", async () => {
    // Simulates a caching/routing bug on the server returning task B's data
    // for a request about task A — silently accepting this would misattribute
    // B's output to A rather than surfacing the protocol violation.
    mock.reset(() =>
      jsonReply({ data: { taskId: "wrong-task", model: "m", status: "success" } }),
    );
    await assert.rejects(client().tasks.retrieve("t9"), (err: unknown) => {
      assert.ok(err instanceof HiAPIError);
      assert.match(err.message, /wrong-task.*does not match.*t9/);
      return true;
    });
  });
});

describe("tasks.list", () => {
  test("parses the page under data.tasks", async () => {
    mock.reset(() =>
      jsonReply({
        data: {
          tasks: [{ taskId: "a", model: "m", status: "success" }],
          page: 1,
          size: 20,
          total: 41,
        },
      }),
    );
    const page = await client().tasks.list();
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].taskId, "a");
    assert.equal(page.total, 41);
    assert.equal(mock.requests[0].path, "/v1/tasks?page=1&size=20");
  });

  test("normalizes a bare array under data", async () => {
    mock.reset(() => jsonReply({ data: [{ taskId: "b", model: "m", status: "queued" }] }));
    const page = await client().tasks.list({ page: 3, size: 7 });
    assert.equal(page.items[0].taskId, "b");
    assert.equal(page.page, 3);
    assert.equal(page.size, 7);
  });

  test("accepts alternate item keys and never crashes on unknown shapes", async () => {
    for (const key of ["items", "list", "records"]) {
      mock.reset(() => jsonReply({ data: { [key]: [{ taskId: "c", model: "m", status: "fail" }] } }));
      const page = await client().tasks.list();
      assert.equal(page.items[0].taskId, "c", `key=${key}`);
    }
    mock.reset(() => jsonReply({ data: { unexpected: true } }));
    const page = await client().tasks.list();
    assert.deepEqual(page.items, []);
  });

  test("a malformed (non-object, non-array) data value stays visible on .raw instead of being discarded", async () => {
    // An earlier revision collapsed any non-object, non-array `data` to a
    // bare `{}` before it ever reached TaskPage, so `.raw` — which
    // TaskPage's own doc comment says always holds "the full, unparsed
    // envelope" — silently lost the fact that the server sent something
    // malformed at all, indistinguishable from a genuinely empty page.
    for (const malformed of [null, "unexpected", 42, false]) {
      mock.reset(() => jsonReply({ data: malformed }));
      const page = await client().tasks.list();
      assert.deepEqual(page.items, [], `malformed=${JSON.stringify(malformed)}`);
      assert.deepEqual(page.raw, { data: malformed }, `malformed=${JSON.stringify(malformed)}`);
    }
  });
});

describe("tasks.wait", () => {
  const statusReply = (status: string, extra: Record<string, unknown> = {}) =>
    jsonReply({ data: { taskId: "w1", model: "m", status, ...extra } });

  test("polls until success and reports status changes once each", async () => {
    const sequence = ["queued", "queued", "handling", "success"];
    mock.reset((_req, index) => statusReply(sequence[Math.min(index, sequence.length - 1)]));
    const seen: string[] = [];
    const task = await client().tasks.wait("w1", {
      pollIntervalMs: 1,
      timeoutMs: 5_000,
      onUpdate: (t) => seen.push(t.status),
    });
    assert.equal(task.status, "success");
    assert.deepEqual(seen, ["queued", "handling", "success"]);
    assert.equal(mock.requests.length, 4);
  });

  test("an async onUpdate is awaited: settles in order, and delays the next poll", async () => {
    const sequence = ["queued", "handling", "success"];
    mock.reset((_req, index) => statusReply(sequence[Math.min(index, sequence.length - 1)]));
    const settleOrder: string[] = [];
    const task = await client().tasks.wait("w1", {
      pollIntervalMs: 1,
      timeoutMs: 5_000,
      onUpdate: async (t) => {
        // A status-dependent delay: if onUpdate weren't awaited, "success"
        // (0ms) would settle before "queued" (20ms) despite firing later —
        // proving out-of-order settlement the same way a real, unawaited
        // async callback would in production.
        await new Promise((resolve) => setTimeout(resolve, t.status === "queued" ? 20 : 0));
        settleOrder.push(t.status);
      },
    });
    assert.equal(task.status, "success");
    assert.deepEqual(settleOrder, ["queued", "handling", "success"]);
  });

  test("a rejecting onUpdate propagates out of wait() instead of becoming an unhandled rejection", async () => {
    mock.reset(() => statusReply("queued"));
    const boom = new Error("onUpdate boom");
    await assert.rejects(
      client().tasks.wait("w1", {
        pollIntervalMs: 1,
        onUpdate: async () => {
          throw boom;
        },
      }),
      (err: unknown) => err === boom,
    );
  });

  test("terminal fail throws TaskFailedError carrying the task and code", async () => {
    mock.reset(() =>
      statusReply("fail", { error: { code: "UPSTREAM_ERROR", message: "boom" } }),
    );
    await assert.rejects(
      client().tasks.wait("w1", { pollIntervalMs: 1 }),
      (err: unknown) => {
        assert.ok(err instanceof TaskFailedError);
        assert.equal(err.code, "UPSTREAM_ERROR");
        assert.equal(err.task.taskId, "w1");
        assert.match(err.message, /w1/);
        assert.match(err.message, /boom/);
        return true;
      },
    );
  });

  test("terminal fail with no error object, or a blank message, falls back to a generic message", async () => {
    mock.reset(() => statusReply("fail"));
    await assert.rejects(client().tasks.wait("w1", { pollIntervalMs: 1 }), (err: unknown) => {
      assert.ok(err instanceof TaskFailedError);
      assert.equal(err.code, undefined);
      assert.match(err.message, /w1 failed: task failed/);
      return true;
    });

    mock.reset(() => statusReply("fail", { error: { code: "X", message: "" } }));
    await assert.rejects(client().tasks.wait("w1", { pollIntervalMs: 1 }), (err: unknown) => {
      assert.ok(err instanceof TaskFailedError);
      assert.match(err.message, /w1 failed: task failed/);
      return true;
    });
  });

  test("client-side timeout throws PollTimeoutError with the task id", async () => {
    mock.reset(() => statusReply("queued"));
    await assert.rejects(
      client().tasks.wait("w1", { pollIntervalMs: 10, timeoutMs: 30 }),
      (err: unknown) => {
        assert.ok(err instanceof PollTimeoutError);
        assert.equal(err.taskId, "w1");
        assert.equal(err.timeoutMs, 30);
        assert.match(err.message, /may still complete/);
        return true;
      },
    );
    assert.ok(mock.requests.length >= 2);
  });

  test("rejects invalid intervals up front", async () => {
    await assert.rejects(client().tasks.wait("w1", { pollIntervalMs: 0 }), RangeError);
    await assert.rejects(client().tasks.wait("w1", { pollIntervalMs: NaN }), RangeError);
    // Infinity is a real, verified failure mode, not just a theoretical one:
    // `setTimeout(fn, Infinity)` does not wait forever — Node clamps it to
    // 1ms — so an infinite interval would degrade into a busy-poll rather
    // than the "poll once and then never again" a caller might expect.
    await assert.rejects(client().tasks.wait("w1", { pollIntervalMs: Infinity }), RangeError);
    await assert.rejects(client().tasks.wait("w1", { timeoutMs: -1 }), RangeError);
    // A non-number timeoutMs is a real bypass for a plain-JS caller (no
    // compile-time protection): a bare `>= 0` comparison coerces "Infinity"
    // via Number(), passing validation, but `deadline + timeoutMs` (a `+`,
    // not `-`) then does STRING CONCATENATION for a string operand, which
    // later reduces to NaN and reproduces the exact busy-poll this guards
    // against elsewhere — confirmed by tracing the actual coercion.
    // @ts-expect-error deliberately passing a non-number to test the runtime guard
    await assert.rejects(client().tasks.wait("w1", { timeoutMs: "Infinity" }), RangeError);
    assert.equal(mock.requests.length, 0);
  });

  test("rejects a pollIntervalMs past Node's real (signed 32-bit) timer limit", async () => {
    // MAX_TIMER_DELAY_MS + 1 must throw; the exact boundary must not.
    await assert.rejects(
      client().tasks.wait("w1", { pollIntervalMs: 2_147_483_648 }),
      RangeError,
    );
    mock.reset(() => statusReply("success"));
    const task = await client().tasks.wait("w1", { pollIntervalMs: 2_147_483_647 });
    assert.equal(task.status, "success");
  });

  test("timeoutMs: Infinity is allowed (no timeout) as long as pollIntervalMs stays finite", async () => {
    mock.reset(() => statusReply("success"));
    const task = await client().tasks.wait("w1", { pollIntervalMs: 1, timeoutMs: Infinity });
    assert.equal(task.status, "success");
  });

  test("an AbortSignal stops the poll loop promptly", async () => {
    mock.reset(() => statusReply("queued"));
    const controller = new AbortController();
    const started = performance.now();
    const waiting = client().tasks.wait("w1", {
      pollIntervalMs: 60_000,
      timeoutMs: 120_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(waiting, (err: unknown) => {
      assert.equal((err as Error).name, "AbortError");
      return true;
    });
    assert.ok(performance.now() - started < 5_000);
  });

  test("an AbortSignal triggered while retrieve() is in flight is still honoured — no onUpdate, no terminal result", async () => {
    // Regression test for the round-4 fix: the abort is re-checked right
    // after `retrieve()` resolves, not just at the top of the loop — so even
    // when the in-flight request's response is a terminal "success" (which
    // would otherwise resolve wait()), the abort must win instead.
    const controller = new AbortController();
    let onUpdateCalls = 0;
    mock.reset(
      () =>
        new Promise((resolve) => {
          // Held open long enough for the abort (fired at 20ms) to land
          // while this request is still in flight.
          setTimeout(() => resolve(statusReply("success")), 100);
        }),
    );
    const waiting = client().tasks.wait("w1", {
      pollIntervalMs: 60_000,
      timeoutMs: 120_000,
      signal: controller.signal,
      onUpdate: () => {
        onUpdateCalls++;
      },
    });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(waiting, (err: unknown) => {
      assert.equal((err as Error).name, "AbortError");
      return true;
    });
    assert.equal(onUpdateCalls, 0);
  });
});

describe("tasks.run", () => {
  test("creates then polls to completion", async () => {
    mock.reset((req, index) => {
      if (index === 0) {
        assert.equal(req.method, "POST");
        return jsonReply({ data: { taskId: "r1" } });
      }
      assert.equal(req.method, "GET");
      return index < 2
        ? jsonReply({ data: { taskId: "r1", model: "m", status: "handling" } })
        : jsonReply({
            data: {
              taskId: "r1",
              model: "m",
              status: "success",
              output: [{ url: "https://cdn/ok.mp4", type: "video" }],
            },
          });
    });
    const task = await client().tasks.run({
      model: "m",
      input: { prompt: "x" },
      idempotencyKey: "run-key",
      pollIntervalMs: 1,
      timeoutMs: 5_000,
    });
    assert.equal(task.succeeded, true);
    assert.equal(task.output[0].url, "https://cdn/ok.mp4");
    assert.equal(mock.requests[0].headers["idempotency-key"], "run-key");
    assert.equal(mock.requests[0].path, "/v1/tasks");
    assert.equal(mock.requests[1].path, "/v1/tasks/r1");
  });

  test("a pre-aborted signal is honoured before create() ever fires — no POST is sent", async () => {
    // create() has no signal awareness of its own (a POST is never safe to
    // abandon mid-flight — it may already have billed), so without this
    // check, run() would still create a task from an already-aborted call.
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      client().tasks.run({ model: "m", input: {}, signal: controller.signal }),
      (err: unknown) => {
        assert.equal((err as Error).name, "AbortError");
        return true;
      },
    );
    assert.equal(mock.requests.length, 0);
  });

  test("an abort landing right after create() succeeds throws RunAbortedError carrying the taskId", async () => {
    mock.reset(() => jsonReply({ data: { taskId: "r2" } }));
    const controller = new AbortController();
    const reason = new Error("cancelled by caller");
    // A custom fetch that aborts the controller right as create()'s POST
    // resolves — reproducing the exact race run() guards against: the
    // signal fires in the window between the task existing server-side and
    // run()'s post-create check running, with no mocked GET configured, so
    // this also proves wait() is never reached (an unexpected request shape
    // would otherwise fail the test).
    const raceClient = new HiAPI({
      apiKey: "sk-test",
      baseUrl: mock.url,
      timeoutMs: 5_000,
      maxRetries: 0,
      fetch: async (...args) => {
        const resp = await fetch(...args);
        controller.abort(reason);
        return resp;
      },
    });
    await assert.rejects(
      raceClient.tasks.run({ model: "m", input: {}, signal: controller.signal }),
      (err: unknown) => {
        assert.ok(err instanceof RunAbortedError);
        assert.equal(err.taskId, "r2");
        assert.equal(err.cause, reason);
        assert.match(err.message, /r2/);
        return true;
      },
    );
    assert.equal(mock.requests.length, 1);
  });
});
