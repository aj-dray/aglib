import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { z } from "zod";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { runAgent } from "../../../run.js";
import { defineTool } from "../../../tools/tool.js";
import { createSqliteStore } from "../../../store/adapters/sqlite.js";
import { textOf } from "../../../content.js";
import type { Agent } from "../../../agent.js";
import type { Store } from "../../../store/store.js";
import { createClaudeAgentSdkHarness, type ClaudeAgentSdkHarnessOptions } from "./index.js";

/**
 * The SDK's `query`, scripted. It reads the prompt stream like the real one,
 * reaches our tools through the MCP server we hand it — the real server, over a
 * transport, so a schema the SDK could not convert fails here too — and
 * answers each turn from `script`.
 */
type Step = { say?: string; call?: { name: string; args: unknown }; connector?: { name: string; args: unknown; result: string }; fail?: string };
function fakeQuery(script: (turn: number, prompts: unknown[]) => Step[], seen: { options?: Record<string, unknown>; prompts: unknown[] } = { prompts: [] }) {
  return ((input: { prompt: AsyncIterable<SDKUserMessage>; options: Record<string, unknown> }) => {
    seen.options = input.options;
    return (async function* (): AsyncGenerator<SDKMessage> {
      const session = (input.options["resume"] as string | undefined) ?? "sess-new";
      const call = await connect((input.options["mcpServers"] as Record<string, { instance: unknown }>)["tools"]!.instance);
      yield { type: "system", subtype: "init", session_id: session } as unknown as SDKMessage;
      let turn = 0;
      for await (const message of input.prompt) {
        seen.prompts.push(message.message.content);
        turn += 1;
        for (const step of script(turn, seen.prompts)) {
          if (step.fail) {
            yield { type: "result", subtype: "error_during_execution", errors: [step.fail], usage: {}, session_id: session, user_message_uuid: message.uuid } as unknown as SDKMessage;
            return;
          }
          if (step.say) yield { type: "assistant", parent_tool_use_id: null, session_id: session, message: { model: "claude-test", content: [{ type: "text", text: step.say }] } } as unknown as SDKMessage;
          if (step.connector) {
            const id = `toolu_${turn}_connector`;
            yield { type: "assistant", parent_tool_use_id: null, session_id: session, message: { model: "claude-test", content: [{ type: "tool_use", id, name: step.connector.name, input: step.connector.args }] } } as unknown as SDKMessage;
            yield { type: "user", parent_tool_use_id: null, session_id: session, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: step.connector.result }] }] } } as unknown as SDKMessage;
          }
          if (step.call) {
            const id = `toolu_${turn}_${step.call.name}`;
            yield { type: "assistant", parent_tool_use_id: null, session_id: session, message: { model: "claude-test", content: [{ type: "tool_use", id, name: `mcp__tools__${step.call.name}`, input: step.call.args }] } } as unknown as SDKMessage;
            await call(step.call.name, step.call.args);
          }
        }
        yield { type: "result", subtype: "success", session_id: session, user_message_uuid: message.uuid, usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 }, total_cost_usd: 1 } as unknown as SDKMessage;
      }
    })();
  }) as unknown as NonNullable<ClaudeAgentSdkHarnessOptions["query"]>;
}

/** A minimal MCP client over an in-memory transport: initialize, then tools/call. */
async function connect(instance: unknown) {
  let onmessage: ((message: unknown) => void) | undefined;
  const replies = new Map<number, (value: unknown) => void>();
  const transport = {
    onmessage: undefined as ((message: unknown) => void) | undefined,
    onclose: undefined, onerror: undefined,
    async start() { onmessage = transport.onmessage; },
    async send(message: { id?: number; result?: unknown; error?: unknown }) { if (message.id !== undefined) replies.get(message.id)?.(message.result ?? message.error); },
    async close() {},
  };
  await (instance as { connect(t: unknown): Promise<void> }).connect(transport);
  let id = 0;
  const request = (method: string, params: unknown) => new Promise<unknown>((resolve) => { id += 1; replies.set(id, resolve); onmessage!({ jsonrpc: "2.0", id, method, params }); });
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  return (name: string, args: unknown) => request("tools/call", { name, arguments: args });
}

const ledger = defineTool({
  name: "read_ledger", description: "Read one account.",
  schema: z.object({ account: z.string() }),
  execute: (args) => ({ content: `${args.account}: 1250` }),
});

