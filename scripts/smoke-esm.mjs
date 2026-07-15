// Exercises the REAL published "exports" map's runtime ("import") condition
// via Node's self-reference resolution — importing the package by its own
// name, not a relative src/ path — so a broken exports map or a stale
// dist/esm build fails this the same way it would for a real consumer. This
// does NOT check the "types" condition (Node's loader never reads it — only
// tsc does); see scripts/smoke-types.mjs for that. Runs after `npm run build`
// (see package.json "smoke").
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  APIError,
  HiAPI,
  HiAPIError,
  Task,
  VERSION,
  verifyWebhook,
} from "hiapi";

const pkgPath = new URL("../package.json", import.meta.url);
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
assert.equal(VERSION, pkg.version);
assert.equal(pkg.name, "hiapi");
assert.equal(typeof HiAPI, "function");
assert.equal(typeof verifyWebhook, "function");
assert.ok(new HiAPIError("x") instanceof Error);
assert.ok(APIError.prototype instanceof HiAPIError);
assert.equal(typeof Task, "function");

const client = new HiAPI({ apiKey: "sk-smoke-test" });
assert.equal(client.baseUrl, "https://api.hiapi.ai/v1");

console.log("smoke:esm ok —", VERSION);
