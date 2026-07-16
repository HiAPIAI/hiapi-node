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
        : jsonReply({ data: { taskId: "t-ok" } }),
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
        : jsonReply({ data: { taskId: "up" } }),
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

  test("an HTTP-date Retry-After on a real 429 is honoured through the full retry loop", async () => {
    // toUTCString() truncates to whole seconds, so a target under ~1s out can
    // round down to "now" or even the past. 1800ms guarantees a real wait
    // (>=~800ms after worst-case truncation) without slowing the suite much.
    const future = new Date(Date.now() + 1_800).toUTCString();
    mock.reset((_req, index) =>
      index === 0
        ? jsonReply({ message: "slow down" }, 429, { "Retry-After": future })
        : jsonReply({ data: { taskId: "t-date" } }),
    );
    const started = performance.now();
    const task = await client().tasks.retrieve("t-date");
    assert.equal(task.taskId, "t-date");
    assert.equal(mock.requests.length, 2);
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 700, `should have waited close to the Retry-After delay, got ${elapsed}ms`);
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
});
