/**
 * A minimal personal agent: one operator, one machine, one `~/.agent`.
 *
 * The smallest thing that is still a real assistant. Our own loop, one hand,
 * a memory it edits, skills it loads, subagents it hands work to, and a choice
 * of where commands run. Everything anyone calls "memory" is application code
 * in this directory; the library provides the log, the loop, and two context
 * slots.
 */
import { runAgent, textOf, type Agent, type RunResult } from "aglib";
import { renderRun, type Sink } from "aglib/render";
import { createSqliteStore } from "aglib/store/adapters/sqlite";
import { createCompactionHook, createNativeHarness, type LifecycleHook } from "aglib/harness";
import type { Model } from "aglib/model";
import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { recipeMarker } from "../manifest.ts";
import { defaultInstructions, openHome } from "./home.ts";
import { memoryTools, readMemory, renderMemory } from "./memory.ts";
import { listSkills, renderSkillIndex, skillTools } from "./skills.ts";
import { bashTools, openSandbox, type SandboxKind } from "./sandbox.ts";
import { drain, isChild, reportToParent, spawnTools } from "./spawn.ts";
import { sendTools, terminalChannel } from "./send.ts";
import { createChosenModel, parseArguments, type Choice } from "./model.ts";
import { terminalSink, turnsFrom, type TurnSource } from "aglib/terminal";
import { runCommand } from "./commands.ts";

export interface Options {
  /**
   * How a selection becomes a model. Defaults to reading a credential from the
   * environment; a test returns a fake and can still exercise `/model`, which a
   * fixed `Model` could not — it would announce a switch and change nothing.
   */
  resolveModel?: (choice: Choice) => Model;
  choice?: Choice;
  sessionId?: string;
  /** Where the run is shown. A test passes one that captures instead of printing. */
  sink?: Sink;
  /** Where turns come from. Defaults to argv and the terminal; a test scripts them. */
  turns?: TurnSource;
}

const choiceDetail = (choice: Choice | undefined): Sink["detail"] | undefined => choice?.detail;

/** A command answers on the account channel, and falls back to the answer only
 * because a caller who gave neither still has to see what it typed. */
const say = (sink: Sink, text: string) => (sink.status ?? sink.write)(`${text}\n`);

