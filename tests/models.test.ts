import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { CreatedTask, Output, Task, TaskPage, TERMINAL_STATUSES } from "../src/index.js";

describe("Task.fromJSON", () => {
  test("parses a full payload and keeps unknown fields in raw", () => {
    const wire = {
      taskId: "t1",
      model: "seedance-2-0",
      status: "success",
      created: 1700000000,
      completed: 1700000100,
      storage: "temp",
      route: "ext",
      output: [{ url: "https://cdn/a.png", type: "image", expireAt: 1700600000 }],
      futureField: { nested: true },
    };
    const task = Task.fromJSON(wire);
    assert.equal(task.taskId, "t1");
    assert.equal(task.model, "seedance-2-0");
    assert.equal(task.createdAt, 1700000000);
    assert.equal(task.completedAt, 1700000100);
    assert.equal(task.storage, "temp");
    assert.equal(task.route, "ext");
    assert.equal(task.output.length, 1);
    assert.equal(task.output[0].expireAt, 1700600000);
    assert.deepEqual(task.raw.futureField, { nested: true });
  });

  test("normalizes the completed: 0 sentinel to undefined", () => {
    const task = Task.fromJSON({ taskId: "t", model: "m", status: "queued", completed: 0 });
    assert.equal(task.completedAt, undefined);
  });

  test("isTerminal / succeeded track the status", () => {
    for (const status of ["queued", "handling", "archiving"]) {
      const task = Task.fromJSON({ taskId: "t", model: "m", status });
      assert.equal(task.isTerminal, false, status);
      assert.equal(task.succeeded, false, status);
    }
    assert.equal(Task.fromJSON({ taskId: "t", model: "m", status: "success" }).succeeded, true);
    assert.equal(Task.fromJSON({ taskId: "t", model: "m", status: "fail" }).isTerminal, true);
    assert.equal(Task.fromJSON({ taskId: "t", model: "m", status: "fail" }).succeeded, false);
    // A status added server-side later must parse without breaking.
    const future = Task.fromJSON({ taskId: "t", model: "m", status: "reviewing" });
    assert.equal(future.status, "reviewing");
    assert.equal(future.isTerminal, false);
    assert.deepEqual([...TERMINAL_STATUSES].sort(), ["fail", "success"]);
  });

  test("parses the error object and filters malformed output entries", () => {
    const task = Task.fromJSON({
      taskId: "t",
      model: "m",
      status: "fail",
      error: { code: "UPSTREAM_ERROR", message: "boom", extra: 1 },
      output: ["not-an-object", { url: "https://cdn/ok.png", type: "image" }],
    });
    assert.equal(task.error?.code, "UPSTREAM_ERROR");
    assert.equal(task.error?.message, "boom");
    assert.equal(task.output.length, 1);
    assert.equal(task.output[0].url, "https://cdn/ok.png");
  });

  test("missing fields default safely", () => {
    const task = Task.fromJSON({});
    assert.equal(task.taskId, "");
    assert.equal(task.status, "");
    assert.deepEqual(task.output, []);
    assert.equal(task.error, undefined);
    assert.equal(task.route, undefined);
  });
});

describe("Output / CreatedTask", () => {
  test("Output defaults missing fields", () => {
    const output = Output.fromJSON({ unexpected: 1 });
    assert.equal(output.url, "");
    assert.equal(output.type, "");
    assert.equal(output.expireAt, undefined);
    assert.deepEqual(output.raw, { unexpected: 1 });
  });

  test("CreatedTask carries the replay flag", () => {
    assert.equal(CreatedTask.fromJSON({ taskId: "t" }).idempotentReplay, false);
    assert.equal(CreatedTask.fromJSON({ taskId: "t" }, true).idempotentReplay, true);
  });
});

describe("TaskPage.fromJSON", () => {
  test("reads the canonical tasks key with pagination fields", () => {
    const page = TaskPage.fromJSON({
      tasks: [{ taskId: "a", model: "m", status: "success" }],
      page: 2,
      size: 10,
      total: 31,
    });
    assert.equal(page.items[0].taskId, "a");
    assert.equal(page.page, 2);
    assert.equal(page.size, 10);
    assert.equal(page.total, 31);
  });

  test("falls back to alternate keys and filters non-object items", () => {
    const page = TaskPage.fromJSON({ list: [{ taskId: "b", model: "m", status: "queued" }, 42] });
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].taskId, "b");
  });

  test("unknown shapes parse to an empty page, never a crash", () => {
    const page = TaskPage.fromJSON({ something: "else" });
    assert.deepEqual(page.items, []);
    assert.equal(page.total, undefined);
  });
});
