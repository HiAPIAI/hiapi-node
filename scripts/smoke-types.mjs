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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// `.pathname`, not used here on purpose: it keeps percent-encoding (e.g. a
// space becomes `%20`) and yields a leading-slash path on Windows (e.g.
// `/C:/...`) that isn't a valid filesystem path — fileURLToPath() decodes
// and normalizes correctly on every platform.
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSC = join(PACKAGE_ROOT, "node_modules/.bin/tsc");

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

  console.log(created.taskId);
}
void run();
`;

// `shell: true` on every call below: on Windows, locally-installed binaries
// (npm, tsc) are `.cmd`/`.ps1` shims that `execFileSync` cannot run directly
// without a shell (unlike POSIX, where the file itself is executable). Safe
// here — every argument is a hardcoded constant, never untrusted input.
const dir = mkdtempSync(join(tmpdir(), "hiapi-smoke-types-"));
try {
  const tarballName = execFileSync("npm", ["pack", "--silent", `--pack-destination=${dir}`], {
    cwd: PACKAGE_ROOT,
    shell: true,
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
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--silent", tarballPath], {
    cwd: dir,
    shell: true,
  });

  // (a) "import" + "types" condition, under an ESM-boundary package.json.
  writeFileSync(join(dir, "consumer-esm.ts"), CONSUMER_SOURCE);
  execFileSync(
    TSC,
    [
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--module",
      "nodenext",
      "--moduleResolution",
      "nodenext",
      "--target",
      "es2022",
      "consumer-esm.ts",
    ],
    { cwd: dir, stdio: "pipe", shell: true },
  );

  // (b) "require" + "types" condition — same source, CJS resolution mode.
  writeFileSync(join(dir, "consumer-cjs.cts"), CONSUMER_SOURCE);
  execFileSync(
    TSC,
    [
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--module",
      "nodenext",
      "--moduleResolution",
      "nodenext",
      "--target",
      "es2022",
      "consumer-cjs.cts",
    ],
    { cwd: dir, stdio: "pipe", shell: true },
  );

  console.log('smoke:types ok — both exports map "types" conditions resolve for a real npm install');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
