import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runAgent } from "../../../run.js";
import { defineTool } from "../../../tools/tool.js";
import { createSqliteStore } from "../../../store/adapters/sqlite.js";
import { textOf } from "../../../content.js";
import type { Agent } from "../../../agent.js";
import type { Store } from "../../../store/store.js";
import type { JsonValue } from "../../../json.js";
import { codexAccount, createCodexHarness, signInToCodex, type CodexConnection, type CodexHarnessOptions } from "./index.js";

type Step = { say?: string; call?: { tool: string; arguments: JsonValue }; item?: string; connector?: { server: string; tool: string; result: string }; fail?: string };

/**
 * An app server, scripted. It keeps threads across connections the way Codex
 * keeps them in `CODEX_HOME`, so resuming is tested against a thread that
 * survived the process, and it writes down every request it was sent.
 */
function fakeServer(script: (turn: number, input: JsonValue) => Step[]) {
  const threads = new Map<string, { tools: JsonValue }>();
  const sent: { method: string; params: JsonValue }[] = [];
  const argv: string[][] = [];
  let turns = 0;
  const connect = (args: readonly string[]): CodexConnection => {
    argv.push([...args]);
    const out: JsonValue[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    const replies = new Map<number, (value: JsonValue) => void>();
    let serverId = 1000;
    const push = (message: JsonValue) => { out.push(message); wake?.(); };
    const ask = (method: string, params: JsonValue) => new Promise<JsonValue>((resolve) => { serverId += 1; replies.set(serverId, resolve); push({ id: serverId, method, params }); });
    const notify = (method: string, params: JsonValue) => push({ method, params });
    const runTurn = async (threadId: string, turnId: string, input: JsonValue) => {
      turns += 1;
      let total = 0;
      for (const step of script(turns, input)) {
        if (step.fail) { notify("turn/completed", { threadId, turn: { id: turnId, status: "failed", error: { message: step.fail } } }); return; }
        if (step.item) notify("item/started", { threadId, turnId, item: { type: step.item, id: "x" } });
        if (step.say) notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: "m", text: step.say } });
        if (step.connector) {
          const item = { type: "mcpToolCall", id: "m1", server: step.connector.server, tool: step.connector.tool, arguments: { query: "launch" } };
          notify("item/started", { threadId, turnId, item: { ...item, status: "inProgress", result: null, error: null } });
          notify("item/completed", { threadId, turnId, item: { ...item, status: "completed", result: { content: [{ type: "text", text: step.connector.result }], structuredContent: null, _meta: null }, error: null } });
        }
        if (step.call) await ask("item/tool/call", { threadId, turnId, callId: `call_${turns}`, namespace: null, tool: step.call.tool, arguments: step.call.arguments });
        total += 10;
        notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { total: { inputTokens: 100 + total, cachedInputTokens: total / 2, cacheWriteInputTokens: 0, outputTokens: total / 2, reasoningOutputTokens: 0, totalTokens: 0 }, last: { inputTokens: 10, cachedInputTokens: 5, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 0 }, modelContextWindow: null } });
      }
      notify("turn/completed", { threadId, turn: { id: turnId, status: "completed", error: null } });
    };
    return {
      send(message) {
        const record = message as { id?: number; method?: string; params?: JsonValue; result?: JsonValue };
        if (!record.method) { replies.get(record.id!)?.(record.result ?? null); return; }
        sent.push({ method: record.method, params: record.params ?? null });
        const reply = (result: JsonValue) => push({ id: record.id!, result });
        const params = (record.params ?? {}) as Record<string, JsonValue>;
        if (record.method === "initialize") reply({ userAgent: "fake" });
        else if (record.method === "thread/start") { const id = `thread-${threads.size + 1}`; threads.set(id, { tools: params["dynamicTools"] ?? null }); reply({ thread: { id } }); }
        else if (record.method === "thread/resume") {
          if (threads.has(String(params["threadId"]))) reply({ thread: { id: params["threadId"]! } });
          else push({ id: record.id!, error: { code: -32600, message: "no rollout found for thread id" } });
        } else if (record.method === "turn/start") { const turnId = `turn-${turns + 1}`; reply({ turn: { id: turnId, status: "inProgress" } }); void runTurn(String(params["threadId"]), turnId, params["input"] ?? null); }
        else if (record.method === "account/read") reply({ account: { type: "chatgpt", email: "owner@example.com", planType: "pro" } });
        else if (record.method === "account/login/start") { reply({ type: "chatgptDeviceCode", loginId: "l1", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" }); setTimeout(() => notify("account/login/completed", { loginId: "l1", success: true, error: null }), 5); }
        else if (record.id !== undefined) reply({});
      },
      messages: (async function* () {
        while (true) {
          while (out.length) yield out.shift()!;
          if (closed) return;
          await new Promise<void>((resolve) => { wake = resolve; });
        }
      })(),
      close() { closed = true; wake?.(); },
    };
  };
  return { connect, sent, argv, threads };
}

const ledger = defineTool({
  name: "read_ledger", description: "Read one account.",
  schema: z.object({ account: z.string() }),
  execute: (args) => ({ content: `${args.account}: 1250` }),
});

const agent = (connect: CodexHarnessOptions["connect"], tools = [ledger], connectors?: boolean): Agent => ({
  id: "a", version: "1", instructions: "Answer from the ledger.", tools,
  harness: createCodexHarness({ model: "gpt-6", cwd: "/", env: { PATH: "/bin" }, ...(connect ? { connect } : {}), ...(connectors ? { connectors } : {}) }),
});

async function entries(store: Store) {
  const read = await store.read({ sessionId: "s" });
  if (!read.ok) throw new Error(read.error.message);
  return read.value.entries;
}

test("our tools are the thread's whole tool list, and each call runs through the executor and the log", async () => {
  const server = fakeServer(() => [{ say: "Looking.", call: { tool: "read_ledger", arguments: { account: "ops" } } }, { say: "It is 1250." }]);
  const store = createSqliteStore({ database: new Database(":memory:") });
  const result = await runAgent({ agent: agent(server.connect), store, sessionId: "s", input: "balance?" }).result;
  expect(result.status).toBe("completed");
  if (result.status === "completed") expect(textOf(result.output)).toBe("It is 1250.");

  const started = server.sent.find((request) => request.method === "thread/start")!.params as Record<string, JsonValue>;
  expect(started["baseInstructions"]).toBe("Answer from the ledger.");
  expect(started["approvalPolicy"]).toBe("never");
  expect(started["sandbox"]).toBe("read-only");
  expect((started["dynamicTools"] as { name: string }[]).map((tool) => tool.name)).toEqual(["read_ledger"]);
  // Codex's own tools are switched off at the process, not left to a refusal.
  expect(server.argv[0]).toEqual(expect.arrayContaining(["--disable", "shell_tool", "--disable", "unified_exec", "--disable", "apps", "-c", 'web_search="disabled"']));

  const log = await entries(store);
  expect(log.map((entry) => entry.type)).toEqual(["run.started", "assistant", "tool.started", "tool.finished", "assistant", "run.finished"]);
  expect(log[1]).toMatchObject({ content: "Looking.", calls: [{ callId: "call_1", name: "read_ledger", arguments: '{"account":"ops"}' }] });
  expect(log[3]).toMatchObject({ result: { content: "ops: 1250" } });
  // The turn's tokens — the thread's total less what it had before — with cached input apart from fresh.
  expect(log[4]).toMatchObject({ providerState: { provider: "codex-app-server", items: [{ session: "thread-1" }] }, usage: { inputTokens: 10, cacheReadTokens: 10, outputTokens: 10 } });
});

test("the next activation resumes the thread with only what is new; a changed tool list starts a new one", async () => {
  const server = fakeServer((_turn, input) => [{ say: `Heard ${JSON.stringify(input).length}` }]);
  const store = createSqliteStore({ database: new Database(":memory:") });
  await runAgent({ agent: agent(server.connect), store, sessionId: "s", input: "one" }).result;
  await runAgent({ agent: agent(server.connect), store, sessionId: "s", input: "two" }).result;
  const resumed = server.sent.filter((request) => request.method === "thread/resume");
  expect(resumed).toHaveLength(1);
  expect(server.sent.filter((request) => request.method === "turn/start").at(-1)!.params).toMatchObject({ threadId: "thread-1", input: [{ type: "text", text: "two" }] });

  const other = defineTool({ name: "read_other", description: "Another.", schema: z.object({}), execute: () => ({ content: "" }) });
  await runAgent({ agent: agent(server.connect, [ledger, other]), store, sessionId: "s", input: "three" }).result;
  expect(server.sent.filter((request) => request.method === "thread/start")).toHaveLength(2);
  const opened = server.sent.filter((request) => request.method === "turn/start").at(-1)!.params as { input: { text: string }[] };
  expect(opened.input[0]!.text).toContain("<conversation-so-far>");
  expect(opened.input[0]!.text.endsWith("three")).toBe(true);
});

test("a thread Codex no longer has starts again from the transcript", async () => {
  const server = fakeServer(() => [{ say: "ok" }]);
  const store = createSqliteStore({ database: new Database(":memory:") });
  await runAgent({ agent: agent(server.connect), store, sessionId: "s", input: "one" }).result;
  server.threads.clear();
  const result = await runAgent({ agent: agent(server.connect), store, sessionId: "s", input: "two" }).result;
  expect(result.status).toBe("completed");
  expect(server.sent.filter((request) => request.method === "thread/start")).toHaveLength(2);
});

test("input arriving at turn priority steers the running turn after a tool result", async () => {
  const store = createSqliteStore({ database: new Database(":memory:") });
  await store.create({ sessionId: "peer", agent: { id: "a", version: "1" } });
  const correcting = defineTool({
    name: "read_ledger", description: "Read one account.", schema: z.object({ account: z.string() }),
    execute: async (args) => {
      const sent = await store.append({ sessionId: "peer", expectedSeq: 0, entries: [], enqueue: [{ sessionId: "s", input: "Correction: use savings", priority: "turn" }] });
      if (!sent.ok) throw new Error(sent.error.message);
      return { content: `${args.account}: 1250` };
    },
  });
  const server = fakeServer(() => [{ call: { tool: "read_ledger", arguments: { account: "ops" } } }, { say: "Savings, then." }]);
  const result = await runAgent({ agent: agent(server.connect, [correcting]), store, sessionId: "s", input: "balance?" }).result;
  expect(result.status).toBe("completed");
  expect(server.sent.find((request) => request.method === "turn/steer")?.params).toMatchObject({ threadId: "thread-1", expectedTurnId: "turn-1", input: [{ type: "text", text: "Correction: use savings" }] });
});

test("a tool of Codex's own fails the turn rather than running on the host", async () => {
  const server = fakeServer(() => [{ item: "commandExecution" }, { say: "ran it" }]);
  const store = createSqliteStore({ database: new Database(":memory:") });
  const result = await runAgent({ agent: agent(server.connect), store, sessionId: "s", input: "hi" }).result;
  expect(result.status).toBe("failed");
  if (result.status === "failed") expect(result.error.message).toContain("commandExecution");
  expect(server.sent.some((request) => request.method === "turn/interrupt")).toBe(true);
});

test("with connectors on, a ChatGPT connector is allowed and recorded as a note; any other MCP call still fails the turn", async () => {
  const server = fakeServer(() => [{ say: "Searching Slack.", connector: { server: "codex_apps", tool: "slack_search", result: "3 messages in #launch" } }, { say: "Found it." }]);
  const store = createSqliteStore({ database: new Database(":memory:") });
  const result = await runAgent({ agent: agent(server.connect, [ledger], true), store, sessionId: "s", input: "what happened with the launch?" }).result;
  expect(result.status).toBe("completed");
  expect(server.argv[0]).not.toContain("apps");
  expect(server.argv[0]).toEqual(expect.arrayContaining(["--disable", "shell_tool"]));
  const log = await entries(store);
  expect(log.map((entry) => entry.type)).toEqual(["run.started", "assistant", "assistant", "run.finished"]);
  expect(log[1]).toMatchObject({ content: 'Searching Slack.\n\n[connector codex_apps.slack_search] {"query":"launch"}\n→ 3 messages in #launch' });

  const other = fakeServer(() => [{ connector: { server: "someone_elses", tool: "run", result: "" } }]);
  const refused = await runAgent({ agent: agent(other.connect, [ledger], true), store: createSqliteStore({ database: new Database(":memory:") }), sessionId: "s", input: "hi" }).result;
  expect(refused.status).toBe("failed");
});

test("a failed turn fails the run with what Codex said", async () => {
  const server = fakeServer(() => [{ fail: "usage limit reached" }]);
  const store = createSqliteStore({ database: new Database(":memory:") });
  const result = await runAgent({ agent: agent(server.connect), store, sessionId: "s", input: "hi" }).result;
  expect(result.status).toBe("failed");
  if (result.status === "failed") expect(result.error.message).toContain("usage limit reached");
});

test("signing in hands back the device code, and the account reads back", async () => {
  const server = fakeServer(() => []);
  const signing = await signInToCodex({ env: {}, connect: server.connect });
  if (!signing.ok) throw new Error(signing.error.message);
  expect(signing.value).toMatchObject({ verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" });
  expect((await signing.value.completed).ok).toBe(true);
  expect(server.sent.find((request) => request.method === "account/login/start")?.params).toEqual({ type: "chatgptDeviceCode" });
  const account = await codexAccount({ env: {}, connect: server.connect });
  expect(account).toEqual({ ok: true, value: { signedIn: true, kind: "chatgpt", email: "owner@example.com", plan: "pro" } });
});

/**
 * The real binary, against a local stand-in for the Responses API: no network
 * and no credential, but the tool list is the one Codex really sends. Opt-in,
 * because it needs the Codex binary.
 */
const executable = process.env["CODEX_EXECUTABLE"];
test.skipIf(!executable)("the binary offers the model our tools and nothing else, and runs a call through the log", async () => {
  const requests: { tools?: { name?: string; type: string }[]; input: unknown[] }[] = [];
  const server = Bun.serve({ port: 0, async fetch(request) {
    if (!new URL(request.url).pathname.endsWith("/responses")) return Response.json({ data: [], models: [] });
    const body = await request.json() as { tools?: { name?: string; type: string }[]; input: unknown[]; model: string };
    requests.push(body);
    const answered = JSON.stringify(body.input).includes("function_call_output");
    const item = answered
      ? { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "It is 1250.", annotations: [] }] }
      : { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_ledger", arguments: '{"account":"ops"}', status: "completed" };
    const response = { id: `resp_${requests.length}`, object: "response", status: "completed", model: body.model, output: [item], usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 } };
    const events = [{ type: "response.created", response: { ...response, status: "in_progress", output: [] } }, { type: "response.output_item.added", output_index: 0, item }, { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response }];
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  } });
  const home = await mkdtemp(join(tmpdir(), "aglib-codex-"));
  try {
    const store = createSqliteStore({ database: new Database(":memory:") });
    const harness = createCodexHarness({
      model: "gpt-6", cwd: home, command: [executable!, "app-server"],
      env: { PATH: process.env["PATH"] ?? "", HOME: home, CODEX_HOME: home, FAKE_KEY: "x" },
      config: { "model_providers.fake": `{name="fake",base_url="http://127.0.0.1:${server.port}/v1",wire_api="responses",env_key="FAKE_KEY"}`, model_provider: '"fake"' },
    });
    const result = await runAgent({ agent: { id: "a", version: "1", instructions: "Answer from the ledger.", tools: [ledger], harness }, store, sessionId: "s", input: "balance?" }).result;
    expect(result.status).toBe("completed");
    if (result.status === "completed") expect(textOf(result.output)).toBe("It is 1250.");
    expect(requests[0]!.tools!.map((tool) => tool.name ?? tool.type)).toEqual(["read_ledger"]);
    const log = await entries(store);
    expect(log.map((entry) => entry.type)).toEqual(["run.started", "assistant", "tool.started", "tool.finished", "assistant", "run.finished"]);

    const again = await runAgent({ agent: { id: "a", version: "1", instructions: "Answer from the ledger.", tools: [ledger], harness }, store, sessionId: "s", input: "and again?" }).result;
    expect(again.status).toBe("completed");
    expect(JSON.stringify(requests.at(-1)!.input)).toContain("balance?");
  } finally {
    server.stop(true);
    await rm(home, { recursive: true, force: true });
  }
}, 120_000);
