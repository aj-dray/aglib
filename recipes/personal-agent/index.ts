/**
 * One operator, one machine, one SQLite file.
 *
 * The recipe that proves the log, compaction, the two context lifetimes, tools
 * and cross-session search — with every part anyone would call "memory" built
 * on the library rather than inside it.
 */
import { runAgent, type Agent } from "aglib";
import { createSqliteStore } from "aglib/store/adapters/sqlite";
import { createNativeHarness } from "aglib/harness";
import type { Model } from "aglib/model";
import { createChosenModel, parseArguments, type ModelChoice } from "./model.ts";
import { createLocalSandboxProvider } from "aglib/sandbox/adapters/local";
import { openDatabase } from "./db.ts";
import { factTools, renderFacts } from "./memory.ts";
import { skillTools, renderSkillIndex } from "./skills.ts";
import { searchTools, indexRun, summarizeRun } from "./search.ts";
import { shellTools } from "./shell.ts";

export async function main(
  task: string,
  options: { model?: Model; choice?: ModelChoice; sessionId?: string; write?: (line: string) => void } = {},
): Promise<string> {
  const sessionId = options.sessionId ?? crypto.randomUUID();
  // Read at call time, not module load: a test points this at a temp directory
  // so it never touches the operator's real agent.
  const home = process.env.AGENT_HOME ?? `${process.env.HOME}/.agent`;
  // One database. aglib owns `sessions` and `entries`; this app owns `facts`
  // and `sessions_fts` beside them. That is the whole reason the store takes an
  // open handle: an application indexes and joins against its own agent's log.
  const database = await openDatabase(`${home}/agent.db`);
  const store = createSqliteStore({ database: database.handle });

  // Constructed once and used twice — by the harness to run the agent, and
  // directly to summarize afterwards. A model is a value, not a subsystem.
  const model = options.model
    ?? createChosenModel(options.choice ?? { provider: "openrouter", model: "deepseek/deepseek-v4-flash" });

  const sandbox = await createLocalSandboxProvider({ root: process.cwd() })
    .create({ isolation: "none", network: { mode: "unrestricted" } });
  if (!sandbox.ok) throw new Error(`sandbox: ${sandbox.error.message}`);

  const skills = await skillTools(`${home}/skills`);
  const facts = factTools(database);

  const agent: Agent = {
    id: "personal",
    version: "1",
    instructions: await Bun.file(`${home}/instructions.md`).text().catch(() => "You are a helpful personal assistant. Be brief."),
    harness: createNativeHarness({
      model,
      ...(options.choice?.effort ? { effort: options.choice.effort } : {}),
      // Personal sessions run long. Compaction is how the log stays in budget,
      // and it is the only memory mechanism the library itself owns.
      compaction: { maxInputTokens: 120_000 },
    }),
    tools: [
      ...facts.tools,
      ...skills.tools,
      ...searchTools(database, store),
      ...shellTools(sandbox.value),
    ],
  };

  const run = runAgent({
    agent,
    store,
    sessionId,
    // `key` is opaque to aglib. Here it is the operator; in a multi-tenant app
    // it would be a tenant or a channel. aglib indexes it and never reads it.
    key: "me",
    input: task,
    context: {
      // Run-scoped: inside the cached prefix, stable for the whole run. A fact
      // written this run takes effect next run — rewriting the cached prefix
      // mid-run would invalidate the cache on every following turn.
      run: [
        renderFacts(await facts.all()),
        // Names and one-line descriptions only. Bodies load through
        // `load_skill`, so ten skills cost ~200 tokens instead of ~20k.
        renderSkillIndex(await skills.list()),
      ].join("\n\n"),
    },
  });

  const write = options.write ?? ((line: string) => process.stdout.write(line));
  for await (const update of run) {
    if (update.type === "text.delta") write(update.text);
  }
  write("\n");

  const result = await run.result;
  await sandbox.value.close();
  if (result.status !== "completed") {
    throw new Error(result.status === "failed" ? `run failed: ${result.error.message}` : `run ${result.status}`);
  }

  // Indexing and titling are application work, done from the committed log
  // after the fact. The library neither summarizes nor indexes anything; it
  // only has to be readable.
  const read = await store.read({ sessionId });
  if (!read.ok) return sessionId;
  indexRun({ database, sessionId, entries: read.value.entries });
  await store.append({
    sessionId,
    expectedSeq: read.value.seq,
    entries: [],
    metadata: await summarizeRun({ model, entries: read.value.entries }),
  });
  return sessionId;
}

if (import.meta.main) {
  const { choice, task } = parseArguments(process.argv.slice(2));
  console.error(`· ${choice.provider} · ${choice.model}${choice.effort ? ` · effort ${choice.effort}` : ""}`);
  await main(task, { choice });
}
