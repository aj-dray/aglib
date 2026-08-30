import { expect, test } from "bun:test";
import { acpAgentFor, acpAgents } from "./agents.ts";
import { main, orientation, parseArguments } from "./index.ts";

test("an agent that cannot run says why, before anything is started or billed", async () => {
  const row = acpAgentFor("opencode");
  expect(row?.unavailable).toBeTruthy();
  // No sandbox is opened and no process is spawned: the refusal comes first.
  await expect(main("go", { choice: { agent: "opencode", sandbox: "local" }, write: () => {} }))
    .rejects.toThrow(/not available here/);
});

test("an agent nobody has heard of is refused by name, with the list", async () => {
  await expect(main("go", { choice: { agent: "nope", sandbox: "local" }, write: () => {} }))
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
