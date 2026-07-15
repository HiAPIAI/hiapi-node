import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { DEFAULT_BASE_URL, HiAPI, HiAPIError, VERSION } from "../src/index.js";
import type { FetchLike } from "../src/index.js";

describe("client construction", () => {
  test("throws a clear error when no API key is available", () => {
    const prev = process.env.HIAPI_API_KEY;
    delete process.env.HIAPI_API_KEY;
    try {
      assert.throws(() => new HiAPI(), (err: unknown) => {
        assert.ok(err instanceof HiAPIError);
        assert.match((err as Error).message, /HIAPI_API_KEY/);
        return true;
      });
    } finally {
      if (prev !== undefined) {
        process.env.HIAPI_API_KEY = prev;
      }
    }
  });

  test("falls back to the HIAPI_API_KEY environment variable", () => {
    const prev = process.env.HIAPI_API_KEY;
    process.env.HIAPI_API_KEY = "sk-env";
    try {
      const client = new HiAPI();
      assert.equal(client.baseUrl, DEFAULT_BASE_URL);
    } finally {
      if (prev === undefined) {
        delete process.env.HIAPI_API_KEY;
      } else {
        process.env.HIAPI_API_KEY = prev;
      }
    }
  });

  test("an explicit empty apiKey falls back to HIAPI_API_KEY, matching the Python SDK", () => {
    const prev = process.env.HIAPI_API_KEY;
    process.env.HIAPI_API_KEY = "sk-env-fallback";
    try {
      const client = new HiAPI({ apiKey: "" });
      assert.equal(client.baseUrl, DEFAULT_BASE_URL);
    } finally {
      if (prev === undefined) {
        delete process.env.HIAPI_API_KEY;
      } else {
        process.env.HIAPI_API_KEY = prev;
      }
    }
  });

  test("rejects a non-finite timeoutMs or maxRetries at construction, not on first request", () => {
    for (const timeoutMs of [NaN, Infinity, -1, 0]) {
      assert.throws(() => new HiAPI({ apiKey: "sk-test", timeoutMs }), RangeError, `timeoutMs=${timeoutMs}`);
    }
    for (const maxRetries of [NaN, Infinity]) {
      assert.throws(() => new HiAPI({ apiKey: "sk-test", maxRetries }), RangeError, `maxRetries=${maxRetries}`);
    }
    // Sanity: valid values still construct fine.
    assert.doesNotThrow(() => new HiAPI({ apiKey: "sk-test", timeoutMs: 1000, maxRetries: 0 }));
  });

  test("a custom fetch implementation is used for requests", async () => {
    const urls: string[] = [];
    const fake: FetchLike = async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ data: { taskId: "via-fake" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const client = new HiAPI({ apiKey: "sk-test", fetch: fake });
    const created = await client.tasks.create({ model: "m", input: {} });
    assert.equal(created.taskId, "via-fake");
    assert.deepEqual(urls, [`${DEFAULT_BASE_URL}/tasks`]);
  });
});

describe("version contract", () => {
  test("VERSION matches package.json", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version: string; name: string };
    assert.equal(pkg.name, "hiapi");
    assert.equal(VERSION, pkg.version);
  });
});
