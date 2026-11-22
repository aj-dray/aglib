/**
 * Our agent, on a plan someone already pays for.
 *
 * A Claude or ChatGPT subscription is sold for the vendor's own program —
 * Claude Code, Codex — and that program is the only thing allowed to spend it.
 * So the vendor's program runs the loop, and everything else is ours: the
 * instructions, the tools, where the tools run, and the log. See the README for
 * what that trade costs.
 */
import { defineTool, runAgent, textOf, type Tool } from "aglib";
import type { Harness } from "aglib/harness";
import { createClaudeAgentSdkHarness, type ClaudeAgentSdkHarnessOptions } from "aglib/harness/adapters/claude-agent-sdk";
import { codexAccount, createCodexHarness, signInToCodex, type CodexHarnessOptions } from "aglib/harness/adapters/codex";
import { createLocalSandboxProvider } from "aglib/sandbox/adapters/local";
import { createSqliteStore } from "aglib/store/adapters/sqlite";
import type { Sandbox } from "aglib/sandbox";
import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { recipeMarker } from "../manifest.ts";

export type Vendor = "claude" | "codex";
export interface Choice { vendor: Vendor; model: string; effort?: "low" | "medium" | "high" | "xhigh" | "max"; connectors?: boolean }

/** Where each vendor keeps its sign-in and its sessions: under this recipe's own home, never the user's. */
export const home = process.env["AGLIB_SUBSCRIPTION_HOME"] ?? join(homedir(), ".aglib-subscription-agent");

/**
 * The process environment, built rather than inherited. Each vendor gets its
 * credential and the directories it keeps state in, and nothing else this
 * process happens to hold.
 */
export function environment(vendor: Vendor): Record<string, string> {
  const base = { PATH: process.env["PATH"] ?? "", HOME: join(home, vendor) };
  if (vendor === "codex") return { ...base, CODEX_HOME: join(home, "codex") };
  const token = process.env["CLAUDE_CODE_OAUTH_TOKEN"], key = process.env["ANTHROPIC_API_KEY"];
  return { ...base, CLAUDE_CONFIG_DIR: join(home, "claude"), ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : key ? { ANTHROPIC_API_KEY: key } : {}) };
}

/** One hand, in a sandbox of ours: the vendor's own shell is switched off, so this is the only one. */
export const shell = (sandbox: Sandbox): Tool => defineTool({
  name: "bash",
  description: "Run a shell command in the working directory.",
  schema: z.object({ command: z.string() }),
  execute: async ({ command }, context) => {
    const output = await sandbox.exec({ command, signal: context.signal });
    if (!output.ok) return { content: `Command failed: ${output.error.message}`, isError: true };
    const { stdout, stderr, exitCode } = output.value;
    return { content: [stdout, stderr].filter(Boolean).join("\n") || `(no output, exit ${exitCode})`, ...(exitCode === 0 ? {} : { isError: true }) };
  },
});

export function harnessFor(choice: Choice, seams: { query?: ClaudeAgentSdkHarnessOptions["query"]; connect?: CodexHarnessOptions["connect"] } = {}): Harness {
  const cwd = join(home, "work");
  return choice.vendor === "claude"
    ? createClaudeAgentSdkHarness({ model: choice.model, cwd, env: environment("claude"), ...(choice.effort ? { effort: choice.effort } : {}), ...(choice.connectors ? { connectors: true } : {}), ...(seams.query ? { query: seams.query } : {}) })
    : createCodexHarness({ model: choice.model, cwd, env: environment("codex"), ...(choice.effort ? { effort: choice.effort } : {}), ...(choice.connectors ? { connectors: true } : {}), ...(seams.connect ? { connect: seams.connect } : {}) });
}

export async function main(task: string, options: { choice: Choice; harness?: Harness; sessionId?: string; write?: (text: string) => void }): Promise<string> {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  await mkdir(join(home, "work"), { recursive: true });
  const database = new Database(join(home, "log.db"), { create: true });
  const store = createSqliteStore({ database });
  const created = await createLocalSandboxProvider({ root: process.cwd() }).create({ isolation: "none", network: { mode: "unrestricted" } });
  if (!created.ok) throw new Error(created.error.message);
  const sandbox = created.value;
  const sessionId = options.sessionId ?? crypto.randomUUID();
  try {
    const run = runAgent({
      agent: { id: "subscription-agent", version: "1", instructions: "You are a careful assistant. Use bash to look before you answer.", tools: [shell(sandbox)], harness: options.harness ?? harnessFor(options.choice) },
      store, sessionId, input: task,
    });
    for await (const update of run) if (update.type === "entry" && update.entry.type === "tool.started") write(`· ${update.entry.callId}\n`);
    const result = await run.result;
    if (result.status !== "completed") throw new Error(result.status === "failed" ? result.error.message : result.status);
    write(`${textOf(result.output)}\n`);
    return sessionId;
  } finally {
    await sandbox.close();
    await store.close();
  }
}

export function parseArguments(argv: readonly string[]): { choice: Choice; task: string; signIn: boolean } {
  const rest = [...argv];
  let vendor: Vendor = "claude", model: string | undefined, effort: Choice["effort"], signIn = false, connectors = false;
  while (rest[0]?.startsWith("--")) {
    const flag = rest.shift()!;
    if (flag === "--vendor") { const value = rest.shift(); if (value !== "claude" && value !== "codex") throw new Error("--vendor is claude or codex"); vendor = value; }
    else if (flag === "--model") model = rest.shift();
    else if (flag === "--effort") effort = rest.shift() as Choice["effort"];
    else if (flag === "--sign-in") signIn = true;
    else if (flag === "--connectors") connectors = true;
    else throw new Error(`Unknown flag ${flag}`);
  }
  return { choice: { vendor, model: model ?? (vendor === "claude" ? "claude-sonnet-5-5" : "gpt-6"), ...(effort ? { effort } : {}), ...(connectors ? { connectors } : {}) }, task: rest.join(" "), signIn };
}

if (import.meta.main) {
  const { choice, task, signIn } = parseArguments(process.argv.slice(2));
  if (signIn) {
    if (choice.vendor !== "codex") throw new Error("Claude Code signs in with `claude setup-token`; put the token in CLAUDE_CODE_OAUTH_TOKEN.");
    const started = await signInToCodex({ env: environment("codex") });
    if (!started.ok) throw new Error(started.error.message);
    console.log(`Open ${started.value.verificationUrl} and enter ${started.value.userCode}`);
    const done = await started.value.completed;
    if (!done.ok) throw new Error(done.error.message);
    console.log(JSON.stringify(await codexAccount({ env: environment("codex") })));
  } else {
    console.error(`· ${choice.vendor} · ${choice.model}`);
    await main(task || "What is in this directory?", { choice });
  }
  console.log(recipeMarker("subscription-agent"));
}
