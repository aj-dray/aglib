import { expect, test } from "bun:test";
import { acpAgentFor, acpAgents } from "./agents.ts";
import { runCommand } from "./commands.ts";
import { main, orientation, parseArguments } from "./index.ts";

/** These cases assert on the refusal, not the screen. */
const quiet = { write: () => {}, status: () => {} };


test("every row is offered, because whether a binary is here is not this file's fact", () => {
  // There was an `unavailable` column, hardcoding one machine's setup into the
  // source. It was wrong about Cursor and about OpenCode inside a day. A row
  // that cannot start now fails when started, saying what the spawn said.
  for (const row of acpAgents) expect(row).not.toHaveProperty("unavailable");
  expect(acpAgentFor("opencode")).toBeTruthy();
});

test("an agent nobody has heard of is refused by name, with the list", async () => {
  await expect(main("go", { choice: { agent: "nope", sandbox: "local" }, sink: quiet }))
    .rejects.toThrow(/Unknown agent 'nope'/);
});

test("--set carries the agent's own option ids, because a flag per axis is a guess", () => {
  const { choice, task } = parseArguments(["--set", "effort=high", "--set", "fast=on", "count", "them"]);
  expect(choice.select).toEqual({ effort: "high", fast: "on" });
  expect(task).toBe("count them");
});

test("no row names an option, so a mode is reached the way every other one is", () => {
  // There was a `mode: "default"` on the Claude Code row, hardcoding one
  // agent's word for "ask before acting". A mode is published like anything
  // else, so `/options` and `--set` reach it and the table stays three fields.
  for (const row of acpAgents) {
    expect(row).not.toHaveProperty("mode");
    expect(Object.keys(row).every((key) => ["id", "command", "credential"].includes(key))).toBe(true);
  }
});

test("every row is argv, because that is all the protocol lets you configure", () => {
  // The shape of this table is the recipe's claim. A row offering a prompt, a
  // tool list or a transcript would be describing a control point ACP does not
  // have — see `vendored-agent` for the route that does.
  for (const row of acpAgents) {
    expect(row.command.length).toBeGreaterThan(0);
    expect(row).not.toHaveProperty("systemPrompt");
    expect(row).not.toHaveProperty("tools");
  }
});

test("orientation leads the message, because there is nowhere else to put it", () => {
  const { choice, task } = parseArguments(["--harness", "codex", "list", "the", "files"]);
  expect(choice.agent).toBe("codex");
  expect(task).toBe("list the files");
  expect(orientation).toContain("sandbox");
});

test("no harness on argv is a question, not a default", () => {
  // The choice is the whole point of the recipe, so it is asked rather than
  // made quietly. `chooseAgent` answers it at a terminal; a pipe takes the
  // first row and the banner says which.
  const { choice } = parseArguments(["list", "the", "files"]);
  expect(choice.agent).toBe("");
});

/**
 * The protocol route, run.
 *
 * Needs somewhere for the agent's own requests to go, which is what the row's
 * `credential` names. Point `ANTHROPIC_BASE_URL` at anything serving that wire
 * — this recipe does not know or care what, and that is the point of naming
 * environment rather than a credential type.
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

test("one list of what the agent published, and a number drills into it", () => {
  const lines: string[] = [];
  const sink = { write: () => {}, status: (line: string) => lines.push(line) };
  const choice = { agent: "claude-code", sandbox: "local" as const };
  // Claude Code's real five, measured. Three of these had no command when this
  // file named one axis at a time.
  const published = [
    { id: "mode", name: "Mode", category: "mode", current: "default",
      choices: [{ id: "auto", name: "Auto" }, { id: "default", name: "Manual" }] },
    { id: "effort", name: "Effort", category: "thought_level", current: "default",
      choices: [{ id: "default", name: "Default" }, { id: "high", name: "High" }] },
    { id: "fast", name: "Fast mode", category: "model_config", current: "off",
      choices: [{ id: "on", name: "On" }, { id: "off", name: "Off" }] },
  ];

  const listed = runCommand({ line: "/options", choice, sink, published });
  // Everything it published, with where each one stands.
  expect(lines.join("")).toContain("Mode");
  expect(lines.join("")).toContain("Fast mode");
  expect(lines.join("")).toContain("Manual");
  expect(listed.choosing?.category).toBe("options");

  lines.length = 0;
  const opened = runCommand({ line: "2", choice, sink, published, choosing: listed.choosing });
  // Drilling in is not choosing: no value is set by opening a list.
  expect(opened.set).toBeUndefined();
  expect(opened.choosing?.option).toBe("effort");
  expect(lines.join("")).toContain("2. High");

  const picked = runCommand({ line: "2", choice, sink, published, choosing: opened.choosing });
  // Keyed by the option's own id, so a category this file never named — `fast`,
  // `thought_level` — is applied by the same path.
  expect(picked.set).toEqual({ option: "effort", value: "high" });
  expect(picked.choosing).toBeNull();
});

test("an agent that published nothing says so rather than showing an empty menu", () => {
  const lines: string[] = [];
  const listed = runCommand({
    line: "/options",
    choice: { agent: "claude-code", sandbox: "local" as const },
    sink: { write: () => {}, status: (line: string) => lines.push(line) },
    published: [],
  });
  expect(listed.handled).toBe(true);
  expect(lines.join("")).toContain("nothing to change");
  expect(listed.choosing).toBeUndefined();
});


test("switching agent starts a new session, because the old one is not its own", () => {
  const lines: string[] = [];
  const sink = { write: () => {}, status: (line: string) => lines.push(line) };
  const choice = { agent: "codex", sandbox: "local" as const };

  const listed = runCommand({ line: "/harness", choice, sink });
  const picked = runCommand({ line: "4", choice, sink, choosing: listed.choosing });
  expect(picked.select).toEqual({ agent: "cursor" });
  // The promise the prompt makes, which the log enforces: a session belongs to
  // the agent that opened it, and `runAgent` answers a mismatch with a
  // conflict. Continuing on the same id failed exactly that way.
  expect(lines.join("")).toContain("will not have seen this conversation");
});
