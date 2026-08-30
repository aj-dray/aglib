import { expect, test } from "bun:test";
import {
  decodeAnthropicRequest, encodeAnthropicError, encodeAnthropicMessage, encodeAnthropicStream,
} from "./anthropic-wire.js";
import { createFakeModel } from "./adapters/fake/index.js";
import type { ModelResponse } from "./model.js";

test("a turn's tool result leaves the turn it arrived in", () => {
  const decoded = decodeAnthropicRequest({
    model: "claude-sonnet-5",
    max_tokens: 1024,
    system: "Be brief.",
    messages: [
      { role: "user", content: "What is in the ledger?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Looking." },
          { type: "tool_use", id: "call_1", name: "read", input: { path: "ledger" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "1250 GBP" },
          { type: "text", text: "and the month before?" },
        ],
      },
    ],
  });

  expect(decoded.ok).toBe(true);
  if (!decoded.ok) return;
  // Anthropic has two roles and puts tool traffic in blocks; we have four and
  // put it in fields. This is the whole of the conversion.
  expect(decoded.value.request.messages).toEqual([
    { role: "system", content: "Be brief." },
    // A string turn stays a string: `Content` is either, and wrapping it
    // would be inventing a part the client did not send.
    { role: "user", content: "What is in the ledger?" },
    {
      role: "assistant",
      content: [{ type: "text", text: "Looking." }],
      calls: [{ callId: "call_1", name: "read", arguments: JSON.stringify({ path: "ledger" }) }],
    },
    { role: "tool", callId: "call_1", content: "1250 GBP" },
    { role: "user", content: [{ type: "text", text: "and the month before?" }] },
  ]);
});

test("an operator instruction sent mid-conversation is a system message, not a refusal", () => {
  const decoded = decodeAnthropicRequest({
    model: "m", max_tokens: 16,
    messages: [
      { role: "user", content: "hello" },
      { role: "system", content: [{ type: "text", text: "Terse mode." }] },
    ],
  });
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) return;
  expect(decoded.value.request.messages.at(-1)).toEqual({
    role: "system", content: [{ type: "text", text: "Terse mode." }],
  });
});

test("a body this package cannot read is a typed refusal, not a throw", () => {
  const decoded = decodeAnthropicRequest({ model: "m" });
  expect(decoded.ok).toBe(false);
  if (decoded.ok) return;
  expect(decoded.error.code).toBe("invalid");
  expect(encodeAnthropicError(decoded.error)).toMatchObject({ error: { type: "invalid_request_error" } });
});

test("tools and the request's own controls carry across", () => {
  const decoded = decodeAnthropicRequest({
    model: "m", max_tokens: 99, temperature: 0.2,
    output_config: { effort: "high" },
    messages: [{ role: "user", content: "go" }],
    tools: [{ name: "bash", description: "run it", input_schema: { type: "object" } }],
  });
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) return;
  expect(decoded.value.request.maxOutputTokens).toBe(99);
  expect(decoded.value.request.temperature).toBe(0.2);
  expect(decoded.value.request.effort).toBe("high");
  expect(decoded.value.request.tools).toEqual([
    { name: "bash", description: "run it", parameters: { type: "object" } },
  ]);
});

test("a response becomes the blocks a client reads, and the counts stay disjoint", () => {
  const response: ModelResponse = {
    message: {
      content: "Done.",
      calls: [{ callId: "c1", name: "bash", arguments: '{"command":"ls"}' }],
    },
    finishReason: "tool-calls",
    usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 7 },
  };
  expect(encodeAnthropicMessage({ response, model: "m", id: "msg_1" })).toEqual({
    id: "msg_1", type: "message", role: "assistant", model: "m",
    content: [
      { type: "text", text: "Done." },
      { type: "tool_use", id: "c1", name: "bash", input: { command: "ls" } },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 7 },
  });
});

test("a generation becomes a frame sequence a client can replay", async () => {
  const model = createFakeModel([
    { text: "hi", calls: [{ callId: "c1", name: "bash", arguments: '{"command":"ls"}' }] },
  ]);
  const events: string[] = [];
  const payloads: unknown[] = [];
  for await (const frame of encodeAnthropicStream({
    generation: model.generate({ messages: [{ role: "user", content: "go" }] }),
    model: "m", id: "msg_1",
  })) {
    events.push(frame.event);
    payloads.push(frame.data);
  }

  expect(events).toEqual([
    "message_start",
    "content_block_start", "content_block_delta", "content_block_stop",
    "content_block_start", "content_block_delta", "content_block_stop",
    "message_delta", "message_stop",
  ]);
  // The text block streams; the call arrives whole, because its name is not
  // known until the generation returns.
  expect(payloads[2]).toMatchObject({ delta: { type: "text_delta", text: "hi" } });
  expect(payloads[4]).toMatchObject({ content_block: { type: "tool_use", name: "bash" } });
  expect(payloads[5]).toMatchObject({ delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } });
  expect(payloads[7]).toMatchObject({ delta: { stop_reason: "tool_use" } });
});

test("a failed generation ends the stream with an error frame, never a truncated success", async () => {
  const events: string[] = [];
  for await (const frame of encodeAnthropicStream({
    generation: createFakeModel([]).generate({ messages: [{ role: "user", content: "go" }] }),
    model: "m", id: "msg_1",
  })) events.push(frame.event);
  expect(events).toEqual(["message_start", "error"]);
});
