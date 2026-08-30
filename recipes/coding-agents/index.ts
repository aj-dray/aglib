/**
 * Any agent in the registry, inside your log.
 *
 * The thin end of the argument `vendored-agents` makes at the other. There
 * is one adapter, `aglib/harness/adapters/acp`, and this recipe is mostly a
 * table of argv — which is the point. Adding an agent costs a line.
 *
 * What you keep: the log, the sandbox, and a decision on every tool call.
 * What you give up, and the adapter says so rather than pretending otherwise:
 *
 *   - **Its tools are its own.** They cannot be removed, only refused. `decide`
 *     sees a title and raw arguments, because the protocol carries no schema.
 *   - **There is no system prompt.** The protocol has no field for one, so
 *     orientation leads the first message and nowhere else.
 *   - **`recovery: "none"`.** The agent owns its context; our entries describe
 *     what it did and cannot put it back mid-turn. `runAgent` closes an
 *     interrupted session rather than handing it out for ever.
 *
 * And the agent process is started *inside* the sandbox, not merely served by
 * it. A coding agent runs its own shell and delegates only the calls it
 * chooses to, so moving the process is the only way to move all of it.
 */
import { runAgent, type Agent } from "aglib";
import { createAcpHarness } from "aglib/harness/adapters/acp";
import { createSqliteStore } from "aglib/store/adapters/sqlite";
import { createLocalSandboxProvider } from "aglib/sandbox/adapters/local";
import { createDockerSandboxProvider } from "aglib/sandbox/adapters/docker";
import type { Sandbox } from "aglib/sandbox";
import { Database } from "bun:sqlite";
import { recipeMarker } from "../manifest.ts";
import { acpAgentFor, acpAgents, type AcpAgentRow } from "./agents.ts";

export const orientation =
  "You are working inside a sandbox for an application that keeps its own durable log of this session. "
  + "Be brief, say what you did, and do not ask for confirmation you cannot receive.";

export interface Choice {
  agent: string;
  sandbox: "local" | "docker";
  model?: string;
}

/**
 * Its containment, made explicit.
 *
 * `docker` needs an image the agent can actually start in — most of these rows
 * are `npx`, so the default alpine has no runtime for them. Named here rather
 * than defaulted quietly, because a container that cannot run the agent is a
 * failure worth reading.
 */
async function openSandbox(kind: Choice["sandbox"]): Promise<Sandbox> {
  const provider = kind === "docker"
    ? createDockerSandboxProvider({ image: process.env["AGLIB_DOCKER_IMAGE"] ?? "node:22-alpine" })
    : createLocalSandboxProvider({ root: process.cwd() });
  const sandbox = await provider.create({
    isolation: kind === "docker" ? "required" : "none",
    network: { mode: "unrestricted" },
  });
  if (!sandbox.ok) throw new Error(`sandbox (${kind}): ${sandbox.error.message}`);
  return sandbox.value;
}

/** What the row needs from the environment, passed through by name. */
function credentialsFor(row: AcpAgentRow): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of row.credential ?? []) {
    const value = process.env[name];
    if (value) out[name] = value;
  }
  return out;
}

export async function main(
  task: string,
  options: { choice?: Choice; write?: (line: string) => void } = {},
): Promise<string> {
  const choice = options.choice ?? { agent: "claude-code", sandbox: "local" as const };
  const write = options.write ?? ((line: string) => process.stdout.write(line));

  const row = acpAgentFor(choice.agent);
  if (!row) throw new Error(`Unknown agent '${choice.agent}'. One of: ${acpAgents.map((a) => a.id).join(", ")}`);
  // Reported before anything is started or billed. A row that says why it
  // cannot run is more useful than one quietly missing from the list.
  if (row.unavailable) throw new Error(`${row.title} is not available here: ${row.unavailable}`);

  const sandbox = await openSandbox(choice.sandbox);
  const agent: Agent = {
    id: `acp-${row.id}`,
    version: "1",
    // Recorded on the session, and deliberately not relied on: the protocol has
    // no system-prompt field, so what actually orients the agent is the first
    // message below.
    instructions: orientation,
    harness: createAcpHarness({
      id: row.id,
      agent: { command: row.command, env: credentialsFor(row) },
      sandbox,
      ...(row.mode ? { mode: row.mode } : {}),
      ...(choice.model ? { model: choice.model } : {}),
    }),
  };

  const database = new Database(":memory:");
  const store = createSqliteStore({ database });
  const sessionId = crypto.randomUUID();
  const run = runAgent({
    agent, store, sessionId, key: "me",
    // Orientation leads, because there is nowhere else for it to go.
    input: `${orientation}\n\n${task}`,
  });
  for await (const update of run) if (update.type === "text.delta") write(update.text);
  write("\n");

  const result = await run.result;
  await sandbox.close();
  await store.close();
  if (result.status !== "completed") {
    throw new Error(result.status === "failed" ? `run failed: ${result.error.message}` : `run ${result.status}`);
  }
  return sessionId;
}

/** `--agent codex --sandbox docker` — everything else is the task. */
export function parseArguments(argv: readonly string[]): { choice: Choice; task: string } {
  const flags = new Map<string, string>();
  const words: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument.startsWith("--")) { flags.set(argument.slice(2), argv[index + 1] ?? ""); index += 1; }
    else words.push(argument);
  }
  const model = flags.get("model");
  return {
    choice: {
      agent: flags.get("agent") ?? "claude-code",
      sandbox: (flags.get("sandbox") ?? "local") as Choice["sandbox"],
      ...(model ? { model } : {}),
    },
    task: words.join(" "),
  };
}

if (import.meta.main) {
  const { choice, task } = parseArguments(process.argv.slice(2));
  console.error(`· acp · ${choice.agent} · sandbox ${choice.sandbox}`);
  await main(task, { choice });
  console.log(recipeMarker("coding-agents"));
}
