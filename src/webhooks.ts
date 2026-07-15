/**
 * Verify HiAPI callback (webhook) signatures.
 *
 * When a "Webhook signing key" is set in the HiAPI console, each terminal
 * callback carries two headers:
 *
 *     X-HiAPI-Timestamp: Unix seconds (string)
 *     X-HiAPI-Signature: hex( HMAC_SHA256(secret, timestamp + "." + body) )
 *
 * `verifyWebhook` recomputes the signature over the **raw request body**
 * (never the re-serialized JSON — re-encoding can change bytes and break the
 * check), guards against replay with a timestamp tolerance, and returns the
 * parsed {@link Task}.
 */

import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

import { WebhookVerificationError } from "./errors.js";
import { Task } from "./models.js";
import type { JSONObject } from "./models.js";

export const TIMESTAMP_HEADER = "X-HiAPI-Timestamp";
export const SIGNATURE_HEADER = "X-HiAPI-Signature";
/** Seconds; callbacks older/newer than this are rejected. */
export const DEFAULT_TOLERANCE = 300;

export interface VerifyWebhookOptions {
  /** Value of the `X-HiAPI-Signature` header. */
  signature: string;
  /** Value of the `X-HiAPI-Timestamp` header. */
  timestamp: string;
  /** The webhook signing key configured in the HiAPI console. */
  secret: string;
  /** Max allowed clock skew in seconds (0 disables the check). Default 300. */
  tolerance?: number;
  /** Override the current Unix time in seconds (for testing). */
  now?: number;
}

/**
 * Verify a raw callback and return the parsed {@link Task}.
 *
 * `body` must be the raw request body exactly as received (bytes preferred).
 * Throws {@link WebhookVerificationError} on missing/blank headers, a bad or
 * stale timestamp, or a signature mismatch.
 */
export function verifyWebhook(body: string | Uint8Array, opts: VerifyWebhookOptions): Task {
  const { signature, timestamp, secret } = opts;
  const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE;
  if (!signature || !timestamp) {
    throw new WebhookVerificationError("missing signature or timestamp header");
  }
  if (!secret) {
    throw new WebhookVerificationError("no webhook signing secret configured");
  }
  // A NaN tolerance is falsy in JS, so `if (tolerance)` below would silently
  // SKIP the freshness check rather than disable it loudly — a caller's typo
  // or bad config (e.g. Number(process.env.X) on an unset var) would fail
  // open on the replay-protection window instead of failing closed.
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new WebhookVerificationError(`tolerance must be a finite number >= 0, got ${tolerance}`);
  }

  if (!/^-?\d+$/.test(timestamp.trim())) {
    throw new WebhookVerificationError("invalid timestamp header");
  }
  const ts = Number(timestamp.trim());

  if (tolerance) {
    // Same fail-open shape as tolerance: a NaN `now` override would make the
    // `> tolerance` comparison below always false (any comparison with NaN
    // is), silently accepting a timestamp of any age.
    const current = opts.now ?? Math.floor(Date.now() / 1000);
    if (!Number.isFinite(current)) {
      throw new WebhookVerificationError(`now must be a finite number, got ${current}`);
    }
    if (Math.abs(current - ts) > tolerance) {
      throw new WebhookVerificationError(
        "timestamp outside the allowed tolerance (possible replay)",
      );
    }
  }

  const bodyBytes = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
  const signed = Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), bodyBytes]);
  const expected = createHmac("sha256", secret).update(signed).digest("hex");

  const expectedBuf = Buffer.from(expected, "utf8");
  const signatureBuf = Buffer.from(signature, "utf8");
  if (expectedBuf.length !== signatureBuf.length || !timingSafeEqual(expectedBuf, signatureBuf)) {
    throw new WebhookVerificationError("signature mismatch");
  }

  let payload: unknown;
  try {
    // `fatal: true` — a plain `bodyBytes.toString("utf8")` silently replaces
    // invalid byte sequences with U+FFFD instead of throwing (confirmed via
    // `node -e`), which could let a signature-verified-but-malformed payload
    // through with corrupted field values rather than being rejected, the
    // way Python's `.decode("utf-8")` (strict by default) already is.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes);
    payload = JSON.parse(text);
  } catch (err) {
    throw new WebhookVerificationError(
      `verified body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new WebhookVerificationError("verified body is not a JSON object");
  }
  return Task.fromJSON(payload as JSONObject);
}

/**
 * Anything header-shaped: the fetch `Headers` class, a framework's
 * case-insensitive header map (everything with a `.get()`), or Node's plain
 * `IncomingMessage.headers` object (lower-cased keys, values possibly arrays).
 */
export type HeadersLike =
  | Headers
  | { get(name: string): string | null | undefined }
  | Record<string, string | string[] | undefined>;

function headerValue(headers: HeadersLike, name: string): string | undefined {
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") {
    // Most header containers with a get() are already case-insensitive.
    const container = headers as { get(name: string): string | null | undefined };
    const value = container.get(name) ?? container.get(name.toLowerCase());
    return value === null || value === undefined ? undefined : String(value);
  }
  const lowered = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (key.toLowerCase() === lowered && value !== undefined) {
      return Array.isArray(value) ? value[0] : String(value);
    }
  }
  return undefined;
}

/** Bound helper: `client.webhooks.verify(body, headers)`. */
export class Webhooks {
  private readonly secret?: string;

  constructor(secret?: string) {
    this.secret = secret;
  }

  /**
   * Verify a callback using its request headers.
   *
   * Pulls `X-HiAPI-Timestamp` / `X-HiAPI-Signature` from `headers`
   * (case-insensitive). `secret` defaults to the `webhookSecret` given when
   * constructing the client (or the `HIAPI_WEBHOOK_SECRET` environment
   * variable).
   */
  verify(
    body: string | Uint8Array,
    headers: HeadersLike,
    opts: { secret?: string; tolerance?: number; now?: number } = {},
  ): Task {
    const resolved = opts.secret ?? this.secret;
    if (!resolved) {
      throw new WebhookVerificationError(
        "no webhook secret: pass secret or set webhookSecret on the client",
      );
    }
    return verifyWebhook(body, {
      signature: headerValue(headers, SIGNATURE_HEADER) ?? "",
      timestamp: headerValue(headers, TIMESTAMP_HEADER) ?? "",
      secret: resolved,
      tolerance: opts.tolerance,
      now: opts.now,
    });
  }
}
