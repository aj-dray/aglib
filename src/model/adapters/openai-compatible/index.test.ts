import { expect, test } from "bun:test";
import { createOpenAiCompatibleModel, createOpenRouterModel } from "./index.js";
import { collect } from "../../model.js";
import type { Message } from "../../../session/messages.js";

/**
 * What this adapter puts on the wire that the conformance suite cannot say.
 *
 * The contract every implementation answers — one result, typed failures,
 * cancellation, tool arguments that parse, what the request carried — lives in
 * `src/model/conformance.ts` and runs against this adapter there. What is left
 * here is this wire's own: which of the two reasoning dialects it speaks, and
 * where OpenRouter points. Sending both dialects is not compatibility, because
 * OpenAI rejects the request outright, so the choice has to be exercised.
 */

const answered = (): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of [
        { model: "acme/one", choices: [{ delta: { content: "hello" } }] },
        { choices: [{ finish_reason: "stop", delta: {} }] },
      ]) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n"));
      controller.close();
    },
  });
};

function capturing() {
  const sent: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    return new Response(answered(), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}

const conversation: readonly Message[] = [{ role: "user", content: "What is the balance?" }];

test("optional tool arguments remain optional on the provider wire", async () => {
  const { fetch, sent } = capturing();
  const model = createOpenRouterModel({ apiKey: "k", model: "acme/one", fetch });
  const parameters = { type: "object", properties: { q: { type: "string" }, limit: { type: "number" } }, required: ["q"], additionalProperties: false } as const;
  await collect(model.generate({ messages: conversation, tools: [{ name: "search", description: "Find records", parameters }] }));
  expect(sent[0]!.body["tools"]).toEqual([{ type: "function", function: { name: "search", description: "Find records", parameters, strict: false } }]);
});

test("effort is spelled the way the endpoint spells it, and never both ways at once", async () => {
  for (const [dialect, expected] of [
    [undefined, { reasoning_effort: "high" }],
    ["reasoning_effort", { reasoning_effort: "high" }],
    ["reasoning", { reasoning: { effort: "high" } }],
  ] as const) {
    const { fetch, sent } = capturing();
    const model = createOpenAiCompatibleModel({
      apiKey: "k", baseUrl: "https://api.example.test/v1", model: "acme/one", fetch,
      ...(dialect ? { effortParameter: dialect } : {}),
    });
    await collect(model.generate({ messages: conversation, effort: "high" }));

    expect(sent[0]!.body).toMatchObject(expected);
    const other = "reasoning_effort" in expected ? "reasoning" : "reasoning_effort";
    expect(sent[0]!.body).not.toHaveProperty(other);
  }
});

test("an endpoint with no reasoning control is sent neither spelling", async () => {
  const { fetch, sent } = capturing();
  const model = createOpenAiCompatibleModel({
    apiKey: "k", baseUrl: "https://api.example.test/v1", model: "acme/one", effortParameter: "none", fetch,
  });
  await collect(model.generate({ messages: conversation, effort: "high" }));

  expect(sent[0]!.body).not.toHaveProperty("reasoning_effort");
  expect(sent[0]!.body).not.toHaveProperty("reasoning");
});

test("OpenRouter is this wire with a fixed base URL, its dialect, and attribution", async () => {
  const { fetch, sent } = capturing();
  const model = createOpenRouterModel({
    apiKey: "k", model: "acme/one", appName: "aglib-test", appUrl: "https://example.test", fetch,
  });
  await collect(model.generate({ messages: conversation, effort: "low" }));

  expect(sent[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
  expect(sent[0]!.headers["x-title"]).toBe("aglib-test");
  expect(sent[0]!.headers["http-referer"]).toBe("https://example.test");
  // The dialect it forwards to whoever is actually serving the model.
  expect(sent[0]!.body["reasoning"]).toEqual({ effort: "low" });
});

test("usage is asked for on the stream, because it arrives on a frame of its own", async () => {
  const { fetch, sent } = capturing();
  const model = createOpenAiCompatibleModel({
    apiKey: "k", baseUrl: "https://api.example.test/v1", model: "acme/one", fetch,
  });
  await collect(model.generate({ messages: conversation }));

  // Without this the counts never arrive at all, and every generation on this
  // wire reports nothing — which the port permits, so nothing else would say so.
  expect(sent[0]!.body["stream_options"]).toEqual({ include_usage: true });
});

test("tool images reach the model after all parallel replies with their call association", async () => {
  const { fetch, sent } = capturing();
  const model = createOpenRouterModel({ apiKey: "k", model: "acme/one", fetch });
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
    { role: "assistant", content: "I can see both screens." },
  ] }));
  const messages = sent[0]!.body["messages"] as Record<string, unknown>[];
  expect(messages.slice(1)).toEqual([
    { role: "tool", tool_call_id: "image-only", content: "" },
    { role: "tool", tool_call_id: "mixed", content: "second screenshot" },
    { role: "user", content: [
      { type: "text", text: "Images from tool call image-only:" },
      { type: "image_url", image_url: { url: "data:image/png;base64,cGl4ZWw=" } },
      { type: "text", text: "Images from tool call mixed:" },
      { type: "image_url", image_url: { url: "https://example.test/screen.jpg" } },
    ] },
    { role: "assistant", content: "I can see both screens." },
  ]);
  // The usual next generation ends at a tool reply, without an assistant yet.
  const { fetch: lastFetch, sent: lastSent } = capturing();
  await collect(createOpenRouterModel({ apiKey: "k", model: "acme/one", fetch: lastFetch }).generate({ messages: [
    { role: "assistant", content: "", calls: [{ callId: "last", name: "read", arguments: "{}" }] },
    { role: "tool", callId: "last", content: [{ type: "image", mediaType: "image/png", source: { kind: "inline", data: "cGl4ZWw=" } }] },
  ] }));
  expect((lastSent[0]!.body["messages"] as Record<string, unknown>[]).at(-1)).toMatchObject({ role: "user", content: [
    { type: "text", text: "Images from tool call last:" },
    { type: "image_url", image_url: { url: "data:image/png;base64,cGl4ZWw=" } },
  ] });
});
