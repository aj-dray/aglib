import { expect, test } from "bun:test";
import { createFakeModel } from "aglib/model/adapters/fake";
import { createOpenRouterModel } from "aglib/model/adapters/openai-compatible";
import { serveAnthropicWire } from "./wire.ts";

/**
 * The offline cases prove the socket: routing, the credential, and that a
 * stream leaves here as frames rather than a body. What the wire *means* is
 * proved in `src/model/anthropic-wire.test.ts`, against the codec itself.
 */
test("a client without the token is refused before a model is asked for anything", async () => {
  const wire = serveAnthropicWire({ model: createFakeModel([]) });
  const response = await fetch(`${wire.url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", max_tokens: 16, messages: [{ role: "user", content: "go" }] }),
  });
  expect(response.status).toBe(401);
  await wire.close();
});

test("a non-streaming request comes back as one message body", async () => {
  const wire = serveAnthropicWire({ model: createFakeModel([{ text: "pineapple" }]) });
  const response = await fetch(`${wire.url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": wire.token },
    body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, messages: [{ role: "user", content: "go" }] }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    type: "message", role: "assistant", model: "claude-sonnet-5",
    content: [{ type: "text", text: "pineapple" }],
    stop_reason: "end_turn",
  });
  await wire.close();
});

test("a streaming request comes back as named server-sent events", async () => {
  const wire = serveAnthropicWire({ model: createFakeModel([{ text: "pineapple" }]) });
  const response = await fetch(`${wire.url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": wire.token },
    body: JSON.stringify({
      model: "m", max_tokens: 16, stream: true, messages: [{ role: "user", content: "go" }],
    }),
  });
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const body = await response.text();
  expect(body).toContain("event: message_start");
  expect(body).toContain('"text_delta"');
  expect(body).toContain("event: message_stop");
  await wire.close();
});

/**
 * The claim this recipe actually makes: the Claude Agent SDK, unmodified, run
 * against a model Anthropic never served.
 *
 * Two gates rather than one. `bun run check` is hermetic and a connected
 * machine must not spend money because somebody ran the gate, so this is opt-in
 * even when the key is present.
 */
const live = process.env["AGLIB_LIVE_MODEL"] === "1" ? process.env["OPENROUTER_API_KEY"] : undefined;
const liveTest = live ? test : test.skip;

liveTest("the Claude Agent SDK runs on a model behind the port", async () => {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const wire = serveAnthropicWire({
    model: createOpenRouterModel({ apiKey: live!, model: "anthropic/claude-sonnet-5", appName: "aglib-vendored-agents" }),
  });

  const said: string[] = [];
  let failed: string | undefined;
  for await (const message of query({
    prompt: "Reply with exactly the word: pineapple. Nothing else.",
    options: {
      settingSources: [],
      allowedTools: [],
      maxTurns: 1,
      env: {
        ...process.env as Record<string, string>,
        ANTHROPIC_BASE_URL: wire.url,
        ANTHROPIC_AUTH_TOKEN: wire.token,
        ANTHROPIC_API_KEY: wire.token,
        ANTHROPIC_MODEL: "claude-sonnet-5",
        ANTHROPIC_SMALL_FAST_MODEL: "claude-sonnet-5",
      },
    },
  })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) if (block.type === "text") said.push(block.text);
    }
    if (message.type === "result" && message.is_error) failed = JSON.stringify(message);
  }

  await wire.close();
  expect(failed).toBeUndefined();
  expect(said.join(" ").toLowerCase()).toContain("pineapple");
}, 180_000);