const agent = (query: ClaudeAgentSdkHarnessOptions["query"], connectors?: boolean): Agent => ({
  id: "a", version: "1", instructions: "Answer from the ledger.", tools: [ledger],
  harness: createClaudeAgentSdkHarness({ model: "opus", env: { PATH: "/bin" }, cwd: "/", ...(query ? { query } : {}), ...(connectors ? { connectors } : {}) }),
});

async function entries(store: Store, sessionId = "s") {
  const read = await store.read({ sessionId });
  if (!read.ok) throw new Error(read.error.message);
  return read.value.entries;
}

test("our tools run through the executor and the log, and the session is recorded for the next activation", async () => {
  const store = createSqliteStore({ database: new Database(":memory:") });
  const seen = { prompts: [] as unknown[] } as { options?: Record<string, unknown>; prompts: unknown[] };
  const query = fakeQuery(() => [{ say: "Looking.", call: { name: "read_ledger", args: { account: "ops" } } }, { say: "It is 1250." }], seen);
  const result = await runAgent({ agent: agent(query), store, sessionId: "s", input: "balance?" }).result;
  expect(result.status).toBe("completed");
  if (result.status === "completed") expect(textOf(result.output)).toBe("It is 1250.");

  // Nothing of Claude Code's own: no built-in tools, our instructions as the system prompt.
  expect(seen.options?.["tools"]).toEqual([]);
  expect(seen.options?.["allowedTools"]).toEqual(["mcp__tools__read_ledger"]);
  expect(seen.options?.["systemPrompt"]).toEqual(["Answer from the ledger."]);
  expect(seen.options?.["settingSources"]).toEqual([]);
  // The account's connectors are not even fetched unless asked for.
  expect(seen.options?.["settings"]).toEqual({ disableClaudeAiConnectors: true });
  expect(seen.options?.["permissionMode"]).toBe("dontAsk");

  const log = await entries(store);
  expect(log.map((entry) => entry.type)).toEqual(["run.started", "assistant", "tool.started", "tool.finished", "assistant", "run.finished"]);
  const asked = log[1]!;
  expect(asked).toMatchObject({ content: "Looking.", calls: [{ callId: "toolu_1_read_ledger", name: "read_ledger", arguments: '{"account":"ops"}' }] });
  expect(log[3]).toMatchObject({ result: { content: "ops: 1250" } });
  // Tokens are recorded; the SDK's computed cost is not a cost anyone was charged.
  expect(log[4]).toMatchObject({ providerState: { provider: "claude-agent-sdk", items: [{ session: "sess-new" }] }, usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 5 } });
  expect((log[4] as { usage?: { costUsd?: number } }).usage?.costUsd).toBeUndefined();
});

test("the next activation resumes the session and sends only what is new", async () => {
  const store = createSqliteStore({ database: new Database(":memory:") });
  await runAgent({ agent: agent(fakeQuery(() => [{ say: "First." }])), store, sessionId: "s", input: "one" }).result;
  const seen = { prompts: [] as unknown[] } as { options?: Record<string, unknown>; prompts: unknown[] };
  const result = await runAgent({ agent: agent(fakeQuery(() => [{ say: "Second." }], seen)), store, sessionId: "s", input: "two" }).result;
  expect(result.status).toBe("completed");
  expect(seen.options?.["resume"]).toBe("sess-new");
  expect(seen.prompts).toEqual(["two"]);
});

test("after another model spoke, a fresh session opens with the conversation so far", async () => {
  const store = createSqliteStore({ database: new Database(":memory:") });
  await runAgent({ agent: agent(fakeQuery(() => [{ say: "First." }])), store, sessionId: "s", input: "one" }).result;
  // Another harness answered since: the vendor's copy of the conversation is behind the log.
  const append = await store.read({ sessionId: "s" });
  if (!append.ok) throw new Error("read");
  await store.append({ sessionId: "s", expectedSeq: append.value.seq, entries: [
    { type: "run.started", runId: "r-other", input: "elsewhere" },
    { type: "assistant", runId: "r-other", content: "From another model." },
    { type: "run.finished", runId: "r-other", outcome: "completed" },
  ] });
  const seen = { prompts: [] as unknown[] } as { options?: Record<string, unknown>; prompts: unknown[] };
  await runAgent({ agent: agent(fakeQuery(() => [{ say: "Third." }], seen)), store, sessionId: "s", input: "three" }).result;
  expect(seen.options?.["resume"]).toBeUndefined();
  const opened = String(seen.prompts[0]);
  expect(opened).toContain("<conversation-so-far>");
  expect(opened).toContain("From another model.");
  expect(opened).toContain("First.");
  expect(opened.endsWith("three")).toBe(true);
});

