/**
 * Somebody else's agent, deeply integrated.
 *
 * Pi's coding agent wrapped as a `Harness`, running inside our log, our sandbox
 * and our tool executor. The claim is that "use their agent" and "own the
 * session" are not a trade — but it holds only when the vendor's library
 * exposes the seams that make it true, which is what this recipe measures:
 *
 *   - **`state.tools` is ours to fill**, and Pi's own tools are *values*, each
 *     taking an `operations` seam. `--tools theirs` keeps their schema,
 *     truncation and prompt guidance while the shell they run is ours and
 *     `decide` gates the call; `--tools both` puts ours in the same list.
 *   - **`state.messages` is ours to seed**, from the committed log on every
 *     activation. That is `recovery: "history"`, and it is what lets an
 *     interrupted run be picked up and finished.
 *   - **Its model is a descriptor**, not a client, so pointing the loop at a
 *     provider is three fields and no translation.
 *
 * `coding-agent` is the other end of the argument: any agent in the ACP
 * registry, cheaply, keeping none of that. What used to sit between them here
 * was the Claude Code SDK — a process wrapper rather than a library, whose
 * tools are names, whose context is its own, and which needed ~490 lines
 * impersonating Anthropic's wire to reach a model of ours. That tier is real
 * and its README says so; carrying it in code proved the point twice over and
 * then cost more than it returned.
 */
import { runAgent, type Agent, type RunResult } from "aglib";
import { renderRun, type Sink } from "aglib/render";
import { terminalSink, turnsFrom } from "aglib/terminal";
import { runCommand, patched, type Choosing } from "./commands.ts";
import { createSqliteStore } from "aglib/store/adapters/sqlite";
import { createLocalSandboxProvider } from "aglib/sandbox/adapters/local";
import { createDockerSandboxProvider } from "aglib/sandbox/adapters/docker";
import type { Sandbox } from "aglib/sandbox";
import { Database } from "bun:sqlite";
import { recipeMarker } from "../manifest.ts";
import { routeTo, type Provider } from "./route.ts";
import { createPiHarness } from "./pi.ts";
import { sandboxTools } from "./tools.ts";
import { piCodingTools } from "./pi-tools.ts";

export interface Choice {
  /** Whose tools the agent gets. The finding this recipe exists for. */
  tools: "ours" | "theirs";
  sandbox: "local" | "docker";
  provider: Provider;
  model: string;
  effort?: "low" | "medium" | "high";
}

const say = (sink: Sink, text: string) => (sink.status ?? sink.write)(`${text}\n`);

/** The whole selection, in the order `/options` lists it. */
const selection = (choice: Choice): string =>
  `tools ${choice.tools} · ${choice.provider} · ${choice.model}`;

export const defaultChoice: Choice = {
  tools: "theirs",
  sandbox: "local",
  provider: "openrouter",
  model: "anthropic/claude-sonnet-5",
};

async function openSandbox(kind: Choice["sandbox"]): Promise<Sandbox> {
  const provider = kind === "docker"
    ? createDockerSandboxProvider({ image: process.env["AGLIB_DOCKER_IMAGE"] ?? "alpine:3" })
    : createLocalSandboxProvider({ root: process.cwd() });
  const sandbox = await provider.create({
    isolation: kind === "docker" ? "required" : "none",
    network: { mode: "unrestricted" },
  });
  if (!sandbox.ok) throw new Error(`sandbox (${kind}): ${sandbox.error.message}`);
  return sandbox.value;
}

const instructions = "You are a careful assistant working inside a sandbox. Be brief and say what you did.";