export async function main(task: string, options: Options = {}): Promise<string> {
  const sessionId = options.sessionId ?? crypto.randomUUID();
  const turns = options.turns ?? turnsFrom({ task });
  const sink: Sink = options.sink
    ?? terminalSink({ ...(choiceDetail(options.choice) ? { detail: choiceDetail(options.choice) } : {}) });
  const choice = options.choice ?? { provider: "openrouter" as const, model: "deepseek/deepseek-v4-flash", sandbox: "local" as const };

  const home = await openHome();
  await mkdir(home.root, { recursive: true });
  const database = new Database(home.database, { create: true });
  database.exec("PRAGMA journal_mode = WAL");
  const store = createSqliteStore({ database });

  // Rebuilt when `/model` changes the choice. A model is a value, not a name
  // the library resolves, so a different one is a different `Model` — and a
  // different harness, and a different agent.
  const resolveModel = options.resolveModel ?? createChosenModel;
  let model = resolveModel(choice);
  const sandbox = await openSandbox(choice.sandbox as SandboxKind);

  const instructions = await Bun.file(home.instructions).text().catch(() => defaultInstructions);
  const harness = () => createNativeHarness({
    model,
    ...(choice.effort ? { effort: choice.effort } : {}),
  });

  const hooks = () => [createCompactionHook({ model, maxInputTokens: 120_000 })];
  const report: LifecycleHook = {
    name: "report-to-parent",
    async beforeStop(context, result) {
      return { deliveries: await reportToParent({ store, sessionId: context.sessionId, output: result.status === "completed" ? textOf(result.output) : result.status }) };
    },
  };
  const identity = { id: "native-agent", version: "1" };
  const hands = [...bashTools(sandbox), ...skillTools(home.skills)];

  /**
   * A child is the same agent with two things taken away: it cannot spawn (so
   * a delegation tree cannot run away) and it cannot write memory (so what one
   * conversation learned is not rewritten by a task it handed off). What it
   * gains is `beforeStop`, which is how its answer gets home.
   */
  let child: Agent = {
    ...identity,
    instructions: `${instructions}\n\nYou are a subagent. Do exactly what you were asked and report the result.`,
    harness: harness(),
    tools: hands,
    hooks: [...hooks(), report],
  };

  // `send` is the parent's and not a hand. A child writing through this sink
  // would print unattributed, while `drain` labels everything else a child
  // says — and what a child needs to report, `beforeStop` already delivers.
  const tools = [
    ...hands,
    ...memoryTools(home.memory),
    ...spawnTools({ store, agent: identity }),
    ...sendTools({ channels: { operator: terminalChannel(sink) }, store }),
  ];
  // `attribution`, because nothing else here says who wrote: a stranger's email
  // arrives as its body and a subagent's report as its answer, and both carry
  // the sender only as `from`. A child gets a self-contained goal instead, so it
  // is told nothing by being told which session sent it.
  let parent: Agent = { ...identity, instructions, harness: harness(), hooks: hooks(), tools, attribution: true };

  // Run-scoped: inside the cached prefix, fixed for the whole *run*, and read
  // again for the next one. Built once for the whole process it was neither —
  // a fact remembered on the first turn stayed invisible until a restart,
  // which is the opposite of what the memory tool promises.
  const contextFor = async () => ({
    run: [
      renderMemory(await readMemory(home.memory)),
      renderSkillIndex(await listSkills(home.skills)),
    ].join("\n\n"),
  });

  // One session for every turn, which is what makes this a conversation rather
  // than a series of strangers — and the only way the compaction this agent
  // configures is ever reached.
  let last: RunResult | undefined;
  for await (const input of turns.lines) {
    // A line beginning with `/` is for the terminal, not the agent, and never
    // reaches the log.
    const command = runCommand({ line: input, choice, sink });
    if (command.handled) {
      // Resolved before anything is committed to, so a missing credential says
      // so and leaves the session answering with what it had.
      if (command.select) {
        const proposed = { ...choice, ...command.select };
        try {
          model = resolveModel(proposed);
          Object.assign(choice, command.select);
          // The subagent too: a child spawned after the switch should run on
          // the model that is answering now, not the one that was.
          parent = { ...parent, harness: harness(), hooks: hooks() };
          child = { ...child, harness: harness(), hooks: [...hooks(), report] };
          say(sink, `Answering with ${choice.provider} · ${choice.model} from the next turn.`);
          say(sink, "The prompt cache starts again from there.");
        } catch (error) {
          say(sink, `Still ${choice.provider} · ${choice.model}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      continue;
    }

    last = await renderRun(
      runAgent({ agent: parent, store, sessionId, key: "me", input, context: await contextFor() }),
      sink,
    );

    // Whatever that turn set in motion, finished before the next prompt.
    // Subagents run here, and their reports come back as ordinary input to the
    // session that asked — which the same worker then picks up and answers.
    await drain({ store, agentFor: (claim) => (isChild(claim.metadata) ? child : parent), sink });

    // A failed turn ends a script, because its exit code is the answer. It does
    // not end a conversation: the renderer has already said what went wrong,
    // and the person is still sitting there.
    if (!turns.interactive) break;
  }

  await sandbox.close();
  await store.close();
  if (!turns.interactive && last && last.status !== "completed") {
    throw new Error(last.status === "failed" ? `run failed: ${last.error.message}` : `run ${last.status}`);
  }
  return sessionId;
}

if (import.meta.main) {
  const { choice, task } = parseArguments(process.argv.slice(2));
  console.error(`· ${choice.provider} · ${choice.model} · sandbox ${choice.sandbox}${choice.effort ? ` · effort ${choice.effort}` : ""}`);
  await main(task, { choice });
  console.log(recipeMarker("native-agent"));
}
