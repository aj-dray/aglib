import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createSqliteStore } from "aglib/store/adapters/sqlite";
import { runAgent, defineTool, textOf, type Agent } from "aglib";
import { z } from "zod";
import { createLocalSandboxProvider } from "aglib/sandbox/adapters/local";
import { createNativeHarness } from "aglib/harness";
import { createOpenRouterModel } from "aglib/model/adapters/openai-compatible";
import { serveAnthropicWire } from "./wire.ts";
import { createClaudeCodeHarness } from "./claude-code.ts";
import { createPiHarness } from "./pi.ts";
import { sandboxTools } from "./tools.ts";
import { defaultChoice, main } from "./index.ts";

test("Claude Code keeping its own tools refuses a sandbox it cannot reach", async () => {
  // Nothing is started: the refusal is the point. Its built-in tools run in
  // this process, so calling a container "contained" while they are in place
  // would be the simulated guarantee this library exists to avoid.
  const harness = createClaudeCodeHarness({
    sandbox: { isolation: "container", root: "/home/user" } as never,
    tools: "theirs",
  });
  const result = await harness.run({
    sessionId: "s", runId: "r", instructions: "",
    history: () => [], entries: () => [],
    commit: async () => {}, emit: () => {}, signal: new AbortController().signal,
  });
  expect(result.status).toBe("failed");
  if (result.status !== "failed") return;
  expect(result.error.code).toBe("unsupported");
});

test("only the harness that can be seeded from the log claims recovery", () => {
  const claude = createClaudeCodeHarness({ sandbox: { isolation: "none" } as never, tools: "ours" });
  const pi = createPiHarness({ baseUrl: "http://127.0.0.1:1", token: "t" });

  // Claude Code owns its context, so an interrupted run is over and `runAgent`
  // closes the session rather than handing it out again. Pi's transcript is
  // assigned from committed entries every activation, so it can be continued.
  expect(claude.recovery).toBe("none");
  expect(pi.recovery).toBe("history");
});

/**
 * The claim, run: a vendor harness inside our log, using our sandbox, on a
 * model its own library never heard of.
 *
 * Two gates, like every other live case here — `bun run check` is hermetic.
 */
const live = process.env["AGLIB_LIVE_MODEL"] === "1" ? process.env["OPENROUTER_API_KEY"] : undefined;
const liveTest = live ? test : test.skip;

for (const which of ["claude-code", "pi"] as const) {
  liveTest(`${which} runs in our log, with our hands, on a model behind the port`, async () => {
    const provider = createLocalSandboxProvider({ root: process.cwd() });
    const opened = await provider.create({ isolation: "none", network: { mode: "unrestricted" } });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const sandbox = opened.value;

    const wire = serveAnthropicWire({
      model: createOpenRouterModel({ apiKey: live!, model: "anthropic/claude-sonnet-5", appName: "aglib-vendored-agents" }),
    });
    const instructions = "You are a careful assistant working inside a sandbox. Be brief.";
    const agent: Agent = which === "pi"
      ? {
          id: "t", version: "1", instructions,
          harness: createPiHarness({ baseUrl: wire.url, token: wire.token }),
          tools: sandboxTools(sandbox),
        }
      : {
          id: "t", version: "1", instructions,
          harness: createClaudeCodeHarness({
            sandbox, tools: "ours",
            env: {
              ...process.env as Record<string, string>,
              ANTHROPIC_BASE_URL: wire.url,
              ANTHROPIC_AUTH_TOKEN: wire.token,
              ANTHROPIC_API_KEY: wire.token,
              ANTHROPIC_MODEL: "claude-sonnet-5",
              ANTHROPIC_SMALL_FAST_MODEL: "claude-sonnet-5",
            },
          }),
        };

    const database = new Database(":memory:");
    const store = createSqliteStore({ database });
    const sessionId = crypto.randomUUID();
    const run = runAgent({
      agent, store, sessionId,
      input: "Run `echo aglib-was-here` with bash, then report exactly what it printed.",
    });
    for await (const _ of run) { /* the log is the record */ }
    const result = await run.result;

    await wire.close();
    await sandbox.close();
    expect(result.status).toBe("completed");

    // The point of wrapping a vendor harness at all: what it did is in *our*
    // log, in our vocabulary, whoever's loop produced it.
    const types = (database.query("SELECT body FROM entries ORDER BY seq").all() as { body: string }[])
      .map((row) => (JSON.parse(row.body) as { type: string }).type);
    expect(types).toContain("assistant");
    expect(types).toContain("tool.started");
    expect(types).toContain("tool.finished");
    await store.close();
  }, 300_000);
}

/**
 * The gap this recipe had: an agent that keeps its own context was told
 * nothing about the last turn, so a second question landed on a stranger.
 * Pi never had it — its transcript is assigned from the log every activation —
 * which is the whole of what `recovery: "history"` is claiming.
 */
liveTest("claude-code remembers the turn before, because it is handed its own session back", async () => {
  const said: string[] = [];
  await main("", {
    choice: { ...defaultChoice, harness: "claude-code", tools: "ours" },
    turns: (async function* () {
      yield "Remember the number 4127. Reply with just: noted.";
      yield "What number did I just ask you to remember? Reply with just the number.";
    })(),
    sink: { write: (text) => said.push(text), status: () => {} },
  });
  expect(said.join(" ")).toContain("4127");
}, 300_000);