test("a session the vendor no longer has starts again from the transcript", async () => {
  const store = createSqliteStore({ database: new Database(":memory:") });
  await runAgent({ agent: agent(fakeQuery(() => [{ say: "First." }])), store, sessionId: "s", input: "one" }).result;
  const calls: Record<string, unknown>[] = [];
  const inner = fakeQuery((turn, prompts) => calls.length === 1 ? [{ fail: "No conversation found with session ID: sess-new" }] : [{ say: `Again ${String(prompts.at(-1)).includes("First.")}` }]);
  const query = ((input: { options: Record<string, unknown> }) => { calls.push(input.options); return (inner as (i: unknown) => unknown)(input); }) as unknown as ClaudeAgentSdkHarnessOptions["query"];
  const result = await runAgent({ agent: agent(query), store, sessionId: "s", input: "two" }).result;
  expect(calls.map((options) => options["resume"])).toEqual(["sess-new", undefined]);
  expect(result.status).toBe("completed");
  if (result.status === "completed") expect(textOf(result.output)).toBe("Again true");
});

test("input arriving at turn priority reaches the running turn after a tool result", async () => {
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
  const query = fakeQuery((turn) => turn === 1 ? [{ call: { name: "read_ledger", args: { account: "ops" } } }, { say: "Ops is 1250." }] : [{ say: "Savings, then." }]);
  const result = await runAgent({ agent: { ...agent(query), tools: [correcting] }, store, sessionId: "s", input: "balance?" }).result;
  expect(result.status).toBe("completed");
  if (result.status === "completed") expect(textOf(result.output)).toBe("Ops is 1250.\n\nSavings, then.");
  const log = await entries(store);
  expect(log.filter((entry) => entry.type === "run.started").map((entry) => (entry as { input: unknown }).input)).toEqual(["balance?", "Correction: use savings"]);
});

test("a refused request, reported as a result flagged as an error, fails the run with its reason", async () => {
  const store = createSqliteStore({ database: new Database(":memory:") });
  const query = ((input: { prompt: AsyncIterable<SDKUserMessage> }) => (async function* () {
    for await (const message of input.prompt) {
      yield { type: "result", subtype: "success", is_error: true, result: "Failed to authenticate. API Error: 401 OAuth access token is invalid.", session_id: "s1", user_message_uuid: message.uuid, usage: {} } as unknown as SDKMessage;
    }
  })()) as unknown as ClaudeAgentSdkHarnessOptions["query"];
  const result = await runAgent({ agent: agent(query), store, sessionId: "s", input: "hi" }).result;
  expect(result.status).toBe("failed");
  if (result.status === "failed") expect(result.error.message).toContain("401 OAuth access token is invalid");
});

test("a vendor failure fails the run with what it said", async () => {
  const store = createSqliteStore({ database: new Database(":memory:") });
  const result = await runAgent({ agent: agent(fakeQuery(() => [{ fail: "OAuth token has expired" }])), store, sessionId: "s", input: "hi" }).result;
  expect(result.status).toBe("failed");
  if (result.status === "failed") expect(result.error.message).toContain("OAuth token has expired");
});

/**
 * The real binary, against a local stand-in for Anthropic's API: no network and
 * no credential, but every byte the process sends is the one it would send.
 * Opt-in, because it needs the platform binary the SDK ships separately.
 */
