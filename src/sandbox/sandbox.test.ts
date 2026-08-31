import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSandboxConformance } from "./conformance.js";
import { createLocalSandboxProvider } from "./adapters/local.js";

const root = await mkdtemp(join(tmpdir(), "aglib-local-"));

for (const item of defineSandboxConformance({
  provider: () => createLocalSandboxProvider({ root }),
  // The honest description of a directory on the operator's own machine, and
  // the reason this provider refuses `isolation: "required"`.
  isolation: "none",
  network: { mode: "unrestricted" },
  refuses: [{ mode: "deny-all" }, { mode: "web-allowlist", hosts: ["api.example.com"] }],
})) {
  test(`local: ${item.name}`, item.run);
}

test("local: the host's authority is what a command has, and it says so", async () => {
  const created = await createLocalSandboxProvider({ root }).create({
    isolation: "none", network: { mode: "unrestricted" },
  });
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  // Not a sandbox and not described as one. The port's `isolation` field is
  // what a caller reads before deciding to run something it does not trust.
  expect(created.value.isolation).toBe("none");
  await created.value.close();
});

afterAll(async () => { await rm(root, { recursive: true, force: true }); });
