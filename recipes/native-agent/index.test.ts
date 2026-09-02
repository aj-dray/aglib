import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createFakeModel } from "aglib/model/adapters/fake";
import { createSqliteStore } from "aglib/store/adapters/sqlite";
import { main } from "./index.ts";
import { parseArguments } from "./model.ts";
import { receive } from "./channel.ts";
import { memoryBudget, parseMemory, renderMemory } from "./memory.ts";

/**
 * Offline, deterministic, no credentials. The fake model stands in for the
 * provider; the log, the tools, the queue and the handoff are the real thing.
 */
async function withHome<T>(body: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "aglib-native-"));
  const previous = process.env["AGENT_HOME"];
  process.env["AGENT_HOME"] = home;
  try { return await body(home); }
  finally {
    if (previous === undefined) delete process.env["AGENT_HOME"]; else process.env["AGENT_HOME"] = previous;
    await rm(home, { recursive: true, force: true });
  }
}

/** Captures nothing: these cases assert on the database, not the screen. */
const quiet = { write: () => {}, status: () => {} };

const call = (name: string, args: unknown) =>
  ({ calls: [{ callId: `c${Math.random().toString(36).slice(2, 8)}`, name, arguments: JSON.stringify(args) }] });

test("a remembered fact is on disk, and is context for the next conversation", async () => {
  await withHome(async (home) => {
    await main("Remember I prefer metric units.", {
      resolveModel: () => createFakeModel([
        call("memory", { action: "add", text: "Prefers metric units." }),
        { text: "Noted." },
      ]),
      sink: quiet,
    });

    const written = await Bun.file(join(home, "memory.md")).text();
    expect(parseMemory(written)).toEqual(["Prefers metric units."]);
    // What the next run would be given, which is the point of writing it.
    expect(renderMemory(parseMemory(written))).toContain("1. Prefers metric units.");
  });
});

test("a write over budget changes nothing and hands back what is there", async () => {
  await withHome(async (home) => {
    await Bun.write(join(home, "memory.md"), "An entry worth keeping.");
    await main("remember something enormous", {
      resolveModel: () => createFakeModel([
        call("memory", { action: "add", text: "x".repeat(memoryBudget) }),
        { text: "It did not fit." },
      ]),
      sink: quiet,
    });

    const written = await Bun.file(join(home, "memory.md")).text();
    expect(parseMemory(written)).toEqual(["An entry worth keeping."]);
  });
});

test("a spawned subagent runs from the queue, and its report reaches the parent", async () => {
  await withHome(async (home) => {
    const said: string[] = [];
    const sessionId = await main("Find out what is in the ledger.", {
      resolveModel: () => createFakeModel([
        // The parent hands the task off and ends its turn. The delivery is
        // committed by the same write that commits this call.
        call("spawn", { goal: "Read the September ledger and report the balance.", context: "" }),
        { text: "Handed that to a subagent." },
        // The worker takes the child off the queue and runs it.
        { text: "September closes at 1250 GBP." },
        // The child's report arrives as input to the parent, which the same
        // worker then picks up.
        { text: "The September balance is 1250 GBP." },
      ]),
      sink: { write: (text) => said.push(text), status: (line) => said.push(line) },
    });

    const database = new Database(join(home, "agent.db"));
    const sessions = database.query("SELECT id, key, metadata FROM sessions ORDER BY key").all() as
      { id: string; key: string | null; metadata: string | null }[];
    expect(sessions).toHaveLength(2);

    const childRow = sessions.find((session) => session.key === `child:${sessionId}`);
    expect(childRow).toBeDefined();
    expect(JSON.parse(childRow!.metadata ?? "{}").parentSessionId).toBe(sessionId);

    // The parent's log carries the child's report as input it received.
    const inputs = (database.query("SELECT body FROM entries WHERE session_id = ? ORDER BY seq")
      .all(sessionId) as { body: string }[])
      .map((entry) => JSON.parse(entry.body) as { type: string; input?: unknown })
      .filter((entry) => entry.type === "run.started");
    expect(JSON.stringify(inputs)).toContain("Subagent");
    expect(said.join("")).toContain("1250 GBP");

    // Nothing is left owed to anyone: the queue is a column on the session,
    // and every delivery has been consumed by the write that committed it.
    const pending = database.query("SELECT pending FROM sessions").all() as { pending: string }[];
    expect(pending.map((row) => row.pending)).toEqual(["[]", "[]"]);
  });
});

test("a channel maps a thread onto one session, and the worker answers it", async () => {
  await withHome(async (home) => {
    const database = new Database(join(home, "agent.db"), { create: true });
    const store = createSqliteStore({ database });
    const agent = { id: "native-agents", version: "1" };
    const message = { thread: "t-1", sender: "someone@example.com", body: "What is the balance?" };

    const first = await receive({ store, agent, message });
    expect(first.opened).toBe(true);

    // A reply on the same thread continues the log rather than opening a second.
    const second = await receive({ store, agent, message: { ...message, body: "Any update?" } });
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.opened).toBe(false);

    const claimed = await store.next({});
    expect(claimed.ok && claimed.value?.sessionId).toBe(first.sessionId);
    // Both messages are waiting, and reading has not consumed either.
    expect(claimed.ok && claimed.value?.pending.map((delivery) => delivery.input)).toEqual([
      "What is the balance?",
      "Any update?",
    ]);
    await store.close();
  });
});

