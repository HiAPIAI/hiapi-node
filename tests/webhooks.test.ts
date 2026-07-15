import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { describe, test } from "node:test";

import {
  HiAPI,
  verifyWebhook,
  WebhookVerificationError,
  Webhooks,
} from "../src/index.js";

const SECRET = "whsec_test";
const PAYLOAD = JSON.stringify({
  taskId: "cb-1",
  model: "m",
  status: "success",
  output: [{ url: "https://cdn/x.png", type: "image" }],
});

function sign(body: string, timestamp: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

describe("verifyWebhook", () => {
  test("accepts a valid signature and returns the parsed Task", () => {
    const ts = String(nowSecs());
    const task = verifyWebhook(PAYLOAD, {
      signature: sign(PAYLOAD, ts),
      timestamp: ts,
      secret: SECRET,
    });
    assert.equal(task.taskId, "cb-1");
    assert.equal(task.succeeded, true);
  });

  test("accepts the body as bytes", () => {
    const ts = String(nowSecs());
    const task = verifyWebhook(Buffer.from(PAYLOAD, "utf8"), {
      signature: sign(PAYLOAD, ts),
      timestamp: ts,
      secret: SECRET,
    });
    assert.equal(task.taskId, "cb-1");
  });

  test("rejects a tampered body and a wrong secret", () => {
    const ts = String(nowSecs());
    const sig = sign(PAYLOAD, ts);
    assert.throws(
      () => verifyWebhook(PAYLOAD.replace("cb-1", "cb-2"), { signature: sig, timestamp: ts, secret: SECRET }),
      /signature mismatch/,
    );
    assert.throws(
      () => verifyWebhook(PAYLOAD, { signature: sig, timestamp: ts, secret: "other" }),
      /signature mismatch/,
    );
  });

  test("rejects missing headers and missing secret", () => {
    const ts = String(nowSecs());
    assert.throws(
      () => verifyWebhook(PAYLOAD, { signature: "", timestamp: ts, secret: SECRET }),
      /missing signature or timestamp/,
    );
    assert.throws(
      () => verifyWebhook(PAYLOAD, { signature: "x", timestamp: "", secret: SECRET }),
      /missing signature or timestamp/,
    );
    assert.throws(
      () => verifyWebhook(PAYLOAD, { signature: "x", timestamp: ts, secret: "" }),
      /no webhook signing secret/,
    );
  });

  test("rejects a stale timestamp; tolerance 0 disables the check", () => {
    const stale = String(nowSecs() - 301);
    assert.throws(
      () => verifyWebhook(PAYLOAD, { signature: sign(PAYLOAD, stale), timestamp: stale, secret: SECRET }),
      /outside the allowed tolerance/,
    );
    const task = verifyWebhook(PAYLOAD, {
      signature: sign(PAYLOAD, stale),
      timestamp: stale,
      secret: SECRET,
      tolerance: 0,
    });
    assert.equal(task.taskId, "cb-1");
  });

  test("the now override pins the clock for testing", () => {
    const ts = "1700000000";
    const task = verifyWebhook(PAYLOAD, {
      signature: sign(PAYLOAD, ts),
      timestamp: ts,
      secret: SECRET,
      now: 1700000100,
    });
    assert.equal(task.taskId, "cb-1");
    assert.throws(
      () =>
        verifyWebhook(PAYLOAD, {
          signature: sign(PAYLOAD, ts),
          timestamp: ts,
          secret: SECRET,
          now: 1700000601,
        }),
      /outside the allowed tolerance/,
    );
  });

  test("rejects non-integer timestamps", () => {
    for (const bad of ["12.5", "abc", " "]) {
      assert.throws(
        () => verifyWebhook(PAYLOAD, { signature: "x", timestamp: bad, secret: SECRET }),
        /invalid timestamp/,
        `timestamp=${JSON.stringify(bad)}`,
      );
    }
  });

  test("rejects a verified body that is not a JSON object", () => {
    const ts = String(nowSecs());
    const notJson = "not json";
    assert.throws(
      () => verifyWebhook(notJson, { signature: sign(notJson, ts), timestamp: ts, secret: SECRET }),
      /not valid JSON/,
    );
    const arrayBody = "[1,2]";
    assert.throws(
      () => verifyWebhook(arrayBody, { signature: sign(arrayBody, ts), timestamp: ts, secret: SECRET }),
      /not a JSON object/,
    );
  });
});

describe("Webhooks.verify header handling", () => {
  test("reads headers from a fetch Headers instance (case-insensitive)", () => {
    const ts = String(nowSecs());
    const headers = new Headers({
      "X-HiAPI-Signature": sign(PAYLOAD, ts),
      "X-HiAPI-Timestamp": ts,
    });
    const task = new Webhooks(SECRET).verify(PAYLOAD, headers);
    assert.equal(task.taskId, "cb-1");
  });

  test("reads Node-style lower-cased header records, including array values", () => {
    const ts = String(nowSecs());
    const task = new Webhooks(SECRET).verify(PAYLOAD, {
      "x-hiapi-signature": [sign(PAYLOAD, ts)],
      "x-hiapi-timestamp": ts,
    });
    assert.equal(task.taskId, "cb-1");
  });

  test("missing headers surface as a verification error", () => {
    assert.throws(
      () => new Webhooks(SECRET).verify(PAYLOAD, {}),
      /missing signature or timestamp/,
    );
  });

  test("per-call secret overrides the bound secret; none at all is an error", () => {
    const ts = String(nowSecs());
    const headers = {
      "x-hiapi-signature": sign(PAYLOAD, ts, "override"),
      "x-hiapi-timestamp": ts,
    };
    const task = new Webhooks(SECRET).verify(PAYLOAD, headers, { secret: "override" });
    assert.equal(task.taskId, "cb-1");
    assert.throws(() => new Webhooks(undefined).verify(PAYLOAD, headers), /no webhook secret/);
    assert.ok(
      (() => {
        try {
          new Webhooks(undefined).verify(PAYLOAD, headers);
          return false;
        } catch (err) {
          return err instanceof WebhookVerificationError;
        }
      })(),
    );
  });

  test("client.webhooks is wired to the constructor webhookSecret", () => {
    const ts = String(nowSecs());
    const clientWithSecret = new HiAPI({ apiKey: "sk-test", webhookSecret: SECRET });
    const task = clientWithSecret.webhooks.verify(PAYLOAD, {
      "x-hiapi-signature": sign(PAYLOAD, ts),
      "x-hiapi-timestamp": ts,
    });
    assert.equal(task.taskId, "cb-1");
  });

  test("falls back to the HIAPI_WEBHOOK_SECRET environment variable", () => {
    const ts = String(nowSecs());
    const prev = process.env.HIAPI_WEBHOOK_SECRET;
    process.env.HIAPI_WEBHOOK_SECRET = SECRET;
    try {
      const envClient = new HiAPI({ apiKey: "sk-test" });
      const task = envClient.webhooks.verify(PAYLOAD, {
        "x-hiapi-signature": sign(PAYLOAD, ts),
        "x-hiapi-timestamp": ts,
      });
      assert.equal(task.taskId, "cb-1");
    } finally {
      if (prev === undefined) {
        delete process.env.HIAPI_WEBHOOK_SECRET;
      } else {
        process.env.HIAPI_WEBHOOK_SECRET = prev;
      }
    }
  });
});
