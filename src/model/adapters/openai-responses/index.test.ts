import { expect, test } from "bun:test";
import type { ResponsesClientEvent, ResponsesServerEvent } from "openai/resources/responses/responses";
import type { ModelDelta, ModelGeneration, ModelResponse } from "../../model.js";
import type { Result } from "../../../result.js";
import {
  createOpenAiResponsesModel,
  type OpenAiResponsesConnection,
} from "./index.js";

class FakeConnection implements OpenAiResponsesConnection {
  readonly sent: ResponsesClientEvent[] = [];
  readonly #values: Array<{ type: "message"; message: ResponsesServerEvent } | { type: "close" }> = [];
  readonly #waiters: Array<(step: IteratorResult<{ type: "message"; message: ResponsesServerEvent } | { type: "close" }>) => void> = [];
  #ended = false;
  closes = 0;
  onSend?: (event: ResponsesClientEvent) => void;

  send(value: unknown): void {
    const event = value as ResponsesClientEvent;
    this.sent.push(event);
    this.onSend?.(event);
  }

  message(event: Record<string, unknown>): void {
    this.#push({ type: "message", message: event as unknown as ResponsesServerEvent });
  }

  close(): void {
    this.closes += 1;
    this.#push({ type: "close" });
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  #push(value: { type: "message"; message: ResponsesServerEvent } | { type: "close" }): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.#values.push(value);
  }

  next(): Promise<IteratorResult<{ type: "message"; message: ResponsesServerEvent } | { type: "close" }>> {
    const value = this.#values.shift();
    if (value) return Promise.resolve({ done: false, value });
    if (this.#ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  [Symbol.asyncIterator]() { return this; }
}

async function drain(generation: ModelGeneration): Promise<{
  deltas: ModelDelta[];
  result: Result<ModelResponse, { code: "auth" | "rate-limit" | "context-length" | "cancelled" | "provider" | "failed"; message: string; retryable: boolean }>;
}> {
  const deltas: ModelDelta[] = [];
  let step = await generation.next();
  while (!step.done) {
    deltas.push(step.value);
    step = await generation.next();
  }
  return { deltas, result: step.value };
}

const laneOf = (event: ResponsesClientEvent): string => {
  if (event.type !== "response.create" || !event.stream_id) throw new Error("expected a response.create lane");
  return event.stream_id;
};

const created = (stream_id: string, id: string) => ({
  type: "response.created", stream_id, response: { id, model: "gpt-6-astra" },
});

const completed = (stream_id: string, id: string, output: readonly unknown[] = []) => ({
  type: "response.completed", stream_id,
  response: { id, model: "gpt-6-astra", output, usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 4 }, output_tokens: 3 } },
});

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) await Promise.resolve();
  if (!condition()) throw new Error("condition did not become true");
}

