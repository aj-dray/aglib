import { test } from "bun:test";
import { defineSandboxConformance } from "aglib/sandbox/conformance";
import { createDaytonaProvider } from "./daytona.ts";
import { secret } from "./credentials.ts";

/**
 * The Daytona provider, held to the same contract as the two in the package.
 *
 * A hosted box is the case the suite is really for. The differences that matter
 * between a container in someone else's datacentre and a directory on this
 * machine are the ones nobody notices until the agent is remote: whether a
 * missing file is `not-found`, whether a non-zero exit is an outcome, whether a
 * closed box refuses. Reading the port cannot tell you; running it can.
 *
 * Skipped without the credential, because a recipe test requires no service.
 */
// Two gates, not one. A connected machine must not start billing boxes because
// somebody ran the gate: `bun run check` is hermetic, and this is opt-in.
const apiKey = process.env["AGLIB_LIVE_SANDBOX"] === "1" ? secret("daytona") : undefined;

for (const item of defineSandboxConformance({
  provider: () => createDaytonaProvider({
    apiKey: apiKey!,
    ...(process.env["DAYTONA_SNAPSHOT"] ? { snapshot: process.env["DAYTONA_SNAPSHOT"] } : {}),
    // Every case takes its own box, and a stopped box still holds its whole
    // disk allocation against the account.
    onClose: "delete",
  }),
  isolation: "container",
  network: { mode: "unrestricted" },
  // Daytona reports one combined stream, and this adapter says so rather than
  // inventing a split. An application parsing stderr here gets nothing.
  streams: "combined",
  // The reason this adapter exists in a service that runs other people's code.
  // Daytona holds the value and gives the box `dtn_secret_<id>`, substituting
  // at egress for the hosts the secret named — so the suite checks that a
  // process in the box genuinely cannot read what it is spending.
  secrets: "substituted",
  // Nothing listed: this provider carries every posture the port names through
  // to the box, so there is none it has to refuse.
})) {
  const name = `daytona: ${item.name}`;
  if (apiKey) test(name, item.run, 120_000);
  else test.skip(`${name} (set AGLIB_LIVE_SANDBOX=1 and connect daytona)`, item.run);
}
