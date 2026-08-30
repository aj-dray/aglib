/**
 * A minimal personal agent: one operator, one machine, one `~/.agent`.
 *
 * The smallest thing that is still a real assistant. Our own loop, one hand,
 * a memory it edits, skills it loads, subagents it hands work to, and a choice
 * of where commands run. Everything anyone calls "memory" is application code
 * in this directory; the library provides the log, the loop, and two context
 * slots.
 */
import { runAgent, textOf, type Agent } from "aglib";
import { renderRun, type Sink } from "aglib/render";
import { createSqliteStore } from "aglib/store/adapters/sqlite";
import { createNativeHarness } from "aglib/harness";
import type { Model } from "aglib/model";
import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { recipeMarker } from "../manifest.ts";
import { defaultInstructions, openHome } from "./home.ts";
import { memoryTools, readMemory, renderMemory } from "./memory.ts";
import { listSkills, renderSkillIndex, skillTools } from "./skills.ts";
import { bashTools, openSandbox, type SandboxKind } from "./sandbox.ts";
import { drain, isChild, reportToParent, spawnTools } from "./spawn.ts";
import { createChosenModel, parseArguments, type Choice } from "./model.ts";

export interface Options {
  model?: Model;
  choice?: Choice;
  sessionId?: string;
  /** Where the run is shown. A test passes one that captures instead of printing. */
  sink?: Sink;
}

const choiceDetail = (choice: Choice | undefined): Sink["detail"] | undefined => choice?.detail;

export async function main(task: string, options: Options = {}): Promise<string> {
  const sessionId = options.sessionId ?? crypto.randomUUID();
  // The answer on stdout, the account of the run on stderr, so redirecting the
  // first captures the answer and nothing else.
  const sink: Sink = options.sink ?? {
    write: (text) => process.stdout.write(text),
    status: (line) => process.stderr.write(line),
    tty: process.stderr.isTTY === true,
    ...(choiceDetail(options.choice) ? { detail: choiceDetail(options.choice) } : {}),
  };
  const choice = options.choice ?? { provider: "openrouter" as const, model: "deepseek/deepseek-v4-flash", sandbox: "local" as const };

  const home = await openHome();
  await mkdir(home.root, { recursive: true });
  const database = new Database(home.database, { create: true });
  database.exec("PRAGMA journal_mode = WAL");
  const store = createSqliteStore({ database });

  const model = options.model ?? createChosenModel(choice);
  const sandbox = await openSandbox(choice.sandbox as SandboxKind);

  const instructions = await Bun.file(home.instructions).text().catch(() => defaultInstructions);
  const harness = () => createNativeHarness({
    model,
    ...(choice.effort ? { effort: choice.effort } : {}),
    // Personal sessions run long, and compaction is the only memory mechanism
    // the library itself owns.
    compaction: { maxInputTokens: 120_000 },
  });

  const identity = { id: "native-agents", version: "1" };
  const hands = [...bashTools(sandbox), ...skillTools(home.skills)];

  /**
   * A child is the same agent with two things taken away: it cannot spawn (so
   * a delegation tree cannot run away) and it cannot write memory (so what one
   * conversation learned is not rewritten by a task it handed off). What it
   * gains is `finished`, which is how its answer gets home.
   */
  const child: Agent = {
    ...identity,
    instructions: `${instructions}\n\nYou are a subagent. Do exactly what you were asked and report the result.`,
    harness: harness(),
    tools: hands,
    finished: (run) => reportToParent({ store, sessionId: run.sessionId, output: textOf(run.output) }),
  };

  const parent: Agent = {
    ...identity,
    instructions,
    harness: harness(),
    tools: [...hands, ...memoryTools(home.memory), ...spawnTools({ store, agent: identity })],
  };

  // Run-scoped: inside the cached prefix, fixed for the whole run. A memory
  // written this run applies from the next one, because rewriting the prefix
  // mid-run would invalidate the cache on every turn after it.
  const context = {
    run: [
      renderMemory(await readMemory(home.memory)),
      renderSkillIndex(await listSkills(home.skills)),
    ].join("\n\n"),
  };

  const result = await renderRun(
    runAgent({ agent: parent, store, sessionId, key: "me", input: task, context }),
    sink,
  );

  // Whatever the conversation set in motion, finished. Subagents run here, and
  // their reports come back as ordinary input to the session that asked — which
  // the same worker then picks up and answers.
  await drain({ store, agentFor: (claim) => (isChild(claim.metadata) ? child : parent), sink });

  await sandbox.close();
  await store.close();
  if (result.status !== "completed") {
    throw new Error(result.status === "failed" ? `run failed: ${result.error.message}` : `run ${result.status}`);
  }
  return sessionId;
}

if (import.meta.main) {
  const { choice, task } = parseArguments(process.argv.slice(2));
  console.error(`· ${choice.provider} · ${choice.model} · sandbox ${choice.sandbox}${choice.effort ? ` · effort ${choice.effort}` : ""}`);
  await main(task, { choice });
  console.log(recipeMarker("native-agents"));
}