test("async calls complete before the response and opaque output is replayed exactly", async () => {
  const wire = new FakeConnection();
  const model = createOpenAiResponsesModel({
    apiKey: "k", model: "gpt-6-astra", asyncTools: true, connect: () => wire,
  });
  const reasoning = { type: "reasoning", id: "rs_old", encrypted_content: "opaque" } as const;
  const oldCall = { type: "function_call", id: "fc_old", call_id: "old_call", name: "lookup", arguments: "{}", async: true } as const;
  const call = {
    type: "function_call", id: "fc_1", call_id: "call_1", name: "research", arguments: "{\"q\":\"voice\"}", async: true,
  } as const;
  wire.onSend = (event) => {
    if (event.type !== "response.create") return;
    const lane = laneOf(event);
    wire.message(created(lane, "resp_1"));
    wire.message({ type: "response.reasoning_summary_text.delta", stream_id: lane, delta: "checking" });
    wire.message({ type: "response.output_item.added", stream_id: lane, item: call });
    wire.message({ type: "response.function_call_arguments.delta", stream_id: lane, item_id: "fc_1", delta: "voice" });
    wire.message({ type: "response.output_item.done", stream_id: lane, item: call });
    wire.message({ type: "response.output_text.delta", stream_id: lane, delta: "I can continue." });
    wire.message({ type: "response.output_item.done", stream_id: lane, item: { type: "message", id: "msg_1", role: "assistant", content: [] } });
    wire.message(completed(lane, "resp_1", [call]));
  };

  const outcome = await drain(model.generate({
    messages: [
      { role: "assistant", content: "", calls: [{ callId: "old_call", name: "lookup", arguments: "{}", async: true }] },
      { role: "tool", callId: "old_call", content: "done" },
      { role: "assistant", content: "", providerState: { provider: "openai-responses", items: [reasoning, oldCall] } },
      { role: "user", content: "What changed?" },
    ],
    tools: [{
      name: "research", description: "Research in parallel", async: true,
      parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    }],
    effort: "high",
  }));

  expect(model.asyncTools).toBe(true);
  const request = wire.sent[0];
  expect(request?.type).toBe("response.create");
  if (request?.type === "response.create") {
    expect(request.include).toEqual(["reasoning.encrypted_content"]);
    expect(request.input).toEqual([
      reasoning,
      oldCall,
      { type: "function_call_output", call_id: "old_call", output: "done" },
      { type: "message", role: "user", content: "What changed?" },
    ]);
    expect(request.tools?.[0]).toMatchObject({ type: "function", name: "research", async: true });
  }
  expect(outcome.deltas).toEqual([
    { type: "reasoning.delta", text: "checking" },
    { type: "tool-call.delta", callId: "call_1", arguments: "voice" },
    { type: "tool-call.done", call: { callId: "call_1", name: "research", arguments: "{\"q\":\"voice\"}", async: true } },
    { type: "text.delta", text: "I can continue." },
  ]);
  expect(outcome.result.ok).toBe(true);
  if (outcome.result.ok) {
    expect(outcome.result.value.finishReason).toBe("stop");
    expect(outcome.result.value.usage).toEqual({ inputTokens: 6, cacheReadTokens: 4, outputTokens: 3 });
    expect(outcome.result.value.providerState?.items).toEqual([
      call,
      { type: "message", id: "msg_1", role: "assistant", content: [] },
    ]);
  }
  model.close();
});

test("a normal client tool call ends the generation and is emitted once", async () => {
  const wire = new FakeConnection();
  const model = createOpenAiResponsesModel({ apiKey: "k", model: "gpt-6-astra", connect: () => wire });
  const call = { type: "function_call", id: "fc_2", call_id: "call_2", name: "bash", arguments: "{}" } as const;
  wire.onSend = (event) => {
    if (event.type !== "response.create") return;
    const lane = laneOf(event);
    wire.message(created(lane, "resp_2"));
    wire.message({ type: "response.output_item.done", stream_id: lane, item: call });
    wire.message(completed(lane, "resp_2", [call]));
  };

  const outcome = await drain(model.generate({ messages: [{ role: "user", content: "run it" }] }));
  expect(outcome.deltas.filter((delta) => delta.type === "tool-call.done")).toHaveLength(1);
  expect(outcome.result.ok && outcome.result.value.finishReason).toBe("tool-calls");
  model.close();
});

test("a Responses refusal is not reported as a normal stop", async () => {
  const wire = new FakeConnection();
  const model = createOpenAiResponsesModel({ apiKey: "k", model: "gpt-6-astra", connect: () => wire });
  wire.onSend = (event) => {
    if (event.type !== "response.create") return;
    const lane = laneOf(event);
    wire.message(created(lane, "resp_refusal"));
    wire.message({ type: "response.refusal.delta", stream_id: lane, delta: "declined" });
    wire.message(completed(lane, "resp_refusal", [{
      type: "message", id: "msg_refusal", role: "assistant",
      content: [{ type: "refusal", refusal: "declined" }],
    }]));
  };

  const outcome = await drain(model.generate({ messages: [{ role: "user", content: "answer" }] }));
  expect(outcome.result.ok && outcome.result.value.finishReason).toBe("refusal");
  model.close();
});

