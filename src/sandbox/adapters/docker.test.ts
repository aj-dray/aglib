import { test } from "bun:test";
import { defineSandboxConformance } from "../conformance.js";
import { createDockerSandboxProvider } from "./docker.js";

/**
 * The same suite the host provider answers, against a real container.
 *
 * Gated rather than mocked. A fake daemon would prove that this file calls the
 * functions this file calls; what needs proving is that a container answers the
 * port the same way a directory does, and only a container can say. So the
 * cases run wherever a daemon and the image are already there, and are skipped
 * — by name, so the skip is visible — wherever they are not.
 */
const image = process.env["AGLIB_DOCKER_IMAGE"] ?? "alpine:3";

const ran = async (argv: readonly string[]): Promise<boolean> => {
  try {
    const probe = Bun.spawn(["docker", ...argv], { stdout: "ignore", stderr: "ignore" });
    return (await probe.exited) === 0;
  } catch {
    return false;
  }
};

const usable = (await ran(["info"])) && (await ran(["image", "inspect", image]));

for (const item of defineSandboxConformance({
  provider: () => createDockerSandboxProvider({ image, lifetimeSeconds: 120 }),
  // The claim the local provider cannot make, and the reason this adapter is
  // in the package: a caller asking for isolation is given some.
  isolation: "container",
  network: { mode: "unrestricted" },
  refuses: [{ mode: "web-allowlist", hosts: ["api.example.com"] }],
})) {
  const name = `docker: ${item.name}`;
  if (usable) test(name, item.run, 60_000);
  else test.skip(`${name} (no daemon, or ${image} is not pulled)`, item.run);
}

// `deny-all` is a posture this provider does enforce, so it is created rather
// than refused — the suite covers only what a provider says it cannot do.
const network = usable ? test : test.skip;
network("docker: a container that was denied the network has none", async () => {
  const created = await createDockerSandboxProvider({ image, lifetimeSeconds: 120 })
    .create({ isolation: "required", network: { mode: "deny-all" } });
  if (!created.ok) throw new Error(`${created.error.code}: ${created.error.message}`);
  try {
    const ping = await created.value.exec({ command: "ping -c1 -W1 1.1.1.1" });
    if (!ping.ok) throw new Error(`${ping.error.code}: ${ping.error.message}`);
    // The posture was asked for out loud, so it is enforced out loud: the
    // command runs and fails, rather than the request being quietly dropped.
    if (ping.value.exitCode === 0) throw new Error("a deny-all container reached the network");
  } finally {
    await created.value.close();
  }
}, 60_000);
