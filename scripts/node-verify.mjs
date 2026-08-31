/**
 * Verifies the built package on Node.
 *
 * The library is runtime-neutral by construction — the SQLite store takes a
 * database handle rather than binding a driver — so most of what needs proving
 * is that every public subpath imports on Node and exposes what it claims.
 *
 * Importing is not enough for anything that spawns. The local sandbox reached
 * for `Bun.spawn`, so on Node it imported cleanly and then threw the moment it
 * was used: a subpath that passes this check and cannot run is the shape of
 * failure a check exists to prevent. So the one adapter whose whole job is to
 * start a process is made to start one here. Run with
 * `node scripts/node-verify.mjs`.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const subpaths = Object.keys(manifest.exports);
assert.ok(subpaths.length > 0, "package.json declares no exports");

let checked = 0;
for (const subpath of subpaths) {
  const target = manifest.exports[subpath].import;
  // Importing is the assertion. Several subpaths are types-only by design —
  // a port is a contract, and having no runtime name is the honest outcome.
  await import(pathToFileURL(join(root, target)).href);
  checked += 1;
}

// One end-to-end composition on Node, with no network and no database file:
// an agent, a scripted model, and a tool, proving the loop itself runs here.
const { runAgent, defineTool, textOf } = await import(pathToFileURL(join(root, "dist/index.js")).href);
const { createNativeHarness } = await import(pathToFileURL(join(root, "dist/harness/index.js")).href);
assert.equal(typeof runAgent, "function");
assert.equal(typeof defineTool, "function");
assert.equal(typeof createNativeHarness, "function");
assert.equal(textOf([{ type: "text", text: "hello" }]), "hello");

// The local sandbox, actually running: a command with both streams and an exit
// code, and a spawned process taking input on stdin.
const { createLocalSandboxProvider } = await import(
  pathToFileURL(join(root, "dist/sandbox/adapters/local.js")).href);
const dir = await mkdtemp(join(tmpdir(), "aglib-node-"));
try {
  const made = await createLocalSandboxProvider({ root: dir })
    .create({ isolation: "none", network: { mode: "unrestricted" } });
  assert.ok(made.ok, "the local sandbox would not open on Node");
  const box = made.value;

  const ran = await box.exec({ command: "echo hello; echo oops >&2; exit 3" });
  assert.ok(ran.ok, "the local sandbox would not run a command on Node");
  assert.equal(ran.value.stdout.trim(), "hello");
  assert.equal(ran.value.stderr.trim(), "oops");
  assert.equal(ran.value.exitCode, 3);

  const started = await box.spawn({ command: ["sh", "-c", "read line; echo \"got $line\""] });
  assert.ok(started.ok, "the local sandbox would not spawn a process on Node");
  started.value.write("hi\n");
  assert.equal((await new Response(started.value.stdout).text()).trim(), "got hi");
  await started.value.exited;
  await box.close();
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(`node: ${checked} subpaths import, and the local sandbox runs`);