test("steering commits only when the successor response is created", async () => {
  const wire = new FakeConnection();
  const model = createOpenAiResponsesModel({
    apiKey: "k", model: "gpt-6-astra", steering: true, connect: () => wire,
  });
  let lane = "";
  wire.onSend = (event) => {
    if (event.type === "response.create") {
      lane = laneOf(event);
      wire.message(created(lane, "resp_before"));
      wire.message({ type: "response.output_text.delta", stream_id: lane, delta: "Before. " });
    } else {
      wire.message({ type: "response.steer.accepted", stream_id: lane, steer: { id: "steer_1", previous_response_id: "resp_before" } });
    }
  };
  const generation = model.generate({ messages: [{ role: "user", content: "start" }] });
  expect(await generation.next()).toEqual({ done: false, value: { type: "text.delta", text: "Before. " } });
  let settled = false;
  const steered = generation.steer!([{ role: "user", content: "new context" }]).then((value) => {
    settled = true;
    return value;
  });
  await until(() => wire.sent.length === 2);
  expect(settled).toBe(false);

  wire.message({ type: "response.incomplete", stream_id: lane, response: { id: "resp_before", incomplete_details: { reason: "steered" }, output: [] } });
  wire.message(created(lane, "resp_after"));
  wire.message({ type: "response.output_text.delta", stream_id: lane, delta: "After." });
  wire.message(completed(lane, "resp_after"));

  const [steerResult, outcome] = await Promise.all([steered, drain(generation)]);
  expect(steerResult).toEqual({ status: "accepted", id: "resp_after" });
  expect(outcome.result.ok && outcome.result.value.message.content).toBe("Before. After.");
  expect(wire.sent[1]).toEqual({
    type: "response.steer", previous_response_id: "resp_before",
    input: [{ type: "message", role: "user", content: "new context" }],
  });
  model.close();
});

test("a rejected steer leaves the current generation running", async () => {
  const wire = new FakeConnection();
  const model = createOpenAiResponsesModel({
    apiKey: "k", model: "gpt-6-astra", steering: true, connect: () => wire,
  });
  let lane = "";
  wire.onSend = (event) => {
    if (event.type === "response.create") {
      lane = laneOf(event);
      wire.message(created(lane, "resp_3"));
      wire.message({ type: "response.output_text.delta", stream_id: lane, delta: "still " });
    } else {
      wire.message({
        type: "response.steer.failed", stream_id: lane,
        steer: { input: event.input }, error: { code: "steering_not_supported", message: "not available" },
      });
      wire.message({ type: "response.output_text.delta", stream_id: lane, delta: "running" });
      wire.message(completed(lane, "resp_3"));
    }
  };
  const generation = model.generate({ messages: [{ role: "user", content: "start" }] });
  await generation.next();
  const [steerResult, outcome] = await Promise.all([
    generation.steer!([{ role: "user", content: "change" }]),
    drain(generation),
  ]);
  expect(steerResult.status).toBe("rejected");
  expect(outcome.result.ok && outcome.result.value.message.content).toBe("still running");
  model.close();
});

test("one WebSocket is reused across turns and cancellation is scoped to its lane", async () => {
  const wire = new FakeConnection();
  let connections = 0;
  const model = createOpenAiResponsesModel({
    apiKey: "k", model: "gpt-6-astra",
    connect: () => { connections += 1; return wire; },
  });
  const lanes: string[] = [];
  wire.onSend = (event) => {
    if (event.type !== "response.create") return;
    const lane = laneOf(event);
    lanes.push(lane);
    wire.message(created(lane, `resp_${lanes.length}`));
    if (lanes.length === 1) wire.message(completed(lane, "resp_1"));
  };
  expect((await drain(model.generate({ messages: [{ role: "user", content: "first" }] }))).result.ok).toBe(true);

  const cancelled = new AbortController();
  const first = drain(model.generate({ messages: [{ role: "user", content: "cancel" }], signal: cancelled.signal }));
  const second = drain(model.generate({ messages: [{ role: "user", content: "continue" }] }));
  await Promise.resolve();
  cancelled.abort();
  await Promise.resolve();
  const liveLane = lanes.at(-1)!;
  wire.message({ type: "response.output_text.delta", stream_id: liveLane, delta: "done" });
  wire.message(completed(liveLane, "resp_3"));
  const [stopped, continued] = await Promise.all([first, second]);

  expect(connections).toBe(1);
  expect(new Set(lanes).size).toBe(3);
  expect(stopped.result).toMatchObject({ ok: false, error: { code: "cancelled" } });
  expect(continued.result.ok && continued.result.value.message.content).toBe("done");
  expect(wire.closes).toBe(0);
  model.close();
  expect(wire.closes).toBe(1);
});

test("capabilities are absent unless explicitly enabled", () => {
  const wire = new FakeConnection();
  const model = createOpenAiResponsesModel({ apiKey: "k", model: "gpt-5.6", connect: () => wire });
  expect(model.asyncTools).toBeUndefined();
  expect(model.generate({ messages: [] }).steer).toBeUndefined();
  model.close();
});