test("a flag that takes no value does not swallow the task", () => {
  const { choice, task } = parseArguments(["--once", "count the files", "--detail", "debug"]);
  expect(choice.once).toBe(true);
  expect(choice.detail).toBe("debug");
  expect(task).toBe("count the files");
});

test("a conversation is one session, and a script is one shot", async () => {
  await withHome(async (home) => {
    const said: string[] = [];
    const sessionId = await main("", {
      // Two turns typed by a person, against one session.
      turns: {
        interactive: true,
        lines: (async function* () { yield "remember I like metric"; yield "what did I just say?"; })(),
      },
      resolveModel: () => createFakeModel([
        call("memory", { action: "add", text: "Likes metric units." }),
        { text: "Noted." },
        { text: "You said you like metric." },
      ]),
      sink: { write: (text) => said.push(text), status: () => {} },
    });

    const database = new Database(join(home, "agent.db"));
    const sessions = database.query("SELECT id FROM sessions").all() as { id: string }[];
    // One session, not two: the second turn continued the first.
    expect(sessions.map((row) => row.id)).toEqual([sessionId]);

    const starts = (database.query("SELECT body FROM entries WHERE session_id = ? ORDER BY seq").all(sessionId) as { body: string }[])
      .map((row) => JSON.parse(row.body) as { type: string })
      .filter((entry) => entry.type === "run.started");
    expect(starts).toHaveLength(2);
    expect(said.join("")).toContain("You said you like metric.");
  });
});

test("a slash line is for the terminal, and never reaches the agent", async () => {
  await withHome(async (home) => {
    const said: string[] = [];
    const sessionId = await main("", {
      turns: {
        interactive: true,
        lines: (async function* () { yield "/model"; yield "/nonsense"; yield "hello"; })(),
      },
      resolveModel: () => createFakeModel([{ text: "hi" }]),
      sink: { write: (text) => said.push(text), status: (line) => said.push(line) },
    });

    expect(said.join("")).toContain("Answering with openrouter");
    expect(said.join("")).toContain("No command '/nonsense'");

    // One turn in the log, not three: the commands were answered by the
    // terminal and the agent never saw them.
    const starts = (new Database(join(home, "agent.db"))
      .query("SELECT body FROM entries WHERE session_id = ? ORDER BY seq").all(sessionId) as { body: string }[])
      .map((row) => JSON.parse(row.body) as { type: string; input?: unknown })
      .filter((entry) => entry.type === "run.started");
    expect(starts).toHaveLength(1);
    expect(JSON.stringify(starts)).not.toContain("/model");
  });
});

test("a switch that cannot be made is refused, and the session keeps answering", async () => {
  await withHome(async () => {
    const said: string[] = [];
    await main("", {
      turns: {
        interactive: true,
        lines: (async function* () { yield "/model openrouter"; yield "/model nope/model"; yield "hello"; })(),
      },
      // Every selection but the one we started with is unavailable, the way a
      // missing credential is unavailable.
      resolveModel: (choice) => {
        if (choice.model !== "deepseek/deepseek-v4-flash") throw new Error("OPENROUTER_API_KEY is not set");
        return createFakeModel([{ text: "hi" }]);
      },
      sink: { write: (text) => said.push(text), status: (line) => said.push(line) },
    });

    const text = said.join("");
    // A provider with no model is a half-finished instruction, not a model.
    expect(text).toContain("Name a model too");
    // A switch that could not be resolved says what is still answering, and
    // never claims the change happened.
    expect(text).toContain("Still openrouter · deepseek/deepseek-v4-flash");
    expect(text).not.toContain("Answering with openrouter · nope/model from the next turn");
    // And the run after it still works, on the model that was there all along.
    expect(text).toContain("hi");
  });
});

test("a fact remembered on one turn is context on the next, not after a restart", async () => {
  await withHome(async () => {
    const asked: string[] = [];
    const scripted = createFakeModel([
      call("memory", { action: "add", text: "Ledger lives in ~/ledgers." }),
      { text: "Noted." },
      { text: "In ~/ledgers." },
    ]);
    // Records what each request was shown, then answers from the script.
    const watching = {
      id: "watching",
      async *generate(request: { messages: readonly { role: string; content: unknown }[] }) {
        asked.push(JSON.stringify(request.messages.filter((message) => message.role === "system")));
        return yield* scripted.generate(request as never);
      },
    };

    await main("", {
      turns: {
        interactive: true,
        lines: (async function* () { yield "remember where the ledger is"; yield "where is it?"; })(),
      },
      resolveModel: () => watching as never,
      sink: { write: () => {}, status: () => {} },
    });

    // The first turn was shown an empty memory; the last was shown the fact the
    // first one wrote. Built once for the whole process, every turn saw the
    // empty one and the memory tool was a promise nothing kept.
    expect(asked[0]).toContain("nothing recorded");
    expect(asked.at(-1)).toContain("Ledger lives in ~/ledgers.");
  });
});
