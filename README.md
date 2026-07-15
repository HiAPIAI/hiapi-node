# HiAPI Node.js SDK

Zero-dependency Node.js client for the [HiAPI](https://hiapi.ai) **unified async task API** (`/v1/tasks`) — submit an image / video / audio generation task, poll it to completion, and read the output in **one call**.

- **Zero runtime dependencies.** Built on the global `fetch` and `node:crypto` — nothing else.
- **One-call workflow.** `client.tasks.run(...)` submits and waits for you.
- **TypeScript-first.** Full type declarations, ESM **and** CommonJS entry points.
- **Webhook verification.** HMAC-SHA256 signature + timestamp freshness check, built in (still deduplicate deliveries by task id).

> For OpenAI-compatible chat/image endpoints, keep using the `openai` library with
> `baseURL: "https://api.hiapi.ai/v1"`. This SDK focuses on what the OpenAI client
> can't do: the asynchronous **submit → poll → retrieve** lifecycle (results come back as output URLs).

## Install

```bash
npm install hiapi
```

Requires Node.js 18.17+.

## Quick start

```js
import { HiAPI } from "hiapi";
// CommonJS works too: const { HiAPI } = require("hiapi");

const client = new HiAPI({ apiKey: "sk-..." }); // or set HIAPI_API_KEY

const task = await client.tasks.run({
  model: "seedance-2-0",
  input: { prompt: "a cyan glass data center entrance", resolution: "1080p" },
  onUpdate: (t) => console.log("status:", t.status),
});

for (const out of task.output) {
  console.log(out.type, out.url); // e.g. "video https://cdn.hiapi.ai/tasks/..."
}
```

`run()` resolves once the task reaches a terminal state. It throws
`TaskFailedError` if the task fails and `PollTimeoutError` if it doesn't finish
within `timeoutMs` (default 600000 — 10 minutes). A poll timeout does **not**
cancel the task — it may still finish (and bill) later; take `taskId` from the
`PollTimeoutError` and `retrieve()` it instead of submitting the same request
again.

Output URLs are **temporary** — they expire about 7 days after creation (each
output carries `expireAt`). To keep an output long-term, promote it to
persistent storage before it expires — see the
[Output Storage docs](https://docs.hiapi.ai/storage/).

## Lower-level control

```js
const created = await client.tasks.create({
  model: "seedance-2-0",
  input: { prompt: "...", resolution: "720p" },
  callback: { url: "https://your-app.com/hiapi/callback", when: "final" },
});
console.log(created.taskId);

let task = await client.tasks.retrieve(created.taskId); // one status check
task = await client.tasks.wait(created.taskId, { pollIntervalMs: 3000, timeoutMs: 900000 });
const page = await client.tasks.list({ page: 1, size: 20 }); // newest first
```

`input` fields are **defined per model** — see the relevant
[model page](https://docs.hiapi.ai/models/). Don't put callback fields inside
`input`; pass `callback` separately.

## Model routes

Some models expose multiple routes (e.g. `ext`) with different pricing or
upstream capacity. Pass `route` instead of writing the `model@route` suffix:

```js
const created = await client.tasks.create({
  model: "gpt-image-2/text-to-image",
  route: "ext", // preferred over model: "...@ext"
  input: { prompt: "..." },
});
```

Omitting `route` (or passing `"default"`) uses the model's default route. An
unknown route fails fast with a 400 whose message lists the available routes.
The legacy `model: "x@ext"` spelling keeps working. When a task was submitted
with `route`, its detail echoes `task.route` and `task.model` holds the
resolved full name (`x@ext`).

## Idempotent retries

Pass `idempotencyKey` (sent as the `Idempotency-Key` header, ≤255 bytes) to
make task submission safe to retry — retrying the same key + same body within
about 24 hours returns the first task instead of creating and billing a new one
(after that the key is cleaned up and the same request creates a new task):

```js
const created = await client.tasks.create({
  model: "seedance-2-0",
  input: { prompt: "..." },
  idempotencyKey: "order-8472:video", // a stable key you derive per job
});
if (created.idempotentReplay) {
  console.log("hit the idempotency cache; no new task created");
}
```

With a key set, the SDK also retries the POST on network errors and retries
`409 IDEMPOTENCY_KEY_PROCESSING` (the first request is still in flight) up to
the retry limit (default 2), honouring `Retry-After` capped at 60s. Reusing a
key with a **different** body throws `IdempotencyKeyMismatchError` — that's a
key-construction bug, not retryable.

## Webhooks

If you set a **Webhook signing key** in the HiAPI console, terminal callbacks are
signed. Verify them against the **raw request body**:

```js
import { createServer } from "node:http";
import { HiAPI, WebhookVerificationError } from "hiapi";

const client = new HiAPI({ apiKey: "sk-...", webhookSecret: "whsec_..." });
const MAX_BODY = 1024 * 1024; // 1 MiB — reject oversized bodies before verifying

createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/hiapi/callback") {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  let size = 0;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY) {
      res.writeHead(413).end();
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    let task;
    try {
      task = client.webhooks.verify(Buffer.concat(chunks), req.headers);
    } catch (err) {
      if (err instanceof WebhookVerificationError) {
        res.writeHead(400).end();
        return;
      }
      throw err;
    }
    if (task.succeeded && task.output.length > 0) {
      console.log(task.output[0].url);
    }
    res.writeHead(200).end(); // ack with 2xx; HiAPI retries non-2xx
  });
}).listen(3000);
```

If you use a framework, make sure the handler receives the **exact bytes** of
the request body (e.g. `express.raw({ type: "application/json" })` in Express)
— verifying a re-serialized JSON object can fail even when the payload is
legitimate.

Callbacks are delivered **at least once** and can arrive concurrently — make
your handler idempotent (e.g. upsert your own record keyed by `task.taskId`)
and return 2xx only after processing succeeds. Duplicates are then harmless,
and a failed or crashed handler is simply redelivered.

## Errors

| Error class | When |
| --- | --- |
| `AuthenticationError` | 401 — bad/missing API key |
| `NotFoundError` | 404 — unknown task or not yours |
| `InvalidRequestError` | `INVALID_REQUEST` — fix the request |
| `ModelUnavailableError` | `MODEL_UNAVAILABLE` — retry or switch model |
| `TaskFailedSyncError` | `TASK_FAILED` — the submission was rejected synchronously (distinct from `TaskFailedError` below) |
| `TaskTimeoutError` / `StorageUnavailableError` | retryable upstream errors |
| `ServiceUnavailableError` | 503 — platform busy (auto-retried) |
| `IdempotencyKeyProcessingError` | 409 — same key still in flight (auto-retried; retryable) |
| `IdempotencyKeyMismatchError` | 422 — key reused with a different body (**not** retryable) |
| `APIError` | any other non-2xx response (base class — e.g. `402`, `403`; carries `status` and `body`) |
| `APIConnectionError` | network failure or client-side timeout (auto-retried for reads only — **not** a keyless `create()`) |
| `TaskFailedError` | a polled task ended in `status=fail` (carries `task` and `code`) |
| `PollTimeoutError` | `run()`/`wait()` exceeded its timeout (carries `taskId`) |
| `WebhookVerificationError` | bad signature or stale timestamp |

429/503 are retried automatically with exponential backoff (`maxRetries`,
default 2; honours `Retry-After`). Network errors are retried **only for
idempotent GETs** (`retrieve` / `list`, and the polling inside `wait` / `run`).
The `POST` that `create()` issues is **never** retried on a network failure —
unless you pass `idempotencyKey`, which makes the retry safe server-side.
Without a key, an `APIConnectionError` from `create()` leaves the request in an
**unknown** state — a task may or may not have been created (and billed).
`list()` can help you inspect recent tasks manually, but tasks don't echo your
`input` back, so absence from the list doesn't prove the request failed — don't
retry automatically on that basis. For anything automated, submit with an
`idempotencyKey` so the retry is safe by design.

## Configuration

```js
new HiAPI({
  apiKey: undefined,                  // falls back to HIAPI_API_KEY
  baseUrl: "https://api.hiapi.ai/v1",
  timeoutMs: 60_000,                  // per-request
  maxRetries: 2,
  webhookSecret: undefined,           // falls back to HIAPI_WEBHOOK_SECRET
  fetch: undefined,                   // custom fetch impl (testing/instrumentation)
});
```

This SDK is designed for server-side use. Don't ship your API key to browsers
— route generation through your backend instead.

## License

MIT
