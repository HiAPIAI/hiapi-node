// CJS counterpart of smoke-esm.mjs — same self-reference trick, exercising
// the "require" condition of the exports map and dist/cjs/package.json (the
// `{"type":"commonjs"}` stub the build writes so Node treats dist/cjs/*.js as
// CommonJS despite the package's own top-level `"type": "module"`).
"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");

const { APIError, HiAPI, HiAPIError, Task, VERSION, verifyWebhook } = require("hiapi");

const pkg = require(path.join(__dirname, "..", "package.json"));
assert.equal(VERSION, pkg.version);
assert.equal(pkg.name, "hiapi");
assert.equal(typeof HiAPI, "function");
assert.equal(typeof verifyWebhook, "function");
assert.ok(new HiAPIError("x") instanceof Error);
assert.ok(APIError.prototype instanceof HiAPIError);
assert.equal(typeof Task, "function");

const client = new HiAPI({ apiKey: "sk-smoke-test" });
assert.equal(client.baseUrl, "https://api.hiapi.ai/v1");

console.log("smoke:cjs ok —", VERSION);
