import { expect, test } from "bun:test";
import { acpAgentFor, acpAgents } from "./agents.ts";
import { main, orientation, parseArguments } from "./index.ts";

/** These cases assert on the refusal, not the screen. */
const quiet = { write: () => {}, status: () => {} };


test("an agent that cannot run says why, before anything is started or billed", async () => {
  const row = acpAgentFor("opencode");
  expect(row?.unavailable).toBeTruthy();
  // No sandbox is opened and no process is spawned: the refusal comes first.
  await expect(main("go", { choice: { agent: "opencode", sandbox: "local" }, sink: quiet }))
    .rejects.toThrow(/not available here/);
});

test("an agent nobody has heard of is refused by name, with the list", async () => {
  await expect(main("go", { choice: { agent: "nope", sandbox: "local" }, sink: quiet }))
    .rejects.toThrow(/Unknown agent 'nope'/);
});

test("every row is argv, because that is all the protocol lets you configure", () => {
  // The shape of this table is the recipe's claim. A row offering a prompt, a
  // tool list or a transcript would be describing a control point ACP does not
  // have — see `vendored-agents` for the route that does.
  for (const row of acpAgents) {
    expect(row.command.length).toBeGreaterThan(0);
    expect(row).not.toHaveProperty("systemPrompt");
    expect(row).not.toHaveProperty("tools");
  }
});

test("orientation leads the message, because there is nowhere else to put it", () => {
  const { choice, task } = parseArguments(["--agent", "codex", "list", "the", "files"]);
  expect(choice.agent).toBe("codex");
  expect(task).toBe("list the files");
  expect(orientation).toContain("sandbox");
});

/**
 * The protocol route, run.
 *
 * Needs somewhere for the agent's own requests to go, which is what the row's
 * `credential` names. Point `ANTHROPIC_BASE_URL` at a real provider or at
 * `serveAnthropicWire` from `vendored-agents` — this recipe does not know or
 * care which, and that is the point of naming environment rather than a
 * credential type.
 *
 * Two gates, like every live case here: `bun run check` is hermetic, and
 * starting an agent over `npx` costs a download and a provider call.
 */
const live = process.env["AGLIB_LIVE_ACP"] === "1"
  && (process.env["ANTHROPIC_BASE_URL"] ?? process.env["ANTHROPIC_API_KEY"]);
const liveTest = live ? test : test.skip;

liveTest("an agent started inside the sandbox lands in our log", async () => {
  const said: string[] = [];
  await main("Say the word pineapple and nothing else.", {
    choice: { agent: "claude-code", sandbox: "local" },
    sink: { write: (text) => said.push(text), status: () => {} },
  });
  expect(said.join("").toLowerCase()).toContain("pineapple");
}, 400_000);
