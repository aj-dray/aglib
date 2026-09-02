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
import { runAgent, type Agent, type RunResult } from "aglib";
import { renderRun, type Sink } from "aglib/render";
import { terminalSink, turnsFrom } from "aglib/terminal";
import { runCommand } from "./commands.ts";
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
  /** Answer once and exit, for someone at a terminal who wants the script behaviour. */
  once?: boolean;
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
  options: { choice?: Choice; sink?: Sink; turns?: AsyncIterable<string> } = {},
): Promise<string> {
  const choice = options.choice ?? { agent: "claude-code", sandbox: "local" as const };
  const sink: Sink = options.sink ?? terminalSink();

  const rowFor = (id: string) => {
    const found = acpAgentFor(id);
    if (!found) throw new Error(`Unknown agent '${id}'. One of: ${acpAgents.map((a) => a.id).join(", ")}`);
    // Reported before anything is started or billed. A row that says why it
    // cannot run is more useful than one quietly missing from the list.
    if (found.unavailable) throw new Error(`${found.title} is not available here: ${found.unavailable}`);
    return found;
  };
  rowFor(choice.agent);

  const sandbox = await openSandbox(choice.sandbox);

  // Held for the life of this process, and no longer than that. The agent owns
  // its context — that is what `recovery: "none"` means — so continuing is
  // handing back the name it knows the conversation by, which the protocol
  // answers with `session/load`. Where that name lives across a restart is a
  // question this recipe does not answer, because its store is in memory.
  let vendorSessionId: string | undefined;

  const agentFor = (): Agent => {
    const row = rowFor(choice.agent);
    return {
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
      ...(vendorSessionId ? { resume: vendorSessionId } : {}),
      onSession: (id) => { vendorSessionId = id; },
    }),
  };
  };

  const database = new Database(":memory:");
  const store = createSqliteStore({ database });
  const sessionId = crypto.randomUUID();
  let result: RunResult | undefined;
  let first = true;
  for await (const input of options.turns ?? [task]) {
    // Rebuilt each turn, because `resume` is only known after the first one has
    // told us what the agent calls this conversation.
    result = await renderRun(runAgent({
      agent: agentFor(), store, sessionId, key: "me",
      // Orientation leads on the first turn, because there is nowhere else for
      // it to go. Repeating it every turn would be the same words again to an
      // agent that already has them.
      input: first ? `${orientation}\n\n${input}` : input,
    }), sink);
    first = false;

  }

  await sandbox.close();
  await store.close();
  if (result && result.status !== "completed") {
    throw new Error(result.status === "failed" ? `run failed: ${result.error.message}` : `run ${result.status}`);
  }
  return sessionId;
}

/** `--agent codex --sandbox docker` — everything else is the task. */
export function parseArguments(argv: readonly string[]): { choice: Choice; task: string } {
  // Flags taking no value must be named, or `--once "do the thing"` swallows
  // the task as `once`'s argument and the agent is asked nothing.
  const valueless = new Set(["once"]);
  const flags = new Map<string, string>();
  const words: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) { words.push(argument); continue; }
    const name = argument.slice(2);
    if (valueless.has(name)) { flags.set(name, "true"); continue; }
    flags.set(name, argv[index + 1] ?? "");
    index += 1;
  }
  const model = flags.get("model");
  return {
    choice: {
      agent: flags.get("agent") ?? "claude-code",
      sandbox: (flags.get("sandbox") ?? "local") as Choice["sandbox"],
      ...(model ? { model } : {}),
      ...(flags.has("once") ? { once: true } : {}),
    },
    task: words.join(" "),
  };
}

if (import.meta.main) {
  const { choice, task } = parseArguments(process.argv.slice(2));
  console.error(`· acp · ${choice.agent} · sandbox ${choice.sandbox}`);
  await main(task, { choice, turns: turnsFrom({ task, once: choice.once === true }).lines });
  console.log(recipeMarker("coding-agents"));
}
