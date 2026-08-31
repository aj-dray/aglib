/**
 * Any agent in the registry, inside your log.
 *
 * The thin end of the argument `vendored-agent` makes at the other. There
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
import { runAgent, type Agent, type Decide, type RunResult } from "aglib";
import { renderRun, type Sink } from "aglib/render";
import { terminalSink, turnsFrom } from "aglib/terminal";
import { runCommand, type Choosing } from "./commands.ts";
import { acpOptions, createAcpHarness, type AcpConfigOption } from "aglib/harness/adapters/acp";
import { createSqliteStore } from "aglib/store/adapters/sqlite";
import { createLocalSandboxProvider } from "aglib/sandbox/adapters/local";
import { createDockerSandboxProvider } from "aglib/sandbox/adapters/docker";
import type { Sandbox } from "aglib/sandbox";
import { Database } from "bun:sqlite";
import { recipeMarker } from "../manifest.ts";
import { createInterface } from "node:readline";
import { acpAgentFor, acpAgents, type AcpAgentRow } from "./agents.ts";

export const orientation =
  "You are working inside a sandbox for an application that keeps its own durable log of this session. "
  + "Be brief, say what you did, and do not ask for confirmation you cannot receive.";

export interface Choice {
  agent: string;
  sandbox: "local" | "docker";
  /** Options the agent published and the operator picked, by the agent's own ids. */
  select?: Readonly<Record<string, string>>;
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
    // Debian rather than alpine, and measured rather than assumed: every row
    // here is `npx`, and the agents run their own shell inside the box. On
    // `node:22-alpine` Claude Code starts, is contained, and cannot act —
    // "No suitable shell found. Claude CLI requires a Posix shell".
    ? createDockerSandboxProvider({ image: process.env["AGLIB_DOCKER_IMAGE"] ?? "node:22" })
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
  const choice = options.choice ?? { agent: acpAgents[0]!.id, sandbox: "local" as const };
  const sink: Sink = options.sink ?? terminalSink();

  const rowFor = (id: string) => {
    const found = acpAgentFor(id);
    if (!found) throw new Error(`Unknown agent '${id}'. One of: ${acpAgents.map((a) => a.id).join(", ")}`);
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
  // What the agent said it offers, from its last `session/new`. Empty until it
  // has opened one, which is why `/model` before the first turn says so rather
  // than showing an empty menu.
  let published: readonly AcpConfigOption[] = [];

  /**
   * Ask the agent what it offers, before anything is asked of it.
   *
   * `/options` used to answer "nothing yet" until after the first message,
   * because ACP publishes on `session/new` and a session opened on the first
   * prompt. A spawn and a handshake buy the menu up front — and say so now
   * rather than on the first turn if the agent cannot start at all.
   */
  const offered = async () => {
    const row = rowFor(choice.agent);
    const asked = await acpOptions({ agent: { command: row.command, env: credentialsFor(row) }, sandbox });
    published = asked.ok ? asked.value : [];
    if (!asked.ok) (sink.status ?? sink.write)(`· ${choice.agent} did not open: ${asked.error.message}\n`);
  };
  let choosing: Choosing | null = null;

  /**
   * Where the operator's rule goes, and what it gets to see.
   *
   * Named here because the README used to claim "a decision on every tool call"
   * while passing nothing, and the adapter allows by default — a claim the code
   * did not keep. What arrives over this protocol is a title and raw arguments:
   * the agent publishes no schema, so there is nothing to validate against and
   * a rule can only match on what it recognises.
   *
   * The shipped rule executes everything, deliberately. A recipe does not know
   * an operator's policy, and inventing one here would be a demonstration of
   * this file's opinion rather than of the seam. Replace the body; the call is
   * already routed through it.
   */
  const decide: Decide = () => ({ action: "execute" });

  const agentFor = (): Agent => {
    const row = rowFor(choice.agent);
    return {
    id: `acp-${row.id}`,
    version: "1",
    decide,
    // Recorded on the session, and deliberately not relied on: the protocol has
    // no system-prompt field, so what actually orients the agent is the first
    // message below.
    instructions: orientation,
    harness: createAcpHarness({
      id: row.id,
      agent: { command: row.command, env: credentialsFor(row) },
      sandbox,
      // Everything configurable goes through one generic door. This recipe
      // names no option: what an agent offers arrives on `onConfig`, and what
      // the operator picked is keyed by the agent's own ids.
      ...(choice.select ? { select: choice.select } : {}),
      onConfig: (offered) => { published = offered; },
      ...(vendorSessionId ? { resume: vendorSessionId } : {}),
      onSession: (id) => { vendorSessionId = id; },
    }),
  };
  };

  const database = new Database(":memory:");
  const store = createSqliteStore({ database });
  // Not const, because switching agent starts a new one. A session in the log
  // belongs to the agent that opened it — `runAgent` refuses a mismatch with a
  // conflict — and that refusal is right: `recovery: "none"` means a vendor
  // owns its context, so there is no sense in which cursor could continue a
  // conversation codex had. The switch says as much before it happens.
  let sessionId = crypto.randomUUID();
  let result: RunResult | undefined;
  let first = true;
  await offered();
  for await (const input of options.turns ?? [task]) {
    // A line beginning with `/` is for the terminal, not the agent — and so is
    // a bare number answering a list one of them printed. Neither reaches the log.
    const command = runCommand({ line: input, choice, sink, published, choosing });
    if (command.handled) {
      if (command.choosing !== undefined) choosing = command.choosing;
      // Keyed by the agent's own option id, so a category this recipe has never
      // heard of is applied the same way as the two it names.
      if (command.set) choice.select = { ...choice.select, [command.set.option]: command.set.value };
      if (command.select) {
        Object.assign(choice, command.select);
        // A different agent is a different conversation: it owns its context,
        // and the one we are about to start has not seen this one. So the
        // vendor's session name goes with the agent that issued it, and what
        // the old one published is not what the new one offers.
        if (command.select.agent) {
          sessionId = crypto.randomUUID();
          vendorSessionId = undefined;
          first = true;
          // What the last agent offered is not what this one does.
          await offered();
        }
      }
      continue;
    }
    choosing = null;
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

/**
 * Which agent runs, when nobody said.
 *
 * Asked rather than defaulted, because the whole point of this recipe is that
 * the choice is one line of argv and there are four of them. A pipe cannot
 * answer a question, so a non-terminal takes the first row that can run and
 * says which on the banner.
 *
 * Its own readline, closed before `turnsFrom` opens one: two interfaces over
 * the same stdin at once is a fight, and one after the other is not.
 */
async function chooseAgent(): Promise<string> {
  const rows = acpAgents;
  if (!process.stdin.isTTY) return rows[0]!.id;

  for (const [index, row] of rows.entries()) {
    process.stderr.write(`  ${String(index + 1).padStart(2)}. ${row.id}\n`);
  }

  const reader = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((resolve) => reader.question("agent › ", resolve));
  reader.close();

  const picked = rows[Number(answer.trim()) - 1] ?? rows.find((row) => row.id === answer.trim());
  // An unreadable answer is the first row rather than an error: someone who
  // pressed return wants to get on with it, and `/harness` changes it later.
  return picked?.id ?? rows[0]!.id;
}

/**
 * `--harness codex --sandbox docker --set effort=high` — the rest is the task.
 *
 * `--set` is repeatable and takes the agent's own option id and value, because
 * the alternative is a flag per axis and a flag per axis is a guess. `/options`
 * prints the ids, so an operator never has to know one in advance.
 */
export function parseArguments(argv: readonly string[]): { choice: Choice; task: string } {
  // Flags taking no value must be named, or one swallows the task as its
  // argument and the agent is asked nothing.
  const valueless = new Set<string>();
  const flags = new Map<string, string>();
  const select: Record<string, string> = {};
  const words: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) { words.push(argument); continue; }
    const name = argument.slice(2);
    if (valueless.has(name)) { flags.set(name, "true"); continue; }
    const value = argv[index + 1] ?? "";
    index += 1;
    if (name === "set") {
      const at = value.indexOf("=");
      if (at > 0) select[value.slice(0, at)] = value.slice(at + 1);
      continue;
    }
    flags.set(name, value);
  }
  return {
    choice: {
      // Empty means nobody said, which `chooseAgent` answers. Not defaulted
      // here, because a default is exactly what hides the choice.
      agent: flags.get("harness") ?? "",

      sandbox: (flags.get("sandbox") ?? "local") as Choice["sandbox"],
      ...(Object.keys(select).length ? { select } : {}),
    },
    task: words.join(" "),
  };
}

if (import.meta.main) {
  const { choice, task } = parseArguments(process.argv.slice(2));
  if (!choice.agent) choice.agent = await chooseAgent();
  console.error(`· acp · ${choice.agent} · sandbox ${choice.sandbox}`);
  await main(task, { choice, turns: turnsFrom({ task }).lines });
  console.log(recipeMarker("coding-agent"));
}