liveTest("pi remembers the turn before, from the log rather than its own memory", async () => {
  const said: string[] = [];
  await main("", {
    choice: { ...defaultChoice, harness: "pi" },
    turns: (async function* () {
      yield "Remember the number 8315. Reply with just: noted.";
      yield "What number did I just ask you to remember? Reply with just the number.";
    })(),
    sink: { write: (text) => said.push(text), status: () => {} },
  });
  expect(said.join(" ")).toContain("8315");
}, 300_000);

/**
 * The claim `recovery: "history"` makes, run against a vendor's loop.
 *
 * `src/run.test.ts` proves the machinery with our own harness. This proves the
 * part that matters for a *foreign* one: that our durable log is enough to put
 * a vendor agent back where a killed worker left it. Pi can be, because its
 * transcript is a field we assign. Claude Code and an ACP agent cannot, which
 * is why they say `recovery: "none"` and `runAgent` closes their interrupted
 * sessions instead of handing them out for ever.
 */
liveTest("pi is put back where a killed worker left it, from our log alone", async () => {
  const provider = createLocalSandboxProvider({ root: process.cwd() });
  const opened = await provider.create({ isolation: "none", network: { mode: "unrestricted" } });
  expect(opened.ok).toBe(true);
  if (!opened.ok) return;

  const wire = serveAnthropicWire({
    model: createOpenRouterModel({ apiKey: live!, model: "anthropic/claude-sonnet-5", appName: "aglib-vendored-agents" }),
  });

  let ran = 0;
  const ledger = defineTool({
    name: "read_ledger",
    description: "Read the September ledger.",
    schema: z.object({}),
    execute: () => { ran += 1; return { content: "1250 GBP" }; },
  });

  const database = new Database(":memory:");
  const store = createSqliteStore({ database });
  const agent = {
    id: "t", version: "1",
    instructions: "Answer from the ledger. Be brief.",
    harness: createPiHarness({ baseUrl: wire.url, token: wire.token }),
    tools: [ledger],
  };

  // Exactly the state a killed worker leaves: everything through a committed
  // tool result, and no terminal entry.
  await store.create({ sessionId: "s", agent: { id: "t", version: "1" } });
  await store.append({
    sessionId: "s", expectedSeq: 0,
    entries: [
      { type: "run.started", runId: "interrupted", input: "What is the September balance?" },
      { type: "assistant", runId: "interrupted", content: "", calls: [{ callId: "c1", name: "read_ledger", arguments: "{}" }] },
      { type: "tool.started", runId: "interrupted", callId: "c1" },
      { type: "tool.finished", runId: "interrupted", callId: "c1", result: { content: "1250 GBP" } },
    ],
  });

  const result = await runAgent({
    agent, store, claim: { sessionId: "s", seq: 4, pending: [], metadata: {} },
  }).result;

  await wire.close();
  await opened.value.close();

  expect(result.status).toBe("completed");
  if (result.status !== "completed") return;
  // It answered from a tool call it never made, because the log told it the
  // answer was already given. Re-running the effect would have been the bug.
  expect(textOf(result.output)).toContain("1250");
  expect(ran).toBe(0);

  const after = await store.read({ sessionId: "s" });
  expect(after.ok && after.value.entries.filter((entry) => entry.type === "run.started")).toHaveLength(1);
  await store.close();
}, 300_000);

/**
 * What a normalised log is actually for.
 *
 * One session, two harnesses: our own loop answers the first turn, and Pi
 * answers the second having never seen it happen. Nothing is translated and
 * nothing is handed over — Pi reads the same committed entries our loop wrote,
 * because there is only one representation of a conversation here.
 *
 * This is the property that does not hold for a harness whose context lives in
 * the vendor. Swap Pi for Claude Code below and the second turn arrives at an
 * agent with no idea what "that number" refers to, which is the whole content
 * of `recovery: "none"`.
 */
liveTest("a session started by one harness is continued by another, through the log alone", async () => {
  const wire = serveAnthropicWire({
    model: createOpenRouterModel({ apiKey: live!, model: "anthropic/claude-sonnet-5", appName: "aglib-vendored-agents" }),
  });
  const store = createSqliteStore({ database: new Database(":memory:") });
  const sessionId = crypto.randomUUID();
  const instructions = "Be brief. Answer with as few words as possible.";

  const ours = await runAgent({
    agent: {
      id: "t", version: "1", instructions,
      harness: createNativeHarness({
        model: createOpenRouterModel({ apiKey: live!, model: "anthropic/claude-sonnet-5", appName: "aglib-vendored-agents" }),
      }),
    },
    store, sessionId, input: "Remember the number 5150. Reply with just: noted.",
  }).result;
  expect(ours.status).toBe("completed");

  const theirs = await runAgent({
    agent: {
      id: "t", version: "1", instructions,
      harness: createPiHarness({ baseUrl: wire.url, token: wire.token }),
    },
    store, sessionId, input: "What number did I ask you to remember? Reply with just the number.",
  }).result;

  await wire.close();
  expect(theirs.status).toBe("completed");
  if (theirs.status !== "completed") return;
  expect(textOf(theirs.output)).toContain("5150");
  await store.close();
}, 300_000);
