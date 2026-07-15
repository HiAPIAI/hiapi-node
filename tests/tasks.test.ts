import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { HiAPI, PollTimeoutError, TaskFailedError } from "../src/index.js";
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

  // Compile-time regression check for a real tsc error (models.ts JSONObject):
  // a plain named interface, with no `[key: string]: unknown` index signature,
  // must be assignable to `input` without a cast — `pretest` type-checks this
  // file, so reverting the generic on CreateTaskParams breaks the build here.
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

  test("Idempotent-Replay response header sets idempotentReplay", async () => {
    mock.reset(() => jsonReply({ data: { taskId: "t" } }, 200, { "Idempotent-Replay": "true" }));
    const created = await client().tasks.create({ model: "m", input: {}, idempotencyKey: "k" });
    assert.equal(created.idempotentReplay, true);
  });
});

describe("tasks.retrieve", () => {
  test("URL-encodes the task id", async () => {
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
    await assert.rejects(client().tasks.wait("w1", { timeoutMs: -1 }), RangeError);
    assert.equal(mock.requests.length, 0);
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
});
