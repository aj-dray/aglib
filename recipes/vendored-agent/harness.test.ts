import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createSqliteStore } from "aglib/store/adapters/sqlite";
import { runAgent, defineTool, textOf, type Agent } from "aglib";
import { z } from "zod";
import { createLocalSandboxProvider } from "aglib/sandbox/adapters/local";
import { createNativeHarness } from "aglib/harness";
import { createOpenRouterModel } from "aglib/model/adapters/openai-compatible";
import { routeTo } from "./route.ts";
import { createPiHarness } from "./pi.ts";
import { sandboxTools } from "./tools.ts";
import { piCodingTools } from "./pi-tools.ts";
import { defaultChoice, main } from "./index.ts";
import { runCommand, patched } from "./commands.ts";

/**
 * The one claim a vendor harness here is allowed to make about recovery.
 *
 * `history` is not a preference — it is the observation that `state.messages`
 * is a field we assign, so the committed log decides what the agent knows. A
 * vendor whose context lives in its own process cannot say this, which is why
 * `coding-agent`'s ACP harness says `none` and `runAgent` closes an interrupted
 * session rather than handing it out for ever.
 */
test("the harness seeded from the log is the one that claims recovery", () => {
  const pi = createPiHarness({ baseUrl: "http://127.0.0.1:1", token: "t" });
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

/** OpenRouter's id for it, which is what a direct route asks for. */
const liveModel = "anthropic/claude-sonnet-5";
const liveOpenRouter = () =>
  createOpenRouterModel({ apiKey: live!, model: liveModel, appName: "aglib-vendored-agent" });

/** Pi on the route the recipe gives it: straight to OpenRouter, on the wire Pi speaks. */
const livePi = () => routeTo("openrouter");

liveTest("pi runs in our log, with our hands, on a model behind the port", async () => {
  const provider = createLocalSandboxProvider({ root: process.cwd() });
  const opened = await provider.create({ isolation: "none", network: { mode: "unrestricted" } });
  expect(opened.ok).toBe(true);
  if (!opened.ok) return;
  const sandbox = opened.value;

  const route = livePi();
  const agent: Agent = {
    id: "t", version: "1",
    instructions: "You are a careful assistant working inside a sandbox. Be brief.",
    harness: createPiHarness({
      baseUrl: route.baseUrl, token: route.token, api: route.api, model: liveModel,
    }),
    tools: sandboxTools(sandbox),
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

liveTest("pi remembers the turn before, from the log rather than its own memory", async () => {
  const said: string[] = [];
  await main("", {
    choice: { ...defaultChoice },
    turns: (async function* () {
      yield "Remember the number 8315. Reply with just: noted.";
      yield "What number did I just ask you to remember? Reply with just the number.";
    })(),
    sink: { write: (text) => said.push(text), status: () => {} },
  });
  expect(said.join("")).toContain("8315");
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

  const route = livePi();

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
    harness: createPiHarness({ baseUrl: route.baseUrl, token: route.token, api: route.api, model: liveModel }),
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

  await opened.value.close();

  expect(result.status).toBe("completed");
  if (result.status !== "completed") return;
  // It answered from a tool call it never made, because the log told it the
  // answer was already given. Re-running the effect would have been the bug.
  // Commas stripped: a model is free to write the number the way a person would.
  expect(textOf(result.output).replace(/,/g, "")).toContain("1250");
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
 * the vendor. There the second turn arrives at an agent with no idea what "that
 * number" refers to, which is the whole content of `recovery: "none"`.
 */
liveTest("a session started by one harness is continued by another, through the log alone", async () => {
  const route = livePi();
  const store = createSqliteStore({ database: new Database(":memory:") });
  const sessionId = crypto.randomUUID();
  const instructions = "Be brief. Answer with as few words as possible.";

  const ours = await runAgent({
    agent: {
      id: "t", version: "1", instructions,
      harness: createNativeHarness({ model: liveOpenRouter() }),
    },
    store, sessionId, input: "Remember the number 5150. Reply with just: noted.",
  }).result;
  expect(ours.status).toBe("completed");

  const theirs = await runAgent({
    agent: {
      id: "t", version: "1", instructions,
      harness: createPiHarness({ baseUrl: route.baseUrl, token: route.token, api: route.api, model: liveModel }),
    },
    store, sessionId, input: "What number did I ask you to remember? Reply with just the number.",
  }).result;

  expect(theirs.status).toBe("completed");
  if (theirs.status !== "completed") return;
  expect(textOf(theirs.output)).toContain("5150");
  await store.close();
}, 300_000);

/**
 * One list, and what each choice costs.
 *
 * `tools` is the axis the recipe exists for, and it is reachable in two lines
 * that say what the choice means before it is made. It used to be argv-only,
 * so seeing what "theirs" buys took a second run.
 *
 * Driven through `runCommand` rather than `main`, because `main` opens a route
 * and a route needs a credential — and this gate is offline. A version of this
 * that called `main` passed here and would have failed on a clean checkout.
 */
test("one list of what this recipe lets you change, and a number picks a value", () => {
  const lines: string[] = [];
  const sink = { write: () => {}, status: (line: string) => lines.push(line) };
  const choice = { ...defaultChoice };

  const listed = runCommand({ line: "/options", choice, sink });
  // Everything it lets you change, with where each one stands.
  expect(lines.join("")).toContain("tools");
  expect(lines.join("")).toContain("theirs");
  expect(listed.choosing?.axis).toBeNull();

  lines.length = 0;
  const opened = runCommand({ line: "1", choice, sink, choosing: listed.choosing });
  // Drilling in is not choosing: no value is set by opening a list.
  expect(opened.set).toBeUndefined();
  expect(opened.choosing?.axis).toBe("tools");

  const picked = runCommand({ line: "1", choice, sink, choosing: opened.choosing });
  expect(picked.set).toEqual({ axis: "tools", value: "ours" });
  // The consequence, said before the move rather than discovered after it.
  expect(lines.join("")).toContain("validated here and gated by `decide`");
  expect(patched(choice, picked.set!.axis, picked.set!.value).tools).toBe("ours");

  // An axis with no list is answered by the next line, whatever it says.
  lines.length = 0;
  const relisted = runCommand({ line: "/options", choice, sink });
  const named = runCommand({ line: "3", choice, sink, choosing: relisted.choosing });
  expect(named.choosing).toEqual({ axis: "model", label: "model", choices: [] });
  const typed = runCommand({ line: "openai/gpt-5", choice, sink, choosing: named.choosing });
  expect(typed.set).toEqual({ axis: "model", value: "openai/gpt-5" });
});

/**
 * The union that never ran.
 *
 * `--tools both` used to offer Pi's tools *and* ours in one list. Against a
 * vendor whose tools arrive namespaced inside its own process that is the
 * interesting mode; against Pi, `state.tools` is one flat list and both sides
 * call their shell `bash`, so `createExecutor` refused it before a turn began.
 * The names are the evidence, and this is what makes the axis two values.
 */
test("ours and Pi's are the same three jobs, which is why there is no union", async () => {
  const provider = createLocalSandboxProvider({ root: process.cwd() });
  const opened = await provider.create({ isolation: "none", network: { mode: "unrestricted" } });
  expect(opened.ok).toBe(true);
  if (!opened.ok) return;

  const theirs = piCodingTools(opened.value).map((tool) => tool.spec.name);
  const ours = sandboxTools(opened.value).map((tool) => tool.spec.name);
  expect(theirs).toContain("bash");
  expect(ours).toContain("bash");
  await opened.value.close();
});
