// Exercises the REAL published "exports" map (ESM condition) via Node's
// self-reference resolution — importing the package by its own name, not a
// relative src/ path — so a broken exports map, a stale dist/esm build, or a
// missing d.ts condition would fail this the same way it would for a real
// consumer. See package.json "test" script: this runs after `npm run build`.
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
