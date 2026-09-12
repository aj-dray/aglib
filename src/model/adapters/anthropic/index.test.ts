import { expect, test } from "bun:test";
import { createAnthropicModel } from "./index.js";
import { collect } from "../../model.js";
import type { Message } from "../../../session/messages.js";

/**
 * What this adapter puts on the wire that the conformance suite cannot say.
 *
 * The contract every implementation answers — one result, typed failures,
 * cancellation, tool arguments that parse, and whether each request option was
 * sent or honestly dropped — lives in `src/model/conformance.ts` and runs
 * against this adapter there. What is left here is this wire's own shape, and
 * every defect it exists to catch was an encoding defect: a thinking budget the
 * current models reject, a cache mark landing on the wrong block, turn context
 * hoisted into the prefix it must sit after. All three typechecked.
 */

const sse = (...frames: unknown[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n`));
      controller.close();
    },
  });
};

const answered = () => sse(
  { type: "message_start", message: { model: "claude-opus-5", usage: { input_tokens: 10 } } },
  { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
);

function capturing(body: () => ReadableStream<Uint8Array> = answered) {
  const sent: Record<string, unknown>[] = [];
  const model = createAnthropicModel({
    apiKey: "k", model: "claude-opus-5",
    fetch: (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(body(), { status: 200 });
    }) as unknown as typeof fetch,
  });
  return { model, sent };
}

const conversation: readonly Message[] = [
  { role: "system", content: "You are a bookkeeper." },
  { role: "system", content: "Remembered: the ledger closes Friday." },
  { role: "user", content: "What is the balance?" },
  { role: "system", content: "The time is 14:02." },
];

test("effort is adaptive thinking plus an effort level, never a token budget", async () => {
  const { model, sent } = capturing();
  await collect(model.generate({ messages: conversation, effort: "xhigh" }));

  expect(sent[0]!["thinking"]).toEqual({ type: "adaptive" });
  expect(sent[0]!["output_config"]).toEqual({ effort: "xhigh" });
  expect(JSON.stringify(sent[0])).not.toContain("budget_tokens");
});

test("only the leading run of system messages becomes the system prompt", async () => {
  const { model, sent } = capturing();
  await collect(model.generate({ messages: conversation }));

  const system = sent[0]!["system"] as { text: string }[];
  expect(system.map((block) => block.text)).toEqual([
    "You are a bookkeeper.",
    "Remembered: the ledger closes Friday.",
  ]);

  // Turn-scoped context stays in the conversation, after the boundary, as the
  // mid-conversation system message it is — not hoisted to the front.
  const messages = sent[0]!["messages"] as { role: string }[];
  expect(messages.map((message) => message.role)).toEqual(["user", "system"]);
});

/**
 * Two breakpoints in the prefix, at its head and at its end.
 *
 * The last is what makes a conversation's own prefix reusable across its turns.
 * The first is what makes an agent's standing instructions reusable across
 * conversations: everything after the first block is composed per conversation,
 * so with one mark at the end a second conversation shares nothing at all and
 * rewrites the instructions it has in common with every other.
 */
test("the prefix is marked at its head and at its end, and nowhere between", async () => {
  const { model, sent } = capturing();
  await collect(model.generate({ messages: conversation, cacheAfter: 2 }));

  const system = sent[0]!["system"] as Record<string, unknown>[];
  expect(system[0]!["cache_control"]).toEqual({ type: "ephemeral" });
  expect(system[system.length - 1]!["cache_control"]).toEqual({ type: "ephemeral" });
  // Anything between buys nothing and spends a budget of four.
  for (const block of system.slice(1, -1)) expect(block).not.toHaveProperty("cache_control");
  // And two is well inside that budget, with the conversation's own mark still
  // to place.
  expect(system.filter((block) => block["cache_control"]).length).toBeLessThanOrEqual(2);
});

/** One block is one mark: the head and the end are the same block. */
test("a single system block carries one breakpoint, not two", async () => {
  const { model, sent } = capturing();
  await collect(model.generate({
    messages: [
      { role: "system", content: "You are a bookkeeper." },
      { role: "user", content: "What is the balance?" },
    ],
    cacheAfter: 1,
  }));

  const system = sent[0]!["system"] as Record<string, unknown>[];
  expect(system).toHaveLength(1);
  expect(system.filter((block) => block["cache_control"]).length).toBe(1);
});

test("the model this adapter was built with is the model it asks for", async () => {
  // There is no name on a request to override it with. A different model is a
  // different `Model`, which is how the loop already hands compaction a cheaper
  // one — and it is what keeps a provider's own ids off a naming convention
  // this package would then have to resolve.
  const { model, sent } = capturing();
  await collect(model.generate({ messages: conversation }));
  expect(sent[0]!["model"]).toBe("claude-opus-5");
});

test("cache writes are counted apart from the tokens that were read back", async () => {
  // The one count this wire has and the OpenAI one does not, so the shared
  // contract cannot ask for it. An application pricing a run bills a write at a
  // different rate from a read, and folding the two loses real money.
  const { model } = capturing(() => sse(
    {
      type: "message_start",
      message: {
        model: "claude-opus-5",
        usage: { input_tokens: 100, cache_read_input_tokens: 60, cache_creation_input_tokens: 30 },
      },
    },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
  ));

  const outcome = await collect(model.generate({ messages: conversation }));
  expect(outcome.ok).toBe(true);
  if (outcome.ok) {
    expect(outcome.value.usage).toEqual({
      inputTokens: 100, outputTokens: 4, cacheReadTokens: 60, cacheWriteTokens: 30,
    });
  }
});

test("signed and redacted thinking blocks survive streaming and a tool continuation unchanged", async () => {
  const { model } = capturing(() => sse(
    { type: "message_start", message: { model: "claude-opus-5", usage: { input_tokens: 10 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "private " } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "thought" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "nature" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "cipher" } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "call-1", name: "read", input: {} } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"account\":" } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "\"main\"}" } },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } },
  ));
  const first = await collect(model.generate({ messages: conversation, effort: "high" }));
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  expect(first.value.message.content).toBe("");
  expect(first.value.providerState?.items).toEqual([
    { type: "thinking", thinking: "private thought", signature: "sig-nature" },
    { type: "redacted_thinking", data: "cipher" },
    { type: "tool_use", id: "call-1", name: "read", input: { account: "main" } },
  ]);

  const continuation = capturing();
  await collect(continuation.model.generate({ messages: [
    { role: "assistant", ...first.value.message, providerState: first.value.providerState },
    { role: "tool", callId: "call-1", content: "1250" },
  ] }));
  expect((continuation.sent[0]!["messages"] as { content: unknown[] }[])[0]!.content).toEqual(
    first.value.providerState?.items,
  );

  const isolated = capturing();
  await collect(isolated.model.generate({ messages: [{
    role: "assistant", content: "safe", calls: [{ callId: "call-1", name: "read", arguments: "{}" }],
    providerState: { provider: "anthropic-messages:another-model", items: [{ type: "redacted_thinking", data: "hidden" }] },
  }] }));
  expect((isolated.sent[0]!["messages"] as { content: unknown[] }[])[0]!.content).toEqual([
    { type: "text", text: "safe" },
    { type: "tool_use", id: "call-1", name: "read", input: {} },
  ]);
});

test("tool-result images and text reach the provider inside their matching parallel results", async () => {
  const { model, sent } = capturing();
  await collect(model.generate({ messages: [
    { role: "assistant", content: "", calls: [
      { callId: "image-only", name: "read", arguments: "{}" },
      { callId: "mixed", name: "read", arguments: "{}" },
    ] },
    { role: "tool", callId: "image-only", content: [
      { type: "image", mediaType: "image/png", source: { kind: "inline", data: "cGl4ZWw=" } },
    ] },
    { role: "tool", callId: "mixed", content: [
      { type: "text", text: "second screenshot" },
      { type: "image", mediaType: "image/jpeg", source: { kind: "url", url: "https://example.test/screen.jpg" } },
    ] },
  ] }));
  expect((sent[0]!["messages"] as unknown[]).at(-1)).toEqual({ role: "user", content: [
    { type: "tool_result", tool_use_id: "image-only", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "cGl4ZWw=" } },
    ] },
    { type: "tool_result", tool_use_id: "mixed", content: [
      { type: "text", text: "second screenshot" },
      { type: "image", source: { type: "url", url: "https://example.test/screen.jpg" } },
    ] },
  ] });
});