export async function main(
  task: string,
  options: { choice?: Choice; sink?: Sink; turns?: AsyncIterable<string> } = {},
): Promise<string> {
  const choice = options.choice ?? defaultChoice;
  const sink: Sink = options.sink ?? terminalSink();
  const sandbox = await openSandbox(choice.sandbox);

  // Three fields, and the vendor's loop is pointed at a provider. Nothing
  // translates anything, and there is no socket to close.
  let route = routeTo(choice.provider);

  // The list `/options` printed last, waiting for the next line to answer it.
  let choosing: Choosing | null = null;

  /**
   * Nothing is held between turns, and that is the point.
   *
   * `transcriptFor` assigns `state.messages` from the committed log on every
   * activation, so what the agent knows is what the log says and nothing else.
   * A harness that kept its own context would need a vendor session id threaded
   * through every turn and a decision about where it lives across a restart;
   * this one needs neither, because the answer is already in the store.
   */
  const agentFor = (): Agent => ({
    id: "vendored-agent", version: "1", instructions,
    harness: createPiHarness({
      baseUrl: route.baseUrl, token: route.token, api: route.api, model: choice.model,
      ...(choice.effort ? { effort: choice.effort } : {}),
    }),
    // Every tool goes through the executor, theirs included: `pi-tools.ts`
    // adapts Pi's own bash, read, edit and write and backs them with the
    // sandbox, so they are validated and gated like anything we wrote.
    //
    // One list or the other, and not a union of the two. There used to be a
    // `both`, which was the interesting mode for a vendor whose tools arrived
    // namespaced inside its own process; against Pi it never ran at all —
    // `state.tools` is one flat list, our `bash` and Pi's `bash` are the same
    // name, and `createExecutor` refuses a duplicate. Ours and Pi's are the
    // same three jobs, so the union was never the demonstration anyway. A tool
    // this application actually owns — a memory, a delegation — goes in this
    // list beside Pi's and is gated identically; that is the seam, and it is
    // the same one either branch below uses.
    tools: choice.tools === "ours" ? sandboxTools(sandbox) : piCodingTools(sandbox),
  });

  const database = new Database(":memory:");
  const store = createSqliteStore({ database });
  const sessionId = crypto.randomUUID();
  let result: RunResult | undefined;
  for await (const input of options.turns ?? [task]) {
    // A line beginning with `/` is for the terminal, not the agent — and so is
    // a bare number answering a list one of them printed. Neither reaches the log.
    const command = runCommand({ line: input, choice, sink, choosing });
    if (command.handled) {
      if (command.choosing !== undefined) choosing = command.choosing;
      // Resolved before anything is committed to: a provider with no credential
      // leaves the selection where it was rather than failing on the next turn.
      if (command.set) {
        const proposed = patched(choice, command.set.axis, command.set.value);
        try {
          if (command.set.axis === "provider") route = routeTo(proposed.provider);
          Object.assign(choice, proposed);
          say(sink, `Answering with ${selection(choice)}, from the next turn.`);
        } catch (error) {
          say(sink, `Still ${selection(choice)}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      continue;
    }
    choosing = null;

    result = await renderRun(runAgent({ agent: agentFor(), store, sessionId, key: "me", input }), sink);
  }

  await sandbox.close();
  await store.close();
  if (result && result.status !== "completed") {
    throw new Error(result.status === "failed" ? `run failed: ${result.error.message}` : `run ${result.status}`);
  }
  return sessionId;
}

/**
 * `--tools ours --sandbox docker --provider openai --model gpt-5` — the rest is
 * the task.
 *
 * A flag per axis, and deliberately not `coding-agent`'s `--set id=value`.
 * There the ids belong to whichever agent is on the other end of the pipe and
 * naming them would be a guess; here they are this file's own fields, typed,
 * and `--sandbox` has to be answered before the sandbox is opened — which is
 * why it is the one axis argv can set and `/options` cannot.
 */
export function parseArguments(argv: readonly string[]): { choice: Choice; task: string } {
  const flags = new Map<string, string>();
  const words: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) { words.push(argument); continue; }
    flags.set(argument.slice(2), argv[index + 1] ?? "");
    index += 1;
  }
  const effort = flags.get("effort") as Choice["effort"];
  return {
    choice: {
      ...defaultChoice,
      tools: (flags.get("tools") ?? defaultChoice.tools) as Choice["tools"],
      sandbox: (flags.get("sandbox") ?? defaultChoice.sandbox) as Choice["sandbox"],
      provider: (flags.get("provider") ?? defaultChoice.provider) as Provider,
      model: flags.get("model") || defaultChoice.model,
      ...(effort ? { effort } : {}),
    },
    task: words.join(" "),
  };
}

if (import.meta.main) {
  const { choice, task } = parseArguments(process.argv.slice(2));
  console.error(`· pi · ${selection(choice)} · sandbox ${choice.sandbox}`);
  // The same terminal every recipe here gets: a prompt for a person, one shot
  // for a pipe, and the argv task as the first turn either way.
  await main(task, { choice, turns: turnsFrom({ task }).lines });
  console.log(recipeMarker("vendored-agent"));
}