const executable = process.env["CLAUDE_CODE_EXECUTABLE"];
test.skipIf(!executable).each([false, true])("the binary offers the model our tools and nothing else, and runs a call through the log (connectors %p)", async (connectors) => {
  const requests: { system?: unknown; tools?: { name: string }[]; messages: unknown[] }[] = [];
  const server = Bun.serve({ port: 0, async fetch(request) {
    if (!new URL(request.url).pathname.endsWith("/messages")) return Response.json({});
    const body = await request.json() as { system?: unknown; tools?: { name: string }[]; messages: unknown[]; model: string };
    requests.push(body);
    const answered = JSON.stringify(body.messages).includes("tool_result");
    const blocks = answered
      ? [{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "It is 1250." } }, { type: "content_block_stop", index: 0 }]
      : [{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "mcp__tools__read_ledger", input: {} } }, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"account":"ops"}' } }, { type: "content_block_stop", index: 0 }];
    const events = [{ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 7, output_tokens: 1 } } }, ...blocks,
      { type: "message_delta", delta: { stop_reason: answered ? "end_turn" : "tool_use" }, usage: { output_tokens: 4 } }, { type: "message_stop" }];
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  } });
  const home = await import("node:fs/promises").then((fs) => fs.mkdtemp(`${(process.env["TMPDIR"] ?? "/tmp")}/aglib-claude-`));
  try {
    const store = createSqliteStore({ database: new Database(":memory:") });
    const harness = createClaudeAgentSdkHarness({
      model: "claude-opus-5-5", cwd: home, executable: executable!, connectors,
      env: { PATH: process.env["PATH"] ?? "", HOME: home, CLAUDE_CONFIG_DIR: `${home}/config`, ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    });
    const result = await runAgent({ agent: { id: "a", version: "1", instructions: "Answer from the ledger.", tools: [ledger], harness }, store, sessionId: "s", input: "balance?" }).result;
    expect(result.status).toBe("completed");
    if (result.status === "completed") expect(textOf(result.output)).toBe("It is 1250.");
    const offered = requests[0]!.tools!.map((tool) => tool.name).filter((name) => !name.startsWith("Deferred"));
    expect(offered).toEqual(["mcp__tools__read_ledger"]);
    expect(JSON.stringify(requests[0]!.system)).toContain("Answer from the ledger.");
    const log = await entries(store);
    expect(log.map((entry) => entry.type)).toEqual(["run.started", "assistant", "tool.started", "tool.finished", "assistant", "run.finished"]);
    expect(log[3]).toMatchObject({ result: { content: "ops: 1250" } });

    // The next activation resumes the session the log names, from the config directory.
    const again = await runAgent({ agent: { id: "a", version: "1", instructions: "Answer from the ledger.", tools: [ledger], harness }, store, sessionId: "s", input: "and again?" }).result;
    expect(again.status).toBe("completed");
    expect(JSON.stringify(requests.at(-1)!.messages)).toContain("balance?");
  } finally {
    server.stop(true);
    await import("node:fs/promises").then((fs) => fs.rm(home, { recursive: true, force: true }));
  }
}, 120_000);

test("with connectors on, an account connector is allowed and recorded as a note, and nothing else of Claude Code's is", async () => {
  const store = createSqliteStore({ database: new Database(":memory:") });
  const seen = { prompts: [] as unknown[] } as { options?: Record<string, unknown>; prompts: unknown[] };
  const query = fakeQuery(() => [
    { say: "Searching Slack.", connector: { name: "mcp__claude_ai_Slack__slack_search", args: { query: "launch" }, result: "3 messages in #launch" } },
    { call: { name: "read_ledger", args: { account: "ops" } } },
    { say: "Found it." },
  ], seen);
  const result = await runAgent({ agent: agent(query, true), store, sessionId: "s", input: "what happened with the launch?" }).result;
  expect(result.status).toBe("completed");

  expect(seen.options?.["settings"]).toBeUndefined();
  const decide = seen.options?.["canUseTool"] as (name: string, input: object, about: object) => Promise<{ behavior: string }>;
  expect((await decide("mcp__claude_ai_Slack__slack_search", {}, { mcpServer: { name: "claude_ai_Slack", source: "claudeai" } })).behavior).toBe("allow");
  expect((await decide("mcp__elsewhere__run", {}, { mcpServer: { name: "elsewhere", source: "user" } })).behavior).toBe("deny");
  expect((await decide("Bash", {}, {})).behavior).toBe("deny");

  const log = await entries(store);
  expect(log.map((entry) => entry.type)).toEqual(["run.started", "assistant", "assistant", "tool.started", "tool.finished", "assistant", "run.finished"]);
  // A note, not a call: a model that takes the session over has no such tool.
  expect(log[1]).toMatchObject({ content: 'Searching Slack.\n\n[connector mcp__claude_ai_Slack__slack_search] {"query":"launch"}\n→ 3 messages in #launch' });
  expect((log[1] as { calls?: unknown }).calls).toBeUndefined();
});
