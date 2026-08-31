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
