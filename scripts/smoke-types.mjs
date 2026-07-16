// Verifies the "types" condition of the exports map — the piece
// smoke-esm.mjs/smoke-cjs.cjs CANNOT check, since Node's module loader never
// reads "types" (only tsc does). `npm pack`s the REAL tarball (exercising the
// "files" allowlist too, not just dist/ read directly) and `npm install`s it
// into a scratch project, then type-checks a throwaway consumer file that
// imports the package by name under both the "import" and "require"
// resolution modes — proving dist/esm/index.d.ts and dist/cjs/index.d.ts both
// actually resolve and are structurally sound for a real TypeScript consumer.
//
// This is a package-name import (`from "hiapi"`), NOT self-reference: tsc's
// self-reference algorithm (unlike Node's own runtime resolver, which does
// support it) turned out — verified interactively — to not resolve a
// same-name package from a loose, non-project subdirectory compile, so a
// real install is both simpler and a more faithful test of what a consumer
// actually gets.
//
// Also exercises the fix for a real tsc error this SDK shipped with earlier:
// a plain named `interface` (no index signature) must be assignable to
// `input` without a cast, including through a pre-declared
// `CreateTaskParams`-typed variable — see tests/tasks.test.ts's "named
// interface" test for the runtime half of that same regression check.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// `.pathname`, not used here on purpose: it keeps percent-encoding (e.g. a
// space becomes `%20`) and yields a leading-slash path on Windows (e.g.
// `/C:/...`) that isn't a valid filesystem path — fileURLToPath() decodes
// and normalizes correctly on every platform.
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
// tsc's own JS entry point, invoked via `node`, not the `.bin/tsc` shim —
// avoids the Windows `.cmd`-shim problem without needing `shell: true` at
// all (which — verified — has its OWN pitfall: execFileSync with an args
// array and shell:true naively space-joins arguments into one command-line
// string without shell-safe quoting, so a path containing a space, common on
// Windows, would be split into two arguments instead of staying intact).
const TSC_JS = join(PACKAGE_ROOT, "node_modules/typescript/lib/tsc.js");
// npm ships bundled with Node itself, as a real JS entry point — just like
// tsc above, this lets every npm call below go through `node` directly, with
// argv passed as a genuine array and NO shell or command-line re-parsing of
// any kind involved, so it's exempt from every quoting/escaping concern a
// string-based invocation would have (paths containing spaces, `&`, `|`,
// `^`, `%`, `<`, `>`, parens — all just inert characters in one argv slot).
// `npm_execpath` (set by npm itself whenever it invokes a script — true for
// this one, run via `npm test`/`npm run smoke`) is the most reliable source,
// since it names the exact npm build already running; the relative-to-
// `process.execPath` layouts below are the documented fallback for direct,
// non-npm-run invocation (this script only needs them when developing it
// standalone), covering both the POSIX layout (verified on this machine) and
// the Windows one (`node_modules/npm/bin/npm-cli.js` sits next to node.exe
// on an official Windows install, not under a sibling `lib/`).
function resolveNpmCli() {
  const fromEnv = process.env.npm_execpath;
  if (fromEnv && existsSync(fromEnv)) {
    return fromEnv;
  }
  const nodeDir = dirname(process.execPath);
  const candidates = [
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  return candidates.find(existsSync);
}
const NPM_CLI = resolveNpmCli();

// Fallback for the rare install layout where no npm-cli.js is discoverable
// at all: Node's own docs say ".bat and .cmd files are not executable on
// their own without a terminal, and therefore cannot be launched using
// child_process.execFile()" on Windows — spawning cmd.exe with `/c` is the
// documented workaround, NOT `shell: true` (Node deprecated passing an
// `args` array together with `shell: true` as of v22.15.0/v23.11.0,
// precisely because that combination does a naive, unsafe join rather than
// real shell-quoting). cmd.exe's own `/c` line reparsing is still not
// argv-safe even with per-argument quoting (it separately treats `&`, `|`,
// `^`, `%`, `<`, `>` and parens as special) — this path is a last resort,
// not the primary mechanism, precisely because that can't be made fully
// safe from here.
function runNpmViaCmdExe(args, options) {
  const NPM = "npm.cmd";
  const quoted = args.map((a) => (/[\s&|^%<>()]/.test(a) ? `"${a}"` : a));
  return execFileSync("cmd.exe", ["/c", NPM, ...quoted], options);
}

function runNpm(args, options) {
  if (NPM_CLI) {
    return execFileSync(process.execPath, [NPM_CLI, ...args], options);
  }
  if (process.platform !== "win32") {
    return execFileSync("npm", args, options);
  }
  return runNpmViaCmdExe(args, options);
}

const CONSUMER_SOURCE = `
import { HiAPI, type CreateTaskParams } from "hiapi";

interface SeedanceInput {
  prompt: string;
  resolution: string;
}

async function run(): Promise<void> {
  const client = new HiAPI({ apiKey: "sk-..." });
  const input: SeedanceInput = { prompt: "x", resolution: "1080p" };

  // Direct call site — plain \`object\` constraint, no cast needed.
  const created = await client.tasks.create({ model: "seedance-2-0", input });

  // Pre-declared variable typed as the exported CreateTaskParams — a generic
  // default type parameter would NOT fix this (inference only applies at a
  // call site), which is why input is plain \`object\` rather than generic.
  const params: CreateTaskParams = { model: "seedance-2-0", input, storage: "persistent" };
  await client.tasks.create(params);

  // Same named-interface-without-index-signature shape, through the
  // \`callback\` field this time (it had its own, separate regression).
  interface CallbackConfig {
    url: string;
    when: "final";
  }
  const callback: CallbackConfig = { url: "https://example.com/cb", when: "final" };
  await client.tasks.create({ model: "seedance-2-0", input, callback });

  console.log(created.taskId);
}
void run();
`;

const dir = mkdtempSync(join(tmpdir(), "hiapi-smoke-types-"));
try {
  const tarballName = runNpm(["pack", "--silent", `--pack-destination=${dir}`], {
    cwd: PACKAGE_ROOT,
  })
    .toString()
    .trim();
  const tarballPath = join(dir, tarballName);

  // "type": "module" makes the plain .ts file default to ESM (the "import"
  // condition); the .cts file below forces CJS regardless of this field (a
  // TypeScript file-extension convention), covering the "require" condition
  // with the same package.json.
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "smoke-consumer", private: true, type: "module" }),
  );
  runNpm(["install", "--no-audit", "--no-fund", "--silent", tarballPath], { cwd: dir });

  const tscArgs = [
    TSC_JS,
    "--noEmit",
    "--strict",
    "--skipLibCheck",
    "--module",
    "nodenext",
    "--moduleResolution",
    "nodenext",
    "--target",
    "es2022",
  ];

  // (a) "import" + "types" condition, under an ESM-boundary package.json.
  writeFileSync(join(dir, "consumer-esm.ts"), CONSUMER_SOURCE);
  execFileSync(process.execPath, [...tscArgs, "consumer-esm.ts"], { cwd: dir, stdio: "pipe" });

  // (b) "require" + "types" condition — same source, CJS resolution mode.
  writeFileSync(join(dir, "consumer-cjs.cts"), CONSUMER_SOURCE);
  execFileSync(process.execPath, [...tscArgs, "consumer-cjs.cts"], { cwd: dir, stdio: "pipe" });

  console.log('smoke:types ok — both exports map "types" conditions resolve for a real npm install');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
